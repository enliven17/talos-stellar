# storage_migration

Versioned storage migration framework for Talos Protocol Soroban contracts.

Shared, contract-agnostic building blocks for evolving a contract's
persistent storage layout safely across releases: a single `u32` schema
version, ordered/idempotent migration steps, a re-entrancy guard, an
on-chain history log, and bounded rollback. It does **not** know anything
about any specific contract's data shapes — each contract defines its own
migration steps (the actual storage reads/writes) and calls into this crate
to sequence and record them safely.

See [`talos_registry`](../talos_registry/src/lib.rs) (`schema_version`,
`run_migrations`, `rollback_schema`) for the reference integration.

## Design

- **Schema version.** One `u32` per contract instance, stored under this
  crate's own private key type — it cannot collide with a host contract's
  `DataKey` enum, since Soroban storage keys are typed values.
- **Ordered, idempotent steps.** A step is only allowed to run when the
  contract's current version equals the step's declared `from` version, and
  it must move the version strictly forward (`to > from`). A step that has
  already been applied is therefore rejected, not silently reapplied — the
  reference pattern is for the contract's `run_migrations` entry point to
  check `schema_version()` before invoking each step, which makes calling
  `run_migrations` repeatedly a safe no-op once everything is up to date.
- **Concurrency guard.** `begin_migration` takes a lock that `complete_migration`
  or `abort_migration` must release. A second `begin_migration` call while a
  step is uncommitted is rejected with `MigrationInProgress` rather than
  silently racing.
- **History log.** Every applied step and rollback is appended to an
  append-only on-chain log (`migration_history_len` / `migration_record_at`)
  with a timestamp, and emits an event (`sch_mig` / `sch_rbk`). This gives
  operators an audit trail without needing off-chain indexing.
- **Rollback, bounded.** `rollback(e, current, target, max_depth)` only
  moves the version pointer backwards, and only within `max_depth` steps of
  the current version. **It does not undo the data changes a forward
  migration made.** Schema migrations in this framework are intentionally
  not required to be data-reversible; rollback exists to unblock a stuck
  upgrade (e.g. move the pointer back so the previous migration step can be
  retried with a fix), not to restore prior on-chain state. An operator
  rolling back must confirm the target version's data shape is actually
  compatible with the entry-points that will run against it.

## Adding a migration step to a contract

1. Pick the next schema version (`to = current_max + 1`).
2. In the host contract, add a branch to its migration dispatcher:
   ```rust
   if current == FROM_VERSION {
       storage_migration::begin_migration(&e, current, FROM_VERSION, TO_VERSION)
           .unwrap_or_else(|_| panic!("migration out of order or in progress"));

       // ... contract-specific storage reads/writes for this step,
       // idempotent (e.g. guarded by `.has()`) wherever practical ...

       storage_migration::complete_migration(&e, FROM_VERSION, TO_VERSION);
       current = TO_VERSION;
   }
   ```
3. Gate the dispatcher entry point behind the contract's existing admin
   authorization (see `talos_registry::run_migrations`, which requires the
   protocol wallet to `require_auth()`).
4. Add a fixture test that: applies the step from a fresh/previous state,
   asserts the resulting data shape, asserts a second call is a no-op, and
   (if relevant) asserts the step is rejected when called out of order.

## Operator runbook

- **Check current version:** call the contract's `schema_version()`.
- **Apply pending migrations:** call `run_migrations()` (admin-authorized).
  Safe to call repeatedly — it stops once the contract is at the latest
  known version.
- **Inspect history:** `migration_history_len()` /
  `migration_record_at(index)` for a chronological audit trail, or watch for
  `sch_mig` / `sch_rbk` events.
- **Roll back:** call `rollback_schema(target_version)` (admin-authorized).
  Only succeeds within the contract's configured `MAX_ROLLBACK_DEPTH`.
  Remember this only moves the version pointer — verify the target
  version's data shape is actually what you want before resuming normal
  operations.

## Known limitations

- Rollback is version-pointer-only, not a data-level undo (see above).
- Migration steps are defined per-contract as an ordered `if` chain in the
  reference integration; a contract with many steps may want to move this
  to a static table, but the underlying `begin_migration` /
  `complete_migration` contract remains the same either way.
- This crate assumes a single logical schema version per contract instance,
  not per-key versioning within one contract.
