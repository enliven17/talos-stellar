import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_STREAM_FAULT_FIXTURES,
  createSyntheticEventStreamTransport,
  encodeSyntheticSSEFrame,
  getEventStreamFaultFixture,
} from "../src/event-stream-fixtures.js";
import {
  InMemorySeenStore,
  TalosEventStream,
  type TalosStreamEvent,
} from "../src/events.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("synthetic event-stream fault fixtures", () => {
  it("provides deterministic names and independent immutable definitions", () => {
    expect(EVENT_STREAM_FAULT_FIXTURES.map((fixture) => fixture.name)).toEqual([
      "truncated-frame",
      "history-gap",
      "reconnect-race",
    ]);
    expect(getEventStreamFaultFixture("history-gap")?.kind).toBe("history-gap");
    expect(getEventStreamFaultFixture("unknown")).toBeUndefined();
  });

  it("models a truncated frame without delivering the incomplete event", async () => {
    const fixture = getEventStreamFaultFixture("truncated-frame")!;
    const transport = createSyntheticEventStreamTransport(fixture);
    const stream = new TalosEventStream("http://synthetic.invalid", {
      fetch: transport.fetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      baseReconnectDelayMs: 0,
      jitter: false,
    });
    const received: TalosStreamEvent[] = [];
    stream.on("event", (event) => received.push(event));

    stream.connect();
    await vi.runAllTimersAsync();

    expect(received.map((event) => event.id)).toEqual(["evt-101"]);
    expect(encodeSyntheticSSEFrame(fixture.frames[0])).not.toContain("\n\n");
  });

  it("exposes history gaps as a detectable numeric ID boundary", () => {
    const fixture = getEventStreamFaultFixture("history-gap")!;
    const ids = fixture.frames.map((frame) => Number(frame.id?.replace("evt-", "")));
    expect(ids).toEqual([100, 102]);
    expect(ids[1] - ids[0]).toBe(2);
  });

  it("deduplicates reconnect replay and sends the last event ID", async () => {
    const fixture = getEventStreamFaultFixture("reconnect-race")!;
    const transport = createSyntheticEventStreamTransport(fixture);
    const stream = new TalosEventStream("http://synthetic.invalid", {
      fetch: transport.fetch,
      seenStore: new InMemorySeenStore(),
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });
    const received: TalosStreamEvent[] = [];
    stream.on("event", (event) => received.push(event));

    stream.connect();
    await vi.runAllTimersAsync();

    expect(received.map((event) => event.id)).toEqual(["evt-200", "evt-201"]);
    expect(transport.callCount()).toBeGreaterThanOrEqual(2);
    expect(transport.getLastEventId()).toBe("evt-201");
  });
});
