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
