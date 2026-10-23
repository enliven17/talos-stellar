//! Registry-specific event emitters for TalosRegistry.
//!
//! All event helpers are `pub(crate)` free functions that take an `&Env`
//! and typed arguments.
//!
//! Timelock events (`tl_sch`, `tl_exec`, `tl_cnl`, `tl_cfg`) and
//! guardian events (`guard_add`, `guard_rem`) are emitted via
//! `admin_controls` to avoid duplication with `TalosNameService`.
//!
//! Event schema (topics → data):
//!   tls_crt  : (symbol, creator: Address)     → (talos_id: u32, name: String, category: String)
//!   pat_upd  : (symbol, talos_id: u32)        → (creator: Address, creator_share: u32, investor_share: u32)
//!   fee_chg  : (symbol,)                      → (old_bps: u32, new_bps: u32)
//!   adm_prp  : (symbol,)                      → (current: Address, proposed: Address)
//!   adm_acc  : (symbol,)                      → (new_admin: Address)
//!   adm_cnl  : (symbol,)                      → (cancelled: Address)
//!   tl_sch   : (symbol, proposal_id: u64)     → (action: AdminAction, eta: u64, proposer: Address)
//!   tl_exec  : (symbol, proposal_id: u64)     → (action: AdminAction, executor: Address)
//!   tl_cnl   : (symbol, proposal_id: u64)     → (action: AdminAction, canceller: Address)
//!   tl_cfg   : (symbol,)                      → (old_min_delay: u64, new_min_delay: u64, grace_period: u64)
//!   dep_path : (symbol,)                      → (deprecated: String, replacement: String)
//!   pause_on : (symbol, domain: PauseDomain)  → (actor: Address, expires_at: u64)
//!   pause_off: (symbol, domain: PauseDomain)  → (actor: Address)
//!   guard_add: (symbol,)                      → (guardian: Address)
//!   guard_rem: (symbol,)                      → (guardian: Address)
//!   allow_add: (symbol,)                      → (asset: Address, admin: Address)
//!   allow_rem: (symbol,)                      → (asset: Address, admin: Address)
//!   tls_paus : (symbol, talos_id: u32)        → (controller: Address)
//!   tls_resu : (symbol, talos_id: u32)        → (controller: Address)

use soroban_sdk::{symbol_short, Address, Env, String};

use crate::{AdminAction, PauseDomain, Patron};

pub(crate) fn emit_talos_created(
    env: &Env,
    talos_id: u32,
    creator: Address,
    name: String,
    category: String,
) {
    let topics = (symbol_short!("tls_crt"), creator.clone());
    env.events()
        .publish(topics, (talos_id, name.clone(), category.clone()));

    let topics2 = (symbol_short!("tls_crt2"), creator);
    env.events().publish(topics2, (1u32, talos_id, name, category));
}

pub(crate) fn emit_patron_updated(env: &Env, talos_id: u32, patron: &Patron) {
    let topics = (symbol_short!("pat_upd"), talos_id);
    env.events().publish(
        topics,
        (
            patron.creator_addr.clone(),
            patron.creator_share,
            patron.investor_share,
        ),
    );
}

pub(crate) fn emit_protocol_fee_changed(env: &Env, old_bps: u32, new_bps: u32) {
    let topics = (symbol_short!("fee_chg"),);
    env.events().publish(topics, (old_bps, new_bps));
}

/// Emitted when the current admin nominates a new admin.
pub(crate) fn emit_admin_proposed(env: &Env, current: Address, proposed: Address) {
    let topics = (symbol_short!("adm_prp"),);
    env.events().publish(topics, (current, proposed));
}

/// Emitted when the pending admin accepts the transfer.
pub(crate) fn emit_admin_accepted(env: &Env, new_admin: Address) {
    let topics = (symbol_short!("adm_acc"),);
    env.events().publish(topics, (new_admin,));
}

/// Emitted when the current admin cancels an in-progress admin transfer.
pub(crate) fn emit_admin_cancelled(env: &Env, cancelled: Address) {
    let topics = (symbol_short!("adm_cnl"),);
    env.events().publish(topics, (cancelled,));
}

pub(crate) fn emit_timelock_scheduled(
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

pub(crate) fn emit_timelock_executed(
    env: &Env,
    proposal_id: u64,
    action: &AdminAction,
    executor: Address,
) {
    let topics = (symbol_short!("tl_exec"), proposal_id);
    env.events().publish(topics, (action.clone(), executor));
}

pub(crate) fn emit_timelock_cancelled(
    env: &Env,
    proposal_id: u64,
    action: &AdminAction,
    canceller: Address,
) {
    let topics = (symbol_short!("tl_cnl"), proposal_id);
    env.events().publish(topics, (action.clone(), canceller));
}

pub(crate) fn emit_timelock_config_changed(
    env: &Env,
    old_min_delay: u64,
    new_min_delay: u64,
    grace_period: u64,
) {
    admin_controls::emit_timelock_config_changed(env, old_min_delay, new_min_delay, grace_period);
}

/// Emitted when a domain is paused or an existing pause is refreshed.
pub(crate) fn emit_pause_set(env: &Env, domain: &PauseDomain, actor: &Address, expires_at: u64) {
    admin_controls::emit_pause_set(env, domain, actor, expires_at);
}

/// Emitted when an admin lifts an active pause on a domain.
pub(crate) fn emit_pause_cleared(env: &Env, domain: &PauseDomain, actor: &Address) {
    admin_controls::emit_pause_cleared(env, domain, actor);
}

pub(crate) fn emit_allowlist_added(env: &Env, asset: Address, admin: Address) {
    let topics = (symbol_short!("allow_add"),);
    env.events().publish(topics, (asset, admin));
}

pub(crate) fn emit_allowlist_removed(env: &Env, asset: Address, admin: Address) {
    let topics = (symbol_short!("allow_rem"),);
    env.events().publish(topics, (asset, admin));
}

pub(crate) fn emit_deprecated_call(env: &Env, deprecated: &str, replacement: &str) {
    let topics = (symbol_short!("dep_path"),);
    env.events().publish(topics, (deprecated, replacement));
}

pub(crate) fn emit_talos_paused(env: &Env, talos_id: u32, controller: Address) {
    let topics = (symbol_short!("tls_paus"), talos_id);
    env.events().publish(topics, controller);
}

pub(crate) fn emit_talos_resumed(env: &Env, talos_id: u32, controller: Address) {
    let topics = (symbol_short!("tls_resu"), talos_id);
    env.events().publish(topics, controller);
}
