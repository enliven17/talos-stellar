# End-to-End Tracing (OpenTelemetry)

Design and operator reference for distributed tracing across the Prime Agent
(`packages/prime-agent`) and Talos Web (`web`). Implements
[#232](https://github.com/enliven17/talos-stellar/issues/232).

## Goals

Make one agent cycle — scheduler tick → LLM call → tool call → Web API call
→ Stellar/Horizon operation → fulfillment — inspectable as a single causal
trace, without changing existing behavior when tracing is off (the default).

## Non-goals

- Replacing Sentry error tracking (`OBSERVABILITY.md`) — tracing is additive.
- Tracing inside the Soroban contracts themselves (`contracts/`) — out of
  scope per the issue; on-chain calls are traced only at the client boundary
  (the Horizon/RPC request the agent or web makes).
- A second, independently-exported OTel pipeline on the web side that
  competes with Sentry's own OpenTelemetry provider (see
  [Web-side tracing](#web-side-tracing) and Known Limitations).

## Architecture overview

```
 agent_cycle_task (scheduler.py)
   └─ span: agent.cycle                         [root, new trace per cycle]
        └─ span: llm.chat_completion             (per ReAct iteration)
        └─ span: tool.<name>                     (ToolRegistry.execute)
             └─ span: web_api.<METHOD> <path>     (TalosAPIClient._request)
                  │   traceparent header injected on the outgoing request
                  ▼
             [ Talos Web /api/... route ]
               └─ span: http.server <METHOD> <route>   (withTraceContext)
                    traceparent extracted from the incoming request
                    └─ downstream: Stellar signing (lib/stellar.ts),
                       x402 settlement (lib/stellar-x402.ts),
                       fulfillment handler (lib/fulfillment/*)
        └─ span: stellar.horizon.<op>            (StellarKit — direct Horizon reads)
```

Each *scheduled* unit of work (an agent cycle, a poll, a heartbeat, a
dividend check, a loan-repayment pass) is its own root span / trace. These
are independent, causally-unrelated invocations, so forcing them into one
giant trace would be misleading and would also defeat sampling. What's
preserved *within* one unit of work is the full causal chain across async
boundaries and the process boundary (agent → web).

## Trace context propagation

- **Within the agent process**: OpenTelemetry's default context propagation
  uses Python `contextvars`, which `asyncio` tasks inherit at creation time.
  Each scheduler task (`agent_cycle_task`, `polling_task`, ...) starts a
  fresh root span at the top of its loop body — the span is attached in the
  current task's context, so every `await` inside that iteration (LLM call,
  tool call, HTTP call) sees it as the active span/parent, since it all runs
  in the same `asyncio.Task`. Nothing was already doing cross-task context
  hand-off, so this doesn't have to invent anything for the existing
  `agent_lock`-serialized tasks.
- **Agent → Web (process boundary)**: `TalosAPIClient` injects the current
  span's W3C `traceparent` (and `tracestate`) into every outgoing request via
  `opentelemetry.propagate.inject()`, the same mechanism already used to
  propagate `cycle_id` as `X-Request-Id` (`api_client.py:set_request_id`).
  Both headers are sent; `X-Request-Id`/`cycle_id` keeps working unchanged
  for log correlation exactly as documented in `OBSERVABILITY.md`.
- **Web (process boundary → route handler)**: `web/src/lib/tracing.ts`
  extracts `traceparent`/`tracestate` from the incoming request and runs the
  route handler inside that extracted context (`context.with(...)`), so any
  span started during the handler — including Sentry's own automatic spans —
  is parented under the agent's trace instead of starting a new one.

## Span taxonomy

| Span name | Where | Kind | Key attributes |
|---|---|---|---|
| `agent.cycle` | `scheduler.py` (root, per scheduled task run) | INTERNAL | `talos.id`, `talos.name`, `agent.task` (`agent_cycle`/`polling`/`heartbeat`/...), `agent.cycle_id` |
| `llm.chat_completion` | `agent/loop.py` | CLIENT | `llm.model`, `llm.iteration`, `llm.tool_count`, `llm.finish_reason` |
| `tool.<name>` | `tools/registry.py` (`ToolRegistry.execute`) | INTERNAL | `tool.name`, `tool.arg_keys`, `tool.error_type` (on failure) |
| `web_api.<METHOD> <path>` | `api_client.py` (`TalosAPIClient._request`) | CLIENT | `http.request.method`, `url.path` (no query string), `http.response.status_code`, `http.retry.count` |
| `stellar.horizon.<op>` | `payments/stellar_kit.py` | CLIENT | `stellar.operation` (`get_account`), `http.response.status_code` |
| `http.server <METHOD> <route>` | `web/src/lib/tracing.ts`, applied to agent-facing routes | SERVER | `http.request.method`, `url.route`, `http.response.status_code` |

Span names never contain user- or agent-supplied values (account IDs, tool
arguments, URLs with query strings) — only the fixed route/tool/operation
identifier. Variable data goes into attributes, and only after redaction
(below).

## Redaction

Two independent, small allowlist-based redaction helpers exist (one per
language — there is no shared runtime between the Python agent and the
Next.js web app, so duplicating ~20 lines of policy is preferable to adding a
cross-language dependency):

- Python: `talos_agent/tracing.py::redact_attributes` / `safe_str`
- TypeScript: `web/src/lib/tracing.ts::redactAttributes`

Both apply the same policy:

1. **Deny-by-key**: any attribute key matching a secret pattern (`api_key`,
   `apikey`, `authorization`, `secret`, `password`, `token`, `private_key`,
   `seed`, `mnemonic`, `signature`, `x-payment`) is dropped, not masked —
   masking risks leaking partial secrets, dropping doesn't.
2. **No raw payloads**: request/response bodies, LLM message content, and
   full tool-call arguments are never set as span attributes. Only
   structural facts are recorded (arg *keys*, not values; body byte length,
   not content; a truncated `safe_str` for the handful of attributes where a
   short value is genuinely useful, e.g. a tool name or HTTP path).
3. **Truncation**: any string attribute that does pass the allowlist is
   truncated to 200 characters.
4. **Headers are never bulk-copied onto spans.** Only specific, known-safe
   header-derived facts (e.g. status code, retry count) become attributes.

This mirrors the existing `maskApiKey` pattern in
`web/src/app/api/talos/[id]/route.ts` and the "no secrets/user payloads" bar
already set by `OBSERVABILITY.md` for structured logs.

## Sampling

- Sampler: `ParentBased(TraceIdRatioBased(ratio))` on both sides — a sampled
  parent always keeps its children sampled; an unsampled parent is
  respected rather than re-rolled, so a trace is never partially exported in
  a way that looks like data loss.
- Ratio is configurable (`OTEL_TRACES_SAMPLER_ARG`, default `1.0` once
  tracing is explicitly enabled — agent-cycle volume is low, typically one
  cycle per `AGENT_CYCLE_INTERVAL` seconds per Talos, so full sampling is
  cheap; operators running many agents can lower the ratio).
- Sampling only takes effect once tracing is enabled at all (see Rollout) —
  the ratio knob does not need its own separate "off" state.

## Async boundaries

- `asyncio.create_task` inherits the creating task's `contextvars` snapshot
  at creation time, which is exactly how OTel's default context storage
  works — no extra plumbing needed for the scheduler's task-per-loop model.
- Detached/fire-and-forget work (e.g. `activity_flush_task` draining
  `db.get_pending_activities()`) intentionally starts its own root span per
  flush rather than trying to re-attach to the span of whichever tool call
  originally queued the activity — that queue is durable (SQLite-backed) and
  flushes are batched, so a single flush can contain activities from
  multiple, already-finished cycles. Attributing a flush span to one
  arbitrary origin cycle would be misleading.
- `run_multi()` runs several agents concurrently in one process
  (`asyncio.gather`). Tracer/meter initialization
  (`tracing.configure_tracing()`) is idempotent and guarded by a
  module-level flag so concurrent `run()` calls don't double-register a
  global `TracerProvider`; per-cycle spans still carry `talos.id` as an
  attribute so traces from different agents sharing the process are
  distinguishable in the backend even though they share one `Resource`.

## Exporter configuration

### Agent (`packages/prime-agent`)

Standard OpenTelemetry environment variables, read directly by the SDK/our
`tracing.py` (not proxied through `pydantic_settings.Settings`, so any
OTel-aware tooling that already knows these names keeps working unmodified):

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_ENABLED` | `false` | Master switch. Everything below is a no-op until this is `true`. |
| `OTEL_TRACES_EXPORTER` | `otlp` | `otlp` or `console` (prints spans to stdout — no collector needed, see Local verification). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | e.g. `http://localhost:4318` for a local Jaeger/Grafana Tempo/collector. Required when `OTEL_TRACES_EXPORTER=otlp`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `key1=value1,key2=value2` — for auth'd collectors (Honeycomb, Grafana Cloud, etc). |
| `OTEL_SERVICE_NAME` | `talos-agent` | Resource `service.name`. |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | Sampling ratio, `0.0`–`1.0`. |
| `OTEL_METRICS_ENABLED` | `false` | Independent switch for the metrics pipeline (histograms/counters below). |

### Web (`web`)

Web-side tracing rides on the OpenTelemetry `TracerProvider` that
`@sentry/nextjs` already registers globally when `SENTRY_DSN` /
`NEXT_PUBLIC_SENTRY_DSN` is set (Sentry's Next.js SDK is OTel-based
internally as of the v8/v9 line already pinned in `web/package.json`). No
new exporter or provider is introduced on the web side in this iteration —
see Known Limitations for what that does and doesn't cover.

| Variable | Default | Purpose |
|---|---|---|
| `TRACE_CONTEXT_ENABLED` | `true` | Extract/propagate `traceparent` and start route spans. Independent of Sentry being configured — with no provider registered this is a documented, harmless no-op (see Known Limitations), so it defaults on. |

## Correlation with existing request IDs

`OBSERVABILITY.md` already documents `cycle_id` ↔ `X-Request-Id` log
correlation. Tracing adds a second, complementary axis:

- Structured logs (`structlog` on the agent, `pino` on web) gain `trace_id`
  and `span_id` fields whenever a span is active, via a log processor that
  reads `opentelemetry.trace.get_current_span()`. When tracing is disabled,
  `get_current_span()` returns a non-recording span and the fields are
  simply omitted — no log shape change for anyone not opted in.
- `cycle_id` is *also* set as the `agent.cycle_id` span attribute, so an
  operator can pivot from an old-style log search (`cycle_id=...`) straight
  into the trace, or vice versa.

## Persistence / migration analysis

**No database schema change and no migration.** Traces are transient,
exported to whatever OTLP-compatible backend the operator points
`OTEL_EXPORTER_OTLP_ENDPOINT` at (or printed to stdout for local dev); they
are not queried through the Talos Web API or stored in Postgres. The only
persisted artifacts are the `trace_id`/`span_id` strings that already ride
along inside structured log lines wherever they're captured (Railway/Vercel
log drains), which needs no new storage. This keeps the feature backward
compatible by construction: nothing in `web/drizzle/*` or `LocalDB`'s SQLite
schema changes, so there is nothing to roll back at the data layer.

