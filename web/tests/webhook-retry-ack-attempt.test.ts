// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const mockUpdate = vi.fn();
  return {
    mockDb: {
      select: mockSelect,
      update: mockUpdate,
    },
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/logger", () => ({
  logger: mocks.mockLogger,
}));

function selectChain(result: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (r: unknown[]) => unknown) => Promise.resolve(cb(result))),
  };
}

function updateChain(result: unknown[]) {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
}

describe("POST /api/webhooks/deliveries/:id/result — attempt binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid retry acknowledgement matching the current delivery attempt", async () => {
    const { POST } = await import("../src/app/api/webhooks/deliveries/[id]/result/route");

    mocks.mockDb.select
      .mockReturnValueOnce(selectChain([{ id: "worker_1" }]))
      .mockReturnValueOnce(
        selectChain([
          {
            id: "delivery_1",
            status: "failed",
            attempts: 1,
            maxAttempts: 5,
            fencingToken: 2,
          },
        ]),
      );

    mocks.mockDb.update.mockReturnValue(updateChain([{ id: "delivery_1" }]));

    const request = new NextRequest("http://localhost:3000/api/webhooks/deliveries/delivery_1/result", {
      method: "POST",
      headers: { Authorization: "Bearer tok_worker_1" },
      body: JSON.stringify({
        fencingToken: 2,
        attempt: 1,
        statusCode: 200,
      }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "delivery_1" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("delivered");
    expect(body.attempts).toBe(2);
    expect(mocks.mockDb.update).toHaveBeenCalledTimes(1);
  });

  it("rejects stale acknowledgement from an older attempt with 409 and preserves current lease and status", async () => {
    const { POST } = await import("../src/app/api/webhooks/deliveries/[id]/result/route");

    mocks.mockDb.select
      .mockReturnValueOnce(selectChain([{ id: "worker_1" }]))
      .mockReturnValueOnce(
        selectChain([
          {
            id: "delivery_1",
            status: "failed",
            attempts: 2,
            maxAttempts: 5,
            fencingToken: 3,
          },
        ]),
      );

    const request = new NextRequest("http://localhost:3000/api/webhooks/deliveries/delivery_1/result", {
      method: "POST",
      headers: { Authorization: "Bearer tok_worker_1" },
      body: JSON.stringify({
        fencingToken: 3,
        attempt: 1,
        statusCode: 500,
        error: "Delayed timeout from attempt 1",
      }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "delivery_1" }) });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("Stale attempt acknowledgement");
    expect(body.detail).toContain("attempt 1");
    expect(body.detail).toContain("attempt 2");
    expect(mocks.mockDb.update).not.toHaveBeenCalled();
  });

  it("rejects acknowledgement targeting a future attempt with 409 without mutating lease or status", async () => {
    const { POST } = await import("../src/app/api/webhooks/deliveries/[id]/result/route");

    mocks.mockDb.select
      .mockReturnValueOnce(selectChain([{ id: "worker_1" }]))
      .mockReturnValueOnce(
        selectChain([
          {
            id: "delivery_1",
            status: "pending",
            attempts: 1,
            maxAttempts: 5,
            fencingToken: 2,
          },
        ]),
      );

    const request = new NextRequest("http://localhost:3000/api/webhooks/deliveries/delivery_1/result", {
      method: "POST",
      headers: { Authorization: "Bearer tok_worker_1" },
      body: JSON.stringify({
        fencingToken: 2,
        attempt: 3,
        statusCode: 200,
      }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "delivery_1" }) });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("Attempt mismatch");
    expect(mocks.mockDb.update).not.toHaveBeenCalled();
  });

  it("returns 409 when a concurrent attempt advances the delivery between select and update", async () => {
    const { POST } = await import("../src/app/api/webhooks/deliveries/[id]/result/route");

    mocks.mockDb.select
      .mockReturnValueOnce(selectChain([{ id: "worker_1" }]))
      .mockReturnValueOnce(
        selectChain([
          {
            id: "delivery_1",
            status: "failed",
            attempts: 1,
            maxAttempts: 5,
            fencingToken: 2,
          },
        ]),
      );

    // Simulate atomic WHERE (id, fencingToken, attempts) matching 0 rows due to concurrent advancement
    mocks.mockDb.update.mockReturnValue(updateChain([]));

    const request = new NextRequest("http://localhost:3000/api/webhooks/deliveries/delivery_1/result", {
      method: "POST",
      headers: { Authorization: "Bearer tok_worker_1" },
      body: JSON.stringify({
        fencingToken: 2,
        attempt: 1,
        statusCode: 500,
        error: "Concurrent stale write",
      }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "delivery_1" }) });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("Stale attempt acknowledgement");
  });

  it("preserves backward compatibility when attempt is omitted", async () => {
    const { POST } = await import("../src/app/api/webhooks/deliveries/[id]/result/route");

    mocks.mockDb.select
      .mockReturnValueOnce(selectChain([{ id: "worker_1" }]))
      .mockReturnValueOnce(
        selectChain([
          {
            id: "delivery_1",
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            fencingToken: 1,
          },
        ]),
      );

    mocks.mockDb.update.mockReturnValue(updateChain([{ id: "delivery_1" }]));

    const request = new NextRequest("http://localhost:3000/api/webhooks/deliveries/delivery_1/result", {
      method: "POST",
      headers: { Authorization: "Bearer tok_worker_1" },
      body: JSON.stringify({
        fencingToken: 1,
        statusCode: 200,
      }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "delivery_1" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("delivered");
    expect(body.attempts).toBe(1);
    expect(mocks.mockDb.update).toHaveBeenCalledTimes(1);
  });

  it("rejects negative attempt values with 400", async () => {
    const { POST } = await import("../src/app/api/webhooks/deliveries/[id]/result/route");

    mocks.mockDb.select.mockReturnValueOnce(selectChain([{ id: "worker_1" }]));

    const request = new NextRequest("http://localhost:3000/api/webhooks/deliveries/delivery_1/result", {
      method: "POST",
      headers: { Authorization: "Bearer tok_worker_1" },
      body: JSON.stringify({
        fencingToken: 1,
        attempt: -1,
        statusCode: 200,
      }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "delivery_1" }) });
    expect(response.status).toBe(400);
    expect(mocks.mockDb.update).not.toHaveBeenCalled();
  });
});
