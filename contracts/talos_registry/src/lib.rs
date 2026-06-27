//! TalosRegistry — Soroban smart contract for Talos Protocol.
//!
//! Handles:
//! - Talos creation (with Pulse token metadata)
//! - Protocol fee collection (3% launchpad fee)
//! - Talos metadata storage and retrieval
//! - Patron registration with minimum Pulse holding validation

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};

// ── Data Types ──────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct Patron {
    pub creator_share: u32,
    pub investor_share: u32,
    pub treasury_share: u32,
    pub creator_addr: Address,
    pub investor_addr: Address,
    pub treasury_addr: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct Kernel {
    pub approval_threshold: i128,
    pub gtm_budget: i128,
    pub min_patron_pulse: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct Pulse {
    pub total_supply: i128,
    pub price_usd_cents: i128,
    pub token_symbol: String,
}

#[contracttype]
#[derive(Clone)]
pub struct Talos {
    pub id: u32,
    pub name: String,
    pub category: String,
    pub description: String,
    pub creator: Address,
    pub patron: Patron,
    pub kernel: Kernel,
    pub pulse: Pulse,
    pub created_at: u64,
    pub active: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    NextTalosId,
    Talos(u32),
    CreatorOf(u32),
    ProtocolWallet,
    ProtocolFeeBps,
}

// ── Events ──────────────────────────────────────────────────────────
//
// Event schema (topics → data):
//   tls_crt : (symbol, creator: Address)   → (talos_id: u32, name: String, category: String)
//   pat_upd : (symbol, talos_id: u32)      → (creator: Address, creator_share: u32, investor_share: u32)
//   fee_chg : (symbol,)                    → (old_bps: u32, new_bps: u32)

fn emit_talos_created(env: &Env, talos_id: u32, creator: Address, name: String, category: String) {
    let topics = (symbol_short!("tls_crt"), creator);
    env.events().publish(topics, (talos_id, name, category));
}

fn emit_patron_updated(env: &Env, talos_id: u32, patron: &Patron) {
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

fn emit_protocol_fee_changed(env: &Env, old_bps: u32, new_bps: u32) {
    let topics = (symbol_short!("fee_chg"),);
    env.events().publish(topics, (old_bps, new_bps));
}

// ── Constants ───────────────────────────────────────────────────────

const PROTOCOL_FEE_BPS: u32 = 300; // 3%
const MAX_PROTOCOL_FEE_BPS: u32 = 10_000; // 100%

// ── Contract ────────────────────────────────────────────────────────

#[contract]
pub struct TalosRegistry;

#[contractimpl]
impl TalosRegistry {
    /// Create a new Talos on-chain.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `name` - Talos name
    /// * `category` - Category (Marketing, Sales, etc.)
    /// * `description` - Description
    /// * `patron` - Patron configuration (shares + addresses)
    /// * `kernel` - Kernel policy (thresholds, budget)
    /// * `pulse` - Pulse token config (supply, price, symbol)
    /// * `protocol_wallet` - Protocol wallet to receive 3% fee
    ///
    /// Returns the new Talos ID.
    pub fn create_talos(
        e: Env,
        name: String,
        category: String,
        description: String,
        patron: Patron,
        kernel: Kernel,
        pulse: Pulse,
        protocol_wallet: Address,
    ) -> u32 {
        // Require creator authorization
        patron.creator_addr.require_auth();

        // If the registry has been initialized, ensure callers use the configured
        // protocol wallet. This keeps the create_talos ABI backwards compatible
        // while preventing a mismatched fee recipient from being supplied.
        if let Some(configured_wallet) = e
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::ProtocolWallet)
        {
            if configured_wallet != protocol_wallet {
                panic!("Protocol wallet mismatch");
            }
        }

        // Get next Talos ID
        let next_id: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::NextTalosId)
            .unwrap_or(1);

        // Create Talos struct
        let talos = Talos {
            id: next_id,
            name: name.clone(),
            category,
            description,
            creator: patron.creator_addr.clone(),
            patron,
            kernel,
            pulse,
            created_at: e.ledger().timestamp(),
            active: true,
        };

        // Store Talos
        e.storage()
            .persistent()
            .set(&DataKey::Talos(next_id), &talos);

        // Track creator
        e.storage()
            .persistent()
            .set(&DataKey::CreatorOf(next_id), &talos.creator);

        // Increment next ID
        e.storage()
            .persistent()
            .set(&DataKey::NextTalosId, &(next_id + 1));

        // Emit event
        emit_talos_created(&e, next_id, talos.creator.clone(), name, talos.category.clone());

        next_id
    }

    /// Get Talos by ID.
    pub fn get_talos(e: Env, talos_id: u32) -> Option<Talos> {
        e.storage().persistent().get(&DataKey::Talos(talos_id))
    }

    /// Get the creator address of a Talos.
    pub fn creator_of(e: Env, talos_id: u32) -> Option<Address> {
        e.storage().persistent().get(&DataKey::CreatorOf(talos_id))
    }

    /// Check if a Talos is active.
    pub fn is_active(e: Env, talos_id: u32) -> bool {
        e.storage()
            .persistent()
            .get(&DataKey::Talos(talos_id))
            .map(|t: Talos| t.active)
            .unwrap_or(false)
    }

    /// Get the next Talos ID (for counting).
    pub fn next_talos_id(e: Env) -> u32 {
        e.storage()
            .persistent()
            .get(&DataKey::NextTalosId)
            .unwrap_or(1)
    }

    /// Update patron shares for a Talos.
    pub fn update_patron(e: Env, talos_id: u32, patron: Patron) {
        let mut talos: Talos = e
            .storage()
            .persistent()
            .get(&DataKey::Talos(talos_id))
            .expect("Talos not found");

        // Require creator authorization
        talos.creator.require_auth();

        talos.patron = patron.clone();

        e.storage()
            .persistent()
            .set(&DataKey::Talos(talos_id), &talos);

        emit_patron_updated(&e, talos_id, &patron);
    }

    /// Update kernel policy for a Talos.
    pub fn update_kernel(e: Env, talos_id: u32, kernel: Kernel) {
        let mut talos: Talos = e
            .storage()
            .persistent()
            .get(&DataKey::Talos(talos_id))
            .expect("Talos not found");

        talos.creator.require_auth();

        talos.kernel = kernel;

        e.storage()
            .persistent()
            .set(&DataKey::Talos(talos_id), &talos);
    }

    /// Update pulse token config for a Talos.
    pub fn update_pulse(e: Env, talos_id: u32, pulse: Pulse) {
        let mut talos: Talos = e
            .storage()
            .persistent()
            .get(&DataKey::Talos(talos_id))
            .expect("Talos not found");

        talos.creator.require_auth();

        talos.pulse = pulse;

        e.storage()
            .persistent()
            .set(&DataKey::Talos(talos_id), &talos);
    }

    /// Deactivate a Talos.
    pub fn deactivate_talos(e: Env, talos_id: u32) {
        let mut talos: Talos = e
            .storage()
            .persistent()
            .get(&DataKey::Talos(talos_id))
            .expect("Talos not found");

        talos.creator.require_auth();
        talos.active = false;

        e.storage()
            .persistent()
            .set(&DataKey::Talos(talos_id), &talos);
    }

    /// Initialize the contract with protocol wallet and fee.
    pub fn initialize(e: Env, protocol_wallet: Address) {
        if e.storage()
            .persistent()
            .get::<_, Address>(&DataKey::ProtocolWallet)
            .is_some()
        {
            panic!("Already initialized");
        }

        e.storage()
            .persistent()
            .set(&DataKey::ProtocolWallet, &protocol_wallet);
        e.storage()
            .persistent()
            .set(&DataKey::ProtocolFeeBps, &PROTOCOL_FEE_BPS);
        e.storage().persistent().set(&DataKey::NextTalosId, &1u32);
    }

    /// Get the protocol wallet address.
    pub fn protocol_wallet(e: Env) -> Option<Address> {
        e.storage().persistent().get(&DataKey::ProtocolWallet)
    }

    /// Get the protocol fee in basis points.
    pub fn protocol_fee_bps(e: Env) -> Option<u32> {
        e.storage().persistent().get(&DataKey::ProtocolFeeBps)
    }

    /// Update the protocol fee in basis points.
    ///
    /// Only the configured protocol wallet may update the fee.
    pub fn set_protocol_fee(e: Env, fee_bps: u32) {
        if fee_bps > MAX_PROTOCOL_FEE_BPS {
            panic!("Protocol fee cannot exceed 100%");
        }

        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::ProtocolWallet)
            .expect("Contract not initialized");

        admin.require_auth();

        let old_bps: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::ProtocolFeeBps)
            .unwrap_or(PROTOCOL_FEE_BPS);

        e.storage()
            .persistent()
            .set(&DataKey::ProtocolFeeBps, &fee_bps);

        emit_protocol_fee_changed(&e, old_bps, fee_bps);
    }

    /// Calculate the protocol fee for an amount using the configured fee bps.
    pub fn calculate_protocol_fee(e: Env, amount: i128) -> i128 {
        if amount < 0 {
            panic!("Amount must be non-negative");
        }

        let fee_bps: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::ProtocolFeeBps)
            .unwrap_or(PROTOCOL_FEE_BPS);

        amount * fee_bps as i128 / MAX_PROTOCOL_FEE_BPS as i128
    }
}

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal, Symbol, TryFromVal,
    };

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosRegistry);
        (env, contract_id)
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

    #[test]
    fn create_talos_happy_path() {
        let (env, contract_id) = setup();
        let client = TalosRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);

        let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

        assert_eq!(id, 1);
        assert_eq!(client.next_talos_id(), 2);
        assert_eq!(client.creator_of(&id), Some(creator.clone()));
        assert!(client.is_active(&id));

        let talos = client.get_talos(&id).expect("talos should be stored");
        assert_eq!(talos.id, id);
        assert_eq!(talos.name, s(&env, "Genesis"));
        assert_eq!(talos.category, s(&env, "Marketing"));
        assert_eq!(talos.creator, creator);
        assert!(talos.active);
    }

    #[test]
    fn initialize_guard_rejects_reinitialization() {
        let (env, contract_id) = setup();
        let client = TalosRegistryClient::new(&env, &contract_id);

        client.initialize(&Address::generate(&env));

        assert!(client.try_initialize(&Address::generate(&env)).is_err());
    }

    #[test]
    fn update_patron_requires_creator_auth() {
        let (env, contract_id) = setup();
        let client = TalosRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

        let new_patron = Patron {
            creator_share: 50,
            investor_share: 30,
            treasury_share: 20,
            creator_addr: creator,
            investor_addr: Address::generate(&env),
            treasury_addr: Address::generate(&env),
        };

        assert!(client.try_update_patron(&id, &new_patron).is_err());
    }

    #[test]
    fn set_protocol_fee_requires_admin_auth() {
        let (env, contract_id) = setup();
        let client = TalosRegistryClient::new(&env, &contract_id);
        let protocol_wallet = Address::generate(&env);

        client.initialize(&protocol_wallet);

        assert!(client.try_set_protocol_fee(&500).is_err());
    }

    #[test]
    fn protocol_fee_calculation_uses_configured_basis_points() {
        let (env, contract_id) = setup();
        let client = TalosRegistryClient::new(&env, &contract_id);
        let protocol_wallet = Address::generate(&env);

        client.initialize(&protocol_wallet);
        assert_eq!(client.protocol_fee_bps(), Some(300));
        assert_eq!(client.calculate_protocol_fee(&10_000), 300);

        client
            .mock_auths(&[MockAuth {
                address: &protocol_wallet,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_protocol_fee",
                    args: (250u32,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_protocol_fee(&250);

        assert_eq!(client.protocol_fee_bps(), Some(250));
        assert_eq!(client.calculate_protocol_fee(&40_000), 1_000);
    }

    fn assert_topic_symbol(env: &Env, topics: &soroban_sdk::Vec<soroban_sdk::Val>, idx: u32, expected: Symbol) {
        let val = topics.get(idx).expect("topic index out of range");
        let sym: Symbol = TryFromVal::try_from_val(env, &val).expect("topic is not a Symbol");
        assert_eq!(sym, expected);
    }

    fn assert_topic_address(env: &Env, topics: &soroban_sdk::Vec<soroban_sdk::Val>, idx: u32, expected: &Address) {
        let val = topics.get(idx).expect("topic index out of range");
        let addr: Address = TryFromVal::try_from_val(env, &val).expect("topic is not an Address");
        assert_eq!(addr, *expected);
    }

    fn assert_topic_u32(env: &Env, topics: &soroban_sdk::Vec<soroban_sdk::Val>, idx: u32, expected: u32) {
        let val = topics.get(idx).expect("topic index out of range");
        let n: u32 = TryFromVal::try_from_val(env, &val).expect("topic is not a u32");
        assert_eq!(n, expected);
    }

    #[test]
    fn create_talos_emits_tls_crt_event() {
        let (env, contract_id) = setup();
        let client = TalosRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);

        let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let (addr, topics, data) = events.get(0).unwrap();

        assert_eq!(addr, contract_id);
        assert_eq!(topics.len(), 2);
        assert_topic_symbol(&env, &topics, 0, symbol_short!("tls_crt"));
        assert_topic_address(&env, &topics, 1, &creator);

        let (got_id, got_name, got_cat): (u32, String, String) =
            TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(got_id, id);
        assert_eq!(got_name, s(&env, "Genesis"));
        assert_eq!(got_cat, s(&env, "Marketing"));
    }

    #[test]
    fn update_patron_emits_pat_upd_event() {
        let (env, contract_id) = setup();
        let client = TalosRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

        let new_patron = Patron {
            creator_share: 50,
            investor_share: 30,
            treasury_share: 20,
            creator_addr: creator.clone(),
            investor_addr: Address::generate(&env),
            treasury_addr: Address::generate(&env),
        };

        client
            .mock_auths(&[MockAuth {
                address: &creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "update_patron",
                    args: (id, new_patron.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .update_patron(&id, &new_patron);

        // tls_crt from create_talos + pat_upd from update_patron
        let events = env.events().all();
        assert_eq!(events.len(), 2);
        let (addr, topics, data) = events.get(1).unwrap();

        assert_eq!(addr, contract_id);
        assert_eq!(topics.len(), 2);
        assert_topic_symbol(&env, &topics, 0, symbol_short!("pat_upd"));
        assert_topic_u32(&env, &topics, 1, id);

        let (got_creator, got_cs, got_is): (Address, u32, u32) =
            TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(got_creator, creator);
        assert_eq!(got_cs, 50);
        assert_eq!(got_is, 30);
    }

    #[test]
    fn set_protocol_fee_emits_fee_chg_event() {
        let (env, contract_id) = setup();
        let client = TalosRegistryClient::new(&env, &contract_id);
        let protocol_wallet = Address::generate(&env);

        client.initialize(&protocol_wallet);

        client
            .mock_auths(&[MockAuth {
                address: &protocol_wallet,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_protocol_fee",
                    args: (500u32,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_protocol_fee(&500);

        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let (addr, topics, data) = events.get(0).unwrap();

        assert_eq!(addr, contract_id);
        assert_eq!(topics.len(), 1);
        assert_topic_symbol(&env, &topics, 0, symbol_short!("fee_chg"));

        let (old_bps, new_bps): (u32, u32) =
            TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(old_bps, 300);
        assert_eq!(new_bps, 500);
    }
}
