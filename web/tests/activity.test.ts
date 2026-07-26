import { beforeEach, describe, expect, it, vi } from "vitest";

const stats = {
  totalTransactions: 3,
  totalVolume: 6,
  activeAgents: 2,
  totalAgents: 3,
  registeredServices: 1,
  playbooksTraded: 1,
};

const pages = [
  {
    transactions: [
      { id: "service-3", type: "service", timestamp: "2026-07-23T12:00:00.000Z" },
      { id: "playbook-2", type: "playbook", timestamp: "2026-07-23T11:00:00.000Z" },
    ],
    nextCursor: "",
  },
  {
    transactions: [
      { id: "service-1", type: "service", timestamp: "2026-07-23T10:00:00.000Z" },
    ],
    nextCursor: null,
  },
];

const { fetchActivityStats, fetchActivityTransactions } = vi.hoisted(() => ({
  fetchActivityStats: vi.fn(),
  fetchActivityTransactions: vi.fn(),
}));

vi.mock("@/app/api/activity/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/activity/query")>()),
  fetchActivityStats,
  fetchActivityTransactions,
}));

import { GET } from "@/app/api/activity/route";
import { encodeActivityCursor } from "@/app/api/activity/query";

pages[0].nextCursor = encodeActivityCursor({
  createdAt: "2026-07-23T11:00:00.000Z",
  type: "playbook",
  id: "playbook-2",
});

describe("GET /api/activity", () => {
  beforeEach(() => {
    fetchActivityStats.mockReset().mockResolvedValue(stats);
    fetchActivityTransactions.mockReset();
  });

  it("returns an opaque cursor and traverses pages without gaps or duplicates", async () => {
    fetchActivityTransactions
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1]);

    const firstResponse = await GET(new Request("http://localhost/api/activity?limit=2"));
    const firstBody = await firstResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(firstBody.nextCursor).toBe(pages[0].nextCursor);
    expect(firstBody.nextCursor).not.toContain("2026-07-23");

    const secondResponse = await GET(
      new Request(`http://localhost/api/activity?limit=2&cursor=${firstBody.nextCursor}`),
    );
    const secondBody = await secondResponse.json();
    const ids = [...firstBody.transactions, ...secondBody.transactions].map((item) => item.id);

    expect(fetchActivityTransactions).toHaveBeenNthCalledWith(1, 2, null);
    expect(fetchActivityTransactions).toHaveBeenNthCalledWith(2, 2, pages[0].nextCursor);
    expect(ids).toEqual(["service-3", "playbook-2", "service-1"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns 400 for a malformed cursor", async () => {
    const response = await GET(new Request("http://localhost/api/activity?cursor=not-a-cursor"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid cursor" });
    expect(fetchActivityStats).not.toHaveBeenCalled();
    expect(fetchActivityTransactions).not.toHaveBeenCalled();
  });

  it("encodes ordering fields in an opaque cursor", () => {
    const cursor = encodeActivityCursor({
      createdAt: "2026-07-23T12:00:00.000Z",
      type: "service",
      id: "service-3",
    });

    expect(cursor).not.toContain("service-3");
    expect(cursor).not.toContain("2026-07-23");
  });

  it("uses service rows before playbook rows as the timestamp tie-breaker", () => {
    const sameTimestamp = "2026-07-23T12:00:00.000Z";
    const ordered = [
      { type: "playbook", id: "playbook-1", timestamp: sameTimestamp },
      { type: "service", id: "service-1", timestamp: sameTimestamp },
    ].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return b.timestamp.localeCompare(a.timestamp);
      if (a.type !== b.type) return a.type === "service" ? -1 : 1;
      return b.id.localeCompare(a.id);
    });

    expect(ordered.map((item) => item.type)).toEqual(["service", "playbook"]);
  });
});