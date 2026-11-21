# Agent Identity Export Fixtures

Deterministic synthetic fixtures for offline ownership verification of a
Talos agent identity. No live network — these are checked-in JSON vectors.

## Record shape

An `AgentIdentity` binds the registry contract, the agent's on-chain id, its
human-readable name, its owner (the Talos creator) and the Stellar network it
was exported against:

| Field         | Type             | Notes                                              |
|---------------|------------------|----------------------------------------------------|
| `kind`        | `"AgentIdentity"` | Tag identifying the vector kind.                  |
| `registry_id` | `String` (StrKey) | `G…`/`C…` account/contract address, 56 chars.     |
| `talos_id`    | `u32`            | The agent's stable on-chain identifier.            |
| `name`        | `String`         | Human-readable name (3-32 lowercase alnum/hyphen). |
| `owner`       | `String \| null` | `G…` creator address, or `null` when unregistered. |
| `network`     | `String`         | Stellar network the export is bound to.            |
| `exported_at` | `u64`            | Deterministic timestamp for the offline vector.    |

## Layout

```
agent_identity/
  positive/
    agent_identity_001.json            # fully populated record
    agent_identity_002_null_owner.json # owner null (talos not yet registered)
  malformed/
    missing_registry_id.json           # required field absent
    wrong_type_talos_id.json           # talos_id not a u32
    invalid_registry_address.json      # registry_id not a valid StrKey
    empty_name.json                    # name must be non-empty
    invalid_owner_address.json         # owner present but not a valid G… address
```

## Acceptance mapping

- **Deterministic positive vectors:** `positive/*.json` parse against the
  serde mirror and pass `verify_agent_identity` (registry_id 56-char StrKey,
  name non-empty, network non-empty, owner null-or-valid `G…`).
- **Malformed vectors:** `malformed/*.json` are rejected — either by serde
  (wrong type / missing field) or by `verify_agent_identity` (invalid address,
  empty name) — with an actionable error naming the file.
- **On-chain binding:** `TalosRegistry::export_agent_identity(talos_id, name,
  network)` binds `registry_id = current_contract_address()`, `owner =
  creator_of(talos_id)` and `exported_at = ledger timestamp`. The focused
  test module (`agent_identity_export.rs`) asserts the bound record matches
  on-chain state for a freshly registered Talos.

Run focused Rust contract tests with synthetic data — no network:

```bash
cargo test -p talos-registry --lib agent_identity_export -- --nocapture
```
