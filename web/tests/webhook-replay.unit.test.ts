import { describe, it, expect, vi, beforeEach } from "vitest";
import { replayEvents } from "@/lib/webhooks/replay";
import { POST as replayHandler } from "@/app/api/webhooks/subscriptions/[id]/replay/route";
import { NextRequest } from "next/server";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockTransaction = vi.fn(async (cb: (tx: any) => Promise<any>) => {
  return cb({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  });
});

vi.mock("@/db", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    insert: (...args: any[]) => mockInsert(...args),
    update: (...args: any[]) => mockUpdate(...args),
    delete: (...args: any[]) => mockDelete(...args),
    transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/outbox/store", () => ({
  writeOutboxEvent: vi.fn(async (_tx, input) => {
    return { id: "outbox_new", ...input };
  }),
}));

function mockQueryChain(result: any) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
    then: vi.fn().mockImplementation((cb: (r: any) => any) => Promise.resolve(cb(result))),
  };
  return chain;
}

describe("Webhook Redelivery Replay Window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("replayEvents unit behavior", () => {
    it("successfully finds matching events in bounded window and queues idempotent replays", async () => {
      const { writeOutboxEvent } = await import("@/lib/outbox/store");

      const mockSub = {
        id: "sub_123",
        talosId: "talos_1",
        eventTypes: ["commerce_job.completed", "revenue.recorded"],
      };

      const mockEvents = [
        {
          id: "evt_1",
          aggregateType: "commerce_job",
          aggregateId: "job_1",
          eventType: "commerce_job.completed",
          payload: { foo: "bar" },
          createdAt: new Date("2026-11-19T00:00:00Z"),
        },
      ];

      // 1. Subscription lookup
      mockSelect.mockReturnValueOnce(mockQueryChain([mockSub]));
      // 2. Events query
      mockSelect.mockReturnValueOnce(mockQueryChain(mockEvents));

      const startTime = new Date("2026-11-18T00:00:00Z");
      const endTime = new Date("2026-11-20T00:00:00Z");
      const replayId = "replay_req_abc123";

      const res = await replayEvents("sub_123", startTime, endTime, replayId);

      expect(res.replayedCount).toBe(1);
      expect(writeOutboxEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          aggregateType: "commerce_job",
          aggregateId: "job_1",
          eventType: "commerce_job.completed",
          dedupeKey: `replay:${replayId}:evt_1`,
          payload: expect.objectContaining({
            foo: "bar",
            isReplay: true,
            replayId,
            originalEventId: "evt_1",
          }),
        }),
      );
    });

    it("rejects boundary case when startTime is after endTime", async () => {
      const startTime = new Date("2026-11-20T00:00:00Z");
      const endTime = new Date("2026-11-18T00:00:00Z");

      await expect(
        replayEvents("sub_123", startTime, endTime, "replay_1"),
      ).rejects.toThrow(/Invalid time window/);
    });

    it("throws when subscription does not exist", async () => {
      mockSelect.mockReturnValueOnce(mockQueryChain([]));

      await expect(
        replayEvents("sub_nonexistent", new Date(), new Date(), "replay_1"),
      ).rejects.toThrow(/Subscription not found/);
    });
  });

  describe("POST /api/webhooks/subscriptions/:id/replay route handler", () => {
    it("returns 400 when startTime is greater than endTime in request body", async () => {
      // Auth lookup
      mockSelect.mockReturnValueOnce(mockQueryChain([{ id: "talos_1" }]));
      // Subscription lookup
      mockSelect.mockReturnValueOnce(mockQueryChain([{ id: "sub_1" }]));

      const req = new NextRequest("http://localhost:3000/api/webhooks/subscriptions/sub_1/replay", {
        method: "POST",
        headers: {
          authorization: "Bearer talos_test_key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          replayId: "replay_123",
          startTime: "2026-11-20T10:00:00.000Z",
          endTime: "2026-11-19T10:00:00.000Z",
        }),
      });

      const response = await replayHandler(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("startTime must be before or equal to endTime")]),
      );
    });

    it("returns 401 when authorization header is missing", async () => {
      const req = new NextRequest("http://localhost:3000/api/webhooks/subscriptions/sub_1/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          replayId: "replay_123",
          startTime: "2026-11-18T10:00:00.000Z",
          endTime: "2026-11-19T10:00:00.000Z",
        }),
      });

      const response = await replayHandler(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(response.status).toBe(401);
    });

    it("returns 404 when subscription not owned by caller", async () => {
      // Auth lookup returns talos_1
      mockSelect.mockReturnValueOnce(mockQueryChain([{ id: "talos_1" }]));
      // Sub lookup returns empty
      mockSelect.mockReturnValueOnce(mockQueryChain([]));

      const req = new NextRequest("http://localhost:3000/api/webhooks/subscriptions/sub_1/replay", {
        method: "POST",
        headers: {
          authorization: "Bearer talos_test_key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          replayId: "replay_123",
          startTime: "2026-11-18T10:00:00.000Z",
          endTime: "2026-11-19T10:00:00.000Z",
        }),
      });

      const response = await replayHandler(req, { params: Promise.resolve({ id: "sub_1" }) });
      expect(response.status).toBe(404);
    });
  });
});
