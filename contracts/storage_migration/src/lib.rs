//! storage_migration — Versioned storage migration framework for Talos
//! Protocol Soroban contracts.
//!
//! ## Model
//!
//! Each contract keeps a single `u32` schema version in its own persistent
//! storage (via this crate's private [`MigrationKey`] type, which cannot
//! collide with a host contract's own `DataKey` enum since Soroban storage
//! keys are typed). Migrations move the version forward **one ordered step
//! at a time**: `begin_migration(e, current, from, to)` only succeeds when
//! `current == from` and `to > from`, so steps can never be skipped or
//! applied out of order, and a step that has already been applied becomes a
//! no-op rejection rather than a silent double-apply — the caller is
//! expected to check [`schema_version`] before invoking a step, which makes
//! a top-level "run all pending migrations" dispatcher naturally idempotent
//! (see `talos_registry::run_migrations` for the reference integration).
//!
//! A migration in progress holds a lock (cleared by [`complete_migration`]
//! or [`abort_migration`]) so a re-entrant or concurrent call cannot begin a
//! second step while one is uncommitted.
//!
//! Every applied step and rollback is appended to an on-chain history log
//! ([`migration_history_len`] / [`migration_record_at`]) and emits an event,
//! giving operators an audit trail without needing off-chain indexing.
//!
//! ## Rollback
//!
//! [`rollback`] only moves the version pointer backwards, bounded by a
//! caller-supplied `max_depth` (see [`validate_rollback`]). It does **not**
//! undo any data written by forward migrations — schema migrations in this
//! framework are intentionally not required to be reversible at the data
//! level. Operators must confirm the target version's data shape is safe to
//! resume from before relying on old entry-points again.
//!
//! See `contracts/storage_migration/README.md` for the full design and an
//! operator runbook.

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{contracterror, contracttype, symbol_short, Env};

// ── Errors ──────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MigrationError {
    /// `to <= from`: migrations must move the schema version strictly forward.
    NotForward = 1,
    /// `current != from`: this step does not apply at the contract's current
    /// version (already applied, or attempted out of order).
    OutOfOrder = 2,
    /// A migration was started but never completed or aborted.
    MigrationInProgress = 3,
    /// Rollback target must be strictly below the current version.
    RollbackNotAllowed = 4,
    /// Rollback target is further back than the allowed depth.
    RollbackTooDeep = 5,
}

// ── Storage ─────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
enum MigrationKey {
    SchemaVersion,
    MigrationLock,
    HistoryLen,
    History(u32),
}

/// A single applied migration or rollback, in chronological order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationRecord {
    pub from_version: u32,
    pub to_version: u32,
    pub applied_at: u64,
    pub rolled_back: bool,
}

// ── Events ──────────────────────────────────────────────────────────
//
// Event schema (topics → data):
//   sch_mig : (symbol,) → (from_version: u32, to_version: u32)
//   sch_rbk : (symbol,) → (from_version: u32, to_version: u32)

fn emit_schema_migrated(env: &Env, from_version: u32, to_version: u32) {
    let topics = (symbol_short!("sch_mig"),);
    env.events().publish(topics, (from_version, to_version));
}

fn emit_schema_rolled_back(env: &Env, from_version: u32, to_version: u32) {
    let topics = (symbol_short!("sch_rbk"),);
    env.events().publish(topics, (from_version, to_version));
}

fn append_history(env: &Env, from_version: u32, to_version: u32, rolled_back: bool) {
    let len: u32 = env
        .storage()
        .persistent()
        .get(&MigrationKey::HistoryLen)
        .unwrap_or(0);
    let record = MigrationRecord {
        from_version,
        to_version,
        applied_at: env.ledger().timestamp(),
        rolled_back,
    };
    env.storage()
        .persistent()
        .set(&MigrationKey::History(len), &record);
    env.storage()
        .persistent()
        .set(&MigrationKey::HistoryLen, &(len + 1));
}