## Rollout & rollback

- **Default state is off.** Agent: `OTEL_ENABLED` unset/`false` → SDK
  initializes a `NoOpTracerProvider`/`NoOpMeterProvider` equivalent (SDK
  installed but nothing is exported, no network calls attempted, near-zero
  overhead). Web: with no `SENTRY_DSN` configured (or Sentry's own
  `tracesSampleRate` at its current `0.1`), `withTraceContext` still runs
  but every span call resolves against the global no-op tracer.
- **Enabling**: set `OTEL_ENABLED=true` plus an exporter target
  (`OTEL_TRACES_EXPORTER=console` for a local dry run, or
  `OTEL_EXPORTER_OTLP_ENDPOINT=...` for a real collector) on the agent; no
  action needed on web beyond having Sentry already configured (existing
  production posture).
  Restart the agent process to pick up env changes (standard `pydantic`/env
  var behavior already true of every other setting in `config.py`).
- **Rolling back**: unset `OTEL_ENABLED` (or set it back to `false`) and
  restart. There is no data-layer state to reverse (see Persistence above).
  If a misbehaving collector endpoint ever caused elevated latency, the
  `BatchSpanProcessor`'s export path is fully decoupled from the request
  path (batched + backgrounded, bounded queue, dropped spans on overflow
  rather than backpressure into the agent loop) — but the immediate lever is
  still `OTEL_ENABLED=false`.
