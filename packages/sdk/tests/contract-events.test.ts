/**
 * Typed contract event decoder tests.
 *
 * Covers: positive decoding for every event family, negative validation
 * (empty topics, wrong types, wrong arity, topic[0] not symbol, unknown
 * event), boundary cases (version gating, cursor defaults, batch mode),
 * regression tests (wire-level fixtures from the canonical fixture file),
 * type guards, cursor comparison, and batch error collection.
 */
import { describe, it, expect } from "vitest";
import {
  decodeContractEvent,
  decodeContractEvents,
  isContractEvent,
  isContractEventFamily,
  compareEventCursors,
  ContractEventError,
  UnknownContractEventError,
  MalformedContractEventError,
  UnsupportedContractVersionError,
  BUILTIN_EVENT_CATALOG,
  CATALOG_SPEC_VERSION,
} from "../src/contract-events.js";
import type {
  RawContractEvent,
  DecodedContractEvent,
  EventCursor,
} from "../src/contract-events.js";

// ── Wire-level fixtures (from contracts/fixtures/event_fixtures.json) ─────────

/** Stable wire-level fixture: tls_crt creation event. */
const TLS_CRT_RAW: RawContractEvent = {
  contract: "talos_registry",
  topics: [
    { type: "symbol", value: "tls_crt" },
    { type: "address", value: "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ" },
  ],
  data: [
    { type: "u32", value: 1 },
    { type: "string", value: "Genesis" },
    { type: "string", value: "Marketing" },
  ],
  ledger_sequence: 100000,
  tx_index_in_ledger: 0,
  event_index_in_tx: 0,
};

/** Stable wire-level fixture: tls_crt2 creation event (v2 with version field). */
const TLS_CRT2_RAW: RawContractEvent = {
  contract: "talos_registry",
  topics: [
    { type: "symbol", value: "tls_crt2" },
    { type: "address", value: "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ" },
  ],
  data: [
    { type: "u32", value: 1 },
    { type: "u32", value: 1 },
    { type: "string", value: "Genesis" },
    { type: "string", value: "Marketing" },
  ],
  ledger_sequence: 100000,
  tx_index_in_ledger: 0,
  event_index_in_tx: 1,
};

/** Stable wire-level fixture: pat_upd update event. */
const PAT_UPD_RAW: RawContractEvent = {
  contract: "talos_registry",
  topics: [
    { type: "symbol", value: "pat_upd" },
    { type: "u32", value: 1 },
  ],
  data: [
    { type: "address", value: "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ" },
    { type: "u32", value: 5000 },
    { type: "u32", value: 3000 },
  ],
  ledger_sequence: 100010,
  tx_index_in_ledger: 0,
  event_index_in_tx: 1,
};

/** Stable wire-level fixture: reg_upd event. */
const REG_UPD_RAW: RawContractEvent = {
  contract: "talos_name_service",
  topics: [
    { type: "symbol", value: "reg_upd" },
  ],
  data: [
    { type: "address", value: "GCFUXR57HNFGGUWGSOW4O6NGE5RQTYE5MFAFLTU2CCNPBRUQUFEJAUV3" },
    { type: "address", value: "GAUC4C3V3FNCSJBILLB56MAVMUTOWQR2YQ5P7LTL2SDGC5CQ4D7WHER7" },
  ],
  ledger_sequence: 100020,
  tx_index_in_ledger: 0,
  event_index_in_tx: 0,
};

/** Stable wire-level fixture: prop_crt governance event. */
const PROP_CRT_RAW: RawContractEvent = {
  contract: "talos_governance",
  topics: [
    { type: "symbol", value: "prop_crt" },
    { type: "u32", value: 7 },
  ],
  data: [
    { type: "u32", value: 1 },
    { type: "address", value: "GDURVWHBP27CFBLJKVI2UISXSQU52MJABOJWVFKJKFYWDC6E6GDOTIFW" },
  ],
  ledger_sequence: 100100,
  tx_index_in_ledger: 0,
  event_index_in_tx: 0,
};

