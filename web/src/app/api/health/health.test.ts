/**
 * Tests for health and readiness probe endpoints.
 *
 * We mock the database and global fetch to simulate healthy, degraded,
 * failing, and timed-out dependency states.  Fake timers are used to verify
 * bounded timeouts without waiting real time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module before importing routes that use it.
vi.mock("@/db", () => ({
  db: {
    execute: vi.fn(),
  },
}));

// Mock global fetch before importing the routes so they see the mock.
const mockFetch = vi.hoisted(() => {
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  return mock;
});

import { db } from "@/db";
import { GET as healthGet } from "./route";
import { GET as readyGet } from "./ready/route";
import { GET as liveGet } from "./live/route";
import { DB_TIMEOUT_MS, STELLAR_TIMEOUT_MS } from "./utils";

// A fake request object for the /api/health route.
function healthRequest() {
  return { nextUrl: new URL("http://localhost/api/health") } as any;
}

function isIsoString(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

describe("health probes", () => {
  beforeEach(() => {
    vi.resetAllMocks(); // clears calls and resets implementations
    vi.useRealTimers();
  });

  describe("liveness probe (GET /api/health/live)", () => {
    it("returns 200 with ok even when dependencies are unavailable", async () => {
      vi.mocked(db.execute).mockRejectedValue(new Error("db unavailable"));
      mockFetch.mockRejectedValue(new Error("horizon unavailable"));

      const response = await liveGet();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toMatchObject({
        status: "ok",
      });
      expect(typeof body.uptime).toBe("number");
      expect(isIsoString(body.ts)).toBe(true);
      // Liveness must not include dependency checks.
      expect(body.checks).toBeUndefined();
      // Liveness must not touch dependencies.
      expect(db.execute).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns no-store cache header", async () => {
      const response = await liveGet();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });
  });

  describe("readiness probe (GET /api/health)", () => {
    it("returns 200 ok when all dependencies are healthy", async () => {
      vi.mocked(db.execute).mockResolvedValue({ rows: [] });
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const response = await healthGet(healthRequest());
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");

      const body = await response.json();
      expect(body).toEqual({
        ok: true,
        checks: { db: "ok", stellar: "ok" },
        ts: expect.any(String),
      });
      expect(isIsoString(body.ts)).toBe(true);
    });

    it("returns 503 with db error when the database is down", async () => {
      vi.mocked(db.execute).mockRejectedValue(new Error("connection refused"));
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const response = await healthGet(healthRequest());
      expect(response.status).toBe(503);

      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.checks).toEqual({ db: "error", stellar: "ok" });
    });

    it("returns 503 with stellar error when Horizon fails", async () => {
      vi.mocked(db.execute).mockResolvedValue({ rows: [] });
      mockFetch.mockResolvedValue(new Response(null, { status: 503 }));

      const response = await healthGet(healthRequest());
      expect(response.status).toBe(503);

      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.checks).toEqual({ db: "ok", stellar: "error" });
    });

    it("returns 503 with both errors when both dependencies fail", async () => {
      vi.mocked(db.execute).mockRejectedValue(new Error("database down"));
      mockFetch.mockRejectedValue(new Error("network error"));

      const response = await healthGet(healthRequest());
      expect(response.status).toBe(503);

      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.checks).toEqual({ db: "error", stellar: "error" });
    });

    it("does not leak secrets or connection strings", async () => {
      const secret = "postgres://user:hunter2@db.internal:5432/prod";
      const dbError = new Error(`db connection failed: ${secret}`);
      const horizonError = new Error(`horizon auth failed: ${secret}`);

      vi.mocked(db.execute).mockRejectedValue(dbError);
      mockFetch.mockRejectedValue(horizonError);

      const response = await healthGet(healthRequest());
      const text = await response.text();

      expect(text).not.toContain("postgres://");
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("db.internal");
    });

    it("returns a bounded response when the database times out", async () => {
      vi.useFakeTimers();
      vi.mocked(db.execute).mockImplementation(
        () => new Promise(() => {}) // never settles
      );
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const pending = healthGet(healthRequest());
      await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS + 10);
      const response = await pending;

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.checks).toEqual({ db: "error", stellar: "ok" });
    });

    it("returns a bounded response when Horizon times out", async () => {
      vi.useFakeTimers();
      vi.mocked(db.execute).mockResolvedValue({ rows: [] });
      mockFetch.mockImplementation(
        () => new Promise(() => {}) // never settles
      );

      const pending = healthGet(healthRequest());
      await vi.advanceTimersByTimeAsync(STELLAR_TIMEOUT_MS + 10);
      const response = await pending;

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.checks).toEqual({ db: "ok", stellar: "error" });
    });
  });

  describe("readiness probe (GET /api/health/ready)", () => {
    it("matches the main /api/health response contract", async () => {
      vi.mocked(db.execute).mockResolvedValue({ rows: [] });
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const [healthResponse, readyResponse] = await Promise.all([
        healthGet(healthRequest()),
        readyGet(),
      ]);

      expect(readyResponse.status).toBe(healthResponse.status);
      const healthBody = await healthResponse.json();
      const readyBody = await readyResponse.json();
      expect(readyBody.ok).toBe(healthBody.ok);
      expect(readyBody.checks).toEqual(healthBody.checks);
      expect(typeof readyBody.ts).toBe("string");
    });

    it("returns 503 with db error when the database times out", async () => {
      vi.useFakeTimers();
      vi.mocked(db.execute).mockImplementation(
        () => new Promise(() => {})
      );
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const pending = readyGet();
      await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS + 10);
      const response = await pending;

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.checks).toEqual({ db: "error", stellar: "ok" });
    });
  });
});
