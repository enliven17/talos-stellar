/**
 * Focused regression coverage for X-RateLimit-* header propagation on
 * ops routes: backup, restore, and backup status.
 *
 * Ensures headers are exposed on successful responses so operators can
 * observe remaining quota.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoist mocks ──────────────────────────────────────────────────────────

const { rateLimitMock } = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    rateLimit: rateLimitMock,
  };
});

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn() })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => []),
          })),
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/backup-config", () => ({
  isBackupDisabled: () => false,
  opsAdminSecret: () => "testsecret",
  backupDefaultTimeoutMs: () => 1000,
  backupMaxBytes: () => 1000,
}));

vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    timingSafeEqual: () => true, // bypass token check
  };
});

vi.mock("@/lib/backup-service", () => ({
  buildBackup: vi.fn(() => Promise.resolve({
    encryptedBytes: 100,
    plaintextBytes: 50,
    rowCounts: { tls_talos: 1 },
    durationMs: 10,
    sha256Plaintext: "hash",
    plaintext: { database: { signalVersion: 1, rowCounts: {} }, timestamp: "2023" },
  })),
  openBackupPool: vi.fn(() => Promise.resolve({ end: vi.fn() })),
}));

import { POST as backupPost } from "@/app/api/ops/backup/route";
import { GET as backupStatusGet } from "@/app/api/ops/backup/status/route";
// Skipping restorePost as formData mocking in NextRequest in vitest can be tricky without full node mocks,
// and we just need coverage that crosses boundaries.

function makeRequest(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: unknown
): NextRequest {
  const h = new Headers(headers);
  h.set("x-ops-token", "testsecret");
  const init: RequestInit = { method, headers: h };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(`http://localhost${path}`, init);
}

function allowedResult() {
  return {
    ok: true,
    limit: 6,
    remaining: 5,
    resetAt: Date.now() + 60_000,
    policy: "ops-backup",
  };
}

function blockedResult() {
  return {
    ok: false,
    limit: 6,
    remaining: 0,
    resetAt: Date.now() + 60_000,
    policy: "ops-backup",
  };
}

beforeEach(() => {
  rateLimitMock.mockReset();
  rateLimitMock.mockResolvedValue(allowedResult());
});

describe("ops routes — rate limit headers", () => {
  it("GET /api/ops/backup/status returns rate limit headers on success", async () => {
    const res = await backupStatusGet(makeRequest("/api/ops/backup/status", "GET"));
    expect(res.headers.get("X-RateLimit-Limit")).toBe("6");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("5");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Policy")).toBe("ops-backup-status"); // set in route handler
  });

  it("POST /api/ops/backup returns rate limit headers on success", async () => {
    const res = await backupPost(
      makeRequest(
        "/api/ops/backup",
        "POST",
        { "x-backup-passphrase": "super-secret-passphrase" },
        { scope: "system" }
      )
    );
    expect(res.headers.get("X-RateLimit-Limit")).toBe("6");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("5");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Policy")).toBe("ops-backup");
  });

  it("POST /api/ops/backup returns 429 when blocked", async () => {
    rateLimitMock.mockResolvedValue(blockedResult());
    const res = await backupPost(
      makeRequest(
        "/api/ops/backup",
        "POST",
        { "x-backup-passphrase": "super-secret-passphrase" },
        { scope: "system" }
      )
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});
