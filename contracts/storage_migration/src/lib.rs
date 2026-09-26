//! storage_migration — Versioned storage migration framework for Talos
//! Protocol Soroban contracts.
//!
//! Each contract keeps a single u32 schema version in persistent storage.
//! Migrations move the version forward one ordered step at a time.
//!
//! A migration in progress holds a lock so a second migration cannot begin
//! until the current migration is completed or aborted.
//!
//! Every completed migration and rollback is recorded in an on-chain history
//! log and emits an audit event.
//!
//! Rollback only moves the schema-version pointer. It does not undo data
//! written by a forward migration.

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{contracterror, contracttype, symbol_short, Env};

// ── Errors ──────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MigrationError {
    /// `to <= from`: migrations must move the schema version forward.
    NotForward = 1,

    /// The supplied/current stored version does not match `from`.
    OutOfOrder = 2,

    /// A migration is already in progress.
    MigrationInProgress = 3,

    /// Rollback target must be below current version.
    RollbackNotAllowed = 4,

    /// Rollback is deeper than the allowed depth.
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

/// A single migration or rollback record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationRecord {
    pub from_version: u32,
    pub to_version: u32,
    pub applied_at: u64,
    pub rolled_back: bool,
}

/// Outcome of a storage-migration dry-run.
///
/// A dry-run is a read-only simulation: it reports what a forward migration
/// *would* do from the contract's current schema version without taking the
/// migration lock, writing storage, appending history, or emitting events.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationDryRun {
    /// Schema version currently stored on-chain.
    pub current_version: u32,
    /// Version the contract would end up at if the plan were applied.
    pub target_version: u32,
    /// Number of ordered steps the plan would apply (`0` when up to date).
    pub steps: u32,
    /// `true` when the contract is already at `target_version`.
    pub up_to_date: bool,
    /// `true` when a migration currently holds the lock, so applying the
    /// plan would be rejected with [`MigrationError::MigrationInProgress`].
    pub locked: bool,
    /// `true` when the plan is safe to apply: not locked, forward-only, and
    /// starting exactly at the stored version.
    pub applicable: bool,
    /// `None` when `applicable`; otherwise the reason the plan would fail.
    pub error: Option<MigrationError>,
}

// ── Events ──────────────────────────────────────────────────────────

fn emit_schema_migrated(
    env: &Env,
    from_version: u32,
    to_version: u32,
) {
    let topics = (symbol_short!("sch_mig"),);

    env.events()
        .publish(topics, (from_version, to_version));
}

fn emit_schema_rolled_back(
    env: &Env,
    from_version: u32,
    to_version: u32,
) {
    let topics = (symbol_short!("sch_rbk"),);

    env.events()
        .publish(topics, (from_version, to_version));
}

// ── Internal helpers ────────────────────────────────────────────────

