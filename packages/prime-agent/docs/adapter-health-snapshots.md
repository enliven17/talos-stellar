# Typed adapter health snapshots

Every adapter and payment kit exposes a side-effect-free
`health_snapshot()` method reporting its in-process readiness (credentials
present, proxy initialized, browser session live, etc.) to the probes in
`talos_agent.adapters.health`. As of this change, `health_snapshot()`
returns one of the frozen dataclasses in `talos_agent.adapters.snapshots`
instead of an ad-hoc `dict[str, bool]`.

| Adapter / kit | Snapshot type | Fields |
| --- | --- | --- |
| `DiscordAdapter` | `DiscordHealthSnapshot` | `has_webhook`, `has_token`, `has_channel` |
| `TelegramAdapter` | `TelegramHealthSnapshot` | `has_token`, `has_chat` |
| `XAdapter` | `XHealthSnapshot` | `has_username`, `has_password`, `browser_live` |
| `StellarKit` | `StellarHealthSnapshot` | `has_api`, `initialized` |
| `X402Signer` | `X402HealthSnapshot` | `has_api`, `initialized`, `has_wallet` |

Every snapshot type has a `to_dict()` method for logging/CLI/telemetry
serialization, matching the existing `ProbeResult`/`WalHealthReport`/
`CircuitBreakerMetrics` convention.

## Backward compatibility

`health_snapshot()` is called through `_snapshot_field`/`_snapshot_bool` in
`talos_agent.adapters.health`, which accept either shape:

- a typed `*HealthSnapshot` dataclass (attribute access), or
- a legacy `dict[str, bool]` (key lookup, for any adapter — custom,
  third-party, or not yet migrated — that still returns a plain dict).

A missing field, a `None` snapshot, or a `health_snapshot()` call that
raises all fall back to introspecting the adapter's own private attributes,
exactly as before this change — a probe never crashes or hangs on a
misbehaving snapshot. `SandboxedAdapter.health_snapshot()` (the capability
sandbox proxy) forwards whatever the wrapped adapter returns unchanged, so
it works with both shapes without modification.

This is an additive, non-breaking change: no caller that consumed the old
`dict[str, bool]` return value (via `.to_dict()`-shaped serialization, or by
reading known keys) needs to change.
