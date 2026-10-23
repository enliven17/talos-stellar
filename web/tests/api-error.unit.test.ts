import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, dependencyError, internalError, readJson } from "@/lib/api-error";

afterEach(() => vi.restoreAllMocks());

describe("apiError", () => {
  it("returns a safe JSON envelope with a request ID", async () => {
    const response = apiError("NOT_FOUND", "Talos not found");
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toMatchObject({ error: "Talos not found", code: "NOT_FOUND" });
    expect(body.requestId).toEqual(expect.any(String));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["BAD_REQUEST", 400],
    ["VALIDATION_FAILED", 422],
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["RATE_LIMITED", 429],
    ["DEPENDENCY_FAILURE", 503],
    ["INTERNAL_ERROR", 500],
  ] as const)("maps %s to HTTP %i", (code, status) => {
    expect(apiError(code, "safe").status).toBe(status);
  });

  it("includes field details and retry timing when supplied", async () => {
    const response = apiError("RATE_LIMITED", "Slow down", {
      details: { limit: "Exceeded" },
      retryAfterSeconds: 5,
    });
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({ details: { limit: "Exceeded" } });
  });

  it("returns generic messages for internal and dependency failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const internal = await internalError(new Error("private detail"), "test").json();
    const dependency = await dependencyError("db", new Error("private detail")).json();
    expect(JSON.stringify(internal)).not.toContain("private detail");
    expect(JSON.stringify(dependency)).not.toContain("private detail");
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

describe("readJson", () => {
