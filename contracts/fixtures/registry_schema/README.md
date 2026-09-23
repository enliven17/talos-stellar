# Registry Schema Fixtures

Fixtures proving registry data remains readable across supported schema versions without a live network.

## Scope

- **Forward lookup:** `TalosNameService::NameRecord(String) → u32`
- **Reverse lookup:** `TalosNameService::TalosName(u32) → String`
- **Ownership:** `TalosRegistry::CreatorOf(u32)` + `Talos.creator` + `Patron` share fields
- **Governance:** `ProtocolWallet`, `ProtocolFeeBps`, `TimelockConfig`, `TimelockProposal`, `PendingAdmin`
- **Additive fields:** `metadata: Option<String>` (v2 additive example) – old fixtures without it must parse as `None`
- **Malformed:** missing fields, wrong types, truncated, invalid sums

## Format

Each fixture is JSON with deterministic synthetic data. No Horizon/RPC.

```jsonc
{
  "meta": {
    "schema_version": 1,          // matches MigrationKey::SchemaVersion
    "contract": "TalosRegistry",  // TalosRegistry | TalosNameService
    "kind": "Talos",              // Talos | NameRecord | TalosName | CreatorOf | TimelockConfig | ProtocolWallet | PatronUpdate
    "additive_fields": [],        // e.g. ["metadata"] when present
    "generator": "scripts/generate-registry-fixtures.mjs"
  },
  "storage_key": {"type": "Talos", "id": 1}, // human mirror of DataKey
  "value": { /* contracttype fields */ }
}
```

### Field encodings
- `Address` → `G...56` string validated by `isValidStellarPublicKey` (StrKey CRC16). Synthetic `G` addresses are deterministic `GAAAA...` with checksum.
- `i128` → JSON string (`"1000000"`) to avoid JS precision loss, parsed as `i128` in Rust.
- `u64`/`u32` → JSON number.
- `Option<T>` additive fields use `null` or missing key → `None` (serde `default`).

See `contracts/talos_registry/src/registry_schema_fixtures.rs` for the authoritative Rust parser (`parse_talos_fixture` etc.) which is used by focused contract tests.

## Directory layout

```
registry_schema/
  schema_versions.json   // manifest
  v1/                    // SCHEMA_GENESIS = 1
    talos_001_genesis.json
    talos_002_minimal.json
    name_forward_001.json
    name_reverse_001.json
    creator_of_001.json
    timelock_config_missing.json
    governance_001.json
  v2/                    // SCHEMA_TIMELOCK_DEFAULTS = 2 (explicit TimelockConfig)
    talos_001_genesis.json
    talos_with_additive_metadata.json
    timelock_config_002.json
    name_forward_001.json
    governance_002.json
  malformed/
    missing_required_field.json
    wrong_type_pulse_price.json
    truncated_xdr.json
    patron_shares_110.json
    invalid_name_double_hyphen.json
    invalid_address.json
```

Each `supported` version parses against current `#[contracttype]` via `parse_*_fixture` – existing fields preserved, additive fields optional.

## Acceptance criteria mapping

- **Each supported version parses against current types:** `cargo test -p talos-registry registry_schema` iterates `v1/*.json` + `v2/*.json` and asserts `parse_talos_fixture(...).is_ok()` with field equality.
- **Existing + additive fields covered:** `v1` has no `metadata`, `v2/talos_with_additive_metadata.json` has `"metadata":"ipfs://..."`. Parser maps missing → `None`, present → `Some`.
- **Incompatible fixtures fail with actionable errors:** `malformed/*.json` tests assert `Err(FixtureError::MissingField(..) | TypeMismatch{field, expected})` with message containing file path + `regen: pnpm fixtures:regen`.
- **Format + regeneration documented:** this README + `scripts/generate-registry-fixtures.mjs`.

## Regeneration

```bash
# Node (preferred – reuses event-fixtures tooling):
pnpm fixtures:gen          # == node scripts/generate-registry-fixtures.mjs
pnpm fixtures:check        # fails if fixtures stale (CI)

# Or Rust (wire-exact, requires soroban-sdk):
cargo run -p registry-fixture-gen -- --check
```

Generator is deterministic: seeded `Address::generate` via `soroban-sdk` testutils, sorted JSON keys, no timestamps.

To add `v3` (example additive `description2`):

1. Bump `talos_registry/src/lib.rs: SCHEMA_FOO = 3`, `CONTRACT_VERSION` minor if additive.
2. Extend `run_migrations` if `current == 2 { begin 2->3; backfill default; complete 2->3 }`.
3. Append `3` to `schema_versions.json:supported` and set `latest:3`.
4. Add field `description2: Option<String>` with `#[serde(default)]` to fixture parser.
5. `pnpm fixtures:gen` – creates `v3/*.json` from existing `v2` + additive example.

CI lane `registry-fixtures` runs `fixtures:check` and `cargo test -p talos-registry registry_schema -- --nocapture`.

## Test expectations

Run focused Rust contract tests with synthetic data – no network:

```bash
cargo test -p talos-registry --lib registry_schema -- --nocapture
cargo test -p talos-registry --lib test::registry_schema_compat -- --nocapture
```

Tests use `Env::default()` synthetic `Address::generate(&env)` (like `web/tests` factories), `soroban_sdk::TryFromVal` where needed, and the `registry_schema_fixtures` parser. No `HORIZON_URL`.

## References

- `contracts/storage_migration/src/lib.rs` – versioned migration framework
- `contracts/talos_registry/src/lib.rs` – `Talos`, `Patron`, `Kernel`, `Pulse`, `TimelockConfig`
- `contracts/talos_name_service/src/lib.rs` – `NameRecord` / `TalosName`
- `contracts/fixtures/event_fixtures.json` – prior art for event catalog fixtures