/** Stable wire-level fixture: vote governance event. */
const VOTE_RAW: RawContractEvent = {
  contract: "talos_governance",
  topics: [
    { type: "symbol", value: "vote" },
    { type: "u32", value: 7 },
  ],
  data: [
    { type: "address", value: "GD7B7EF2S2AHRXDZVOBRUKFOXF373C7J43LAACLCL2NW4XKEFFH63NMK" },
    { type: "symbol", value: "Approve" },
    { type: "i128", value: 150 },
  ],
  ledger_sequence: 100110,
  tx_index_in_ledger: 0,
  event_index_in_tx: 0,
};

/** Stable wire-level fixture: prop_stat governance event. */
const PROP_STAT_RAW: RawContractEvent = {
  contract: "talos_governance",
  topics: [
    { type: "symbol", value: "prop_stat" },
    { type: "u32", value: 7 },
  ],
  data: [
    { type: "symbol", value: "Approved" },
  ],
  ledger_sequence: 100120,
  tx_index_in_ledger: 0,
  event_index_in_tx: 0,
};

/** Stable wire-level fixture: ep_cmt payment event. */
const EP_CMT_RAW: RawContractEvent = {
  contract: "talos_dividends",
  topics: [
    { type: "symbol", value: "ep_cmt" },
    { type: "u32", value: 1 },
  ],
  data: [
    { type: "u64", value: 42 },
    { type: "i128", value: 1000000 },
    { type: "u64", value: 2592000 },
  ],
  ledger_sequence: 100200,
  tx_index_in_ledger: 0,
  event_index_in_tx: 0,
};

/** Stable wire-level fixture: div_clm payment event. */
const DIV_CLM_RAW: RawContractEvent = {
  contract: "talos_dividends",
  topics: [
    { type: "symbol", value: "div_clm" },
    { type: "u64", value: 42 },
    { type: "address", value: "GBUC4RLWOMRLPAIL4UZPB3MZYHVMMCC2UUEOVJ4DCFVHWHHRT7WY4F33" },
  ],
  data: [
    { type: "u32", value: 1 },
    { type: "i128", value: 600000 },
    { type: "symbol", value: "Creator" },
  ],
  ledger_sequence: 100210,
  tx_index_in_ledger: 0,
  event_index_in_tx: 0,
};

// ── Catalog sanity ────────────────────────────────────────────────────────────

describe("Contract event catalog", () => {
  it("CATALOG_SPEC_VERSION is 1.2.0", () => {
    expect(CATALOG_SPEC_VERSION).toBe("1.2.0");
  });

  it("built-in catalog has all four families", () => {
    expect(Object.keys(BUILTIN_EVENT_CATALOG).sort()).toEqual([
      "creation",
      "governance",
      "payment",
      "update",
    ]);
  });

  it("built-in catalog has all nine event symbols", () => {
    const symbols: string[] = [];
    for (const family of Object.values(BUILTIN_EVENT_CATALOG)) {
      symbols.push(...Object.keys(family));
    }
    expect(symbols.sort()).toEqual([
      "div_clm",
      "ep_cmt",
      "pat_upd",
      "prop_crt",
      "prop_stat",
      "reg_upd",
      "tls_crt",
      "tls_crt2",
      "vote",
    ]);
  });
});

// ── Positive decoding (one per event type) ────────────────────────────────────

describe("decodeContractEvent — positive (creation family)", () => {
  it("decodes tls_crt with correct typed fields", () => {
    const decoded = decodeContractEvent(TLS_CRT_RAW);
    expect(decoded.event).toBe("tls_crt");
    expect(decoded.family).toBe("creation");
    expect(decoded.contract).toBe("talos_registry");
    expect(decoded.topics).toEqual({
      event: "tls_crt",
      creator: "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ",
    });
    expect(decoded.data).toEqual({
      talos_id: 1,
      name: "Genesis",
      category: "Marketing",
    });
    expect(decoded.cursor).toEqual({
      ledger_sequence: 100000,
      tx_index_in_ledger: 0,
      event_index_in_tx: 0,
    });
  });

  it("decodes tls_crt2 with version field", () => {
    const decoded = decodeContractEvent(TLS_CRT2_RAW);
    expect(decoded.event).toBe("tls_crt2");
    expect(decoded.family).toBe("creation");
    expect(decoded.data).toEqual({
      version: 1,
      talos_id: 1,
      name: "Genesis",
      category: "Marketing",
    });
    expect(decoded.cursor.event_index_in_tx).toBe(1);
  });
});