fn is_locked(env: &Env) -> bool {
    env.storage()
        .persistent()
        .get(&MigrationKey::MigrationLock)
        .unwrap_or(false)
}

// ── Pure validation (unit-testable without an Env) ─────────────────

/// A forward migration step is valid only when it starts exactly at the
/// contract's current version and strictly increases the version. This is
/// what makes step application order-safe: a step whose `from` no longer
/// matches `current` (because it was already applied, or a later step ran
/// first) is rejected rather than silently reapplied or skipped.
pub fn validate_forward_step(current: u32, from: u32, to: u32) -> Result<(), MigrationError> {
    if to <= from {
        return Err(MigrationError::NotForward);
    }
    if current != from {
        return Err(MigrationError::OutOfOrder);
    }
    Ok(())
}

/// A rollback is valid only when the target is strictly below the current
/// version and within `max_depth` steps of it.
pub fn validate_rollback(current: u32, target: u32, max_depth: u32) -> Result<(), MigrationError> {
    if target >= current {
        return Err(MigrationError::RollbackNotAllowed);
    }
    if current - target > max_depth {
        return Err(MigrationError::RollbackTooDeep);
    }
    Ok(())
}

// ── Public API ──────────────────────────────────────────────────────

/// Read the on-chain schema version, if one has ever been recorded.
/// Contracts adopting this framework should treat `None` as their
/// pre-migration-system genesis version.
pub fn schema_version(e: &Env) -> Option<u32> {
    e.storage().persistent().get(&MigrationKey::SchemaVersion)
}

/// Record an explicit genesis version. Idempotent: does nothing if a
/// version is already recorded (e.g. on re-`initialize` guards, or when
/// called against a contract instance that already adopted this framework).
pub fn initialize_schema(e: &Env, genesis: u32) {
    if schema_version(e).is_none() {
        e.storage()
            .persistent()
            .set(&MigrationKey::SchemaVersion, &genesis);
        append_history(e, genesis, genesis, false);
    }
}

/// Begin a single ordered migration step. Must be followed by
/// [`complete_migration`] (on success) or [`abort_migration`] (to release
/// the lock without advancing the version).
pub fn begin_migration(e: &Env, current: u32, from: u32, to: u32) -> Result<(), MigrationError> {
    validate_forward_step(current, from, to)?;
    if is_locked(e) {
        return Err(MigrationError::MigrationInProgress);
    }
    e.storage()
        .persistent()
        .set(&MigrationKey::MigrationLock, &true);
    Ok(())
}

/// Commit a migration step started with [`begin_migration`]: advances the
/// schema version, releases the lock, appends a history record, and emits
/// `sch_mig`.
pub fn complete_migration(e: &Env, from_version: u32, to_version: u32) {
    e.storage()
        .persistent()
        .set(&MigrationKey::SchemaVersion, &to_version);
    e.storage()
        .persistent()
        .set(&MigrationKey::MigrationLock, &false);
    append_history(e, from_version, to_version, false);
    emit_schema_migrated(e, from_version, to_version);
}

/// Release the migration lock without advancing the schema version, e.g.
/// when a step's precondition fails after `begin_migration` succeeded.
pub fn abort_migration(e: &Env) {
    e.storage()
        .persistent()
        .set(&MigrationKey::MigrationLock, &false);
}

/// Roll the schema version back to `target`, bounded by `max_depth` steps.
/// Only moves the version pointer — see the module docs for why forward
/// migrations are not required to be reversible at the data level.
pub fn rollback(e: &Env, current: u32, target: u32, max_depth: u32) -> Result<(), MigrationError> {
    validate_rollback(current, target, max_depth)?;
    if is_locked(e) {
        return Err(MigrationError::MigrationInProgress);
    }
    e.storage()
        .persistent()
        .set(&MigrationKey::SchemaVersion, &target);
    append_history(e, current, target, true);
    emit_schema_rolled_back(e, current, target);
    Ok(())
}

