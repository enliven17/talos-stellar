use soroban_sdk::{Address, Env};

use crate::events::{emit_timelock_cancelled, emit_timelock_config_changed, emit_timelock_executed, emit_timelock_scheduled};
use crate::pause::PAUSE_NAME_CONFIG;
use crate::types::DataKey;
use crate::admin::{AdminAction, ProposalStatus, TimelockConfig, TimelockProposal, DEFAULT_GRACE_PERIOD, MAX_MIN_DELAY};
use pause_control;

/// Set or transfer admin role for TalosNameService.
pub fn set_admin(e: &Env, new_admin: Address) {
    pause_control::check_not_paused(e, PAUSE_NAME_CONFIG);

    if let Some(admin) = e.storage().persistent().get::<_, Address>(&DataKey::Admin) {
        admin.require_auth();
    }
    e.storage().persistent().set(&DataKey::Admin, &new_admin);
}

/// Update the registered TalosRegistry contract address.
///
/// Requires admin authorization. If timelock is enabled (`min_delay > 0`),
/// this action must be scheduled and executed via `execute_action`.
///
/// **Deprecation:** When timelock is enabled, this direct path is
/// rejected with a privacy-safe `dep_path` event before panicking.
/// Callers should `schedule_action(SetRegistryContract(..), delay)`
/// and `execute_action` after the ETA.
pub fn set_registry_contract(e: &Env, new_registry_id: Address) {
    pause_control::check_not_paused(e, PAUSE_NAME_CONFIG);

    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");
    admin.require_auth();

    let config = get_timelock_config_owned(e.clone());
    if config.min_delay > 0 {
        crate::events::emit_deprecated_call(
            e,
            "set_registry_contract (direct, pre-timelock)",
            "schedule_action(SetRegistryContract, ..) + execute_action",
        );
        soroban_sdk::panic_with_error!(e, crate::types::ContractError::TimelockEnabled);
    }

    let old: Address = e
        .storage()
        .persistent()
        .get(&DataKey::RegistryContract)
        .expect("Registry contract not initialized");

    e.storage()
        .persistent()
        .set(&DataKey::RegistryContract, &new_registry_id);

    crate::events::emit_registry_updated(e, old, new_registry_id);
}

// ── Timelock Administration ─────────────────────────────────────

/// Configure timelock parameter settings (`min_delay` and `grace_period`).
pub fn set_timelock_config(e: &Env, min_delay: u64, grace_period: u64) {
    pause_control::check_not_paused(e, PAUSE_NAME_CONFIG);

    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");
    admin.require_auth();

    if grace_period == 0 {
        panic!("Grace period must be positive");
    }
    if min_delay > MAX_MIN_DELAY {
        panic!("Min delay exceeds maximum limit");
    }

    let old_config = get_timelock_config_owned(e.clone());

    let new_config = TimelockConfig {
        min_delay,
        grace_period,
    };

    e.storage()
        .persistent()
        .set(&DataKey::TimelockConfig, &new_config);

    emit_timelock_config_changed(e, old_config.min_delay, min_delay, grace_period);
}

/// Retrieve active timelock configuration.
pub fn get_timelock_config(e: &Env) -> TimelockConfig {
    e.storage()
        .persistent()
        .get(&DataKey::TimelockConfig)
        .unwrap_or(TimelockConfig {
            min_delay: 0,
            grace_period: DEFAULT_GRACE_PERIOD,
        })
}

/// Retrieve active timelock configuration (owned Env version).
pub fn get_timelock_config_owned(e: Env) -> TimelockConfig {
    e.storage()
        .persistent()
        .get(&DataKey::TimelockConfig)
        .unwrap_or(TimelockConfig {
            min_delay: 0,
            grace_period: DEFAULT_GRACE_PERIOD,
        })
}

/// Schedule an administrative action for future execution.
pub fn schedule_action(e: &Env, action: AdminAction, delay: u64) -> u64 {
    pause_control::check_not_paused(e, PAUSE_NAME_CONFIG);

    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");
    admin.require_auth();

    let config = get_timelock_config_owned(e.clone());
    if delay < config.min_delay {
        panic!("Delay less than minimum required delay");
    }

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

/// Execute a scheduled action after its timelock ETA has matured.
pub fn execute_action(e: &Env, proposal_id: u64) {
    let mut proposal: TimelockProposal = e
        .storage()
        .persistent()
        .get(&DataKey::TimelockProposal(proposal_id))
        .expect("Timelock proposal not found");

    if proposal.status != ProposalStatus::Scheduled {
        panic!("Proposal not active");
    }

    let now = e.ledger().timestamp();
    if now < proposal.eta {
        panic!("Timelock delay not met");
    }

    let config = get_timelock_config_owned(e.clone());
    if now > proposal.eta.saturating_add(config.grace_period) {
        panic!("Proposal expired");
    }

    match &proposal.action {
        AdminAction::SetRegistryContract(new_registry_id) => {
            let old: Address = e
                .storage()
                .persistent()
                .get(&DataKey::RegistryContract)
                .expect("Registry contract not initialized");

            e.storage()
                .persistent()
                .set(&DataKey::RegistryContract, &new_registry_id);

            crate::events::emit_registry_updated(e, old, new_registry_id.clone());
        }
        AdminAction::SetAdmin(new_admin) => {
            e.storage().persistent().set(&DataKey::Admin, new_admin);
        }
    }

    proposal.status = ProposalStatus::Executed;
    e.storage()
        .persistent()
        .set(&DataKey::TimelockProposal(proposal_id), &proposal);

    let executor = proposal.scheduled_by.clone();
    emit_timelock_executed(e, proposal_id, &proposal.action, executor);
}

/// Cancel a scheduled action.
pub fn cancel_action(e: &Env, proposal_id: u64) {
    pause_control::check_not_paused(e, PAUSE_NAME_CONFIG);

    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");
    admin.require_auth();

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

/// Retrieve a timelock proposal by ID.
pub fn get_timelock_proposal(e: &Env, proposal_id: u64) -> Option<TimelockProposal> {
    e.storage()
        .persistent()
        .get(&DataKey::TimelockProposal(proposal_id))
}