describe("decodeContractEvent — positive (update family)", () => {
  it("decodes pat_upd with shares", () => {
    const decoded = decodeContractEvent(PAT_UPD_RAW);
    expect(decoded.event).toBe("pat_upd");
    expect(decoded.family).toBe("update");
    expect(decoded.topics).toEqual({ event: "pat_upd", talos_id: 1 });
    expect(decoded.data).toEqual({
      creator_addr:
        "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ",
      creator_share: 5000,
      investor_share: 3000,
    });
  });

  it("decodes reg_upd with old/new registry addresses", () => {
    const decoded = decodeContractEvent(REG_UPD_RAW);
    expect(decoded.event).toBe("reg_upd");
    expect(decoded.family).toBe("update");
    expect(decoded.topics).toEqual({ event: "reg_upd" });
    expect(decoded.data).toEqual({
      old_registry:
        "GCFUXR57HNFGGUWGSOW4O6NGE5RQTYE5MFAFLTU2CCNPBRUQUFEJAUV3",
      new_registry:
        "GAUC4C3V3FNCSJBILLB56MAVMUTOWQR2YQ5P7LTL2SDGC5CQ4D7WHER7",
    });
  });
});

describe("decodeContractEvent — positive (governance family)", () => {
  it("decodes prop_crt with proposal_id and proposer", () => {
    const decoded = decodeContractEvent(PROP_CRT_RAW);
    expect(decoded.event).toBe("prop_crt");
    expect(decoded.family).toBe("governance");
    expect(decoded.topics).toEqual({ event: "prop_crt", proposal_id: 7 });
    expect(decoded.data).toEqual({
      talos_id: 1,
      proposer: "GDURVWHBP27CFBLJKVI2UISXSQU52MJABOJWVFKJKFYWDC6E6GDOTIFW",
    });
  });

  it("decodes vote with choice and weight", () => {
    const decoded = decodeContractEvent(VOTE_RAW);
    expect(decoded.event).toBe("vote");
    expect(decoded.family).toBe("governance");
    expect(decoded.data).toEqual({
      voter: "GD7B7EF2S2AHRXDZVOBRUKFOXF373C7J43LAACLCL2NW4XKEFFH63NMK",
      choice: "Approve",
      weight: 150,
    });
  });

  it("decodes prop_stat with status", () => {
    const decoded = decodeContractEvent(PROP_STAT_RAW);
    expect(decoded.event).toBe("prop_stat");
    expect(decoded.family).toBe("governance");
    expect(decoded.data).toEqual({ status: "Approved" });
  });
});

describe("decodeContractEvent — positive (payment family)", () => {
  it("decodes ep_cmt with epoch commit data", () => {
    const decoded = decodeContractEvent(EP_CMT_RAW);
    expect(decoded.event).toBe("ep_cmt");
    expect(decoded.family).toBe("payment");
    expect(decoded.data).toEqual({
      epoch_id: 42,
      total: 1000000,
      expiry_secs: 2592000,
    });
  });

  it("decodes div_clm with dividend claim data", () => {
    const decoded = decodeContractEvent(DIV_CLM_RAW);
    expect(decoded.event).toBe("div_clm");
    expect(decoded.family).toBe("payment");
    expect(decoded.topics).toEqual({
      event: "div_clm",
      epoch_id: 42,
      patron: "GBUC4RLWOMRLPAIL4UZPB3MZYHVMMCC2UUEOVJ4DCFVHWHHRT7WY4F33",
    });
    expect(decoded.data).toEqual({
      talos_id: 1,
      amount: 600000,
      role: "Creator",
    });
  });
});

// ── Negative — structural validation ──────────────────────────────────────────

