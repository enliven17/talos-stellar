/**
 * Tests for the opt-in in-flight GET deduplication feature.
 * Issue: #981 perf(sdk): coalesce concurrent identical GET requests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TalosClient } from "../src/index.js";

describe("dedupeInFlightGets", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Disabled by default ───────────────────────────────────

  it("is disabled by default — two concurrent GETs each issue a fetch", async () => {
    const client = new TalosClient({ baseUrl: "http://localhost:3000" });

    let resolveFirst!: (v: Response) => void;
    let resolveSecond!: (v: Response) => void;

    vi.mocked(fetch)
      .mockImplementationOnce(
        () => new Promise<Response>((r) => { resolveFirst = r; }),
      )
      .mockImplementationOnce(
        () => new Promise<Response>((r) => { resolveSecond = r; }),
      );

    const p1 = client.getTalos("1");
    const p2 = client.getTalos("1");

    resolveFirst({ ok: true, json: async () => ({ id: "1" }) } as Response);
    resolveSecond({ ok: true, json: async () => ({ id: "1" }) } as Response);

    await Promise.all([p1, p2]);

    // Without dedup, two fetches are expected.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // ── Enabled (boolean true) ────────────────────────────────

  it("two concurrent identical GETs produce exactly one fetch when enabled", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: true,
    });

    let settle!: (v: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((r) => { settle = r; }),
    );

    const data = { id: "1", name: "Talos" };
    const p1 = client.getTalos("1");
    const p2 = client.getTalos("1");

    settle({ ok: true, json: async () => data } as Response);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(data);
    expect(r2).toEqual(data);
  });

  it("a third concurrent call is also coalesced", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: true,
    });

    let settle!: (v: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((r) => { settle = r; }),
    );

    const data = { id: "x" };
    const p1 = client.getTalos("x");
    const p2 = client.getTalos("x");
    const p3 = client.getTalos("x");

    settle({ ok: true, json: async () => data } as Response);

    const results = await Promise.all([p1, p2, p3]);

    expect(fetch).toHaveBeenCalledTimes(1);
    results.forEach((r) => expect(r).toEqual(data));
  });

  it("after the first promise settles, the next call issues a new fetch", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: true,
    });

    const data = { id: "1" };
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => data } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => data } as Response);

    await client.getTalos("1");
    await client.getTalos("1");

    // Sequential calls each get their own fetch.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // ── Different URLs / identities are NOT coalesced ─────────

  it("different URLs are not coalesced", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: true,
    });

    const data = { id: "x" };
    vi.mocked(fetch)
      .mockResolvedValue({ ok: true, json: async () => data } as Response);

    await Promise.all([client.getTalos("1"), client.getTalos("2")]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("different API keys are not coalesced", async () => {
    const c1 = new TalosClient({ baseUrl: "http://localhost:3000", apiKey: "key-a", dedupeInFlightGets: true });
    const c2 = new TalosClient({ baseUrl: "http://localhost:3000", apiKey: "key-b", dedupeInFlightGets: true });

    const data = { id: "1" };
    vi.mocked(fetch)
      .mockResolvedValue({ ok: true, json: async () => data } as Response);

    await Promise.all([c1.getTalos("1"), c2.getTalos("1")]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // ── Non-GET requests are never deduped ────────────────────

  it("POST requests are never deduped even when feature is enabled", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: true,
    });

    const data = { id: "new", name: "t", apiKeyOnce: "k" };
    vi.mocked(fetch)
      .mockResolvedValue({ ok: true, json: async () => data } as Response);

    await Promise.all([
      client.createTalos({ name: "t", category: "Test", description: "d" }),
      client.createTalos({ name: "t", category: "Test", description: "d" }),
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // ── onDedupe observer ─────────────────────────────────────

  it("onDedupe is called for each request that reuses an in-flight promise", async () => {
    const onDedupe = vi.fn();
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: { onDedupe },
    });

    let settle!: (v: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((r) => { settle = r; }),
    );

    const p1 = client.getTalos("1");
    const p2 = client.getTalos("1");
    const p3 = client.getTalos("1");

    settle({ ok: true, json: async () => ({ id: "1" }) } as Response);
    await Promise.all([p1, p2, p3]);

    // p2 and p3 reuse the in-flight promise; p1 is the originator.
    expect(onDedupe).toHaveBeenCalledTimes(2);
    expect(onDedupe).toHaveBeenCalledWith({ url: "http://localhost:3000/api/talos/1", method: "GET" });
  });

  // ── getInFlightCount ──────────────────────────────────────

  it("getInFlightCount reflects current map size", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: true,
    });

    let settle!: (v: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((r) => { settle = r; }),
    );

    expect(client.getInFlightCount()).toBe(0);

    const p = client.getTalos("cnt");
    expect(client.getInFlightCount()).toBe(1);

    settle({ ok: true, json: async () => ({ id: "cnt" }) } as Response);
    await p;

    expect(client.getInFlightCount()).toBe(0);
  });

  // ── maxInFlight capacity ──────────────────────────────────

  it("bypasses dedup when map is at maxInFlight capacity", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: { maxInFlight: 1 },
    });

    let settleA!: (v: Response) => void;
    let settleB!: (v: Response) => void;

    // Two different in-flight keys: /api/talos/a and /api/talos/b
    vi.mocked(fetch)
      .mockImplementationOnce(() => new Promise<Response>((r) => { settleA = r; }))
      .mockImplementationOnce(() => new Promise<Response>((r) => { settleB = r; }));

    const data = { id: "x" };
    const pA = client.getTalos("a"); // fills the 1-slot map
    const pB = client.getTalos("b"); // capacity reached → bypasses dedup, issues new fetch

    settleA({ ok: true, json: async () => data } as Response);
    settleB({ ok: true, json: async () => data } as Response);

    await Promise.all([pA, pB]);

    // Both issued their own fetch (map was at capacity for pB).
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // ── Error propagation ─────────────────────────────────────

  it("when the shared request fails, all coalesced callers receive the error", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: true,
      retryPolicy: { maxAttempts: 1 },
    });

    let settle!: (v: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((r) => { settle = r; }),
    );

    const p1 = client.getTalos("err");
    const p2 = client.getTalos("err");

    settle({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "not found",
    } as Response);

    await expect(p1).rejects.toMatchObject({ status: 404 });
    await expect(p2).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("after a failed shared request settles, the next call issues a fresh fetch", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      dedupeInFlightGets: true,
      retryPolicy: { maxAttempts: 1 },
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => "err",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "1" }),
      } as Response);

    await expect(client.getTalos("1")).rejects.toMatchObject({ status: 500 });
    await expect(client.getTalos("1")).resolves.toEqual({ id: "1" });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // ── Constructor validation ────────────────────────────────

  it("throws RangeError for maxInFlight < 1", () => {
    expect(
      () => new TalosClient({ baseUrl: "http://localhost:3000", dedupeInFlightGets: { maxInFlight: 0 } }),
    ).toThrow(RangeError);
  });

  it("throws TypeError for non-function onDedupe", () => {
    expect(
      () =>
        new TalosClient({
          baseUrl: "http://localhost:3000",
          dedupeInFlightGets: { onDedupe: "not-a-function" as unknown as () => void },
        }),
    ).toThrow(TypeError);
  });
});
