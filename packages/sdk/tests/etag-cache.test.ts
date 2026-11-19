/**
 * Tests for the opt-in ETag conditional-GET caching feature.
 * Issue: #982 feat(sdk): support conditional GETs with ETags for agent detail reads
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TalosClient, type ETagStore, type ETagCacheEntry } from "../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a 200 response carrying an ETag. */
function ok200(body: unknown, etag: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ ETag: etag }),
    json: async () => body,
  } as Response;
}

/** Build a 304 Not Modified response (no body). */
function notModified304(): Response {
  return {
    ok: false,
    status: 304,
    headers: new Headers(),
    text: async () => "",
  } as unknown as Response;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ETag conditional-GET cache", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Disabled by default ─────────────────────────────────────

  it("is disabled by default — no If-None-Match header sent", async () => {
    const client = new TalosClient({ baseUrl: "http://localhost:3000" });

    vi.mocked(fetch).mockResolvedValue(ok200({ id: "1" }, '"v1"'));

    await client.getTalos("1");

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init?.headers as Record<string, string>)?.["If-None-Match"]).toBeUndefined();
  });

  it("getETagStore returns null when disabled", () => {
    const client = new TalosClient({ baseUrl: "http://localhost:3000" });
    expect(client.getETagStore()).toBeNull();
  });

  // ── 200 → populate cache ────────────────────────────────────

  it("populates the cache when server returns ETag on 200", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: true,
    });

    vi.mocked(fetch).mockResolvedValue(ok200({ id: "1", name: "Talos" }, '"abc"'));

    await client.getTalos("1");

    const store = client.getETagStore()!;
    const entry = store.get(`http://localhost:3000/api/talos/1\n`);
    expect(entry).toBeDefined();
    expect(entry?.etag).toBe('"abc"');
    expect(entry?.body).toEqual({ id: "1", name: "Talos" });
  });

  it("sends If-None-Match on subsequent GET after cache is populated", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: true,
    });

    const body = { id: "1", name: "Talos" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok200(body, '"etag-v1"'))
      .mockResolvedValueOnce(notModified304());

    await client.getTalos("1");
    await client.getTalos("1");

    const secondCall = vi.mocked(fetch).mock.calls[1];
    expect((secondCall[1]?.headers as Record<string, string>)?.["If-None-Match"]).toBe('"etag-v1"');
  });

  // ── 304 → return cached body ────────────────────────────────

  it("returns cached body transparently on 304", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: true,
    });

    const body = { id: "1", name: "Talos Cached" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok200(body, '"etag-v1"'))
      .mockResolvedValueOnce(notModified304());

    const first = await client.getTalos("1");
    const second = await client.getTalos("1");

    expect(first).toEqual(body);
    expect(second).toEqual(body);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("onCacheHit observer fires on 304", async () => {
    const onCacheHit = vi.fn();
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: { onCacheHit },
    });

    const body = { id: "1" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok200(body, '"tag1"'))
      .mockResolvedValueOnce(notModified304());

    await client.getTalos("1");
    await client.getTalos("1");

    expect(onCacheHit).toHaveBeenCalledOnce();
    expect(onCacheHit).toHaveBeenCalledWith({
      url: "http://localhost:3000/api/talos/1",
      etag: '"tag1"',
    });
  });

  it("onCacheHit is not called on a normal 200", async () => {
    const onCacheHit = vi.fn();
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: { onCacheHit },
    });

    vi.mocked(fetch).mockResolvedValue(ok200({ id: "1" }, '"tag1"'));

    await client.getTalos("1");

    expect(onCacheHit).not.toHaveBeenCalled();
  });

  // ── Full 200 → 304 → 200 sequence ──────────────────────────

  it("handles a full 200 → 304 → fresh 200 sequence", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: true,
    });

    const v1 = { id: "1", version: 1 };
    const v2 = { id: "1", version: 2 };

    vi.mocked(fetch)
      .mockResolvedValueOnce(ok200(v1, '"etag-v1"'))  // 1st call: 200
      .mockResolvedValueOnce(notModified304())          // 2nd call: 304
      .mockResolvedValueOnce(ok200(v2, '"etag-v2"'));  // 3rd call: 200 (resource changed)

    const r1 = await client.getTalos("1");
    const r2 = await client.getTalos("1");
    const r3 = await client.getTalos("1");

    expect(r1).toEqual(v1);
    expect(r2).toEqual(v1);   // served from cache
    expect(r3).toEqual(v2);   // new version
    expect(fetch).toHaveBeenCalledTimes(3);

    // Third call should have sent the *first* etag as If-None-Match
    const thirdHeaders = vi.mocked(fetch).mock.calls[2][1]?.headers as Record<string, string>;
    expect(thirdHeaders["If-None-Match"]).toBe('"etag-v1"');

    // Cache is now updated to v2's etag
    const store = client.getETagStore()!;
    const entry = store.get(`http://localhost:3000/api/talos/1\n`);
    expect(entry?.etag).toBe('"etag-v2"');
    expect(entry?.body).toEqual(v2);
  });

  // ── 200 with no ETag — no caching ──────────────────────────

  it("does not cache when server returns 200 without ETag", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: true,
    });

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: "1" }),
    } as Response);

    await client.getTalos("1");

    const store = client.getETagStore()!;
    const entry = store.get(`http://localhost:3000/api/talos/1\n`);
    expect(entry).toBeUndefined();
  });

  // ── POST is never cached ────────────────────────────────────

  it("does not send If-None-Match or cache POST responses", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: true,
    });

    const data = { id: "new", name: "t", apiKeyOnce: "k" };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ ETag: '"post-etag"' }),
      json: async () => data,
    } as Response);

    await client.createTalos({ name: "t", category: "Test", description: "d" });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init?.headers as Record<string, string>)?.["If-None-Match"]).toBeUndefined();

    // Nothing cached for POST
    const store = client.getETagStore()!;
    expect(store.get(`http://localhost:3000/api/talos\n`)).toBeUndefined();
  });

  // ── Different API keys have isolated caches ──────────────────

  it("different API keys do not share cached entries", async () => {
    const c1 = new TalosClient({ baseUrl: "http://localhost:3000", apiKey: "key-a", etagCache: true });
    const c2 = new TalosClient({ baseUrl: "http://localhost:3000", apiKey: "key-b", etagCache: true });

    const body = { id: "1" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok200(body, '"etag-a"'))
      .mockResolvedValueOnce(ok200(body, '"etag-b"'));

    await c1.getTalos("1");
    await c2.getTalos("1");

    // Neither client sent If-None-Match on its first call (different keys = isolated caches).
    const c1Headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
    const c2Headers = vi.mocked(fetch).mock.calls[1][1]?.headers as Record<string, string>;
    expect(c1Headers["If-None-Match"]).toBeUndefined();
    expect(c2Headers["If-None-Match"]).toBeUndefined();
  });

  // ── LRU eviction ────────────────────────────────────────────

  it("evicts oldest entry when maxEntries is exceeded", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: { maxEntries: 2 },
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(ok200({ id: "a" }, '"e-a"'))
      .mockResolvedValueOnce(ok200({ id: "b" }, '"e-b"'))
      .mockResolvedValueOnce(ok200({ id: "c" }, '"e-c"'));

    await client.getTalos("a");
    await client.getTalos("b");
    await client.getTalos("c");  // triggers eviction of "a"

    const store = client.getETagStore()!;
    // "a" should be evicted
    expect(store.get(`http://localhost:3000/api/talos/a\n`)).toBeUndefined();
    // "b" and "c" should remain
    expect(store.get(`http://localhost:3000/api/talos/b\n`)).toBeDefined();
    expect(store.get(`http://localhost:3000/api/talos/c\n`)).toBeDefined();
  });

  // ── Pluggable store ─────────────────────────────────────────

  it("accepts a custom ETagStore implementation", async () => {
    const map = new Map<string, ETagCacheEntry>();
    const customStore: ETagStore = {
      get: (k) => map.get(k),
      set: (k, v) => { map.set(k, v); },
      delete: (k) => { map.delete(k); },
    };

    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: { store: customStore },
    });

    const body = { id: "1" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok200(body, '"custom-etag"'))
      .mockResolvedValueOnce(notModified304());

    await client.getTalos("1");
    expect(map.size).toBe(1);

    const result = await client.getTalos("1");
    expect(result).toEqual(body);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("getETagStore returns the custom store when provided", () => {
    const customStore: ETagStore = {
      get: () => undefined,
      set: () => {},
      delete: () => {},
    };

    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: { store: customStore },
    });

    expect(client.getETagStore()).toBe(customStore);
  });

  // ── Non-2xx evicts stale entry ──────────────────────────────

  it("evicts cache entry when server returns 404 on a conditional request", async () => {
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      etagCache: true,
      retryPolicy: { maxAttempts: 1 },
    });

    const body = { id: "1" };
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok200(body, '"tag1"'))
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () => "not found",
      } as Response);

    await client.getTalos("1");

    const store = client.getETagStore()!;
    expect(store.get(`http://localhost:3000/api/talos/1\n`)).toBeDefined();

    await expect(client.getTalos("1")).rejects.toMatchObject({ status: 404 });

    // Entry should be evicted after the 404
    expect(store.get(`http://localhost:3000/api/talos/1\n`)).toBeUndefined();
  });

  // ── Constructor validation ────────────────────────────────────

  it("throws RangeError for maxEntries < 1", () => {
    expect(
      () =>
        new TalosClient({
          baseUrl: "http://localhost:3000",
          etagCache: { maxEntries: 0 },
        }),
    ).toThrow(RangeError);
  });

  it("throws TypeError for non-function onCacheHit", () => {
    expect(
      () =>
        new TalosClient({
          baseUrl: "http://localhost:3000",
          etagCache: { onCacheHit: "not-a-function" as unknown as () => void },
        }),
    ).toThrow(TypeError);
  });

  it("throws TypeError for invalid store shape", () => {
    expect(
      () =>
        new TalosClient({
          baseUrl: "http://localhost:3000",
          etagCache: { store: { get: "bad" } as unknown as ETagStore },
        }),
    ).toThrow(TypeError);
  });
});