describe("decodeContractEvent — negative (malformed payloads)", () => {
  it("rejects null input", () => {
    expect(() =>
      decodeContractEvent(null as unknown as RawContractEvent),
    ).toThrow(MalformedContractEventError);
  });

  it("rejects empty topics array", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT_RAW,
      topics: [],
    };
    expect(() => decodeContractEvent(raw)).toThrow(
      MalformedContractEventError,
    );
    expect(() => decodeContractEvent(raw)).toThrow(
      "non-empty array",
    );
  });

  it("rejects topic[0] that is not a symbol", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT_RAW,
      topics: [
        { type: "u32", value: 99 },
        {
          type: "address",
          value:
            "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ",
        },
      ],
    };
    expect(() => decodeContractEvent(raw)).toThrow(
      MalformedContractEventError,
    );
    expect(() => decodeContractEvent(raw)).toThrow("must be a symbol");
  });

  it("rejects topic type mismatch (address expected, got u32)", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT_RAW,
      topics: [
        { type: "symbol", value: "tls_crt" },
        { type: "u32", value: 1 },
      ],
    };
    expect(() => decodeContractEvent(raw)).toThrow(
      MalformedContractEventError,
    );
    expect(() => decodeContractEvent(raw)).toThrow(
      "topic[1] expected type address",
    );
  });

  it("rejects wrong topic arity", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT_RAW,
      topics: [{ type: "symbol", value: "tls_crt" }],
    };
    expect(() => decodeContractEvent(raw)).toThrow(
      MalformedContractEventError,
    );
    expect(() => decodeContractEvent(raw)).toThrow("expected 2 topics, got 1");
  });

  it("rejects wrong data arity (too few fields)", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT_RAW,
      data: [
        { type: "u32", value: 1 },
        { type: "string", value: "Genesis" },
      ],
    };
    expect(() => decodeContractEvent(raw)).toThrow(
      MalformedContractEventError,
    );
    expect(() => decodeContractEvent(raw)).toThrow(
      "expected 3 data fields, got 2",
    );
  });

  it("rejects wrong data arity (too many fields)", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT_RAW,
      data: [
        { type: "u32", value: 1 },
        { type: "string", value: "Genesis" },
        { type: "string", value: "Marketing" },
        { type: "string", value: "Extra" },
      ],
    };
    expect(() => decodeContractEvent(raw)).toThrow(
      MalformedContractEventError,
    );
    expect(() => decodeContractEvent(raw)).toThrow(
      "expected 3 data fields, got 4",
    );
  });

  it("rejects data type mismatch (u32 expected, got string)", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT_RAW,
      data: [
        { type: "string", value: "not-a-number" },
        { type: "string", value: "Genesis" },
        { type: "string", value: "Marketing" },
      ],
    };
    expect(() => decodeContractEvent(raw)).toThrow(
      MalformedContractEventError,
    );
    expect(() => decodeContractEvent(raw)).toThrow(
      "data[0] expected type u32, got string",
    );
  });

  it("rejects data as non-array", () => {
    const raw = {
      ...TLS_CRT_RAW,
      data: "not-an-array",
    };
    expect(() =>
      decodeContractEvent(raw as unknown as RawContractEvent),
    ).toThrow(MalformedContractEventError);
  });
});

describe("decodeContractEvent — negative (unknown events)", () => {
  it("rejects unknown event symbol", () => {
    const raw: RawContractEvent = {
      contract: "talos_registry",
      topics: [{ type: "symbol", value: "unknown_event" }],
      data: [],
      ledger_sequence: 1,
    };
    expect(() => decodeContractEvent(raw)).toThrow(
      UnknownContractEventError,
    );
    expect(() => decodeContractEvent(raw)).toThrow("unknown_event");
  });

  it("UnknownContractEventError exposes the symbol", () => {
    const raw: RawContractEvent = {
      contract: "talos_registry",
      topics: [{ type: "symbol", value: "fancy_event" }],
      data: [],
      ledger_sequence: 1,
    };
    try {
      decodeContractEvent(raw);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownContractEventError);
      expect((err as UnknownContractEventError).symbol).toBe("fancy_event");
    }
  });
});

// ── Boundary — version gating ─────────────────────────────────────────────────

