# Observability Guide

## Error Tracking (Sentry)

### Web (Next.js)
Errors are auto-captured via `@sentry/nextjs`. Configure by setting:
```
SENTRY_DSN=<your-dsn>
NEXT_PUBLIC_SENTRY_DSN=<your-dsn>
```
in `web/.env.local`. Both vars are needed: `SENTRY_DSN` for server-side routes, `NEXT_PUBLIC_SENTRY_DSN` for client-side.

To verify Sentry is working, add a deliberate throw to any API route:
```ts
throw new Error("Sentry test error");
```
Then check your Sentry dashboard.

### Agent (Python)
Errors are captured via `sentry-sdk` with the asyncio integration. Configure:
```
SENTRY_DSN=<your-dsn>
```
in `packages/prime-agent/.env`. Leave blank to disable.

## Structured Logging

### Web (Next.js) — pino
Logs are emitted as JSON lines in production. Import and use:
```ts
import { logger } from "@/lib/logger";
logger.info({ requestId }, "handler called");
logger.error({ err, requestId }, "handler failed");
```

In development, logs are pretty-printed via `pino-pretty`.

### Agent (Python) — structlog
Logs are JSON lines on stdout, captured by Railway.
```python
import structlog
log = structlog.get_logger(__name__)
log.info("event_name", key="value")
```

Every agent cycle binds a `cycle_id` UUID to the log context via `structlog.contextvars`.

### Transactional outbox
The domain-event outbox (`web/src/lib/outbox`) emits one structured log
line per state transition (`outbox_event_written`, `_leased`,
`_dispatched`, `_retry_scheduled`, `_dead_letter`, `outbox_lease_reaped`,
`outbox_events_pruned`) — identifiers and counters only, never the event
`payload` or a raw error. See `web/OUTBOX.md`.

## Request Correlation

### X-Request-Id header
Every web API response includes an `X-Request-Id` header (UUID). When the agent calls the web API, it propagates its `cycle_id` as `X-Request-Id`, so both sides' logs can be correlated:

- Web log: `{ "requestId": "abc-123", ... }`
- Agent log: `{ "cycle_id": "abc-123", ... }`

To cross-reference: filter both log streams by the same ID.

## Distributed Tracing (OpenTelemetry)

End-to-end tracing across scheduler → LLM → tool → Web API → Stellar/Horizon
→ fulfillment. Full design in **[docs/TRACING.md](docs/TRACING.md)** —
span taxonomy, sampling, redaction policy, exporter config, and known
limitations. Summary:

- **Disabled by default.** No behavior or performance change unless you
  opt in.
- **Agent**: set `OTEL_ENABLED=true` in `packages/prime-agent/.env`, plus
  either `OTEL_TRACES_EXPORTER=console` (prints spans to stdout, no
  infrastructure needed) or `OTEL_EXPORTER_OTLP_ENDPOINT=...` for a real
  collector.
- **Web**: rides on Sentry's already-registered OpenTelemetry provider — no
  separate setup. Spans only export somewhere when `SENTRY_DSN` /
  `NEXT_PUBLIC_SENTRY_DSN` is configured, matching the existing web
  observability posture.
- **Local verification** (agent):
  ```bash
  cd packages/prime-agent
  OTEL_ENABLED=true OTEL_TRACES_EXPORTER=console talos-agent start
  ```
  Look for `agent.cycle`, `llm.chat_completion`, `tool.<name>`, and
  `web_api.<METHOD> <path>` spans printed to stdout, sharing one `trace_id`
  per cycle.
- **Rollback**: unset `OTEL_ENABLED` (or set it to `false`) and restart.
  Nothing is persisted to a database, so there is no data-layer state to
  reverse — see `docs/TRACING.md#persistence--migration-analysis`.
- Structured logs on both sides now include `trace_id`/`span_id` fields
  whenever a span is active (alongside the existing `cycle_id`/
  `X-Request-Id`), so you can pivot from a log line straight into a trace.

## Where to find logs

| Layer | Where |
|---|---|
| Web errors | Sentry dashboard → `talos-stellar-web` project |
| Web logs | Vercel dashboard → Functions tab → Log drain |
| Agent errors | Sentry dashboard → `talos-stellar-agent` project |
| Agent logs | Railway dashboard → Deployment logs |
| Benchmark logs | `BENCHMARK_LOG_LEVEL`-controlled pino logger in `area/devx/logger.ts` |
| Benchmark artifacts | JSON files in `.benchmarks/` directory (configurable via `BENCHMARK_ARTIFACT_DIR`) |

## Benchmark Observability

The benchmark system in `web/src/area/devx/` provides its own observability layer:

