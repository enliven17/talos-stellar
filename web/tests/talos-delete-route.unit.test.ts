/**
 * Unit tests for POST /api/talos/[id]/delete (issue #881).
 *
 * Verifies that cache tags are revalidated only after a successful soft-delete
 * and are NOT revalidated when the request is rejected.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const TALOS_ID = "talos_881";

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const revalidateTag = vi.fn();

  // Minimal transaction stub — delegates to the callback immediately.
  const transaction = vi.fn(async (cb: (tx: any) => Promise<any>) => cb({}));

  return { revalidateTag, transaction };
});

vi.mock("next/cache", () => ({
  revalidateTag: mocks.revalidateTag,
}));

vi.mock("@/db", () => ({
  db: {
    transaction: mocks.transaction,
  },
}));

// Body-parser helper — forward real schema validation but expose a quick way
// to inject a pre-parsed result.
vi.mock("@/lib/schemas", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    parseBody: vi.fn(),
  };
});

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/talos/${TALOS_ID}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("POST /api/talos/[id]/delete — cache revalidation", () => {
  let POST: (req: NextRequest, ctx: any) => Promise<Response>;
  let parseBody: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Import fresh module bindings after clearing mocks.
    const schemasMod = await import("@/lib/schemas");
    parseBody = schemasMod.parseBody as unknown as ReturnType<typeof vi.fn>;

    const routeMod = await import("../src/app/api/talos/[id]/delete/route");
    POST = routeMod.POST;
  });

  // ── success path ────────────────────────────────────────────────────────

  it("revalidates every agentMutationTag after a successful soft-delete", async () => {
    const now = new Date();

    // parseBody succeeds
    parseBody.mockResolvedValue({
      error: null,
      data: {
        reason: "testing",
        stellarPublicKey: "GPUBLIC",
        signature: "sig",
        message: `delete:${TALOS_ID}`,
      },
    });

    // Transaction returns a successfully deleted talos record
    mocks.transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
      const tx = {
        query: {
          tlsTalos: {
            findFirst: vi.fn().mockResolvedValue({
              id: TALOS_ID,
              deletedAt: null,
              walletPublicKey: "GPUBLIC",
              creatorPublicKey: "GPUBLIC",
            }),
          },
        },
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([
            {
              id: TALOS_ID,
              agentName: "Test Agent",
              deletedAt: now,
              deletedReason: "testing",
            },
          ]),
        }),
      };
      return cb(tx);
    });

    // Bypass Stellar SDK signature verification for the unit test
    vi.mock("@stellar/stellar-sdk", () => ({
      Keypair: {
        fromPublicKey: vi.fn().mockReturnValue({
          verify: vi.fn().mockReturnValue(true),
        }),
      },
    }));

    const res = await POST(makeRequest(), paramsFor(TALOS_ID));

    expect(res.status).toBe(200);

    // Both "agents:list" and "agents:id:<id>" must have been revalidated.
    const calledWith = mocks.revalidateTag.mock.calls.map((c) => c[0]);
    expect(calledWith).toContain("agents:list");
    expect(calledWith).toContain(`agents:id:${TALOS_ID}`);
  });

  // ── error path: bad message ─────────────────────────────────────────────

  it("does NOT revalidate when the message does not contain the TALOS ID", async () => {
    parseBody.mockResolvedValue({
      error: null,
      data: {
        reason: "testing",
        stellarPublicKey: "GPUBLIC",
        signature: "sig",
        message: "delete:some-other-id", // does NOT include TALOS_ID
      },
    });

    const res = await POST(makeRequest(), paramsFor(TALOS_ID));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/TALOS ID/i);

    // No tags should have been revalidated
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  // ── error path: body parse failure ─────────────────────────────────────

  it("does NOT revalidate when parseBody returns an error response", async () => {
    parseBody.mockResolvedValue({
      error: Response.json({ error: "Bad request" }, { status: 400 }),
    });

    const res = await POST(makeRequest(), paramsFor(TALOS_ID));

    expect(res.status).toBe(400);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  // ── error path: transaction returns 404 ────────────────────────────────

  it("does NOT revalidate when the transaction returns a not-found error", async () => {
    parseBody.mockResolvedValue({
      error: null,
      data: {
        reason: "testing",
        stellarPublicKey: "GPUBLIC",
        signature: "sig",
        message: `delete:${TALOS_ID}`,
      },
    });

    mocks.transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
      const tx = {
        query: {
          tlsTalos: {
            findFirst: vi.fn().mockResolvedValue(null), // agent not found
          },
        },
        update: vi.fn(),
      };
      return cb(tx);
    });

    const res = await POST(makeRequest(), paramsFor(TALOS_ID));

    expect(res.status).toBe(404);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });
});
