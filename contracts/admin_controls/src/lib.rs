//! admin_controls — Shared timelock and guardian helpers for Talos Protocol
//! Soroban contracts.
//!
//! ## Purpose
//!
//! `TalosRegistry` and `TalosNameService` both implement nearly-identical
//! timelock administration and guardian/pause management logic. This crate
//! centralises the shared parts so each contract can call the helpers rather
//! than duplicating them.
//!
//! ## What is shared
//!
//! | Concern | Helpers |
//! |---------|---------|
//! | Shared types | [`TimelockConfig`], [`ProposalStatus`] |
//! | Timelock events | [`emit_timelock_scheduled`], [`emit_timelock_executed`], [`emit_timelock_cancelled`], [`emit_timelock_config_changed`] |
//! | Timelock validation | [`validate_timelock_config`], [`validate_delay`], [`validate_executable`] |
//! | Action receipts | [`canonical_action_digest`], [`ExecutionReceipt`], [`emit_execution_receipt`] |
//! | Queued actions & delayed cancellation | [`QueuedActionRecord`], [`CancellationRecord`], [`QueuedActionStage`], [`queued_action_stage`], [`validate_queue_config`], [`build_queue_record`], [`validate_cancellable`], [`build_cancellation_record`], [`validate_queued_execution`] |
//! | Guardian events | [`emit_guardian_added`], [`emit_guardian_removed`] |
//! | Guardian helpers | [`add_guardian`], [`remove_guardian`], [`is_guardian`], [`list_guardians`] |
//! | Pause events | [`emit_pause_set`], [`emit_pause_cleared`] |
//! | Pause helpers | [`validate_pause_duration`], [`compute_expires_at`] |
//! | Constants | [`DEFAULT_GRACE_PERIOD`], [`MAX_MIN_DELAY`], [`MAX_GUARDIAN_PAUSE_SECS`], [`MAX_ADMIN_PAUSE_SECS`], [`MAX_GUARDIANS`] |
//!
//! ## What stays contract-specific
//!
//! - The `AdminAction` enum (different variants in each contract)
//! - The `DataKey` enum and storage layout
//! - The `TimelockProposal` type (cannot be made generic due to `#[contracttype]`)
//! - Entry-point authorization (`require_auth` calls)
//! - The `execute_action` dispatch (depends on `AdminAction`)
//!
//! ## Design note
//!
//! Storage keys are owned by each contract so that existing on-chain data is
//! never affected. This crate provides stateless validation helpers and event
//! emitters; all storage reads and writes are performed by the calling contract.

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contracttype, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Val, Vec};

/// Immutable record written after a proposal action executes successfully.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionReceipt {
    /// SHA-256 digest of the domain-separated canonical action XDR.
    pub action_digest: BytesN<32>,
    /// Ledger timestamp at which the action executed.
    pub executed_at: u64,
}

/// Hash a contract action's canonical Soroban ScVal XDR with a domain prefix.
///
/// The namespace prevents identical XDR values in different contract families
/// from being treated as the same approved action.
pub fn canonical_action_digest<T>(env: &Env, namespace: &str, action: &T) -> BytesN<32>
where
    T: Clone + IntoVal<Env, Val>,
{
    let mut payload = Bytes::from_slice(env, namespace.as_bytes());
    payload.append(&action.clone().to_xdr(env));
    env.crypto().sha256(&payload).to_bytes()
}

/// Emit an additive receipt event while preserving the legacy `tl_exec` shape.
pub fn emit_execution_receipt(
    env: &Env,
    namespace: &str,
    proposal_id: u64,
    receipt: &ExecutionReceipt,
) {
    let topics = (symbol_short!("act_rcpt"), proposal_id);
    env.events().publish(
        topics,
        (
            String::from_str(env, namespace),
            receipt.action_digest.clone(),
            receipt.executed_at,
        ),
    );
}
// ── Shared constants ──────────────────────────────────────────────────

