import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const resolveTalosFromRequest = vi.fn();
  return { resolveTalosFromRequest };
});

vi.mock("@/lib/auth", () => ({
  resolveTalosFromRequest: mocks.resolveTalosFromRequest,
}));

import { GET } from "@/app/api/talos/me/route";

describe("GET /api/talos/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when Authorization header is missing (from resolveTalosFromRequest)", async () => {
    mocks.resolveTalosFromRequest.mockResolvedValueOnce({
      ok: false,
      response: Response.json(
        { error: "Missing Authorization header. Use: Bearer <api_key>" },
        { status: 401 }
      ),
    });

    const req = new NextRequest("http://localhost/api/talos/me");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Missing Authorization header. Use: Bearer <api_key>");
    expect(mocks.resolveTalosFromRequest).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTalosFromRequest).toHaveBeenCalledWith(req);
  });

  it("returns 200 with talos payload for a valid key", async () => {
    const mockTalos = {
      id: "talos-123",
      name: "Test Agent",
      status: "Active",
    };

    mocks.resolveTalosFromRequest.mockResolvedValueOnce({
      ok: true,
      talos: mockTalos,
    });

    const req = new NextRequest("http://localhost/api/talos/me", {
      headers: {
        authorization: "Bearer tak_valid_api_key_12345",
      },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(mockTalos);
    expect(mocks.resolveTalosFromRequest).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTalosFromRequest).toHaveBeenCalledWith(req);
  });
});
