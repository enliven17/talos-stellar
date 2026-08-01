# Idempotency Key Support for SDK Write Calls

**Status:** Implemented  
**Date:** 2026-07-24  
**Scope:** `packages/sdk`, `packages/prime-agent`, `web/src/lib`, `web/src/app/api`

---

## Overview

Safe retry behaviour for SDK write calls requires idempotency: the same logical request can be
retried any number of times and produce exactly one side effect. This document describes the
design, interfaces, persistence model, rollout path, and compatibility constraints for the
idempotency key feature in the Talos protocol.

---

## Problem Statement

### Before this change

| Layer | Retry behaviour |
|---|---|
| TypeScript SDK (`TalosClient`) | Retries on transient codes (429/5xx) but **only for safe methods** (GET, HEAD, PUT, DELETE, OPTIONS). POST calls are never retried, so a network failure after a POST has been received by the server may silently drop the request from the client's perspective, or result in a duplicate if the client retries manually. |
| Python agent (`TalosAPIClient`) | All methods use `request_with_retry`, which retries on 429/502/503/504. POSTs are retried, but without idempotency keys, a 503 that actually committed could be retried and create a duplicate job or revenue record. |
| Server (jobs route) | `Idempotency-Key` header supported; DB partial-unique index enforces uniqueness. |
| Server (buy-token route) | `txHash` used as natural idempotency key. |

### After this change

- Both SDKs inject a unique `Idempotency-Key` header on every write (POST/PATCH) call.
- The TypeScript SDK can now safely retry POST calls when the caller opts in via `idempotencyKey` in per-call options.
- The Python SDK injects keys automatically on every mutating call.
- A shared key-generation utility (TypeScript and Python) produces RFC 4122 v4 UUIDs.
- Privacy-safe structured logging records state transitions without leaking payload contents.
- Conflict errors carry machine-readable codes so callers can distinguish safe-retry from genuine conflict.

---

## Key Generation

### Constraints

- Keys must be globally unique per logical operation.
- Keys must be stable across retries of the same logical call (caller holds the key).
- Keys must not encode PII or payload contents.
- Keys must be ≤ 255 bytes (column `text`, validated server-side to 128 bytes max).

### Format

**UUID v4** (128 bits, random). Format: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.

- TypeScript: `crypto.randomUUID()` (Web Crypto API — available in Node 19+, all modern browsers, and the Next.js edge runtime).
- Python: `uuid.uuid4()` (stdlib, cryptographically random).
- Both implementations are in `packages/sdk/src/idempotency.ts` and
  `packages/prime-agent/src/talos_agent/idempotency.py`.

### Caller-provided keys

Callers may supply their own key in per-call options:

```typescript
// TypeScript SDK
await client.submitJobResult(jobId, result, { idempotencyKey: myKey });

// Caller generates key before a retry loop
const key = generateIdempotencyKey();
for (let i = 0; i < 3; i++) {
  const res = await client.createJob(talosId, params, { idempotencyKey: key });
  if (res.ok) break;
}
```

```python
# Python SDK
from talos_agent.idempotency import generate_idempotency_key
key = generate_idempotency_key()
await client.report_activity(talos_id, type_="post", content="...", channel="X",
                              idempotency_key=key)
```

If no key is provided, write methods on the Python SDK generate one automatically (opt-out via
`idempotency_key=None`). The TypeScript SDK requires an explicit opt-in to avoid changing
existing call signatures silently.

---

## Interfaces

### TypeScript SDK — `WriteOptions`

```typescript
export interface WriteOptions {
  /** Optional idempotency key. UUID v4 recommended. Max 128 bytes. */
  idempotencyKey?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}
```

Methods that accept `WriteOptions`: `createJob`, `reportActivity`, `reportRevenue`,
`createApproval`, `submitJobResult`, `createPlaybook`, `transfer`.

### TypeScript SDK — `IdempotencyConflictError`

Thrown when the server returns 409 due to key reuse with a different payload:

```typescript
export class IdempotencyConflictError extends TalosAPIError {
  readonly conflictingKey: string;
}
```

### Python SDK — `IdempotencyConflictError`

```python
class IdempotencyConflictError(Exception):
    def __init__(self, key: str, message: str):
        self.key = key
        super().__init__(message)
```

### Server response metadata

Responses to idempotent writes include an `Idempotency-Key` echo header:

```
HTTP/1.1 201 Created
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
X-Idempotent-Replayed: false
```

On a cache hit (replay):
```
HTTP/1.1 201 Created
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
X-Idempotent-Replayed: true
```

---

## Persistence Model

### Jobs (`tls_commerce_jobs`)

Already in place (migration `0011_add_jobs_idempotency_key.sql`):

