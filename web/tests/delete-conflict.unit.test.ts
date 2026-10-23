import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/talos/[id]/delete/route";

const mocks = vi.hoisted(() => {
  return {
    findFirstMock: vi.fn(),
    updateMock: vi.fn(),
  };
});

vi.mock("@/db", () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
      const tx = {
        query: {
          tlsTalos: {
            findFirst: (...args: any[]) => mocks.findFirstMock(...args),
          },
        },
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "talos-123" }]),
            })),
          })),
        })),
      };
      return cb(tx);
    }),
  },
}));

describe("POST /api/talos/[id]/delete unit tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 conflict when TALOS has already been deleted (deletedAt is set)", async () => {
    mocks.findFirstMock.mockResolvedValueOnce({
      id: "talos-123",
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      walletPublicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      creatorPublicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    });

    const req = new NextRequest("http://localhost:3000/api/talos/talos-123/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "Repeated delete attempt",
        stellarPublicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        signature: "dummy-sig",
        message: "Delete TALOS talos-123",
      }),
    });

    const response = await POST(req, {
      params: Promise.resolve({ id: "talos-123" }),
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ error: "TALOS already deleted" });
  });

  it("returns 404 when TALOS is not found", async () => {
    mocks.findFirstMock.mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost:3000/api/talos/non-existent/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "Delete attempt",
        stellarPublicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        signature: "dummy-sig",
        message: "Delete TALOS non-existent",
      }),
    });

    const response = await POST(req, {
      params: Promise.resolve({ id: "non-existent" }),
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "TALOS not found" });
  });
});
