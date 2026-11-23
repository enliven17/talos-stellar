/**
 * Deterministic synthetic SSE fault fixtures.
 *
 * These fixtures model stream failures without network access. They are
 * intended for tests and local replay only: no production URLs or credentials
 * are used.
 */

export type EventStreamFaultKind =
  | "truncated-frame"
  | "history-gap"
  | "reconnect-race";

export interface SyntheticSSEFrame {
  id?: string;
  event?: string;
  data?: string;
  /** Raw bytes/chunks appended to the fake stream before the frame closes. */
  chunks?: readonly string[];
}

export interface EventStreamFaultFixture {
  name: string;
  kind: EventStreamFaultKind;
  description: string;
  frames: readonly SyntheticSSEFrame[];
  expectedLastEventId: string | undefined;
  expectedDeliveredIds: readonly string[];
  reconnectAfterFrames: number;
}

export const EVENT_STREAM_FAULT_FIXTURES: readonly EventStreamFaultFixture[] =
  Object.freeze([
    Object.freeze({
      name: "truncated-frame",
      kind: "truncated-frame",
      description:
        "A frame loses its final blank line, so it must not be delivered as a complete event.",
      frames: Object.freeze([
        Object.freeze({
          chunks: Object.freeze([
            "id: evt-100\n",
            'event: job.created\ndata: {"jobId":"job-synthetic"}',
          ]),
        }),
        Object.freeze({
          id: "evt-101",
          event: "job.completed",
          data: '{"jobId":"job-synthetic","status":"completed"}',
        }),
      ]),
      expectedLastEventId: "evt-101",
      expectedDeliveredIds: Object.freeze(["evt-101"]),
      reconnectAfterFrames: 1,
    }),
    Object.freeze({
      name: "history-gap",
      kind: "history-gap",
      description:
        "The stream advances from evt-100 to evt-102, exposing a missing evt-101 history window.",
      frames: Object.freeze([
        Object.freeze({ id: "evt-100", event: "job.created", data: '{"percent":10}' }),
        Object.freeze({ id: "evt-102", event: "job.completed", data: '{"percent":100}' }),
      ]),
      expectedLastEventId: "evt-102",
      expectedDeliveredIds: Object.freeze(["evt-100", "evt-102"]),
      reconnectAfterFrames: 2,
    }),
    Object.freeze({
      name: "reconnect-race",
      kind: "reconnect-race",
      description:
        "Reconnect replay returns an already-seen event followed by one new event.",
      frames: Object.freeze([
        Object.freeze({ id: "evt-200", event: "job.progress", data: '{"percent":50}' }),
        Object.freeze({ id: "evt-200", event: "job.progress", data: '{"percent":50}' }),
        Object.freeze({ id: "evt-201", event: "job.completed", data: '{"percent":100}' }),
      ]),
      expectedLastEventId: "evt-201",
      expectedDeliveredIds: Object.freeze(["evt-200", "evt-201"]),
      reconnectAfterFrames: 1,
    }),
  ]);

export function getEventStreamFaultFixture(
  name: string,
): EventStreamFaultFixture | undefined {
  return EVENT_STREAM_FAULT_FIXTURES.find((fixture) => fixture.name === name);
}

export function encodeSyntheticSSEFrame(frame: SyntheticSSEFrame): string {
  if (frame.chunks) return frame.chunks.join("");
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  if (frame.data !== undefined) lines.push(`data: ${frame.data}`);
  return `${lines.join("\n")}\n\n`;
}

export interface SyntheticEventStreamTransport {
  fetch: typeof globalThis.fetch;
  getLastEventId: () => string | undefined;
  callCount: () => number;
}

/**
 * Build a local fake fetch transport for one fixture. Responses contain only
 * synthetic SSE text and make no network calls.
 */
export function createSyntheticEventStreamTransport(
  fixture: EventStreamFaultFixture,
): SyntheticEventStreamTransport {
  let callCount = 0;
  let lastEventId: string | undefined;

  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    callCount += 1;
    const headerValue =
      init?.headers instanceof Headers
        ? init.headers.get("Last-Event-ID")
        : (init?.headers as Record<string, string> | undefined)?.["Last-Event-ID"];
    if (headerValue) lastEventId = headerValue;

    const start = callCount === 1 ? 0 : fixture.reconnectAfterFrames;
    const frames = fixture.frames.slice(start);
    const text = frames.map(encodeSyntheticSSEFrame).join("");
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });

    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body,
    } as Response;
  }) as typeof globalThis.fetch;

  return {
    fetch,
    getLastEventId: () => lastEventId,
    callCount: () => callCount,
  };
}
