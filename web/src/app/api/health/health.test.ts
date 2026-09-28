/**
 * Tests for health and readiness probe endpoints.
 *
 * We mock the database and global fetch to simulate healthy, degraded,
 * failing, and timed-out dependency states.  Fake timers are used to verify
 * bounded timeouts without waiting real time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
      vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const response = await healthGet(healthRequest());
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");

      const body = await response.json();
      expect(body).toEqual({
        ok: true,
        status: "ok",
        ready: true,
        checks: { db: "ok", stellar: "ok" },
        ts: expect.any(String),
      });
      expect(isIsoString(body.ts)).toBe(true);
    });

    it("returns 503 unavailable when the database is down (critical)", async () => {
      vi.mocked(db.execute).mockRejectedValue(new Error("connection refused"));
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const response = await healthGet(healthRequest());
      expect(response.status).toBe(503);

      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.status).toBe("unavailable");
      expect(body.ready).toBe(false);
      expect(body.checks).toEqual({ db: "error", stellar: "ok" });
    });

    it("returns 200 degraded when Horizon fails (soft dependency)", async () => {
      vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
      mockFetch.mockResolvedValue(new Response(null, { status: 503 }));

      const response = await healthGet(healthRequest());
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.status).toBe("degraded");
      expect(body.ready).toBe(true);
      expect(body.checks).toEqual({ db: "ok", stellar: "error" });
    });

    it("returns 503 unavailable when both dependencies fail", async () => {
      vi.mocked(db.execute).mockRejectedValue(new Error("database down"));
      mockFetch.mockRejectedValue(new Error("network error"));

      const response = await healthGet(healthRequest());
      expect(response.status).toBe(503);

      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.status).toBe("unavailable");
      expect(body.ready).toBe(false);
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
        () => new Promise(() => {}) as never // never settles
      );
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const pending = healthGet(healthRequest());
      await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS + 10);
      const response = await pending;

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.checks).toEqual({ db: "error", stellar: "ok" });
    });

    it("returns a bounded degraded response when Horizon times out", async () => {
      vi.useFakeTimers();
      vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
      mockFetch.mockImplementation(
        () => new Promise(() => {}) as never // never settles
      );

      const pending = healthGet(healthRequest());
      await vi.advanceTimersByTimeAsync(STELLAR_TIMEOUT_MS + 10);
      const response = await pending;

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("degraded");
      expect(body.ready).toBe(true);
      expect(body.checks).toEqual({ db: "ok", stellar: "error" });
    });
  });

  describe("readiness probe (GET /api/health/ready)", () => {
    it("matches the main /api/health response contract", async () => {
      vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
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
        () => new Promise(() => {}) as never
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


describe("health probe timeout env config", () => {
  const prevDb = process.env.HEALTH_DB_TIMEOUT_MS;
  const prevStellar = process.env.HEALTH_STELLAR_TIMEOUT_MS;

  afterEach(() => {
    if (prevDb === undefined) delete process.env.HEALTH_DB_TIMEOUT_MS;
    else process.env.HEALTH_DB_TIMEOUT_MS = prevDb;
    if (prevStellar === undefined) delete process.env.HEALTH_STELLAR_TIMEOUT_MS;
    else process.env.HEALTH_STELLAR_TIMEOUT_MS = prevStellar;
  });

  it("uses defaults when env vars are unset", async () => {
    delete process.env.HEALTH_DB_TIMEOUT_MS;
    delete process.env.HEALTH_STELLAR_TIMEOUT_MS;
    const { resolveDbTimeoutMs, resolveStellarTimeoutMs, DEFAULT_DB_TIMEOUT_MS, DEFAULT_STELLAR_TIMEOUT_MS } = await import("./utils");
    expect(resolveDbTimeoutMs({})).toBe(DEFAULT_DB_TIMEOUT_MS);
    expect(resolveStellarTimeoutMs({})).toBe(DEFAULT_STELLAR_TIMEOUT_MS);
  });

  it("honors valid HEALTH_*_TIMEOUT_MS overrides", async () => {
    const { parseTimeoutMs, resolveDbTimeoutMs, resolveStellarTimeoutMs } = await import("./utils");
    expect(parseTimeoutMs("1500", 2000)).toBe(1500);
    expect(resolveDbTimeoutMs({ HEALTH_DB_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(resolveStellarTimeoutMs({ HEALTH_STELLAR_TIMEOUT_MS: "4500" })).toBe(4500);
  });

  it("falls back on malformed, zero, and out-of-range values", async () => {
    const { parseTimeoutMs } = await import("./utils");
    expect(parseTimeoutMs("nope", 2000)).toBe(2000);
    expect(parseTimeoutMs("0", 2000)).toBe(2000);
    expect(parseTimeoutMs("-5", 2000)).toBe(2000);
    expect(parseTimeoutMs("999999", 2000)).toBe(2000);
    expect(parseTimeoutMs("12.5", 2000)).toBe(2000);
    expect(parseTimeoutMs("  ", 2000)).toBe(2000);
  });
});


describe("summarizeReadiness", () => {
  it("classifies ok / degraded / unavailable without conflating soft failure with hard failure", async () => {
    const { summarizeReadiness } = await import("./utils");
    expect(summarizeReadiness({ db: "ok", stellar: "ok" })).toEqual({
      status: "ok",
      ok: true,
      ready: true,
      httpStatus: 200,
    });
    expect(summarizeReadiness({ db: "ok", stellar: "error" })).toEqual({
      status: "degraded",
      ok: false,
      ready: true,
      httpStatus: 200,
    });
    expect(summarizeReadiness({ db: "error", stellar: "ok" })).toEqual({
      status: "unavailable",
      ok: false,
      ready: false,
      httpStatus: 503,
    });
    expect(summarizeReadiness({ db: "error", stellar: "error" })).toEqual({
      status: "unavailable",
      ok: false,
      ready: false,
      httpStatus: 503,
    });
  });
});
