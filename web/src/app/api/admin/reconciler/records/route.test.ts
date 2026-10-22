import { describe, it, expect, beforeEach, vi } from "vitest";

const mockGetStats = vi.fn();
const mockRunOneTick = vi.fn();
const mockVerifyAdminKey = vi.fn();
const mockSelect = vi.fn();

vi.mock("@/lib/reconciler", () => ({
  getStats: () => mockGetStats(),
  runOneTick: () => mockRunOneTick(),
}));

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminKey: (...args: unknown[]) => mockVerifyAdminKey(...args),
}));

vi.mock("@/db/schema", () => ({
  tlsStellarTxRecords: {
    txHash: "txHash",
    sourceType: "sourceType",
    sourceId: "sourceId",
    finalityStatus: "finalityStatus",
    pollCount: "pollCount",
    lastError: "lastError",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
}));

type Row = {
  txHash: string;
  sourceType: string;
  sourceId: string;
  finalityStatus: string;
  pollCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    txHash:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    sourceType: "payment",
    sourceId: "pay_123",
    finalityStatus: "pending",
    pollCount: 3,
    lastError: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

// Chainable query builder mock that records calls and resolves to given rows.
function makeQuery(rows: Row[]) {
  const calls: string[] = [];
  const chain: any = {
    from: vi.fn(() => {
      calls.push("from");
      return chain;
    }),
    where: vi.fn(() => {
      calls.push("where");
      return chain;
    }),
    orderBy: vi.fn(() => {
      calls.push("orderBy");
      return chain;
    }),
    limit: vi.fn(() => {
      calls.push("limit");
      return chain;
    }),
    then: (
      onFulfilled: (value: Row[]) => unknown,
      onRejected?: (value: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
  return { chain, calls };
}

let currentQuery: ReturnType<typeof makeQuery> | null = null;

beforeEach(() => {
  vi.resetAllMocks();
  currentQuery = null;
  mockVerifyAdminKey.mockReset();
  mockGetStats.mockReset();
  mockRunOneTick.mockReset();
  mockSelect.mockReset();
});

async function loadRoute() {
  return import("./route");
}

function request(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: "GET", headers });
}

describe("GET /api/admin/reconciler/records", () => {
  it("rejects requests without a valid admin key", async () => {
    mockVerifyAdminKey.mockReturnValue(false);
    const { GET } = await loadRoute();
    const res = await GET(request("http://localhost/api/admin/reconciler/records"));
    expect(res.status).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("rejects requests with an invalid admin key", async () => {
    mockVerifyAdminKey.mockReturnValue(false);
    const { GET } = await loadRoute();
    const res = await GET(
      request("http://localhost/api/admin/reconciler/records", {
        "x-admin-key": "wrong-key",
      }),
    );
    expect(res.status).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns privacy-safe fields only", async () => {
    mockVerifyAdminKey.mockReturnValue(true);
    currentQuery = makeQuery([makeRow()]);
    mockSelect.mockImplementation(() => currentQuery!.chain);

    const { GET } = await loadRoute();
    const res = await GET(
      request("http://localhost/api/admin/reconciler/records", {
        "x-admin-key": "valid-key",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toHaveLength(1);
    const record = body.records[0];
    expect(Object.keys(record).sort()).toEqual(
      [
        "createdAt",
        "finalityStatus",
        "lastError",
        "pollCount",
        "sourceId",
        "sourceType",
        "txHash",
        "updatedAt",
      ].sort(),
    );
    expect(record.txHash).not.toBe(makeRow().txHash);
    expect(record.txHash.length).toBeLessThan(20);
    expect(record.txHash).toMatch(/^[0-9a-f]+\.…[0-9a-f]+$/);
    expect(JSON.stringify(body)).not.toContain("xdr");
    expect(JSON.stringify(body)).not.toContain("payload");
  });

  it("applies the status filter", async () => {
    mockVerifyAdminKey.mockReturnValue(true);
    currentQuery = makeQuery([]);
    mockSelect.mockImplementation(() => currentQuery!.chain);

    const { GET } = await loadRoute();
    const res = await GET(
      request(
        "http://localhost/api/admin/reconciler/records?status=failed",
        { "x-admin-key": "valid-key" },
      ),
    );
    expect(res.status).toBe(200);
    expect(currentQuery!.calls).toContain("where");
  });

  it("rejects an unknown status filter", async () => {
    mockVerifyAdminKey.mockReturnValue(true);
    currentQuery = makeQuery([]);
    mockSelect.mockImplementation(() => currentQuery!.chain);

    const { GET } = await loadRoute();
    const res = await GET(
      request(
        "http://localhost/api/admin/reconciler/records?status=not-a-status",
        { "x-admin-key": "valid-key" },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("paginates with a limit and cursor", async () => {
    mockVerifyAdminKey.mockReturnValue(true);
    const rows = [
        makeRow({ sourceId: "pay_1", updatedAt: new Date("2024-01-05T00:00:00.000Z") }),
        makeRow({ sourceId: "pay_2", updatedAt: new Date("2024-01-04T00:00:00.000Z") }),
      ],
      cursor = new Date("2024-01-06T00:00:00.000Z").toISOString();
    currentQuery = makeQuery(rows);
    mockSelect.mockImplementation(() => currentQuery!.chain);

    const { GET } = await loadRoute();
    const res = await GET(
      request(
        `http://localhost/api/admin/reconciler/records?limit=1&cursor=${encodeURIComponent(cursor)}`,
        { "x-admin-key": "valid-key" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].sourceId).toBe("pay_1");
    expect(body.nextCursor).toBe("2024-01-05T00:00:00.000Z");
    expect(currentQuery!.calls).toContain("limit");
  });

  it("returns an empty list with null cursor when there are no records", async () => {
    mockVerifyAdminKey.mockReturnValue(true);
    currentQuery = makeQuery([]);
    mockSelect.mockImplementation(() => currentQuery!.chain);

    const { GET } = await loadRoute();
    const res = await GET(
      request("http://localhost/api/admin/reconciler/records", {
        "x-admin-key": "valid-key",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });
});
