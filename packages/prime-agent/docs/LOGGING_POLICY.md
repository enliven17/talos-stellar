# Talos Prime Agent — Logging Policy

This document specifies **what is safe to log** and **what must always be
redacted** in the Talos prime-agent.  It is the definitive reference for
contributors adding or modifying code that emits log output.

---

## Guiding principles

1. **Redact before serialize.**  Redaction is applied to every structured log
   event *before* it is serialized by the structlog `JSONRenderer`.  No
   downstream sink (stdout, Sentry, OpenTelemetry) ever receives a raw secret.

2. **Single source of truth.**  All patterns and keyword lists live in
   [`talos_agent/redact.py`](../src/talos_agent/redact.py).  Do not copy-paste
   keyword sets or regex patterns into other modules.

3. **Safe fields are never touched.**  Correlation IDs, HTTP status codes,
   transaction hashes, provider names, and error categories are never
   redacted, because they are essential for incident debugging.

4. **Redact exception messages, not just structured fields.**  Any
   `except Exception as e: ... str(e)` path that produces user-facing output
   must route through `redact_text(str(e))` before logging or returning it.

---

## Safe-to-log fields

These fields are explicitly preserved through the structlog pipeline and must
**never** be redacted:

| Field | Type | Purpose |
|---|---|---|
| `trace_id` | string | Distributed tracing correlation (OTEL) |
| `span_id` | string | Distributed span correlation (OTEL) |
| `job_id` | string | Commerce / async job correlation |
| `talos_id` | string | Agent identity for multi-agent logs |
| `level` | string | Log severity |
| `timestamp` | string | ISO 8601 event time |
| `event` | string | Human-readable log message (redacted by value patterns) |
| `provider` | string | LLM / API provider name (e.g. `groq`, `openai`) |
| `status_code` | int | HTTP response status code |
| `retry_count` | int | Number of retry attempts |
| `attempt_number` | int | Retry attempt index |
| `duration_ms` | float | Operation duration |
| `amount` | number | Payment value in USDC smallest units |
| `asset_code` | string | Stellar asset symbol (`USDC`, `XLM`) |
| `payee` | string | Public Stellar address (`G…` + 55 chars) |
| `error_category` | string | Error classification for alerting |
| `error_type` | string | Python exception class name |
| `transaction_hash` | string | On-chain transaction identifier |
| `account_id` | string | Public Stellar account ID |
| `service_type` | string | Commerce service name |
| `adapter` | string | Adapter name (e.g. `discord`, `x`) |
| `balance` | number | Wallet balance (XLM or USDC) |

---

## Redacted fields — NEVER log these values

These fields must be replaced with `"[REDACTED]"` in all log output:

### Stellar / cryptographic material

| Pattern | Examples |
|---|---|
| Stellar secret key (`S` + 55 Base32 chars) | `SCZANGBA5RLGSRSGIEASPY53FKNCZMXNXNIQHPKWI27BKYPPJCAAAAA` |
| Field named `stellar_secret` / `stellar_key` | Any field with these key names |
| Field named `wallet_secret` / `wallet_key` | Wallet private material |
| Field named `private_key` / `privateKey` | Raw private key material |
| Field named `seed` | Deterministic key seed |
| Field named `mnemonic` | BIP-39 seed phrase |
| Field named `signing_key` | Signing key material |
| `ENC::…` envelope | Encrypted-at-rest key material stored in DB |

### API authentication

| Pattern | Examples |
|---|---|
| `Bearer <token>` in any string | `Authorization: Bearer sk-live-abc123` |
| `Token <value>` in any string | `Token sk-proj-xyz` |
| Field named `api_key` / `apiKey` / `apikey` | Groq, OpenAI, Talos API keys |
| Field named `authorization` / `auth` | HTTP Authorization header |
| Field named `token` / `access_token` / `refresh_token` | OAuth tokens |
| Field named `password` | Plaintext passwords |
| `key=<value>` / `secret=<value>` pattern in free text | Generic KV credential pairs |

