/**
 * Per-request endpoint capability negotiation — focused test suite for #1401
 *
 * Covers:
 *   - parseEndpointCapabilities reads api version + feature flags from a
 *     bounded response (Headers and plain records), with missing/empty,
 *     trimming, dedup, and count/length bounds (positive + boundary).
 *   - satisfiesCapabilities / describeCapabilityMismatch for version (single +
 *     array), feature match, and missing cases (positive + negative).
 *   - TalosClient honors per-call `requireCapabilities` on a 2xx response and
 *     fails explicitly with TalosCapabilityError when a required capability is
 *     unavailable (positive + negative + boundary).
 *   - A capability mismatch is never retried and never routed to `onError`
 *     (regression / boundary).
 *   - Omitting `requireCapabilities` preserves the prior accept-any-2xx
 *     behavior (regression).
 *   - Privacy: the error surface never leaks the API key.
 */

import { describe, it, expect, vi } from "vitest";
import {
  TalosClient,
  TalosAPIError,
  TalosCapabilityError,
  parseEndpointCapabilities,
  describeCapabilityMismatch,
  satisfiesCapabilities,
} from "../src/index.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a 2xx Response carrying the given body and response headers. */
function okResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

// ── pure parsers ────────────────────────────────────────────────────────────

describe("parseEndpointCapabilities (#1401)", () => {
  it("reads api version and feature flags from a Headers object", () => {
    const caps = parseEndpointCapabilities(
      new Headers({ "x-talos-api-version": "v1", "x-talos-features": "streaming, quotes" }),
    );
    expect(caps.apiVersion).toBe("v1");
    expect(caps.features).toEqual(["streaming", "quotes"]);
  });

  it("reads from a plain record with lowercased keys", () => {
    const caps = parseEndpointCapabilities({
      "x-talos-api-version": "v2",
      "x-talos-features": "a,b",
    });
    expect(caps.apiVersion).toBe("v2");
    expect(caps.features).toEqual(["a", "b"]);
  });

  it("returns empty capabilities when headers are absent (boundary)", () => {
    const caps = parseEndpointCapabilities(new Headers());
    expect(caps.apiVersion).toBeUndefined();
    expect(caps.features).toEqual([]);
  });

  it("returns empty capabilities for null/undefined input (boundary)", () => {
    expect(parseEndpointCapabilities(null).features).toEqual([]);
    expect(parseEndpointCapabilities(undefined).features).toEqual([]);
  });

  it("trims, drops empties, and deduplicates feature flags", () => {
    const caps = parseEndpointCapabilities({
      "x-talos-features": " x , , y ,x, ",
    });
    expect(caps.features).toEqual(["x", "y"]);
  });

  it("bounds the number of retained feature flags (boundary)", () => {
    const many = Array.from({ length: 80 }, (_, i) => `f${i}`).join(",");
    const caps = parseEndpointCapabilities({ "x-talos-features": many });
    expect(caps.features.length).toBe(64);
  });

  it("bounds the length of each feature flag and the api version (boundary)", () => {
    const longFlag = "z".repeat(200);
    const longVersion = "v".repeat(200);
    const caps = parseEndpointCapabilities({
      "x-talos-features": longFlag,
      "x-talos-api-version": `  ${longVersion}  `,
    });
    expect(caps.features[0]?.length).toBe(64);
    expect(caps.apiVersion?.length).toBe(64);
  });

  it("returns a frozen snapshot", () => {
    const caps = parseEndpointCapabilities({ "x-talos-features": "a" });
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.features)).toBe(true);
  });
});

// ── matching helpers ────────────────────────────────────────────────────────

describe("satisfiesCapabilities / describeCapabilityMismatch (#1401)", () => {
  it("is satisfied when version and features match (positive)", () => {
    expect(
      satisfiesCapabilities(
        { apiVersion: "v1", features: ["a"] },
        { apiVersion: "v1", features: ["a", "b"] },
      ),
    ).toBe(true);
  });

  it("accepts an array of acceptable versions (boundary)", () => {
    expect(
      satisfiesCapabilities({ apiVersion: ["v1", "v2"] }, { apiVersion: "v2", features: [] }),
    ).toBe(true);
  });

  it("fails when the required version is not advertised (negative)", () => {
    expect(
      satisfiesCapabilities({ apiVersion: "v2" }, { apiVersion: "v1", features: [] }),
    ).toBe(false);
  });

  it("fails when a version is required but the endpoint advertises none (boundary)", () => {
    expect(satisfiesCapabilities({ apiVersion: "v1" }, { features: [] })).toBe(false);
  });

  it("fails when a required feature is missing (negative)", () => {
    expect(
      satisfiesCapabilities({ features: ["x", "y"] }, { features: ["x"] }),
    ).toBe(false);
  });

  it("is satisfied by an empty requirement (boundary)", () => {
    expect(satisfiesCapabilities({}, { features: [] })).toBe(true);
  });

  it("describeCapabilityMismatch returns null when satisfied", () => {
    expect(
      describeCapabilityMismatch({ apiVersion: "v1" }, { apiVersion: "v1", features: [] }),
    ).toBeNull();
  });

  it("describeCapabilityMismatch returns a privacy-safe reason when unsatisfied", () => {
    const msg = describeCapabilityMismatch({ features: ["z"] }, { features: ["a"] });
    expect(msg).toMatch(/feature/);
    expect(msg).toContain("z");
  });
});