/// Default grace period (7 days in seconds) applied when no timelock config
/// has been explicitly set. Both contracts use the same default.
pub const DEFAULT_GRACE_PERIOD: u64 = 604_800;

/// Maximum allowed `min_delay` for a timelock config.
pub const MAX_MIN_DELAY: u64 = 2_592_000; // 30 days

/// Maximum duration a guardian may impose in a single `pause` call (7 days).
/// Guardians cannot impose indefinite pauses.
pub const MAX_GUARDIAN_PAUSE_SECS: u64 = 604_800;

/// Maximum duration the admin may impose in a timed `pause` call (30 days).
/// The admin may also pass `duration = 0` for an indefinite pause.
pub const MAX_ADMIN_PAUSE_SECS: u64 = 2_592_000;

/// Maximum number of registered guardians. Bounds unbounded storage growth.
pub const MAX_GUARDIANS: u32 = 10;

// ── Shared types ──────────────────────────────────────────────────────

/// Timelock delay and grace-period configuration.
///
/// Both contracts store this under their own `DataKey::TimelockConfig`; the
/// shape is identical so only one definition is needed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockConfig {
    /// Minimum seconds an action must wait before it can be executed.
    pub min_delay: u64,
    /// Maximum seconds after ETA during which an action remains executable.
    pub grace_period: u64,
}

/// Lifecycle state of a scheduled administrative proposal.
///
/// Both contracts share the same three-state machine.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Scheduled,
    Executed,
    Cancelled,
}

// ── Timelock event emitters ───────────────────────────────────────────

/// Emit `tl_sch` — a new proposal was scheduled.
///
/// Topics: `(symbol, proposal_id: u64)`
/// Data:   `(action: A, eta: u64, proposer: Address)` — serialised as
///         a tuple; the `action` value is the caller-supplied contract-specific
///         `AdminAction` after it has been converted to `soroban_sdk::Val`.
pub fn emit_timelock_scheduled_raw(
    env: &Env,
    proposal_id: u64,
    action: impl soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
    eta: u64,
    proposer: Address,
) {
    let topics = (symbol_short!("tl_sch"), proposal_id);
    let action_val: soroban_sdk::Val = action.into_val(env);
    env.events().publish(topics, (action_val, eta, proposer));
}

/// Emit `tl_exec` — a proposal was executed.
pub fn emit_timelock_executed_raw(
    env: &Env,
    proposal_id: u64,
    action: impl soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
    executor: Address,
) {
    let topics = (symbol_short!("tl_exec"), proposal_id);
    let action_val: soroban_sdk::Val = action.into_val(env);
    env.events().publish(topics, (action_val, executor));
}

/// Emit `tl_cnl` — a proposal was cancelled.
pub fn emit_timelock_cancelled_raw(
    env: &Env,
    proposal_id: u64,
    action: impl soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
    canceller: Address,
) {
    let topics = (symbol_short!("tl_cnl"), proposal_id);
    let action_val: soroban_sdk::Val = action.into_val(env);
    env.events().publish(topics, (action_val, canceller));
}

/// Emit `tl_cfg` — the timelock configuration was updated.
///
/// Topics: `(symbol,)`
/// Data:   `(old_min_delay: u64, new_min_delay: u64, grace_period: u64)`
pub fn emit_timelock_config_changed(
    env: &Env,
    old_min_delay: u64,
    new_min_delay: u64,
    grace_period: u64,
) {
    let topics = (symbol_short!("tl_cfg"),);
    env.events()
        .publish(topics, (old_min_delay, new_min_delay, grace_period));
}

// ── Timelock validation helpers ───────────────────────────────────────

/// Validate that `(min_delay, grace_period)` are within acceptable bounds.
///
/// # Panics
/// - `"Grace period must be positive"` — `grace_period == 0`
/// - `"Min delay exceeds maximum limit"` — `min_delay > MAX_MIN_DELAY`
pub fn validate_timelock_config(min_delay: u64, grace_period: u64) {
    if grace_period == 0 {
        panic!("Grace period must be positive");
    }
    if min_delay > MAX_MIN_DELAY {
        panic!("Min delay exceeds maximum limit");
    }
}

