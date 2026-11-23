# Registry Migration Compatibility Manifest

Synthetic fixtures that publish the old → new schema-key mapping for
`TalosRegistry` storage keys across the v1 → v2 storage migration, and let a
non-Rust operator audit the upgrade without a live network.

## Scope

- `manifest.json` — the compatibility manifest: one row per `DataKey` variant
  with its v1 and v2 representation and a `changed` flag. Only `TimelockConfig`
  changes (implicit `unwrap_or` default → explicitly persisted); every other
  key is byte-identical across the upgrade, so ownership (`CreatorOf`) and
  name-bearing records (`Talos`) are preserved.
- `v1_storage_keys.json` — the synthetic v1 (`SCHEMA_GENESIS = 1`) key set.
  `TimelockConfig` is absent (resolved via `get_timelock_config`'s
  `unwrap_or` default).
- `v2_storage_keys.json` — the synthetic v2 (`SCHEMA_TIMELOCK_DEFAULTS = 2`)
  key set. `TimelockConfig` is present with the backfilled default
  (`min_delay = 0`, `grace_period = 604800`).

## Acceptance mapping

- **Publish old and new schema key mappings:** `manifest.json` lists every
  `DataKey` with its v1 and v2 form; the focused test module
  (`registry_migration_manifest.rs`) parses all three documents with `serde_json`
  and asserts the manifest agrees with the v1/v2 key sets.
- **Validate ownership and name uniqueness after a simulated upgrade:** the
  test module creates a `TalosRegistry` instance, registers two Talos, runs
  `run_migrations` (the simulated v1 → v2 upgrade) and asserts
  `creator_of(id)` (ownership) and the two distinct `Talos.name` values
  (name uniqueness) are unchanged after the upgrade.

Run focused Rust contract tests with synthetic data — no network:

```bash
cargo test -p talos-registry --lib registry_migration_manifest -- --nocapture
```

## Regeneration

The manifest and key sets are deterministic synthetic JSON, hand-authored to
mirror `DataKey` in `contracts/talos_registry/src/lib.rs` and the v1 → v2
`run_migrations` step. When a new schema version is added, append its row to
`manifest.json`, add a `vN_storage_keys.json`, and update `from_version` /
`to_version`.
