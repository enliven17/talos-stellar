import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  verifyAdminKey,
  verifyInternalSecret,
  verifyInternalJobsSecret,
} from "@/lib/admin-auth";

const TEST_ADMIN_KEY = "test-admin-secret-key";
const TEST_INTERNAL_SECRET = "test-internal-secret-key";

function createAdminRequest(authHeader?: string): NextRequest {
  const headers = new Headers();
  if (authHeader !== undefined) {
    headers.set("authorization", authHeader);
  }
  return new NextRequest("http://localhost:3000/api/admin/outbox", { headers });
}

function createInternalRequest(headerName: string, headerValue?: string): NextRequest {
  const headers = new Headers();
  if (headerValue !== undefined) {
    headers.set(headerName, headerValue);
  }
  return new NextRequest("http://localhost:3000/api/jobs/drain", { headers });
}

describe("verifyAdminKey", () => {
  const originalEnv = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_API_KEY = originalEnv;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it("returns 500 when ADMIN_API_KEY is missing from environment", async () => {
    delete process.env.ADMIN_API_KEY;
    const req = createAdminRequest(`Bearer ${TEST_ADMIN_KEY}`);
    const res = verifyAdminKey(req);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(500);
      const json = await res.response.json();
      expect(json).toEqual({ error: "Admin API is not configured" });
    }
  });

  it("returns 401 when Authorization header is missing", async () => {
    const req = createAdminRequest();
    const res = verifyAdminKey(req);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      const json = await res.response.json();
      expect(json).toEqual({
        error: "Missing Authorization header. Use: Bearer <admin_api_key>",
      });
    }
  });

  it("returns 401 when Authorization header does not start with Bearer", async () => {
    const req = createAdminRequest(`Basic ${TEST_ADMIN_KEY}`);
    const res = verifyAdminKey(req);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
    }
  });

  it("returns 403 for wrong ASCII token of same length", async () => {
    const wrongToken = "x".repeat(TEST_ADMIN_KEY.length);
    const req = createAdminRequest(`Bearer ${wrongToken}`);
    const res = verifyAdminKey(req);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      const json = await res.response.json();
      expect(json).toEqual({ error: "Invalid admin API key" });
    }
  });

  it("returns 403 for wrong ASCII token of different length", async () => {
    const req = createAdminRequest("Bearer wrong-key");
    const res = verifyAdminKey(req);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      const json = await res.response.json();
      expect(json).toEqual({ error: "Invalid admin API key" });
    }
  });

  it("returns 403 without throwing RangeError for multi-byte same-length token", async () => {
    // String with matching UTF-16 code units (JS string length) but different byte length in UTF-8
    const multiByteToken = "é".repeat(TEST_ADMIN_KEY.length);
    expect(multiByteToken.length).toBe(TEST_ADMIN_KEY.length);
    expect(Buffer.from(multiByteToken).byteLength).not.toBe(
      Buffer.from(TEST_ADMIN_KEY).byteLength,
    );

    let res: ReturnType<typeof verifyAdminKey>;
    expect(() => {
      res = verifyAdminKey(createAdminRequest(`Bearer ${multiByteToken}`));
    }).not.toThrow();

    expect(res!.ok).toBe(false);
    if (!res!.ok) {
      expect(res!.response.status).toBe(403);
      const json = await res!.response.json();
      expect(json).toEqual({ error: "Invalid admin API key" });
    }
  });

  it("returns { ok: true } for correct token", () => {
    const req = createAdminRequest(`Bearer ${TEST_ADMIN_KEY}`);
    const res = verifyAdminKey(req);

    expect(res.ok).toBe(true);
  });
});

describe("verifyInternalSecret", () => {
  const originalEnv = process.env.INTERNAL_JOBS_SECRET;

  beforeEach(() => {
    process.env.INTERNAL_JOBS_SECRET = TEST_INTERNAL_SECRET;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.INTERNAL_JOBS_SECRET = originalEnv;
    } else {
      delete process.env.INTERNAL_JOBS_SECRET;
    }
  });

  it("returns 500 when configured env var is missing", async () => {
    delete process.env.INTERNAL_JOBS_SECRET;
    const req = createInternalRequest("x-internal-jobs-secret", TEST_INTERNAL_SECRET);
    const res = verifyInternalSecret(req, "INTERNAL_JOBS_SECRET", "x-internal-jobs-secret");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(500);
      const json = await res.response.json();
      expect(json).toEqual({ error: "Internal trigger is not configured" });
    }
  });

  it("returns 403 when header is missing", async () => {
    const req = createInternalRequest("x-internal-jobs-secret");
    const res = verifyInternalSecret(req, "INTERNAL_JOBS_SECRET", "x-internal-jobs-secret");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      const json = await res.response.json();
      expect(json).toEqual({ error: "Invalid or missing secret" });
    }
  });

  it("returns 403 for wrong ASCII token", async () => {
    const wrongToken = "x".repeat(TEST_INTERNAL_SECRET.length);
    const req = createInternalRequest("x-internal-jobs-secret", wrongToken);
    const res = verifyInternalSecret(req, "INTERNAL_JOBS_SECRET", "x-internal-jobs-secret");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      const json = await res.response.json();
      expect(json).toEqual({ error: "Invalid or missing secret" });
    }
  });

  it("returns 403 without throwing RangeError for multi-byte same-length token", async () => {
    const multiByteToken = "é".repeat(TEST_INTERNAL_SECRET.length);
    expect(multiByteToken.length).toBe(TEST_INTERNAL_SECRET.length);

    let res: ReturnType<typeof verifyInternalSecret>;
    expect(() => {
      res = verifyInternalSecret(
        createInternalRequest("x-internal-jobs-secret", multiByteToken),
        "INTERNAL_JOBS_SECRET",
        "x-internal-jobs-secret",
      );
    }).not.toThrow();

    expect(res!.ok).toBe(false);
    if (!res!.ok) {
      expect(res!.response.status).toBe(403);
      const json = await res!.response.json();
      expect(json).toEqual({ error: "Invalid or missing secret" });
    }
  });

  it("returns { ok: true } for correct token", () => {
    const req = createInternalRequest("x-internal-jobs-secret", TEST_INTERNAL_SECRET);
    const res = verifyInternalSecret(req, "INTERNAL_JOBS_SECRET", "x-internal-jobs-secret");

    expect(res.ok).toBe(true);
  });

  it("verifyInternalJobsSecret works end-to-end", () => {
    const req = createInternalRequest("x-internal-jobs-secret", TEST_INTERNAL_SECRET);
    const res = verifyInternalJobsSecret(req);
    expect(res.ok).toBe(true);
  });
});