```sql
idempotencyKey       text,
idempotencyResponse  jsonb,

-- Partial unique index: uniqueness enforced only when key IS NOT NULL
UNIQUE (talosId, idempotencyKey) WHERE "idempotencyKey" IS NOT NULL
```

Lifecycle:
1. First request with key → INSERT row with `idempotencyKey`, then UPDATE `idempotencyResponse`
   within the same DB transaction.
2. Retry with same key + same payload → SELECT returns row with `idempotencyResponse`; return
   cached body (no INSERT).
3. Retry with same key + different payload → SELECT returns row; payload mismatch → 409.
4. Concurrent request → second INSERT hits unique index → PG error 23505 → 409.

### Token purchases (`tls_token_purchases`)

Natural key is `txHash` (Stellar transaction hash). The `tls_token_purchases` table already
implements idempotency via the PK + `status` column. No schema changes needed.

### Key expiry

Keys are retained for the lifetime of their associated record. There is no TTL-based key
expiry in this implementation (adding one is a forward migration when needed). The partial
unique index makes re-use across different talosIds safe.

---

## Conflict Errors

### Error codes

| Scenario | HTTP status | `error` field | SDK exception |
|---|---|---|---|
| Key reused, different payload | 409 | `"Idempotency-Key reused with a different payload..."` | `IdempotencyConflictError` |
| Key exists, in-flight | 409 | `"Request with this Idempotency-Key is already being processed"` | `TalosAPIError(409)` |
| Concurrent duplicate (race) | 409 | `"Request with this Idempotency-Key is already being processed"` | `TalosAPIError(409)` |
| txHash replay (buy-token) | 409 | `"Purchase is already in progress for this transaction"` | `TalosAPIError(409)` |

The TypeScript SDK maps `409` responses whose body contains `"reused with a different payload"`
to `IdempotencyConflictError`. All other 409s become plain `TalosAPIError(409)`.

---

## Retry Interaction

### TypeScript SDK

Before this change, POST was not in the retry-eligible method list. After this change:
- If the caller passes `idempotencyKey` in `WriteOptions`, the method is added to the retry set
  for that call only, using the same exponential-backoff-with-jitter policy.
- The idempotency key is injected on every attempt including retries, so the server can
  de-duplicate a retry that arrives after the first attempt committed.
- Retries are only attempted on 429/500/502/503/504. A 409 conflict is **not** retried (it
  requires caller intervention).

### Python SDK

`request_with_retry` already retries on 429/502/503/504. After this change:
- Every `_post` and `_patch` call in `TalosAPIClient` injects an auto-generated
  `Idempotency-Key` header unless the caller passes `idempotency_key=None`.
- Because the key is generated once per logical call (not per retry attempt), all retry
  attempts carry the same key and are safe to retry.
- A `409 IdempotencyConflictError` is **not** wrapped by `RetryableHTTPError`, so tenacity does
  not retry it.

---

## Observability

### Log events (privacy-safe)

All log events record the idempotency key value (opaque UUID — no PII) and the outcome code,
but never the request payload or response body.

#### TypeScript (pino)

```typescript
logger.info({ idempotencyKey, talosId, event: "idempotency_hit", replayed: true }, "idempotent replay");
logger.warn({ idempotencyKey, talosId, event: "idempotency_conflict" }, "idempotency key conflict");
logger.info({ idempotencyKey, talosId, event: "idempotency_miss" }, "new idempotent request");
```

#### Python (structlog)

```python
log.info("idempotency_key_injected", key=key, method="POST", path=path)
log.info("idempotency_conflict", key=key, status=409)
```

### Metrics (future)

The log events use structured keys (`event`) that can be aggregated by log drain or forwarded to
a metrics backend. Suggested counters:

| Metric | Description |
|---|---|
| `idempotency_hit_total` | Replays served from cache |
| `idempotency_miss_total` | New requests (first-time key) |
| `idempotency_conflict_total` | 409 conflicts (payload mismatch) |
| `idempotency_inflight_total` | 409 in-flight (concurrent) |

---

## Browser Support

`crypto.randomUUID()` is available in all modern browsers (Chrome 92+, Firefox 95+, Safari 15.4+)
and the Node.js 19+ runtime. For environments that do not support it, a pure-JS fallback is
provided in `idempotency.ts`:

```typescript
export function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback using Math.random (not cryptographically strong,
  // but sufficient for idempotency key uniqueness)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
```

---

## Rollout Path

### Phase 0 — Backward compatibility (already in place)

The server routes accept `Idempotency-Key` as an **optional** header. Requests without the
header proceed normally with no idempotency enforcement. This is the existing behaviour.

### Phase 1 — SDK instrumentation (this PR)

- TypeScript SDK: opt-in per call via `WriteOptions.idempotencyKey`.
- Python SDK: auto-inject on every write call; opt-out via `idempotency_key=None`.
- No server changes required.

