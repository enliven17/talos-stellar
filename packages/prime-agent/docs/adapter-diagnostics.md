# Adapter diagnostic log schema

The adapter capability sandbox emits only `adapter_sandbox_invocation`,
`adapter_capability_denied`, and `adapter_resource_limit`. Unknown fields are
dropped before logging.

| Field | Maximum | Handling |
| --- | ---: | --- |
| `adapter` (provider) | 64 chars | identifier characters only; case-preserving safe display value |
| `account` (remote account) | 64 chars | identifier characters only; case-preserving safe display value |
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

## Adapter configuration reload preview

To safely inspect changes to channel adapters without executing external side-effects
or connecting to third-party networks, call `AdapterRegistry.preview_reload(candidate)`.

The preview validates candidate configuration entirely in-process without contacting
remote networks or requiring external credentials. It calculates channel diffs,
capability changes, and affected scheduled tasks.

### Preview response schema

`preview_reload` returns an `AdapterReloadPreview` structure (also serializable via `.to_dict()`):

| Field | Type | Description |
| --- | --- | --- |
| `valid` | boolean | Whether candidate configuration is structurally valid |
| `has_changes` | boolean | True if any channel was added, removed, or modified |
| `added_channels` | string[] | Channel names present in candidate but not current |
| `removed_channels` | string[] | Channel names present in current but not candidate |
| `modified_channels` | string[] | Channel names whose capabilities changed |
| `unchanged_channels` | string[] | Channel names whose capabilities are identical |
| `capability_diff` | object | Per-channel capability differences (`before`, `after`, `differences`) |
| `affected_scheduled_tasks` | string[] | Scheduled tasks impacted by the configuration changes |
| `validation_errors` | string[] | Error messages describing invalid candidate configuration |

### Affected scheduled tasks

When adapter channels or capabilities change, the preview flags affected scheduler tasks:
- `agent_cycle`: impacted whenever social channel adapters or capabilities change.
- `learning_cycle`: impacted whenever social channel adapters change.
- `telemetry_log`: impacted whenever any channel adapter is added, removed, or changed.
- `telegram_queue`: impacted whenever the Telegram adapter is added, removed, or modified.