describe("decodeContractEvent — boundary (version gating)", () => {
  it("accepts tls_crt2 with version=1 (default maxSupportedVersion)", () => {
    const decoded = decodeContractEvent(TLS_CRT2_RAW);
    expect(decoded.event).toBe("tls_crt2");
    expect(decoded.data).toHaveProperty("version", 1);
  });

  it("rejects tls_crt2 with version=2 (exceeds default max)", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT2_RAW,
      data: [
        { type: "u32", value: 2 },
        { type: "u32", value: 1 },
        { type: "string", value: "Genesis" },
        { type: "string", value: "Marketing" },
      ],
    };
    expect(() => decodeContractEvent(raw)).toThrow(
      UnsupportedContractVersionError,
    );
  });

  it("UnsupportedContractVersionError exposes the version", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT2_RAW,
      data: [
        { type: "u32", value: 3 },
        { type: "u32", value: 1 },
        { type: "string", value: "Genesis" },
        { type: "string", value: "Marketing" },
      ],
    };
    try {
      decodeContractEvent(raw);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedContractVersionError);
      expect((err as UnsupportedContractVersionError).version).toBe(3);
    }
  });

  it("accepts tls_crt2 with version=2 when maxSupportedVersion=2", () => {
    const raw: RawContractEvent = {
      ...TLS_CRT2_RAW,
      data: [
        { type: "u32", value: 2 },
        { type: "u32", value: 1 },
        { type: "string", value: "Genesis" },
        { type: "string", value: "Marketing" },
      ],
    };
    const decoded = decodeContractEvent(raw, { maxSupportedVersion: 2 });
    expect(decoded.data).toHaveProperty("version", 2);
  });
});

// ── Boundary — cursor defaults ────────────────────────────────────────────────

describe("decodeContractEvent — boundary (cursor defaults)", () => {
  it("defaults tx_index_in_ledger and event_index_in_tx to 0", () => {
    const raw: RawContractEvent = {
      contract: "talos_governance",
      topics: [
        { type: "symbol", value: "prop_stat" },
        { type: "u32", value: 1 },
      ],
      data: [{ type: "symbol", value: "Active" }],
      ledger_sequence: 999,
    };
    const decoded = decodeContractEvent(raw);
    expect(decoded.cursor).toEqual({
      ledger_sequence: 999,
      tx_index_in_ledger: 0,
      event_index_in_tx: 0,
    });
  });
});

// ── Error hierarchy ───────────────────────────────────────────────────────────

