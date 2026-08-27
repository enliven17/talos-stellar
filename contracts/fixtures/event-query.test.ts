/**
 * Tests for the bounded event-query fixtures and helper (issue #423).
 *
 * Validates:
 *   - fixture document parsing (spec, bounds, catalog)
 *   - one end-to-end decode per event family (creation, update, governance, payment)
 *   - empty ranges return zero events
 *   - malformed payloads are rejected
 *   - unbounded ledger ranges and page sizes are rejected
 */
import { describe, it, expect } from "vitest";
import raw from "./event_fixtures.json";
import {
  parseFixtureSet,
  parseEventFixture,
  queryEvents,
  validateQuery,
  isRangeEmpty,
  EventQueryError,
  UnboundedRangeError,
  UnboundedPageSizeError,
  MalformedEventError,
  UnknownEventError,
  type EventFixture,
  type FixtureSet,
} from "./event-query";

const set: FixtureSet = parseFixtureSet(raw);

describe("fixture document parsing", () => {
  it("is a versioned talos-event-fixtures document", () => {
    expect(set.format).toBe("talos-event-fixtures");
    expect(typeof set.spec_version).toBe("string");
    expect(set.spec_version.length).toBeGreaterThan(0);
  });

  it("defines bounded query limits", () => {
    expect(set.bounds.min_page_size).toBeGreaterThanOrEqual(1);
    expect(set.bounds.max_page_size).toBeGreaterThanOrEqual(set.bounds.min_page_size);
    expect(set.bounds.max_ledger_span).toBeGreaterThan(0);
  });

  it("has a catalog covering all four event families", () => {
    expect(Object.keys(set.event_catalog).sort()).toEqual([
      "creation",
      "governance",
      "payment",
      "update",
    ]);
    expect(set.event_catalog.creation.tls_crt).toBeDefined();
    expect(set.event_catalog.update.pat_upd).toBeDefined();
    expect(set.event_catalog.governance.prop_crt).toBeDefined();
    expect(set.event_catalog.payment.ep_cmt).toBeDefined();
  });

  it("every normal fixture parses against the catalog", () => {
    expect(set.fixtures.length).toBeGreaterThan(0);
    for (const fixture of set.fixtures) {
      const parsed = parseEventFixture(fixture, set);
      expect(parsed.event).toBe(fixture.event);
      expect(parsed.decoded.contract).toBe(fixture.contract);
    }
  });

  it("rejects a non-versioned document", () => {
    expect(() => parseFixtureSet({ format: "nope" })).toThrow(MalformedEventError);
  });

  it("rejects an unknown event family in the catalog", () => {
    const bad = {
      ...raw,
      event_catalog: { ...raw.event_catalog, nonsense: {} },
    };
    expect(() => parseFixtureSet(bad)).toThrow(MalformedEventError);
  });

  it("rejects missing bounds", () => {
    const { bounds: _bounds, ...withoutBounds } = raw;
    expect(() => parseFixtureSet(withoutBounds)).toThrow(MalformedEventError);
  });
});

describe("end-to-end decode per event family", () => {
  function decode(id: string): EventFixture {
    const fixture = set.fixtures.find((f) => f.id === id);
    expect(fixture).toBeDefined();
    return parseEventFixture(fixture, set);
  }

  it("decodes a creation event (tls_crt)", () => {
    const parsed = decode("creation.tls_crt.normal");
    expect(parsed.family).toBe("creation");
    expect(parsed.decoded).toEqual({
      event: "tls_crt",
      contract: "talos_registry",
      ledger_sequence: 100000,
      topics: {
        event: "tls_crt",
        creator: "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ",
      },
      data: { talos_id: 1, name: "Genesis", category: "Marketing" },
    });
  });

  it("decodes an update event (pat_upd)", () => {
    const parsed = decode("update.pat_upd.normal");
    expect(parsed.family).toBe("update");
    expect(parsed.decoded.data).toEqual({
      creator_addr: "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ",
      creator_share: 5000,
      investor_share: 3000,
    });
  });

  it("decodes a governance event (prop_crt)", () => {
    const parsed = decode("governance.prop_crt.normal");
    expect(parsed.family).toBe("governance");
    expect(parsed.decoded.topics).toEqual({ event: "prop_crt", proposal_id: 7 });
    expect(parsed.decoded.data).toEqual({
      talos_id: 1,
      proposer: "GDURVWHBP27CFBLJKVI2UISXSQU52MJABOJWVFKJKFYWDC6E6GDOTIFW",
    });
  });

  it("decodes a payment event (div_clm)", () => {
    const parsed = decode("payment.div_clm.normal");
    expect(parsed.family).toBe("payment");
    expect(parsed.decoded.topics).toEqual({
      event: "div_clm",
      epoch_id: 42,
      patron: "GBUC4RLWOMRLPAIL4UZPB3MZYHVMMCC2UUEOVJ4DCFVHWHHRT7WY4F33",
    });
    expect(parsed.decoded.data).toEqual({
      talos_id: 1,
      amount: 600000,
      role: "Creator",
    });
  });
});