// ── TalosClient per-request negotiation ─────────────────────────────────────

describe("TalosClient per-request capability negotiation (#1401)", () => {
  it("returns the body when required capabilities are advertised (positive)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ id: "1" }, { "x-talos-api-version": "v1", "x-talos-features": "streaming" }),
    );
    const client = new TalosClient({ baseUrl: "http://localhost:3000", fetch: fetchMock });

    const result = await client.getTalos("1", {
      requireCapabilities: { apiVersion: "v1", features: ["streaming"] },
    });

    expect(result).toEqual({ id: "1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws TalosCapabilityError when a required feature is missing (negative)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ id: "1" }, { "x-talos-api-version": "v1", "x-talos-features": "streaming" }),
    );
    const client = new TalosClient({ baseUrl: "http://localhost:3000", fetch: fetchMock });

    const err = await client
      .getTalos("1", { requireCapabilities: { features: ["missing-flag"] } })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TalosCapabilityError);
    expect(err).toBeInstanceOf(TalosAPIError);
    expect((err as TalosCapabilityError).code).toBe("capability_error");
    expect((err as TalosCapabilityError).isRetryable).toBe(false);
    expect((err as TalosCapabilityError).available.features).toEqual(["streaming"]);
    expect((err as TalosCapabilityError).required.features).toEqual(["missing-flag"]);
    expect(String((err as Error).message)).toMatch(/missing-flag/);
  });

  it("throws when the required API version is not advertised (boundary)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ id: "1" }, { "x-talos-api-version": "v1" }),
    );
    const client = new TalosClient({ baseUrl: "http://localhost:3000", fetch: fetchMock });

    const err = await client
      .getTalos("1", { requireCapabilities: { apiVersion: "v2" } })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TalosCapabilityError);
    expect(String((err as Error).message)).toMatch(/version/i);
  });

  it("accepts an array of acceptable versions (boundary)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ id: "1" }, { "x-talos-api-version": "v2" }),
    );
    const client = new TalosClient({ baseUrl: "http://localhost:3000", fetch: fetchMock });

    const result = await client.getTalos("1", { requireCapabilities: { apiVersion: ["v1", "v2"] } });
    expect(result).toEqual({ id: "1" });
  });

  it("omitting requireCapabilities preserves prior accept-any-2xx behavior (regression)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "1" }));
    const client = new TalosClient({ baseUrl: "http://localhost:3000", fetch: fetchMock });

    const result = await client.getTalos("1");
    expect(result).toEqual({ id: "1" });
  });

  it("does not retry a capability mismatch even with retries enabled (boundary)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ id: "1" }, { "x-talos-features": "a" }),
    );
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      fetch: fetchMock,
      retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    const err = await client
      .getTalos("1", { requireCapabilities: { features: ["z"] } })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TalosCapabilityError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not route a capability mismatch to the onError observer (boundary)", async () => {
    const onError = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ id: "1" }, { "x-talos-features": "a" }),
    );
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      fetch: fetchMock,
      onError,
    });

    await client
      .getTalos("1", { requireCapabilities: { features: ["z"] } })
      .catch(() => {});

    expect(onError).not.toHaveBeenCalled();
  });

  it("honors requireCapabilities on a keyed write (POST with idempotencyKey)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse(
        { id: "act" },
        { "x-talos-api-version": "v1", "x-talos-features": "events" },
      ),
    );
    const client = new TalosClient({ baseUrl: "http://localhost:3000", fetch: fetchMock });

    const result = await client.reportActivity(
      "t1",
      { type: "post", content: "x", channel: "twitter" },
      {
        idempotencyKey: "key-1",
        requireCapabilities: { apiVersion: "v1", features: ["events"] },
      },
    );
    expect(result).toEqual({ id: "act" });
  });

  it("honors requireCapabilities on a list (CursorRequestOptions) path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse(
        { data: [{ id: "1" }], nextCursor: null },
        { "x-talos-api-version": "v1" },
      ),
    );
    const client = new TalosClient({ baseUrl: "http://localhost:3000", fetch: fetchMock });

    const result = await client.listTaloses({
      limit: 5,
      requireCapabilities: { apiVersion: "v1" },
    });
    expect(result).toEqual({ data: [{ id: "1" }], nextCursor: null });
  });

  it("purchaseServiceWithPayment honors requireCapabilities on a direct 2xx path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ id: "job" }, { "x-talos-features": "a" }),
    );
    const client = new TalosClient({ baseUrl: "http://localhost:3000", fetch: fetchMock });

    const err = await client
      .purchaseServiceWithPayment("seller", "buyer", {}, { requireCapabilities: { features: ["z"] } })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TalosCapabilityError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("privacy: the error surface never leaks the API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ id: "1" }, { "x-talos-features": "a" }),
    );
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      apiKey: "super-secret-key",
      fetch: fetchMock,
    });

    const err = await client
      .getTalos("1", { requireCapabilities: { features: ["z"] } })
      .catch((e) => e) as TalosCapabilityError;

    expect(JSON.stringify(err.toJSON())).not.toContain("super-secret-key");
    expect(JSON.stringify(err.available)).not.toContain("super-secret-key");
  });
});
