import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError, apiError, getRequestId, readJson, toErrorResponse, withApiErrors } from "@/lib/api-error";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("apiError envelope", () => {
  it("keeps the legacy string `error` field and adds code + requestId", async () => {
    const res = apiError("NOT_FOUND", "Talos not found");
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe("Talos not found");
    expect(body.code).toBe("NOT_FOUND");
    expect(body.requestId).toBeTruthy();
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["BAD_REQUEST", 400],
    ["MALFORMED_JSON", 400],
    ["VALIDATION_ERROR", 400],
    ["UNAUTHORIZED", 401],
    ["PAYMENT_REQUIRED", 402],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["RATE_LIMITED", 429],
    ["INTERNAL_ERROR", 500],
    ["DEPENDENCY_UNAVAILABLE", 503],
  ] as const)("maps %s to %i", (code, status) => {
    expect(apiError(code, "x").status).toBe(status);
  });

  it("omits details/retry fields when not provided (boundary)", async () => {
    const body = await apiError("BAD_REQUEST", "x").json();
    expect("details" in body).toBe(false);
    expect("retryAfterSeconds" in body).toBe(false);
  });

  it("sets Retry-After and rounds up / clamps at 0 (retry boundary)", () => {
    expect(apiError("RATE_LIMITED", "x", { retryAfterSeconds: 1.2 }).headers.get("retry-after")).toBe("2");
    expect(apiError("RATE_LIMITED", "x", { retryAfterSeconds: -5 }).headers.get("retry-after")).toBe("0");
  });
});

describe("getRequestId", () => {
  it("reuses a well-formed inbound id", () => {
    const req = new Request("http://x", { headers: { "x-request-id": "abc12345-def" } });
    expect(getRequestId(req)).toBe("abc12345-def");
  });
  it("rejects malformed inbound ids (header injection / oversize)", () => {
    const req = new Request("http://x", { headers: { "x-request-id": "bad id with spaces" } });
    expect(getRequestId(req)).not.toBe("bad id with spaces");
    const long = new Request("http://x", { headers: { "x-request-id": "a".repeat(65) } });
    expect(getRequestId(long)).not.toBe("a".repeat(65));
  });
});

describe("toErrorResponse", () => {
  it("passes ApiError through", async () => {
    const res = toErrorResponse(new ApiError("CONFLICT", "Name taken"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
  });

  it("maps SyntaxError to MALFORMED_JSON 400", async () => {
    const res = toErrorResponse(new SyntaxError("Unexpected token"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("MALFORMED_JSON");
  });

  it("maps Zod-like errors to VALIDATION_ERROR with paths only, never values", async () => {
    const err = Object.assign(new Error("z"), {
      name: "ZodError",
      issues: [{ path: ["wallet", "secret"], message: "Required", received: "SDSECRETVALUE" }],
    });
    const res = toErrorResponse(err);
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(400);
    expect(text).toContain("wallet.secret");
    expect(text).not.toContain("SDSECRETVALUE");
  });

  it("returns a generic 500 and never leaks the error message (privacy)", async () => {
    const res = toErrorResponse(new Error("postgres://user:hunter2@db.internal/prod failed"));
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(500);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("postgres://");
  });

  it("does not log the error message or stack (privacy)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    toErrorResponse(new Error("S_SECRET_SEED_123"));
    expect(JSON.stringify(spy.mock.calls)).not.toContain("S_SECRET_SEED_123");
  });

  it.each(["ECONNREFUSED", "ETIMEDOUT", "08006", "57P01", "40001"])(
    "maps dependency failure %s to 503 with Retry-After",
    async (code) => {
      const res = toErrorResponse(Object.assign(new Error("boom"), { code }));
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(res.headers.get("retry-after")).toBe("5");
    },
  );
});

describe("withApiErrors", () => {
  it("returns the handler response untouched on success (regression)", async () => {
    const handler = withApiErrors(async () => Response.json({ ok: true }, { status: 201 }));
    const res = await handler(new Request("http://x"));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("catches thrown errors and echoes the inbound request id", async () => {
    const handler = withApiErrors(async () => {
      throw new ApiError("FORBIDDEN", "Nope");
    });
    const res = await handler(new Request("http://x", { headers: { "x-request-id": "req-12345678" } }));
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.requestId).toBe("req-12345678");
  });

  it("forwards extra route args such as params", async () => {
    const handler = withApiErrors(async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
      Response.json({ id: (await ctx.params).id }),
    );
    const res = await handler(new Request("http://x"), { params: Promise.resolve({ id: "42" }) });
    expect(await res.json()).toEqual({ id: "42" });
  });
});

describe("readJson", () => {
  it("parses valid JSON", async () => {
    const req = new Request("http://x", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(await readJson(req)).toEqual({ a: 1 });
  });
  it("throws MALFORMED_JSON on empty or invalid body (missing/malformed input)", async () => {
    await expect(readJson(new Request("http://x", { method: "POST", body: "{bad" }))).rejects.toMatchObject({
      code: "MALFORMED_JSON",
    });
    await expect(readJson(new Request("http://x", { method: "POST" }))).rejects.toMatchObject({
      code: "MALFORMED_JSON",
    });
  });
});