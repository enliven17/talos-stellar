# Adapter registration and capability conflicts

`AdapterRegistry` in
[`adapters/registry.py`](../src/talos_agent/adapters/registry.py) maps a
case-insensitive `channel_name` to a single adapter instance. It is populated
while the agent's tools are built at startup, before any task can publish.

## Idempotent registration

Registering the same adapter again, or registering another adapter for the same
channel with identical `ChannelCapabilities`, is idempotent. The first adapter
is kept and no error or warning is emitted, so restart and re-initialisation
paths can safely repeat an explicit registration.

## Conflicting capabilities

A second adapter for the same channel whose capabilities differ is a capability
conflict. Nothing is replaced; the existing adapter stays registered. The
conflict is handled according to `AdapterRegistry(on_duplicate=...)`:

| `on_duplicate` | Behaviour |
| --- | --- |
| `"raise"` (default) | Raise `AdapterCapabilityConflictError`, a `ValueError` subclass, so the misconfiguration fails startup. |
| `"warn"` | Log a warning and keep the existing adapter. |
| `"skip"` | Keep the existing adapter without logging. |

Use `AdapterRegistry.replace(adapter)` when swapping an adapter is intentional,
for example when rotating credentials or switching environments. `replace()`
never raises on a pre-existing entry and returns the previous adapter, if any.