/// Validate that `delay >= config.min_delay`.
///
/// # Panics
/// - `"Delay less than minimum required delay"` — `delay < config.min_delay`
pub fn validate_delay(delay: u64, config: &TimelockConfig) {
    if delay < config.min_delay {
        panic!("Delay less than minimum required delay");
    }
}

/// Check that `now` is within the execution window `[eta, eta + grace_period]`.
///
/// # Panics
/// - `"Proposal not active"` — if called on an already-executed or cancelled proposal
///   (the caller must check `status == Scheduled` before calling this)
/// - `"Timelock delay not met"` — ETA is still in the future
/// - `"Proposal expired"` — the grace period has elapsed
pub fn validate_executable(env: &Env, eta: u64, grace_period: u64) {
    let now = env.ledger().timestamp();
    if now < eta {
        panic!("Timelock delay not met");
    }
    if now > eta.saturating_add(grace_period) {
        panic!("Proposal expired");
    }
}

// ── Queued actions and delayed cancellation ───────────────────────────
//
// A privileged action that has been approved can be *queued* behind a
// timelock: it becomes executable at `eta = queued_at + min_delay` and stays
// executable until `eta + grace_period`. The delay exists so that the
// privileged authority can veto a harmful action before it takes effect:
//
// | Stage        | Window                         | Cancel | Execute |
// |--------------|--------------------------------|--------|---------|
// | `Pending`    | `now <  eta`                   | yes    | no      |
// | `Executable` | `eta <= now <= eta + grace`    | no     | yes     |
// | `Expired`    | `now >  eta + grace`           | no     | no      |
//
// Cancellation is only possible while the action is still `Pending`; once the
// ETA is reached the approved outcome stands. The records below are written
// once and never deleted, so the queued intent and its cancellation remain
// verifiable after the fact. Which actor may cancel is decided by the calling
// contract (it performs `require_auth`); these helpers enforce *when*.

/// Immutable record of an action queued behind a timelock.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedActionRecord {
    /// Canonical digest of the queued action (see [`canonical_action_digest`]).
    pub action_digest: BytesN<32>,
    /// Ledger timestamp at which the action was queued.
    pub queued_at: u64,
    /// Earliest ledger timestamp at which the action may execute.
    pub eta: u64,
    /// Seconds after `eta` during which the action remains executable.
    pub grace_period: u64,
}

/// Immutable record of a queued action cancelled during its delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CancellationRecord {
    /// Address that authorised the cancellation.
    pub cancelled_by: Address,
    /// Ledger timestamp of the cancellation (always `< eta`).
    pub cancelled_at: u64,
    /// The queue record's ETA, kept alongside for self-contained verification.
    pub eta: u64,
}

/// Stage of a queued action relative to the current ledger time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QueuedActionStage {
    /// Delay not elapsed: cancellable, not yet executable.
    Pending,
    /// Within `[eta, eta + grace_period]`: executable, no longer cancellable.
    Executable,
    /// Grace period elapsed: neither executable nor cancellable.
    Expired,
}

/// Classify `record` at ledger time `now`.
pub fn queued_action_stage(record: &QueuedActionRecord, now: u64) -> QueuedActionStage {
    if now < record.eta {
        QueuedActionStage::Pending
    } else if now <= record.eta.saturating_add(record.grace_period) {
        QueuedActionStage::Executable
    } else {
        QueuedActionStage::Expired
    }
}

/// Validate an execution timelock for queued actions: a valid
/// [`TimelockConfig`] (see [`validate_timelock_config`]) with a non-zero
/// delay, since a zero delay would leave no window in which to cancel.
///
/// # Panics
/// - `"Queue delay must be positive"` — `min_delay == 0`
/// - plus the panics of [`validate_timelock_config`]
pub fn validate_queue_config(config: &TimelockConfig) {
    if config.min_delay == 0 {
        panic!("Queue delay must be positive");
    }
    validate_timelock_config(config.min_delay, config.grace_period);
}