- **Graceful shutdown**: the existing SIGINT/SIGTERM handling in
  `scheduler.py::run()` now also flushes the span/metric processors
  (`tracer_provider.shutdown()`/`force_flush()`) in the same `finally:`
  block that already closes the browser, API client, and DB — so a clean
  shutdown doesn't lose the last batch of buffered spans. An unclean crash
  (`kill -9`, OOM) can still lose whatever was buffered and not yet
  exported; this is the same trade-off every batched exporter makes and is
  called out explicitly rather than solved with synchronous export (which
  would put a network call on the critical path of every agent cycle).

## Metrics

Bounded, pre-declared instrument set (agent side; `talos_agent/metrics.py`),
exported via the same OTLP pipeline when `OTEL_METRICS_ENABLED=true`:

| Instrument | Type | Attributes |
|---|---|---|
| `talos_agent_cycle_duration_seconds` | Histogram | `agent.task`, `outcome` |
| `talos_agent_cycle_total` | Counter | `agent.task`, `outcome` (`success`/`error`) |
| `talos_agent_tool_call_duration_seconds` | Histogram | `tool.name`, `outcome` |
| `talos_agent_tool_call_errors_total` | Counter | `tool.name` |
| `talos_agent_llm_call_duration_seconds` | Histogram | `llm.model`, `outcome` |
| `talos_agent_http_client_duration_seconds` | Histogram | `http.response.status_code`, `http.retry.count` |