describe("Contract event error hierarchy", () => {
  it("MalformedContractEventError extends ContractEventError", () => {
    const err = new MalformedContractEventError("test");
    expect(err).toBeInstanceOf(ContractEventError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MalformedContractEventError");
  });

  it("UnknownContractEventError extends ContractEventError", () => {
    const err = new UnknownContractEventError("sym");
    expect(err).toBeInstanceOf(ContractEventError);
    expect(err.name).toBe("UnknownContractEventError");
  });

  it("UnsupportedContractVersionError extends ContractEventError", () => {
    const err = new UnsupportedContractVersionError(5);
    expect(err).toBeInstanceOf(ContractEventError);
    expect(err.name).toBe("UnsupportedContractVersionError");
  });

  it("all contract event errors are catchable as ContractEventError", () => {
    const errors = [
      new ContractEventError("base"),
      new MalformedContractEventError("bad"),
      new UnknownContractEventError("sym"),
      new UnsupportedContractVersionError(9),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(ContractEventError);
    }
  });
});

// ── Type guards ───────────────────────────────────────────────────────────────

describe("isContractEvent — type guard", () => {
  it("narrows to tls_crt", () => {
    const decoded = decodeContractEvent(TLS_CRT_RAW);
    expect(isContractEvent(decoded, "tls_crt")).toBe(true);
    expect(isContractEvent(decoded, "vote")).toBe(false);
    if (isContractEvent(decoded, "tls_crt")) {
      // TypeScript narrows: this should compile
      const _id: number = decoded.data.talos_id;
      expect(_id).toBe(1);
    }
  });

  it("narrows to div_clm", () => {
    const decoded = decodeContractEvent(DIV_CLM_RAW);
    expect(isContractEvent(decoded, "div_clm")).toBe(true);
    if (isContractEvent(decoded, "div_clm")) {
      const _role: string = decoded.data.role;
      expect(_role).toBe("Creator");
    }
  });
});

describe("isContractEventFamily — type guard", () => {
  it("narrows to creation family", () => {
    const decoded = decodeContractEvent(TLS_CRT_RAW);
    expect(isContractEventFamily(decoded, "creation")).toBe(true);
    expect(isContractEventFamily(decoded, "governance")).toBe(false);
  });

  it("narrows to payment family", () => {
    const decoded = decodeContractEvent(EP_CMT_RAW);
    expect(isContractEventFamily(decoded, "payment")).toBe(true);
    expect(isContractEventFamily(decoded, "update")).toBe(false);
  });
});

// ── Cursor comparison ─────────────────────────────────────────────────────────

describe("compareEventCursors", () => {
  it("returns 0 for identical cursors", () => {
    const a: EventCursor = { ledger_sequence: 100, tx_index_in_ledger: 0, event_index_in_tx: 0 };
    expect(compareEventCursors(a, a)).toBe(0);
  });

  it("orders by ledger_sequence first", () => {
    const a: EventCursor = { ledger_sequence: 100, tx_index_in_ledger: 5, event_index_in_tx: 5 };
    const b: EventCursor = { ledger_sequence: 200, tx_index_in_ledger: 0, event_index_in_tx: 0 };
    expect(compareEventCursors(a, b)).toBeLessThan(0);
    expect(compareEventCursors(b, a)).toBeGreaterThan(0);
  });

  it("orders by tx_index_in_ledger second", () => {
    const a: EventCursor = { ledger_sequence: 100, tx_index_in_ledger: 1, event_index_in_tx: 9 };
    const b: EventCursor = { ledger_sequence: 100, tx_index_in_ledger: 2, event_index_in_tx: 0 };
    expect(compareEventCursors(a, b)).toBeLessThan(0);
  });

  it("orders by event_index_in_tx third", () => {
    const a: EventCursor = { ledger_sequence: 100, tx_index_in_ledger: 1, event_index_in_tx: 0 };
    const b: EventCursor = { ledger_sequence: 100, tx_index_in_ledger: 1, event_index_in_tx: 1 };
    expect(compareEventCursors(a, b)).toBeLessThan(0);
  });

  it("sorts an array of decoded events correctly", () => {
    const events = [DIV_CLM_RAW, TLS_CRT_RAW, VOTE_RAW, PAT_UPD_RAW].map(
      (raw) => decodeContractEvent(raw),
    );
    events.sort((a, b) => compareEventCursors(a.cursor, b.cursor));
    expect(events.map((e) => e.event)).toEqual([
      "tls_crt",     // 100000:0:0
      "pat_upd",     // 100010:0:1
      "vote",        // 100110:0:0
      "div_clm",     // 100210:0:0
    ]);
  });
});

// ── Batch decoding ────────────────────────────────────────────────────────────

describe("decodeContractEvents — batch", () => {
  it("decodes all valid events in a batch", () => {
    const result = decodeContractEvents([
      TLS_CRT_RAW,
      PAT_UPD_RAW,
      VOTE_RAW,
      EP_CMT_RAW,
    ]);
    expect(result.decoded).toHaveLength(4);
    expect(result.errors).toHaveLength(0);
    expect(result.decoded.map((e) => e.event)).toEqual([
      "tls_crt",
      "pat_upd",
      "vote",
      "ep_cmt",
    ]);
  });

  it("collects errors without throwing, preserving valid events", () => {
    const badRaw: RawContractEvent = {
      contract: "talos_registry",
      topics: [],
      data: [],
      ledger_sequence: 1,
    };
    const result = decodeContractEvents([TLS_CRT_RAW, badRaw, VOTE_RAW]);
    expect(result.decoded).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(1);
    expect(result.errors[0].error).toBeInstanceOf(MalformedContractEventError);
  });

  it("returns empty arrays for empty input", () => {
    const result = decodeContractEvents([]);
    expect(result.decoded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("handles all-bad input gracefully", () => {
    const bads: RawContractEvent[] = [
      { contract: "x", topics: [], data: [], ledger_sequence: 1 },
      { contract: "x", topics: [{ type: "u32", value: 0 }], data: [], ledger_sequence: 2 },
    ];
    const result = decodeContractEvents(bads);
    expect(result.decoded).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].index).toBe(0);
    expect(result.errors[1].index).toBe(1);
  });

  it("preserves original indices in batch errors", () => {
    const unknown: RawContractEvent = {
      contract: "talos_registry",
      topics: [{ type: "symbol", value: "not_real" }],
      data: [],
      ledger_sequence: 99,
    };
    const result = decodeContractEvents([
      TLS_CRT_RAW,
      unknown,
      PAT_UPD_RAW,
      unknown,
      VOTE_RAW,
    ]);
    expect(result.decoded).toHaveLength(3);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].index).toBe(1);
    expect(result.errors[1].index).toBe(3);
    expect(result.errors[0].error).toBeInstanceOf(UnknownContractEventError);
    expect(result.errors[1].error).toBeInstanceOf(UnknownContractEventError);
  });
});