/// Build the queue record for `action_digest` queued now under `config`.
///
/// # Panics
/// - `"Queue ETA overflows"` — `now + min_delay` does not fit in `u64`
/// - plus the panics of [`validate_queue_config`]
pub fn build_queue_record(
    env: &Env,
    action_digest: BytesN<32>,
    config: &TimelockConfig,
) -> QueuedActionRecord {
    validate_queue_config(config);
    let queued_at = env.ledger().timestamp();
    let eta = queued_at
        .checked_add(config.min_delay)
        .unwrap_or_else(|| panic!("Queue ETA overflows"));
    QueuedActionRecord {
        action_digest,
        queued_at,
        eta,
        grace_period: config.grace_period,
    }
}

/// Check that `record` may still be cancelled (it is `Pending`).
///
/// # Panics
/// - `"Cancellation window closed"` — `now >= eta`
pub fn validate_cancellable(env: &Env, record: &QueuedActionRecord) {
    if queued_action_stage(record, env.ledger().timestamp()) != QueuedActionStage::Pending {
        panic!("Cancellation window closed");
    }
}

/// Validate that `record` may be cancelled now and build the cancellation
/// record attributed to `canceller` (whose authorisation the caller checks).
pub fn build_cancellation_record(
    env: &Env,
    record: &QueuedActionRecord,
    canceller: Address,
) -> CancellationRecord {
    validate_cancellable(env, record);
    CancellationRecord {
        cancelled_by: canceller,
        cancelled_at: env.ledger().timestamp(),
        eta: record.eta,
    }
}

/// Check that a queued action may execute now and still carries the digest it
/// was queued with.
///
/// # Panics
/// - `"Queued action digest mismatch"` — `action_digest != record.action_digest`
/// - `"Timelock delay not met"` / `"Proposal expired"` — see [`validate_executable`]
pub fn validate_queued_execution(env: &Env, record: &QueuedActionRecord, action_digest: &BytesN<32>) {
    if *action_digest != record.action_digest {
        panic!("Queued action digest mismatch");
    }
    validate_executable(env, record.eta, record.grace_period);
}

// ── Guardian event emitters ───────────────────────────────────────────

/// Emit `guard_add` — a guardian was registered.
pub fn emit_guardian_added(env: &Env, guardian: &Address) {
    let topics = (symbol_short!("guard_add"),);
    env.events().publish(topics, (guardian.clone(),));
}

/// Emit `guard_rem` — a guardian was deregistered.
pub fn emit_guardian_removed(env: &Env, guardian: &Address) {
    let topics = (symbol_short!("guard_rem"),);
    env.events().publish(topics, (guardian.clone(),));
}

// ── Guardian storage helpers ──────────────────────────────────────────
//
// These helpers operate against the caller-supplied `Vec<Address>` guardian
// list rather than reading/writing storage directly. The contract reads the
// list from its own storage key, calls these helpers, then writes the
// (potentially modified) list back. This keeps storage keys entirely in the
// caller's domain.

/// Add `guardian` to `list` and emit `guard_add`.
///
/// Idempotent: if `guardian` is already in `list`, returns `false` without
/// modifying the list or emitting an event.
///
/// # Panics
/// - `"Guardian limit reached"` — `list.len() >= MAX_GUARDIANS`
///
/// # Returns
/// `true` if added, `false` if already present.
pub fn add_guardian(env: &Env, list: &mut Vec<Address>, guardian: Address) -> bool {
    if list.iter().any(|g| g == guardian) {
        return false;
    }
    if list.len() >= MAX_GUARDIANS {
        panic!("Guardian limit reached");
    }
    list.push_back(guardian.clone());
    emit_guardian_added(env, &guardian);
    true
}

