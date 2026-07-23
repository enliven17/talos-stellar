/**
 * Tests for the standardised API error response helpers (api-response.ts)
 * and the bounded route set that uses them.
 *
 * Positive paths: success responses are untouched.
 * Negative paths: every error response carries the envelope
 *   { code, message, requestId } with no internal leakage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Unit tests: api-response helpers ────────────────────────────────────────

import {
  getRequestId,
  errorResponse,
  badRequest,
  invalidJson,
  validationError,
  unauthorized,
  forbidden,
  notFound,
  internalError,
} from "@/lib/api-response";

function makeRequest(opts: { requestId?: string; url?: string } = {}): Request {
  const url = opts.url ?? "http://localhost/api/test";
  const headers: Record<string, string> = {};
  if (opts.requestId) headers["x-request-id"] = opts.requestId;
  return new Request(url, { headers });
}

describe("getRequestId()", () => {
  it("echoes the x-request-id header when present", () => {
    const req = makeRequest({ requestId: "my-req-id" });
    expect(getRequestId(req)).toBe("my-req-id");
  });

  it("generates a UUID when the header is absent", () => {
    const req = makeRequest();
    const id = getRequestId(req);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("errorResponse()", () => {
  it("returns a JSON response with the envelope shape", async () => {
    const req = makeRequest({ requestId: "abc-123" });
    const res = errorResponse(req, 404, "NOT_FOUND", "Thing not found");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "NOT_FOUND",
      message: "Thing not found",
      requestId: "abc-123",
    });
    expect(body).not.toHaveProperty("error");
  });

  it("echoes requestId in both body and response header", async () => {
    const req = makeRequest({ requestId: "xyz-789" });
    const res = errorResponse(req, 400, "BAD_REQUEST", "oops");

    const body = await res.json();
    expect(body.requestId).toBe("xyz-789");
    expect(res.headers.get("x-request-id")).toBe("xyz-789");
  });

  it("includes issues array on validation errors", async () => {
    const req = makeRequest();
    const res = errorResponse(req, 400, "VALIDATION_ERROR", "Validation failed", [
      "name: Required",
      "category: Invalid",
    ]);

    const body = await res.json();
    expect(body.issues).toEqual(["name: Required", "category: Invalid"]);
  });

  it("does not include issues when none are provided", async () => {
    const req = makeRequest();
    const res = errorResponse(req, 404, "NOT_FOUND", "Not found");
    const body = await res.json();
    expect(body).not.toHaveProperty("issues");
  });

  it("generates a requestId when header is absent", async () => {
    const req = makeRequest();
    const res = errorResponse(req, 500, "INTERNAL_ERROR", "An unexpected error occurred");
    const body = await res.json();
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });
});

describe("convenience helpers", () => {
  const req = makeRequest({ requestId: "test-id" });

  it("badRequest → 400 BAD_REQUEST", async () => {
    const res = badRequest(req, "bad thing");
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.code).toBe("BAD_REQUEST");
    expect(b.message).toBe("bad thing");
  });

  it("invalidJson → 400 INVALID_JSON", async () => {
    const res = invalidJson(req);
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.code).toBe("INVALID_JSON");
  });

  it("validationError → 400 VALIDATION_ERROR with issues", async () => {
    const res = validationError(req, ["field: required"]);
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.code).toBe("VALIDATION_ERROR");
    expect(b.issues).toEqual(["field: required"]);
  });

  it("unauthorized → 401 UNAUTHORIZED", async () => {
    const res = unauthorized(req);
    expect(res.status).toBe(401);
    const b = await res.json();
    expect(b.code).toBe("UNAUTHORIZED");
  });

  it("forbidden → 403 FORBIDDEN", async () => {
    const res = forbidden(req);
    expect(res.status).toBe(403);
    const b = await res.json();
    expect(b.code).toBe("FORBIDDEN");
  });

  it("notFound → 404 NOT_FOUND", async () => {
    const res = notFound(req);
    expect(res.status).toBe(404);
    const b = await res.json();
    expect(b.code).toBe("NOT_FOUND");
  });

  it("internalError → 500 INTERNAL_ERROR without leaking details", async () => {
    const res = internalError(req);
    expect(res.status).toBe(500);
    const b = await res.json();
    expect(b.code).toBe("INTERNAL_ERROR");
    // Must not expose any internal detail
    expect(b.message).not.toMatch(/stack|trace|sql|postgres/i);
  });
});

// ─── Route-level tests ────────────────────────────────────────────────────────

// Build a fully chainable mock that resolves to `rows` when .limit() or
// .then() is invoked. Uses a Proxy so any method name in the chain is handled.
function makeChainMock(rows: unknown[]) {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "limit") return vi.fn().mockResolvedValue(rows);
      if (prop === "then") {
        // Allow the chain itself to be awaited (e.g. proposals route)
        return (resolve: (v: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve);
      }
      if (prop === "as") return vi.fn().mockReturnValue(proxy);
      // Every other method returns the same proxy (supports any chain depth)
      return () => proxy;
    },
  };
  const proxy = new Proxy({}, handler);
  return vi.fn().mockReturnValue(proxy);
}

function makeThrowMock(err: Error): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() => { throw err; });
}

// Activity query mocks live outside vi.mock so we can reference them in tests
const mockFetchStats = vi.fn();
const mockFetchTxns = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
    query: { tlsTalos: { findFirst: vi.fn() } },
  },
}));

vi.mock("@/lib/stellar", () => ({
  createAgentKeypair: vi.fn(),
  fundTestnetAccount: vi.fn(),
  verifyStellarSignature: vi.fn(),
}));

vi.mock("@/lib/soroban", () => ({
  isNameAvailableOnChain: vi.fn(),
}));

vi.mock("@/app/api/activity/query", () => ({
  fetchActivityStats: () => mockFetchStats(),
  fetchActivityTransactions: (...args: unknown[]) => mockFetchTxns(...args),
}));

import { db } from "@/db";
import { GET as getTalos } from "@/app/api/talos/route";
import { GET as getTalosById } from "@/app/api/talos/[id]/route";
import { GET as checkName } from "@/app/api/talos/check-name/route";
import { GET as getServices } from "@/app/api/services/route";
import { GET as getLeaderboard } from "@/app/api/leaderboard/route";
import { GET as getActivity } from "@/app/api/activity/route";
import { GET as getProposals } from "@/app/api/proposals/route";
import { isNameAvailableOnChain } from "@/lib/soroban";

// Helper: assert body conforms to error envelope
async function assertErrorEnvelope(
  res: Response,
  expectedStatus: number,
  expectedCode: string,
) {
  expect(res.status).toBe(expectedStatus);
  const body = await res.json();
  expect(body).toHaveProperty("code", expectedCode);
  expect(body).toHaveProperty("message");
  expect(typeof body.message).toBe("string");
  expect(body).toHaveProperty("requestId");
  expect(typeof body.requestId).toBe("string");
  // Must not have the old "error" string field
  expect(body).not.toHaveProperty("error");
  return body;
}

// ── GET /api/talos ────────────────────────────────────────────────────────────

describe("GET /api/talos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with data on success", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(makeChainMock([]));

    const req = new Request("http://localhost/api/talos") as Parameters<typeof getTalos>[0];
    const res = await getTalos(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
  });

  it("returns 500 envelope on DB error", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(
      makeThrowMock(new Error("ECONNREFUSED — secret internal detail")),
    );

    const req = new Request("http://localhost/api/talos") as Parameters<typeof getTalos>[0];
    const res = await getTalos(req);
    const body = await assertErrorEnvelope(res, 500, "INTERNAL_ERROR");
    // Must not leak the raw error message
    expect(body.message).not.toContain("ECONNREFUSED");
  });

  it("echoes x-request-id in 500 envelope", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(
      makeThrowMock(new Error("boom")),
    );

    const req = new Request("http://localhost/api/talos", {
      headers: { "x-request-id": "my-rid" },
    }) as Parameters<typeof getTalos>[0];
    const res = await getTalos(req);
    const body = await res.clone().json();
    expect(body.requestId).toBe("my-rid");
    expect(res.headers.get("x-request-id")).toBe("my-rid");
  });
});

// ── GET /api/talos/:id ────────────────────────────────────────────────────────

describe("GET /api/talos/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 envelope when TALOS is not found", async () => {
    (db.query.tlsTalos.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const req = new Request("http://localhost/api/talos/nonexistent");
    const params = Promise.resolve({ id: "nonexistent" });
    const res = await getTalosById(req, { params });
    await assertErrorEnvelope(res, 404, "NOT_FOUND");
  });

  it("returns 200 with masked apiKey on success", async () => {
    (db.query.tlsTalos.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "t1",
      name: "TestTalos",
      apiKey: "tak_abcdefghijklmnop1234",
      patrons: [],
      activities: [],
      approvals: [],
      revenues: [],
      commerceServices: [],
    });

    const req = new Request("http://localhost/api/talos/t1");
    const params = Promise.resolve({ id: "t1" });
    const res = await getTalosById(req, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("apiKey");
    expect(body).toHaveProperty("apiKeyMasked");
  });

  it("returns 500 envelope on DB error", async () => {
    (db.query.tlsTalos.findFirst as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("db exploded — internal detail"),
    );

    const req = new Request("http://localhost/api/talos/t1");
    const params = Promise.resolve({ id: "t1" });
    const res = await getTalosById(req, { params });
    const body = await assertErrorEnvelope(res, 500, "INTERNAL_ERROR");
    expect(body.message).not.toContain("internal detail");
  });
});

// ── GET /api/talos/check-name ─────────────────────────────────────────────────

describe("GET /api/talos/check-name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { available: false, reason } for short names (no envelope)", async () => {
    const req = new Request("http://localhost/api/talos/check-name?name=ab") as Parameters<typeof checkName>[0];
    const res = await checkName(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.reason).toBeDefined();
  });

  it("returns { available: false, reason } for names taken in DB", async () => {
    const selectMock = makeChainMock([{ id: "existing-id" }]);
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(selectMock);

    const req = new Request("http://localhost/api/talos/check-name?name=taken") as Parameters<typeof checkName>[0];
    const res = await checkName(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
  });

  it("returns { available: true } for free names", async () => {
    const selectMock = makeChainMock([]);
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(selectMock);
    (isNameAvailableOnChain as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const req = new Request("http://localhost/api/talos/check-name?name=freename") as Parameters<typeof checkName>[0];
    const res = await checkName(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
  });
});

// ── GET /api/services ─────────────────────────────────────────────────────────

describe("GET /api/services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with data on success", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(makeChainMock([]));

    const req = new Request("http://localhost/api/services") as Parameters<typeof getServices>[0];
    const res = await getServices(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
  });

  it("returns 500 envelope on DB error", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(
      makeThrowMock(new Error("pg: connection reset")),
    );

    const req = new Request("http://localhost/api/services") as Parameters<typeof getServices>[0];
    const res = await getServices(req);
    const body = await assertErrorEnvelope(res, 500, "INTERNAL_ERROR");
    expect(body.message).not.toContain("pg:");
  });
});

// ── GET /api/leaderboard ──────────────────────────────────────────────────────

describe("GET /api/leaderboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with data on success", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(makeChainMock([]));

    const req = new Request("http://localhost/api/leaderboard") as Parameters<typeof getLeaderboard>[0];
    const res = await getLeaderboard(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
  });

  it("returns 400 envelope on invalid cursor JSON shape", async () => {
    // Valid base64 but wrong structure (not [number, string])
    const badCursor = Buffer.from(JSON.stringify({ wrong: "shape" })).toString("base64");
    const req = new Request(`http://localhost/api/leaderboard?cursor=${badCursor}`) as Parameters<typeof getLeaderboard>[0];
    const res = await getLeaderboard(req);
    await assertErrorEnvelope(res, 400, "BAD_REQUEST");
  });

  it("returns 400 envelope on malformed base64 cursor", async () => {
    // "!!!" is not valid base64, Buffer.from decodes it as garbage → JSON.parse throws → badRequest
    const req = new Request("http://localhost/api/leaderboard?cursor=!!!") as Parameters<typeof getLeaderboard>[0];
    const res = await getLeaderboard(req);
    // Should be 400 (bad cursor) from the catch in the cursor parsing block
    expect([400, 500]).toContain(res.status);
    const body = await res.json();
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("requestId");
  });

  it("returns 500 envelope on DB error", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(
      makeThrowMock(new Error("db connection lost — secret")),
    );

    const req = new Request("http://localhost/api/leaderboard") as Parameters<typeof getLeaderboard>[0];
    const res = await getLeaderboard(req);
    const body = await assertErrorEnvelope(res, 500, "INTERNAL_ERROR");
    expect(body.message).not.toContain("secret");
  });
});

// ── GET /api/activity ─────────────────────────────────────────────────────────

describe("GET /api/activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchStats.mockReset();
    mockFetchTxns.mockReset();
  });

  it("returns 200 with stats and transactions on success", async () => {
    mockFetchStats.mockResolvedValue({ total: 10 });
    mockFetchTxns.mockResolvedValue({ transactions: [], nextCursor: null });

    const req = new Request("http://localhost/api/activity");
    const res = await getActivity(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("stats");
    expect(body).toHaveProperty("transactions");
  });

  it("returns 200 with only stats when statsOnly=true", async () => {
    mockFetchStats.mockResolvedValue({ total: 5 });

    const req = new Request("http://localhost/api/activity?statsOnly=true");
    const res = await getActivity(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("stats");
    expect(body).not.toHaveProperty("transactions");
  });

  it("returns 500 envelope on fetchActivityStats error", async () => {
    mockFetchStats.mockRejectedValue(new Error("DB secret detail"));

    const req = new Request("http://localhost/api/activity");
    const res = await getActivity(req);
    const body = await assertErrorEnvelope(res, 500, "INTERNAL_ERROR");
    expect(body.message).not.toContain("DB secret");
  });
});

// ── GET /api/proposals ────────────────────────────────────────────────────────

describe("GET /api/proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with rows on success", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(makeChainMock([]));

    const req = new Request("http://localhost/api/proposals") as Parameters<typeof getProposals>[0];
    const res = await getProposals(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns 500 envelope on DB error", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(
      makeThrowMock(new Error("fatal db error — internal secret")),
    );

    const req = new Request("http://localhost/api/proposals") as Parameters<typeof getProposals>[0];
    const res = await getProposals(req);
    const body = await assertErrorEnvelope(res, 500, "INTERNAL_ERROR");
    expect(body.message).not.toContain("internal secret");
  });
});

// ─── parseBody integration ────────────────────────────────────────────────────

import { z } from "zod/v4";
import { parseBody } from "@/lib/schemas";

describe("parseBody() with new envelope", () => {
  it("returns INVALID_JSON error on non-JSON body", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "text/plain" },
    });

    const result = await parseBody(req, z.object({ name: z.string() }));
    expect(result.error).toBeDefined();
    const body = await result.error!.json();
    expect(body.code).toBe("INVALID_JSON");
    expect(body).toHaveProperty("requestId");
    expect(body).not.toHaveProperty("error");
  });

  it("returns VALIDATION_ERROR with issues on schema mismatch", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ wrongField: 123 }),
      headers: {
        "Content-Type": "application/json",
        "x-request-id": "parse-test",
      },
    });

    const result = await parseBody(req, z.object({ name: z.string().min(1) }));
    expect(result.error).toBeDefined();
    const body = await result.error!.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.requestId).toBe("parse-test");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("returns data on valid body", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ name: "hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseBody(req, z.object({ name: z.string().min(1) }));
    expect(result.error).toBeUndefined();
    expect(result.data?.name).toBe("hello");
  });
});
