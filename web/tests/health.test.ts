/**
 * Tests for GET /api/health/live (liveness probe) and
 * GET /api/health/ready (readiness probe).
 *
 * Coverage:
 *   - Liveness: always 200, correct shape, no external I/O
 *   - Readiness: healthy (both deps ok), degraded (one dep down),
 *                unavailable (both deps down), timeout behaviour,
 *                Cache-Control header, backward-compat alias
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Liveness probe ───────────────────────────────────────────────────────────

import { GET as getLive } from "@/app/api/health/live/route";

describe("GET /api/health/live", () => {
  it("returns 200 with status=ok", async () => {
    const res = getLive();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("includes uptime (non-negative integer) and ts (ISO string)", async () => {
    const res = getLive();
    const body = await res.json();
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.uptime)).toBe(true);
    expect(typeof body.ts).toBe("string");
    expect(() => new Date(body.ts)).not.toThrow();
  });

  it("sets Cache-Control: no-store", () => {
    const res = getLive();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never calls fetch or any external service", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    getLive();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── Readiness probe ──────────────────────────────────────────────────────────

vi.mock("@/db", () => ({
  db: { execute: vi.fn() },
}));

import { GET as getReady } from "@/app/api/health/ready/route";
import { db } from "@/db";

const mockExecute = db.execute as ReturnType<typeof vi.fn>;

describe("GET /api/health/ready", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Healthy ────────────────────────────────────────────────────────

  it("returns 200 with ok=true when both deps pass", async () => {
    mockExecute.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await getReady();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe("ok");
    expect(body.checks.stellar).toBe("ok");
    expect(typeof body.ts).toBe("string");
  });

  // ── Degraded — one dep down ────────────────────────────────────────

  it("returns 503 with checks.db=error when DB is down", async () => {
    mockExecute.mockRejectedValue(new Error("ECONNREFUSED"));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await getReady();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("error");
    expect(body.checks.stellar).toBe("ok");
  });

  it("returns 503 with checks.stellar=error when Stellar is unreachable", async () => {
    mockExecute.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("fetch failed"),
    );

    const res = await getReady();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("ok");
    expect(body.checks.stellar).toBe("error");
  });

  it("returns 503 with checks.stellar=error when Horizon returns non-2xx", async () => {
    mockExecute.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 503 }),
    );

    const res = await getReady();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.stellar).toBe("error");
  });

  // ── Unavailable — both deps down ───────────────────────────────────

  it("returns 503 with both checks=error when all deps are down", async () => {
    mockExecute.mockRejectedValue(new Error("DB offline"));
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error"),
    );

    const res = await getReady();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("error");
    expect(body.checks.stellar).toBe("error");
  });

  // ── Timeout behaviour ──────────────────────────────────────────────

  it("returns 503 when DB check times out", async () => {
    // Never resolves — simulates a hung DB
    mockExecute.mockReturnValue(new Promise(() => {}));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await getReady();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.db).toBe("error");
    expect(body.checks.stellar).toBe("ok");
  }, 10_000);

  it("returns 503 when Stellar check times out", async () => {
    mockExecute.mockResolvedValue([]);
    // Never resolves — simulates a hung Horizon
    (fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    const res = await getReady();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.db).toBe("ok");
    expect(body.checks.stellar).toBe("error");
  }, 10_000);

  // ── Headers ────────────────────────────────────────────────────────

  it("sets Cache-Control: no-store on 200", async () => {
    mockExecute.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await getReady();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sets Cache-Control: no-store on 503", async () => {
    mockExecute.mockRejectedValue(new Error("down"));
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));

    const res = await getReady();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ─── Backward-compat alias /api/health ───────────────────────────────────────

import { GET as getLegacy } from "@/app/api/health/route";

describe("GET /api/health (legacy alias)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns 200 with ok=true when both deps pass (same behaviour as /ready)", async () => {
    mockExecute.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await getLegacy();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe("ok");
    expect(body.checks.stellar).toBe("ok");
  });

  it("returns 503 when DB is down (same behaviour as /ready)", async () => {
    mockExecute.mockRejectedValue(new Error("ECONNREFUSED"));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await getLegacy();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("error");
  });

  it("sets Cache-Control: no-store", async () => {
    mockExecute.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await getLegacy();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
