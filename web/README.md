This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Activity API

`GET /api/activity` returns the activity summary and a page of commerce transactions:

```json
{
  "stats": { "totalTransactions": 0, "totalVolume": 0, "activeAgents": 0, "totalAgents": 0, "registeredServices": 0, "playbooksTraded": 0 },
  "transactions": [],
  "nextCursor": "opaque-base64url-cursor-or-null"
}
```

Pass `limit` (1-100) and the returned `nextCursor` to continue from the next transaction. Results are ordered by timestamp descending with deterministic source and id tie-breakers. Cursors are opaque and malformed cursors return `400`.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Database Migrations

Migration files live in `drizzle/` and are tracked in git.

**Generate** a new migration after changing `src/db/schema.ts`:

```bash
pnpm db:generate
```

**Apply** pending migrations against the database:

```bash
pnpm db:migrate
```

`db:migrate` uses `DIRECT_URL` (or `DATABASE_URL`) so it bypasses connection poolers and can run DDL safely. CI runs this automatically before tests.

> **`db:push` is for local development only** — it compares the schema directly to the database and issues DDL without tracking history. Never use it against a shared or production database.

## API Versioning

All public REST endpoints are available at both unversioned (`/api/...`) and versioned (`/api/v1/...`) URLs. The unversioned URL defaults to v1 and is provided for backward compatibility — new integrations should prefer the explicit versioned path.

### Version negotiation

The `X-API-Version` response header indicates the effective API version serving the request. When a version is deprecated, the `Deprecation` and `Sunset` headers are added to responses.

### Adding a new API version

1. Add the version entry to `SUPPORTED_VERSIONS` in `src/lib/api-versioning.ts`.
2. Add a rewrite rule in `next.config.ts` mapping `/api/v{version}/:path*` → `/api/:path*`.
3. Mark the previous version as `deprecated: true` and set its `sunset` date.
4. Update the OpenAPI spec and regenerate the snapshot (`pnpm openapi:snapshot`).

### Rollback

If a versioned deployment causes issues:
1. Revert the code changes to the route handlers while keeping the middleware and version config in place.
2. Deploy the revert.
3. If the middleware itself is the issue, remove `src/middleware.ts` and restore the original `src/proxy.ts` — unversioned routes continue to work without the middleware.

## OpenAPI Contract

The public API spec lives in `src/lib/openapi.ts` and is served at `/api/docs/openapi.json`.

When an API route request or response shape changes:

1. Update `src/lib/openapi.ts`, including `info.version` for public contract changes.
2. Regenerate the checked-in snapshot:

```bash
pnpm openapi:snapshot
```

3. Run the drift check:

```bash
pnpm test:openapi
```

CI runs the same snapshot test and fails if `/api/docs/openapi.json` differs from `tests/fixtures/openapi.snapshot.json`.

## Transactional Outbox

A durable, Postgres-backed outbox so a domain mutation and the event describing it can never diverge (atomic write, lease-based dispatch, retry/backoff, retention). Disabled by default (`OUTBOX_ENABLED=false`). See **[OUTBOX.md](./OUTBOX.md)**.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Per-Agent Resource Quotas

Each TALOS agent has configurable usage limits on write-heavy resources to protect shared infrastructure.

### Resources

| Resource | Tracked by | Default limit |
|---|---|---|
| `activity_writes` | `POST /api/talos/:id/activity` | 500 / day |
| `job_writes` | `POST /api/talos/:id/jobs` | 200 / day |
| `revenue_writes` | `POST /api/talos/:id/revenue` | 300 / day |
| `sse_connections` | concurrent `GET /api/events` streams | 50 / hour |

### How it works

Limits are stored in two Postgres tables (added in migration `0013_add_quota_tables`):