No unbounded label values (no account IDs, job IDs, or free-text) are used
as metric attributes — only the fixed, low-cardinality dimensions above —
to keep cardinality bounded on whatever metrics backend receives these.

## Concurrency, retries, failure, restart, duplicate delivery

These scenarios' *correctness* is already handled by existing mechanisms
(`agent_lock`, `DurableBackoff`, job leasing/fencing in `tools/commerce.py`,
`request_with_retry`/`call_with_retry`). Tracing's job here is purely to
make that existing behavior *observable*, not to change it:

- **Concurrency** (`run_multi`, concurrent scheduler tasks): each unit of
  work gets its own trace; `talos.id`/`agent.task` attributes disambiguate
  overlapping traces from different agents or task kinds sharing one
  process. No shared mutable tracing state is read or written outside the
  SDK's own thread/async-safe primitives.
- **Retries**: `http.py`'s retry loop is wrapped so each *logical* HTTP call
  is one span with an `http.retry.count` attribute, rather than one span per
  physical attempt — a trace shows "this call needed 2 retries," not 3
  disconnected spans.
- **Partial failure / timeout**: caught exceptions (including
  `httpx.TimeoutException`, `asyncio.TimeoutError`) set span status `ERROR`
  and `error.type`/`error.message` (message truncated + redacted like any
  other attribute) and are re-raised unchanged — tracing never swallows or
  alters an exception.
- **Restart**: see Rollout & rollback above (flush-on-shutdown, accepted
  loss on unclean crash).
- **Duplicate delivery** (job claim/heartbeat/release replay): the existing
  fencing-token flow is untouched; spans for those calls carry `job.id`/
  `tool.arg_keys` so a duplicate-claim attempt is visible in a trace, but no
  new dedup logic is added by this feature.

## Local verification

Agent:

```bash
cd packages/prime-agent
OTEL_ENABLED=true OTEL_TRACES_EXPORTER=console OTEL_METRICS_ENABLED=false \
  talos-agent start
# spans print as JSON to stdout as they end; look for "agent.cycle",
# "llm.chat_completion", "tool.<name>", "web_api.<METHOD> <path>"
```

Or, against a local collector (e.g. Jaeger all-in-one):

```bash
docker run -d --name jaeger -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one:latest
OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 talos-agent start
# UI at http://localhost:16686
```

Web: run `pnpm dev` with `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` set to a
local Sentry (self-hosted) or dev DSN, call an agent-facing route with a
manually crafted `traceparent` header, and confirm the resulting Sentry
transaction shows the same `trace_id`.

Failure path: unset `OTEL_EXPORTER_OTLP_ENDPOINT` while `OTEL_ENABLED=true`
and `OTEL_TRACES_EXPORTER=otlp` — the exporter logs a connection warning
per export interval but the agent loop itself is unaffected (export runs on
a background thread with its own bounded retry, decoupled from the request
path).

## Known limitations

- **Web spans depend on Sentry being configured.** Without `SENTRY_DSN`,
  `web/src/lib/tracing.ts` still runs but has no provider to hand spans to,
  so no web-side spans are exported anywhere (they're created against the
  global no-op tracer). This was a deliberate scope decision (see
  `TRACING.md` intro / PR description) to avoid registering a second,
  competing `TracerProvider` next to Sentry's auto-instrumentation inside
  `withSentryConfig`, which is not a supported combination and would risk
  the "builds remain green" requirement. A follow-up could add a standalone
  `instrumentation.ts`-based NodeSDK gated so it only activates when Sentry
  is *not* configured.
- **Full async context propagation on web requires Sentry's
  `AsyncLocalStorage`-based context manager.** `@opentelemetry/api` alone
  (no SDK/context manager registered) only preserves context synchronously;
  with Sentry active this is handled correctly, without it, spans created
  after an `await` inside a route handler may not nest under the extracted
  parent. Since no export happens in that state anyway (previous bullet),
  this has no observable effect today.
- **No tail sampling / span buffering across a crash.** See Rollout &
  rollback.
- **Contracts (`contracts/`) are not instrumented.** Tracing stops at the
  Horizon/RPC client call; what happens inside the Soroban runtime is out
  of scope.
