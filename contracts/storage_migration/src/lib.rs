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

    /// Target version exceeds the maximum supported schema version.
    TargetExceedsMax = 6,
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
    /// `true` when the contract is already at `target_version`. An up-to-date
    /// plan is a successful no-op: `steps == 0`, `applicable == true`, and
    /// `error == None`.
    pub up_to_date: bool,
    /// `true` when a migration currently holds the lock, so applying the
    /// plan would be rejected with [`MigrationError::MigrationInProgress`].
    pub locked: bool,
    /// `true` when the plan is safe to apply: not locked, forward-only, and
    /// starting exactly at the stored version. An up-to-date plan is
    /// applicable with zero steps.
    pub applicable: bool,
    /// `None` when `applicable`; otherwise the numeric code of the
    /// [`MigrationError`] the real call would return.
    ///
    /// The code is stored as a `u32` rather than the enum itself because
    /// `#[contracterror]` enums are not `#[contracttype]`-compatible values.
    /// Use [`MigrationDryRun::error`] to read it back as a typed
    /// [`MigrationError`].
    pub error_code: Option<u32>,
}

impl MigrationDryRun {
    /// The typed reason the plan would fail, or `None` when `applicable`.
    ///
    /// Unknown codes (which cannot be produced by this crate) map to `None`
    /// rather than panicking, so decoding is total and privacy-safe.
    pub fn error(&self) -> Option<MigrationError> {
        match self.error_code {
            Some(code) => MigrationError::from_code(code),
            None => None,
        }
    }
}

impl MigrationError {
    /// Decode a numeric discriminant back into a [`MigrationError`].
    ///
    /// Returns `None` for codes that do not correspond to a known variant.
    pub fn from_code(code: u32) -> Option<MigrationError> {
        match code {
            1 => Some(MigrationError::NotForward),
            2 => Some(MigrationError::OutOfOrder),
            3 => Some(MigrationError::MigrationInProgress),
            4 => Some(MigrationError::RollbackNotAllowed),
            5 => Some(MigrationError::RollbackTooDeep),
            6 => Some(MigrationError::TargetExceedsMax),
            _ => None,
        }
    }

    /// The stable numeric discriminant of this error.
    pub fn code(self) -> u32 {
        self as u32
    }
}

// ── Events ──────────────────────────────────────────────────────────

fn emit_schema_migrated(env: &Env, from_version: u32, to_version: u32) {
    let topics = (symbol_short!("sch_mig"),);

    env.events().publish(topics, (from_version, to_version));
}

fn emit_schema_rolled_back(env: &Env, from_version: u32, to_version: u32) {
    let topics = (symbol_short!("sch_rbk"),);

    env.events().publish(topics, (from_version, to_version));
}

// ── Internal helpers ────────────────────────────────────────────────

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

// ── Pure validation ─────────────────────────────────────────────────