### Phase 2 — Enforcement (future, operator-gated)

If the operator wants to require idempotency keys on specific endpoints, add a check at the top
of the route handler:

```typescript
if (!idempotencyKey && REQUIRE_IDEMPOTENCY_KEY) {
  return Response.json(
    { error: "Idempotency-Key header is required for this endpoint" },
    { status: 400 },
  );
}
```

Gate this behind an env var (`REQUIRE_IDEMPOTENCY_KEY=true`) so existing callers have time to
upgrade before enforcement.

### Rollback

Phase 1 (SDK instrumentation) is entirely additive:
- Remove `idempotency.ts` / `idempotency.py`.
- Revert the `_post` / `_patch` methods in `TalosAPIClient` to not pass the header.
- Revert the `request` method in `TalosClient` to not include the header.
- The server-side schema and index are additive (nullable column + partial index) and can be
  left in place without impact.

If Phase 2 enforcement is rolled out and must be reversed: set `REQUIRE_IDEMPOTENCY_KEY=false`
(or unset the env var) and redeploy. No DB changes needed.

---

## Compatibility Analysis

| Change | Backward compatible | Notes |
|---|---|---|
| `Idempotency-Key` header on new requests | ✅ | Server ignores absent header |
| `IdempotencyConflictError` new exception | ✅ | Subclass of `TalosAPIError`; existing `catch(e instanceof TalosAPIError)` still works |
| `WriteOptions` parameter on write methods | ✅ | Optional parameter; callers not supplying it get existing behaviour |
| Python auto-inject on write calls | ⚠️ | If the server rejects unknown headers (it does not), this would break. The server ignores unrecognised headers. |
| `X-Idempotent-Replayed` response header | ✅ | New header; existing callers ignore it |
| `Idempotency-Key` echo response header | ✅ | New header; existing callers ignore it |

---

## Security Considerations

- Keys are opaque UUIDs; they do not encode payload contents or user identity.
- Keys are scoped per `talosId` at the DB level — the same UUID can be reused safely across
  different agents.
- The partial unique index prevents brute-force key squatting across unrelated requests.
- Key length is validated: values longer than 128 bytes are rejected with 400 to prevent
  header-size abuse.
- The server echoes the key in the response header but never logs the request payload.

---

## Limitations

- In-memory rate-limit store (`rate-limit.ts`) is per-process. Key uniqueness enforcement is at
  the DB level via the partial unique index, which is single-source-of-truth and works across
  multiple Vercel instances.
- Key expiry is not implemented. Long-running deployments accumulate one `idempotencyKey` column
  value per job. This is fine at current scale; a background cleanup job can be added later if
  needed.
- The Python SDK generates a new key per call object (not per connection). If an agent restarts
  mid-retry, the new process generates a new key and the previous in-flight request may complete
  independently. The server's partial unique index prevents duplicate commits in this case.

---

## Test Coverage

| File | What it covers |
|---|---|
| `web/tests/commerce-jobs-idempotency.test.ts` | Server-side key lookup, cache hit, payload conflict, race condition, backward compat |
| `web/tests/buy-token-idempotency.test.ts` | txHash natural key, completed replay, in-flight 409, concurrent race, atomic transaction |
| `packages/sdk/tests/idempotency.test.ts` | Key generation, format validation, `IdempotencyConflictError`, retry with key, 409 handling |
| `packages/prime-agent/tests/test_idempotency.py` | Key generation, auto-inject, opt-out, conflict detection, retry with stable key |
| `web/tests/sdk-idempotency-integration.test.ts` | End-to-end: SDK generates key → server accepts → replay returns cached response |

---

## Files Changed

```
docs/idempotency-design.md                          (this file)
packages/sdk/src/idempotency.ts                     new — key generation + error type
packages/sdk/src/client.ts                          modified — WriteOptions, retry POST, inject header
packages/sdk/src/types.ts                           modified — IdempotencyConflictError export
packages/sdk/src/index.ts                           modified — re-export new types
packages/sdk/tests/idempotency.test.ts              new — unit tests
packages/prime-agent/src/talos_agent/idempotency.py new — key generation + error type
packages/prime-agent/src/talos_agent/api_client.py  modified — auto-inject on write calls
packages/prime-agent/tests/test_idempotency.py      new — unit tests
web/src/app/api/talos/[id]/jobs/route.ts            modified — echo header, logging
web/src/app/api/talos/[id]/buy-token/route.ts       modified — echo header, logging
web/tests/sdk-idempotency-integration.test.ts       new — integration tests
CONTRIBUTING.md                                     modified — idempotency section
OBSERVABILITY.md                                    modified — idempotency log events
```
