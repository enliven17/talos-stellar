import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/db", () => ({
  db: mockDb,
}));

import { GET } from "@/app/api/proposals/route";

describe("GET /api/proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.limit.mockResolvedValue([]);
  });

  function createRequest(url: string) {
    return new NextRequest(url);
  }

  it("returns 400 for an invalid status", async () => {
    const req = createRequest("http://localhost/api/proposals?status=bogus");
    const res = await GET(req, { params: {} });
    
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid status "bogus"');
    expect(json.error).toContain("Allowed: pending, approved, rejected");
  });

  it("accepts lowercase status and filters via eq()", async () => {
    const req = createRequest("http://localhost/api/proposals?status=approved");
    const res = await GET(req, { params: {} });
    
    expect(res.status).toBe(200);
    expect(mockDb.where).toHaveBeenCalled();
    expect(mockDb.where.mock.calls[0][0]).toBeDefined();
  });

  it("accepts uppercase status and normalizes it", async () => {
    const req = createRequest("http://localhost/api/proposals?status=APPROVED");
    const res = await GET(req, { params: {} });
    
    expect(res.status).toBe(200);
    expect(mockDb.where).toHaveBeenCalled();
    expect(mockDb.where.mock.calls[0][0]).toBeDefined();
  });

  it("returns all proposals if status is absent (where undefined)", async () => {
    const req = createRequest("http://localhost/api/proposals");
    const res = await GET(req, { params: {} });
    
    expect(res.status).toBe(200);
    expect(mockDb.where).toHaveBeenCalledWith(undefined);
  });
});