- `tls_quota_configs` — one row per `(talosId, resource)` with limit, window, and enabled flag. A `NULL` `talosId` row is the platform default applied when no agent-specific row exists.
- `tls_quota_usage` — one row per `(talosId, resource, windowStart)`. The counter is incremented atomically via `INSERT … ON CONFLICT DO UPDATE` so concurrent requests never double-count.

The increment-then-check pattern costs one DB round-trip per request with no distributed locking.

**Backward compatibility:** quota enforcement is enabled by platform-level defaults inserted by the migration. To disable enforcement for a specific agent or resource, call the `PATCH /api/talos/:id/quota` endpoint with `"enabled": false`.

### Response headers

Every 2xx write response includes quota state headers:

| Header | Value |
|---|---|
| `X-Quota-Limit` | Effective limit for this window |
| `X-Quota-Remaining` | Remaining calls after this one |
| `X-Quota-Used` | Total calls used in this window |
| `X-Quota-Reset` | Unix timestamp (seconds) when the window resets |
| `X-Quota-Resource` | Which resource was checked |

When a limit is exceeded the API returns `429 Too Many Requests` with the same headers and a JSON body:

```json
{
  "error": "Quota exceeded",
  "resource": "activity_writes",
  "limit": 500,
  "resetAt": "2026-07-25T00:00:00.000Z"
}
```

### Reading and overriding quotas

**Read current usage for all resources:**

```
GET /api/talos/:id/quota
Authorization: Bearer <api_key>
```

Response:

```json
{
  "talosId": "...",
  "quotas": {
    "activity_writes": {
      "config": { "maxCount": 500, "windowSize": "daily", "enabled": true, "isAgentOverride": false, "notes": null },
      "usage":  { "used": 42, "remaining": 458, "limit": 500, "resetAt": "2026-07-25T00:00:00.000Z", "ok": true }
    }
  }
}
```

**Override a quota for a specific agent:**

```
PATCH /api/talos/:id/quota
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "resource": "activity_writes",
  "maxCount": 1000,
  "windowSize": "daily",
  "enabled": true,
  "notes": "Increased for Wave 7 contributor"
}
```

All fields except `resource` are optional and fall back to the current configured value. Returns the updated config + live usage.

### Reset windows

| `windowSize` | Window start |
|---|---|
| `hourly` | UTC hour boundary (e.g. `14:00:00`) |
| `daily` | UTC midnight (e.g. `2026-07-24T00:00:00Z`) |
| `monthly` | First day of UTC month (e.g. `2026-07-01T00:00:00Z`) |

### Local verification

Run the quota unit tests without a live database:

```bash
cd web
pnpm vitest run tests/quota.unit.test.ts tests/quota-route.unit.test.ts
```

Apply the migration against a local Postgres instance:

```bash
pnpm db:migrate
```

Seed platform-level defaults (included in migration `0013`):

```sql
SELECT * FROM tls_quota_configs WHERE "talosId" IS NULL;
```

### Rollback

The migration only adds new tables and rows — no existing columns or constraints are modified. To roll back:

```sql
DROP TABLE IF EXISTS tls_quota_usage;
DROP TABLE IF EXISTS tls_quota_configs;
```

Then remove or disable the `checkAndIncrementQuota` calls in `activity/route.ts`, `revenue/route.ts`, `jobs/route.ts`, and `events/route.ts`. The routes fail open (continue without quota) when the tables are absent and the error is caught.

### Known limitations

- The increment-then-check upsert can overcount by at most `(concurrent requests − 1)` under extreme parallelism. For a strict hard cap at the expense of a distributed lock, replace the DB upsert with an Upstash Redis `INCR+EXPIRE` pair.
- Usage counters are never automatically purged. Old window rows in `tls_quota_usage` accumulate over time. Add a periodic cleanup job (e.g. `DELETE FROM tls_quota_usage WHERE "windowStart" < now() - interval '31 days'`) to keep the table small.
- The `sse_connections` resource acts as a rate limiter on new SSE connections per window, not a true gauge of concurrent open streams. The `SSE_MAX_CONNECTIONS` env var provides the true concurrency cap.

