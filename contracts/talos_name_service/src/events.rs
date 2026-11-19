//! Event emission functions for TalosNameService.

use super::admin::AdminAction;
use super::types::PauseDomain;
use soroban_sdk::{symbol_short, Address, Env};

/// Emit a name registration event.
///
/// Emits both legacy `name_reg` and versioned `name_reg2` events.
pub fn emit_name_registered(env: &Env, talos_id: u32, name: soroban_sdk::String, owner: Address) {
    let topics = (symbol_short!("name_reg"), talos_id);
    env.events().publish(topics, (name.clone(), owner.clone()));

    let topics2 = (symbol_short!("name_reg2"), talos_id);
    env.events().publish(topics2, (1u32, name, owner));
}

/// Emit a registry contract update event.
pub fn emit_registry_updated(env: &Env, old_registry: Address, new_registry: Address) {
    let topics = (symbol_short!("reg_upd"),);
    env.events().publish(topics, (old_registry, new_registry));
}

/// Emit a timelock action scheduled event.
pub fn emit_timelock_scheduled(
    env: &Env,
    proposal_id: u64,
    action: &AdminAction,
    eta: u64,
    proposer: Address,
) {
    let topics = (symbol_short!("tl_sch"), proposal_id);
    env.events()
        .publish(topics, (action.clone(), eta, proposer));
}

/// Emit a timelock action executed event.
pub fn emit_timelock_executed(env: &Env, proposal_id: u64, action: &AdminAction, executor: Address) {
    let topics = (symbol_short!("tl_exec"), proposal_id);
    env.events().publish(topics, (action.clone(), executor));
}

/// Emit a timelock action cancelled event.
pub fn emit_timelock_cancelled(env: &Env, proposal_id: u64, action: &AdminAction, canceller: Address) {
    let topics = (symbol_short!("tl_cnl"), proposal_id);
    env.events().publish(topics, (action.clone(), canceller));
}

/// Emit a timelock configuration changed event.
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

/// Emit a pause set event.
pub fn emit_pause_set(env: &Env, domain: &PauseDomain, actor: &Address, expires_at: u64) {
    let topics = (symbol_short!("pause_on"), domain.clone());
    env.events().publish(topics, (actor.clone(), expires_at));
}

/// Emit a pause cleared event.
pub fn emit_pause_cleared(env: &Env, domain: &PauseDomain, actor: &Address) {
    let topics = (symbol_short!("pause_off"), domain.clone());
    env.events().publish(topics, (actor.clone(),));
}

/// Emit a guardian added event.
pub fn emit_guardian_added(env: &Env, guardian: Address) {
    let topics = (symbol_short!("guard_add"),);
    env.events().publish(topics, (guardian,));
}

/// Emit a guardian removed event.
pub fn emit_guardian_removed(env: &Env, guardian: Address) {
    let topics = (symbol_short!("guard_rem"),);
    env.events().publish(topics, (guardian,));
}

/// Emit a name fee paid event.
pub fn emit_name_fee_paid(env: &Env, talos_id: u32, payer: &Address, asset: &Address, fee: i128) {
    let topics = (symbol_short!("name_fee"), talos_id);
    env.events().publish(topics, (payer.clone(), asset.clone(), fee));
}

/// Emit a deprecation event for legacy direct-admin paths.
pub fn emit_deprecated_call(env: &Env, deprecated: &str, replacement: &str) {
    let topics = (symbol_short!("dep_path"),);
    env.events()
        .publish(topics, (deprecated, replacement));
}