fn append_history(
    env: &Env,
    from_version: u32,
    to_version: u32,
    rolled_back: bool,
) {
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

// ── Pure validation ─────────────────────────────────────────────────

/// Validate a forward migration step.
///
/// The migration must:
/// 1. Increase the version.
/// 2. Start exactly at the contract's current version.
pub fn validate_forward_step(
    current: u32,
    from: u32,
    to: u32,
) -> Result<(), MigrationError> {
    if to <= from {
        return Err(MigrationError::NotForward);
    }

    if current != from {
        return Err(MigrationError::OutOfOrder);
    }

    Ok(())
}

/// Validate a rollback.
///
/// The target must be strictly below the current version and within
/// the caller-supplied maximum rollback depth.
pub fn validate_rollback(
    current: u32,
    target: u32,
    max_depth: u32,
) -> Result<(), MigrationError> {
    if target >= current {
        return Err(MigrationError::RollbackNotAllowed);
    }

    if current - target > max_depth {
        return Err(MigrationError::RollbackTooDeep);
    }

    Ok(())
}

/// Simulate a forward migration without mutating any state.
///
/// `current` is the caller's view of the stored schema version and is used
/// only as the baseline for an uninitialized contract, exactly like
/// [`begin_migration`]. The stored version is authoritative once the
/// framework has been initialized.
///
/// The dry-run never takes the migration lock, never writes storage, never
/// appends history, and never emits events, so it is always safe to call —
/// including while another migration is in progress. It reports the same
/// rejection [`begin_migration`] would produce, so callers can pre-flight an
/// upgrade before committing to it.
pub fn dry_run(
    e: &Env,
    current: u32,
    from: u32,
    to: u32,
) -> MigrationDryRun {
    let stored_current = schema_version(e).unwrap_or(current);
    let locked = is_locked(e);

    // Mirror `begin_migration`'s checks in the same order so the dry-run
    // predicts the real outcome rather than a stricter or looser one.
    let error = if stored_current != current {
        Some(MigrationError::OutOfOrder)
    } else {
        match validate_forward_step(stored_current, from, to) {
            Err(err) => Some(err),
            Ok(()) => {
                if locked {
                    Some(MigrationError::MigrationInProgress)
                } else {
                    None
                }
            }
        }
    };

    let up_to_date = stored_current == to;

    MigrationDryRun {
        current_version: stored_current,
        target_version: to,
        steps: if up_to_date { 0 } else { 1 },
        up_to_date,
        locked,
        applicable: error.is_none(),
        error,
    }
}

// ── Public API ──────────────────────────────────────────────────────

/// Read the currently stored schema version.
///
/// Returns `None` when the migration framework has not yet been initialized.
pub fn schema_version(e: &Env) -> Option<u32> {
    e.storage()
        .persistent()
        .get(&MigrationKey::SchemaVersion)
}

/// Initialize the schema version.
///
/// This operation is idempotent. If a schema version already exists,
/// the existing value is preserved.
pub fn initialize_schema(e: &Env, genesis: u32) {
    if schema_version(e).is_none() {
        e.storage()
            .persistent()
            .set(&MigrationKey::SchemaVersion, &genesis);

        append_history(e, genesis, genesis, false);
    }
}

/// Begin one ordered migration step.
///
/// `current` is retained in the API for compatibility with existing
/// callers, but the stored schema version is authoritative once the
/// migration framework has been initialized.
pub fn begin_migration(
    e: &Env,
    current: u32,
    from: u32,
    to: u32,
) -> Result<(), MigrationError> {
    // The stored value is authoritative.
    //
    // For an uninitialized contract, the caller-provided `current`
    // is used as the initial baseline. Existing integrations can
    // therefore continue using this API.
    let stored_current = schema_version(e).unwrap_or(current);

    if stored_current != current {
        return Err(MigrationError::OutOfOrder);
    }

    validate_forward_step(stored_current, from, to)?;

    if is_locked(e) {
        return Err(MigrationError::MigrationInProgress);
    }

    e.storage()
        .persistent()
        .set(&MigrationKey::MigrationLock, &true);

    Ok(())
}

/// Complete a migration that was previously started with
/// [`begin_migration`].
///
/// The schema version is advanced, the migration lock is released,
/// history is appended, and the migration event is emitted.
pub fn complete_migration(
    e: &Env,
    from_version: u32,
    to_version: u32,
) {
    // Do not silently commit an invalid migration.
    //
    // `complete_migration` has historically returned `()`, so a failed
    // invariant is treated as a contract failure rather than returning
    // an error that callers could accidentally ignore.
    let current = schema_version(e).unwrap_or(from_version);

    if current != from_version {
        panic!("Migration completion version mismatch");
    }

    if !is_locked(e) {
        panic!("No migration is currently in progress");
    }

    if to_version <= from_version {
        panic!("Migration target must be greater than source");
    }

    e.storage()
        .persistent()
        .set(&MigrationKey::SchemaVersion, &to_version);

    e.storage()
        .persistent()
        .set(&MigrationKey::MigrationLock, &false);

    append_history(
        e,
        from_version,
        to_version,
        false,
    );

    emit_schema_migrated(
        e,
        from_version,
        to_version,
    );
}

/// Abort the currently running migration.
///
/// The schema version remains unchanged and the migration lock is released.
pub fn abort_migration(e: &Env) {
    e.storage()
        .persistent()
        .set(&MigrationKey::MigrationLock, &false);
}

/// Roll the schema version back to `target`.
///
/// This changes only the schema-version pointer. It does not reverse
/// storage/data changes made by the forward migration.
pub fn rollback(
    e: &Env,
    current: u32,
    target: u32,
    max_depth: u32,
) -> Result<(), MigrationError> {
    // Stored schema version is authoritative.
    let stored_current = schema_version(e).unwrap_or(current);

    if stored_current != current {
        return Err(MigrationError::OutOfOrder);
    }

    validate_rollback(
        stored_current,
        target,
        max_depth,
    )?;

    if is_locked(e) {
        return Err(MigrationError::MigrationInProgress);
    }

    e.storage()
        .persistent()
        .set(
            &MigrationKey::SchemaVersion,
            &target,
        );

    append_history(
        e,
        stored_current,
        target,
        true,
    );

    emit_schema_rolled_back(
        e,
        stored_current,
        target,
    );

    Ok(())
}

/// Number of migration/rollback history records.
pub fn migration_history_len(e: &Env) -> u32 {
    e.storage()
        .persistent()
        .get(&MigrationKey::HistoryLen)
        .unwrap_or(0)
}

/// Fetch a history record by index.
///
/// Index `0` is the oldest record.
pub fn migration_record_at(
    e: &Env,
    index: u32,
) -> Option<MigrationRecord> {
    e.storage()
        .persistent()
        .get(&MigrationKey::History(index))
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    #[test]
    fn forward_step_accepts_matching_sequential_version() {
        assert_eq!(
            validate_forward_step(1, 1, 2),
            Ok(())
        );
    }

    #[test]
    fn forward_step_accepts_larger_target_version() {
        assert_eq!(
            validate_forward_step(1, 1, 5),
            Ok(())
        );
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
        assert_eq!(
            validate_rollback(3, 2, 1),
            Ok(())
        );

        assert_eq!(
            validate_rollback(3, 1, 2),
            Ok(())
        );
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
    fn initialize_schema_is_idempotent() {
        let env = Env::default();

        let contract_id =
            soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            assert_eq!(
                schema_version(&env),
                Some(1)
            );

            assert_eq!(
                migration_history_len(&env),
                1
            );

            // Second initialization must not overwrite
            // the existing schema version.
            initialize_schema(&env, 99);

            assert_eq!(
                schema_version(&env),
                Some(1)
            );

            assert_eq!(
                migration_history_len(&env),
                1
            );
        });
    }

    #[test]
    fn full_lifecycle_begin_complete_advances_version_and_history() {
        let env = Env::default();

        let contract_id =
            soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            assert_eq!(
                schema_version(&env),
                Some(1)
            );

            assert_eq!(
                migration_history_len(&env),
                1
            );

            begin_migration(
                &env,
                1,
                1,
                2,
            )
            .unwrap();

            complete_migration(
                &env,
                1,
                2,
            );

            assert_eq!(
                schema_version(&env),
                Some(2)
            );

            assert_eq!(
                migration_history_len(&env),
                2
            );

            assert!(!is_locked(&env));

            let record =
                migration_record_at(&env, 1).unwrap();

            assert_eq!(
                record.from_version,
                1
            );

            assert_eq!(
                record.to_version,
                2
            );

            assert!(!record.rolled_back);
        });
    }

    #[test]
    fn begin_rejects_stale_caller_version() {
        let env = Env::default();

        let contract_id =
            soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            assert_eq!(
                begin_migration(
                    &env,
                    1,
                    1,
                    2,
                ),
                Err(MigrationError::OutOfOrder)
            );

            assert_eq!(
                schema_version(&env),
                Some(2)
            );
        });
    }

    #[test]
    fn concurrent_begin_is_rejected_until_completed_or_aborted() {
        let env = Env::default();

        let contract_id =
            soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            begin_migration(
                &env,
                1,
                1,
                2,
            )
            .unwrap();

            assert_eq!(
                begin_migration(
                    &env,
                    1,
                    1,
                    2,
                ),
                Err(MigrationError::MigrationInProgress)
            );

            abort_migration(&env);

            assert_eq!(
                schema_version(&env),
                Some(1)
            );

            begin_migration(
                &env,
                1,
                1,
                2,
            )
            .unwrap();

            complete_migration(
                &env,
                1,
                2,
            );

            assert_eq!(
                schema_version(&env),
                Some(2)
            );
        });
    }

    #[test]
    fn rollback_then_reapply_round_trips() {
        let env = Env::default();

        let contract_id =
            soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            begin_migration(
                &env,
                1,
                1,
                2,
            )
            .unwrap();

            complete_migration(
                &env,
                1,
                2,
            );

            rollback(
                &env,
                2,
                1,
                1,
            )
            .unwrap();

            assert_eq!(
                schema_version(&env),
                Some(1)
            );

            begin_migration(
                &env,
                1,
                1,
                2,
            )
            .unwrap();

            complete_migration(
                &env,
                1,
                2,
            );

            assert_eq!(
                schema_version(&env),
                Some(2)
            );

            assert_eq!(
                migration_history_len(&env),
                4
            );
        });
    }

    #[test]
    fn rollback_rejects_stale_caller_version() {
        let env = Env::default();

        let contract_id =
            soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 3);

            assert_eq!(
                rollback(
                    &env,
                    2,
                    1,
                    1,
                ),
                Err(MigrationError::OutOfOrder)
            );

            assert_eq!(
                schema_version(&env),
                Some(3)
            );
        });
    }

    // ── Dry-run tests ───────────────────────────────────────────────

    #[test]
    fn dry_run_reports_applicable_plan_without_mutating_state() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            let plan = dry_run(&env, 1, 1, 2);

            assert_eq!(plan.current_version, 1);
            assert_eq!(plan.target_version, 2);
            assert_eq!(plan.steps, 1);
            assert!(!plan.up_to_date);
            assert!(!plan.locked);
            assert!(plan.applicable);
            assert_eq!(plan.error, None);

            // Read-only: version, lock, and history are untouched.
            assert_eq!(schema_version(&env), Some(1));
            assert!(!is_locked(&env));
            assert_eq!(migration_history_len(&env), 1);
        });
    }

    #[test]
    fn dry_run_reports_up_to_date_when_already_at_target() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            let plan = dry_run(&env, 2, 2, 2);

            assert!(plan.up_to_date);
            assert_eq!(plan.steps, 0);
            assert!(!plan.applicable);
            assert_eq!(plan.error, Some(MigrationError::NotForward));
        });
    }

    #[test]
    fn dry_run_rejects_non_forward_target() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            let plan = dry_run(&env, 2, 2, 1);

            assert!(!plan.applicable);
            assert_eq!(plan.error, Some(MigrationError::NotForward));
            assert_eq!(schema_version(&env), Some(2));
        });
    }

    #[test]
    fn dry_run_rejects_out_of_order_current() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            // Caller believes it is at 1 but storage says 2.
            let plan = dry_run(&env, 1, 1, 2);

            assert!(!plan.applicable);
            assert_eq!(plan.error, Some(MigrationError::OutOfOrder));
            assert_eq!(plan.current_version, 2);
        });
    }

    #[test]
    fn dry_run_reports_locked_without_clearing_the_lock() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);
            begin_migration(&env, 1, 1, 2).expect("begin");

            let plan = dry_run(&env, 1, 1, 2);

            assert!(plan.locked);
            assert!(!plan.applicable);
            assert_eq!(plan.error, Some(MigrationError::MigrationInProgress));

            // The dry-run must not release the lock held by the real migration.
            assert!(is_locked(&env));
            assert_eq!(schema_version(&env), Some(1));
        });
    }

    #[test]
    fn dry_run_uses_caller_baseline_for_uninitialized_contract() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            let plan = dry_run(&env, 1, 1, 2);

            assert_eq!(plan.current_version, 1);
            assert!(plan.applicable);
            assert_eq!(plan.error, None);

            // Still uninitialized: the dry-run wrote nothing.
            assert_eq!(schema_version(&env), None);
            assert_eq!(migration_history_len(&env), 0);
        });
    }

    #[test]
    fn dry_run_matches_begin_migration_outcome() {
        let env = Env::default();
        let contract_id = soroban_sdk::Address::generate(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            let plan = dry_run(&env, 1, 1, 2);
            assert!(plan.applicable);

            // Applying the same plan must succeed, proving the dry-run is not
            // stricter or looser than the real path.
            assert_eq!(begin_migration(&env, 1, 1, 2), Ok(()));
            complete_migration(&env, 1, 2);
            assert_eq!(schema_version(&env), Some(2));
        });
    }
}