/// Remove `guardian` from `list` and emit `guard_rem`.
///
/// Idempotent: if `guardian` is not in `list`, returns `false` without
/// modifying the list or emitting an event.
///
/// # Returns
/// `true` if removed, `false` if not found.
pub fn remove_guardian(env: &Env, list: &mut Vec<Address>, guardian: Address) -> bool {
    let mut new_list = Vec::new(env);
    let mut found = false;
    for g in list.iter() {
        if g == guardian {
            found = true;
            continue;
        }
        new_list.push_back(g);
    }
    if !found {
        return false;
    }
    *list = new_list;
    emit_guardian_removed(env, &guardian);
    true
}

/// Return `true` if `addr` is in `list`.
pub fn is_guardian(list: &Vec<Address>, addr: &Address) -> bool {
    list.iter().any(|g| g == *addr)
}

// ── Pause event emitters ──────────────────────────────────────────────

/// Emit `pause_on` — a domain was paused or an existing pause was refreshed.
pub fn emit_pause_set<D: soroban_sdk::IntoVal<Env, soroban_sdk::Val> + Clone>(
    env: &Env,
    domain: &D,
    actor: &Address,
    expires_at: u64,
) {
    let topics = (symbol_short!("pause_on"), domain.clone());
    env.events().publish(topics, (actor.clone(), expires_at));
}

/// Emit `pause_off` — a domain was unpaused.
pub fn emit_pause_cleared<D: soroban_sdk::IntoVal<Env, soroban_sdk::Val> + Clone>(
    env: &Env,
    domain: &D,
    actor: &Address,
) {
    let topics = (symbol_short!("pause_off"), domain.clone());
    env.events().publish(topics, (actor.clone(),));
}

// ── Pause validation helpers ──────────────────────────────────────────

/// Validate pause duration for an admin or guardian caller.
///
/// Rules:
/// - Admin (`is_admin = true`): `duration = 0` is allowed (indefinite);
///   non-zero must be ≤ `MAX_ADMIN_PAUSE_SECS`.
/// - Guardian (`is_admin = false`): duration must be `1..=MAX_GUARDIAN_PAUSE_SECS`.
///
/// # Panics
/// - `"Duration exceeds admin maximum"` — admin non-zero duration too large.
/// - `"Guardian pause duration out of bounds"` — guardian duration 0 or too large.
///
/// # Returns
/// The computed `expires_at` timestamp (`0` means indefinite).
pub fn compute_expires_at(env: &Env, is_admin: bool, duration: u64) -> u64 {
    let now = env.ledger().timestamp();
    if is_admin {
        if duration == 0 {
            0 // indefinite
        } else {
            if duration > MAX_ADMIN_PAUSE_SECS {
                panic!("Duration exceeds admin maximum");
            }
            now.saturating_add(duration)
        }
    } else {
        if duration == 0 || duration > MAX_GUARDIAN_PAUSE_SECS {
            panic!("Guardian pause duration out of bounds");
        }
        now.saturating_add(duration)
    }
}

