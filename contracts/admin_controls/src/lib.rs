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

use soroban_sdk::{contracttype, symbol_short, Address, Env, Vec};

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
    use soroban_sdk::{testutils::Address as _, Address, Env};

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
        // eta = 0, grace_period = 0 → already expired.
        validate_executable(&env, 0, 0);
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
