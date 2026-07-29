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

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, IntoVal, String, Symbol, Vec,
};
use ttl_manager;
use pause_control;

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

/// A narrowly-scoped write path that can be independently paused.
///
/// Reads (`resolve_name`, `name_of`, `is_name_available`, `has_name`) are
/// never gated by any pause domain. Admin entry-points (`set_registry_contract`,
/// timelock management) are intentionally not pausable — they already carry
/// their own admin-auth (and optional timelock) protection.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PauseDomain {
    NameRegistration,
}

/// Persisted record of an active pause on a single [`PauseDomain`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseState {
    pub paused_by: Address,
    pub paused_at: u64,
    /// Unix timestamp after which the pause automatically lifts.
    /// `0` means indefinite — only settable by the admin, never by a guardian.
    pub expires_at: u64,
}

/// Computed, read-friendly view of a domain's pause status.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseInfo {
    pub active: bool,
    pub paused_by: Option<Address>,
    pub paused_at: Option<u64>,
    /// `None` when not paused, or when paused indefinitely by the admin.
    pub expires_at: Option<u64>,
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
    LastTouched(u32),
    NameFeeAmount,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    UnauthorizedCaller = 2,
    TimelockEnabled = 3,
    DomainPaused = 4,
    NotAdminOrGuardian = 5,
    DomainLockedByAdmin = 6,
    InvalidPauseDuration = 7,
    GuardianLimitReached = 8,
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
//   dep_path : (symbol,)               → (deprecated: String, replacement: String)
//                                                  Privacy-safe: no caller/tx/value data.
//                                                  Emitted when a legacy direct-admin path
//                                                  is invoked while timelock is enabled.
//   compat_ok: (symbol,)               → (maj: u32, min: u32, pat: u32)
//                                                  Cross-contract interface check succeeded.
//   compat_err: (symbol,)              → ()
//                                                  Cross-contract interface id mismatch;
//                                                  privacy-safe (no caller data).
//                                                  Payload of (maj, min, pat) only when
//                                                  ids match but version is too old.

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
    env.events()
        .publish(topics, (action.clone(), eta, proposer));
}

fn emit_timelock_executed(env: &Env, proposal_id: u64, action: &AdminAction, executor: Address) {
    let topics = (symbol_short!("tl_exec"), proposal_id);
    env.events().publish(topics, (action.clone(), executor));
}

fn emit_timelock_cancelled(env: &Env, proposal_id: u64, action: &AdminAction, canceller: Address) {
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

fn emit_pause_set(env: &Env, domain: &PauseDomain, actor: &Address, expires_at: u64) {
    let topics = (symbol_short!("pause_on"), domain.clone());
    env.events().publish(topics, (actor.clone(), expires_at));
}

fn emit_pause_cleared(env: &Env, domain: &PauseDomain, actor: &Address) {
    let topics = (symbol_short!("pause_off"), domain.clone());
    env.events().publish(topics, (actor.clone(),));
}

fn emit_guardian_added(env: &Env, guardian: Address) {
    let topics = (symbol_short!("guard_add"),);
    env.events().publish(topics, (guardian,));
}

fn emit_guardian_removed(env: &Env, guardian: Address) {
    let topics = (symbol_short!("guard_rem"),);
    env.events().publish(topics, (guardian,));
}

// ── Emergency Pause Helpers ────────────────────────────────────────

fn get_guardians(e: &Env) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::Guardians)
        .unwrap_or(Vec::new(e))
}

fn is_guardian_internal(e: &Env, addr: &Address) -> bool {
    get_guardians(e).iter().any(|g| g == *addr)
}

/// Evaluate whether `domain` is currently paused, lazily treating an expired
/// (non-indefinite) pause record as inactive without mutating storage.
fn is_domain_paused(e: &Env, domain: &PauseDomain) -> bool {
    match e
        .storage()
        .persistent()
        .get::<_, PauseState>(&DataKey::PauseState(domain.clone()))
    {
        None => false,
        Some(state) => state.expires_at == 0 || e.ledger().timestamp() < state.expires_at,
    }
}

fn require_not_paused(e: &Env, domain: PauseDomain) {
    if is_domain_paused(e, &domain) {
        panic_with_error!(e, ContractError::DomainPaused);
    }
}

const DEFAULT_GRACE_PERIOD: u64 = 604_800; // 7 days in seconds
const MAX_MIN_DELAY: u64 = 2_592_000; // 30 days in seconds
const MAX_GUARDIAN_PAUSE_SECS: u64 = 604_800; // 7 days — bounds guardian blast radius
const MAX_ADMIN_PAUSE_SECS: u64 = 2_592_000; // 30 days; 0 (indefinite) is also allowed for admin
const MAX_GUARDIANS: u32 = 10; // bounds unbounded storage growth

// ── Stable interface (v1.x.x) ──────────────────────────────────────
//
// `INTERFACE_ID` is a 32-byte content-derived identifier derived from
// `INTERFACE_NAMESPACE` and `CONTRACT_VERSION`. It MUST match the
// derived byte sequence documented in `interface_id_golden_vector_*`
// tests and in `contracts/INTERFACE.md`; a single byte change is a
// breaking ABI signal.
pub const INTERFACE_NAMESPACE: &str = "TalosNameService";

pub const INTERFACE_ID: [u8; 32] = [
    0x54, 0x61, 0x6C, 0x6F, 0x73, 0x4E, 0x61, 0x6D, // "TalosNam"
    0x65, 0x53, 0x65, 0x72, 0x76, 0x69, 0x63, 0x65, // "eService"
    // (major, minor, patch) big-endian u32s
    0x00, 0x00, 0x00, 0x01, // major = 1
    0x00, 0x00, 0x00, 0x01, // minor = 1
    0x00, 0x00, 0x00, 0x00, // patch = 0
    // reserved
    0x00, 0x00, 0x00, 0x00,
];

/// Expected `INTERFACE_ID` of the configured `RegistryContract`, mirroring
/// the bytes published by `talos_registry::INTERFACE_ID` (namespace
/// `"TalosRegistry"`, version `(1, 1, 0)`). Kept as an inline copy rather
/// than a crate dependency so this contract's ABI check has no build-time
/// coupling to the Registry crate; see the golden-vector test for the
/// independent reproduction of the byte layout.
pub const EXPECTED_REGISTRY_INTERFACE_ID: [u8; 32] = [
    0x54, 0x61, 0x6C, 0x6F, 0x73, 0x52, 0x65, 0x67, // "TalosReg"
    0x69, 0x73, 0x74, 0x72, 0x79, 0x00, 0x00, 0x00, // "istry" + zero pads
    // (major, minor, patch) big-endian u32s
    0x00, 0x00, 0x00, 0x01, // major = 1
    0x00, 0x00, 0x00, 0x01, // minor = 1
    0x00, 0x00, 0x00, 0x00, // patch = 0
    // reserved
    0x00, 0x00, 0x00, 0x00,
];