// ── Crate-level unit tests ─────────────────────────────────────────────

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, Env};

    fn setup() -> Env {
        Env::default()
    }

    // ── validate_timelock_config ─────────────────────────────────────

    #[test]
    fn validate_timelock_config_accepts_valid_inputs() {
        // min_delay = 0 is allowed (disables timelock); grace_period > 0 is required
        validate_timelock_config(0, 1);
        validate_timelock_config(3_600, 86_400);
        validate_timelock_config(MAX_MIN_DELAY, DEFAULT_GRACE_PERIOD);
    }

    #[test]
    #[should_panic(expected = "Grace period must be positive")]
    fn validate_timelock_config_rejects_zero_grace_period() {
        validate_timelock_config(0, 0);
    }

    #[test]
    #[should_panic(expected = "Min delay exceeds maximum limit")]
    fn validate_timelock_config_rejects_delay_above_max() {
        validate_timelock_config(MAX_MIN_DELAY + 1, DEFAULT_GRACE_PERIOD);
    }

    // ── validate_delay ───────────────────────────────────────────────

    #[test]
    fn validate_delay_accepts_delay_at_minimum() {
        let config = TimelockConfig {
            min_delay: 3_600,
            grace_period: DEFAULT_GRACE_PERIOD,
        };
        validate_delay(3_600, &config); // exactly minimum
        validate_delay(7_200, &config); // above minimum
    }

    #[test]
    #[should_panic(expected = "Delay less than minimum required delay")]
    fn validate_delay_rejects_delay_below_minimum() {
        let config = TimelockConfig {
            min_delay: 3_600,
            grace_period: DEFAULT_GRACE_PERIOD,
        };
        validate_delay(3_599, &config);
    }

    // ── validate_executable ──────────────────────────────────────────

    #[test]
    fn validate_executable_accepts_within_window() {
        let env = setup();
        // Default ledger timestamp is 0; eta = 0 is already met.
        validate_executable(&env, 0, DEFAULT_GRACE_PERIOD);
    }

    #[test]
    #[should_panic(expected = "Timelock delay not met")]
    fn validate_executable_rejects_future_eta() {
        let env = setup();
        // eta is in the future relative to ledger time 0.
        validate_executable(&env, 1, DEFAULT_GRACE_PERIOD);
    }

    #[test]
    #[should_panic(expected = "Proposal expired")]
    fn validate_executable_rejects_expired_proposal() {
        let env = setup();
        // eta = 0, grace_period = 0 → the window is [0, 0]; one second later
        // it has expired. (At the default timestamp 0 it is still executable.)
        env.ledger().set_timestamp(1);
        validate_executable(&env, 0, 0);
    }

    // ── queued actions / delayed cancellation ────────────────────────

    fn digest(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }

    fn queue_config() -> TimelockConfig {
        TimelockConfig { min_delay: 3_600, grace_period: 86_400 }
    }

    #[test]
    fn build_queue_record_sets_eta_from_delay() {
        let env = setup();
        env.ledger().set_timestamp(1_000);
        let record = build_queue_record(&env, digest(&env, 1), &queue_config());
        assert_eq!(
            record,
            QueuedActionRecord {
                action_digest: digest(&env, 1),
                queued_at: 1_000,
                eta: 4_600,
                grace_period: 86_400,
            }
        );
    }

    #[test]
    #[should_panic(expected = "Queue delay must be positive")]
    fn build_queue_record_rejects_zero_delay() {
        let env = setup();
        build_queue_record(&env, digest(&env, 1), &TimelockConfig { min_delay: 0, grace_period: 1 });
    }

    #[test]
    #[should_panic(expected = "Grace period must be positive")]
    fn build_queue_record_rejects_zero_grace() {
        let env = setup();
        build_queue_record(&env, digest(&env, 1), &TimelockConfig { min_delay: 1, grace_period: 0 });
    }

    #[test]
    #[should_panic(expected = "Queue ETA overflows")]
    fn build_queue_record_rejects_eta_overflow() {
        let env = setup();
        env.ledger().set_timestamp(u64::MAX - 10);
        build_queue_record(&env, digest(&env, 1), &queue_config());
    }

    #[test]
    fn queued_action_stage_boundaries() {
        let record = QueuedActionRecord {
            action_digest: digest(&setup(), 1),
            queued_at: 0,
            eta: 100,
            grace_period: 50,
        };
        assert_eq!(queued_action_stage(&record, 99), QueuedActionStage::Pending);
        assert_eq!(queued_action_stage(&record, 100), QueuedActionStage::Executable);
        assert_eq!(queued_action_stage(&record, 150), QueuedActionStage::Executable);
        assert_eq!(queued_action_stage(&record, 151), QueuedActionStage::Expired);
    }

    #[test]
    fn cancellation_allowed_until_one_second_before_eta() {
        let env = setup();
        env.ledger().set_timestamp(1_000);
        let record = build_queue_record(&env, digest(&env, 1), &queue_config());
        let canceller = Address::generate(&env);

        env.ledger().set_timestamp(record.eta - 1);
        let cancellation = build_cancellation_record(&env, &record, canceller.clone());
        assert_eq!(
            cancellation,
            CancellationRecord { cancelled_by: canceller, cancelled_at: record.eta - 1, eta: record.eta }
        );
    }

    #[test]
    #[should_panic(expected = "Cancellation window closed")]
    fn cancellation_rejected_at_eta() {
        let env = setup();
        env.ledger().set_timestamp(1_000);
        let record = build_queue_record(&env, digest(&env, 1), &queue_config());
        env.ledger().set_timestamp(record.eta);
        build_cancellation_record(&env, &record, Address::generate(&env));
    }

    #[test]
    #[should_panic(expected = "Cancellation window closed")]
    fn cancellation_rejected_after_expiry() {
        let env = setup();
        let record = build_queue_record(&env, digest(&env, 1), &queue_config());
        env.ledger().set_timestamp(record.eta + record.grace_period + 1);
        validate_cancellable(&env, &record);
    }

    #[test]
    fn queued_execution_allowed_within_window() {
        let env = setup();
        let record = build_queue_record(&env, digest(&env, 1), &queue_config());
        env.ledger().set_timestamp(record.eta);
        validate_queued_execution(&env, &record, &digest(&env, 1));
        env.ledger().set_timestamp(record.eta + record.grace_period);
        validate_queued_execution(&env, &record, &digest(&env, 1));
    }

    #[test]
    #[should_panic(expected = "Timelock delay not met")]
    fn queued_execution_rejected_before_eta() {
        let env = setup();
        let record = build_queue_record(&env, digest(&env, 1), &queue_config());
        env.ledger().set_timestamp(record.eta - 1);
        validate_queued_execution(&env, &record, &digest(&env, 1));
    }

    #[test]
    #[should_panic(expected = "Queued action digest mismatch")]
    fn queued_execution_rejects_a_different_action() {
        let env = setup();
        let record = build_queue_record(&env, digest(&env, 1), &queue_config());
        env.ledger().set_timestamp(record.eta);
        validate_queued_execution(&env, &record, &digest(&env, 2));
    }

    // ── add_guardian / remove_guardian / is_guardian ─────────────────

    #[test]
    fn add_guardian_adds_and_reports_true() {
        let env = setup();
        let mut list = Vec::new(&env);
        let g = Address::generate(&env);
        assert!(add_guardian(&env, &mut list, g.clone()));
        assert_eq!(list.len(), 1);
        assert!(is_guardian(&list, &g));
    }

    #[test]
    fn add_guardian_is_idempotent() {
        let env = setup();
        let mut list = Vec::new(&env);
        let g = Address::generate(&env);
        assert!(add_guardian(&env, &mut list, g.clone()));
        assert!(!add_guardian(&env, &mut list, g.clone())); // second call → false
        assert_eq!(list.len(), 1);
    }

    #[test]
    #[should_panic(expected = "Guardian limit reached")]
    fn add_guardian_panics_when_at_max() {
        let env = setup();
        let mut list = Vec::new(&env);
        for _ in 0..MAX_GUARDIANS {
            let g = Address::generate(&env);
            add_guardian(&env, &mut list, g);
        }
        // One more should panic.
        let g = Address::generate(&env);
        add_guardian(&env, &mut list, g);
    }

    #[test]
    fn remove_guardian_removes_and_reports_true() {
        let env = setup();
        let mut list = Vec::new(&env);
        let g = Address::generate(&env);
        add_guardian(&env, &mut list, g.clone());
        assert!(remove_guardian(&env, &mut list, g.clone()));
        assert_eq!(list.len(), 0);
        assert!(!is_guardian(&list, &g));
    }

    #[test]
    fn remove_guardian_is_idempotent() {
        let env = setup();
        let mut list = Vec::new(&env);
        let g = Address::generate(&env);
        add_guardian(&env, &mut list, g.clone());
        assert!(remove_guardian(&env, &mut list, g.clone()));
        assert!(!remove_guardian(&env, &mut list, g.clone())); // second call → false
    }

    #[test]
    fn is_guardian_returns_false_for_unknown_address() {
        let env = setup();
        let list = Vec::new(&env);
        let g = Address::generate(&env);
        assert!(!is_guardian(&list, &g));
    }

    // ── compute_expires_at ───────────────────────────────────────────

    #[test]
    fn compute_expires_at_admin_zero_returns_zero() {
        let env = setup();
        assert_eq!(compute_expires_at(&env, true, 0), 0);
    }

    #[test]
    fn compute_expires_at_admin_nonzero_returns_offset() {
        let env = setup();
        // Ledger timestamp defaults to 0.
        let result = compute_expires_at(&env, true, 3_600);
        assert_eq!(result, 3_600);
    }

    #[test]
    #[should_panic(expected = "Duration exceeds admin maximum")]
    fn compute_expires_at_admin_exceeds_max() {
        let env = setup();
        compute_expires_at(&env, true, MAX_ADMIN_PAUSE_SECS + 1);
    }

    #[test]
    fn compute_expires_at_guardian_valid_returns_offset() {
        let env = setup();
        let result = compute_expires_at(&env, false, 3_600);
        assert_eq!(result, 3_600);
    }

    #[test]
    #[should_panic(expected = "Guardian pause duration out of bounds")]
    fn compute_expires_at_guardian_zero_panics() {
        let env = setup();
        compute_expires_at(&env, false, 0);
    }

    #[test]
    #[should_panic(expected = "Guardian pause duration out of bounds")]
    fn compute_expires_at_guardian_exceeds_max() {
        let env = setup();
        compute_expires_at(&env, false, MAX_GUARDIAN_PAUSE_SECS + 1);
    }

    // ── TimelockConfig and ProposalStatus types ──────────────────────

    #[test]
    fn timelock_config_fields_are_accessible() {
        let cfg = TimelockConfig {
            min_delay: 3_600,
            grace_period: DEFAULT_GRACE_PERIOD,
        };
        assert_eq!(cfg.min_delay, 3_600);
        assert_eq!(cfg.grace_period, DEFAULT_GRACE_PERIOD);
    }

    #[test]
    fn proposal_status_equality() {
        assert_eq!(ProposalStatus::Scheduled, ProposalStatus::Scheduled);
        assert_ne!(ProposalStatus::Scheduled, ProposalStatus::Executed);
        assert_ne!(ProposalStatus::Scheduled, ProposalStatus::Cancelled);
        assert_ne!(ProposalStatus::Executed, ProposalStatus::Cancelled);
    }
}

#[cfg(test)]
mod action_digest_tests {
    use super::canonical_action_digest;
    use soroban_sdk::{contracttype, Env};

    #[contracttype]
    #[derive(Clone)]
    enum FixtureAction {
        SetFee(u32),
    }

    #[test]
    fn canonical_digest_is_stable_for_the_same_action() {
        let env = Env::default();
        let action = FixtureAction::SetFee(125);
        let first = canonical_action_digest(&env, "TalosRegistry", &action);
        let second = canonical_action_digest(&env, "TalosRegistry", &action);
        assert_eq!(first, second);
    }

    #[test]
    fn canonical_digest_binds_namespace_and_payload() {
        let env = Env::default();
        let action = FixtureAction::SetFee(125);
        let changed_action = FixtureAction::SetFee(126);
        assert_ne!(
            canonical_action_digest(&env, "TalosRegistry", &action),
            canonical_action_digest(&env, "TalosRegistry", &changed_action),
        );
        assert_ne!(
            canonical_action_digest(&env, "TalosRegistry", &action),
            canonical_action_digest(&env, "TalosNameService", &action),
        );
    }
}