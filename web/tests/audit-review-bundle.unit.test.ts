import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  verifyAgentApiKey: vi.fn(),
  getAgentAuditReviewBundle: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ verifyAgentApiKey: mocks.verifyAgentApiKey }));
vi.mock("@/lib/audit-log", () => ({
  getAgentAuditReviewBundle: mocks.getAgentAuditReviewBundle,
}));

import { GET } from "@/app/api/talos/[id]/audit/review-bundle/route";

function request(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

const context = { params: Promise.resolve({ id: "agent-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyAgentApiKey.mockResolvedValue({ ok: true, talos: { id: "agent-1" } });
  mocks.getAgentAuditReviewBundle.mockResolvedValue({
    auditReferences: [],
    nextCursor: null,
    checkpoint: { chainRoot: null, totalEntries: 0, chainVersion: null, createdAt: "2026-01-01T00:00:00.000Z" },
  });
});

describe("GET /api/talos/:id/audit/review-bundle", () => {
  it("returns an agent-scoped bundle with the default bounded limit", async () => {
    const response = await GET(request("/api/talos/agent-1/audit/review-bundle"), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      talosId: "agent-1",
      auditReferences: [],
      checkpoint: { chainRoot: null, totalEntries: 0 },
    });
    expect(mocks.verifyAgentApiKey).toHaveBeenCalledWith(expect.any(NextRequest), "agent-1");
    expect(mocks.getAgentAuditReviewBundle).toHaveBeenCalledWith("agent-1", 50, undefined);
  });

  it("accepts the maximum limit and rejects an out-of-range limit", async () => {
    expect((await GET(request("/api/talos/agent-1/audit/review-bundle?limit=200"), context)).status).toBe(200);

    const response = await GET(request("/api/talos/agent-1/audit/review-bundle?limit=201"), context);
    expect(response.status).toBe(400);
    expect(mocks.getAgentAuditReviewBundle).toHaveBeenCalledTimes(1);
  });

  it("passes a valid cursor and rejects a malformed cursor", async () => {
    const cursor = "2026-01-01T00:00:00.000Z";
    expect(
      (await GET(request(`/api/talos/agent-1/audit/review-bundle?cursor=${encodeURIComponent(cursor)}`), context)).status,
    ).toBe(200);
    expect(mocks.getAgentAuditReviewBundle).toHaveBeenCalledWith("agent-1", 50, cursor);

    const response = await GET(request("/api/talos/agent-1/audit/review-bundle?cursor=invalid"), context);
    expect(response.status).toBe(400);
    expect(mocks.getAgentAuditReviewBundle).toHaveBeenCalledTimes(1);
  });

  it("does not query the bundle when authentication fails", async () => {
    mocks.verifyAgentApiKey.mockResolvedValue({ ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) });

    const response = await GET(request("/api/talos/agent-1/audit/review-bundle"), context);

    expect(response.status).toBe(401);
    expect(mocks.getAgentAuditReviewBundle).not.toHaveBeenCalled();
  });

  it("returns a sanitized error when audit storage fails", async () => {
    mocks.getAgentAuditReviewBundle.mockRejectedValue(new Error("database credentials leaked"));

    const response = await GET(request("/api/talos/agent-1/audit/review-bundle"), context);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });
});
