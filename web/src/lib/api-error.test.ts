import { describe, it, expect, vi } from "vitest";
import { apiError, internalError, dependencyError, readJson } from "./api-error";

describe("apiError", () => {
  it("returns the standard envelope and keeps legacy `error` string", async () => {
    const res = apiError("NOT_FOUND", "Not found");
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body).toMatchObject({ error: "Not found", code: "NOT_FOUND" });
    expect(typeof body.requestId).toBe("string");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("includes field details and Retry-After when given", async () => {
    const res = apiError("RATE_LIMITED", "Slow down", {
      details: { name: "required" },
      retryAfterSeconds: 10,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
    expect((await res.json()).details).toEqual({ name: "required" });
  });
});

describe("privacy", () => {
  it("internalError never leaks the error message or logs it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = internalError(new Error("SECRET_SEED_abc123"), "test");
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(500);
    expect(text).not.toContain("SECRET_SEED_abc123");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET_SEED_abc123");
    spy.mockRestore();
  });

  it("dependencyError is 503 with a generic message and Retry-After", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = dependencyError("db", new Error("password=hunter2"));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
    spy.mockRestore();
  });
});

describe("readJson", () => {
  it("parses valid JSON", async () => {
    const r = await readJson(new Request("http://x", { method: "POST", body: '{"a":1}' }));
    expect(r).toEqual({ ok: true, data: { a: 1 } });
  });
  it("returns 400 for malformed JSON", async () => {
    const r = await readJson(new Request("http://x", { method: "POST", body: "{bad" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });
  it("returns 400 for an empty body", async () => {
    const r = await readJson(new Request("http://x", { method: "POST" }));
    expect(r.ok).toBe(false);
  });
});