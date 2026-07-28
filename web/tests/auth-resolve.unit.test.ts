import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  verifyAgentApiKey,
  resolveTalosFromRequest,
  generateApiKey,
  hashApiKey,
  VALID_SCOPES,
} from "@/lib/auth";
import { db } from "@/db";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

function makeRequest(
  token?: string,
  opts?: { method?: string; path?: string }
): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(`http://localhost${opts?.path ?? "/api/test"}`, {
    method: opts?.method ?? "GET",
    headers,
  });
}

function mockSelectChain(results: unknown[]) {
  const chain: Record<string, unknown> = {};
  const stepMethods = ["from", "where", "limit", "orderBy", "offset"];
  for (const method of stepMethods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: Function) => resolve(results);
  chain.execute = vi.fn().mockResolvedValue(results);
  return chain;
}

describe("generateApiKey", () => {
  it("generates a tak_ prefixed key with hash", () => {
    const { raw, hash } = generateApiKey();
    expect(raw).toMatch(/^tak_[a-f0-9]{64}$/);
    expect(hash).toBe(hashApiKey(raw));
  });

  it("generates unique keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
  });
});

describe("hashApiKey", () => {
  it("returns a hex SHA-256 hash", () => {
    const hash = hashApiKey("test-key");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("verifyAgentApiKey - Scoped Authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should deny request if Authorization header is missing", async () => {
    const req = makeRequest();
    const res = await verifyAgentApiKey(req, "t1", ["wallet:read"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
    }
  });

  it("should deny if TALOS not found", async () => {
    vi.mocked(db.select).mockImplementation(() => mockSelectChain([]) as any);
    const req = makeRequest("some-key");
    const res = await verifyAgentApiKey(req, "nonexistent", []);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(404);
    }
  });

  it("should accept valid scoped API key", async () => {
    const rawKey = "talos_sk_test_123456789";
    const hashed = hashApiKey(rawKey);

    const selectTalosMock = mockSelectChain([{ id: "t1", legacyApiKey: null }]);
    const selectKeysMock = mockSelectChain([{ id: "k1", scopes: ["wallet:read"], expiresAt: null }]);
    const updateMock = { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue({}) };
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectTalosMock as any)
      .mockImplementationOnce(() => selectKeysMock as any);
    vi.mocked(db.update).mockImplementation(() => updateMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest(rawKey);
    const res = await verifyAgentApiKey(req, "t1", ["wallet:read"]);
    expect(res.ok).toBe(true);
  });

  it("should deny access if scope is missing", async () => {
    const rawKey = "talos_sk_test_123456789";

    const selectTalosMock = mockSelectChain([{ id: "t1", legacyApiKey: null }]);
    const selectKeysMock = mockSelectChain([{ id: "k1", scopes: ["activity:write"], expiresAt: null }]);
    const updateMock = { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue({}) };
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectTalosMock as any)
      .mockImplementationOnce(() => selectKeysMock as any);
    vi.mocked(db.update).mockImplementation(() => updateMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest(rawKey);
    const res = await verifyAgentApiKey(req, "t1", ["wallet:sign"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      const data = await res.response.json();
      expect(data.error).toBe("Insufficient scopes");
    }
  });

  it("should accept admin scope for any required scope", async () => {
    const rawKey = "talos_sk_test_admin";

    const selectTalosMock = mockSelectChain([{ id: "t1", legacyApiKey: null }]);
    const selectKeysMock = mockSelectChain([{ id: "k1", scopes: ["admin"], expiresAt: null }]);
    const updateMock = { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue({}) };
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectTalosMock as any)
      .mockImplementationOnce(() => selectKeysMock as any);
    vi.mocked(db.update).mockImplementation(() => updateMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest(rawKey);
    const res = await verifyAgentApiKey(req, "t1", ["wallet:sign", "revenue:write"]);
    expect(res.ok).toBe(true);
  });

  it("should reject expired scoped key", async () => {
    const rawKey = "talos_sk_test_expired";

    const selectTalosMock = mockSelectChain([{ id: "t1", legacyApiKey: null }]);
    const selectKeysMock = mockSelectChain([{
      id: "k1",
      scopes: ["wallet:read"],
      expiresAt: new Date("2020-01-01"),
    }]);
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectTalosMock as any)
      .mockImplementationOnce(() => selectKeysMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest(rawKey);
    const res = await verifyAgentApiKey(req, "t1", ["wallet:read"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      const data = await res.response.json();
      expect(data.error).toBe("API key has expired");
    }
  });

  it("should accept legacy key as admin equivalent", async () => {
    const legacyKey = "tlk_abcdef1234567890abcdef12";

    const selectTalosMock = mockSelectChain([{ id: "t1", legacyApiKey: legacyKey }]);
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectTalosMock as any)
      .mockImplementation(() => mockSelectChain([]) as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest(legacyKey);
    const res = await verifyAgentApiKey(req, "t1", ["wallet:sign", "revenue:write"]);
    expect(res.ok).toBe(true);
  });
});

describe("resolveTalosFromRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should deny if no Authorization header", async () => {
    const req = makeRequest();
    const res = await resolveTalosFromRequest(req);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
    }
  });

  it("should resolve TALOS from scoped key", async () => {
    const rawKey = "test-scoped-key-123";
    const hashed = hashApiKey(rawKey);

    const selectScopedKeyMock = mockSelectChain([{
      id: "k1",
      talosId: "t1",
      scopes: ["admin"],
      expiresAt: null,
    }]);
    const selectTalosMock = mockSelectChain([{
      id: "t1",
      name: "TestBot",
      apiKey: "tlk_old_key",
      persona: null,
    }]);
    const updateMock = { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue({}) };
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectScopedKeyMock as any)
      .mockImplementationOnce(() => selectTalosMock as any);
    vi.mocked(db.update).mockImplementation(() => updateMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest(rawKey);
    const res = await resolveTalosFromRequest(req);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.talos.id).toBe("t1");
      expect(res.talos.name).toBe("TestBot");
      // apiKey should be stripped
      expect((res.talos as any).apiKey).toBeUndefined();
    }
  });

  it("should deny if scoped key has expired", async () => {
    const rawKey = "test-expired-key";

    const selectScopedKeyMock = mockSelectChain([{
      id: "k1",
      talosId: "t1",
      scopes: ["admin"],
      expiresAt: new Date("2020-01-01"),
    }]);
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectScopedKeyMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest(rawKey);
    const res = await resolveTalosFromRequest(req);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
    }
  });

  it("should deny if scoped key lacks required scopes", async () => {
    const rawKey = "test-limited-key";

    const selectScopedKeyMock = mockSelectChain([{
      id: "k1",
      talosId: "t1",
      scopes: ["activity:write"],
      expiresAt: null,
    }]);
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectScopedKeyMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest(rawKey);
    const res = await resolveTalosFromRequest(req, ["wallet:read"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
    }
  });

  it("should fallback to legacy key if no scoped key matches", async () => {
    const legacyKey = "tlk_legacy_test_1234567890";

    // First call: scoped key lookup returns nothing
    const selectScopedKeyMock = mockSelectChain([]);
    // Second call: all talos with apiKey
    const selectAllTalosMock = mockSelectChain([{
      id: "t1",
      name: "LegacyBot",
      apiKey: legacyKey,
      persona: null,
    }]);
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectScopedKeyMock as any)
      .mockImplementationOnce(() => selectAllTalosMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest(legacyKey);
    const res = await resolveTalosFromRequest(req);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.talos.id).toBe("t1");
      expect(res.talos.name).toBe("LegacyBot");
      expect((res.talos as any).apiKey).toBeUndefined();
    }
  });

  it("should deny invalid key that matches nothing", async () => {
    const selectScopedKeyMock = mockSelectChain([]);
    const selectAllTalosMock = mockSelectChain([{ id: "t1", apiKey: "other-key" }]);
    const insertMock = { values: vi.fn().mockResolvedValue({}) };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectScopedKeyMock as any)
      .mockImplementationOnce(() => selectAllTalosMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = makeRequest("totally-wrong-key");
    const res = await resolveTalosFromRequest(req);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
    }
  });
});

describe("VALID_SCOPES", () => {
  it("contains all expected scopes", () => {
    expect(VALID_SCOPES).toContain("admin");
    expect(VALID_SCOPES).toContain("activity:write");
    expect(VALID_SCOPES).toContain("commerce:read");
    expect(VALID_SCOPES).toContain("commerce:write");
    expect(VALID_SCOPES).toContain("wallet:read");
    expect(VALID_SCOPES).toContain("wallet:sign");
    expect(VALID_SCOPES).toContain("settings:read");
    expect(VALID_SCOPES).toContain("settings:write");
    expect(VALID_SCOPES).toContain("revenue:read");
    expect(VALID_SCOPES).toContain("revenue:write");
    expect(VALID_SCOPES).toHaveLength(10);
  });
});
