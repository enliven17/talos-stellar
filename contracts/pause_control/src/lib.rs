#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{contracttype, symbol_short, Address, Env};

pub type DomainId = u32;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseStatus {
    pub paused: bool,
    pub paused_by: Address,
    pub paused_at: u64,
    pub expires_at: u64,
}

#[contracttype]
pub enum PauseDataKey {
    PauseStatus(DomainId),
}

pub fn is_paused(env: &Env, domain_id: DomainId) -> bool {
    let key = PauseDataKey::PauseStatus(domain_id);
    env.storage()
        .persistent()
        .get::<_, PauseStatus>(&key)
        .map(|s| s.paused)
        .unwrap_or(false)
}

pub fn get_pause_status(env: &Env, domain_id: DomainId) -> Option<PauseStatus> {
    let key = PauseDataKey::PauseStatus(domain_id);
    env.storage().persistent().get::<_, PauseStatus>(&key)
}

pub fn require_not_paused(env: &Env, domain_id: DomainId) {
    if is_paused(env, domain_id) {
        panic!("Domain is paused");
    }
}

pub fn pause_domain(env: &Env, domain_id: DomainId, auth_addr: &Address, duration: u64) {
    auth_addr.require_auth();

    let ledger_timestamp = env.ledger().timestamp();
    let expires_at = if duration == 0 {
        0
    } else {
        ledger_timestamp + duration
    };

    let status = PauseStatus {
        paused: true,
        paused_by: auth_addr.clone(),
        paused_at: ledger_timestamp,
        expires_at,
    };

    let key = PauseDataKey::PauseStatus(domain_id);
    env.storage().persistent().set(&key, &status);

    emit_domain_paused(env, domain_id, auth_addr, duration);
}

pub fn unpause_domain(env: &Env, domain_id: DomainId, auth_addr: &Address) {
    auth_addr.require_auth();

    let key = PauseDataKey::PauseStatus(domain_id);
    let old = env
        .storage()
        .persistent()
        .get::<_, PauseStatus>(&key)
        .expect("Domain is not paused");

    if !old.paused {
        panic!("Domain is not paused");
    }

    let status = PauseStatus {
        paused: false,
        paused_by: auth_addr.clone(),
        paused_at: old.paused_at,
        expires_at: 0,
    };

    env.storage().persistent().set(&key, &status);

    emit_domain_unpaused(env, domain_id, auth_addr);
}

pub fn expire_if_elapsed(env: &Env, domain_id: DomainId) -> bool {
    let key = PauseDataKey::PauseStatus(domain_id);
    let status = match env.storage().persistent().get::<_, PauseStatus>(&key) {
        Some(s) => s,
        None => return false,
    };

    if !status.paused {
        return false;
    }

    if status.expires_at == 0 {
        return false;
    }

    let now = env.ledger().timestamp();
    if now >= status.expires_at {
        let expired = PauseStatus {
            paused: false,
            paused_by: status.paused_by.clone(),
            paused_at: status.paused_at,
            expires_at: 0,
        };
        env.storage().persistent().set(&key, &expired);
        emit_domain_expired(env, domain_id);
        true
    } else {
        false
    }
}

pub fn check_not_paused(env: &Env, domain_id: DomainId) {
    expire_if_elapsed(env, domain_id);
    require_not_paused(env, domain_id);
}

fn emit_domain_paused(env: &Env, domain_id: DomainId, by: &Address, duration: u64) {
    let topics = (symbol_short!("dom_paus"), by.clone());
    env.events().publish(topics, (domain_id, duration));
}

fn emit_domain_unpaused(env: &Env, domain_id: DomainId, by: &Address) {
    let topics = (symbol_short!("dom_resm"), by.clone());
    env.events().publish(topics, (domain_id,));
}

