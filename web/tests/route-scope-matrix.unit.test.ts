import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { verifyAgentApiKey, hashApiKey, VALID_SCOPES, ApiScope } from "@/lib/auth";
import { db } from "@/db";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

function makeRequest(
  url: string,
  token?: string,
  method: string = "GET"
): NextRequest {
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest(url, { method, headers });
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

describe("Route-to-Scope Authorization Matrix & Key Compatibility", () => {
  const talosId = "t1_matrix_agent";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUDIT_HASH_CHAIN_ENABLED = "false";
  });

  const matrixCases: Array<{
    name: string;
    route: string;
    method: string;
    requiredScopes: ApiScope[];
    validScope: ApiScope;
    invalidScope: ApiScope;
  }> = [
    {
      name: "Wallet Read",
      route: `http://localhost/api/talos/${talosId}/wallet`,
      method: "GET",
      requiredScopes: ["wallet:read"],
      validScope: "wallet:read",
      invalidScope: "activity:write",
    },
    {
      name: "Wallet Sign / Transfer",
      route: `http://localhost/api/talos/${talosId}/transfer`,
      method: "POST",
      requiredScopes: ["wallet:sign"],
      validScope: "wallet:sign",
      invalidScope: "revenue:read",
    },
    {
      name: "Activity Write",
      route: `http://localhost/api/talos/${talosId}/activity`,
      method: "POST",
      requiredScopes: ["activity:write"],
      validScope: "activity:write",
      invalidScope: "commerce:read",
    },
    {
      name: "Commerce Read (Pending Jobs)",
      route: `http://localhost/api/jobs/pending`,
      method: "GET",
      requiredScopes: ["commerce:read"],
      validScope: "commerce:read",
      invalidScope: "wallet:read",
    },
    {
      name: "Commerce Write (Submit Result)",
      route: `http://localhost/api/jobs/job_1/result`,
      method: "POST",
      requiredScopes: ["commerce:write"],
      validScope: "commerce:write",
      invalidScope: "activity:write",
    },
    {
      name: "Settings Write (Status Update)",
      route: `http://localhost/api/talos/${talosId}/status`,
      method: "PATCH",
      requiredScopes: ["settings:write"],
      validScope: "settings:write",
      invalidScope: "wallet:read",
    },
    {
      name: "Revenue Read (Financial Summary)",
      route: `http://localhost/api/talos/${talosId}/financial-summary`,
      method: "GET",
      requiredScopes: ["revenue:read"],
      validScope: "revenue:read",
      invalidScope: "commerce:write",
    },
    {
      name: "Revenue Write (Distribute)",
      route: `http://localhost/api/talos/${talosId}/revenue/distribute`,
      method: "POST",
      requiredScopes: ["revenue:write"],
      validScope: "revenue:write",
      invalidScope: "settings:write",
    },
    {
      name: "Admin Scoped API Keys Management",
      route: `http://localhost/api/talos/${talosId}/api-keys`,
      method: "POST",
      requiredScopes: ["admin"],
      validScope: "admin",
      invalidScope: "revenue:read",
    },
  ];

  describe.each(matrixCases)("Matrix: $name", ({ route, method, requiredScopes, validScope, invalidScope }) => {
    it("allows access when key contains required scope", async () => {
      const rawKey = "tak_test_valid_key_12345678901234567890123456789012";

      const selectTalosMock = mockSelectChain([{ id: talosId, legacyApiKey: null }]);
      const selectKeysMock = mockSelectChain([
        { id: "k1", scopes: [validScope], expiresAt: null, status: "active" },
      ]);
      const updateMock = { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue({}) };
      const insertMock = { values: vi.fn().mockResolvedValue({}) };

      vi.mocked(db.select)
        .mockImplementationOnce(() => selectTalosMock as any)
        .mockImplementationOnce(() => selectKeysMock as any);
      vi.mocked(db.update).mockImplementation(() => updateMock as any);
      vi.mocked(db.insert).mockImplementation(() => insertMock as any);

      const req = makeRequest(route, rawKey, method);
      const res = await verifyAgentApiKey(req, talosId, requiredScopes);

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.talos.id).toBe(talosId);
      }
    });

    it("denies access when the key is not active", async () => {
      const rawKey = "tak_test_inactive_key_123456789012345678901234567890";

      const selectTalosMock = mockSelectChain([{ id: talosId, legacyApiKey: null }]);
      const selectKeysMock = mockSelectChain([
        { id: "k-inactive", scopes: [requiredScopes[0]], expiresAt: null, status: "disabled" },
      ]);

      vi.mocked(db.select)
        .mockImplementationOnce(() => selectTalosMock as any)
        .mockImplementationOnce(() => selectKeysMock as any);

      const req = makeRequest(route, rawKey, method);
      const res = await verifyAgentApiKey(req, talosId, requiredScopes);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.response.status).toBe(403);
    });

    it("denies access with 403 when key lacks required scope", async () => {
      const rawKey = "tak_test_invalid_scope_key_12345678901234567890";

      const selectTalosMock = mockSelectChain([{ id: talosId, legacyApiKey: null }]);
      const selectKeysMock = mockSelectChain([
        { id: "k1", scopes: [invalidScope], expiresAt: null, status: "active" },
      ]);
      const updateMock = { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), execute: vi.fn().mockResolvedValue({}) };
      const insertMock = { values: vi.fn().mockResolvedValue({}) };

      vi.mocked(db.select)
        .mockImplementationOnce(() => selectTalosMock as any)
        .mockImplementationOnce(() => selectKeysMock as any);
      vi.mocked(db.update).mockImplementation(() => updateMock as any);
      vi.mocked(db.insert).mockImplementation(() => insertMock as any);

      const req = makeRequest(route, rawKey, method);
      const res = await verifyAgentApiKey(req, talosId, requiredScopes);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(403);
        const data = await res.response.json();
        expect(data.error).toBe("Insufficient scopes");
      }

      // Flush microtasks for fire-and-forget writeAuditLog
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(db.insert).toHaveBeenCalled();
      expect(insertMock.values).toHaveBeenCalledWith(
        expect.objectContaining({
          talosId,
          method,
          statusCode: 403,
          denialReason: "insufficient_scopes",
          scopesRequired: requiredScopes,
        })
      );
    });

    it("allows access using legacy key (tlk_*) as admin equivalent", async () => {
      const legacyKey = "tlk_legacy_admin_key_1234567890";

      const selectTalosMock = mockSelectChain([{ id: talosId, legacyApiKey: legacyKey }]);
      const selectKeysMock = mockSelectChain([]);
      const insertMock = { values: vi.fn().mockResolvedValue({}) };

      vi.mocked(db.select)
        .mockImplementationOnce(() => selectTalosMock as any)
        .mockImplementationOnce(() => selectKeysMock as any);
      vi.mocked(db.insert).mockImplementation(() => insertMock as any);

      const req = makeRequest(route, legacyKey, method);
      const res = await verifyAgentApiKey(req, talosId, requiredScopes);

      expect(res.ok).toBe(true);
    });
  });

  describe("Revoked & Expired Keys Security Checks", () => {
    it("denies access if scoped key status is revoked", async () => {
      const rawKey = "tak_revoked_key_12345678901234567890";

      const selectTalosMock = mockSelectChain([{ id: talosId, legacyApiKey: null }]);
      const selectKeysMock = mockSelectChain([
        { id: "k1", scopes: ["admin"], expiresAt: null, status: "revoked" },
      ]);
      const insertMock = { values: vi.fn().mockResolvedValue({}) };

      vi.mocked(db.select)
        .mockImplementationOnce(() => selectTalosMock as any)
        .mockImplementationOnce(() => selectKeysMock as any);
      vi.mocked(db.insert).mockImplementation(() => insertMock as any);

      const req = makeRequest(`http://localhost/api/talos/${talosId}/wallet`, rawKey, "GET");
      const res = await verifyAgentApiKey(req, talosId, ["wallet:read"]);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(403);
        const data = await res.response.json();
        expect(data.error).toBe("API key has been revoked");
      }
    });

    it("denies access if scoped key expiresAt is in the past", async () => {
      const rawKey = "tak_expired_key_12345678901234567890";
      const pastDate = new Date(Date.now() - 3600000); // 1 hour ago

      const selectTalosMock = mockSelectChain([{ id: talosId, legacyApiKey: null }]);
      const selectKeysMock = mockSelectChain([
        { id: "k1", scopes: ["wallet:read"], expiresAt: pastDate, status: "active" },
      ]);
      const insertMock = { values: vi.fn().mockResolvedValue({}) };

      vi.mocked(db.select)
        .mockImplementationOnce(() => selectTalosMock as any)
        .mockImplementationOnce(() => selectKeysMock as any);
      vi.mocked(db.insert).mockImplementation(() => insertMock as any);

      const req = makeRequest(`http://localhost/api/talos/${talosId}/wallet`, rawKey, "GET");
      const res = await verifyAgentApiKey(req, talosId, ["wallet:read"]);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(403);
        const data = await res.response.json();
        expect(data.error).toBe("API key has expired");
      }
    });
  });
});