describe("bounded querying", () => {
  it("returns events within inclusive ledger bounds", () => {
    const result = queryEvents(set, {
      fromLedger: 100000,
      toLedger: 100020,
      pageSize: 10,
    });
    expect(result.total).toBe(3);
    expect(result.events.map((e) => e.event).sort()).toEqual(["pat_upd", "reg_upd", "tls_crt"]);
  });

  it("treats ledger bounds as inclusive on both ends", () => {
    const single = queryEvents(set, {
      fromLedger: 100010,
      toLedger: 100010,
      pageSize: 10,
    });
    expect(single.total).toBe(1);
    expect(single.events[0].event).toBe("pat_upd");
  });

  it("filters by topic (topic[0] symbol)", () => {
    const result = queryEvents(set, {
      topic: "div_clm",
      fromLedger: 100000,
      toLedger: 100300,
      pageSize: 10,
    });
    expect(result.total).toBe(1);
    expect(result.events[0].id).toBe("payment.div_clm.normal");
  });

  it("filters by contract", () => {
    const result = queryEvents(set, {
      contract: "talos_governance",
      fromLedger: 100000,
      toLedger: 100300,
      pageSize: 10,
    });
    expect(result.total).toBe(3);
  });

  it("paginates with a bounded page size", () => {
    const page1 = queryEvents(set, { fromLedger: 100000, toLedger: 100300, pageSize: 3 });
    const page2 = queryEvents(set, { fromLedger: 100000, toLedger: 100300, pageSize: 3, page: 2 });
    expect(page1.events).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page2.events).toHaveLength(3);
    expect(page2.page).toBe(2);
  });

  it("returns an empty page for an empty range", () => {
    const result = queryEvents(set, {
      topic: "div_clm",
      fromLedger: 999000,
      toLedger: 999999,
      pageSize: 100,
    });
    expect(result.total).toBe(0);
    expect(result.events).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("declares every empty-range fixture as empty", () => {
    for (const range of set.empty_ranges) {
      expect(
        isRangeEmpty(set, {
          topic: range.topic,
          contract: range.contract,
          start_ledger: range.start_ledger,
          end_ledger: range.end_ledger,
        }),
      ).toBe(true);
    }
  });
});

describe("query bounds enforcement", () => {
  it("rejects a missing ledger range (unbounded range)", () => {
    expect(() => queryEvents(set, { pageSize: 10 })).toThrow(UnboundedRangeError);
    expect(() => queryEvents(set, { fromLedger: 1, pageSize: 10 })).toThrow(UnboundedRangeError);
    expect(() => queryEvents(set, { toLedger: 100, pageSize: 10 })).toThrow(UnboundedRangeError);
  });

  it("rejects a missing page size (unbounded page size)", () => {
    expect(() => queryEvents(set, { fromLedger: 1, toLedger: 100 })).toThrow(UnboundedPageSizeError);
  });

  it("rejects a zero or negative page size", () => {
    expect(() => queryEvents(set, { fromLedger: 1, toLedger: 100, pageSize: 0 })).toThrow(EventQueryError);
    expect(() => queryEvents(set, { fromLedger: 1, toLedger: 100, pageSize: -5 })).toThrow(EventQueryError);
  });

  it("rejects a page size larger than the max bound", () => {
    expect(() => queryEvents(set, { fromLedger: 1, toLedger: 100, pageSize: 1000 })).toThrow(
      EventQueryError,
    );
  });

  it("rejects an inverted range (fromLedger > toLedger)", () => {
    expect(() => queryEvents(set, { fromLedger: 200, toLedger: 100, pageSize: 10 })).toThrow(
      EventQueryError,
    );
  });

  it("rejects a range whose span exceeds max_ledger_span", () => {
    const max = set.bounds.max_ledger_span;
    expect(() =>
      queryEvents(set, { fromLedger: 0, toLedger: max, pageSize: 10 }),
    ).toThrow(EventQueryError);
    // Exactly the max span is allowed.
    expect(() =>
      queryEvents(set, { fromLedger: 0, toLedger: max - 1, pageSize: 10 }),
    ).not.toThrow();
  });

  it("rejects a non-positive page number", () => {
    expect(() => queryEvents(set, { fromLedger: 1, toLedger: 100, pageSize: 10, page: 0 })).toThrow(
      EventQueryError,
    );
  });
});

describe("malformed payloads", () => {
  it("fixture file declares malformed cases", () => {
    expect(set.malformed.length).toBeGreaterThan(0);
    for (const malformed of set.malformed) {
      expect(malformed.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects a fixture with no topics", () => {
    const fixture = set.malformed.find((m) => m.id === "malformed.no_topics");
    expect(fixture).toBeDefined();
    expect(() => parseEventFixture(fixture!.fixture, set)).toThrow(MalformedEventError);
  });

  it("rejects a fixture whose topic[0] is not a symbol", () => {
    const fixture = set.malformed.find((m) => m.id === "malformed.topic0_not_symbol");
    expect(() => parseEventFixture(fixture!.fixture, set)).toThrow(MalformedEventError);
  });

  it("rejects a fixture with mismatched topic types", () => {
    const fixture = set.malformed.find((m) => m.id === "malformed.topic_mismatch");
    expect(() => parseEventFixture(fixture!.fixture, set)).toThrow(MalformedEventError);
  });

  it("rejects a fixture with the wrong data arity", () => {
    const fixture = set.malformed.find((m) => m.id === "malformed.data_arity");
    expect(() => parseEventFixture(fixture!.fixture, set)).toThrow(MalformedEventError);
  });

  it("rejects a fixture with mismatched data types", () => {
    const fixture = set.malformed.find((m) => m.id === "malformed.data_type");
    expect(() => parseEventFixture(fixture!.fixture, set)).toThrow(MalformedEventError);
  });

  it("rejects an unknown event symbol", () => {
    expect(() =>
      parseEventFixture(
        {
          id: "unknown-event",
          family: "creation",
          event: "not_a_real_event",
          contract: "talos_registry",
          ledger_sequence: 1,
          topics: [{ type: "symbol", value: "not_a_real_event" }],
          data: [],
        },
        set,
      ),
    ).toThrow(UnknownEventError);
  });
});