fn emit_domain_expired(env: &Env, domain_id: DomainId) {
    let topics = (symbol_short!("dom_expd"),);
    env.events().publish(topics, (domain_id,));
}

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup_env() -> (Env, Address) {
        let env = Env::default();
        let admin = Address::generate(&env);
        env.ledger().set_timestamp(1_000_000);
        (env, admin)
    }

    #[test]
    fn test_is_not_paused_by_default() {
        let (env, _admin) = setup_env();
        assert!(!is_paused(&env, 1));
    }

    #[test]
    fn test_get_pause_status_none_by_default() {
        let (env, _admin) = setup_env();
        assert!(get_pause_status(&env, 1).is_none());
    }

    #[test]
    fn test_require_not_paused_does_not_panic_when_not_paused() {
        let (env, _admin) = setup_env();
        require_not_paused(&env, 1);
    }

    #[test]
    fn test_pause_domain() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 0);
        assert!(is_paused(&env, 1));
    }

    #[test]
    #[should_panic(expected = "Domain is paused")]
    fn test_require_not_paused_panics_when_paused() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 0);
        require_not_paused(&env, 1);
    }

    #[test]
    fn test_unpause_domain() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 0);
        assert!(is_paused(&env, 1));
        unpause_domain(&env, 1, &admin);
        assert!(!is_paused(&env, 1));
    }

    #[test]
    #[should_panic(expected = "Domain is not paused")]
    fn test_unpause_not_paused_panics() {
        let (env, admin) = setup_env();
        unpause_domain(&env, 1, &admin);
    }

    #[test]
    fn test_pause_with_expiry() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 100);
        assert!(is_paused(&env, 1));
        env.ledger().set_timestamp(1_000_050);
        assert!(!expire_if_elapsed(&env, 1));
        assert!(is_paused(&env, 1));
        env.ledger().set_timestamp(1_000_100);
        assert!(expire_if_elapsed(&env, 1));
        assert!(!is_paused(&env, 1));
    }

    #[test]
    fn test_expire_after_exact_timestamp() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 100);
        env.ledger().set_timestamp(1_000_100);
        assert!(expire_if_elapsed(&env, 1));
        assert!(!is_paused(&env, 1));
    }

    #[test]
    fn test_expire_before_timestamp_does_not_expire() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 100);
        env.ledger().set_timestamp(1_000_099);
        assert!(!expire_if_elapsed(&env, 1));
        assert!(is_paused(&env, 1));
    }

    #[test]
    fn test_indefinite_pause_does_not_expire() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 0);
        assert!(!expire_if_elapsed(&env, 1));
        assert!(is_paused(&env, 1));
    }

    #[test]
    fn test_check_not_paused_expires_automatically() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 50);
        env.ledger().set_timestamp(1_000_100);
        check_not_paused(&env, 1);
        assert!(!is_paused(&env, 1));
    }

    #[test]
    fn test_multiple_domains_independent() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 0);
        pause_domain(&env, 2, &admin, 0);
        assert!(is_paused(&env, 1));
        assert!(is_paused(&env, 2));
        unpause_domain(&env, 1, &admin);
        assert!(!is_paused(&env, 1));
        assert!(is_paused(&env, 2));
    }

    #[test]
    fn test_pause_then_unpause_then_pause_again() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 0);
        unpause_domain(&env, 1, &admin);
        pause_domain(&env, 1, &admin, 100);
        assert!(is_paused(&env, 1));
    }

    #[test]
    fn test_get_pause_status_after_pause() {
        let (env, admin) = setup_env();
        pause_domain(&env, 1, &admin, 100);
        let status = get_pause_status(&env, 1).unwrap();
        assert!(status.paused);
        assert_eq!(status.paused_by, admin);
        assert_eq!(status.paused_at, 1_000_000);
        assert_eq!(status.expires_at, 1_000_100);
    }

    #[test]
    fn test_domains_are_independent() {
        let (env, admin) = setup_env();
        pause_domain(&env, 5, &admin, 0);
        pause_domain(&env, 10, &admin, 0);
        assert!(is_paused(&env, 5));
        assert!(is_paused(&env, 10));
        unpause_domain(&env, 5, &admin);
        assert!(!is_paused(&env, 5));
        assert!(is_paused(&env, 10));
    }

    #[test]
    fn test_pause_status_returns_correct_values() {
        let (env, admin) = setup_env();
        pause_domain(&env, 42, &admin, 500);
        let status = get_pause_status(&env, 42).unwrap();
        assert!(status.paused);
        assert_eq!(status.paused_by, admin);
        assert_eq!(status.paused_at, 1_000_000);
        assert_eq!(status.expires_at, 1_000_500);
    }
}