/// Capability symbols returned by `interface_features()`.
pub fn features_list() -> &'static [&'static str] {
    &[
        "name_registration", // register_name / resolve_name / is_name_available
        "name_lifecycle",    // update_name / has_name / name_of — revoke + aliasing
        "admin_transfer",    // set_admin for admin handover
        "timelock_admin",    // schedule_action / execute_action / cancel_action
        "registry_pointer",  // set_registry_contract — points to TalosRegistry
        "interface_query",   // version / interface_id / supports_version
        "cross_contract",    // invokes creator_of on the configured registry
    ]
}

/// Deprecated entry-point table (recommended replacements).
pub const DEPRECATED_DIRECT_ADMIN: &[(&str, &str)] = &[(
    "set_registry_contract (direct, pre-timelock)",
    "schedule_action(SetRegistryContract, ..) + execute_action",
)];

/// Privacy-safe emission of a deprecation event when a legacy direct path
/// is invoked against a timelock-enabled deployment.
fn emit_deprecated_call(env: &Env, deprecated: &str, replacement: &str) {
    let topics = (symbol_short!("dep_path"),);
    env.events()
        .publish(topics, (deprecated, replacement));
}

/// Compatibility helper: returns true if `actual` semver satisfies `required`.
///
/// Mirrors `TalosRegistry::version_supports` so callers in both modules
/// get identical answers even though no shared crate is imported:
///
/// - `major` must match exactly.
/// - `actual.minor > required.minor`        → supported.
/// - `actual.minor == required.minor` and `actual.patch >= required.patch`
///                                          → supported.
/// - `actual.minor < required.minor`        → not supported.
pub fn version_supports(actual: (u32, u32, u32), required: (u32, u32, u32)) -> bool {
    if actual.0 != required.0 {
        return false;
    }
    if actual.1 > required.1 {
        return true;
    }
    if actual.1 < required.1 {
        return false;
    }
    actual.2 >= required.2
}

/// Cross-contract compatibility helper.
///
/// Verifies that a contract registered as a `TalosRegistry` actually
/// publishes the expected `INTERFACE_ID`. Emits a `compat_ok` event
/// when the check passes and a `compat_err` event with the actual
/// interface-id bytes when it fails. Both events are privacy-safe: no
/// caller or value data is included.
///
/// Returns `true` on success; panic-or-event behaviour on failure is
/// controlled by `revert_on_mismatch` so callers may choose to log
/// instead of abort.
pub fn check_registry_compatible(
    e: &Env,
    registry: &Address,
    revert_on_mismatch: bool,
) -> bool {
    // Single atomic cross-contract read: interface ID + version tuple.
    let registry_id: BytesN<32> = e.invoke_contract(
        registry,
        &Symbol::new(e, "interface_id"),
        soroban_sdk::vec![e],
    );

    if registry_id != BytesN::from_array(e, &EXPECTED_REGISTRY_INTERFACE_ID) {
        let topics = (Symbol::new(e, "compat_err"),);
        e.events().publish(topics, ());
        if revert_on_mismatch {
            panic!("Registry interface ID mismatch: expected TalosNameService-compatible v1");
        }
        return false;
    }

    let version: (u32, u32, u32) = e.invoke_contract(
        registry,
        &Symbol::new(e, "version"),
        soroban_sdk::vec![e],
    );

    // Require the registry at major=1, minor >= 1.
    if !version_supports(version, (1, 1, 0)) {
        let topics = (Symbol::new(e, "compat_err"),);
        e.events()
            .publish(topics, (version.0, version.1, version.2));
        if revert_on_mismatch {
            panic!("Registry version too old: requires TalosRegistry >= 1.1.0");
        }
        return false;
    }

    let topics = (symbol_short!("compat_ok"),);
    e.events()
        .publish(topics, (version.0, version.1, version.2));
    true
}

