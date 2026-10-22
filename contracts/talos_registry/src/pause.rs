//! Emergency pause and guardian helpers for TalosRegistry.
//!
//! Guardian list storage lives under `DataKey::Guardians`. The guardian
//! add/remove/check logic is delegated to `admin_controls` to avoid
//! duplication with `TalosNameService`. Domain pause state is stored under
//! `DataKey::PauseState(PauseDomain)` and handled locally here.

use soroban_sdk::{Address, Env, Vec};

use admin_controls;

use crate::{
    events::{emit_pause_cleared, emit_pause_set},
    DataKey, PauseDomain, PauseInfo, PauseState,
};

// ── Guardian helpers ─────────────────────────────────────────────────

pub(crate) fn get_guardians(e: &Env) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::Guardians)
        .unwrap_or(Vec::new(e))
}

pub(crate) fn is_guardian_internal(e: &Env, addr: &Address) -> bool {
    let guardians = get_guardians(e);
    admin_controls::is_guardian(&guardians, addr)
}

// ── Domain pause helpers ─────────────────────────────────────────────

/// Evaluate whether `domain` is currently paused, lazily treating an expired
/// (non-indefinite) pause record as inactive without mutating storage.
pub(crate) fn is_domain_paused(e: &Env, domain: &PauseDomain) -> bool {
    match e
        .storage()
        .persistent()
        .get::<_, PauseState>(&DataKey::PauseState(domain.clone()))
    {
        None => false,
        Some(state) => state.expires_at == 0 || e.ledger().timestamp() < state.expires_at,
    }
}

/// Apply a pause to `domain` on behalf of `caller`.
///
/// Duration semantics are enforced by `admin_controls::compute_expires_at`.
/// A guardian cannot overwrite a pause that the admin established.
///
/// # Panics
/// - `"Domain locked by admin; guardians cannot modify"` — guardian tried to
///   overwrite an admin lock.
/// - `"Duration exceeds admin maximum"` — admin non-zero duration too large.
/// - `"Guardian pause duration out of bounds"` — guardian duration invalid.
pub(crate) fn apply_pause(
    e: &Env,
    caller: &Address,
    admin: &Address,
    is_admin_caller: bool,
    domain: PauseDomain,
    duration: u64,
) {
    let key = DataKey::PauseState(domain.clone());

    if !is_admin_caller {
        if let Some(existing) = e.storage().persistent().get::<_, PauseState>(&key) {
            if existing.paused_by == *admin {
                panic!("Domain locked by admin; guardians cannot modify");
            }
        }
    }

    let now = e.ledger().timestamp();
    let expires_at = admin_controls::compute_expires_at(e, is_admin_caller, duration);

    e.storage().persistent().set(
        &key,
        &PauseState {
            paused_by: caller.clone(),
            paused_at: now,
            expires_at,
        },
    );

    emit_pause_set(e, &domain, caller, expires_at);
}

/// Lift a pause from `domain`. No-op if the domain is not currently paused.
/// Emits `pause_off` only when a record was actually present.
pub(crate) fn clear_pause(e: &Env, admin: &Address, domain: PauseDomain) {
    let key = DataKey::PauseState(domain.clone());
    if e.storage().persistent().get::<_, PauseState>(&key).is_none() {
        return;
    }
    e.storage().persistent().remove(&key);
    emit_pause_cleared(e, &domain, admin);
}

/// Build a read-friendly [`PauseInfo`] view from raw storage.
pub(crate) fn pause_info(e: &Env, domain: PauseDomain) -> PauseInfo {
    match e
        .storage()
        .persistent()
        .get::<_, PauseState>(&DataKey::PauseState(domain.clone()))
    {
        None => PauseInfo {
            active: false,
            paused_by: None,
            paused_at: None,
            expires_at: None,
        },
        Some(state) => {
            let active = state.expires_at == 0 || e.ledger().timestamp() < state.expires_at;
            PauseInfo {
                active,
                paused_by: Some(state.paused_by),
                paused_at: Some(state.paused_at),
                expires_at: if state.expires_at == 0 {
                    None
                } else {
                    Some(state.expires_at)
                },
            }
        }
    }
}
