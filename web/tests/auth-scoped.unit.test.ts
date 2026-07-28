import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { verifyAgentApiKey, hashApiKey } from "@/lib/auth";
import { db } from "@/db";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

describe("verifyAgentApiKey - Scoped Authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should deny request if Authorization header is missing", async () => {
    const req = new NextRequest("http://localhost/api/talos/t1/wallet");
    const res = await verifyAgentApiKey(req, "t1", ["wallet:read"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
    }
  });

  it("should accept valid scoped API key", async () => {
    const rawKey = "talos_sk_test_123456789";
    const hashed = hashApiKey(rawKey);

    // Mock db.select for tlsTalos query
    const selectTalosMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "t1", legacyApiKey: null }]),
    };

    // Mock db.select for tlsApiKeys query
    const selectKeysMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "k1", scopes: ["wallet:read"] }]),
    };

    // Mock db.update for updating lastUsedAt
    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue({}),
    };

    // Mock db.insert for audit log
    const insertMock = {
      values: vi.fn().mockResolvedValue({}),
    };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectTalosMock as any)
      .mockImplementationOnce(() => selectKeysMock as any);
    vi.mocked(db.update).mockImplementation(() => updateMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = new NextRequest("http://localhost/api/talos/t1/wallet", {
      headers: { authorization: `Bearer ${rawKey}` },
    });

    const res = await verifyAgentApiKey(req, "t1", ["wallet:read"]);
    expect(res.ok).toBe(true);
  });

  it("should deny access if scope is missing", async () => {
    const rawKey = "talos_sk_test_123456789";

    const selectTalosMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "t1", legacyApiKey: null }]),
    };

    const selectKeysMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "k1", scopes: ["activity:write"] }]),
    };

    const updateMock = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue({}),
    };

    const insertMock = {
      values: vi.fn().mockResolvedValue({}),
    };

    vi.mocked(db.select)
      .mockImplementationOnce(() => selectTalosMock as any)
      .mockImplementationOnce(() => selectKeysMock as any);
    vi.mocked(db.update).mockImplementation(() => updateMock as any);
    vi.mocked(db.insert).mockImplementation(() => insertMock as any);

    const req = new NextRequest("http://localhost/api/talos/t1/wallet", {
      headers: { authorization: `Bearer ${rawKey}` },
    });

    const res = await verifyAgentApiKey(req, "t1", ["wallet:sign"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      const data = await res.response.json();
      expect(data.error).toBe("Insufficient scopes");
    }
  });
});
