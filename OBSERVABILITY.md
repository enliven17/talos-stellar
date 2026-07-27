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

## Request Correlation

### X-Request-Id header
Every web API response includes an `X-Request-Id` header (UUID). When the agent calls the web API, it propagates its `cycle_id` as `X-Request-Id`, so both sides' logs can be correlated:

- Web log: `{ "requestId": "abc-123", ... }`
- Agent log: `{ "cycle_id": "abc-123", ... }`

To cross-reference: filter both log streams by the same ID.

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

## Pagination

List endpoints now support cursor-based pagination:

| Endpoint | Paginated |
|---|---|
| `GET /api/talos/:id/approvals` | ✅ |
| `GET /api/talos/:id/revenue` | ✅ |
| `GET /api/talos/:id/activity` | ✅ |
| `GET /api/jobs/pending` | ✅ |
| `GET /api/activity` | ✅ (pre-existing) |

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
