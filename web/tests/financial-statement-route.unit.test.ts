import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { selectMock, verifyOwnerProofMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  verifyOwnerProofMock: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: selectMock } }));
vi.mock("@/lib/api-key-owner-auth", () => ({
  verifyApiKeyOwnerProof: verifyOwnerProofMock,
}));
vi.mock("@/lib/with-request-id", () => ({
  withRequestId: (handler: () => Promise<Response>) => handler,
}));

function chain(result: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
  };
  return query;
}

function request(id: string, query = "") {
  return new NextRequest(`http://localhost/api/talos/${id}/financial-statement${query}`, {
    method: "GET",
    headers: {
      "x-talos-owner-address": "GCREATOR",
      "x-talos-owner-message": `talos:${id}:financial-statement:GET:1763904000000`,
      "x-talos-owner-signature": "c2lnbmF0dXJl",
    },
  });
}

describe("GET /api/talos/[id]/financial-statement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyOwnerProofMock.mockResolvedValue(true);
    selectMock
      .mockReturnValueOnce(
        chain([
          {
            id: "talos-1",
            name: "Alpha Corp",
            agentName: "alpha",
            createdAt: new Date("2026-11-01T00:00:00.000Z"),
            observedAt: null,
          },
        ]),
      )
      .mockReturnValueOnce(
        chain([
          {
            id: "rev-1",
            amount: "12.345678",
            source: "job-payment",
            txHash: "tx-rev-1",
            createdAt: new Date("2026-11-21T09:00:00.000Z"),
          },
        ]),
      )
      .mockReturnValueOnce(
        chain([
          {
            id: "apr-1",
            amount: "3.25",
            type: "withdrawal",
            title: "Treasury withdrawal",
            status: "approved",
            txHash: "tx-apr-1",
            createdAt: new Date("2026-11-22T09:00:00.000Z"),
          },
        ]),
      );
  });

  it("requires a fresh owner proof bound to the financial-statement resource", async () => {
    verifyOwnerProofMock.mockResolvedValue(false);
    const { GET } = await import("../src/app/api/talos/[id]/financial-statement/route");

    const response = await GET(request("talos-1"), { params: Promise.resolve({ id: "talos-1" }) });

    expect(response.status).toBe(401);
    expect(verifyOwnerProofMock).toHaveBeenCalledWith(
      expect.anything(),
      "talos-1",
      "financial-statement",
    );
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("returns a JSON attachment with exact activity and no credentials", async () => {
    const { GET } = await import("../src/app/api/talos/[id]/financial-statement/route");

    const response = await GET(request("talos-1"), { params: Promise.resolve({ id: "talos-1" }) });
    const text = await response.text();
    const statement = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="talos-talos-1-financial-statement.json"',
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(statement.talosId).toBe("talos-1");
    expect(statement.entries).toHaveLength(2);
    expect(statement.entries[0].amountUsdc).toBe("12.345678");
    expect(statement.entries[1].status).toBe("approved");
    expect(text).not.toContain("apiKey");
  });

  it("returns a CSV attachment for format=csv", async () => {
    const { GET } = await import("../src/app/api/talos/[id]/financial-statement/route");

    const response = await GET(request("talos-1", "?format=csv"), {
      params: Promise.resolve({ id: "talos-1" }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(
      'attachment; filename="talos-talos-1-financial-statement.csv"',
    );
    expect(text).toContain("12.345678");
    expect(text).toContain("approved");
  });

  it("returns 404 when the agent does not exist", async () => {
    selectMock.mockReset();
    selectMock.mockReturnValue(chain([]));
    const { GET } = await import("../src/app/api/talos/[id]/financial-statement/route");

    const response = await GET(request("missing"), { params: Promise.resolve({ id: "missing" }) });

    expect(response.status).toBe(404);
  });
});
