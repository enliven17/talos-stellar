// @vitest-environment node
/**
 * POST /api/talos/:id/retire — lifecycle reason bounds (#1364).
 *
 * Uses the real `retireAgentSchema` (no schema mock) so the route-level
 * contract is exercised: an invalid reason is rejected with 400 before any
 * database read, write, or lifecycle audit event; a valid reason at the bound
 * is persisted and audited exactly as sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

const creator = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const CREATOR_KEY = creator.publicKey();
const AGENT_ID = "agent_1";
const REPLACEMENT_ID = "cm3x9agentreplacement0001";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  emit: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    query: { tlsTalos: { findFirst: mocks.findFirst } },
    select: mocks.select,
    transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/governance/events", () => ({
  LIFECYCLE_EVENTS: { RETIRED: "agent.lifecycle.retired" },
  emitLifecycleEvent: mocks.emit,
}));

vi.mock("@/lib/governance/retirement-reconciliation", () => ({
  enqueueRetirementReconciliation: mocks.enqueue,
  loadRetirementReconciliation: vi.fn(async () => null),
}));

import { POST } from "../src/app/api/talos/[id]/retire/route";

function selectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    then: (cb: (r: unknown) => unknown) => Promise.resolve(cb(result)),
  };
  return chain;
}

function retire(reason: string, extra: Record<string, unknown> = {}) {
  const message = `Retire TALOS ${AGENT_ID}`;
  const signature = creator.sign(Buffer.from(message, "utf8")).toString("base64");
  return POST(
    new NextRequest(`http://localhost:3000/api/talos/${AGENT_ID}/retire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason, stellarPublicKey: CREATOR_KEY, signature, message, ...extra }),
    }),
    { params: Promise.resolve({ id: AGENT_ID }) },
  );
}

describe("POST /api/talos/:id/retire — reason validation", () => {
  let setCalls: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    setCalls = [];
    mocks.select.mockReturnValue(selectChain([])); // readiness: nothing pending
    mocks.findFirst.mockResolvedValue({ id: REPLACEMENT_ID });
    mocks.emit.mockResolvedValue({ id: "evt_1", sequence: 1, deduped: false });
    mocks.enqueue.mockResolvedValue({ jobId: "job_1", created: true });
    mocks.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        query: {
          tlsTalos: {
            findFirst: vi.fn().mockResolvedValue({
              id: AGENT_ID,
              creatorPublicKey: CREATOR_KEY,
              walletPublicKey: null,
              retiredAt: null,
              status: "Active",
            }),
          },
        },
        select: vi.fn(() => selectChain([])), // no in-flight jobs
        update: vi.fn(() => {
          const chain = {
            set: vi.fn((values: Record<string, unknown>) => {
              setCalls.push(values);
              return chain;
            }),
            where: vi.fn(() => chain),
            returning: vi.fn(async () => [
              {
                id: AGENT_ID,
                agentName: "agent-1",
                retiredAt: new Date("2026-11-25T00:00:00.000Z"),
                retiredReason: setCalls[0]?.retiredReason,
                supersededBy: setCalls[0]?.supersededBy,
              },
            ]),
          };
          return chain;
        }),
      }),
    );
  });

  it.each([
    ["over the 1,000-character bound", "r".repeat(1001), "reason: reason must be at most 1000 characters (got 1001)"],
    ["whitespace only", "    ", "reason: reason must not be blank"],
    ["containing NUL", "Obsolete\u0000", "reason: reason must not contain control characters or malformed Unicode"],
  ])(
    "rejects a reason %s with 400 before any persistence or audit emission",
    async (_name, reason, issue) => {
      const res = await retire(reason);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues).toEqual([issue]);

      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.findFirst).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(mocks.emit).not.toHaveBeenCalled();
    },
  );

  it("persists and audits a reason at the bound exactly as sent, identifiers intact", async () => {
    const head = `Superseded by ${REPLACEMENT_ID}; reconciliation tracked separately. `;
    const reason = head.padEnd(1000, "."); // exactly 1,000 characters

    const res = await retire(reason, { supersededBy: REPLACEMENT_ID });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retiredReason).toBe(reason);
    expect(body.supersededBy).toBe(REPLACEMENT_ID);

    expect(setCalls[0]).toMatchObject({ retiredReason: reason, supersededBy: REPLACEMENT_ID });
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit.mock.calls[0][0].detail).toEqual({
      reason,
      supersededBy: REPLACEMENT_ID,
      reconciliationJobId: "job_1",
    });
  });
});
