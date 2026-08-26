/**
 * Tests for web/src/lib/tracing.ts — see docs/TRACING.md for the design.
 *
 * Coverage: redaction never leaks secret-shaped attributes, route templating
 * collapses dynamic segments, withTraceContext creates a correctly-parented
 * span (using an in-memory OTel provider so we don't depend on Sentry being
 * configured), records status/exceptions, still applies X-Request-Id
 * correlation, and degrades to a harmless pass-through when disabled or when
 * no provider is registered at all (the default, backward-compatible state).
 */
import { NextRequest } from "next/server";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { redactAttributes, routeTemplate, withTraceContext } from "@/lib/tracing";

describe("redactAttributes", () => {
  it.each([
    "api_key",
    "apiKey",
    "API_KEY",
    "authorization",
    "Authorization",
    "secret",
    "password",
    "token",
    "private_key",
    "privateKey",
    "seed",
    "mnemonic",
    "signature",
    "x-payment",
  ])("drops secret-shaped key: %s", (key) => {
    const out = redactAttributes({ [key]: "super-secret", safe: "ok" });
    expect(out[key]).toBeUndefined();
    expect(out.safe).toBe("ok");
  });

  it("truncates long strings to 200 chars", () => {
    const out = redactAttributes({ note: "x".repeat(500) });
    expect((out.note as string).length).toBe(200);
    expect(out.note).toMatch(/\.\.\.$/);
  });

  it("preserves primitive types", () => {
    const out = redactAttributes({ count: 3, ratio: 0.5, ok: true });
    expect(out).toEqual({ count: 3, ratio: 0.5, ok: true });
  });

  it("drops null/undefined values", () => {
    const out = redactAttributes({ missing: null, present: "x" });
    expect(out.missing).toBeUndefined();
    expect(out.present).toBe("x");
  });

  it("never leaks a real-looking secret end-to-end", () => {
    const out = redactAttributes({
      to: "GABCDE...",
      apiKey: "tak_live_do_not_leak",
      authorization: "Bearer sk-do-not-leak",
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("do_not_leak");
  });
});

describe("routeTemplate", () => {
  it("collapses long id-shaped segments to :id", () => {
    expect(routeTemplate("/api/talos/019a1b2c3d4e5f60cafebabe1234")).toBe(
      "/api/talos/:id",
    );
  });

  it("leaves short, fixed route segments untouched", () => {
    expect(routeTemplate("/api/talos/abc/service")).toBe(
      "/api/talos/abc/service",
    );
    expect(routeTemplate("/api/jobs/pending")).toBe("/api/jobs/pending");
  });
});

function makeRequest(url: string, init?: { headers?: Record<string, string> }) {
  return new NextRequest(url, init ? { headers: new Headers(init.headers) } : undefined);
}

describe("withTraceContext", () => {
  const originalEnv = process.env.TRACE_CONTEXT_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.TRACE_CONTEXT_ENABLED;
    else process.env.TRACE_CONTEXT_ENABLED = originalEnv;
    vi.restoreAllMocks();
  });

  it("passes requests through unchanged when disabled", async () => {
    process.env.TRACE_CONTEXT_ENABLED = "false";
    const handler = vi.fn(async (_req: NextRequest) => Response.json({ ok: true }));
    const wrapped = withTraceContext(handler);

    const res = await wrapped(makeRequest("http://test.local/api/talos/abc"));

    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    // withRequestId still runs underneath — correlation is independent of tracing.
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("is a safe no-op with no TracerProvider registered (default state)", async () => {
    delete process.env.TRACE_CONTEXT_ENABLED;
    const handler = vi.fn(async (_req: NextRequest) => Response.json({ ok: true }));
    const wrapped = withTraceContext(handler);

    const res = await wrapped(makeRequest("http://test.local/api/talos/abc"));

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("propagates non-2xx/5xx handler responses and params/context args unchanged", async () => {
    const handler = vi.fn(
      async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
        const { id } = await ctx.params;
        return Response.json({ error: "not found", id }, { status: 404 });
      },
    );
    const wrapped = withTraceContext(handler);

    const res = await wrapped(
      makeRequest("http://test.local/api/talos/missing-id"),
      { params: Promise.resolve({ id: "missing-id" }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.id).toBe("missing-id");
  });
});

describe("withTraceContext with a real (in-memory) provider", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterEach(async () => {
    exporter.reset();
    await provider.shutdown();
    // OpenTelemetry's global TracerProvider can only be set once per
    // process without a disable/reset call — undo our registration so
    // later test files (and other describe blocks above) see the
    // no-op default again.
    trace.disable();
  });

  it("creates a server span named after the method + templated route", async () => {
    const handler = vi.fn(async (_req: NextRequest) => Response.json({ ok: true }));
    const wrapped = withTraceContext(handler);

    await wrapped(
      makeRequest("http://test.local/api/talos/abcdefghijklmnop/service"),
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("http.server GET /api/talos/:id/service");
    expect(spans[0].attributes["http.response.status_code"]).toBe(200);
  });

  it("never sets an incoming Authorization header as a span attribute", async () => {
    const handler = vi.fn(async (_req: NextRequest) => Response.json({ ok: true }));
    const wrapped = withTraceContext(handler);

    await wrapped(
      makeRequest("http://test.local/api/talos/abc/transfer", {
        headers: { authorization: "Bearer tak_super_secret_value" },
      }),
    );

    const [span] = exporter.getFinishedSpans();
    expect(JSON.stringify(span.attributes)).not.toContain(
      "tak_super_secret_value",
    );
  });

  it("records an ERROR status and the exception when the handler throws", async () => {
    const handler = vi.fn(async (_req: NextRequest) => {
      throw new Error("boom");
    });
    const wrapped = withTraceContext(handler);

    await expect(
      wrapped(makeRequest("http://test.local/api/talos/abc/transfer")),
    ).rejects.toThrow("boom");

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("nests the span under an incoming traceparent so agent and web traces correlate", async () => {
    const handler = vi.fn(async (_req: NextRequest) => Response.json({ ok: true }));
    const wrapped = withTraceContext(handler);

    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentSpanId = "00f067aa0ba902b7";

    await wrapped(
      makeRequest("http://test.local/api/talos/abc/transfer", {
        headers: { traceparent: `00-${traceId}-${parentSpanId}-01` },
      }),
    );

    const [span] = exporter.getFinishedSpans();
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.parentSpanId).toBe(parentSpanId);
  });
});