/// Number of entries in the migration/rollback history log.
pub fn migration_history_len(e: &Env) -> u32 {
    e.storage()
        .persistent()
        .get(&MigrationKey::HistoryLen)
        .unwrap_or(0)
}

/// Fetch a single history entry by index (`0..migration_history_len`),
/// oldest first.
pub fn migration_record_at(e: &Env, index: u32) -> Option<MigrationRecord> {
    e.storage().persistent().get(&MigrationKey::History(index))
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Address;

    #[test]
    fn forward_step_accepts_matching_sequential_version() {
        assert_eq!(validate_forward_step(1, 1, 2), Ok(()));
    }

    #[test]
    fn forward_step_rejects_non_increasing_target() {
        assert_eq!(
            validate_forward_step(1, 1, 1),
            Err(MigrationError::NotForward)
        );
        assert_eq!(
            validate_forward_step(2, 2, 1),
            Err(MigrationError::NotForward)
        );
    }

    #[test]
    fn forward_step_rejects_out_of_order_current() {
        // Step is written for from=1, but the contract is already at 2
        // (already applied) or still at 0 (an earlier step hasn't run yet).
        assert_eq!(
            validate_forward_step(2, 1, 2),
            Err(MigrationError::OutOfOrder)
        );
        assert_eq!(
            validate_forward_step(0, 1, 2),
            Err(MigrationError::OutOfOrder)
        );
    }

    #[test]
    fn rollback_accepts_target_within_depth() {
        assert_eq!(validate_rollback(3, 2, 1), Ok(()));
        assert_eq!(validate_rollback(3, 1, 2), Ok(()));
    }

    #[test]
    fn rollback_rejects_target_at_or_above_current() {
        assert_eq!(
            validate_rollback(3, 3, 5),
            Err(MigrationError::RollbackNotAllowed)
        );
        assert_eq!(
            validate_rollback(3, 4, 5),
            Err(MigrationError::RollbackNotAllowed)
        );
    }

    #[test]
    fn rollback_rejects_target_beyond_max_depth() {
        assert_eq!(
            validate_rollback(5, 2, 2),
            Err(MigrationError::RollbackTooDeep)
        );
    }

    #[test]
    fn full_lifecycle_begin_complete_advances_version_and_history() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);
        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);
            assert_eq!(schema_version(&env), Some(1));
            assert_eq!(migration_history_len(&env), 1);

            begin_migration(&env, 1, 1, 2).unwrap();
            complete_migration(&env, 1, 2);

            assert_eq!(schema_version(&env), Some(2));
            assert_eq!(migration_history_len(&env), 2);
            assert!(!is_locked(&env));

            let record = migration_record_at(&env, 1).unwrap();
            assert_eq!(record.from_version, 1);
            assert_eq!(record.to_version, 2);
            assert!(!record.rolled_back);
        });
    }

    #[test]
    fn concurrent_begin_is_rejected_until_completed_or_aborted() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);
        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            begin_migration(&env, 1, 1, 2).unwrap();
            // A second, concurrent/re-entrant attempt must not be able to
            // start while the first step is uncommitted.
            assert_eq!(
                begin_migration(&env, 1, 1, 2),
                Err(MigrationError::MigrationInProgress)
            );

            abort_migration(&env);
            // Once aborted (lock released, version unchanged), the same
            // step can be retried.
            assert_eq!(schema_version(&env), Some(1));
            begin_migration(&env, 1, 1, 2).unwrap();
            complete_migration(&env, 1, 2);
            assert_eq!(schema_version(&env), Some(2));
        });
    }

    #[test]
    fn rollback_then_reapply_round_trips() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);
        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);
            begin_migration(&env, 1, 1, 2).unwrap();
            complete_migration(&env, 1, 2);

            rollback(&env, 2, 1, 1).unwrap();
            assert_eq!(schema_version(&env), Some(1));

            begin_migration(&env, 1, 1, 2).unwrap();
            complete_migration(&env, 1, 2);
            assert_eq!(schema_version(&env), Some(2));
        });
    }
}
