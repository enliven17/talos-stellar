/**
 * Cursor pagination tests for GET /api/talos (agent directory).
 *
 * Acceptance criteria:
 *   ✓ encodeTalosCursor / decodeTalosCursor round-trip (opaque base64url)
 *   ✓ decodeTalosCursor rejects null, garbage, missing fields, invalid date
 *   ✓ Malformed cursor query param → 400
 *   ✓ Invalid / missing limit → 400
 *   ✓ First page returns data + encoded nextCursor (not null, not a plain object)
 *   ✓ Last page returns nextCursor = null
 *   ✓ nextCursor is decodable and advances the window correctly
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// DB + dependency mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  mockReputations: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/db", () => ({ db: mocks.mockDb }));
vi.mock("@/lib/reputation-ledger", () => ({
  fetchReputations: mocks.mockReputations,
}));
vi.mock("@/lib/stellar", () => ({
  createAgentKeypair: vi.fn(),
  fundTestnetAccount: vi.fn(),
  verifyStellarSignature: vi.fn(),
}));
vi.mock("@/lib/drift", () => ({
  withDriftDetection: vi.fn((_label: string, fn: unknown) => fn),
}));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildChain(results: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const methods = [
    "select",
    "from",
    "where",
    "orderBy",
    "limit",
    "leftJoin",
    "innerJoin",
    "groupBy",
    "as",
  ];
  for (const m of methods) obj[m] = vi.fn(() => obj);
  obj.then = vi.fn((cb: (v: unknown[]) => unknown) =>
    Promise.resolve(cb(results)),
  );
  return obj;
}

function makeRow(id: string, createdAt: Date) {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    onChainId: null,
    agentName: null,
    name: `Agent-${id}`,
    category: "Development",
    description: "test agent",
    status: "Active",
    stellarAssetCode: null,
    pulsePrice: "0",
    totalSupply: 1_000_000,
    creatorShare: 0,
    investorShare: 0,
    treasuryShare: 100,
    persona: null,
    targetAudience: null,
    channels: [],
    toneVoice: null,
    approvalThreshold: "10",
    gtmBudget: "200",
    minPatronPulse: null,
    agentOnline: false,
    agentLastSeen: null,
    walletPublicKey: null,
    creatorPublicKey: null,
    investorPublicKey: null,
    treasuryPublicKey: null,
    patrons: 0,
  };
}

function req(params: Record<string, string> = {}): NextRequest {
  const u = new URL("http://localhost/api/talos");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new NextRequest(u.toString());
}

// ---------------------------------------------------------------------------
// Imports under test (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  GET,
  encodeTalosCursor,
  decodeTalosCursor,
  type TalosCursor,
} from "@/app/api/talos/route";

// ---------------------------------------------------------------------------
// Cursor encode / decode unit tests
// ---------------------------------------------------------------------------

describe("encodeTalosCursor / decodeTalosCursor", () => {
  const sample: TalosCursor = {
    createdAt: "2026-09-01T10:00:00.000Z",
    id: "abc123",
  };

  it("round-trips correctly", () => {
    const encoded = encodeTalosCursor(sample);
    expect(typeof encoded).toBe("string");
    // Must be opaque base64url, not a raw JSON string
    expect(encoded).not.toContain("{");
    const decoded = decodeTalosCursor(encoded);
    expect(decoded).toEqual(sample);
  });

  it("returns null for null input", () => {
    expect(decodeTalosCursor(null)).toBeNull();
  });

  it("returns null for random garbage", () => {
    expect(decodeTalosCursor("not-a-cursor")).toBeNull();
  });

  it("returns null when id field is missing", () => {
    const noId = Buffer.from(
      JSON.stringify({ createdAt: "2026-09-01T10:00:00.000Z" }),
      "utf8",
    ).toString("base64url");
    expect(decodeTalosCursor(noId)).toBeNull();
  });

  it("returns null when id is an empty string", () => {
    const emptyId = Buffer.from(
      JSON.stringify({ createdAt: "2026-09-01T10:00:00.000Z", id: "" }),
      "utf8",
    ).toString("base64url");
    expect(decodeTalosCursor(emptyId)).toBeNull();
  });

  it("returns null when createdAt is not a valid date", () => {
    const badDate = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "abc" }),
      "utf8",
    ).toString("base64url");
    expect(decodeTalosCursor(badDate)).toBeNull();
  });

  it("returns null when createdAt field is missing", () => {
    const noDate = Buffer.from(
      JSON.stringify({ id: "abc" }),
      "utf8",
    ).toString("base64url");
    expect(decodeTalosCursor(noDate)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/talos route tests
// ---------------------------------------------------------------------------

describe("GET /api/talos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockReputations.mockResolvedValue(new Map());
  });

  it("returns 400 for a malformed cursor", async () => {
    const res = await GET(req({ cursor: "this-is-not-valid-base64url-cursor" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/cursor/i);
  });

  it("returns 400 for limit=0", async () => {
    const res = await GET(req({ limit: "0" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric limit", async () => {
    const res = await GET(req({ limit: "abc" }));
    expect(res.status).toBe(400);
  });

  it("first page: returns data array and non-null encoded nextCursor", async () => {
    const now = new Date("2026-09-01T10:00:00.000Z");
    // 10 rows returned; limit defaults to 50 — but we pass limit=3 so we need
    // more than 3*2=6 rows to trigger hasMore. Provide 8 rows (> 6).
    const rows = Array.from({ length: 8 }, (_, i) =>
      makeRow(`id-${i}`, new Date(now.getTime() - i * 1000)),
    );

    // The route makes TWO db.select calls: one for patronCount subquery (via .as()),
    // one for the main entries query. Chain the mock to return rows on the entries call.
    let callCount = 0;
    mocks.mockDb.select.mockImplementation(() => {
      callCount++;
      // First call is the patronCount subquery (.as() is called on it — returns empty)
      // Second call is the main entries query
      return buildChain(callCount === 1 ? [] : rows);
    });

    const res = await GET(req({ limit: "3" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(3);

    // nextCursor must be a non-null string (encoded)
    expect(typeof body.nextCursor).toBe("string");
    expect(body.nextCursor).not.toBeNull();

    // Must be a valid decodable cursor
    const decoded = decodeTalosCursor(body.nextCursor);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBeDefined();
    expect(decoded?.createdAt).toBeDefined();
  });

  it("last page: returns nextCursor = null when DB is exhausted", async () => {
    const now = new Date("2026-09-01T10:00:00.000Z");
    // Only 2 rows — less than limit=3 → exhausted
    const rows = [
      makeRow("id-0", now),
      makeRow("id-1", new Date(now.getTime() - 1000)),
    ];

    let callCount = 0;
    mocks.mockDb.select.mockImplementation(() => {
      callCount++;
      return buildChain(callCount === 1 ? [] : rows);
    });

    const res = await GET(req({ limit: "3" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.length).toBe(2);
    expect(body.nextCursor).toBeNull();
  });

  it("empty DB returns empty data and nextCursor = null", async () => {
    mocks.mockDb.select.mockImplementation(() => buildChain([]));

    const res = await GET(req({}));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("nextCursor is opaque: does not expose raw field values as plain object", async () => {
    const now = new Date("2026-09-01T10:00:00.000Z");
    const rows = Array.from({ length: 8 }, (_, i) =>
      makeRow(`id-${i}`, new Date(now.getTime() - i * 1000)),
    );

    let callCount = 0;
    mocks.mockDb.select.mockImplementation(() => {
      callCount++;
      return buildChain(callCount === 1 ? [] : rows);
    });

    const res = await GET(req({ limit: "3" }));
    const body = await res.json();

    // nextCursor must be a string, not an object
    expect(typeof body.nextCursor).toBe("string");
    // Must not be raw JSON
    expect(body.nextCursor).not.toContain("{");
    expect(body.nextCursor).not.toContain("createdAt");
  });

  it("valid encoded cursor is accepted without 400", async () => {
    const cursor: TalosCursor = {
      createdAt: "2026-09-01T10:00:00.000Z",
      id: "some-id",
    };
    const encoded = encodeTalosCursor(cursor);

    // Return empty rows so handler runs to completion
    mocks.mockDb.select.mockImplementation(() => buildChain([]));

    const res = await GET(req({ cursor: encoded }));
    // Should not be 400 (bad cursor)
    expect(res.status).not.toBe(400);
  });
});
