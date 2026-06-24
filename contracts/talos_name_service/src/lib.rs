//! TalosNameService — Soroban smart contract for human-readable Talos names.
//!
//! Handles:
//! - Name registration (e.g., "marketbot" → Talos ID)
//! - Name resolution (name → Talos ID)
//! - Name availability checks
//! - Validation: 3-32 chars, lowercase alphanumeric + hyphens

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};

// ── Data Types ──────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    NameRecord(String), // name → talos_id
    TalosName(u32),     // talos_id → name
}

// ── Events ──────────────────────────────────────────────────────────

fn emit_name_registered(env: &Env, talos_id: u32, name: String) {
    let topics = (symbol_short!("name_reg"), talos_id);
    env.events().publish(topics, name);
}

// ── Validation ──────────────────────────────────────────────────────
// Character-level validation is handled off-chain (Next.js regex).
// On-chain we only enforce the byte-length bounds.

fn validate_name(name: &String) -> bool {
    let len = name.len();
    len >= 3 && len <= 32
}

// ── Contract ────────────────────────────────────────────────────────

#[contract]
pub struct TalosNameService;

#[contractimpl]
impl TalosNameService {
    /// Register a name for a Talos.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `owner` - The address authorizing this name registration
    /// * `talos_id` - The Talos ID to associate with the name
    /// * `name` - Human-readable name (3-32 chars, lowercase alphanumeric + hyphens)
    pub fn register_name(e: Env, owner: Address, talos_id: u32, name: String) {
        owner.require_auth();

        if !validate_name(&name) {
            panic!("Invalid name. Must be 3-32 chars, lowercase alphanumeric + hyphens, no consecutive hyphens.");
        }

        if e.storage()
            .persistent()
            .get::<_, u32>(&DataKey::NameRecord(name.clone()))
            .is_some()
        {
            panic!("Name already taken");
        }

        // Store mappings
        e.storage()
            .persistent()
            .set(&DataKey::NameRecord(name.clone()), &talos_id);
        e.storage()
            .persistent()
            .set(&DataKey::TalosName(talos_id), &name);

        emit_name_registered(&e, talos_id, name);
    }

    /// Resolve a name to a Talos ID.
    /// Returns None if the name doesn't exist.
    pub fn resolve_name(e: Env, name: String) -> Option<u32> {
        e.storage().persistent().get(&DataKey::NameRecord(name))
    }

    /// Get the name associated with a Talos ID.
    /// Returns None if the Talos has no name.
    pub fn name_of(e: Env, talos_id: u32) -> Option<String> {
        e.storage().persistent().get(&DataKey::TalosName(talos_id))
    }

    /// Check if a name is available.
    pub fn is_name_available(e: Env, name: String) -> bool {
        if !validate_name(&name) {
            return false;
        }
        e.storage()
            .persistent()
            .get::<_, u32>(&DataKey::NameRecord(name))
            .is_none()
    }

    /// Check if a Talos has a registered name.
    pub fn has_name(e: Env, talos_id: u32) -> bool {
        e.storage()
            .persistent()
            .get::<_, String>(&DataKey::TalosName(talos_id))
            .is_some()
    }
}

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal,
    };

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosNameService);
        (env, contract_id)
    }

    fn s(env: &Env, value: &str) -> String {
        String::from_str(env, value)
    }

    fn register_name_with_auth(
        env: &Env,
        client: &TalosNameServiceClient,
        contract_id: &Address,
        owner: &Address,
        talos_id: u32,
        name: &String,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: owner,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "register_name",
                    args: (owner.clone(), talos_id, name.clone()).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .register_name(owner, &talos_id, name);
    }

    #[test]
    fn register_name_success() {
        let (env, contract_id) = setup();
        let client = TalosNameServiceClient::new(&env, &contract_id);
        let owner = Address::generate(&env);
        let name = s(&env, "marketbot");

        assert!(client.is_name_available(&name));
        register_name_with_auth(&env, &client, &contract_id, &owner, 7, &name);

        assert!(!client.is_name_available(&name));
        assert!(client.has_name(&7));
        assert_eq!(client.resolve_name(&name), Some(7));
        assert_eq!(client.name_of(&7), Some(name));
    }

    #[test]
    fn duplicate_name_rejected() {
        let (env, contract_id) = setup();
        let client = TalosNameServiceClient::new(&env, &contract_id);
        let owner = Address::generate(&env);
        let second_owner = Address::generate(&env);
        let name = s(&env, "marketbot");

        register_name_with_auth(&env, &client, &contract_id, &owner, 1, &name);

        let duplicate_result = client
            .mock_auths(&[MockAuth {
                address: &second_owner,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "register_name",
                    args: (second_owner.clone(), 2u32, name.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_register_name(&second_owner, &2, &name);

        assert!(duplicate_result.is_err());
    }

    #[test]
    fn unauthorized_caller_rejected() {
        let (env, contract_id) = setup();
        let client = TalosNameServiceClient::new(&env, &contract_id);
        let owner = Address::generate(&env);
        let name = s(&env, "marketbot");

        assert!(client.try_register_name(&owner, &1, &name).is_err());
    }

    #[test]
    fn lookup_by_name_returns_correct_talos_id() {
        let (env, contract_id) = setup();
        let client = TalosNameServiceClient::new(&env, &contract_id);
        let owner = Address::generate(&env);
        let name = s(&env, "atlas-agent");

        register_name_with_auth(&env, &client, &contract_id, &owner, 42, &name);

        assert_eq!(client.resolve_name(&name), Some(42));
        assert_eq!(client.name_of(&42), Some(name));
    }

    #[test]
    fn invalid_name_rejected() {
        let (env, contract_id) = setup();
        let client = TalosNameServiceClient::new(&env, &contract_id);
        let owner = Address::generate(&env);
        let invalid_name = s(&env, "ab");

        let result = client
            .mock_auths(&[MockAuth {
                address: &owner,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "register_name",
                    args: (owner.clone(), 1u32, invalid_name.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_register_name(&owner, &1, &invalid_name);

        assert!(result.is_err());
    }
}
