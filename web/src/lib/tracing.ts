/**
 * Web-side half of end-to-end tracing (see docs/TRACING.md). Extracts a W3C
 * traceparent/tracestate from the agent's request and runs the route
 * handler inside that context, then starts a child server span via
 * @opentelemetry/api. Uses whatever TracerProvider is already globally
 * registered (Sentry's, when SENTRY_DSN is configured) — no separate
 * exporter/provider is stood up here. With no provider registered this is a
 * harmless no-op: spans resolve against the default no-op tracer.
 */
import { NextRequest } from "next/server";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { withRequestId } from "./with-request-id";

const TRACER_NAME = "talos-web";

const SECRET_KEY_PATTERN =
  /(api[_-]?key|apikey|authorization|secret|password|token|private[_-]?key|seed|mnemonic|signature|x-payment)/i;
const MAX_ATTR_LEN = 200;

function safeStr(value: unknown, maxLen = MAX_ATTR_LEN): string {
  const s = String(value);
  return s.length > maxLen ? `${s.slice(0, maxLen - 3)}...` : s;
}

/**
 * Deny-by-key redaction for span attributes — mirrors
 * talos_agent.tracing.redact_attributes on the agent side (see
 * docs/TRACING.md#redaction). Never pass raw request/response bodies
 * through this; it truncates/type-filters, it doesn't summarize payloads.
 */
export function redactAttributes(
  attributes: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value
        .slice(0, 20)
        .map((v) => safeStr(v, 64))
        .join(",");
    } else {
      out[key] = safeStr(value);
    }
  }
  return out;
}

/**
 * Collapse dynamic path segments (ids, uuids, api keys) to ":id" so route
 * spans don't leak entity identifiers and don't create unbounded
 * cardinality on a tracing/metrics backend.
 */
export function routeTemplate(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (/^[0-9a-zA-Z_-]{16,}$/.test(seg) ? ":id" : seg))
    .join("/");
}

function isEnabled(): boolean {
  return process.env.TRACE_CONTEXT_ENABLED !== "false";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRouteHandler = (req: NextRequest, ...rest: any[]) => Promise<Response>;

/**
 * Wrap a Next.js route handler so it: (1) extracts traceparent/tracestate
 * from the incoming request and runs inside that context, (2) starts a
 * `http.server <METHOD> <route>` child span around the handler, redacting
 * attributes and recording status/exceptions, (3) still applies
 * withRequestId's existing X-Request-Id correlation (see
 * OBSERVABILITY.md) — composed rather than duplicated.
 *
 * Default-on (TRACE_CONTEXT_ENABLED=false to disable) because, absent a
 * registered TracerProvider, every OpenTelemetry API call here resolves
 * against the global no-op tracer — there is nothing to roll back.
 */
export function withTraceContext<H extends AnyRouteHandler>(handler: H): H {
  const traced = (async (req: NextRequest, ...rest: unknown[]) => {
    if (!isEnabled()) {
      return handler(req, ...rest);
    }

    const carrier: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      carrier[key] = value;
    });
    const parentContext = propagation.extract(context.active(), carrier);

    const method = req.method;
    const route = routeTemplate(new URL(req.url).pathname);
    const tracer = trace.getTracer(TRACER_NAME);

    return context.with(parentContext, () =>
      tracer.startActiveSpan(
        `http.server ${method} ${route}`,
        {
          kind: SpanKind.SERVER,
          attributes: redactAttributes({
            "http.request.method": method,
            "url.route": route,
          }),
        },
        async (span) => {
          try {
            const res = await handler(req, ...rest);
            span.setAttribute("http.response.status_code", res.status);
            span.setStatus({
              code:
                res.status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
            });
            return res;
          } catch (err) {
            span.recordException(
              err instanceof Error ? err : new Error(safeStr(err)),
            );
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: safeStr(err, 300),
            });
            throw err;
          } finally {
            span.end();
          }
        },
      ),
    );
  }) as AnyRouteHandler;

  return withRequestId(traced) as H;
}