- **Privacy-safe logging**: Sensitive fields (API keys, secrets, tokens) are automatically redacted in benchmark log output via pattern matching in `sanitizeForLogging()`.
- **Structured benchmark events**: Every benchmark run, result, and threshold violation is logged as structured JSON via pino.
- **Resource tracking**: Memory (heap used) and CPU usage are sampled per iteration via the `ResourceTracker` class, which wraps `process.memoryUsage()` and `process.cpuUsage()`.
- **CI correlation**: When `CI=true`, benchmark logs include `commitSha` and `branch` from `GITHUB_SHA`/`GITHUB_REF_NAME`, linking performance data to specific commits.
- **Artifact persistence**: Full benchmark results (including percentiles, sample data, and threshold results) are persisted as JSON files for trend analysis.

See [BENCHMARKS.md](./BENCHMARKS.md) for complete documentation.

## Backup / Restore signals

Backup events emit log entries prefixed with `ops backup completed`,
`ops backup failed`, `ops restore verified`, `ops restore applied`,
`ops restore failed`, or `ops backup status failed`. Successful backup /
restore runs are also recorded in `tls_backup_runs` so alerting rules can
look at history:

```
GET /api/ops/backup/status    ← OTel-friendly: include counts, lastSuccess, lastFailure
```

The web `_backup` and `/ops/restore` endpoints never log:
- the artifact bytes,
- the passphrase (`X-Backup-Passphrase` header is read once and discarded),
- long hex/base64 strings ≥ 32 chars,
- filesystem paths.

See `sanitizeErrorMessage` in `web/src/lib/backup-types.ts` for the exact
redaction regex set.

## Idempotency Observability

### Structured log events

All idempotency state transitions are logged as structured events. Keys and route paths are
logged; payload contents and response bodies are **never** logged.

#### Web (pino)

| `event` field | When emitted | Log level |
|---|---|---|
| `idempotency_miss` | New key seen for first time | `info` |
| `idempotency_hit` | Cache hit — cached response returned | `info` |
| `idempotency_inflight` | Key exists but response not yet cached | `info` |
| `idempotency_conflict` | Key reused with different payload | `warn` |
| `idempotency_commit` | buy-token purchase committed successfully | `info` |

Example log line (JSON):
```json
{
  "level": "info",
  "time": "2026-07-24T18:00:00.000Z",
  "event": "idempotency_hit",
  "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
  "talosId": "abc123",
  "jobId": "job-xyz",
  "replayed": true,
  "msg": "idempotent replay — returning cached response"
}
```

#### Agent (Python / structlog)

| Event | When emitted |
|---|---|
| `idempotency_key_injected` | Key appended to outbound POST/PATCH |
| `idempotency_conflict` | `IdempotencyConflictError` raised |

### Metrics

Aggregate the structured log events with a log drain or query:

| Suggested metric name | `event` filter |
|---|---|
| `idempotency_hit_total` | `event = "idempotency_hit"` |
| `idempotency_miss_total` | `event = "idempotency_miss"` |
| `idempotency_conflict_total` | `event = "idempotency_conflict"` |
| `idempotency_inflight_total` | `event = "idempotency_inflight"` |

### Response headers

Use the response headers to detect replays at the HTTP layer (e.g. in a proxy or test harness):

```
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
X-Idempotent-Replayed: true
```

## Pagination

List endpoints now support cursor-based pagination:

| Endpoint | Paginated |
|---|---|
| `GET /api/talos/:id/approvals` | ✅ |
| `GET /api/talos/:id/revenue` | ✅ |
| `GET /api/talos/:id/activity` | ✅ |
| `GET /api/jobs/pending` | ✅ |
| `GET /api/activity` | ✅ (pre-existing) |
| `GET /api/admin/outbox` | ✅ (see `web/OUTBOX.md`) |

### Usage
```
GET /api/talos/:id/approvals?limit=50
GET /api/talos/:id/approvals?limit=50&cursor=2024-01-15T12:00:00.000Z
```

Response shape:
```json
{
  "approvals": [...],
  "nextCursor": "2024-01-14T08:30:00.000Z"
}
```

`nextCursor` is `null` when there are no more pages. Default limit is 50, max is 200.

## Provider Reputation

`GET /api/talos/:id/reputation` returns the versioned provider
reputation score with confidence, decay, and bounded counterparty
influence. See `REPUTATION.md` for the full algorithm contract.

Signals to alert on (Sentry):

- `inputs.evidence === "insufficient"` for an active provider
- `inputsTrace.concentrationDamping < 0.5` for a non-new provider
  (likely sybil / single-buyer pattern)
- `score` is requested but `scoreVersion` returned is not pinned to
  the expected version (cache or formula break)

Cache key for downstream stores: `(talosId, scoreVersion, dayBucket)`.
