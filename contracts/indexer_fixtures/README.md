# Indexer Fixtures (`indexer_fixtures`)

Typed event fixtures and schema references for Talos Protocol Soroban indexer integration tests and consumers.

## Purpose

On-chain Soroban events emitted by Talos smart contracts (`TalosRegistry`, `TalosNameService`, and `TalosGovernance`) serve as the primary integration interface for off-chain indexers, analytics services, and SDK consumers.

The `indexer_fixtures` crate (`contracts/indexer_fixtures`):
1. **Defines typed event structs** mirroring the exact topic and data layout of contract events so indexers have a canonical, versioned Rust source of truth rather than reverse-engineering payloads from contract logic or doc comments.
2. **Exposes canonical fixture builder functions** (`*_fixture(...)`) to instantiate structured in-memory event representations for integration assertions and decoder round-trip testing.
3. **Validates end-to-end event emission**: features host round-trip tests that set up contract environments, execute entry-points, capture `(contract_id, topics, data)` tuples, and decode them into typed structs.

---

## Fixture Builders

`contracts/indexer_fixtures/src/lib.rs` exports constructors for all supported event payloads across the protocol:

### `TalosRegistry` Fixtures
- **`talos_created_fixture(env, creator, talos_id, name, category)`** (`tls_crt`): Emitted when a new Talos entity is created.
- **`patron_updated_fixture(env, talos_id, creator, creator_share, investor_share)`** (`patron_upd` / `pat_upd`): Emitted when creator/investor patron shares are adjusted.
- **`fee_changed_fixture(old_bps, new_bps)`** (`fee_chg`): Emitted when protocol fee basis points change.
- **`admin_proposed_fixture(current, proposed)`** (`adm_prp`): Emitted when an admin migration/transfer is proposed.
- **`admin_accepted_fixture(new_admin)`** (`adm_acc`): Emitted when the proposed admin accepts adminship.
- **`admin_cancelled_fixture(cancelled)`** (`adm_cnl`): Emitted when a pending admin proposal is cancelled.
- **`registry_timelock_scheduled_fixture(proposal_id, action, eta, proposer)`** (`tl_sch`): Emitted when an admin timelock operation is scheduled.
- **`registry_timelock_executed_fixture(proposal_id, action, executor)`** (`tl_exec`): Emitted when a timelock operation executes after delay.
- **`registry_timelock_cancelled_fixture(proposal_id, action, canceller)`** (`tl_cnl`): Emitted when a scheduled timelock operation is cancelled.
- **`timelock_config_changed_fixture(old_min_delay, new_min_delay, grace_period)`** (`tl_cfg`): Emitted when timelock delay parameters are updated.

### `TalosNameService` Fixtures
- **`name_registered_fixture(env, talos_id, name, owner)`** (`name_reg`): Emitted when a human-readable name is mapped to a Talos ID.
- **`registry_updated_fixture(old_registry, new_registry)`** (`reg_upd`): Emitted when the linked registry contract address is updated.
- **`ns_timelock_scheduled_fixture(proposal_id, action, eta, proposer)`** (`tl_sch`): Emitted when a name-service timelock operation is scheduled.
- **`ns_timelock_executed_fixture(proposal_id, action, executor)`** (`tl_exec`): Emitted when a name-service timelock action is executed.
- **`ns_timelock_cancelled_fixture(proposal_id, action, canceller)`** (`tl_cnl`): Emitted when a name-service timelock action is cancelled.

### `TalosGovernance` Fixtures
- **`proposal_created_fixture(proposal_id, talos_id, proposer)`** (`prop_crt`): Emitted when a governance proposal is created.
- **`vote_cast_fixture(proposal_id, voter, choice, weight)`** (`vote`): Emitted when a vote is recorded with weight and choice.
- **`proposal_status_changed_fixture(proposal_id, status)`** (`prop_stat`): Emitted when a proposal transitions between lifecycle states (`Draft`, `Active`, `Passed`, `Defeated`, `Executed`, `Cancelled`).
- **`ttl_touched_fixture(env, class_name, keys_touched)`** (`ttl_touch`): Emitted during TTL bumps and instance entry maintenance.
- **`ttl_warning_fixture(env, class_name, keys_below, max_age)`** (`ttl_warn`): Emitted when key entries are approaching archival thresholds.
- **`ttl_batch_fixture(total, touched, skipped)`** (`ttl_batch`): Emitted upon completion of batch TTL maintenance operations.

### Diagnostic & Gate Fixtures
- **`budget_gate_fixture(env, entry_point, cpu_cost, mem_cost)`** (`bgt_gate`): Test-only fixture capturing budget regression gates (entry-point, CPU instruction count, and memory bytes cost) for indexer CI and property tests.

---

## Relationship to JSON Fixtures & Reference Query Helper

In addition to Rust in-memory structs, the repository provides non-Rust indexers and clients with static, wire-level fixture documents:

- **`contracts/fixtures/event_fixtures.json`**: The canonical JSON specification conforming to `contracts/EVENTS.md`. It contains:
  - `spec_version`: Explicit version tag to prevent schema drift across consumers.
  - `event_catalog`: Canonical topic positions and data schemas categorized by event family (`creation`, `update`, `governance`, `payment`).
  - `fixtures`: Concrete examples for each event with raw wire-level `topics`/`data` alongside expected fully decoded payloads.
  - `empty_ranges`: Representative ledger sequences that return no events.
  - `malformed`: Payloads testing rejection behavior (empty topics, non-symbol roots, arity/type errors).
- **`contracts/fixtures/event-query.ts`**: Reference TypeScript helper implementing query filtering, pagination bounds checking, and schema parsing against `event_fixtures.json`.

---

## Fixture Regeneration & Verification

When contract event schemas are modified or new events are introduced, the Rust types and JSON fixtures must remain synchronized.

### Regeneration Workflow
1. Update event shapes in contract code and mirror them in `contracts/indexer_fixtures/src/lib.rs`.
2. Add or update the corresponding builder function in `contracts/indexer_fixtures/src/lib.rs`.
3. Update `contracts/fixtures/event_fixtures.json` and bump `spec_version` if wire format or field ordering changed.
4. Update `contracts/EVENTS.md` event catalogs to match.

### Verification Commands

- **Verify Rust crate tests and round-trip assertions:**
  ```bash
  cargo test --manifest-path contracts/Cargo.toml -p indexer-fixtures
  ```

- **Verify JSON fixtures and TypeScript bounded-query conformance:**
  ```bash
  # From root:
  pnpm test:fixtures

  # Or directly in the contracts directory:
  pnpm --dir contracts test:fixtures
  ```
  *(Runs `tsc --noEmit && vitest run fixtures` checking parsing, malformed payload rejections, and catalog integrity).*

---

## Consumption in SDK Tests

The TypeScript SDK (`packages/sdk`) relies on these event specifications to decode contract events off-chain:

1. **Decoder Implementation (`packages/sdk/src/contract-events.ts`)**:
   - Mirrors `event_fixtures.json` via `BUILTIN_EVENT_CATALOG` and `CATALOG_SPEC_VERSION`.
   - Provides `decodeContractEvent(rawEvent)` and batch processing `decodeContractEvents(rawEvents)`.

2. **SDK Test Suite (`packages/sdk/tests/contract-events.test.ts`)**:
   - Imports raw event examples matching `contracts/fixtures/event_fixtures.json`.
   - Verifies wire-level round-trips: ensures `decodeContractEvent(raw)` produces expected topics and data objects matching the catalog specifications.
   - Tests error handling against invalid, malformed, or unsupported event versions according to `contracts/EVENTS.md` rules.