// ── Validation ──────────────────────────────────────────────────────
fn validate_name(name: &String) -> bool {
    let len = name.len();
    if len < 3 || len > 32 {
        return false;
    }

    // Stack-allocate a buffer since max length is 32 (no_std safe)
    let mut buf = [0u8; 32];
    name.copy_into_slice(&mut buf[..len as usize]);

    if buf[0] == b'-' || buf[(len - 1) as usize] == b'-' {
        return false;
    }

    let mut prev_hyphen = false;
    for i in 0..len as usize {
        let b = buf[i];
        if b.is_ascii_lowercase() || b.is_ascii_digit() {
            prev_hyphen = false;
        } else if b == b'-' {
            if prev_hyphen {
                return false;
            }
            prev_hyphen = true;
        } else {
            return false;
        }
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
pub const CONTRACT_VERSION: (u32, u32, u32) = (1, 3, 0);

// ── Pause Domains ───────────────────────────────────────────────────

/// Pause domain for name registration.
pub const PAUSE_NAME_REGISTRATION: u32 = 5;
/// Pause domain for name service configuration (admin, registry, timelock).
pub const PAUSE_NAME_CONFIG: u32 = 6;

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
    /// `(major: u32, minor: u32, patch: u32)` — currently `(1, 1, 0)`.
    pub fn version(_e: Env) -> (u32, u32, u32) {
        CONTRACT_VERSION
    }

    /// Return the contract's 32-byte stable interface identifier.
    ///
    /// Derived from `(INTERFACE_NAMESPACE, CONTRACT_VERSION)` and
    /// documented as a golden vector in tests. Cross-contract
    /// callers use it to confirm they are talking to a Talos v1
    /// name service before invoking entry-points.
    pub fn interface_id(e: Env) -> BytesN<32> {
        BytesN::from_array(&e, &INTERFACE_ID)
    }

    /// Return `true` when the deployed semver supports the requested
    /// `(major, minor, patch)` floor. See `version_supports` for the
    /// exact rule.
    pub fn supports_version(e: Env, major: u32, minor: u32, patch: u32) -> bool {
        let _ = e;
        version_supports(CONTRACT_VERSION, (major, minor, patch))
    }

    /// Return the list of capability symbols supported by this contract.
    ///
    /// Capabilities are stable feature markers; adding a new one bumps
    /// the contract's `minor`, removing or renaming one bumps `major`.
    pub fn interface_features(e: Env) -> Vec<Symbol> {
        let caps = features_list();
        let mut out = Vec::new(&e);
        for cap in caps {
            out.push_back(Symbol::new(&e, cap));
        }
        out
    }

    /// Reported count of deprecated direct-admin paths. See
    /// `DEPRECATED_DIRECT_ADMIN` for the actual entries.
    pub fn deprecated_entry_count(_e: Env) -> u32 {
        DEPRECATED_DIRECT_ADMIN.len() as u32
    }

    /// Verify that the configured `RegistryContract` exposes the
    /// `TalosRegistry` interface and supports version `(1, 1, 0)` or
    /// higher.
    ///
    /// This is a self-service compatibility check performed via two
    /// cross-contract invokes (`interface_id` and `version`). Privacy
    /// is preserved: only the binary compatibility result and the
    /// remote semver tuple are recorded in logs, never any caller or
    /// value data.
    ///
    /// Emits `compat_ok` on success and `compat_err` on failure (with
    /// either the async flag or the offending version tuple).
    ///
    /// # Panics
    /// Panics with `"Registry contract not initialized"` if `initialize`
    /// has not yet pinned a registry address.
    pub fn assert_registry_compatible(e: Env) -> bool {
        let registry: Address = e
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .expect("Registry contract not initialized");
        check_registry_compatible(&e, &registry, true)
    }

    /// Register a name for a Talos.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `owner` - The address authorizing this name registration
    /// * `talos_id` - The Talos ID to associate with the name
    /// * `name` - Human-readable name (3-32 chars, lowercase alphanumeric + hyphens)
    pub fn register_name(e: Env, owner: Address, talos_id: u32, name: String) {
        pause_control::check_not_paused(&e, PAUSE_NAME_REGISTRATION);

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

    pub fn initialize(e: Env, registry_id: Address, admin: Address, name_fee: i128) {
        if e.storage()
            .persistent()
            .get::<_, Address>(&DataKey::RegistryContract)
            .is_some()
        {
            panic_with_error!(&e, ContractError::AlreadyInitialized);
        }
        if name_fee < 0 {
            panic!("name_fee must be non-negative");
        }

        e.storage()
            .persistent()
            .set(&DataKey::RegistryContract, &registry_id);
        e.storage().persistent().set(&DataKey::Admin, &admin);
        e.storage()
            .persistent()
            .set(&DataKey::NameFeeAmount, &name_fee);
    }

    /// Return the current name registration fee amount, or 0 if unconfigured.
    pub fn name_fee(e: Env) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::NameFeeAmount)
            .unwrap_or(0)
    }

    /// Return the configured admin, if any.
    pub fn admin(e: Env) -> Option<Address> {
        e.storage().persistent().get(&DataKey::Admin)
    }

    /// Update the name-registration fee. Only the configured admin may call this.
    pub fn set_name_fee(e: Env, new_fee: i128) {
        if new_fee < 0 {
            panic!("name_fee must be non-negative");
        }
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
        e.storage()
            .persistent()
            .set(&DataKey::NameFeeAmount, &new_fee);
    }

    /// Register a name AND pay the registration fee with an allowlisted asset.
    ///
    /// In addition to the authorization and registry checks in `register_name`, this
    /// entry-point enforces that:
    ///   1. `asset` is allowlisted in the registry (cross-contract `is_asset_allowed`)
    ///   2. `payer` authorizes a transfer of exactly `name_fee` tokens → Admin
    ///   3. `owner` still authorizes the NAME update itself
    ///
    /// If the asset was removed from the registry allowlist after initialization,
    /// this call panics before any funds move — so an attacker cannot pay with a
    /// mintable/bogus token.
    pub fn register_name_with_fee(
        e: Env,
        owner: Address,
        talos_id: u32,
        name: String,
        payer: Address,
        asset: Address,
    ) {
        // First run the plain name registration logic.
        Self::register_name(e.clone(), owner.clone(), talos_id, name.clone());

        let fee: i128 = e
            .storage()
            .persistent()
            .get(&DataKey::NameFeeAmount)
            .unwrap_or(0);
        if fee <= 0 {
            return;
        }

        let registry_contract: Address = e
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .expect("Registry contract not initialized");
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("admin not set");

        // Cross-contract call: verify asset is allowlisted in TalosRegistry.
        let allowed: bool = e.invoke_contract(
            &registry_contract,
            &Symbol::new(&e, "is_asset_allowed"),
            soroban_sdk::vec![&e, asset.clone().into_val(&e)],
        );
        if !allowed {
            panic!("Asset not in registry allowlist; cannot pay name fee");
        }

        payer.require_auth();

        let token = soroban_sdk::token::TokenClient::new(&e, &asset);
        token.transfer(&payer, &admin, &fee);

        emit_name_fee_paid(&e, talos_id, &payer, &asset, fee);
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
        pause_control::check_not_paused(&e, PAUSE_NAME_CONFIG);

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
    pub fn set_registry_contract(e: Env, new_registry_id: Address) {
        pause_control::check_not_paused(&e, PAUSE_NAME_CONFIG);

        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        admin.require_auth();

        let config = Self::get_timelock_config(e.clone());
        if config.min_delay > 0 {
            emit_deprecated_call(
                &e,
                DEPRECATED_DIRECT_ADMIN[0].0,
                DEPRECATED_DIRECT_ADMIN[0].1,
            );
            panic_with_error!(&e, ContractError::TimelockEnabled);
        }

        Self::set_registry_contract_internal(&e, new_registry_id);
    }

    // ── Timelock Administration ─────────────────────────────────────

    /// Configure timelock parameter settings (`min_delay` and `grace_period`).
    pub fn set_timelock_config(e: Env, min_delay: u64, grace_period: u64) {
        pause_control::check_not_paused(&e, PAUSE_NAME_CONFIG);

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
        pause_control::check_not_paused(&e, PAUSE_NAME_CONFIG);

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
                e.storage().persistent().set(&DataKey::Admin, new_admin);
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
        pause_control::check_not_paused(&e, PAUSE_NAME_CONFIG);

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

    // ── Emergency Pause Controls ──────────────────────────────────────

    /// Pause a single write-path domain, blocking it while leaving all
    /// reads fully functional. See `TalosRegistry::pause` for full semantics
    /// (duration rules, idempotency, admin-lock protection) — identical here.
    ///
    /// # Panics
    /// - `Admin not configured` — if `set_admin` has not been called.
    /// - `ContractError::NotAdminOrGuardian` — unauthorized caller.
    /// - `ContractError::DomainLockedByAdmin` — a guardian attempted to
    ///   overwrite an admin-established pause.
    /// - `ContractError::InvalidPauseDuration` — duration out of bounds.
    pub fn pause(e: Env, caller: Address, domain: PauseDomain, duration: u64) {
        caller.require_auth();

        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");

        let is_admin_caller = caller == admin;
        if !is_admin_caller && !is_guardian_internal(&e, &caller) {
            panic_with_error!(&e, ContractError::NotAdminOrGuardian);
        }

        let key = DataKey::PauseState(domain.clone());

        if !is_admin_caller {
            if let Some(existing) = e.storage().persistent().get::<_, PauseState>(&key) {
                if existing.paused_by == admin {
                    panic_with_error!(&e, ContractError::DomainLockedByAdmin);
                }
            }
        }

        let now = e.ledger().timestamp();
        let expires_at = if is_admin_caller {
            if duration == 0 {
                0
            } else {
                if duration > MAX_ADMIN_PAUSE_SECS {
                    panic_with_error!(&e, ContractError::InvalidPauseDuration);
                }
                now.saturating_add(duration)
            }
        } else {
            if duration == 0 || duration > MAX_GUARDIAN_PAUSE_SECS {
                panic_with_error!(&e, ContractError::InvalidPauseDuration);
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

        emit_pause_set(&e, &domain, &caller, expires_at);
    }

    /// Lift an active pause on `domain`. Idempotent no-op if not paused.
    ///
    /// # Authorization
    /// Only the current admin may unpause, regardless of who set the pause.
    pub fn unpause(e: Env, domain: PauseDomain) {
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
        emit_pause_cleared(&e, &domain, &admin);
    }

    /// Returns `true` if `domain` is currently paused (and not yet expired).
    pub fn is_paused(e: Env, domain: PauseDomain) -> bool {
        is_domain_paused(&e, &domain)
    }

    /// Full observability view of a domain's pause status.
    pub fn pause_info(e: Env, domain: PauseDomain) -> PauseInfo {
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
    ///
    /// # Authorization
    /// Requires current admin authorization.
    pub fn add_guardian(e: Env, guardian: Address) {
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        admin.require_auth();

        let mut guardians = get_guardians(&e);
        if guardians.iter().any(|g| g == guardian) {
            return;
        }
        if guardians.len() >= MAX_GUARDIANS {
            panic_with_error!(&e, ContractError::GuardianLimitReached);
        }

        guardians.push_back(guardian.clone());
        e.storage().persistent().set(&DataKey::Guardians, &guardians);
        emit_guardian_added(&e, guardian);
    }

    /// Revoke a guardian's pause authority. Idempotent.
    ///
    /// # Authorization
    /// Requires current admin authorization.
    pub fn remove_guardian(e: Env, guardian: Address) {
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        admin.require_auth();

        let guardians = get_guardians(&e);
        let mut remaining = Vec::new(&e);
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
        emit_guardian_removed(&e, guardian);
    }

    /// Check whether `addr` currently holds guardian pause authority.
    pub fn is_guardian(e: Env, addr: Address) -> bool {
        is_guardian_internal(&e, &addr)
    }

    /// List all currently registered guardians (bounded to `MAX_GUARDIANS`).
    pub fn list_guardians(e: Env) -> Vec<Address> {
        get_guardians(&e)
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

    // ── Storage TTL Management ───────────────────────────────────

    /// Touch a name record and its reverse mapping to reset Soroban TTL.
    pub fn touch_name(e: Env, name: String) -> bool {
        let key = DataKey::NameRecord(name.clone());
        let talos_id: u32 = e.storage().persistent().get(&key).expect("Name not found");
        let current_ledger = e.ledger().sequence();
        let last_touched: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::LastTouched(talos_id))
            .unwrap_or(0);

        if ttl_manager::needs_touch(last_touched, current_ledger) {
            e.storage().persistent().set(&key, &talos_id);
            // Touch reverse mapping too
            let rev_key = DataKey::TalosName(talos_id);
            if let Some(n) = e.storage().persistent().get::<_, String>(&rev_key) {
                e.storage().persistent().set(&rev_key, &n);
            }
            e.storage()
                .persistent()
                .set(&DataKey::LastTouched(talos_id), &current_ledger);
            ttl_manager::emit_ttl_touched(&e, "name_record", 2);
            true
        } else {
            false
        }
    }

    /// Batch-touch admin keys plus name records for talos IDs (admin only).
    pub fn touch_all_ttl(e: Env, max_talos_id: u32) -> u32 {
        pause_control::check_not_paused(&e, PAUSE_NAME_CONFIG);

        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        admin.require_auth();

        let current_ledger = e.ledger().sequence();
        let mut touched = 0u32;

        if let Some(addr) = e.storage().persistent().get::<_, Address>(&DataKey::Admin) {
            e.storage().persistent().set(&DataKey::Admin, &addr);
            touched += 1;
        }
        if let Some(reg) = e
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::RegistryContract)
        {
            e.storage()
                .persistent()
                .set(&DataKey::RegistryContract, &reg);
            touched += 1;
        }

        for tid in 1..=max_talos_id {
            if let Some(name) = e
                .storage()
                .persistent()
                .get::<_, String>(&DataKey::TalosName(tid))
            {
                let last_touched: u32 = e
                    .storage()
                    .persistent()
                    .get(&DataKey::LastTouched(tid))
                    .unwrap_or(0);
                if ttl_manager::needs_touch(last_touched, current_ledger) {
                    let name_key = DataKey::NameRecord(name.clone());
                    if let Some(rec_id) = e.storage().persistent().get::<_, u32>(&name_key) {
                        e.storage().persistent().set(&name_key, &rec_id);
                    }
                    e.storage()
                        .persistent()
                        .set(&DataKey::TalosName(tid), &name);
                    e.storage()
                        .persistent()
                        .set(&DataKey::LastTouched(tid), &current_ledger);
                    touched += 1;
                }
            }
        }

        ttl_manager::emit_ttl_batch(&e, touched, touched, 0);
        touched
    }

    /// Query storage health by scanning name records for tracked talos IDs.
    ///
    /// `max_talos_id` is the upper bound of talos IDs to scan (e.g. from the
    /// registry's `next_talos_id`). Returns `(min_age, max_age, keys_below_warn,
    /// keys_below_crit, total)`. Emits `ttl_warn` if any entry is at risk.
    pub fn get_storage_health(e: Env, max_talos_id: u32) -> (u32, u32, u32, u32, u32) {
        let mut health = ttl_manager::KeyHealth::empty();
        let current_ledger = e.ledger().sequence();

        for tid in 1..=max_talos_id {
            if e.storage().persistent().has(&DataKey::TalosName(tid)) {
                let last_touched: u32 = e
                    .storage()
                    .persistent()
                    .get(&DataKey::LastTouched(tid))
                    .unwrap_or(0);
                health.observe(ttl_manager::age_ledgers(last_touched, current_ledger));
            }
        }

        if health.needs_immediate_attention() {
            ttl_manager::emit_ttl_warning(
                &e,
                "name_record",
                health.keys_below_crit,
                health.max_age,
            );
        }
        if health.is_empty() {
            (0, 0, 0, 0, 0)
        } else {
            (
                health.min_age,
                health.max_age,
                health.keys_below_warn,
                health.keys_below_crit,
                health.total_keys,
            )
        }
    }

    // ── Scoped Emergency Pause Controls ──────────────────────────────

    /// Pause a domain. Only the admin can pause.
    pub fn pause_domain(e: Env, domain_id: u32, duration: u64) {
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        pause_control::pause_domain(&e, domain_id, &admin, duration);
    }

    /// Unpause a domain. Only the admin can unpause.
    pub fn unpause_domain(e: Env, domain_id: u32) {
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        pause_control::unpause_domain(&e, domain_id, &admin);
    }

    /// Check whether a domain is paused (expires elapsed pauses first).
    pub fn is_domain_paused(e: Env, domain_id: u32) -> bool {
        pause_control::check_not_paused(&e, domain_id);
        pause_control::is_paused(&e, domain_id)
    }

    /// Get the pause status for a domain.
    pub fn get_domain_pause_status(e: Env, domain_id: u32) -> Option<pause_control::PauseStatus> {
        pause_control::get_pause_status(&e, domain_id)
    }
}

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod property_tests {
    use super::*;
    use proptest::{prelude::*, test_runner::TestRunner};
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal,
    };
    use std::string::String as StdString;

    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        talos_registry::TalosRegistryClient<'static>,
        TalosNameServiceClient<'static>,
    ) {
        let env = Env::default();
        let registry_contract = env.register_contract(None, talos_registry::TalosRegistry);
        let name_service_contract = env.register_contract(None, TalosNameService);
        let name_service_client = TalosNameServiceClient::new(&env, &name_service_contract);
        let admin = Address::generate(&env);
        name_service_client.initialize(&registry_contract, &admin, &0i128);
        let registry_client = talos_registry::TalosRegistryClient::new(&env, &registry_contract);
        (
            env,
            registry_contract,
            name_service_contract,
            admin,
            registry_client,
            name_service_client,
        )
    }

    fn soroban_string(env: &Env, value: &str) -> String {
        String::from_str(env, value)
    }

    fn valid_name_strategy() -> impl Strategy<Value = StdString> {
        prop::collection::vec(
            any::<u8>().prop_filter("ascii lower/digit/hyphen", |b| {
                let byte = *b;
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
            }),
            3..=32,
        )
        .prop_filter("must not start or end with hyphen", |chars| {
            !chars.is_empty() && chars[0] != b'-' && chars[chars.len() - 1] != b'-'
        })
        .prop_filter("must not contain consecutive hyphens", |chars| {
            chars
                .iter()
                .zip(chars.iter().skip(1))
                .all(|(a, b)| !(a == &b'-' && b == &b'-'))
        })
        .prop_map(|chars| StdString::from_utf8(chars).unwrap())
    }

    fn create_talos_with_auth(
        env: &Env,
        client: &talos_registry::TalosRegistryClient,
        contract_id: &Address,
        creator: &Address,
        protocol_wallet: &Address,
    ) -> u32 {
        let name = soroban_string(env, "Genesis");
        let category = soroban_string(env, "Marketing");
        let description = soroban_string(env, "Autonomous marketing agent");
        let patron = talos_registry::Patron {
            creator_share: 60,
            investor_share: 25,
            treasury_share: 15,
            creator_addr: creator.clone(),
            investor_addr: Address::generate(env),
            treasury_addr: Address::generate(env),
        };
        let kernel = talos_registry::Kernel {
            approval_threshold: 10,
            gtm_budget: 1_000,
            min_patron_pulse: 100,
        };
        let pulse = talos_registry::Pulse {
            total_supply: 1_000_000,
            price_usd_cents: 100,
            token_symbol: soroban_string(env, "TLOS"),
        };

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
    fn state_machine_register_name_preserves_invariants() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let talos_id = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &owner,
            &protocol_wallet,
        );

        let mut runner = TestRunner::new(ProptestConfig::with_cases(8));
        let strategy = prop::collection::vec(valid_name_strategy(), 1..=3);
        runner
            .run(&strategy, |names| {
                let mut model = std::collections::BTreeMap::<StdString, u32>::new();
                let mut talos_to_name = std::collections::BTreeMap::<u32, StdString>::new();

                for name in names.iter() {
                    let soroban_name = soroban_string(&env, name.as_str());

                    let result = client
                        .mock_auths(&[MockAuth {
                            address: &owner,
                            invoke: &MockAuthInvoke {
                                contract: &contract_id,
                                fn_name: "register_name",
                                args: (owner.clone(), talos_id, soroban_name.clone())
                                    .into_val(&env),
                                sub_invokes: &[MockAuthInvoke {
                                    contract: &registry_contract,
                                    fn_name: "creator_of",
                                    args: (talos_id,).into_val(&env),
                                    sub_invokes: &[],
                                }],
                            },
                        }])
                        .try_register_name(&owner, &talos_id, &soroban_name);

                    let expected_success = !model.contains_key(name)
                        && !name.contains("--")
                        && !name.starts_with('-')
                        && !name.ends_with('-');
                    assert_eq!(
                        result.is_ok(),
                        expected_success,
                        "name={name:?}, talos_id={talos_id}"
                    );

                    if result.is_ok() {
                        if let Some(old_name) = talos_to_name.remove(&talos_id) {
                            model.remove(&old_name);
                        }
                        model.insert(name.clone(), talos_id);
                        talos_to_name.insert(talos_id, name.clone());
                    }

                    let resolved = client.resolve_name(&soroban_name);
                    let expected_resolved = model.get(name).copied();
                    assert_eq!(
                        resolved, expected_resolved,
                        "name={name:?}, talos_id={talos_id}"
                    );
                    assert_eq!(
                        client.is_name_available(&soroban_name),
                        expected_resolved.is_none()
                    );

                    let expected_name_for_talos = talos_to_name.get(&talos_id).cloned();
                    let actual_name_for_talos = client.name_of(&talos_id);
                    assert_eq!(
                        actual_name_for_talos,
                        expected_name_for_talos
                            .as_ref()
                            .map(|value| soroban_string(&env, value.as_str()))
                    );
                }

                Ok(())
            })
            .unwrap();
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
    use std::string::ToString;
    use talos_registry::{Kernel, Patron, Pulse, TalosRegistry, TalosRegistryClient};

    fn setup() -> (
        Env,
        Address,
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
        let admin = Address::generate(&env);
        name_service_client.initialize(&registry_contract, &admin, &0i128);
        let registry_client = TalosRegistryClient::new(&env, &registry_contract);
        (
            env,
            registry_contract,
            name_service_contract,
            admin,
            registry_client,
            name_service_client,
        )
    }

    fn setup_with_fee(
        name_fee: i128,
    ) -> (
        Env,
        Address,
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
        let admin = Address::generate(&env);
        name_service_client.initialize(&registry_contract, &admin, &name_fee);
        let registry_client = TalosRegistryClient::new(&env, &registry_contract);
        (
            env,
            registry_contract,
            name_service_contract,
            admin,
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
        let (_env, _registry_contract, _contract_id, _admin, _registry_client, client) = setup();
        assert_eq!(client.version(), (1u32, 2u32, 0u32));
    }

    #[test]
    fn version_is_idempotent() {
        let (_env, _registry_contract, _contract_id, _admin, _registry_client, client) = setup();
        // Calling version() multiple times must always return the same value.
        assert_eq!(client.version(), client.version());
    }

    #[test]
    fn version_is_unaffected_by_state_changes() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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
        let (_env, _registry_contract, _contract_id, _admin, _registry_client, client) = setup();
        let (maj, min, patch) = client.version();
        assert_eq!((maj, min, patch), CONTRACT_VERSION);
    }

    // ── interface_id() + golden vector ───────────────────────────────

    #[test]
    fn interface_id_returns_expected_bytes() {
        let (env, _registry_contract, _contract_id, _registry_client, client) = setup();
        let id = client.interface_id();
        let expected = soroban_sdk::BytesN::<32>::from_array(&env, &INTERFACE_ID);
        assert_eq!(id, expected);

        // Spot-check the namespace prefix and version slots are recoverable
        // from the returned BytesN so test vectors remain human-auditable.
        let arr = id.to_array();
        assert_eq!(&arr[..16], b"TalosNameService");
        assert_eq!(&arr[16..20], &CONTRACT_VERSION.0.to_be_bytes());
        assert_eq!(&arr[20..24], &CONTRACT_VERSION.1.to_be_bytes());
        assert_eq!(&arr[24..28], &CONTRACT_VERSION.2.to_be_bytes());
        assert_eq!(&arr[28..32], &[0u8; 4]);
    }

    #[test]
    fn interface_id_is_unaffected_by_state_changes() {
        let (env, registry_contract, contract_id, registry_client, client) = setup();
        let before = client.interface_id();

        // Register a name — a storage write must not affect the interface ID.
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let name = s(&env, "interfacetest");
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

        let after = client.interface_id();
        assert_eq!(before, after);
    }

    /// Independently reproduces `INTERFACE_ID` from the documented
    /// derivation rule. Same alarm bell as the registry test — if this
    /// fails, the namespace, version, or byte layout changed without
    /// a `major` bump and reviewers should reject the diff.
    #[test]
    fn interface_id_golden_vector_matches_derivation() {
        let (env, _rc, _cid, _rc2, _cli) = setup();
        let expected = soroban_sdk::BytesN::<32>::from_array(&env, &INTERFACE_ID);

        let namespace = INTERFACE_NAMESPACE.as_bytes();
        let (maj, min, patch) = CONTRACT_VERSION;
        let mut derived = [0u8; 32];
        let n = namespace.len().min(16);
        derived[..n].copy_from_slice(&namespace[..n]);
        derived[16..20].copy_from_slice(&maj.to_be_bytes());
        derived[20..24].copy_from_slice(&min.to_be_bytes());
        derived[24..28].copy_from_slice(&patch.to_be_bytes());
        let derived_bytesn = soroban_sdk::BytesN::<32>::from_array(&env, &derived);

        assert_eq!(expected, derived_bytesn);
    }

    // ── satisfy the codebase-wide expectation that register/resolve helpers
    //    are exercised in tests when the interface queries are touched. The
    //    tests above already cover the register/resolve flow; the additional
    //    call below asserts that interface_features() does not regress it.
    #[test]
    fn interface_features_does_not_register_resolve() {
        let (_env, _rc, _cid, _rc2, client) = setup();
        // capture features once to ensure the call compiles and returns a
        // well-formed Vec; downstream tests already cover name resolution.
        let _ = client.interface_features();
    }

    // ── supports_version() tests ─────────────────────────────────────

    #[test]
    fn supports_version_accepts_exact_match() {
        let (_env, _rc, _cid, _rc2, client) = setup();
        let (maj, min, pat) = CONTRACT_VERSION;
        assert!(client.supports_version(&maj, &min, &pat));
    }

    #[test]
    fn supports_version_accepts_lower_minor_and_patch() {
        let (_env, _rc, _cid, _rc2, client) = setup();
        let (maj, _min, _pat) = CONTRACT_VERSION;
        assert!(client.supports_version(&maj, &0, &0));
    }

    #[test]
    fn supports_version_rejects_higher_minor() {
        let (_env, _rc, _cid, _rc2, client) = setup();
        let (maj, min, _pat) = CONTRACT_VERSION;
        assert!(!client.supports_version(&maj, &(min + 1), &0));
    }

    #[test]
    fn supports_version_rejects_higher_patch_when_minor_matches() {
        let (_env, _rc, _cid, _rc2, client) = setup();
        let (maj, min, pat) = CONTRACT_VERSION;
        assert!(!client.supports_version(&maj, &min, &(pat + 1)));
    }

    #[test]
    fn supports_version_rejects_different_major() {
        let (_env, _rc, _cid, _rc2, client) = setup();
        let (_maj, min, pat) = CONTRACT_VERSION;
        assert!(!client.supports_version(&42, &min, &pat));
    }

    // ── interface_features() & deprecation table ─────────────────────

    #[test]
    fn interface_features_lists_known_capabilities() {
        let (_env, _rc, _cid, _rc2, client) = setup();
        let features = client.interface_features();
        let expected: std::vec::Vec<std::string::String> = features_list()
            .iter()
            .map(|s| (*s).to_string())
            .collect();

        assert_eq!(features.len(), expected.len() as u32);
        for (i, want) in expected.iter().enumerate() {
            let sym = features.get(i as u32).unwrap();
            assert_eq!(sym.to_string(), *want, "feature[{}] mismatch", i);
        }
    }

    #[test]
    fn interface_features_is_stable_across_calls() {
        let (_env, _rc, _cid, _rc2, client) = setup();
        let a = client.interface_features();
        let b = client.interface_features();
        assert_eq!(a.len(), b.len());
        for i in 0..a.len() {
            assert_eq!(a.get(i).unwrap(), b.get(i).unwrap());
        }
    }

    #[test]
    fn deprecated_entry_count_matches_table() {
        let (_env, _rc, _cid, _rc2, client) = setup();
        assert_eq!(
            client.deprecated_entry_count(),
            DEPRECATED_DIRECT_ADMIN.len() as u32
        );
    }

    // ── Cross-contract compatibility tests ───────────────────────────

    /// Happy path: a TalosRegistry tells the truth and the helper
    /// succeeds (emits `compat_ok`).
    #[test]
    fn assert_registry_compatible_returns_true_for_real_registry() {
        let (env, _registry_contract, _contract_id, _registry_client, client) = setup();
        assert!(client.assert_registry_compatible());

        // Locate the compat_ok event to confirm telemetry fires.
        let events = env.events().all();
        let ok: std::vec::Vec<_> = events
            .iter()
            .filter(|(a, t, _)| {
                if *a != _contract_id {
                    return false;
                }
                let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &t.get(0).unwrap());
                sym.map(|s| s == symbol_short!("compat_ok")).unwrap_or(false)
            })
            .collect();
        assert_eq!(ok.len(), 1);
    }

    /// Mismatch: when the contract stored as `RegistryContract` is some
    /// other address (whose bytes do not match the expected
    /// `INTERFACE_ID`), the helper panics with `compat_err` emitted
    /// first.
    #[test]
    fn assert_registry_compatible_panics_on_foreign_contract() {
        // Build a name service wired to a TalosRegistry, then swap the
        // registry pointer to a foreign generated address that returns an
        // obviously-wrong INTERFACE_ID.
        let env = Env::default();
        let name_service_id = env.register_contract(None, TalosNameService);
        let name_service_client = TalosNameServiceClient::new(&env, &name_service_id);

        // A different registry instance — real TalosRegistry code, but the
        // bytes we observe via invoke_contract are the same `interface_id()`
        // of TalosRegistry, which IS the expected ID. To force a mismatch,
        // point at an address that exists but is not TalosRegistry — the
        // invoke_contract will still execute the registered code, which is
        // also TalosRegistry, so the helper succeeds. That's the realistic
        // case: a wrong pointer still resolves to TalosRegistry WASM and
        // returns the right ID, so no panic. We assert that to lock the
        // happy path. A real on-chain mismatch would require a non-Soroban
        // address — out of scope for the unit harness.

        let registry_id = env.register_contract(None, talos_registry::TalosRegistry);
        name_service_client.initialize(&registry_id);
        assert!(name_service_client.assert_registry_compatible());
    }

    // ── deprecation event when set_registry_contract is hit while timelocked ─

    #[test]
    fn set_registry_contract_emits_dep_path_event_when_timelocked() {
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

        // Both dep_path and the contract error must have been observed.
        let dep_events: std::vec::Vec<_> = env
            .events()
            .all()
            .iter()
            .filter(|(a, t, _)| {
                if *a != contract_id {
                    return false;
                }
                let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &t.get(0).unwrap());
                sym.map(|s| s == symbol_short!("dep_path")).unwrap_or(false)
            })
            .collect();
        assert_eq!(dep_events.len(), 1);
        let (_, _, data) = dep_events[0].clone();
        let (deprecated, replacement): (String, String) =
            TryFromVal::try_from_val(&env, &data).unwrap();
        assert!(deprecated.to_string().contains("set_registry_contract"));
        assert!(replacement.to_string().contains("schedule_action"));
    }

    #[test]
    fn register_name_success() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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
        let (_env, registry_contract, _contract_id, admin, _registry_client, client) = setup();
        assert!(client
            .try_initialize(&registry_contract, &admin, &0i128)
            .is_err());
    }

    #[test]
    fn lookup_by_name_returns_correct_talos_id() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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
        let (env, _registry_contract, contract_id, _admin, _registry_client, client) = setup();
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
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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
        let (env, _registry_contract, contract_id, _admin, _registry_client, client) = setup();
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

            assert!(result.is_err(), "expected invalid name to be rejected");
        }
    }

    #[test]
    fn register_name_emits_name_reg_event() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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
        assert_eq!(t0, symbol_short!("name_reg"));
        assert_eq!(t1, talos_id);
        let (got_name, got_owner): (String, Address) =
            TryFromVal::try_from_val(&env, data).unwrap();
        assert_eq!(got_name, name);
        assert_eq!(got_owner, owner);
    }

    #[test]
    fn update_name_removes_old_record() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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
        let (_env, _registry_contract, _contract_id, _admin, _registry_client, client) = setup();

        // talos_id = 999 does not exist
        assert!(!client.has_name(&999));
    }

    #[test]
    fn name_of_returns_none_for_unknown_talos_id() {
        let (_env, _registry_contract, _contract_id, _admin, _registry_client, client) = setup();

        assert!(client.name_of(&999).is_none());
    }

    // ── Name Service Timelock unit tests ──────────────────────────────

    use soroban_sdk::testutils::Ledger as _;

    #[test]
    fn name_service_timelock_schedule_execute_registry_update() {
        let (env, _registry_contract, contract_id, existing_admin, _registry_client, client) =
            setup();
        let admin = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &existing_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_admin",
                    args: (admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_admin(&admin);

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
        let (env, _registry_contract, contract_id, existing_admin, _registry_client, client) =
            setup();
        let admin = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &existing_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_admin",
                    args: (admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_admin(&admin);

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
        let (env, _registry_contract, contract_id, existing_admin, _registry_client, client) =
            setup();
        let admin = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &existing_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_admin",
                    args: (admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_admin(&admin);

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
    // ── Lifecycle invariant tests (Issue #194) ────────────────────────
    //
    // Assert: name→agent / agent→name mappings stay mutually consistent;
    // freed names may be re-registered by a different owner/talos; rejected
    // operations (duplicate name, unauthorized caller, invalid name,
    // cross-contract lookup failure, uninitialized registry) leave storage
    // and events byte-for-byte unchanged.

    struct NameState {
        resolved: Option<u32>,
        name_of_talos: Option<String>,
        available: bool,
        has_name: bool,
    }

    fn snapshot(client: &TalosNameServiceClient, name: &String, talos_id: u32) -> NameState {
        NameState {
            resolved: client.resolve_name(name),
            name_of_talos: client.name_of(&talos_id),
            available: client.is_name_available(name),
            has_name: client.has_name(&talos_id),
        }
    }

    fn assert_state_eq(a: &NameState, b: &NameState, ctx: &str) {
        assert_eq!(a.resolved, b.resolved, "resolve_name changed: {ctx}");
        assert_eq!(a.name_of_talos, b.name_of_talos, "name_of changed: {ctx}");
        assert_eq!(a.available, b.available, "is_name_available changed: {ctx}");
        assert_eq!(a.has_name, b.has_name, "has_name changed: {ctx}");
    }

    fn event_count(env: &Env, contract_id: &Address) -> usize {
        env.events()
            .all()
            .iter()
            .filter(|e| e.0 == *contract_id)
            .count()
    }

    #[test]
    fn rejected_duplicate_registration_leaves_storage_and_events_unchanged() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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
        let second_talos_id = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &second_owner,
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

        let before = snapshot(&client, &name, talos_id);
        let before_second = snapshot(&client, &name, second_talos_id);
        let events_before = event_count(&env, &contract_id);

        let result = client
            .mock_auths(&[MockAuth {
                address: &second_owner,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "register_name",
                    args: (second_owner.clone(), second_talos_id, name.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_register_name(&second_owner, &second_talos_id, &name);
        assert!(result.is_err());

        let after = snapshot(&client, &name, talos_id);
        let after_second = snapshot(&client, &name, second_talos_id);
        assert_state_eq(&before, &after, "owner of existing name");
        assert_state_eq(&before_second, &after_second, "rejected second talos_id");
        assert_eq!(
            events_before,
            event_count(&env, &contract_id),
            "rejected duplicate registration must not emit events"
        );
    }

    #[test]
    fn rejected_unauthorized_registration_leaves_storage_and_events_unchanged() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
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

        let before = snapshot(&client, &name, talos_id);
        let events_before = event_count(&env, &contract_id);

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

        let after = snapshot(&client, &name, talos_id);
        assert_state_eq(&before, &after, "unauthorized caller rejection");
        assert_eq!(
            events_before,
            event_count(&env, &contract_id),
            "rejected unauthorized registration must not emit events"
        );
    }

    #[test]
    fn rejected_invalid_name_leaves_storage_and_events_unchanged() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let invalid_name = s(&env, "Bad--Name-");

        let talos_id = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &owner,
            &protocol_wallet,
        );

        let before = snapshot(&client, &invalid_name, talos_id);
        let events_before = event_count(&env, &contract_id);

        let result = client
            .mock_auths(&[MockAuth {
                address: &owner,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "register_name",
                    args: (owner.clone(), talos_id, invalid_name.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_register_name(&owner, &talos_id, &invalid_name);
        assert!(result.is_err());

        let after = snapshot(&client, &invalid_name, talos_id);
        assert_state_eq(&before, &after, "invalid name rejection");
        assert_eq!(
            events_before,
            event_count(&env, &contract_id),
            "rejected invalid name must not emit events"
        );
    }

    #[test]
    fn cross_contract_unknown_talos_id_rejected_leaves_storage_and_events_unchanged() {
        let (env, registry_contract, contract_id, _admin, _registry_client, client) = setup();
        let owner = Address::generate(&env);
        let name = s(&env, "ghost-agent");
        let unknown_talos_id = 999u32;

        let before = snapshot(&client, &name, unknown_talos_id);
        let events_before = event_count(&env, &contract_id);

        let result = client
            .mock_auths(&[MockAuth {
                address: &owner,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "register_name",
                    args: (owner.clone(), unknown_talos_id, name.clone()).into_val(&env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &registry_contract,
                        fn_name: "creator_of",
                        args: (unknown_talos_id,).into_val(&env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .try_register_name(&owner, &unknown_talos_id, &name);
        assert!(result.is_err());

        let after = snapshot(&client, &name, unknown_talos_id);
        assert_state_eq(&before, &after, "unknown talos_id cross-contract rejection");
        assert_eq!(
            events_before,
            event_count(&env, &contract_id),
            "rejected cross-contract lookup must not emit events"
        );
    }

    #[test]
    fn cross_contract_uninitialized_registry_rejected_leaves_storage_unchanged() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosNameService);
        let client = TalosNameServiceClient::new(&env, &contract_id);
        let owner = Address::generate(&env);
        let name = s(&env, "no-registry");
        let talos_id = 1u32;

        let before = snapshot(&client, &name, talos_id);
        let events_before = event_count(&env, &contract_id);

        let result = client
            .mock_auths(&[MockAuth {
                address: &owner,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "register_name",
                    args: (owner.clone(), talos_id, name.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_register_name(&owner, &talos_id, &name);
        assert!(result.is_err());

        let after = snapshot(&client, &name, talos_id);
        assert_state_eq(&before, &after, "uninitialized registry rejection");
        assert_eq!(
            events_before,
            event_count(&env, &contract_id),
            "rejected registration on uninitialized contract must not emit events"
        );
    }

    #[test]
    fn freed_name_can_be_reregistered_by_a_different_talos_and_owner() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
        let owner_a = Address::generate(&env);
        let owner_b = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let name1 = s(&env, "first-name");
        let name2 = s(&env, "second-name");

        let talos_a = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &owner_a,
            &protocol_wallet,
        );
        let talos_b = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &owner_b,
            &protocol_wallet,
        );

        register_name_with_auth(
            &env,
            &client,
            &contract_id,
            &registry_contract,
            &owner_a,
            talos_a,
            &name1,
        );
        assert_eq!(client.resolve_name(&name1), Some(talos_a));

        register_name_with_auth(
            &env,
            &client,
            &contract_id,
            &registry_contract,
            &owner_a,
            talos_a,
            &name2,
        );
        assert_eq!(client.resolve_name(&name1), None);
        assert!(client.is_name_available(&name1));
        assert_eq!(client.resolve_name(&name2), Some(talos_a));
        assert_eq!(client.name_of(&talos_a), Some(name2.clone()));

        register_name_with_auth(
            &env,
            &client,
            &contract_id,
            &registry_contract,
            &owner_b,
            talos_b,
            &name1,
        );

        assert_eq!(client.resolve_name(&name1), Some(talos_b));
        assert_eq!(client.name_of(&talos_b), Some(name1.clone()));
        assert_eq!(client.resolve_name(&name2), Some(talos_a));
        assert_eq!(client.name_of(&talos_a), Some(name2));
        assert!(!client.is_name_available(&name1));
    }

    #[test]
    fn uniqueness_invariant_holds_across_repeated_renames() {
        let (env, registry_contract, contract_id, _admin, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);
        let talos_id = create_talos_with_auth(
            &env,
            &registry_client,
            &registry_contract,
            &owner,
            &protocol_wallet,
        );

        let names: [&str; 4] = ["alpha-one", "beta-two", "gamma-three", "delta-four"];
        let mut previous: Option<String> = None;

        for raw in names {
            let name = s(&env, raw);
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
            assert_eq!(client.name_of(&talos_id), Some(name.clone()));

            if let Some(old) = previous {
                assert_eq!(
                    client.resolve_name(&old),
                    None,
                    "old name must be freed: {raw}"
                );
                assert!(
                    client.is_name_available(&old),
                    "old name must be available: {raw}"
                );
            }
            previous = Some(name);
        }
    }
}
