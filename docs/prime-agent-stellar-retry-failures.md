# Prime Agent — Stellar transaction retry failure classification

This runbook describes how the Prime Agent classifies failures that occur while
it submits Stellar transactions (XLM/token transfers, dividend distribution,
loan repayment) and how contributors and operators should consume the result.

The single source of truth is
[`packages/prime-agent/src/talos_agent/payments/stellar_retry.py`](../packages/prime-agent/src/talos_agent/payments/stellar_retry.py).
Do not re-implement classification heuristics per call site — call
`classify_stellar_failure(...)` / `classify_stellar_result(...)` instead.

## Classes

| Class | Meaning | `retryable` | `indeterminate` | `terminal` |
| --- | --- | --- | --- | --- |
| `retryable` | Transient dependency failure (transport/connect error, upstream 5xx). | yes | no | no |
| `rate_limited` | Upstream throttling (HTTP 429). Retry after backoff. | yes | no | no |
| `indeterminate` | Timed out after submission — the transaction may have landed. | no | yes | no |
| `permanent` | Terminal failure (bad request, auth, insufficient funds, conflict). | no | no | yes |
| `unknown` | Malformed or unclassifiable input. Operator review required. | no | no | no |

Only `retryable` and `rate_limited` are safe to feed back into the existing
bounded retry loop — the flag mirrors
`talos_agent.http.RETRYABLE_STATUSES`, so the class and the retry policy can
never disagree.

## Input → class mapping

The classifier inspects only *bounded* signals:

- an explicit HTTP `status_code`,
- the *type* of the exception that aborted the call (never its message),
- an optional upstream `error_code` that matches `^[a-z][a-z0-9_]{0,63}$`.

| Input | Class | `failure_code` |
| --- | --- | --- |
| `429` | `rate_limited` | `rate_limited` |
| `502` / `503` / `504` | `retryable` | `upstream_unavailable` |
| `401` / `403` | `permanent` | `unauthorized` |
| `402` | `permanent` | `insufficient_funds` |
| `404` | `permanent` | `not_found` |
| `409` | `permanent` | `conflict` |
| other `4xx` | `permanent` | `invalid_request` |
| `500` / other `5xx` | `unknown` | `server_error` |
| `httpx.TimeoutException`, `TimeoutError` | `indeterminate` | `submission_timeout` |
| `httpx.TransportError` | `retryable` | `transport_unavailable` |
| `CircuitBreakerOpen` | `retryable` | `circuit_open` |
| `RetryableHTTPError` | derived from its status | e.g. `upstream_unavailable` |
| anything else / missing / malformed | `unknown` | `unclassified` |

Explicit, recognized `error_code` values take precedence and are interpreted
from a fixed allow-list (`insufficient_funds`, `tx_bad_auth`,
`invalid_destination`, `submission_timeout`, …). Codes outside the allow-list
are **not** echoed back — the result degrades to `unknown` / `unclassified`.

## Privacy guarantees

- `message` is chosen from a fixed per-class table. It never interpolates
  exception text, response bodies, Stellar secret seeds, x402 payment proofs,
  or wallet material.
- The classifier only reads an exception's *type*, never `str(exc)`.
- Tool results and the payment proxy replace raw upstream error strings with
  the safe message and expose only bounded fields:
  `failure_class`, `failure_code`, `retryable`, `indeterminate`, `terminal`.
- The classification is registered in the agent's state-classification
  registry as `DERIVED` (runtime only) and is never written into a checkpoint.

## Consuming a classification

```python
from talos_agent.payments.stellar_retry import classify_stellar_failure

failure = classify_stellar_failure(status_code=response.status_code)
if failure.retryable:
    ...            # safe to retry with backoff
elif failure.indeterminate:
    ...            # reconcile against the chain before retrying
else:
    ...            # terminal — do not retry without changing the inputs
```

`StellarKit` and the Stellar tools return the classification fields alongside
the legacy `error` key, so `if "error" in result:` style checks keep working.
The worker-lifecycle loan-repayment task aggregates counts per class into
`result["failure_classes"]`.

## Compatibility and migration

- **No schema migration and no new environment variables.** The change is
  additive to return payloads.
- The historical `{"status": "submitted", ...}` success shape and the `error`
  key on failures are preserved; existing callers are unaffected.
- The classification is computed at call time from the failure itself, so
  there is nothing to backfill.

## Operational impact

- Operators can distinguish a transient Stellar/provider outage (`retryable`,
  `rate_limited`) from a terminal input error (`permanent`) without reading raw
  upstream text.
- `indeterminate` failures must be reconciled before retrying to avoid a
  double-spend. Treat them as "possibly already submitted".
- Rollback: revert the commit. No durable state is written by this feature.
