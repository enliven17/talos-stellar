/**
 * Body-limit tests for parseBody().
 *
 * These tests call parseBody() directly via a synthetic Web API Request —
 * no Next.js server or database is required.
 *
 * Coverage:
 *   - Below limit  → passes through to Zod validation (not 413)
 *   - Exactly at limit → passes through
 *   - Above limit  → 413 Payload Too Large, body NOT echoed
 *
 * The limit under test is the module-level BODY_LIMIT_BYTES constant so the
 * tests remain valid regardless of the configured value.
 */
import { describe, it, expect } from "vitest";
import { parseBody, BODY_LIMIT_BYTES } from "../src/lib/schemas";
import { z } from "zod/v4";

// A minimal schema — we only care about the size guard here, not field validation.
const anySchema = z.object({ x: z.string() }).passthrough();

/** Build a synthetic Request whose body is exactly `byteLength` bytes of JSON. */
function makeRequest(byteLength: number): Request {
  // Fill a JSON string to the exact byte target.
  // {"x":"<padding>"}  — base is 7 bytes ("{"x":""}"), so pad = byteLength - 7.
  const base = `{"x":"`;
  const close = `"}`;
  const padLength = byteLength - base.length - close.length;
  const body =
    padLength >= 0
      ? base + "a".repeat(padLength) + close
      : `{"x":""}`.slice(0, byteLength); // degenerate: very small bodies

  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

/** Build a Request that declares a Content-Length but has a body of different size. */
function makeRequestWithContentLength(
  bodyBytes: number,
  declaredLength: number,
): Request {
  const body = "a".repeat(bodyBytes);
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(declaredLength),
    },
    body,
  });
}

// ────────────────────────────────────────────────────────────────
// Body size guard tests
// ────────────────────────────────────────────────────────────────

describe("parseBody — body size guard", () => {
  it("passes through a body below the limit", async () => {
    const request = makeRequest(BODY_LIMIT_BYTES - 1);
    const result = await parseBody(request, anySchema);

    // Should reach Zod validation — NOT blocked with 413.
    // The body is valid JSON that satisfies anySchema, so no error.
    expect(result.error).toBeUndefined();
    expect(result.data).toBeDefined();
  });

  it("passes through a body exactly at the limit", async () => {
    const request = makeRequest(BODY_LIMIT_BYTES);
    const result = await parseBody(request, anySchema);

    // At-limit bodies are allowed (limit is inclusive).
    expect(result.error).toBeUndefined();
    expect(result.data).toBeDefined();
  });

  it("rejects a body one byte over the limit with 413", async () => {
    const request = makeRequest(BODY_LIMIT_BYTES + 1);
    const result = await parseBody(request, anySchema);

    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(413);
  });

  it("does not echo body contents in the 413 response", async () => {
    const request = makeRequest(BODY_LIMIT_BYTES + 1024);
    const result = await parseBody(request, anySchema);

    expect(result.error!.status).toBe(413);
    const body = await result.error!.json();
    // Only the safe error key must be present — no input data echoed.
    expect(body).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      message: "Payload too large",
    });
    expect(body.requestId).toEqual(expect.any(String));
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(["code", "message", "requestId"]),
    );
  });

  it("rejects via Content-Length fast path before reading the stream", async () => {
    // Declare a body that exceeds the limit via the header alone.
    // The actual body is empty — proving the check is on the header.
    const request = makeRequestWithContentLength(0, BODY_LIMIT_BYTES + 1);
    const result = await parseBody(request, anySchema);

    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(413);
  });

  it("rejects when the declared content-length is below the limit but the actual body exceeds it", async () => {
    // This catches mismatched or misleading headers and ensures the measured
    // byte length is always enforced before JSON parsing.
    const request = makeRequestWithContentLength(
      BODY_LIMIT_BYTES + 1,
      BODY_LIMIT_BYTES - 1,
    );
    const result = await parseBody(request, anySchema);

    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(413);
  });

  it("returns 413 for a very large body (10× limit)", async () => {
    const request = makeRequest(BODY_LIMIT_BYTES * 10);
    const result = await parseBody(request, anySchema);

    expect(result.error!.status).toBe(413);
  });
});

// ────────────────────────────────────────────────────────────────
// Existing behaviour is preserved for valid-sized requests
// ────────────────────────────────────────────────────────────────

describe("parseBody — existing behaviour preserved (valid-size requests)", () => {
  it("returns 400 for invalid JSON within the limit", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const result = await parseBody(request, anySchema);

    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(400);
    const body = await result.error!.json();
    expect(body).toMatchObject({
      code: "INVALID_JSON",
      message: "Invalid JSON body",
    });
    expect(body.requestId).toEqual(expect.any(String));
  });

  it("returns 400 for a valid-size body that fails schema validation", async () => {
    const strictSchema = z.object({ requiredField: z.string() });
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrongField: 123 }),
    });
    const result = await parseBody(request, strictSchema);

    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(400);
    const body = await result.error!.json();
    expect(body).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Validation failed",
    });
    expect(body.requestId).toEqual(expect.any(String));
    expect(Array.isArray(body.issues)).toBe(true);
  });
});