/// Validate a forward migration step.
///
/// The migration must:
/// 1. Increase the version.
/// 2. Start exactly at the contract's current version.
pub fn validate_forward_step(current: u32, from: u32, to: u32) -> Result<(), MigrationError> {
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
pub fn validate_rollback(current: u32, target: u32, max_depth: u32) -> Result<(), MigrationError> {
    if target >= current {
        return Err(MigrationError::RollbackNotAllowed);
    }

    if current - target > max_depth {
        return Err(MigrationError::RollbackTooDeep);
    }

    Ok(())
}

/// Validate an explicit forward migration target version against the contract's
/// current schema version and maximum supported schema version.
///
/// The target version must be:
/// 1. Greater than or equal to current (`target < current` returns `NotForward`).
/// 2. Less than or equal to `max_supported` (`target > max_supported` returns `TargetExceedsMax`).
///
/// An up-to-date target (`target == current`) succeeds with `Ok(())`.
pub fn validate_migration_target(
    current: u32,
    target: u32,
    max_supported: u32,
) -> Result<(), MigrationError> {
    if target < current {
        return Err(MigrationError::NotForward);
    }

    if target > max_supported {
        return Err(MigrationError::TargetExceedsMax);
    }

    Ok(())
}

/// Check whether a migration step to `step_to` should execute when gating migrations
/// by an explicit `target_version`.
///
/// Returns `true` if `step_to <= target_version`.
pub fn is_step_within_target(step_to: u32, target_version: u32) -> bool {
    step_to <= target_version
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
pub fn dry_run(e: &Env, current: u32, from: u32, to: u32) -> MigrationDryRun {
    let stored_current = schema_version(e).unwrap_or(current);
    let locked = is_locked(e);

    // Stored version is authoritative: if the caller's view does not match
    // storage, reject with OutOfOrder immediately.
    if stored_current != current {
        return MigrationDryRun {
            current_version: stored_current,
            target_version: to,
            steps: 0,
            up_to_date: false,
            locked,
            applicable: false,
            error_code: Some(MigrationError::OutOfOrder.code()),
        };
    }

    // Already at the target: the plan is a no-op, not a failure. Report it as
    // applicable with zero steps so callers can treat "up to date" as success
    // rather than as a `NotForward` rejection.
    let up_to_date = stored_current == to;

    if up_to_date {
        return MigrationDryRun {
            current_version: stored_current,
            target_version: to,
            steps: 0,
            up_to_date: true,
            locked,
            applicable: true,
            error_code: None,
        };
    }

    // Mirror `begin_migration`'s checks in the same order so the dry-run
    // predicts the real outcome rather than a stricter or looser one.
    let error = match validate_forward_step(stored_current, from, to) {
        Err(err) => Some(err),
        Ok(()) => {
            if locked {
                Some(MigrationError::MigrationInProgress)
            } else {
                None
            }
        }
    };

    MigrationDryRun {
        current_version: stored_current,
        target_version: to,
        steps: 1,
        up_to_date: false,
        locked,
        applicable: error.is_none(),
        error_code: error.map(MigrationError::code),
    }
}

/// Simulate a forward migration to an explicit target version without mutating state.
///
/// Validates the target against current storage and `max_supported`, and reports whether
/// the plan is applicable, up-to-date, locked, or rejected.
pub fn dry_run_to(e: &Env, current: u32, target: u32, max_supported: u32) -> MigrationDryRun {
    let stored_current = schema_version(e).unwrap_or(current);
    let locked = is_locked(e);

    if stored_current != current {
        return MigrationDryRun {
            current_version: stored_current,
            target_version: target,
            steps: 0,
            up_to_date: false,
            locked,
            applicable: false,
            error_code: Some(MigrationError::OutOfOrder.code()),
        };
    }

    let up_to_date = stored_current == target;
    if up_to_date {
        return MigrationDryRun {
            current_version: stored_current,
            target_version: target,
            steps: 0,
            up_to_date: true,
            locked,
            applicable: true,
            error_code: None,
        };
    }

    let error = match validate_migration_target(stored_current, target, max_supported) {
        Err(err) => Some(err),
        Ok(()) => {
            if locked {
                Some(MigrationError::MigrationInProgress)
            } else {
                None
            }
        }
    };

    MigrationDryRun {
        current_version: stored_current,
        target_version: target,
        steps: if error.is_none() {
            target.saturating_sub(stored_current)
        } else {
            0
        },
        up_to_date: false,
        locked,
        applicable: error.is_none(),
        error_code: error.map(MigrationError::code),
    }
}

// ── Public API ──────────────────────────────────────────────────────

/// Read the currently stored schema version.
///
/// Returns `None` when the migration framework has not yet been initialized.
pub fn schema_version(e: &Env) -> Option<u32> {
    e.storage().persistent().get(&MigrationKey::SchemaVersion)
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
pub fn begin_migration(e: &Env, current: u32, from: u32, to: u32) -> Result<(), MigrationError> {
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
pub fn complete_migration(e: &Env, from_version: u32, to_version: u32) {
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

    append_history(e, from_version, to_version, false);

    emit_schema_migrated(e, from_version, to_version);
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
pub fn rollback(e: &Env, current: u32, target: u32, max_depth: u32) -> Result<(), MigrationError> {
    // Stored schema version is authoritative.
    let stored_current = schema_version(e).unwrap_or(current);

    if stored_current != current {
        return Err(MigrationError::OutOfOrder);
    }

    validate_rollback(stored_current, target, max_depth)?;

    if is_locked(e) {
        return Err(MigrationError::MigrationInProgress);
    }

    e.storage()
        .persistent()
        .set(&MigrationKey::SchemaVersion, &target);

    append_history(e, stored_current, target, true);

    emit_schema_rolled_back(e, stored_current, target);

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
pub fn migration_record_at(e: &Env, index: u32) -> Option<MigrationRecord> {
    e.storage().persistent().get(&MigrationKey::History(index))
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn forward_step_accepts_matching_sequential_version() {
        assert_eq!(validate_forward_step(1, 1, 2), Ok(()));
    }

    #[test]
    fn forward_step_accepts_larger_target_version() {
        assert_eq!(validate_forward_step(1, 1, 5), Ok(()));
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

    #[soroban_sdk::contract]
    struct MockMigrationContract;

    fn register_test_contract(env: &Env) -> soroban_sdk::Address {
        env.register_contract(None, MockMigrationContract)
    }

    #[test]
    fn migration_target_accepts_in_range_target() {
        assert_eq!(validate_migration_target(1, 2, 3), Ok(()));
    }

    #[test]
    fn migration_target_accepts_current_version_as_noop() {
        assert_eq!(validate_migration_target(2, 2, 3), Ok(()));
    }

    #[test]
    fn migration_target_accepts_max_supported_version() {
        assert_eq!(validate_migration_target(1, 5, 5), Ok(()));
    }

    #[test]
    fn migration_target_rejects_target_below_current() {
        assert_eq!(
            validate_migration_target(2, 1, 3),
            Err(MigrationError::NotForward)
        );
    }

    #[test]
    fn migration_target_rejects_target_above_max() {
        assert_eq!(
            validate_migration_target(1, 4, 3),
            Err(MigrationError::TargetExceedsMax)
        );
    }

    #[test]
    fn step_within_target_gates_correctly() {
        assert!(is_step_within_target(2, 2));
        assert!(is_step_within_target(2, 3));
        assert!(!is_step_within_target(3, 2));
    }

    #[test]
    fn initialize_schema_is_idempotent() {
        let env = Env::default();

        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            assert_eq!(schema_version(&env), Some(1));

            assert_eq!(migration_history_len(&env), 1);

            // Second initialization must not overwrite
            // the existing schema version.
            initialize_schema(&env, 99);

            assert_eq!(schema_version(&env), Some(1));

            assert_eq!(migration_history_len(&env), 1);
        });
    }

    #[test]
    fn full_lifecycle_begin_complete_advances_version_and_history() {
        let env = Env::default();

        let contract_id = register_test_contract(&env);

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
    fn begin_rejects_stale_caller_version() {
        let env = Env::default();

        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            assert_eq!(
                begin_migration(&env, 1, 1, 2,),
                Err(MigrationError::OutOfOrder)
            );

            assert_eq!(schema_version(&env), Some(2));
        });
    }

    #[test]
    fn concurrent_begin_is_rejected_until_completed_or_aborted() {
        let env = Env::default();

        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            begin_migration(&env, 1, 1, 2).unwrap();

            assert_eq!(
                begin_migration(&env, 1, 1, 2,),
                Err(MigrationError::MigrationInProgress)
            );

            abort_migration(&env);

            assert_eq!(schema_version(&env), Some(1));

            begin_migration(&env, 1, 1, 2).unwrap();

            complete_migration(&env, 1, 2);

            assert_eq!(schema_version(&env), Some(2));
        });
    }

    #[test]
    fn rollback_then_reapply_round_trips() {
        let env = Env::default();

        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            begin_migration(&env, 1, 1, 2).unwrap();

            complete_migration(&env, 1, 2);

            rollback(&env, 2, 1, 1).unwrap();

            assert_eq!(schema_version(&env), Some(1));

            begin_migration(&env, 1, 1, 2).unwrap();

            complete_migration(&env, 1, 2);

            assert_eq!(schema_version(&env), Some(2));

            assert_eq!(migration_history_len(&env), 4);
        });
    }

    #[test]
    fn rollback_rejects_stale_caller_version() {
        let env = Env::default();

        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 3);

            assert_eq!(rollback(&env, 2, 1, 1,), Err(MigrationError::OutOfOrder));

            assert_eq!(schema_version(&env), Some(3));
        });
    }

    // ── Dry-run tests ───────────────────────────────────────────────

    #[test]
    fn dry_run_reports_applicable_plan_without_mutating_state() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            let plan = dry_run(&env, 1, 1, 2);

            assert_eq!(plan.current_version, 1);
            assert_eq!(plan.target_version, 2);
            assert_eq!(plan.steps, 1);
            assert!(!plan.up_to_date);
            assert!(!plan.locked);
            assert!(plan.applicable);
            assert_eq!(plan.error(), None);

            // Read-only: version, lock, and history are untouched.
            assert_eq!(schema_version(&env), Some(1));
            assert!(!is_locked(&env));
            assert_eq!(migration_history_len(&env), 1);
        });
    }

    #[test]
    fn dry_run_reports_up_to_date_when_already_at_target() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            let plan = dry_run(&env, 2, 2, 2);

            assert!(plan.up_to_date);
            assert_eq!(plan.steps, 0);
            assert!(plan.applicable);
            assert_eq!(plan.error(), None);
            assert_eq!(plan.current_version, 2);
            assert_eq!(plan.target_version, 2);
        });
    }

    #[test]
    fn dry_run_up_to_date_is_a_noop_even_while_locked() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);
            begin_migration(&env, 2, 2, 3).expect("begin");

            // Already at the target: nothing to apply, so the plan is a
            // successful no-op rather than a lock rejection.
            let plan = dry_run(&env, 2, 2, 2);

            assert!(plan.up_to_date);
            assert_eq!(plan.steps, 0);
            assert!(plan.applicable);
            assert_eq!(plan.error(), None);
            assert!(plan.locked);

            // Still read-only: the real migration keeps its lock.
            assert!(is_locked(&env));
            assert_eq!(schema_version(&env), Some(2));
        });
    }

    #[test]
    fn dry_run_rejects_non_forward_target() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            let plan = dry_run(&env, 2, 2, 1);

            assert!(!plan.applicable);
            assert_eq!(plan.error(), Some(MigrationError::NotForward));
            assert_eq!(schema_version(&env), Some(2));
        });
    }

    #[test]
    fn dry_run_rejects_out_of_order_current() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            // Caller believes it is at 1 but storage says 2.
            let plan = dry_run(&env, 1, 1, 2);

            assert!(!plan.applicable);
            assert_eq!(plan.error(), Some(MigrationError::OutOfOrder));
            assert_eq!(plan.current_version, 2);
        });
    }

    #[test]
    fn dry_run_reports_locked_without_clearing_the_lock() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);
            begin_migration(&env, 1, 1, 2).expect("begin");

            let plan = dry_run(&env, 1, 1, 2);

            assert!(plan.locked);
            assert!(!plan.applicable);
            assert_eq!(plan.error(), Some(MigrationError::MigrationInProgress));

            // The dry-run must not release the lock held by the real migration.
            assert!(is_locked(&env));
            assert_eq!(schema_version(&env), Some(1));
        });
    }

    #[test]
    fn dry_run_uses_caller_baseline_for_uninitialized_contract() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            let plan = dry_run(&env, 1, 1, 2);

            assert_eq!(plan.current_version, 1);
            assert!(plan.applicable);
            assert_eq!(plan.error(), None);

            // Still uninitialized: the dry-run wrote nothing.
            assert_eq!(schema_version(&env), None);
            assert_eq!(migration_history_len(&env), 0);
        });
    }

    #[test]
    fn dry_run_matches_begin_migration_outcome() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

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

    #[test]
    fn dry_run_error_code_round_trips_to_typed_error() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            let plan = dry_run(&env, 2, 2, 1);

            // The wire representation is a stable numeric code...
            assert_eq!(plan.error_code, Some(MigrationError::NotForward.code()));
            // ...and decodes back to the typed error for callers.
            assert_eq!(plan.error(), Some(MigrationError::NotForward));
        });
    }

    #[test]
    fn migration_error_code_round_trips_for_every_variant() {
        for err in [
            MigrationError::NotForward,
            MigrationError::OutOfOrder,
            MigrationError::MigrationInProgress,
            MigrationError::RollbackNotAllowed,
            MigrationError::RollbackTooDeep,
            MigrationError::TargetExceedsMax,
        ] {
            assert_eq!(MigrationError::from_code(err.code()), Some(err));
        }

        // Unknown codes decode to `None` instead of panicking.
        assert_eq!(MigrationError::from_code(0), None);
        assert_eq!(MigrationError::from_code(99), None);
    }

    #[test]
    fn dry_run_to_reports_applicable_plan_with_steps() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            let plan = dry_run_to(&env, 1, 3, 3);
            assert_eq!(plan.current_version, 1);
            assert_eq!(plan.target_version, 3);
            assert_eq!(plan.steps, 2);
            assert!(!plan.up_to_date);
            assert!(!plan.locked);
            assert!(plan.applicable);
            assert_eq!(plan.error(), None);

            // Read-only
            assert_eq!(schema_version(&env), Some(1));
            assert_eq!(migration_history_len(&env), 1);
        });
    }

    #[test]
    fn dry_run_to_reports_up_to_date_when_already_at_target() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            let plan = dry_run_to(&env, 2, 2, 3);
            assert!(plan.up_to_date);
            assert_eq!(plan.steps, 0);
            assert!(plan.applicable);
            assert_eq!(plan.error(), None);
        });
    }

    #[test]
    fn dry_run_to_rejects_target_below_current() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            let plan = dry_run_to(&env, 2, 1, 3);
            assert!(!plan.applicable);
            assert_eq!(plan.error(), Some(MigrationError::NotForward));
        });
    }

    #[test]
    fn dry_run_to_rejects_target_above_max() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            let plan = dry_run_to(&env, 1, 4, 3);
            assert!(!plan.applicable);
            assert_eq!(plan.error(), Some(MigrationError::TargetExceedsMax));
        });
    }

    #[test]
    fn dry_run_to_reports_locked_without_mutating() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);
            begin_migration(&env, 1, 1, 2).expect("begin");

            let plan = dry_run_to(&env, 1, 2, 3);
            assert!(plan.locked);
            assert!(!plan.applicable);
            assert_eq!(plan.error(), Some(MigrationError::MigrationInProgress));
            assert!(is_locked(&env));
        });
    }

    #[test]
    fn dry_run_to_rejects_out_of_order_caller_baseline() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            let plan = dry_run_to(&env, 1, 2, 3);
            assert!(!plan.applicable);
            assert_eq!(plan.error(), Some(MigrationError::OutOfOrder));
        });
    }

    // ── Budget regression gates (#610) ───────────────────────────────────────
    //
    // storage_migration is a library crate (no contract struct), so calls run
    // through `env.as_contract(&contract_id, || { … })`.  Budget tracking is
    // still active in this mode and measures real host resource consumption.
    // Ceilings are loose regression sentinels; WASM costs will be higher.

    const BUDGET_CPU_INITIALIZE_SCHEMA: u64 = 300_000;
    const BUDGET_MEM_INITIALIZE_SCHEMA: u64 = 60_000;

    const BUDGET_CPU_BEGIN_MIGRATION: u64 = 300_000;
    const BUDGET_MEM_BEGIN_MIGRATION: u64 = 60_000;

    const BUDGET_CPU_COMPLETE_MIGRATION: u64 = 400_000;
    const BUDGET_MEM_COMPLETE_MIGRATION: u64 = 80_000;

    const BUDGET_CPU_DRY_RUN: u64 = 200_000;
    const BUDGET_MEM_DRY_RUN: u64 = 40_000;

    #[test]
    fn budget_initialize_schema_within_limits() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            env.budget().reset_default();
            initialize_schema(&env, 1);
        });

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_INITIALIZE_SCHEMA,
            "initialize_schema CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_INITIALIZE_SCHEMA,
        );
        assert!(
            mem < BUDGET_MEM_INITIALIZE_SCHEMA,
            "initialize_schema memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_INITIALIZE_SCHEMA,
        );
    }

    #[test]
    fn budget_begin_migration_within_limits() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            env.budget().reset_default();
            let result = begin_migration(&env, 1, 1, 2);
            assert_eq!(result, Ok(()));
        });

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_BEGIN_MIGRATION,
            "begin_migration CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_BEGIN_MIGRATION,
        );
        assert!(
            mem < BUDGET_MEM_BEGIN_MIGRATION,
            "begin_migration memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_BEGIN_MIGRATION,
        );
    }

    #[test]
    fn budget_complete_migration_within_limits() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);
            assert_eq!(begin_migration(&env, 1, 1, 2), Ok(()));

            env.budget().reset_default();
            complete_migration(&env, 1, 2);
        });

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_COMPLETE_MIGRATION,
            "complete_migration CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_COMPLETE_MIGRATION,
        );
        assert!(
            mem < BUDGET_MEM_COMPLETE_MIGRATION,
            "complete_migration memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_COMPLETE_MIGRATION,
        );
    }

    #[test]
    fn budget_dry_run_within_limits() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            env.budget().reset_default();
            let plan = dry_run(&env, 1, 1, 2);
            assert!(plan.applicable);
        });

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_DRY_RUN,
            "dry_run CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_DRY_RUN,
        );
        assert!(
            mem < BUDGET_MEM_DRY_RUN,
            "dry_run memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_DRY_RUN,
        );
    }

    /// Boundary: dry_run on an already-up-to-date schema reports a no-op
    /// and must be just as cheap as a regular dry_run.
    #[test]
    fn budget_dry_run_up_to_date_within_limits() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 2);

            env.budget().reset_default();
            let plan = dry_run(&env, 2, 2, 2);
            assert!(plan.up_to_date);
            assert!(plan.applicable);
        });

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_DRY_RUN,
            "dry_run (up-to-date) CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_DRY_RUN,
        );
        assert!(
            mem < BUDGET_MEM_DRY_RUN,
            "dry_run (up-to-date) memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_DRY_RUN,
        );
    }

    /// Negative: begin_migration with a mismatched `from` version must be
    /// rejected cheaply — the early-exit path costs less than a full migration.
    #[test]
    fn budget_begin_migration_out_of_order_rejected_cheaply() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            env.budget().reset_default();
            let result = begin_migration(&env, 1, 3, 4); // from=3 but stored=1
            assert_eq!(result, Err(MigrationError::OutOfOrder));
        });

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_BEGIN_MIGRATION,
            "rejected begin_migration CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_BEGIN_MIGRATION,
        );
        assert!(
            mem < BUDGET_MEM_BEGIN_MIGRATION,
            "rejected begin_migration memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_BEGIN_MIGRATION,
        );
    }

    #[test]
    fn budget_dry_run_to_within_limits() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_schema(&env, 1);

            env.budget().reset_default();
            let plan = dry_run_to(&env, 1, 2, 3);
            assert!(plan.applicable);
        });

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_DRY_RUN,
            "dry_run_to CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_DRY_RUN,
        );
        assert!(
            mem < BUDGET_MEM_DRY_RUN,
            "dry_run_to memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_DRY_RUN,
        );
    }

    #[test]
    fn budget_validate_migration_target_within_limits() {
        let env = Env::default();
        let contract_id = register_test_contract(&env);

        env.as_contract(&contract_id, || {
            env.budget().reset_default();
            let result = validate_migration_target(1, 2, 3);
            assert_eq!(result, Ok(()));
        });

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_DRY_RUN,
            "validate_migration_target CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_DRY_RUN,
        );
        assert!(
            mem < BUDGET_MEM_DRY_RUN,
            "validate_migration_target memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_DRY_RUN,
        );
    }
}
