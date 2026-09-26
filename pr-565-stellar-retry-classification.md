# feat(agent): classify Stellar transaction retry failures

Closes #565

## Summary

Adds a single, privacy-safe classification for Stellar transaction retry
failures so contributors and operators can tell — deterministically — whether a
failed Stellar transaction (`transfer`, dividend distribution, loan repayment)
is safe to retry, must be reconciled, or is terminal.

Every failure now resolves to exactly one class via a new
`talos_agent.payments.stellar_retry` module, which is the **single source of
truth** consumed by the Web API adapter, the `StellarKit` payment proxy, the
Stellar tools, and the worker-lifecycle loan-repayment task. The change is
additive: the historic `{"status": "submitted", ...}` success shape and the
`error` key on failures are preserved, so no existing caller breaks.

This is a production-grade improvement: it addresses failure recovery,
predictable retry semantics, privacy-safe errors, and operational visibility
without introducing a parallel source of truth.

## Motivation

- Stellar failures were unstructured. `StellarKit.transfer_xlm` returned
  `{"error": f"Transfer failed: {e}"}` (raw exception text) and, worse, treated
  a **Web API error payload as success** because the dict was truthy.
- Retry decisions were implicit and inconsistent: the bounded retry loop knows
  about `429/502/503/504`, but callers had no shared contract for "is this
  retryable?" or "did a timeout maybe already land on chain?".
- Raw upstream text could flow into tool results and durable activity records —
  an avoidable sensitive-data exposure path.
- Operators could not distinguish a transient provider outage from a terminal
  input error without reading upstream payloads.

## Changes

### New classification core — `packages/prime-agent/src/talos_agent/payments/stellar_retry.py`

- `StellarRetryClass` — `retryable`, `rate_limited`, `indeterminate`,
  `permanent`, `unknown`.
- `StellarFailure` — frozen dataclass (`classification`, `code`, `message`) with
  `retryable` / `indeterminate` / `terminal` properties and bounded
  `to_dict()` / `log_fields()` projections.
- `classify_stellar_failure(*, status_code, exc, error_code)` — maps a status,
  an exception **type**, or an explicit bounded error code to a class.
- `classify_stellar_result(result)` — classifies Web API payloads, honouring a
  classification already attached at the API boundary.
- `attach_stellar_failure(result, failure)` — additively merges the
  classification and replaces ``error`` with the safe message.

The classifier only reads *bounded* signals (status code, exception type, and
an allow-listed `error_code`). It never parses free-form server text, so a
noisy or malicious upstream cannot steer the result.

### Input → class mapping

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
| `httpx.TimeoutException` / `TimeoutError` | `indeterminate` | `submission_timeout` |
| `httpx.TransportError` | `retryable` | `transport_unavailable` |
| `CircuitBreakerOpen` | `retryable` | `circuit_open` |
| `RetryableHTTPError` | derived from status | e.g. `upstream_unavailable` |
| missing / malformed | `unknown` | `unclassified` |

Explicit, recognized `error_code` values (`insufficient_funds`, `tx_bad_auth`,
`invalid_destination`, `submission_timeout`, …) take precedence. Unrecognized
codes are **not** echoed back — the result degrades to `unknown`.

`retryable` mirrors `talos_agent.http.RETRYABLE_STATUSES`, so the class and the
existing retry policy can never disagree.

### Boundary wiring

- `api_client.request_transfer` — classifies the failure where the status code
  is known and attaches the fields additively (server fields preserved).
- `payments/stellar_kit.py` — `transfer_xlm`, `get_balance`,
  `get_token_balance` return the classification on failure. Fixes the latent
  "error payload treated as success" bug in `transfer_xlm`.
- `tools/stellar.py` — `execute_approved_transfer` and `airdrop_pulse` surface
  the classification instead of raw upstream text.
- `scheduler.run_loan_repayment` — aggregates counts per class into
  `result["failure_classes"]`; the existing activity message is preserved for
  backward compatibility.

### Durable state

- The classification fields are registered in
  `state_classifications.py` as `DERIVED` (runtime only) — recomputed per call,
  never checkpointed, and explicitly documented as containing no secrets.

## Privacy

- `message` is chosen from a fixed per-class table; it never interpolates
  exception text, response bodies, Stellar secret seeds, x402 payment proofs,
  or wallet material.
- The classifier inspects an exception's *type*, never `str(exc)`.
- Raw upstream error text is replaced with the safe message and only bounded
  fields are returned/logged.

## Compatibility and migration

- **No schema migration and no new environment variables.** Changes are
  additive to return payloads.
- Success shapes and the `error` key on failures are unchanged; existing
  `if "error" in result:` callers keep working.
- The classification is computed at call time from the failure itself, so
  there is nothing to backfill.
- Rollback: revert the commit. The feature writes no durable state.

## Operational impact

- Operators can distinguish transient Stellar/provider outages (`retryable`,
  `rate_limited`) from terminal input errors (`permanent`) at a glance.
- `indeterminate` means "possibly already submitted" — reconcile against the
  chain before retrying to avoid a double-spend.
- No new background tasks, timers, or dependencies.

## Test plan

- [x] New focused suite
      `packages/prime-agent/tests/test_stellar_retry_classification.py`
      (67 tests): positive status/exception mapping, negative malformed input,
      boundary (status range, bool/str status, code length/charset), privacy
      (no seed/proof leakage), regression (`error` key and success shape
      preserved), and integration (`StellarKit` + loan-repayment lifecycle).
- [x] Existing suites unchanged: `test_stellar_integration`,
      `test_tools_integration`, `test_api_integration`, `test_scheduler`,
      `test_state_classify`, `test_state_classify_integration`.
- [x] Focused run: `174 passed` (1 pre-existing, unrelated failure in
      `test_update_status` — `_patch` forwards `idempotency_key` to httpx).
- [x] `ruff check` on affected modules adds **zero** new findings versus `main`.
- [x] Full package suite: failures identical to `main` (62 pre-existing),
      new tests all green.
- [x] External services replaced with dependency-free fakes (`AsyncMock`,
      plain stubs) — no network access in tests.

## Checklist

- [x] I have read the `CONTRIBUTING.md` guide.
- [x] My code follows the style guidelines of this project.
- [x] I have documented the new capability
      (`docs/prime-agent-stellar-retry-failures.md`) and linked it from the
      Prime Agent README.
- [x] I have added tests that prove the classification works.
- [x] New and existing unit tests pass locally with my changes.
- [x] This change is backward-compatible and requires no migration.

## Out of scope

Unrelated dependency upgrades, broad refactors, production credentials, and
unrelated UI redesigns.