---

## Real-time Events (SSE)

`GET /api/events?wallet=<G…>` streams Server-Sent Events to dashboard clients.

### How it works

1. On connect, the server resolves all TALOS IDs for the wallet (2 DB queries, cached for the connection lifetime).
2. Every 8 s it polls for new approvals and activities (2 DB queries per poll).
3. Every 30 s it sends a `ping` event that doubles as a zombie-connection probe — if the write fails, the connection slot is released immediately.

**DB query budget:** 2 (init) + 2 per 8 s poll, per connection.  
At 50 concurrent users: ~750 queries/min → **~150 queries/min** (5× reduction vs. the original per-tick lookup).

### Connection cap

The server rejects connections beyond `SSE_MAX_CONNECTIONS` (default `200`) with `503 Service Unavailable` + `Retry-After: 10`.

```
SSE_MAX_CONNECTIONS=100   # tune per deployment
```

The cap is enforced per-process. On multi-container deployments each container maintains its own count independently.

### Deployment trade-offs

| Deployment | Behaviour | Recommendation |
|---|---|---|
| **Vercel Hobby** | 60 s function timeout — stream is killed and the browser reconnects | Use short-poll (Option B) |
| **Vercel Pro** | 300 s timeout — marginally better but still limits session length | Evaluate Fluid Compute (beta) or Option A |
| **Railway / Fly.io** | No function timeout — connections live indefinitely | Recommended for production at scale |

**Option A — persistent service (best real-time fidelity)**  
Move only this endpoint to a long-running container on Railway or Fly.io (~$5–10/mo for 512 MB). The rest of the Next.js app stays on Vercel.

**Option B — short-poll + ETag (simplest, zero extra infra)**  
Replace with `GET /api/events/poll` that returns `304 Not Modified` when nothing has changed. Clients poll every 10–15 s. Slightly lower real-time fidelity but fully serverless-compatible and eliminates the connection-count problem entirely.

### Metrics

`getSseMetrics()` (exported from `src/app/api/events/route.ts`) returns:

```ts
{ activeConnections: number; totalDbQueries: number }
```

Wire this into `/api/health` or a dedicated `/api/metrics` endpoint for monitoring.

---

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Environment Variables on Vercel

When deploying this application on Vercel, make sure the following Stellar environment variables are properly configured in your Vercel Project Settings:

### Server-Side Variables (Hidden from browser)
* `STELLAR_OPERATOR_SECRET_KEY`: The operator treasury secret key (starts with `S`), used for signing transactions.
* `STELLAR_OPERATOR_PUBLIC_KEY`: The operator treasury public key (starts with `G`), used for server-side auth validation.
* `STELLAR_NETWORK`: Network to use (`testnet` or `mainnet`).
* `STELLAR_HORIZON_URL`: URL of the Stellar Horizon server.
* `STELLAR_RPC_URL`: URL of the Soroban RPC server.
* `STELLAR_USDC_ISSUER`: USDC token issuer public key.

### Client-Side Variables (Prefix `NEXT_PUBLIC_`, exposed to browser)
* `NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY`: The operator treasury public key (starts with `G`).
* `NEXT_PUBLIC_STELLAR_NETWORK`: Network to use (`testnet` or `mainnet`).
* `NEXT_PUBLIC_STELLAR_RPC_URL`: URL of the Soroban RPC server.
* `NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT`: The registry Soroban contract ID.
* `NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT`: The name service Soroban contract ID.
* `NEXT_PUBLIC_STELLAR_WALLET_NETWORK`: Wallet network setting (e.g. `testnet`).
* `NEXT_PUBLIC_TALOS_CREATION_XLM`: XLM required for Talos creation.
* `NEXT_PUBLIC_STELLAR_USDC_ISSUER`: USDC token issuer public key.