// ── Regression — wire-level fixture round-trip ────────────────────────────────

describe("Wire-level fixture round-trip (regression)", () => {
  /**
   * Each entry matches the `decoded` object from the canonical
   * `contracts/fixtures/event_fixtures.json`. This ensures the SDK
   * decoder produces exactly the same output as the reference helper.
   */
  const FIXTURE_EXPECTATIONS: Array<{
    id: string;
    raw: RawContractEvent;
    expectedTopics: Record<string, string | number>;
    expectedData: Record<string, string | number>;
  }> = [
    {
      id: "creation.tls_crt.normal",
      raw: TLS_CRT_RAW,
      expectedTopics: {
        event: "tls_crt",
        creator: "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ",
      },
      expectedData: { talos_id: 1, name: "Genesis", category: "Marketing" },
    },
    {
      id: "creation.tls_crt2.normal",
      raw: TLS_CRT2_RAW,
      expectedTopics: {
        event: "tls_crt2",
        creator: "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ",
      },
      expectedData: {
        version: 1,
        talos_id: 1,
        name: "Genesis",
        category: "Marketing",
      },
    },
    {
      id: "update.pat_upd.normal",
      raw: PAT_UPD_RAW,
      expectedTopics: { event: "pat_upd", talos_id: 1 },
      expectedData: {
        creator_addr:
          "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ",
        creator_share: 5000,
        investor_share: 3000,
      },
    },
    {
      id: "update.reg_upd.normal",
      raw: REG_UPD_RAW,
      expectedTopics: { event: "reg_upd" },
      expectedData: {
        old_registry:
          "GCFUXR57HNFGGUWGSOW4O6NGE5RQTYE5MFAFLTU2CCNPBRUQUFEJAUV3",
        new_registry:
          "GAUC4C3V3FNCSJBILLB56MAVMUTOWQR2YQ5P7LTL2SDGC5CQ4D7WHER7",
      },
    },
    {
      id: "governance.prop_crt.normal",
      raw: PROP_CRT_RAW,
      expectedTopics: { event: "prop_crt", proposal_id: 7 },
      expectedData: {
        talos_id: 1,
        proposer: "GDURVWHBP27CFBLJKVI2UISXSQU52MJABOJWVFKJKFYWDC6E6GDOTIFW",
      },
    },
    {
      id: "governance.vote.normal",
      raw: VOTE_RAW,
      expectedTopics: { event: "vote", proposal_id: 7 },
      expectedData: {
        voter: "GD7B7EF2S2AHRXDZVOBRUKFOXF373C7J43LAACLCL2NW4XKEFFH63NMK",
        choice: "Approve",
        weight: 150,
      },
    },
    {
      id: "governance.prop_stat.normal",
      raw: PROP_STAT_RAW,
      expectedTopics: { event: "prop_stat", proposal_id: 7 },
      expectedData: { status: "Approved" },
    },
    {
      id: "payment.ep_cmt.normal",
      raw: EP_CMT_RAW,
      expectedTopics: { event: "ep_cmt", talos_id: 1 },
      expectedData: { epoch_id: 42, total: 1000000, expiry_secs: 2592000 },
    },
    {
      id: "payment.div_clm.normal",
      raw: DIV_CLM_RAW,
      expectedTopics: {
        event: "div_clm",
        epoch_id: 42,
        patron: "GBUC4RLWOMRLPAIL4UZPB3MZYHVMMCC2UUEOVJ4DCFVHWHHRT7WY4F33",
      },
      expectedData: { talos_id: 1, amount: 600000, role: "Creator" },
    },
  ];

  for (const fixture of FIXTURE_EXPECTATIONS) {
    it(`fixture ${fixture.id}: topics match canonical decoded`, () => {
      const decoded = decodeContractEvent(fixture.raw);
      expect(decoded.topics).toEqual(fixture.expectedTopics);
    });

    it(`fixture ${fixture.id}: data match canonical decoded`, () => {
      const decoded = decodeContractEvent(fixture.raw);
      expect(decoded.data).toEqual(fixture.expectedData);
    });
  }
});

