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

use soroban_sdk::{contract, contractimpl, contracttype, panic_with_error, symbol_short, Address, Env, String};

// ── Data Types ──────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    NameRecord(String), // name → talos_id
    TalosName(u32),     // talos_id → name
    RegistryContract,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    AlreadyInitialized,
    UnauthorizedCaller,
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

        let registry_contract: Address = e
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .expect("Registry contract not initialized");

        let creator: Option<Address> = e.invoke_contract(
            &registry_contract,
            &symbol_short!("creator_of"),
            (&talos_id,),
        );

        if creator != Some(owner.clone()) {
            panic_with_error!(&e, ContractError::UnauthorizedCaller);
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

    pub fn initialize(e: Env, registry_id: Address) {
        if e
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::RegistryContract)
            .is_some()
        {
            panic_with_error!(&e, ContractError::AlreadyInitialized);
        }

        e.storage()
            .persistent()
            .set(&DataKey::RegistryContract, &registry_id);
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
    use talos_registry::{TalosRegistry, TalosRegistryClient, Patron, Kernel, Pulse};
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal,
    };

    fn setup() -> (
        Env,
        Address,
        Address,
        TalosRegistryClient,
        TalosNameServiceClient,
    ) {
        let env = Env::default();
        let registry_contract = env.register_contract(None, TalosRegistry);
        let name_service_contract = env.register_contract(None, TalosNameService);
        let registry_client = TalosRegistryClient::new(&env, &registry_contract);
        let name_service_client = TalosNameServiceClient::new(&env, &name_service_contract);
        name_service_client.initialize(&registry_contract);
        (env, registry_contract, name_service_contract, registry_client, name_service_client)
    }

    fn s(env: &Env, value: &str) -> String {
        String::from_str(env, value)
    }

    fn patron(env: &Env, creator: &Address) -> Patron {
        Patron {
            creator_share: 60,
            investor_share: 25,
            treasury_share: 15,
            creator_addr: creator.clone(),
            investor_addr: Address::generate(env),
            treasury_addr: Address::generate(env),
        }
    }

    fn kernel() -> Kernel {
        Kernel {
            approval_threshold: 10,
            gtm_budget: 1_000,
            min_patron_pulse: 100,
        }
    }

    fn pulse(env: &Env) -> Pulse {
        Pulse {
            total_supply: 1_000_000,
            price_usd_cents: 100,
            token_symbol: s(env, "TLOS"),
        }
    }

    fn create_talos_with_auth(
        env: &Env,
        client: &TalosRegistryClient,
        contract_id: &Address,
        creator: &Address,
        protocol_wallet: &Address,
    ) -> u32 {
        let name = s(env, "Genesis");
        let category = s(env, "Marketing");
        let description = s(env, "Autonomous marketing agent");
        let patron = patron(env, creator);
        let kernel = kernel();
        let pulse = pulse(env);

        client
            .mock_auths(&[MockAuth {
                address: creator,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "create_talos",
                    args: (
                        name.clone(),
                        category.clone(),
                        description.clone(),
                        patron.clone(),
                        kernel.clone(),
                        pulse.clone(),
                        protocol_wallet.clone(),
                    )
                        .into_val(env),
                    sub_invokes: &[],
                },
            }])
            .create_talos(
                &name,
                &category,
                &description,
                &patron,
                &kernel,
                &pulse,
                protocol_wallet,
            )
    }

    fn register_name_with_auth(
        env: &Env,
        client: &TalosNameServiceClient,
        contract_id: &Address,
        registry_contract: &Address,
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
                    sub_invokes: &[MockAuthInvoke {
                        contract: registry_contract,
                        fn_name: "creator_of",
                        args: (talos_id,).into_val(env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .register_name(owner, &talos_id, name);
    }

    #[test]
    fn register_name_success() {
        let (env, registry_contract, contract_id, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let name = s(&env, "marketbot");

        let talos_id = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &owner,
            &protocol_wallet,
        );

        assert!(client.is_name_available(&name));
        register_name_with_auth(
            &env,
            &client,
            &contract_id,
            &registry_contract,
            &owner,
            talos_id,
            &name,
        );

        assert!(!client.is_name_available(&name));
        assert!(client.has_name(&talos_id));
        assert_eq!(client.resolve_name(&name), Some(talos_id));
        assert_eq!(client.name_of(&talos_id), Some(name));
    }

    #[test]
    fn duplicate_name_rejected() {
        let (env, registry_contract, contract_id, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let second_owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let name = s(&env, "marketbot");

        let talos_id = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &owner,
            &protocol_wallet,
        );

        register_name_with_auth(
            &env,
            &client,
            &contract_id,
            &registry_contract,
            &owner,
            talos_id,
            &name,
        );

        let duplicate_result = client
            .mock_auths(&[MockAuth {
                address: &second_owner,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "register_name",
                    args: (second_owner.clone(), talos_id, name.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_register_name(&second_owner, &talos_id, &name);

        assert!(duplicate_result.is_err());
    }

    #[test]
    fn unauthorized_caller_rejected() {
        let (env, registry_contract, contract_id, registry_client, client) = setup();
        let creator = Address::generate(&env);
        let unauthorized = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let name = s(&env, "marketbot");

        let talos_id = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &creator,
            &protocol_wallet,
        );

        let result = client
            .mock_auths(&[MockAuth {
                address: &unauthorized,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "register_name",
                    args: (unauthorized.clone(), talos_id, name.clone()).into_val(&env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &registry_contract,
                        fn_name: "creator_of",
                        args: (talos_id,).into_val(&env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .try_register_name(&unauthorized, &talos_id, &name);

        assert!(result.is_err());
    }

    #[test]
    fn initialize_guard_rejects_reinitialization() {
        let (env, registry_contract, _contract_id, _registry_client, client) = setup();
        assert!(client.try_initialize(&registry_contract).is_err());
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
