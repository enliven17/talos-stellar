import { describe, it, expect, vi, beforeEach, afterEach, vi as vitest } from "vitest";

vi.mock("@/db", () => ({
  db: { execute: vi.fn() },
}));

import { GET } from "@/app/api/health/route";
import { db } from "@/db";

const mockExecute = db.execute as ReturnType<typeof vi.fn>;

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("returns 200 with ok=true when both checks pass", async () => {
    mockExecute.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe("ok");
    expect(body.checks.stellar).toBe("ok");
    expect(typeof body.ts).toBe("string");
  });

  it("returns 503 with checks.db=error when DB is down", async () => {
    mockExecute.mockRejectedValue(new Error("ECONNREFUSED"));
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await GET();

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

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("ok");
    expect(body.checks.stellar).toBe("error");
  });

  it("sets Cache-Control: no-store on all responses", async () => {
    mockExecute.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const res = await GET();

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("aborts fetch request on timeout", async () => {
    mockExecute.mockResolvedValue([]);
    let fetchSignal: AbortSignal | undefined;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation((url, opts) => {
      fetchSignal = opts?.signal;
      return new Promise(() => {}); // Never resolve
    });

    const promise = GET();
    vi.advanceTimersByTime(4000); // More than 3000ms for stellar timeout
    await promise;

    expect(fetchSignal?.aborted).toBe(true);
  });

  it("clears timers when main promise resolves before timeout", async () => {
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    mockExecute.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    await GET();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});
