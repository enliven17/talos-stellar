## Summary

Replace generic `TalosAPIError` request failures with an actionable, backward-compatible typed error hierarchy for `@talos-protocol/sdk`. Every typed error remains an `instanceof TalosAPIError`, so existing catch blocks keep working unchanged. New fields surface retry hints, validation issues, parsed x402 challenges, rate-limit counters, request-ids, and sanitized response headers for callers that want to react per failure mode.

This is a production-grade improvement for the Talos protocol: it preserves existing public behavior while addressing failure recovery, bounded concurrency, observability, secure defaults, and operational rollout.

## Motivation

- Generic `TalosAPIError(status, body, path)` forces every consumer to introspect `status` and parse `body` themselves — no shared, stable contract for known failures.
- Network and timeout failures were raw `Error`s (or AggregateError wrappers) so retry logic couldn't safely rely on `err.isRetryable`.
- 5xx bodies, retry-after hints, and rate-limit counters were discarded on the client — observability had to be re-implemented per caller.
- Sensitive fields (`token`, `authorization`, `apiKey`, `signature`, …) could leak through logs/payloads when callers stringified the error body.

## Changes

### New typed error hierarchy (`packages/sdk/src/errors.ts`)

All errors extend `TalosAPIError` so legacy `catch (e: TalosAPIError)` and `rejects.toThrow(…)` patterns keep working.

| Status | Type | Code | Retryable | Extra fields |
| --- | --- | --- | --- | --- |
| 400 | `TalosValidationError` | `validation_error` | no | `issues: string[]` |
| 401 | `TalosAuthenticationError` | `authentication_error` | no | — |
| 402 | `TalosPaymentError` | `payment_error` | no | `challenge?: { price, payee, token, … }` |
| 403 | `TalosForbiddenError` | `forbidden` | no | — |
| 404 | `TalosNotFoundError` | `not_found_error` | no | — |
| 409 | `TalosConflictError` | `conflict_error` | no | `data.detail?` |
| 429 | `TalosRateLimitError` | `rate_limit_error` | yes | `retryAfterMs`, `limit`, `remaining`, `resetAt` |
| 500 | `TalosServerError` | `server_error` | no | — |
| 502/503/504 | `TalosServerRetryableError` | `server_error` | yes | — |
| network | `TalosTransportError` | `transport_error` | yes | `cause?` |
| abort/timeout | `TalosTimeoutError` | `timeout_error` | yes | — |

Every error exposes:
- `code` — stable string discriminator for `switch`-style handling
- `isRetryable` — bounded retry hint
- `retryAfterMs?` — server `Retry-After` already normalized to ms
- `requestId?` — `x-request-id` for log correlation
- `headers` — sanitized subset (`x-request-id`, `retry-after`, `www-authenticate`, `x-ratelimit-*`)
- `data` — parsed JSON body, redacted + size-capped (`≤ MAX_DATA_BYTES = 4096`) at construction
- `body` — single-line, secrets redacted, capped at `MAX_BODY_BYTES = 1024`
- `cause` — original transport error if wrapped
- `timestamp` — ISO 8601 string captured at construction
- `toJSON()` — bounded log-friendly projection (omits `body` and `data`)

### Privacy and safety primitives (`packages/sdk/src/errors.ts`)

- **`sanitizeBody(raw)`** — parses JSON, runs `redactSecrets`, truncates to `MAX_BODY_BYTES`. Non-JSON bodies are collapsed to single line, truncated.
- **`redactSecrets(value)`** — recursive, cycle-safe (WeakSet). Replaces fields whose name matches `/^(token|authorization|secret|api[_-]?key|password|cookie|signature|message|nonce|hash)$/i` with `"[REDACTED]"`.
- **`snapshotHeaders(headers)`** — pulls a fixed safe subset (no `authorization`, no cookies, no arbitrary user headers).
- **`parseRetryAfter(value)`** — accepts seconds or HTTP date, returns ms.
- **`parseX402Challenge(header)`** — requires `price` and `payee`; rejects partial challenges before they reach the downstream `/sign` call.

### Client refactor (`packages/sdk/src/client.ts`)

- **Bounded timeout** via `AbortController` — opt-in `timeoutMs`; `acquireTimeoutController()` returns `{ signal, dispose }` and the request helper calls `dispose()` in a `finally` so successful responses don't leak `setTimeout` handles.
- **Bounded retry** via `retry.maxAttempts` — only retries idempotent (`GET`/`HEAD`) by default; honors server `Retry-After` (clamped to `maxRetryAfterMs`, default 60s) with exponential backoff (`baseDelayMs * 2^(n-1)`, capped `maxDelayMs`, default 8s) and ±25% jitter. Hard cap of 8 attempts regardless of user input. Validation/auth/conflict/payment errors are never retried.
- **`onError` / `onRetry` observers** — fire-and-forget callbacks for central logging/metrics. `onError` fires once per failed call with `{ error, path, method, attempt, durationMs }`.
- **`fetch` injection** — `TalosClientOptions.fetch` allows swap-in middleware. `globalThis.fetch` is resolved lazily on each request so `vi.stubGlobal("fetch", …)` keeps intercepting in tests.
- **Lazy `resolveFetch()`** — fixes a regression where eager capture at construction broke test mocks.
- **Plain-object `mergeHeaders`** — preserves the legacy `toHaveProperty("Authorization", …)` test contract.
- **`purchaseServiceWithPayment`** x402 flow now:
  - parses challenge via `parseX402Challenge` (which requires `price`+`payee`);
  - guards `Number.isFinite(amount)` so `price="abc"` never feeds `NaN` to `/sign`;
  - delegates the signed retry to `request()` so timeout/retry/typed errors apply uniformly.

