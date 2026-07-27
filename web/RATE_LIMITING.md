# Distributed Rate Limiting

## Overview

The web API uses a sliding-window rate limiter with two interchangeable backends:

| Backend | When active | Scope |
|---|---|---|
| Redis | `REDIS_URL` is set | Shared across all horizontally scaled instances |
| In-memory | `REDIS_URL` unset | Per-process (dev / test only) |

Switching backends requires no code changes — only environment variable updates.

---

## Architecture

```
Request
  └─▶ middleware.ts (Next.js Edge)
        └─▶ proxy.ts  ─ bucket selection ─▶ rateLimit()
                                                └─▶ getRateLimitStore()
                                                      ├─ RedisRateLimitStore  (REDIS_URL set)
                                                      │   └─ INCR + PEXPIREAT  (atomic, 1 round-trip)
                                                      │   └─ falls back to MemoryRateLimitStore on error
                                                      └─ MemoryRateLimitStore  (REDIS_URL unset)
```

### Atomicity

The Redis backend uses `INCR` followed by `PEXPIREAT` in a single pipelined send. `INCR` is atomic in Redis, so concurrent requests across any number of instances increment the same counter without races or double-counting.

### Fail-open / Fail-closed

By default (`RATE_LIMIT_FAIL_CLOSED=false`), if Redis is unreachable the store silently falls back to in-memory. This keeps traffic flowing during a Redis blip but means quotas are temporarily process-local.

Set `RATE_LIMIT_FAIL_CLOSED=true` to deny all traffic when Redis is unavailable (strict shared-quota enforcement).

---

## Rate Limit Buckets

| Bucket | Key pattern | Default limit | Window |
|---|---|---|---|
| Auth | `auth:{ip}` | 20 req | 60 s |
| Read (GET) | `read:{ip}` | 100 req | 60 s |
| Write + API key | `write_key:{key_fingerprint}` | 30 req | 60 s |
| Write, no key | `write_ip:{ip}` | 30 req | 60 s |

Auth routes: any path ending in `/me`, containing `check-name`, or containing `regenerate-key`.

API keys are stored as an 8+8 character fingerprint (first 8 + last 8 chars) — the raw secret is never written to the shared store.

---

## Response Headers

Every API response includes:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Quota for this bucket |
| `X-RateLimit-Remaining` | Remaining requests in the current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |
| `Retry-After` | Seconds until the client may retry (429 responses only) |

---

## Configuration

All settings are controlled via environment variables. No redeploy of application code is needed to change quotas.

### Required (production)

```env
REDIS_URL=redis://default:password@redis.example.com:6379
```

### Optional

```env
# Proxy depth for trusted X-Forwarded-For parsing (default: 1)
TRUSTED_PROXY_DEPTH=1

# Deny requests when Redis is down instead of falling back to memory (default: false)
RATE_LIMIT_FAIL_CLOSED=false

# Quota overrides
RATE_LIMIT_AUTH_LIMIT=20
RATE_LIMIT_AUTH_WINDOW_MS=60000
RATE_LIMIT_READ_LIMIT=100
RATE_LIMIT_READ_WINDOW_MS=60000
RATE_LIMIT_WRITE_KEY_LIMIT=30
RATE_LIMIT_WRITE_IP_LIMIT=30
RATE_LIMIT_WRITE_WINDOW_MS=60000
```

### Trusted proxy depth

`TRUSTED_PROXY_DEPTH` controls how many proxy hops are stripped from the right of `X-Forwarded-For` before reading the client IP:

| Infrastructure | Value |
|---|---|
| Vercel (single edge layer) | `1` |
| Railway behind one proxy | `1` |
| Behind two proxies | `2` |
| No proxy / raw socket | `0` |

Setting this incorrectly allows clients to spoof their IP by injecting values at the start of `X-Forwarded-For`.

---

## Local Verification

### Without Redis (in-memory fallback)

No additional setup needed. Omit `REDIS_URL` from your `.env.local`:

```bash
cd web
cp env.example .env.local   # remove or leave blank REDIS_URL
npm run dev
```

Hit the rate-limit manually:
```bash
for i in $(seq 1 35); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/talos
done
# Requests 1-100 → 200, 101+ → 429
```

### With Redis (distributed mode)

Start a local Redis instance:
```bash
docker run -d -p 6379:6379 redis:7-alpine
```

Add to `web/.env.local`:
```env
REDIS_URL=redis://127.0.0.1:6379
```

Restart the dev server and repeat the curl loop. Counters now survive process restarts and are shared across multiple `next start` instances on different ports.

### Verify Retry-After header

```bash
curl -i http://localhost:3000/api/talos  # after exceeding limit
# HTTP/1.1 429
# Retry-After: 58
# X-RateLimit-Remaining: 0
```

---

## Observability

Rate-limit events are emitted via `pino` at the `warn` level:

```json
{ "level": "warn", "key": "read:1.2.3.4", "err": { "message": "..." }, "msg": "rate-limit: Redis unavailable, falling back to memory store" }
```

On fail-closed denial (no Redis), the process logs at `error` level and returns `{ count: MAX_SAFE_INTEGER }` so any quota is immediately exceeded.

Alert recommendations (Sentry / log drain):
- `msg = "rate-limit: Redis unavailable"` — Redis connectivity issue
- `msg = "rate-limit: store.increment threw unexpectedly"` — unexpected store error
- HTTP 429 spike — potential abuse or mis-configured client

---

## Rollback

To revert to the previous process-local behavior:

1. Remove or clear `REDIS_URL` from your environment.
2. Redeploy.

The in-memory store is identical to the original implementation. No schema changes, no migrations, no downtime.

To fully remove distributed rate limiting, revert `src/lib/rate-limit.ts` to the commit before this feature. The `src/lib/rate-limit-store.ts` and `src/middleware.ts` files can then also be deleted.

---

## Known Limitations

- The Redis client in `rate-limit-store.ts` opens a new TCP connection per rate-limit check. This is intentional (no external dependency) and acceptable at the traffic volumes this service handles. For very high throughput, replace `MinRedisClient` with a connection-pooled client (e.g. `ioredis`).
- The `PTTL`-based `resetAt` derivation for count > 1 involves a second Redis round-trip. This can be eliminated by using a Lua script or Redis 7 `OBJECT FREQ` — left as a future optimisation.
- Key fingerprinting for API keys (8+8 chars) provides weak collision resistance for very large key spaces. If the key space exceeds ~10k active keys, switch to a keyed HMAC using a server-side secret.
