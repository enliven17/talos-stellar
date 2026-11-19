import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as listKeysHandler, POST as createKeyHandler } from "@/app/api/talos/[id]/api-keys/route";
import { PATCH as updateKeyHandler, DELETE as revokeKeyHandler } from "@/app/api/talos/[id]/api-keys/[keyId]/route";
import { verifyAgentApiKey, hashApiKey } from "@/lib/auth";
import { db } from "@/db";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    verifyAgentApiKey: vi.fn(),
  };
});

function makeRequest(
  url: string,
  method: string = "GET",
  body?: unknown,
  token?: string
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new NextRequest(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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

describe("Scoped API Keys Route Handlers", () => {
  const talosId = "t1_test_agent";
  const keyId = "key_12345";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/talos/:id/api-keys (Create Key)", () => {
    it("creates a new scoped key and returns raw key with 201 status", async () => {
      vi.mocked(verifyAgentApiKey).mockResolvedValue({
        ok: true,
        talos: { id: talosId, name: "Test Agent" } as any,
      });

      const mockInsertedKey = {
        id: keyId,
        name: "Test Runner Key",
        scopes: ["activity:write", "commerce:read"],
        expiresAt: null,
        status: "active",
        createdAt: new Date(),
      };

      const insertChain = {
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([mockInsertedKey]),
      };
      vi.mocked(db.insert).mockReturnValue(insertChain as any);

      const req = makeRequest(`http://localhost/api/talos/${talosId}/api-keys`, "POST", {
        name: "Test Runner Key",
        scopes: ["activity:write", "commerce:read"],
      });

      const params = Promise.resolve({ id: talosId });
      const res = await createKeyHandler(req, { params });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe(keyId);
      expect(data.name).toBe("Test Runner Key");
      expect(data.scopes).toEqual(["activity:write", "commerce:read"]);
      expect(data.apiKey).toMatch(/^tak_[a-f0-9]{64}$/);

      expect(verifyAgentApiKey).toHaveBeenCalledWith(req, talosId, ["admin"]);
      expect(db.insert).toHaveBeenCalled();
    });

    it("returns 401/403 if caller lacks admin authorization", async () => {
      vi.mocked(verifyAgentApiKey).mockResolvedValue({
        ok: false,
        response: Response.json({ error: "Insufficient scopes" }, { status: 403 }),
      });

      const req = makeRequest(`http://localhost/api/talos/${talosId}/api-keys`, "POST", {
        name: "Test Key",
        scopes: ["wallet:read"],
      });

      const params = Promise.resolve({ id: talosId });
      const res = await createKeyHandler(req, { params });

      expect(res.status).toBe(403);
    });

    it("returns 400 when body fails schema validation", async () => {
      vi.mocked(verifyAgentApiKey).mockResolvedValue({
        ok: true,
        talos: { id: talosId } as any,
      });

      const req = makeRequest(`http://localhost/api/talos/${talosId}/api-keys`, "POST", {
        // Missing name and invalid scopes
        scopes: ["invalid_scope_xyz"],
      });

      const params = Promise.resolve({ id: talosId });
      const res = await createKeyHandler(req, { params });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/talos/:id/api-keys (List Keys)", () => {
    it("lists key metadata without returning raw keys or hashes", async () => {
      vi.mocked(verifyAgentApiKey).mockResolvedValue({
        ok: true,
        talos: { id: talosId } as any,
      });

      const mockKeys = [
        {
          id: "k1",
          name: "Key 1",
          scopes: ["wallet:read"],
          expiresAt: null,
          lastUsedAt: null,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "k2",
          name: "Key 2",
          scopes: ["activity:write"],
          expiresAt: null,
          lastUsedAt: null,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.mocked(db.select).mockReturnValue(mockSelectChain(mockKeys) as any);

      const req = makeRequest(`http://localhost/api/talos/${talosId}/api-keys`, "GET");
      const params = Promise.resolve({ id: talosId });
      const res = await listKeysHandler(req, { params });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.keys).toHaveLength(2);
      expect(data.keys[0].id).toBe("k1");
      expect(data.keys[0].keyHash).toBeUndefined();
      expect(data.keys[0].apiKey).toBeUndefined();
    });
  });

  describe("PATCH /api/talos/:id/api-keys/:keyId (Update Key)", () => {
    it("updates key scopes and name", async () => {
      vi.mocked(verifyAgentApiKey).mockResolvedValue({
        ok: true,
        talos: { id: talosId } as any,
      });

      // Select existing key
      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([{ id: keyId, talosId, name: "Old Name", scopes: ["wallet:read"] }]) as any
      );

      const updatedKey = {
        id: keyId,
        name: "New Name",
        scopes: ["wallet:read", "wallet:sign"],
        expiresAt: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([updatedKey]),
      };
      vi.mocked(db.update).mockReturnValue(updateChain as any);

      const req = makeRequest(`http://localhost/api/talos/${talosId}/api-keys/${keyId}`, "PATCH", {
        name: "New Name",
        scopes: ["wallet:read", "wallet:sign"],
      });

      const params = Promise.resolve({ id: talosId, keyId });
      const res = await updateKeyHandler(req, { params });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("New Name");
      expect(data.scopes).toEqual(["wallet:read", "wallet:sign"]);
    });

    it("returns 404 if API key is not found", async () => {
      vi.mocked(verifyAgentApiKey).mockResolvedValue({
        ok: true,
        talos: { id: talosId } as any,
      });

      vi.mocked(db.select).mockReturnValue(mockSelectChain([]) as any);

      const req = makeRequest(`http://localhost/api/talos/${talosId}/api-keys/nonexistent`, "PATCH", {
        name: "New Name",
      });

      const params = Promise.resolve({ id: talosId, keyId: "nonexistent" });
      const res = await updateKeyHandler(req, { params });

      expect(res.status).toBe(404);
    });

    it("returns 400 if no update fields are provided", async () => {
      vi.mocked(verifyAgentApiKey).mockResolvedValue({
        ok: true,
        talos: { id: talosId } as any,
      });

      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([{ id: keyId, talosId, name: "Key", scopes: ["wallet:read"] }]) as any
      );

      const req = makeRequest(`http://localhost/api/talos/${talosId}/api-keys/${keyId}`, "PATCH", {});

      const params = Promise.resolve({ id: talosId, keyId });
      const res = await updateKeyHandler(req, { params });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/talos/:id/api-keys/:keyId (Revoke Key)", () => {
    it("soft deletes key by setting status to revoked", async () => {
      vi.mocked(verifyAgentApiKey).mockResolvedValue({
        ok: true,
        talos: { id: talosId } as any,
      });

      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([{ id: keyId, talosId, status: "active" }]) as any
      );

      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue({}),
      };
      vi.mocked(db.update).mockReturnValue(updateChain as any);

      const req = makeRequest(`http://localhost/api/talos/${talosId}/api-keys/${keyId}`, "DELETE");
      const params = Promise.resolve({ id: talosId, keyId });
      const res = await revokeKeyHandler(req, { params });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.message).toBe("API key revoked");
      expect(updateChain.set).toHaveBeenCalledWith({ status: "revoked" });
    });

    it("returns 404 if API key to revoke does not exist", async () => {
      vi.mocked(verifyAgentApiKey).mockResolvedValue({
        ok: true,
        talos: { id: talosId } as any,
      });

      vi.mocked(db.select).mockReturnValue(mockSelectChain([]) as any);

      const req = makeRequest(`http://localhost/api/talos/${talosId}/api-keys/nonexistent`, "DELETE");
      const params = Promise.resolve({ id: talosId, keyId: "nonexistent" });
      const res = await revokeKeyHandler(req, { params });

      expect(res.status).toBe(404);
    });
  });
});
