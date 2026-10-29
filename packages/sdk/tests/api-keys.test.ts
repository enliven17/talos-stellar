/**
 * Tests for scoped API key management methods.
 *
 * All tests use vi.stubGlobal("fetch", …) — zero real network calls.
 *
 * Relates to: https://github.com/enliven17/talos-stellar/issues/987
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TalosClient, TalosAPIError } from "../src/client.js";
import type {
  ApiKey,
  ApiKeyCreated,
  TalosScope,
} from "../src/types.js";

const BASE = "http://localhost:3000";
const TALOS_ID = "talos_abc123";
const KEY_ID = "key_xyz789";

function makeClient(): TalosClient {
  return new TalosClient({ baseUrl: BASE, apiKey: "tlk_test" });
}

function ok<T>(body: T): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

// ── TalosScope union – type-level tests ────────────────────────────────────

describe("TalosScope – compile-time type safety", () => {
  it("accepts all valid scope strings without error", () => {
    // This test exists purely to drive type-checking.
    // If TalosScope were 'string' these assignments would still compile, but
    // typos like "activty:write" would also compile — the union prevents that.
    const scopes: TalosScope[] = [
      "activity:read",
      "activity:write",
      "revenue:read",
      "revenue:write",
      "approvals:read",
      "approvals:write",
      "service:read",
      "service:write",
      "wallet:read",
      "wallet:write",
      "playbooks:read",
      "playbooks:write",
      "keys:read",
      "keys:write",
    ];
    expect(scopes).toHaveLength(14);
  });

  it("narrowing: TalosScope is assignable to string but not the reverse", () => {
    const scope: TalosScope = "activity:write";
    // upcast to string is fine
    const asString: string = scope;
    expect(asString).toBe("activity:write");
  });
});

// ── listApiKeys ────────────────────────────────────────────────────────────

describe("listApiKeys", () => {
  it("sends GET /api/talos/:id/api-keys and returns ApiKey[]", async () => {
    const mockKeys: ApiKey[] = [
      {
        id: KEY_ID,
        talosId: TALOS_ID,
        name: "CI deploy key",
        scopes: ["activity:write", "revenue:read"],
        keyMasked: "…abc1",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockKeys));

    const client = makeClient();
    const result: ApiKey[] = await client.listApiKeys(TALOS_ID);

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos/${TALOS_ID}/api-keys`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tlk_test" }),
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(KEY_ID);
    // Type check: scopes is TalosScope[]
    const _scopes: TalosScope[] = result[0].scopes;
    expect(_scopes).toContain("activity:write");
  });

  it("returns an empty array when no keys exist", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok([]));

    const client = makeClient();
    const result = await client.listApiKeys(TALOS_ID);

    expect(result).toEqual([]);
  });

  it("throws TalosAPIError on 401", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as Response);

    const client = makeClient();
    await expect(client.listApiKeys(TALOS_ID)).rejects.toThrow(TalosAPIError);
  });
});

// ── createApiKey ───────────────────────────────────────────────────────────

describe("createApiKey", () => {
  it("sends POST /api/talos/:id/api-keys with name and scopes", async () => {
    const mockCreated: ApiKeyCreated = {
      id: KEY_ID,
      talosId: TALOS_ID,
      name: "CI deploy key",
      scopes: ["activity:write", "revenue:read"],
      keyMasked: "…abc1",
      createdAt: "2026-01-01T00:00:00Z",
      keyOnce: "tlk_full_key_value_shown_only_once",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockCreated));

    const client = makeClient();
    const result: ApiKeyCreated = await client.createApiKey(TALOS_ID, {
      name: "CI deploy key",
      scopes: ["activity:write", "revenue:read"],
    });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos/${TALOS_ID}/api-keys`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "CI deploy key", scopes: ["activity:write", "revenue:read"] }),
      }),
    );
    expect(result.id).toBe(KEY_ID);
    // keyOnce must be a string (present only on ApiKeyCreated, not ApiKey)
    const _keyOnce: string = result.keyOnce;
    expect(typeof _keyOnce).toBe("string");
    // keyOnce should not be logged — we only verify it exists in the type
  });

  it("throws TalosAPIError on 403 (insufficient permissions)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    } as Response);

    const client = makeClient();
    await expect(
      client.createApiKey(TALOS_ID, { name: "bad key", scopes: ["keys:write"] }),
    ).rejects.toThrow(TalosAPIError);
  });

  it("accepts a key with all valid scopes", async () => {
    const allScopes: TalosScope[] = [
      "activity:read", "activity:write",
      "revenue:read", "revenue:write",
      "approvals:read", "approvals:write",
      "service:read", "service:write",
      "wallet:read", "wallet:write",
      "playbooks:read", "playbooks:write",
      "keys:read", "keys:write",
    ];

    const mockCreated: ApiKeyCreated = {
      id: "key_full",
      talosId: TALOS_ID,
      name: "full-access key",
      scopes: allScopes,
      keyMasked: "…ffff",
      createdAt: "2026-01-01T00:00:00Z",
      keyOnce: "tlk_full_key",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockCreated));

    const client = makeClient();
    const result = await client.createApiKey(TALOS_ID, {
      name: "full-access key",
      scopes: allScopes,
    });

    expect(result.scopes).toHaveLength(14);
  });
});

// ── revokeApiKey ───────────────────────────────────────────────────────────

describe("revokeApiKey", () => {
  it("sends DELETE /api/talos/:id/api-keys/:keyId", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => undefined,
    } as unknown as Response);

    const client = makeClient();
    await client.revokeApiKey(TALOS_ID, KEY_ID);

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos/${TALOS_ID}/api-keys/${KEY_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("throws TalosAPIError on 404 (key not found)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    } as Response);

    const client = makeClient();
    await expect(client.revokeApiKey(TALOS_ID, "nonexistent-key")).rejects.toThrow(TalosAPIError);
  });
});

// ── regenerateKey ──────────────────────────────────────────────────────────

describe("regenerateKey", () => {
  it("sends POST /api/talos/:id/regenerate-key with signature params", async () => {
    const mockResponse = { apiKey: "tlk_new_key_value" };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockResponse));

    const client = makeClient();
    const result = await client.regenerateKey(TALOS_ID, {
      stellarPublicKey: "GABC123",
      signature: "base64sig==",
      message: `Regenerate API key for ${TALOS_ID}`,
    });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos/${TALOS_ID}/regenerate-key`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          stellarPublicKey: "GABC123",
          signature: "base64sig==",
          message: `Regenerate API key for ${TALOS_ID}`,
        }),
      }),
    );
    // Type check: result has apiKey string
    const _apiKey: string = result.apiKey;
    expect(typeof _apiKey).toBe("string");
  });

  it("throws TalosAPIError on 403 (invalid signature)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Invalid signature",
    } as Response);

    const client = makeClient();
    await expect(
      client.regenerateKey(TALOS_ID, {
        stellarPublicKey: "GABC",
        signature: "badsig",
        message: `Regenerate API key for ${TALOS_ID}`,
      }),
    ).rejects.toThrow(TalosAPIError);
  });

  it("does not log the returned apiKey value", async () => {
    // This test asserts intent: the SDK method returns the key but never
    // calls console.log internally. We verify by spying on console.log.
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.mocked(fetch).mockResolvedValueOnce(ok({ apiKey: "tlk_secret" }));

    const client = makeClient();
    await client.regenerateKey(TALOS_ID, {
      stellarPublicKey: "GABC",
      signature: "sig",
      message: `Regenerate API key for ${TALOS_ID}`,
    });

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ── Route correctness ──────────────────────────────────────────────────────

describe("route targets", () => {
  it("listApiKeys → GET /api/talos/:id/api-keys", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok([]));
    await makeClient().listApiKeys("talos_1");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`${BASE}/api/talos/talos_1/api-keys`);
  });

  it("createApiKey → POST /api/talos/:id/api-keys", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      ok({ id: "k", talosId: "talos_1", name: "n", scopes: [], keyMasked: "…x", createdAt: "", keyOnce: "v" }),
    );
    await makeClient().createApiKey("talos_1", { name: "n", scopes: [] });
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(`${BASE}/api/talos/talos_1/api-keys`);
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("revokeApiKey → DELETE /api/talos/:id/api-keys/:keyId", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => undefined } as unknown as Response);
    await makeClient().revokeApiKey("talos_1", "key_2");
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(`${BASE}/api/talos/talos_1/api-keys/key_2`);
    expect((call[1] as RequestInit).method).toBe("DELETE");
  });

  it("regenerateKey → POST /api/talos/:id/regenerate-key", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({ apiKey: "new" }));
    await makeClient().regenerateKey("talos_1", { stellarPublicKey: "G", signature: "s", message: "m talos_1" });
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(`${BASE}/api/talos/talos_1/regenerate-key`);
    expect((call[1] as RequestInit).method).toBe("POST");
  });
});