// ── Privacy / safety ──────────────────────────────────────────────────────────

describe("Privacy and safety", () => {
  it("error messages never contain raw event data payloads", () => {
    const secretAddress = "GDSECRETADDRESSTHATSHOULDNOTLEAK1234567890ABCDEF";
    const raw: RawContractEvent = {
      contract: "talos_registry",
      topics: [
        { type: "symbol", value: "tls_crt" },
        { type: "u32", value: 1 }, // wrong type → will fail
      ],
      data: [
        { type: "address", value: secretAddress },
      ],
      ledger_sequence: 1,
    };
    try {
      decodeContractEvent(raw);
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = String(err);
      expect(msg).not.toContain(secretAddress);
    }
  });

  it("decoded events never contain fields beyond catalog definitions", () => {
    const decoded = decodeContractEvent(TLS_CRT_RAW);
    const topicKeys = Object.keys(decoded.topics);
    const dataKeys = Object.keys(decoded.data);

    // Only catalog-defined fields should appear
    expect(topicKeys).toEqual(["event", "creator"]);
    expect(dataKeys).toEqual(["talos_id", "name", "category"]);
  });
});

// ── Custom catalog ────────────────────────────────────────────────────────────

describe("Custom catalog support", () => {
  it("decodes events against a user-provided catalog", () => {
    const customCatalog = {
      creation: {},
      update: {},
      governance: {},
      payment: {
        custom_evt: {
          contract: "my_contract",
          topics: [
            { position: 0, type: "symbol", name: "event" },
          ],
          data: [
            { position: 0, type: "u32", name: "count" },
          ],
        },
      },
    };

    const raw: RawContractEvent = {
      contract: "my_contract",
      topics: [{ type: "symbol", value: "custom_evt" }],
      data: [{ type: "u32", value: 42 }],
      ledger_sequence: 5,
    };

    const decoded = decodeContractEvent(raw, { catalog: customCatalog });
    expect(decoded.event).toBe("custom_evt");
    expect(decoded.family).toBe("payment");
    expect(decoded.data).toEqual({ count: 42 });
  });

  it("unknown symbol in custom catalog throws UnknownContractEventError", () => {
    const customCatalog = {
      creation: {},
      update: {},
      governance: {},
      payment: {},
    };

    expect(() =>
      decodeContractEvent(TLS_CRT_RAW, { catalog: customCatalog }),
    ).toThrow(UnknownContractEventError);
  });
});

// ── Switch narrowing (compile-time correctness) ───────────────────────────────

describe("Discriminated union switch narrowing", () => {
  it("allows exhaustive switch on all nine event types", () => {
    const allRaws = [
      TLS_CRT_RAW,
      TLS_CRT2_RAW,
      PAT_UPD_RAW,
      REG_UPD_RAW,
      PROP_CRT_RAW,
      VOTE_RAW,
      PROP_STAT_RAW,
      EP_CMT_RAW,
      DIV_CLM_RAW,
    ];

    for (const raw of allRaws) {
      const decoded = decodeContractEvent(raw);
      let matched = false;

      switch (decoded.event) {
        case "tls_crt":
          matched = typeof decoded.data.talos_id === "number";
          break;
        case "tls_crt2":
          matched = typeof decoded.data.version === "number";
          break;
        case "pat_upd":
          matched = typeof decoded.data.creator_share === "number";
          break;
        case "reg_upd":
          matched = typeof decoded.data.old_registry === "string";
          break;
        case "prop_crt":
          matched = typeof decoded.data.proposer === "string";
          break;
        case "vote":
          matched = typeof decoded.data.choice === "string";
          break;
        case "prop_stat":
          matched = typeof decoded.data.status === "string";
          break;
        case "ep_cmt":
          matched = typeof decoded.data.epoch_id === "number";
          break;
        case "div_clm":
          matched = typeof decoded.data.role === "string";
          break;
      }

      expect(matched).toBe(true);
    }
  });
});
