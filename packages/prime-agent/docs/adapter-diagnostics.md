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

## Adapter recovery queue and operator disposition

When external network or provider operations time out or experience ambiguous transport
disruptions after transmission begins, publications transition to an `indeterminate` state.
To preserve at-most-once delivery and prevent duplicate public posts, the system **never
silently retries an action that may already have succeeded**.

Instead, indeterminate and lease-expired publications enter the `AdapterRecoveryQueue`
awaiting explicit operator disposition.

### Inspecting uncertain publications

Use `AdapterRecoveryQueue(db).list_uncertain()` or `registry.recovery_queue.list_uncertain()`:

```python
queue = registry.recovery_queue
uncertain_items = queue.list_uncertain(limit=50)
for item in uncertain_items:
    print(item.operation_id, item.adapter_name, item.safe_actions)
```

Each `UncertainPublication` reports:
- `operation_id`: Unique idempotency key.
- `adapter_name`: Channel adapter identifier.
- `operation`: Adapter action (e.g., `post`, `reply`).
- `input_digest`: SHA-256 hash of outbound payload.
- `state`: Current state (`indeterminate` or expired `running`).
- `attempt_count`: Total transmission attempts made.
- `lease_expires_at`: ISO timestamp when invocation lease expired.
- `safe_actions`: Explicit allowed dispositions:
  - `resolve_succeeded`: Confirm external publication succeeded out-of-band.
  - `resolve_failed`: Confirm external publication failed without publishing.
  - `abandon`: Discard without further retry.
  - `retry`: Explicitly re-authorize retry; transitions record to `failed` so it may be re-admitted without silent background retries.

### Applying operator disposition

```python
result = queue.apply_disposition(
    operation_id="post-abc-123",
    disposition="resolve_succeeded",  # or OperatorDisposition.RESOLVE_SUCCEEDED
    operator="ops-admin",
    reason="Confirmed live post visible on platform feed",
)
```

Attempting to apply a disposition to an actively running or already terminal operation
raises a `ValueError`. Automatic background loops are strictly forbidden from silently
re-executing indeterminate publications.


