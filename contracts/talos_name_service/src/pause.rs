//! Pause domain helper functions for TalosNameService.

use soroban_sdk::{Address, Env, Vec};

use super::types::{DataKey, PauseDomain, PauseState, PauseInfo};

/// Maximum pause duration for guardians: 7 days in seconds.
pub const MAX_GUARDIAN_PAUSE_SECS: u64 = 604_800;

/// Maximum pause duration for admin: 30 days in seconds.
pub const MAX_ADMIN_PAUSE_SECS: u64 = 2_592_000;

/// Maximum number of guardians allowed.
pub const MAX_GUARDIANS: u32 = 10;

/// Pause domain for name registration.
pub const PAUSE_NAME_REGISTRATION: u32 = 5;
/// Pause domain for name service configuration (admin, registry, timelock).
pub const PAUSE_NAME_CONFIG: u32 = 6;

/// Get the list of guardian addresses.
pub fn get_guardians(e: &Env) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::Guardians)
        .unwrap_or(Vec::new(e))
}

/// Check if an address is a guardian.
pub fn is_guardian_internal(e: &Env, addr: &Address) -> bool {
    get_guardians(e).iter().any(|g| g == *addr)
}

/// Evaluate whether `domain` is currently paused, lazily treating an expired
/// (non-indefinite) pause record as inactive without mutating storage.
pub fn is_domain_paused(e: &Env, domain: &PauseDomain) -> bool {
    match e
        .storage()
        .persistent()
        .get::<_, PauseState>(&DataKey::PauseState(domain.clone()))
    {
        None => false,
        Some(state) => state.expires_at == 0 || e.ledger().timestamp() < state.expires_at,
    }
}

/// Pause a single write-path domain, blocking it while leaving all
/// reads fully functional.
pub fn pause(e: &Env, caller: Address, domain: PauseDomain, duration: u64) {
    use soroban_sdk::panic_with_error;
    use super::types::ContractError;

    caller.require_auth();

    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");

    let is_admin_caller = caller == admin;
    if !is_admin_caller && !is_guardian_internal(e, &caller) {
        panic_with_error!(e, ContractError::NotAdminOrGuardian);
    }

    let key = DataKey::PauseState(domain.clone());

    if !is_admin_caller {
        if let Some(existing) = e.storage().persistent().get::<_, PauseState>(&key) {
            if existing.paused_by == admin {
                panic_with_error!(e, ContractError::DomainLockedByAdmin);
            }
        }
    }

    let now = e.ledger().timestamp();
    let expires_at = if is_admin_caller {
        if duration == 0 {
            0
        } else {
            if duration > MAX_ADMIN_PAUSE_SECS {
                panic_with_error!(e, ContractError::InvalidPauseDuration);
            }
            now.saturating_add(duration)
        }
    } else {
        if duration == 0 || duration > MAX_GUARDIAN_PAUSE_SECS {
            panic_with_error!(e, ContractError::InvalidPauseDuration);
        }
        now.saturating_add(duration)
    };

    e.storage().persistent().set(
        &key,
        &PauseState {
            paused_by: caller.clone(),
            paused_at: now,
            expires_at,
        },
    );

    super::events::emit_pause_set(e, &domain, &caller, expires_at);
}

/// Lift an active pause on `domain`. Idempotent no-op if not paused.
pub fn unpause(e: &Env, domain: PauseDomain) {
    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");
    admin.require_auth();

    let key = DataKey::PauseState(domain.clone());
    if e.storage().persistent().get::<_, PauseState>(&key).is_none() {
        return;
    }

    e.storage().persistent().remove(&key);
    super::events::emit_pause_cleared(e, &domain, &admin);
}

/// Returns `true` if `domain` is currently paused (and not yet expired).
pub fn is_paused(e: &Env, domain: PauseDomain) -> bool {
    is_domain_paused(e, &domain)
}

/// Full observability view of a domain's pause status.
pub fn pause_info(e: &Env, domain: PauseDomain) -> PauseInfo {
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

/// Register a guardian address authorized to trigger (but never lift)
/// bounded-duration pauses. Idempotent; bounded to `MAX_GUARDIANS`.
pub fn add_guardian(e: &Env, guardian: Address) {
    use soroban_sdk::panic_with_error;
    use super::types::ContractError;

    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");
    admin.require_auth();

    let mut guardians = get_guardians(e);
    if guardians.iter().any(|g| g == guardian) {
        return;
    }
    if guardians.len() >= MAX_GUARDIANS {
        panic_with_error!(e, ContractError::GuardianLimitReached);
    }

    guardians.push_back(guardian.clone());
    e.storage().persistent().set(&DataKey::Guardians, &guardians);
    super::events::emit_guardian_added(e, guardian);
}

/// Revoke a guardian's pause authority. Idempotent.
pub fn remove_guardian(e: &Env, guardian: Address) {
    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");
    admin.require_auth();

    let guardians = get_guardians(e);
    let mut remaining = Vec::new(e);
    let mut found = false;
    for g in guardians.iter() {
        if g == guardian {
            found = true;
            continue;
        }
        remaining.push_back(g);
    }

    if !found {
        return;
    }

    e.storage().persistent().set(&DataKey::Guardians, &remaining);
    super::events::emit_guardian_removed(e, guardian);
}

/// Check whether `addr` currently holds guardian pause authority.
pub fn is_guardian(e: &Env, addr: Address) -> bool {
    is_guardian_internal(e, &addr)
}

/// List all currently registered guardians (bounded to `MAX_GUARDIANS`).
pub fn list_guardians(e: &Env) -> Vec<Address> {
    get_guardians(e)
}

/// Pause a domain via pause_control (for register_name gating).
pub fn pause_domain(e: &Env, domain_id: u32, duration: u64) {
    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");
    pause_control::pause_domain(e, domain_id, &admin, duration);
}

/// Unpause a domain via pause_control.
pub fn unpause_domain(e: &Env, domain_id: u32) {
    let admin: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .expect("Admin not configured");
    pause_control::unpause_domain(e, domain_id, &admin);
}

/// Check whether a domain is paused via pause_control.
pub fn is_domain_paused_scoped(e: &Env, domain_id: u32) -> bool {
    pause_control::check_not_paused(e, domain_id);
    pause_control::is_paused(e, domain_id)
}

/// Get the pause status for a domain via pause_control.
pub fn get_domain_pause_status(e: &Env, domain_id: u32) -> Option<pause_control::PauseStatus> {
    pause_control::get_pause_status(e, domain_id)
}
