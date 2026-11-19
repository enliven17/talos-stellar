# Adapter diagnostic log schema

The adapter capability sandbox emits only `adapter_sandbox_invocation`,
`adapter_capability_denied`, and `adapter_resource_limit`. Unknown fields are
dropped before logging.

| Field | Maximum | Handling |
| --- | ---: | --- |
| `adapter` (provider) | 64 chars | identifier characters only |
| `operation` | 64 chars | built-in adapter operations only |
| `operation_id` | 128 chars | identifier characters only |
| `outcome` (status) | 32 chars | `succeeded`, `failed`, `timed_out`, or `denied` |
| `error_type` / `error` | 256 chars | type is an identifier; text is redacted then capped |
| `capability` / `resource` | 32 chars | fixed allowlists |
| `target` | 128 chars | redacted then capped |
| `duration_ms` | 3,600,000 | locally computed finite number |

Unexpected categorical values become `unknown`. Control characters are replaced
with spaces so values cannot alter log records. Sensitive keys (tokens,
secrets, passwords, API keys, cookies, credentials, and similar names) are
redacted recursively in nested error metadata before truncation. The schema is
logging-only and does not affect retry, fallback, circuit-breaker, or adapter
execution decisions.
