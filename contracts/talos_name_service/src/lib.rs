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

#[cfg(all(test, not(target_arch = "wasm32")))]
use std::string::ToString;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, IntoVal, String, Symbol,
};

// ── Data Types ──────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdminAction {
    SetRegistryContract(Address),
    SetAdmin(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Scheduled,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockProposal {
    pub id: u64,
    pub action: AdminAction,
    pub eta: u64,
    pub status: ProposalStatus,
    pub scheduled_at: u64,
    pub scheduled_by: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockConfig {
    pub min_delay: u64,
    pub grace_period: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    NameRecord(String), // name → talos_id
    TalosName(u32),     // talos_id → name
    RegistryContract,
    Admin,
    TimelockConfig,
    TimelockProposal(u64),
    NextTimelockId,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    UnauthorizedCaller = 2,
    TimelockEnabled = 3,
}

// ── Events ──────────────────────────────────────────────────────────
//
// Event schema (topics → data):
//   name_reg : (symbol, talos_id: u32) → (name: String, owner: Address)
//   reg_upd  : (symbol,)               → (old_registry: Address, new_registry: Address)
//   tl_sch   : (symbol, proposal_id: u64) → (action: AdminAction, eta: u64, proposer: Address)
//   tl_exec  : (symbol, proposal_id: u64) → (action: AdminAction, executor: Address)
//   tl_cnl   : (symbol, proposal_id: u64) → (action: AdminAction, canceller: Address)
//   tl_cfg   : (symbol,)               → (old_min_delay: u64, new_min_delay: u64, grace_period: u64)

fn emit_name_registered(env: &Env, talos_id: u32, name: String, owner: Address) {
    let topics = (symbol_short!("name_reg"), talos_id);
    env.events().publish(topics, (name, owner));
}

fn emit_registry_updated(env: &Env, old_registry: Address, new_registry: Address) {
    let topics = (symbol_short!("reg_upd"),);
    env.events().publish(topics, (old_registry, new_registry));
}

fn emit_timelock_scheduled(
    env: &Env,
    proposal_id: u64,
    action: &AdminAction,
    eta: u64,
    proposer: Address,
) {
    let topics = (symbol_short!("tl_sch"), proposal_id);
    env.events().publish(topics, (action.clone(), eta, proposer));
}

fn emit_timelock_executed(
    env: &Env,
    proposal_id: u64,
    action: &AdminAction,
    executor: Address,
) {
    let topics = (symbol_short!("tl_exec"), proposal_id);
    env.events().publish(topics, (action.clone(), executor));
}

fn emit_timelock_cancelled(
    env: &Env,
    proposal_id: u64,
    action: &AdminAction,
    canceller: Address,
) {
    let topics = (symbol_short!("tl_cnl"), proposal_id);
    env.events().publish(topics, (action.clone(), canceller));
}

fn emit_timelock_config_changed(
    env: &Env,
    old_min_delay: u64,
    new_min_delay: u64,
    grace_period: u64,
) {
    let topics = (symbol_short!("tl_cfg"),);
    env.events()
        .publish(topics, (old_min_delay, new_min_delay, grace_period));
}

const DEFAULT_GRACE_PERIOD: u64 = 604_800; // 7 days in seconds
const MAX_MIN_DELAY: u64 = 2_592_000; // 30 days in seconds

// ── Validation ──────────────────────────────────────────────────────
fn validate_name(name: &String) -> bool {
    let len = name.len();
    if len < 3 || len > 32 {
        return false;
    }

    let name_string = name.to_string();
    let bytes = name_string.as_bytes();
    if bytes.first().is_none() || bytes.last().is_none() {
        return false;
    }

    let mut prev_hyphen = false;
    for &b in bytes {
        if (b'a'..=b'z').contains(&b) || (b'0'..=b'9').contains(&b) {
            prev_hyphen = false;
            continue;
        }
        if b == b'-' {
            if prev_hyphen || bytes.first() == Some(&b) || bytes.last() == Some(&b) {
                return false;
            }
            prev_hyphen = true;
            continue;
        }
        return false;
    }

    true
}

// ── Contract ────────────────────────────────────────────────────────

/// Compile-time interface version of TalosNameService.
///
/// Format: `(major, minor, patch)` following Semantic Versioning.
///
/// Bump rules:
/// - **major** — incompatible ABI change (removed/renamed entry-points, changed argument types)
/// - **minor** — backwards-compatible new entry-point or return-field added
/// - **patch** — bug-fix with no observable ABI change
///
/// This constant is embedded in the WASM binary at compile time and is
/// therefore immutable once deployed; it cannot be altered by any admin
/// call, storage write, or cross-contract invocation.
pub const CONTRACT_VERSION: (u32, u32, u32) = (1, 1, 0);

#[contract]
pub struct TalosNameService;

#[contractimpl]
impl TalosNameService {
    /// Return the contract's interface version as `(major, minor, patch)`.
    ///
    /// The value is a compile-time constant baked into the WASM binary.
    /// It is **not** stored in ledger state and cannot be altered by any
    /// administrator, upgrade, or cross-contract call after deployment.
    ///
    /// Clients should call this method to verify ABI compatibility before
    /// invoking other entry-points. A change in `major` signals a breaking
    /// change; a change in `minor` adds new entry-points while remaining
    /// backwards compatible; `patch` carries bug-fixes only.
    ///
    /// # Returns
    /// `(major: u32, minor: u32, patch: u32)` — currently `(1, 0, 0)`.
    pub fn version(_e: Env) -> (u32, u32, u32) {
        CONTRACT_VERSION
    }

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
            &Symbol::new(&e, "creator_of"),
            soroban_sdk::vec![&e, talos_id.into_val(&e)],
        );

        if creator != Some(owner.clone()) {
            panic_with_error!(&e, ContractError::UnauthorizedCaller);
        }

        // Retrieve the old name via TalosName(talos_id) and delete NameRecord(old_name)
        // to prevent dangling records when changing names.
        if let Some(old_name) = e
            .storage()
            .persistent()
            .get::<_, String>(&DataKey::TalosName(talos_id))
        {
            e.storage()
                .persistent()
                .remove(&DataKey::NameRecord(old_name));
        }

        // Store mappings
        e.storage()
            .persistent()
            .set(&DataKey::NameRecord(name.clone()), &talos_id);
        e.storage()
            .persistent()
            .set(&DataKey::TalosName(talos_id), &name);

        emit_name_registered(&e, talos_id, name, owner);
    }

    pub fn initialize(e: Env, registry_id: Address) {
        if e.storage()
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

    fn set_registry_contract_internal(e: &Env, new_registry_id: Address) {
        let old: Address = e
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .expect("Registry contract not initialized");

        e.storage()
            .persistent()
            .set(&DataKey::RegistryContract, &new_registry_id);

        emit_registry_updated(e, old, new_registry_id);
    }

    /// Set or transfer admin role for TalosNameService.
    pub fn set_admin(e: Env, new_admin: Address) {
        if let Some(admin) = e.storage().persistent().get::<_, Address>(&DataKey::Admin) {
            admin.require_auth();
        }
        e.storage().persistent().set(&DataKey::Admin, &new_admin);
    }

    /// Update the registered TalosRegistry contract address.
    ///
    /// Requires admin authorization. If timelock is enabled (`min_delay > 0`),
    /// this action must be scheduled and executed via `execute_action`.
    pub fn set_registry_contract(e: Env, new_registry_id: Address) {
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        admin.require_auth();

        let config = Self::get_timelock_config(e.clone());
        if config.min_delay > 0 {
            panic_with_error!(&e, ContractError::TimelockEnabled);
        }

        Self::set_registry_contract_internal(&e, new_registry_id);
    }

    // ── Timelock Administration ─────────────────────────────────────

    /// Configure timelock parameter settings (`min_delay` and `grace_period`).
    pub fn set_timelock_config(e: Env, min_delay: u64, grace_period: u64) {
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

        let old_config = Self::get_timelock_config(e.clone());

        let new_config = TimelockConfig {
            min_delay,
            grace_period,
        };

        e.storage()
            .persistent()
            .set(&DataKey::TimelockConfig, &new_config);

        emit_timelock_config_changed(&e, old_config.min_delay, min_delay, grace_period);
    }

    /// Retrieve active timelock configuration.
    pub fn get_timelock_config(e: Env) -> TimelockConfig {
        e.storage()
            .persistent()
            .get(&DataKey::TimelockConfig)
            .unwrap_or(TimelockConfig {
                min_delay: 0,
                grace_period: DEFAULT_GRACE_PERIOD,
            })
    }

    /// Schedule an administrative action for future execution.
    pub fn schedule_action(e: Env, action: AdminAction, delay: u64) -> u64 {
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        admin.require_auth();

        let config = Self::get_timelock_config(e.clone());
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

        emit_timelock_scheduled(&e, id, &action, eta, admin);
        id
    }

    /// Execute a scheduled action after its timelock ETA has matured.
    pub fn execute_action(e: Env, proposal_id: u64) {
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

        let config = Self::get_timelock_config(e.clone());
        if now > proposal.eta.saturating_add(config.grace_period) {
            panic!("Proposal expired");
        }

        match &proposal.action {
            AdminAction::SetRegistryContract(new_registry_id) => {
                Self::set_registry_contract_internal(&e, new_registry_id.clone());
            }
            AdminAction::SetAdmin(new_admin) => {
                e.storage()
                    .persistent()
                    .set(&DataKey::Admin, new_admin);
            }
        }

        proposal.status = ProposalStatus::Executed;
        e.storage()
            .persistent()
            .set(&DataKey::TimelockProposal(proposal_id), &proposal);

        let executor = proposal.scheduled_by.clone();
        emit_timelock_executed(&e, proposal_id, &proposal.action, executor);
    }

    /// Cancel a scheduled action.
    pub fn cancel_action(e: Env, proposal_id: u64) {
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

        emit_timelock_cancelled(&e, proposal_id, &proposal.action, admin);
    }

    /// Retrieve a timelock proposal by ID.
    pub fn get_timelock_proposal(e: Env, proposal_id: u64) -> Option<TimelockProposal> {
        e.storage()
            .persistent()
            .get(&DataKey::TimelockProposal(proposal_id))
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
        testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal, Symbol, TryFromVal,
    };
    use talos_registry::{Kernel, Patron, Pulse, TalosRegistry, TalosRegistryClient};

    fn setup() -> (
        Env,
        Address,
        Address,
        TalosRegistryClient<'static>,
        TalosNameServiceClient<'static>,
    ) {
        let _env = Env::default();
        let env = _env.clone();
        let registry_contract = env.register_contract(None, TalosRegistry);
        let name_service_contract = env.register_contract(None, TalosNameService);
        let name_service_client = TalosNameServiceClient::new(&env, &name_service_contract);
        name_service_client.initialize(&registry_contract);
        let registry_client = TalosRegistryClient::new(&env, &registry_contract);
        (
            env,
            registry_contract,
            name_service_contract,
            registry_client,
            name_service_client,
        )
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

    // ── version() tests ──────────────────────────────────────────────

    #[test]
    fn version_returns_compile_time_constant() {
        let (_env, _registry_contract, _contract_id, _registry_client, client) = setup();
        assert_eq!(client.version(), (1u32, 1u32, 0u32));
    }

    #[test]
    fn version_is_idempotent() {
        let (_env, _registry_contract, _contract_id, _registry_client, client) = setup();
        // Calling version() multiple times must always return the same value.
        assert_eq!(client.version(), client.version());
    }

    #[test]
    fn version_is_unaffected_by_state_changes() {
        let (env, registry_contract, contract_id, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let name = s(&env, "vega");

        let before = client.version();

        // Register a name — a storage write must not affect the version constant.
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

        let after = client.version();
        assert_eq!(before, after);
    }

    #[test]
    fn version_matches_contract_version_constant() {
        // Verify that the public CONTRACT_VERSION constant and the on-chain
        // entry-point are in sync, so tooling that reads the constant directly
        // agrees with what the deployed WASM reports.
        let (_env, _registry_contract, _contract_id, _registry_client, client) = setup();
        let (maj, min, patch) = client.version();
        assert_eq!((maj, min, patch), CONTRACT_VERSION);
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
        let (_env, registry_contract, _contract_id, _registry_client, client) = setup();
        assert!(client.try_initialize(&registry_contract).is_err());
    }

    #[test]
    fn lookup_by_name_returns_correct_talos_id() {
        let (env, registry_contract, contract_id, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let name = s(&env, "atlas-agent");

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

        assert_eq!(client.resolve_name(&name), Some(talos_id));
        assert_eq!(client.name_of(&talos_id), Some(name));
    }

    #[test]
    fn invalid_name_rejected() {
        let (env, _registry_contract, contract_id, _registry_client, client) = setup();
        let invalid_name = s(&env, "ab");
        let owner = Address::generate(&env);

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

    #[test]
    fn accepts_valid_name_patterns() {
        let (env, registry_contract, contract_id, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let valid_name = s(&env, "alpha-1");
        let talos_id = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &owner,
            &protocol_wallet,
        );

        let result = client
            .mock_auths(&[MockAuth {
                address: &owner,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "register_name",
                    args: (owner.clone(), talos_id, valid_name.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_register_name(&owner, &talos_id, &valid_name);

        assert!(result.is_ok());
    }

    #[test]
    fn rejects_invalid_name_patterns() {
        let (env, _registry_contract, contract_id, _registry_client, client) = setup();
        let owner = Address::generate(&env);
        let invalid_names = [
            s(&env, "Alpha"),
            s(&env, "bad--name"),
            s(&env, "-bad"),
            s(&env, "bad-"),
        ];

        for invalid_name in invalid_names {
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

            assert!(
                result.is_err(),
                "expected invalid name {:?} to be rejected",
                invalid_name.to_string()
            );
        }
    }

    #[test]
    fn register_name_emits_name_reg_event() {
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

        register_name_with_auth(
            &env,
            &client,
            &contract_id,
            &registry_contract,
            &owner,
            talos_id,
            &name,
        );

        let all_events = env.events().all();
        let events = all_events
            .iter()
            .filter(|e| e.0 == contract_id)
            .collect::<std::vec::Vec<_>>();
        assert_eq!(events.len(), 1);
        let (_addr, topics, data) = events.get(0).unwrap();
        assert_eq!(topics.len() as u32, 2);
        let t0: Symbol = TryFromVal::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
        let t1: u32 = TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (got_name, got_owner): (String, Address) =
            TryFromVal::try_from_val(&env, data).unwrap();
        assert_eq!(got_name, name);
        assert_eq!(got_owner, owner);
    }

    #[test]
    fn update_name_removes_old_record() {
        let (env, registry_contract, contract_id, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let name1 = s(&env, "name1");
        let name2 = s(&env, "name2");

        let talos_id = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &owner,
            &protocol_wallet,
        );

        // Register first name
        register_name_with_auth(
            &env,
            &client,
            &contract_id,
            &registry_contract,
            &owner,
            talos_id,
            &name1,
        );

        assert_eq!(client.resolve_name(&name1), Some(talos_id));

        // Register second name
        register_name_with_auth(
            &env,
            &client,
            &contract_id,
            &registry_contract,
            &owner,
            talos_id,
            &name2,
        );

        assert_eq!(client.resolve_name(&name2), Some(talos_id));
        // Verify old name is cleared
        assert_eq!(client.resolve_name(&name1), None);
        assert!(client.is_name_available(&name1));
    }
    #[test]
    fn has_name_returns_false_for_unknown_talos_id() {
        let (env, registry_contract, contract_id, _registry_client, client) = setup();

        // talos_id = 999 does not exist
        assert!(!client.has_name(&999));
    }

    #[test]
    fn name_of_returns_none_for_unknown_talos_id() {
        let (_env, _registry_contract, _contract_id, _registry_client, client) = setup();

        assert!(client.name_of(&999).is_none());
    }

    // ── Name Service Timelock unit tests ──────────────────────────────

    use soroban_sdk::testutils::Ledger as _;

    #[test]
    fn name_service_timelock_schedule_execute_registry_update() {
        let (env, registry_contract, contract_id, _registry_client, client) = setup();
        let admin = Address::generate(&env);
        client.set_admin(&admin);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_timelock_config",
                    args: (3600u64, 86400u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_timelock_config(&3600, &86400);

        let new_registry = Address::generate(&env);
        let action = AdminAction::SetRegistryContract(new_registry.clone());

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "schedule_action",
                    args: (action.clone(), 3600u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .schedule_action(&action, &3600);

        assert_eq!(proposal_id, 1);

        // Early execution must fail
        assert!(client.try_execute_action(&proposal_id).is_err());

        // Advance to ETA
        env.ledger().with_mut(|li| {
            li.timestamp += 3600;
        });

        client.execute_action(&proposal_id);

        let prop = client.get_timelock_proposal(&proposal_id).unwrap();
        assert_eq!(prop.status, ProposalStatus::Executed);
    }

    #[test]
    fn name_service_timelock_direct_call_guarded() {
        let (env, _registry_contract, contract_id, _registry_client, client) = setup();
        let admin = Address::generate(&env);
        client.set_admin(&admin);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_timelock_config",
                    args: (3600u64, 86400u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_timelock_config(&3600, &86400);

        let new_registry = Address::generate(&env);
        let res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_registry_contract",
                    args: (new_registry.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_registry_contract(&new_registry);

        assert!(res.is_err());
    }

    #[test]
    fn name_service_timelock_cancellation() {
        let (env, _registry_contract, contract_id, _registry_client, client) = setup();
        let admin = Address::generate(&env);
        client.set_admin(&admin);

        let new_registry = Address::generate(&env);
        let action = AdminAction::SetRegistryContract(new_registry);

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "schedule_action",
                    args: (action.clone(), 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .schedule_action(&action, &0);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cancel_action",
                    args: (proposal_id,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .cancel_action(&proposal_id);

        let prop = client.get_timelock_proposal(&proposal_id).unwrap();
        assert_eq!(prop.status, ProposalStatus::Cancelled);
        assert!(client.try_execute_action(&proposal_id).is_err());
    }
}
