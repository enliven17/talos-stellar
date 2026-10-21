import { describe, it, expect, vi, beforeEach } from "vitest";
import rawFixtures from "../../contracts/fixtures/event_fixtures.json";
import {
  ingestEvents,
  pollContractEventsOnce,
  normalizeRpcEvent,
  type SorobanRpcEventResponse,
} from "@/lib/contract-events/indexer";
import { listContractEvents } from "@/lib/contract-events/store";
import { db } from "@/db";

// In-memory mock database store
const mockEventsTable: Map<string, any> = new Map();
const mockCursorTable: Map<string, number> = new Map();

vi.mock("@/db", () => {
  return {
    db: {
      select: vi.fn((fields) => {
        return {
          from: vi.fn((table) => {
            return {
              where: vi.fn((condition) => {
                return {
                  limit: vi.fn(async (limitCount) => {
                    // Check if querying cursor table
                    if (fields && fields.lastLedger) {
                      const val = mockCursorTable.get("default");
                      return val !== undefined ? [{ lastLedger: val }] : [];
                    }
                    // Querying events table
                    const items = Array.from(mockEventsTable.values());
                    return items.slice(0, limitCount);
                  }),
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(async (limitCount) => {
                      const items = Array.from(mockEventsTable.values()).sort((a, b) => {
                        if (a.ledger !== b.ledger) return b.ledger - a.ledger;
                        return b.id.localeCompare(a.id);
                      });
                      return items.slice(0, limitCount);
                    }),
                  })),
                };
              }),
              orderBy: vi.fn(() => ({
                limit: vi.fn(async (limitCount) => {
                  const items = Array.from(mockEventsTable.values()).sort((a, b) => {
                    if (a.ledger !== b.ledger) return b.ledger - a.ledger;
                    return b.id.localeCompare(a.id);
                  });
                  return items.slice(0, limitCount);
                }),
              })),
            };
          }),
        };
      }),
      insert: vi.fn((table) => {
        return {
          values: vi.fn((vals) => {
            return {
              onConflictDoUpdate: vi.fn(async ({ set }) => {
                if (vals.id && "lastLedger" in vals) {
                  mockCursorTable.set(vals.id, set.lastLedger ?? vals.lastLedger);
                }
                return;
              }),
              onConflictDoNothing: vi.fn(async () => {
                if (vals.id && !mockEventsTable.has(vals.id)) {
                  mockEventsTable.set(vals.id, vals);
                }
                return;
              }),
            };
          }),
        };
      }),
    },
  };
});

