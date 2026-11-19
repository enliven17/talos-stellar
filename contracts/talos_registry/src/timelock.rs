//! Timelock administration helpers for TalosRegistry.
//!
//! Validation logic (`validate_timelock_config`, `validate_delay`,
//! `validate_executable`) is delegated to `admin_controls` to avoid
//! duplication with `TalosNameService`. Event emission for timelock events
//! is handled by `crate::events`.

use soroban_sdk::{Address, Env};

use admin_controls;

use crate::{
    events::{
        emit_timelock_cancelled, emit_timelock_config_changed, emit_timelock_executed,
        emit_timelock_scheduled,
    },
    AdminAction, DataKey, ProposalStatus, TimelockConfig, TimelockProposal,
    DEFAULT_GRACE_PERIOD,
};

/// Read the current timelock config from storage, returning a safe default
/// (no delay, 7-day grace period) when nothing has been written yet.
pub(crate) fn get_timelock_config(e: &Env) -> TimelockConfig {
    e.storage()
        .persistent()
        .get(&DataKey::TimelockConfig)
        .unwrap_or(TimelockConfig {
            min_delay: 0,
            grace_period: DEFAULT_GRACE_PERIOD,
        })
}

/// Validate and persist a new timelock config, then emit `tl_cfg`.
/// Delegates constraint checks to `admin_controls::validate_timelock_config`.
pub(crate) fn set_timelock_config_internal(e: &Env, min_delay: u64, grace_period: u64) {
    admin_controls::validate_timelock_config(min_delay, grace_period);

    let old_config = get_timelock_config(e);

    e.storage().persistent().set(
        &DataKey::TimelockConfig,
        &TimelockConfig {
            min_delay,
            grace_period,
        },
    );

    emit_timelock_config_changed(e, old_config.min_delay, min_delay, grace_period);
}

/// Create a new timelock proposal, persist it, and emit `tl_sch`.
/// Delegates delay validation to `admin_controls::validate_delay`.
/// Returns the new proposal ID.
pub(crate) fn schedule_action_internal(
    e: &Env,
    admin: Address,
    action: AdminAction,
    delay: u64,
) -> u64 {
    let config = get_timelock_config(e);
    admin_controls::validate_delay(delay, &config);

    let id: u64 = e
        .storage()
        .persistent()
        .get(&DataKey::NextTimelockId)
        .unwrap_or(1);

    let now = e.ledger().timestamp();
    let eta = now.saturating_add(delay);

    let proposal = TimelockProposal {
        id,
        action: action.clone(),
        eta,
        status: ProposalStatus::Scheduled,
        scheduled_at: now,
        scheduled_by: admin.clone(),
    };

    e.storage()
        .persistent()
        .set(&DataKey::TimelockProposal(id), &proposal);
    e.storage()
        .persistent()
        .set(&DataKey::NextTimelockId, &(id + 1));

    emit_timelock_scheduled(e, id, &action, eta, admin);
    id
}

/// Cancel a scheduled proposal and emit `tl_cnl`.
pub(crate) fn cancel_action_internal(e: &Env, admin: Address, proposal_id: u64) {
    let mut proposal: TimelockProposal = e
        .storage()
        .persistent()
        .get(&DataKey::TimelockProposal(proposal_id))
        .expect("Timelock proposal not found");

    if proposal.status != ProposalStatus::Scheduled {
        panic!("Proposal not active");
    }

    proposal.status = ProposalStatus::Cancelled;
    e.storage()
        .persistent()
        .set(&DataKey::TimelockProposal(proposal_id), &proposal);

    emit_timelock_cancelled(e, proposal_id, &proposal.action, admin);
}

/// Load a proposal and validate it is within the execution window.
/// Delegates timing checks to `admin_controls::validate_executable`.
///
/// # Panics
/// - `"Timelock proposal not found"` — unknown ID
/// - `"Proposal not active"` — already executed or cancelled
/// - `"Timelock delay not met"` — ETA in the future
/// - `"Proposal expired"` — ETA + grace period in the past
pub(crate) fn validate_executable_proposal(e: &Env, proposal_id: u64) -> TimelockProposal {
    let proposal: TimelockProposal = e
        .storage()
        .persistent()
        .get(&DataKey::TimelockProposal(proposal_id))
        .expect("Timelock proposal not found");

    if proposal.status != ProposalStatus::Scheduled {
        panic!("Proposal not active");
    }

    let config = get_timelock_config(e);
    admin_controls::validate_executable(e, proposal.eta, config.grace_period);

    proposal
}

/// Mark a proposal as executed and emit `tl_exec`.
pub(crate) fn mark_executed(e: &Env, mut proposal: TimelockProposal) {
    let executor = proposal.scheduled_by.clone();
    proposal.status = ProposalStatus::Executed;
    e.storage()
        .persistent()
        .set(&DataKey::TimelockProposal(proposal.id), &proposal);
    emit_timelock_executed(e, proposal.id, &proposal.action, executor);
}