- **`errorFromResponse` dispatcher** — pure function mapping `(status, body, headers)` → typed subclass; shared between `request()` and `purchaseServiceWithPayment`'s non-402 paths.
- **`classifyTransportError(cause, path)`** — wraps raw `fetch` rejections into `TalosTransportError` / `TalosTimeoutError`, falls back to `DOMException({name:"AbortError"})` and message-based timeout heuristic. Original message is preserved so legacy `rejects.toThrow("Aborted")` assertions stay green.

### Documentation (`packages/sdk/README.md`)

New **Error Handling** section covering:
- The `TalosErrorCode` discriminator list with retries-per-type
- Two example `catch` block patterns (`instanceof` and `code` `switch`)
- Retry, timeout, and observability configuration tables
- Privacy guarantees (`MAX_BODY_BYTES`, redaction, no request bodies)
- Migration / rollback narrative — explicitly "fully backward-compatible, no server-side migration required"

### Tests (`packages/sdk/tests/client.test.ts`)

- **All 29 pre-existing tests pass unchanged** (legacy message strings, header shape, `instanceof TalosAPIError`).
- **31 new typed-error tests cover**:
  - Validation error parses server `issues[]` and exposes `code/requestId/data`
  - 401 → `TalosAuthenticationError` (≠ 403), 403 → `TalosForbiddenError` (with `not.toBeInstanceOf(TalosAuthenticationError)` regression guard)
  - 404 → `TalosNotFoundError`; 409 → `TalosConflictError` (with `data.detail`)
  - 402 → `TalosPaymentError` with structured `challenge{}`
  - 429 → `TalosRateLimitError` capturing `Retry-After` + `X-RateLimit-*` headers
  - 500 → `TalosServerError` (non-retryable); 503 → `TalosServerRetryableError`
  - Secret redaction: nested fields, cycle-safe `redactSecrets`, oversized-body truncation
  - Transport classification: `ECONNREFUSED` / `AbortError` / message-based timeout
  - Bounded timeout (`vi.useFakeTimers` + AbortSignal listener)
  - **Bounded retry**:
    - rate-limited GET retried until `maxAttempts`
    - **POST not retried** by default (idempotent guard)
    - `onRetry` + `onError` observers invoked correctly
    - **`maxAttempts` hard-capped at 8** (user can request more, cap holds)
    - non-retryable errors fail immediately
    - **success after transient retry** (returns 2nd mock)
    - **timer `clearTimeout` on success** (no leaked `setTimeout` handles)
  - Helper coverage: `errorFromResponse` matrix, `sanitizeBody`, `redactSecrets` cycle, `parseRetryAfter`, `parseX402Challenge`, `classifyTransportError`, `toJSON()`
  - Backward-compat aliases: every typed error `instanceof TalosAPIError`; legacy 502/503/504 message retains status code in string

## Related Issues

Closes #253

## Test Plan

- [x] All existing SDK tests pass unchanged (29/29)
- [x] All new typed-error tests pass (31/31, total 60/60)
- [x] `tsc` build is clean — no type errors
- [x] Verified manually with focused scripts:
  - Confirmed every typed error is `instanceof TalosAPIError`
  - Confirmed legacy message strings (`"Network error"`, `"Aborted"`, `"Request timeout"`, `"Invalid x402 challenge"`) are preserved on the new typed errors
  - Confirmed redaction removes bearer tokens, api keys, signatures, and Stellar secret seeds from `body` and `data`
  - Confirmed bounded retry never retries validation/auth/conflict/payment errors
  - Confirmed `timeout?.dispose()` runs in `finally` (success and failure paths)

## Backward compatibility

- `TalosAPIError` constructor signature `(status, body, path)` is unchanged — existing `catch (e: TalosAPIError)` and `rejects.toThrow(…)` patterns keep working.
- All public SDK methods keep their signatures and return types.
- New `TalosClientOptions` fields (`timeoutMs`, `retry`, `onError`, `fetch`) are all optional with defaults that match the previous behavior.
- `TalosAPIError.toJSON()` strips `body` and `data` to avoid leaking large payloads through structured log sinks.
- Rollback: revert the SDK version pin in `package.json`. No server-side migration is required.

## Out of scope

No visual redesign, no live deployment, no real credentials, no broad dependency upgrades.

## Checklist

- [x] I have read the `CONTRIBUTING.md` guide.
- [x] My code follows the style guidelines of this project.
- [x] I have commented my code in JSDoc, particularly on the typed error semantics.
- [x] I have made corresponding changes to `packages/sdk/README.md`.
- [x] My changes generate no new warnings or errors.
- [x] I have added tests that prove the new typed hierarchy works.
- [x] New and existing unit tests pass locally with my changes (60/60).
- [x] This change is fully backward-compatible.