describe("Contract Events Indexer & Decoder", () => {
  beforeEach(() => {
    mockEventsTable.clear();
    mockCursorTable.clear();
    vi.clearAllMocks();
  });

  it("normalizes and decodes event envelope correctly", () => {
    const raw = rawFixtures.fixtures[0]; // tls_crt
    const rpcEvent: SorobanRpcEventResponse = {
      id: raw.id,
      ledger: raw.ledger_sequence,
      contractId: raw.contract,
      txHash: raw.tx_hash,
      topics: raw.topics,
      data: raw.data,
      tx_index_in_ledger: raw.tx_index_in_ledger,
      event_index_in_tx: raw.event_index_in_tx,
    };

    const normalized = normalizeRpcEvent(rpcEvent);
    expect(normalized).not.toBeNull();
    expect(normalized?.contract).toBe(raw.contract);
    expect(normalized?.ledger_sequence).toBe(raw.ledger_sequence);
    expect(normalized?.topics[0].value).toBe("tls_crt");
  });

  it("ingests and stores decoded events from all four contracts in event_fixtures.json", async () => {
    // Map fixtures to RPC event responses
    const rpcEvents: SorobanRpcEventResponse[] = rawFixtures.fixtures.map((f: any) => ({
      id: f.id,
      ledger: f.ledger_sequence,
      contractId: f.contract,
      txHash: f.tx_hash,
      topics: f.topics,
      data: f.data,
      tx_index_in_ledger: f.tx_index_in_ledger,
      event_index_in_tx: f.event_index_in_tx,
    }));

    const result = await ingestEvents(rpcEvents, "default");
    expect(result.processed).toBe(rpcEvents.length);
    expect(result.stored).toBeGreaterThan(0);

    // Verify stored events contain decoded payloads
    const storedList = Array.from(mockEventsTable.values());
    expect(storedList.length).toBe(result.stored);

    // Check creation event
    const crt = storedList.find((e) => e.topic === "tls_crt");
    expect(crt).toBeDefined();
    expect(crt.decodedPayload).toBeDefined();
    expect(crt.decodedPayload.event).toBe("tls_crt");
    expect(crt.decodedPayload.data.name).toBe("Genesis");

    // Check governance event
    const gov = storedList.find((e) => e.topic === "prop_crt");
    expect(gov).toBeDefined();
    expect(gov.decodedPayload).toBeDefined();
    expect(gov.decodedPayload.event).toBe("prop_crt");

    // Check update event
    const upd = storedList.find((e) => e.topic === "pat_upd");
    expect(upd).toBeDefined();
    expect(upd.decodedPayload).toBeDefined();
    expect(upd.decodedPayload.event).toBe("pat_upd");

    // Check payment event
    const pmt = storedList.find((e) => e.topic === "ep_cmt");
    expect(pmt).toBeDefined();
    expect(pmt.decodedPayload).toBeDefined();
    expect(pmt.decodedPayload.event).toBe("ep_cmt");
  });

  it("is idempotent: re-ingesting the same events does not duplicate entries", async () => {
    const rpcEvents: SorobanRpcEventResponse[] = rawFixtures.fixtures.slice(0, 3).map((f: any) => ({
      id: f.id,
      ledger: f.ledger_sequence,
      contractId: f.contract,
      txHash: f.tx_hash,
      topics: f.topics,
      data: f.data,
    }));

    await ingestEvents(rpcEvents, "default");
    const countFirst = mockEventsTable.size;

    // Ingest again
    await ingestEvents(rpcEvents, "default");
    expect(mockEventsTable.size).toBe(countFirst);
  });

  it("resumes from saved cursor and updates cursor monotonically", async () => {
    mockCursorTable.set("default", 100050);

    const mockRpcClient = {
      getEvents: vi.fn(async (params: any) => {
        expect(params.startLedger).toBe(100051); // 100050 + 1
        return {
          events: [
            {
              id: "ev-1",
              ledger: 100055,
              contractId: "talos_registry",
              txHash: "0x123",
              topics: [{ type: "symbol", value: "tls_crt" }, { type: "address", value: "GXXX" }],
              data: [{ type: "u32", value: 10 }, { type: "string", value: "Agent10" }, { type: "string", value: "Dev" }],
            },
          ],
          latestLedger: 100060,
        };
      }),
    };

    const res = await pollContractEventsOnce(
      {
        cursorId: "default",
        defaultStartLedger: 1,
        batchLimit: 50,
        pollIntervalMs: 1000,
      },
      mockRpcClient as any,
    );

    expect(res).not.toBeNull();
    expect(res?.processed).toBe(1);
    expect(mockCursorTable.get("default")).toBe(100060);
  });

  it("skips and logs unknown events and unsupported versions without crashing", async () => {
    const mixedEvents: SorobanRpcEventResponse[] = [
      // 1. Unknown event symbol
      {
        id: "unknown-1",
        ledger: 100,
        contractId: "talos_unknown",
        txHash: "0xunknown",
        topics: [{ type: "symbol", value: "unrecognized_evt" }],
        data: [],
      },
      // 2. Unsupported version
      {
        id: "unsupported-ver-1",
        ledger: 101,
        contractId: "talos_registry",
        txHash: "0xver",
        topics: [{ type: "symbol", value: "tls_crt2" }, { type: "address", value: "GXXX" }],
        data: [
          { type: "u32", value: 999 }, // version 999 > maxSupportedVersion (1)
          { type: "u32", value: 1 },
          { type: "string", value: "Future" },
          { type: "string", value: "Future" },
        ],
      },
      // 3. Malformed payload
      {
        id: "malformed-1",
        ledger: 102,
        contractId: "talos_governance",
        txHash: "0xmal",
        topics: [{ type: "symbol", value: "prop_crt" }], // missing proposal_id topic
        data: [],
      },
      // 4. Valid event
      {
        id: "valid-1",
        ledger: 103,
        contractId: "talos_registry",
        txHash: "0xvalid",
        topics: [{ type: "symbol", value: "tls_crt" }, { type: "address", value: "GXXX" }],
        data: [{ type: "u32", value: 1 }, { type: "string", value: "Genesis" }, { type: "string", value: "Core" }],
      },
    ];

    const result = await ingestEvents(mixedEvents, "default");
    expect(result.processed).toBe(4);
    expect(result.stored).toBe(4); // all rows stored, valid has decodedPayload, invalid have null decodedPayload
    expect(result.skipped).toBe(3);

    const validStored = mockEventsTable.get("valid-1");
    expect(validStored.decodedPayload).not.toBeNull();

    const unknownStored = mockEventsTable.get("unknown-1");
    expect(unknownStored.decodedPayload).toBeNull();
  });
});