### x402 / payment proofs

| Pattern | Examples |
|---|---|
| Field named `x-payment` / `x_payment` | x402 signed payment proof (JWT-like) |
| Field named `payment_header` / `paymentHeader` | Signed authorization header sent to service |
| Field named `payment_proof` / `proof` | Raw x402 proof object |
| Free-text `x-payment=<value>` pattern | Echoed payment headers in error bodies |

### Prompts and inference inputs

| Field | Reason |
|---|---|
| `prompt` / `user_prompt` / `system_prompt` | May contain PII or business logic |

---

## How redaction works

### 1. Structlog pipeline (all structured log calls)

`observability.configure_logging()` inserts `redact_event_dict` **before**
`JSONRenderer`:

```
merge_contextvars → add_log_level → TimeStamper → inject_trace_context
→ redact_event_dict          ← RUNS HERE
→ JSONRenderer               ← serializes only after redaction
```

`redact_event_dict` (in `redact.py`):
- Replaces any field whose **key name** is in `REDACT_FIELD_NAMES` or matches
  `is_sensitive_key()` with `"[REDACTED]"`.
- Recursively walks `dict` and `list` values.
- Passes string values through `redact_value()` to catch embedded secrets.
- Passes the `event` message through `redact_text()` to catch `key=value`
  patterns in free-form strings.

### 2. HTTP retry logs (`http.py`)

`_log_before_sleep` calls `_sanitize_response_text` (aliased to `redact_text`)
on the response body before including it in the warning log.  Redaction runs
before truncation to prevent partial token leakage at the truncation boundary.

### 3. Fallback chain exception summaries (`routing/fallback.py`)

`_summarise_exception` calls `_sanitize_response_text` on the exception
string **before** truncation for the same reason.

### 4. Discord adapter error responses (`adapters/discord.py`)

`resp.text[:200]` in webhook/bot-API error paths is passed through
`_redact_text()` before it is embedded in the `PublishResult.error` string.

### 5. x402 signer exceptions (`payments/x402_signer.py`)

`str(e)` in exception catches is passed through `_redact_text()` before
being returned in the error dict.

### 6. Stellar kit exceptions (`payments/stellar_kit.py`)

Exception messages in all error returns are sanitized via `_redact_text()`.

---

## Adding new log calls — contributor checklist

When adding a new `log.*()` call or an `except … return {"error": ...}` path:

- [ ] **Keys**: use safe field names from the table above.  If you need a new
  field that might contain sensitive data, add it to `REDACT_FIELD_NAMES` in
  `redact.py`.
- [ ] **Values**: never embed raw exception messages, response bodies, or
  header values directly.  Route strings through `redact_text(str(e))`.
- [ ] **Test**: add a test in `tests/test_redact.py` that asserts the secret
  value does not appear in the logged / returned output.

---

## Module map

| Module | Role |
|---|---|
| `talos_agent/redact.py` | Canonical patterns, `is_sensitive_key`, `redact_value`, `redact_json_value`, `redact_text`, `redact_event_dict` |
| `talos_agent/observability.py` | Wires `redact_event_dict` into the structlog pipeline |
| `talos_agent/http.py` | Imports `redact_text` / `redact_json_value` from `redact.py`; applies to retry log bodies |
| `talos_agent/routing/fallback.py` | Imports `redact_text` from `redact.py`; applies to exception summaries |
| `talos_agent/telemetry.py` | Imports `is_sensitive_key` from `redact.py`; guards metric labels |
| `talos_agent/adapters/discord.py` | Applies `redact_text` to `resp.text` in all error paths |
| `talos_agent/payments/x402_signer.py` | Applies `redact_text` to exception messages |
| `talos_agent/payments/stellar_kit.py` | Applies `redact_text` to exception messages |
| `tests/test_redact.py` | 103 tests covering all categories and integration paths |
