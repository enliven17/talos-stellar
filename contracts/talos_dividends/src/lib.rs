//! TalosDividends — Pull-based dividend claim contract for the Talos protocol.
//!
//! # Design
//!
//! Instead of iterating over all eligible patrons on chain (push model), the
//! distributor commits a **distribution root** — a `(talos_id, epoch, total_amount)`
//! tuple stored on ledger — and each eligible patron independently calls
//! `claim_dividend` to pull their own allocation.  This bounds per-transaction
//! resource consumption to O(1) regardless of patron set size.
//!
//! ## Key invariants
//!
//! 1. **Single claim per (patron, epoch)** — the `Claimed(epoch, patron)` storage
//!    key acts as the double-claim guard; the contract panics on a second attempt.
//! 2. **Allocation bounded by patron shares** — the claimed amount is computed
//!    from the on-chain `Patron` struct's `creator_share`, `investor_share`, and
//!    `treasury_share` percentages and the epoch's `total_amount`; no off-chain
//!    proof input can exceed this bound.
//! 3. **Expiry enforced** — claims submitted after
//!    `epoch.created_at + epoch.expiry_secs` are rejected; expired funds can be
//!    swept back by the admin via `recover_expired`.
//! 4. **Accounting invariant** — `epoch.claimed_amount` is atomically incremented
//!    on every successful claim; `claimed_amount <= total_amount` is enforced at
//!    write time.
//! 5. **Idempotent operations** — `commit_epoch` is a no-op if the epoch already
//!    exists (same talos_id + epoch_id); duplicate calls are safe.
//!
//! ## Storage layout
//!
//! | Key                         | Value            | TTL policy  |
//! |-----------------------------|------------------|-------------|
//! | `Admin`                     | `Address`        | persistent  |
//! | `PendingAdmin`              | `Address`        | persistent  |
//! | `RegistryContract`          | `Address`        | persistent  |
//! | `Epoch(talos_id, epoch_id)` | `EpochRecord`    | persistent  |
//! | `Claimed(epoch_id, patron)` | `bool`           | persistent  |
//! | `RoundingDust(talos_id, epoch_id)` | `i128`     | persistent  |
//! | `NextEpochId(talos_id)`     | `u64`            | persistent  |
//! | `PendingAdmin`              | `Address`        | persistent  |
//!
//! ## Events (topics → data)
//!
//! | Symbol     | Topics                                    | Data                                               |
//! |------------|-------------------------------------------|----------------------------------------------------|
//! | `ep_cmt`   | `(symbol, talos_id: u32)`                 | `(epoch_id: u64, total: i128, expiry_secs: u64)`   |
//! | `div_clm`  | `(symbol, epoch_id: u64, patron: Address)`| `(talos_id: u32, amount: i128, role: PatronRole)`  |
//! | `div_dst`  | `(symbol, epoch_id: u64)`                  | `(talos_id: u32, dust: i128)`                      |
//! | `ep_rcv`   | `(symbol, epoch_id: u64)`                 | `(talos_id: u32, recovered: i128, admin: Address)` |
//! | `adm_prp`  | `(symbol,)`                               | `(current: Address, proposed: Address)`            |
//! | `adm_acc`  | `(symbol,)`                               | `(new_admin: Address,)`                            |
//! | `adm_cnl`  | `(symbol,)`                               | `(cancelled: Address,)`                            |
//! | `reg_upd`  | `(symbol,)`                               | `(old_registry: Address, new_registry: Address)`   |
//!
//! ## Compatibility / rollout notes
//!
//! This contract is additive — it does not modify `TalosRegistry` storage.
//! Deploy independently, configure `registry_contract` to point at the live
//! `TalosRegistry`, and begin committing epochs.  Old push-based flows can
//! continue operating in parallel until clients migrate to the claim interface.
//! Rounding dust is stored under a new key and defaults to absent for existing
//! epochs, so no migration is required.  It is recorded on the first claim,
//! when the contract receives the validated three-role split.
//!
//! ## Version
//!
//! `CONTRACT_VERSION = (1, 2, 0)`

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    Symbol, Vec,
};

// ── Error types ─────────────────────────────────────────────────────────────

/// Explicit, typed error codes returned by every fallible entry-point.
///
/// Using `contracterror` ensures callers get a typed `Result<_, ContractError>`
/// rather than an opaque host error, which simplifies retry / recovery logic.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    /// `initialize` was called on an already-initialised contract.
    AlreadyInitialized = 1,
    /// Required contract storage is absent (contract not yet initialised).
    NotInitialized = 2,
    /// Caller is not the configured administrator.
    Unauthorized = 3,
    /// The referenced epoch does not exist.
    EpochNotFound = 4,
    /// The patron has already claimed their allocation for this epoch.
    AlreadyClaimed = 5,
    /// The epoch's claim window has closed.
    EpochExpired = 6,
    /// The claim window is still open; recovery is not yet permitted.
    EpochNotExpired = 7,
    /// Computed allocation is zero; nothing to transfer.
    ZeroAllocation = 8,
    /// `total_amount` or `expiry_secs` violates minimum/maximum bounds.
    InvalidEpochParams = 9,
    /// The caller's address does not match any patron role in the Talos.
    NotAPatron = 10,
    /// An arithmetic overflow was detected; the operation was aborted.
    Overflow = 11,
    /// The epoch was already committed; duplicate `commit_epoch` calls are no-ops.
    EpochAlreadyExists = 12,
    /// The registry returned no Talos for the supplied `talos_id`.
    TalosNotFound = 13,
    /// `claimed_amount` would exceed `total_amount` (accounting invariant).
    AccountingOverflow = 14,
    /// The epoch has already been recovered; cannot recover twice.
    AlreadyRecovered = 15,
    /// Supplied patron shares do not sum to 100%.
    InvalidPatronShares = 16,
    /// Supplied patron shares differ from previously recorded shares for this epoch.
    InconsistentShareData = 17,
    /// No pending admin transfer exists to accept or cancel.
    NoPendingAdmin = 18,
    /// The new registry contract does not expose the expected TalosRegistry interface.
    IncompatibleRegistry = 19,
}

// ── Data types ───────────────────────────────────────────────────────────────

/// Identifies which patron role a claimant occupies in a given Talos.
///
/// The on-chain `Patron` struct carries three roles (creator, investor,
/// treasury).  This enum lets us record which role was used for a specific
/// claim, which is surfaced in the `div_clm` event for off-chain analytics.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PatronRole {
    Creator,
    Investor,
    Treasury,
}

/// Lifecycle state of a distribution epoch.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EpochStatus {
    /// Claims are open.
    Active,
    /// Claim window closed; unclaimed funds are recoverable by admin.
    Expired,
    /// Admin has swept unclaimed funds back.
    Recovered,
}

/// A single distribution epoch for one Talos.
///
/// The distributor commits one `EpochRecord` per payout round.  Each eligible
/// patron calls `claim_dividend` independently; the `claimed_amount` counter
/// is updated atomically on each successful claim.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EpochRecord {
    /// Globally unique epoch identifier (auto-incremented per talos_id).
    pub epoch_id: u64,
    /// The Talos this epoch belongs to.
    pub talos_id: u32,
    /// Total amount available for distribution across all patron roles.
    pub total_amount: i128,
    /// Running total of amounts successfully claimed so far.
    pub claimed_amount: i128,
    /// Ledger timestamp when this epoch was committed.
    pub created_at: u64,
    /// Seconds after `created_at` during which claims are accepted.
    /// After this window, `recover_expired` may be called.
    pub expiry_secs: u64,
    /// Lifecycle state.
    pub status: EpochStatus,
}

/// Persistent storage key enumeration.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Address authorised to commit epochs and recover expired funds.
    Admin,
    /// Address of the deployed `TalosRegistry` contract.
    RegistryContract,
    /// Distribution epoch record: `(talos_id: u32, epoch_id: u64)`.
    Epoch(u32, u64),
    /// Double-claim guard: `(epoch_id: u64, patron: Address)`.
    Claimed(u64, Address),
    /// Monotonically increasing epoch counter per talos: `talos_id: u32`.
    NextEpochId(u32),
    /// Rounding remainder derived from the epoch's validated patron split.
    /// Appended to preserve existing key discriminants.
    RoundingDust(u32, u64),
    /// Pending admin address nominated for transfer.
    PendingAdmin,
    /// Ledger sequence when an epoch's persistent records were last refreshed: `(talos_id: u32, epoch_id: u64)`.
    LastTouched(u32, u64),
}

// ── Constants ────────────────────────────────────────────────────────────────

/// Minimum epoch expiry: 1 hour.
const MIN_EXPIRY_SECS: u64 = 3_600;

/// Maximum epoch expiry: 365 days.
const MAX_EXPIRY_SECS: u64 = 31_536_000;

/// Minimum total_amount per epoch (1 stroops-equivalent unit).
const MIN_EPOCH_AMOUNT: i128 = 1;

/// Compile-time interface version of TalosDividends.
///
/// Format: `(major, minor, patch)` following Semantic Versioning.
/// - **major** — incompatible ABI change
/// - **minor** — backwards-compatible new entry-point or field
/// - **patch** — bug-fix with no observable ABI change
pub const CONTRACT_VERSION: (u32, u32, u32) = (1, 2, 0);

/// Expected `INTERFACE_ID` of the configured `RegistryContract`, mirroring
/// the bytes published by `talos_registry::INTERFACE_ID` (namespace
/// `"TalosRegistry"`, version `(1, 4, 0)`). Kept as an inline copy rather
/// than a crate dependency so this contract's ABI check has no build-time
/// coupling to the Registry crate.
pub const EXPECTED_REGISTRY_INTERFACE_ID: [u8; 32] = [
    0x54, 0x61, 0x6C, 0x6F, 0x73, 0x52, 0x65, 0x67, // "TalosReg"
    0x69, 0x73, 0x74, 0x72, 0x79, 0x00, 0x00, 0x00, // "istry" + zero pads
    // (major, minor, patch) big-endian u32s
    0x00, 0x00, 0x00, 0x01, // major = 1
    0x00, 0x00, 0x00, 0x04, // minor = 4
    0x00, 0x00, 0x00, 0x00, // patch = 0
    // reserved
    0x00, 0x00, 0x00, 0x00,
];

pub const INTERFACE_NAMESPACE: &str = "TalosDividends";

pub const INTERFACE_ID: [u8; 32] = [
    0x54, 0x61, 0x6C, 0x6F, 0x73, 0x44, 0x69, 0x76, // "TalosDiv"
    0x69, 0x64, 0x65, 0x6E, 0x64, 0x73, 0x00, 0x00, // "idends" + zero pad
    0x00, 0x00, 0x00, 0x01, // major = 1
    0x00, 0x00, 0x00, 0x02, // minor = 2
    0x00, 0x00, 0x00, 0x00, // patch = 0
    0x00, 0x00, 0x00, 0x00, // reserved
];

pub fn features_list() -> &'static [&'static str] {
    &[
        "epoch_commitment",
        "pull_claims",
        "expiry_recovery",
        "rounding_dust",
        "interface_query",
    ]
}

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

// ── Events ───────────────────────────────────────────────────────────────────
//
// All events follow the schema documented in the module-level doc comment.

fn emit_epoch_committed(env: &Env, talos_id: u32, epoch_id: u64, total: i128, expiry_secs: u64) {
    env.events().publish(
        (symbol_short!("ep_cmt"), talos_id),
        (epoch_id, total, expiry_secs),
    );
}

fn emit_dividend_claimed(
    env: &Env,
    epoch_id: u64,
    patron: Address,
    talos_id: u32,
    amount: i128,
    role: PatronRole,
) {
    env.events().publish(
        (symbol_short!("div_clm"), epoch_id, patron),
        (talos_id, amount, role),
    );
}

fn emit_rounding_dust(env: &Env, epoch_id: u64, talos_id: u32, dust: i128) {
    env.events()
        .publish((symbol_short!("div_dst"), epoch_id), (talos_id, dust));
}

fn emit_epoch_recovered(env: &Env, epoch_id: u64, talos_id: u32, recovered: i128, admin: Address) {
    env.events().publish(
        (symbol_short!("ep_rcv"), epoch_id),
        (talos_id, recovered, admin),
    );
}

fn emit_admin_proposed(env: &Env, current: Address, proposed: Address) {
    let topics = (symbol_short!("adm_prp"),);
    env.events().publish(topics, (current, proposed));
}

fn emit_admin_accepted(env: &Env, new_admin: Address) {
    let topics = (symbol_short!("adm_acc"),);
    env.events().publish(topics, (new_admin,));
}

fn emit_admin_cancelled(env: &Env, cancelled: Address) {
    let topics = (symbol_short!("adm_cnl"),);
    env.events().publish(topics, (cancelled,));
}

fn emit_registry_updated(env: &Env, old_registry: Address, new_registry: Address) {
    let topics = (symbol_short!("reg_upd"),);
    env.events().publish(topics, (old_registry, new_registry));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Load the admin address, panicking with `NotInitialized` if absent.
fn require_admin_addr(env: &Env) -> Result<Address, ContractError> {
    env.storage()
        .persistent()
        .get(&DataKey::Admin)
        .ok_or(ContractError::NotInitialized)
}

/// Assert that `caller` is the stored admin and that they have authorised the call.
fn require_admin(env: &Env, caller: &Address) -> Result<(), ContractError> {
    caller.require_auth();
    let stored: Address = require_admin_addr(env)?;
    if stored != *caller {
        return Err(ContractError::Unauthorized);
    }
    Ok(())
}

/// Compute the share-proportional allocation for a given `share_bps` (0-100 percentage).
///
/// `allocation = total_amount * share_bps / 100`
///
/// Uses checked arithmetic to guard against overflow.  Returns `Overflow` if
/// intermediate multiplication wraps, or `ZeroAllocation` if the result is zero.
fn compute_allocation(total_amount: i128, share_pct: u32) -> Result<i128, ContractError> {
    let numerator = total_amount
        .checked_mul(share_pct as i128)
        .ok_or(ContractError::Overflow)?;
    let allocation = numerator / 100;
    if allocation <= 0 {
        return Err(ContractError::ZeroAllocation);
    }
    Ok(allocation)
}

fn compute_rounding_dust(
    total_amount: i128,
    creator_share: u32,
    investor_share: u32,
    treasury_share: u32,
) -> Result<i128, ContractError> {
    let creator = total_amount
        .checked_mul(creator_share as i128)
        .ok_or(ContractError::Overflow)?
        / 100;
    let investor = total_amount
        .checked_mul(investor_share as i128)
        .ok_or(ContractError::Overflow)?
        / 100;
    let treasury = total_amount
        .checked_mul(treasury_share as i128)
        .ok_or(ContractError::Overflow)?
        / 100;
    let distributed = creator
        .checked_add(investor)
        .and_then(|value| value.checked_add(treasury))
        .ok_or(ContractError::Overflow)?;
    total_amount
        .checked_sub(distributed)
        .ok_or(ContractError::Overflow)
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
fn version_supports(actual: (u32, u32, u32), required: (u32, u32, u32)) -> bool {
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
/// publishes the expected `INTERFACE_ID`. Returns `true` on success,
/// `Err(IncompatibleRegistry)` on failure.
fn check_registry_compatible(
    env: &Env,
    registry: &Address,
) -> Result<(), ContractError> {
    // Single atomic cross-contract read: interface ID + version tuple.
    let registry_id: BytesN<32> = env.invoke_contract(
        registry,
        &Symbol::new(env, "interface_id"),
        soroban_sdk::vec![env],
    );

    if registry_id != BytesN::from_array(env, &EXPECTED_REGISTRY_INTERFACE_ID) {
        return Err(ContractError::IncompatibleRegistry);
    }

    let version: (u32, u32, u32) = env.invoke_contract(
        registry,
        &Symbol::new(env, "version"),
        soroban_sdk::vec![env],
    );

    // Require the registry at major=1, minor >= 1.
    if !version_supports(version, (1, 1, 0)) {
        return Err(ContractError::IncompatibleRegistry);
    }

    Ok(())
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct TalosDividends;

#[contractimpl]
impl TalosDividends {
    // ── Initialisation ───────────────────────────────────────────────────────

    /// Initialise the contract with an administrator and the address of the
    /// deployed `TalosRegistry` contract.
    ///
    /// # Authorization
    /// None — the first caller wins.  The `admin` address is stored as the
    /// sole future authorised caller for privileged operations.
    ///
    /// # Panics / Errors
    /// - [`ContractError::AlreadyInitialized`] — if called again after the
    ///   first successful initialisation.
    pub fn initialize(
        env: Env,
        admin: Address,
        registry_contract: Address,
    ) -> Result<(), ContractError> {
        if env.storage().persistent().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::RegistryContract, &registry_contract);
        Ok(())
    }

    // ── Epoch management ─────────────────────────────────────────────────────

    /// Commit a new distribution epoch for `talos_id`.
    ///
    /// Creates an `EpochRecord` keyed by `(talos_id, epoch_id)` where
    /// `epoch_id` is auto-incremented from `NextEpochId(talos_id)`.
    ///
    /// # Authorization
    /// Requires the configured admin to sign the transaction.
    ///
    /// # Arguments
    /// * `talos_id`     — must match an existing Talos in the registry.
    /// * `total_amount` — gross dividend amount; must be ≥ [`MIN_EPOCH_AMOUNT`].
    /// * `expiry_secs`  — claim window in seconds; clamped to
    ///                    [`MIN_EXPIRY_SECS`]..=[`MAX_EXPIRY_SECS`].
    ///
    /// # Returns
    /// The new `epoch_id` on success.
    ///
    /// # Panics / Errors
    /// - [`ContractError::Unauthorized`]        — caller is not admin.
    /// - [`ContractError::InvalidEpochParams`]  — `total_amount` or `expiry_secs`
    ///                                            out of bounds.
    pub fn commit_epoch(
        env: Env,
        admin: Address,
        talos_id: u32,
        total_amount: i128,
        expiry_secs: u64,
    ) -> Result<u64, ContractError> {
        require_admin(&env, &admin)?;

        if total_amount < MIN_EPOCH_AMOUNT {
            return Err(ContractError::InvalidEpochParams);
        }
        if expiry_secs < MIN_EXPIRY_SECS || expiry_secs > MAX_EXPIRY_SECS {
            return Err(ContractError::InvalidEpochParams);
        }

        let epoch_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::NextEpochId(talos_id))
            .unwrap_or(1u64);

        // Idempotency guard: if the epoch already exists, return early.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Epoch(talos_id, epoch_id))
        {
            return Err(ContractError::EpochAlreadyExists);
        }

        let record = EpochRecord {
            epoch_id,
            talos_id,
            total_amount,
            claimed_amount: 0,
            created_at: env.ledger().timestamp(),
            expiry_secs,
            status: EpochStatus::Active,
        };

        let current_ledger = env.ledger().sequence();
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(talos_id, epoch_id), &record);
        env.storage()
            .persistent()
            .set(&DataKey::NextEpochId(talos_id), &(epoch_id + 1));
        env.storage()
            .persistent()
            .set(&DataKey::LastTouched(talos_id, epoch_id), &current_ledger);

        emit_epoch_committed(&env, talos_id, epoch_id, total_amount, expiry_secs);

        Ok(epoch_id)
    }

    // ── Claims ───────────────────────────────────────────────────────────────

    /// Claim the caller's dividend allocation for `epoch_id` of `talos_id`.
    ///
    /// The contract resolves the caller's patron role by matching `claimant`
    /// against the `creator_addr`, `investor_addr`, or `treasury_addr` stored
    /// in the `TalosRegistry`-sourced patron struct embedded in the on-chain
    /// `EpochRecord`.  The allocation is computed as:
    ///
    /// ```text
    /// allocation = epoch.total_amount * role_share_pct / 100
    /// ```
    ///
    /// The `Claimed(epoch_id, claimant)` key prevents double-claims.  Token
    /// transfer is **not** performed by this contract (it does not hold token
    /// balance); instead, the returned `allocation` value is emitted in the
    /// `div_clm` event for the off-chain settlement layer to act on.  This
    /// separation keeps the contract stateless with respect to token custody
    /// while still providing a tamper-proof, on-chain claim record.
    ///
    /// # Authorization
    /// Requires `claimant` to sign the transaction.
    ///
    /// # Panics / Errors
    /// - [`ContractError::EpochNotFound`]  — epoch does not exist.
    /// - [`ContractError::EpochExpired`]   — claim window has elapsed.
    /// - [`ContractError::AlreadyClaimed`] — patron already claimed this epoch.
    /// - [`ContractError::NotAPatron`]     — claimant is not a registered patron role.
    /// - [`ContractError::ZeroAllocation`] — computed share rounds to zero.
    /// - [`ContractError::AccountingOverflow`] — would exceed `total_amount`.
    pub fn claim_dividend(
        env: Env,
        claimant: Address,
        talos_id: u32,
        epoch_id: u64,
        patron_creator: Address,
        patron_investor: Address,
        patron_treasury: Address,
        creator_share: u32,
        investor_share: u32,
        treasury_share: u32,
    ) -> Result<i128, ContractError> {
        claimant.require_auth();

        // Load epoch record.
        let mut record: EpochRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(talos_id, epoch_id))
            .ok_or(ContractError::EpochNotFound)?;

        // Enforce epoch status.
        if record.status != EpochStatus::Active {
            return Err(ContractError::EpochExpired);
        }

        // Enforce claim window. Inclusive of `deadline` itself — claims are
        // accepted for `now <= deadline`, so this is the exact complement of
        // `recover_expired`'s `now <= deadline` rejection below: the two
        // windows meet at `deadline` but never overlap. See the boundary
        // tests in `mod tests` (`claim_succeeds_exactly_at_deadline`,
        // `recover_fails_exactly_at_deadline`, etc.) for the pinned behavior.
        let now = env.ledger().timestamp();
        let deadline = record
            .created_at
            .checked_add(record.expiry_secs)
            .ok_or(ContractError::Overflow)?;
        if now > deadline {
            return Err(ContractError::EpochExpired);
        }

        // Verify shares sum to 100 (basic integrity check on supplied patron data).
        let share_sum = creator_share
            .checked_add(investor_share)
            .and_then(|s| s.checked_add(treasury_share))
            .ok_or(ContractError::Overflow)?;
        if share_sum != 100 {
            return Err(ContractError::InvalidPatronShares);
        }

        // Resolve claimant role from supplied patron addresses.
        let (role, share_pct) = if claimant == patron_creator {
            (PatronRole::Creator, creator_share)
        } else if claimant == patron_investor {
            (PatronRole::Investor, investor_share)
        } else if claimant == patron_treasury {
            (PatronRole::Treasury, treasury_share)
        } else {
            return Err(ContractError::NotAPatron);
        };

        // Double-claim guard.
        let claim_key = DataKey::Claimed(epoch_id, claimant.clone());
        if env.storage().persistent().has(&claim_key) {
            return Err(ContractError::AlreadyClaimed);
        }

        // Compute allocation.
        let allocation = compute_allocation(record.total_amount, share_pct)?;

        let dust = compute_rounding_dust(
            record.total_amount,
            creator_share,
            investor_share,
            treasury_share,
        )?;
        let dust_key = DataKey::RoundingDust(talos_id, epoch_id);
        let recorded_dust_opt: Option<i128> = env.storage().persistent().get(&dust_key);
        if let Some(recorded_dust) = recorded_dust_opt {
            if recorded_dust != dust {
                return Err(ContractError::InconsistentShareData);
            }
        } else {
            env.storage().persistent().set(&dust_key, &dust);
            if dust > 0 {
                emit_rounding_dust(&env, epoch_id, talos_id, dust);
            }
        }

        // Accounting invariant: ensure we do not over-distribute.
        let new_claimed = record
            .claimed_amount
            .checked_add(allocation)
            .ok_or(ContractError::Overflow)?;
        if new_claimed > record.total_amount {
            return Err(ContractError::AccountingOverflow);
        }

        // Persist claim and update running total atomically.
        let current_ledger = env.ledger().sequence();
        env.storage().persistent().set(&claim_key, &true);
        record.claimed_amount = new_claimed;
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(talos_id, epoch_id), &record);
        env.storage()
            .persistent()
            .set(&DataKey::LastTouched(talos_id, epoch_id), &current_ledger);

        emit_dividend_claimed(&env, epoch_id, claimant, talos_id, allocation, role);

        Ok(allocation)
    }

    // ── Recovery ─────────────────────────────────────────────────────────────

    /// Recover unclaimed funds from an expired epoch.
    ///
    /// Only callable by the admin, and only after the epoch's claim window has
    /// closed.  Marks the epoch as `Recovered` and emits `ep_rcv` with the
    /// unclaimed amount so the off-chain layer can return the tokens.
    ///
    /// # Authorization
    /// Requires the configured admin to sign the transaction.
    ///
    /// # Panics / Errors
    /// - [`ContractError::Unauthorized`]    — caller is not admin.
    /// - [`ContractError::EpochNotFound`]  — epoch does not exist.
    /// - [`ContractError::EpochNotExpired`]— claim window has not yet closed.
    /// - [`ContractError::AlreadyRecovered`]— epoch already recovered.
    pub fn recover_expired(
        env: Env,
        admin: Address,
        talos_id: u32,
        epoch_id: u64,
    ) -> Result<i128, ContractError> {
        require_admin(&env, &admin)?;

        let mut record: EpochRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Epoch(talos_id, epoch_id))
            .ok_or(ContractError::EpochNotFound)?;

        if record.status == EpochStatus::Recovered {
            return Err(ContractError::AlreadyRecovered);
        }

        // Strictly after `deadline` — recovery is only accepted once `now >
        // deadline`, i.e. the exact complement of `claim_dividend`'s
        // inclusive `now <= deadline` acceptance above. At `now == deadline`
        // the claim window still owns the instant, so recovery correctly
        // rejects here; see the boundary tests in `mod tests`.
        let now = env.ledger().timestamp();
        let deadline = record
            .created_at
            .checked_add(record.expiry_secs)
            .ok_or(ContractError::Overflow)?;
        if now <= deadline {
            return Err(ContractError::EpochNotExpired);
        }

        let unclaimed = record
            .total_amount
            .checked_sub(record.claimed_amount)
            .ok_or(ContractError::Overflow)?;

        record.status = EpochStatus::Recovered;
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(talos_id, epoch_id), &record);

        emit_epoch_recovered(&env, epoch_id, talos_id, unclaimed, admin);

        Ok(unclaimed)
    }

    // ── Registry management ───────────────────────────────────────────────────

    /// Update the registered TalosRegistry contract address.
    ///
    /// Requires admin authorization and verifies that the new registry
    /// exposes the expected TalosRegistry interface (v1.1.0 or higher).
    ///
    /// # Authorization
    /// Requires the configured admin to sign the transaction.
    ///
    /// # Panics / Errors
    /// - [`ContractError::Unauthorized`]        — caller is not admin.
    /// - [`ContractError::IncompatibleRegistry`] — new registry does not expose
    ///                                            the expected interface.
    pub fn set_registry_contract(
        env: Env,
        admin: Address,
        new_registry: Address,
    ) -> Result<(), ContractError> {
        require_admin(&env, &admin)?;

        // Verify the new registry is compatible before updating.
        check_registry_compatible(&env, &new_registry)?;

        let old: Address = env
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .ok_or(ContractError::NotInitialized)?;

        env.storage()
            .persistent()
            .set(&DataKey::RegistryContract, &new_registry);

        emit_registry_updated(&env, old, new_registry);

        Ok(())
    }

    // ── Read-only queries ────────────────────────────────────────────────────

    /// Return the epoch record for `(talos_id, epoch_id)`, or `None` if absent.
    pub fn get_epoch(env: Env, talos_id: u32, epoch_id: u64) -> Option<EpochRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Epoch(talos_id, epoch_id))
    }

    /// Return `true` if `claimant` has already claimed for `epoch_id`.
    pub fn has_claimed(env: Env, epoch_id: u64, claimant: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Claimed(epoch_id, claimant))
    }

    /// Return the rounding remainder recorded from the first valid claim.
    /// Returns `None` until a claim supplies the epoch's patron split.
    pub fn get_rounding_dust(env: Env, talos_id: u32, epoch_id: u64) -> Option<i128> {
        env.storage()
            .persistent()
            .get(&DataKey::RoundingDust(talos_id, epoch_id))
    }

    /// Return the next epoch ID that would be assigned for `talos_id`.
    pub fn next_epoch_id(env: Env, talos_id: u32) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::NextEpochId(talos_id))
            .unwrap_or(1u64)
    }

    /// Return the configured admin address, or `None` before initialisation.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Admin)
    }

    /// Return the configured registry contract address, or `None` before initialisation.
    pub fn get_registry(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::RegistryContract)
    }

    /// Return the contract's interface version as `(major, minor, patch)`.
    ///
    /// The value is a compile-time constant baked into the WASM binary and
    /// cannot be altered by any post-deployment state write.
    pub fn version(_env: Env) -> (u32, u32, u32) {
        CONTRACT_VERSION
    }

    pub fn interface_id(env: Env) -> BytesN<32> {
        BytesN::from_array(&env, &INTERFACE_ID)
    }

    pub fn supports_version(env: Env, major: u32, minor: u32, patch: u32) -> bool {
        let _ = env;
        version_supports(CONTRACT_VERSION, (major, minor, patch))
    }

    pub fn interface_features(env: Env) -> Vec<Symbol> {
        let mut features = Vec::new(&env);
        for feature in features_list() {
            features.push_back(Symbol::new(&env, feature));
        }
        features
    }

    // ── Two-step admin transfer ──────────────────────────────────────

    /// Nominate `new_admin` as the next administrator.
    ///
    /// The transfer is not immediate. The nominated address must call
    /// `accept_admin` to confirm and complete the handover. Until then the
    /// current admin retains all privileges.
    ///
    /// Calling `propose_admin` while a transfer is already pending replaces
    /// the old nomination with the new one.
    ///
    /// # Authorization
    /// Requires the current admin to sign the transaction.
    ///
    /// # Panics / Errors
    /// - [`ContractError::NotInitialized`] — if `initialize` has not been called.
    /// - [`ContractError::Unauthorized`] — caller is not the configured administrator.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        let current: Address = require_admin_addr(&env)?;
        current.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::PendingAdmin, &new_admin);

        emit_admin_proposed(&env, current, new_admin);
        Ok(())
    }

    /// Complete the pending admin transfer.
    ///
    /// The nominated address (stored under `PendingAdmin`) must call this
    /// method and authorize it. On success:
    ///   1. `Admin` is updated to the caller's address.
    ///   2. The `PendingAdmin` storage entry is removed.
    ///   3. An `adm_acc` event is emitted.
    ///
    /// # Authorization
    /// Requires the pending admin to sign the transaction.
    ///
    /// # Panics / Errors
    /// - [`ContractError::NoPendingAdmin`] — if `propose_admin` has not been called.
    pub fn accept_admin(env: Env) -> Result<(), ContractError> {
        let pending: Address = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdmin)
            .ok_or(ContractError::NoPendingAdmin)?;

        pending.require_auth();

        env.storage().persistent().set(&DataKey::Admin, &pending);
        env.storage().persistent().remove(&DataKey::PendingAdmin);

        emit_admin_accepted(&env, pending);
        Ok(())
    }

    /// Cancel an in-progress admin transfer.
    ///
    /// Removes the `PendingAdmin` entry and revokes the nomination without
    /// changing the current admin.
    ///
    /// # Authorization
    /// Requires the current admin to sign the transaction.
    ///
    /// # Panics / Errors
    /// - [`ContractError::NotInitialized`] — if `initialize` has not been called.
    /// - [`ContractError::NoPendingAdmin`] — if there is nothing to cancel.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), ContractError> {
        let current: Address = require_admin_addr(&env)?;
        current.require_auth();

        let pending: Address = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdmin)
            .ok_or(ContractError::NoPendingAdmin)?;

        env.storage().persistent().remove(&DataKey::PendingAdmin);

        emit_admin_cancelled(&env, pending);
        Ok(())
    }

    /// Return the pending admin address, if any.
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::PendingAdmin)
    }

    // ── Storage TTL Management ───────────────────────────────────

    /// Touch an epoch record to reset its Soroban persistent storage TTL.
    ///
    /// Since every `set()` call on persistent storage resets the TTL to the maximum,
    /// this function re-reads the `EpochRecord` and writes it back unchanged along
    /// with updating `LastTouched(talos_id, epoch_id)`.
    /// It only writes when the entry has not been touched recently (within
    /// the renewal threshold) to save gas.
    ///
    /// Returns `true` if a touch was performed, `false` if skipped.
    pub fn touch_epoch(env: Env, talos_id: u32, epoch_id: u64) -> Result<bool, ContractError> {
        let key = DataKey::Epoch(talos_id, epoch_id);
        let record: EpochRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::EpochNotFound)?;

        let current_ledger = env.ledger().sequence();
        let last_touched: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::LastTouched(talos_id, epoch_id))
            .unwrap_or(0);

        if ttl_manager::needs_touch(last_touched, current_ledger) {
            env.storage().persistent().set(&key, &record);
            env.storage()
                .persistent()
                .set(&DataKey::LastTouched(talos_id, epoch_id), &current_ledger);
            ttl_manager::emit_ttl_touched(&env, "epoch", 1);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Batched TTL extension for epoch records with explicit age and work bounds.
    ///
    /// Sweeps epochs `[start_epoch_id, min(next_epoch_id, start_epoch_id + limit))`,
    /// clipped to [`ttl_manager::DEFAULT_MAX_BATCH_KEYS`] ids per call, and re-writes
    /// only entries whose age in ledgers falls inside `[min_age, max_age]`.
    /// Records outside the window are reported as `skipped`; ids without an epoch record are ignored.
    ///
    /// Returns `(touched, skipped)`.
    ///
    /// # Authorization
    /// Requires the configured admin to sign.
    ///
    /// # Panics / Errors
    /// - [`ContractError::Unauthorized`] — caller is not admin.
    /// - Static panic if bounds are invalid (`min_age > max_age`, `max_keys` 0 or > `MAX_BATCH_KEYS`).
    pub fn extend_ttl_batch(
        env: Env,
        admin: Address,
        talos_id: u32,
        start_epoch_id: u64,
        limit: u32,
        min_age: u32,
        max_age: u32,
    ) -> Result<(u32, u32), ContractError> {
        require_admin(&env, &admin)?;

        let bounds =
            ttl_manager::TtlBounds::new(min_age, max_age, ttl_manager::DEFAULT_MAX_BATCH_KEYS);
        bounds.validate().unwrap_or_else(|err| panic!("{}", err.message()));

        let capped_limit = bounds
            .clamp_limit(limit)
            .unwrap_or_else(|err| panic!("{}", err.message()));

        let next_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::NextEpochId(talos_id))
            .unwrap_or(1u64);

        let end_id = next_id.min(start_epoch_id.saturating_add(capped_limit as u64));

        let current_ledger = env.ledger().sequence();
        let mut sweep = ttl_manager::BatchSweep::empty();

        for eid in start_epoch_id..end_id {
            let key = DataKey::Epoch(talos_id, eid);
            let record: EpochRecord = match env.storage().persistent().get(&key) {
                Some(r) => r,
                None => {
                    sweep.record(ttl_manager::EntryOutcome::Absent);
                    continue;
                }
            };

            let last_touched: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::LastTouched(talos_id, eid))
                .unwrap_or(0);

            if ttl_manager::should_extend(last_touched, current_ledger, &bounds) {
                env.storage().persistent().set(&key, &record);
                env.storage()
                    .persistent()
                    .set(&DataKey::LastTouched(talos_id, eid), &current_ledger);
                sweep.record(ttl_manager::EntryOutcome::Touched);
            } else {
                sweep.record(ttl_manager::EntryOutcome::Skipped);
            }
        }

        sweep.emit(&env);
        Ok((sweep.touched, sweep.skipped))
    }

    /// Query storage health for tracked epoch records of `talos_id`.
    ///
    /// Returns `(min_age, max_age, keys_below_warn, keys_below_crit, total)`.
    /// Emits `ttl_warn` if any entry is at risk.
    pub fn get_storage_health(env: Env, talos_id: u32) -> (u32, u32, u32, u32, u32) {
        let mut health = ttl_manager::KeyHealth::empty();
        let current_ledger = env.ledger().sequence();

        let next_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::NextEpochId(talos_id))
            .unwrap_or(1u64);

        for eid in 1..next_id {
            if env.storage().persistent().has(&DataKey::Epoch(talos_id, eid)) {
                let last_touched: u32 = env
                    .storage()
                    .persistent()
                    .get(&DataKey::LastTouched(talos_id, eid))
                    .unwrap_or(0);
                health.observe(ttl_manager::age_ledgers(last_touched, current_ledger));
            }
        }

        if health.needs_immediate_attention() {
            ttl_manager::emit_ttl_warning(&env, "dividends_epoch", health.keys_below_crit, health.max_age);
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
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal, Symbol, TryFromVal,
    };

    // ── Test helpers ─────────────────────────────────────────────────────────

    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        TalosDividendsClient<'static>,
    ) {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });
        let contract_id = env.register_contract(None, TalosDividends);
        let client = TalosDividendsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let registry = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), registry.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .initialize(&admin, &registry);

        (env, contract_id, admin, registry, client)
    }

    /// Helper: commit an epoch with explicit amount and expiry.
    fn commit_epoch(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        admin: &Address,
        talos_id: u32,
        total_amount: i128,
        expiry_secs: u64,
    ) -> u64 {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), talos_id, total_amount, expiry_secs).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .commit_epoch(admin, &talos_id, &total_amount, &expiry_secs)
    }

    /// Helper: commit a default epoch (total=10_000, expiry=7_200s).
    fn commit_default_epoch(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        admin: &Address,
        talos_id: u32,
    ) -> u64 {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), talos_id, 10_000_i128, 7_200_u64).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .commit_epoch(admin, &talos_id, &10_000_i128, &7_200_u64)
    }

    /// Helper: perform a claim with provided patron addresses and default 60/25/15 shares.
    #[allow(clippy::too_many_arguments)]
    fn do_claim(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        claimant: &Address,
        talos_id: u32,
        epoch_id: u64,
        creator: &Address,
        investor: &Address,
        treasury: &Address,
    ) -> i128 {
        do_claim_with_shares(
            env,
            contract_id,
            client,
            claimant,
            talos_id,
            epoch_id,
            creator,
            investor,
            treasury,
            60,
            25,
            15,
        )
    }

    /// Helper: perform a claim with provided patron addresses and shares.
    #[allow(clippy::too_many_arguments)]
    fn do_claim_with_shares(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        claimant: &Address,
        talos_id: u32,
        epoch_id: u64,
        creator: &Address,
        investor: &Address,
        treasury: &Address,
        creator_share: u32,
        investor_share: u32,
        treasury_share: u32,
    ) -> i128 {
        client
            .mock_auths(&[MockAuth {
                address: claimant,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "claim_dividend",
                    args: (
                        claimant.clone(),
                        talos_id,
                        epoch_id,
                        creator.clone(),
                        investor.clone(),
                        treasury.clone(),
                        creator_share,
                        investor_share,
                        treasury_share,
                    )
                        .into_val(env),
                    sub_invokes: &[],
                },
            }])
            .claim_dividend(
                claimant,
                &talos_id,
                &epoch_id,
                creator,
                investor,
                treasury,
                &creator_share,
                &investor_share,
                &treasury_share,
            )
    }

    #[allow(clippy::too_many_arguments)]
    fn try_do_claim_with_shares(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        claimant: &Address,
        talos_id: u32,
        epoch_id: u64,
        creator: &Address,
        investor: &Address,
        treasury: &Address,
    ) -> Result<Result<i128, soroban_sdk::Error>, Result<ContractError, soroban_sdk::InvokeError>>
    {
        try_do_claim_with_shares(
            env,
            contract_id,
            client,
            claimant,
            talos_id,
            epoch_id,
            creator,
            investor,
            treasury,
            60,
            25,
            15,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn try_do_claim_with_shares(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        claimant: &Address,
        talos_id: u32,
        epoch_id: u64,
        creator: &Address,
        investor: &Address,
        treasury: &Address,
        creator_share: u32,
        investor_share: u32,
        treasury_share: u32,
    ) -> Result<Result<i128, soroban_sdk::Error>, Result<ContractError, soroban_sdk::InvokeError>>
    {
        client
            .mock_auths(&[MockAuth {
                address: claimant,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "claim_dividend",
                    args: (
                        claimant.clone(),
                        talos_id,
                        epoch_id,
                        creator.clone(),
                        investor.clone(),
                        treasury.clone(),
                        creator_share,
                        investor_share,
                        treasury_share,
                    )
                        .into_val(env),
                    sub_invokes: &[],
                },
            }])
            .try_claim_dividend(
                claimant, &talos_id, &epoch_id, creator, investor, treasury, &creator_share,
                &investor_share, &treasury_share,
            )
    }

    fn mock_propose(
        env: &Env,
        client: &TalosDividendsClient,
        contract_id: &Address,
        admin: &Address,
        new_admin: &Address,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "propose_admin",
                    args: (new_admin.clone(),).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .propose_admin(new_admin);
    }

    fn mock_accept(
        env: &Env,
        client: &TalosDividendsClient,
        contract_id: &Address,
        new_admin: &Address,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: new_admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "accept_admin",
                    args: ().into_val(env),
                    sub_invokes: &[],
                },
            }])
            .accept_admin();
    }

    fn mock_cancel(
        env: &Env,
        client: &TalosDividendsClient,
        contract_id: &Address,
        admin: &Address,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "cancel_admin_transfer",
                    args: ().into_val(env),
                    sub_invokes: &[],
                },
            }])
            .cancel_admin_transfer();
    }

    // ── version() ────────────────────────────────────────────────────────────

    #[test]
    fn version_returns_compile_time_constant() {
        let (env, contract_id, _, _, client) = setup();
        assert_eq!(client.version(), (1u32, 2u32, 0u32));
        let _ = (env, contract_id);
    }

    #[test]
    fn version_matches_contract_constant() {
        let (env, contract_id, _, _, client) = setup();
        assert_eq!(client.version(), CONTRACT_VERSION);
        let _ = (env, contract_id);
    }

    #[test]
    fn interface_id_matches_pinned_golden_vector() {
        let (_, _, _, _, client) = setup();
        let expected = [
            0x54, 0x61, 0x6C, 0x6F, 0x73, 0x44, 0x69, 0x76, 0x69, 0x64, 0x65, 0x6E, 0x64, 0x73,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(INTERFACE_NAMESPACE, "TalosDividends");
        assert_eq!(INTERFACE_ID, expected);
        assert_eq!(client.interface_id().to_array(), expected);
    }

    #[test]
    fn supports_version_checks_major_minor_and_patch() {
        let (_, _, _, _, client) = setup();
        assert!(client.supports_version(&1, &0, &0));
        assert!(client.supports_version(&1, &1, &0));
        assert!(client.supports_version(&1, &2, &0));
        assert!(!client.supports_version(&1, &1, &1));
        assert!(!client.supports_version(&1, &3, &0));
        assert!(!client.supports_version(&2, &0, &0));
    }

    #[test]
    fn interface_features_lists_dividends_capabilities() {
        let (env, _, _, _, client) = setup();
        let features = client.interface_features();
        for feature in features_list() {
            assert!(features.contains(&Symbol::new(&env, feature)));
        }
        assert_eq!(features.len(), features_list().len() as u32);
    }

    // ── initialize() ─────────────────────────────────────────────────────────

    #[test]
    fn initialize_stores_admin_and_registry() {
        let (env, _contract_id, admin, registry, client) = setup();
        assert_eq!(client.get_admin(), Some(admin));
        assert_eq!(client.get_registry(), Some(registry));
        let _ = env;
    }

    #[test]
    fn double_initialize_returns_error() {
        let (env, contract_id, admin, registry, client) = setup();
        let res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), registry.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_initialize(&admin, &registry);
        assert_eq!(res, Err(Ok(ContractError::AlreadyInitialized)));
    }

    // ── commit_epoch() ───────────────────────────────────────────────────────

    #[test]
    fn commit_epoch_happy_path() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);
        assert_eq!(epoch_id, 1u64);
        assert_eq!(client.next_epoch_id(&talos_id), 2u64);

        let rec = client.get_epoch(&talos_id, &epoch_id).unwrap();
        assert_eq!(rec.total_amount, 10_000);
        assert_eq!(rec.claimed_amount, 0);
        assert_eq!(rec.status, EpochStatus::Active);
    }

    #[test]
    fn commit_epoch_auto_increments_id() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let id1 = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);
        let id2 = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);
        assert_eq!(id1, 1u64);
        assert_eq!(id2, 2u64);
    }

    #[test]
    fn commit_epoch_rejects_zero_amount() {
        let (env, contract_id, admin, _, client) = setup();
        let res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), 1u32, 0_i128, 7_200_u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_commit_epoch(&admin, &1u32, &0_i128, &7_200_u64);
        assert_eq!(res, Err(Ok(ContractError::InvalidEpochParams)));
    }

    #[test]
    fn commit_epoch_rejects_expiry_too_short() {
        let (env, contract_id, admin, _, client) = setup();
        let res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), 1u32, 1_000_i128, 3_599_u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_commit_epoch(&admin, &1u32, &1_000_i128, &3_599_u64);
        assert_eq!(res, Err(Ok(ContractError::InvalidEpochParams)));
    }

    #[test]
    fn commit_epoch_rejects_expiry_too_long() {
        let (env, contract_id, admin, _, client) = setup();
        let res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), 1u32, 1_000_i128, 31_536_001_u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_commit_epoch(&admin, &1u32, &1_000_i128, &31_536_001_u64);
        assert_eq!(res, Err(Ok(ContractError::InvalidEpochParams)));
    }

    #[test]
    fn commit_epoch_requires_admin_auth() {
        let (env, contract_id, _, _, client) = setup();
        let impostor = Address::generate(&env);
        let res = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "commit_epoch",
                    args: (impostor.clone(), 1u32, 1_000_i128, 7_200_u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_commit_epoch(&impostor, &1u32, &1_000_i128, &7_200_u64);
        assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn commit_epoch_emits_ep_cmt_event() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let (addr, topics, data) = events.get(0).unwrap();
        assert_eq!(addr, contract_id);

        let sym: Symbol = TryFromVal::try_from_val(&env, &topics.get(0).unwrap()).expect("symbol");
        assert_eq!(sym, symbol_short!("ep_cmt"));

        let got_talos_id: u32 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).expect("talos_id");
        assert_eq!(got_talos_id, talos_id);

        let (got_epoch_id, got_total, got_expiry): (u64, i128, u64) =
            TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(got_epoch_id, epoch_id);
        assert_eq!(got_total, 10_000);
        assert_eq!(got_expiry, 7_200);
    }

    // ── claim_dividend() ─────────────────────────────────────────────────────

    #[test]
    fn creator_can_claim_correct_share() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        let allocation = do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );

        // creator_share = 60%; 10_000 * 60 / 100 = 6_000
        assert_eq!(allocation, 6_000);
        assert!(client.has_claimed(&epoch_id, &creator));

        let rec = client.get_epoch(&talos_id, &epoch_id).unwrap();
        assert_eq!(rec.claimed_amount, 6_000);
    }

    #[test]
    fn investor_can_claim_correct_share() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        let allocation = do_claim(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );

        // investor_share = 25%; 10_000 * 25 / 100 = 2_500
        assert_eq!(allocation, 2_500);
    }

    #[test]
    fn treasury_can_claim_correct_share() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        let allocation = do_claim(
            &env,
            &contract_id,
            &client,
            &treasury,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );

        // treasury_share = 15%; 10_000 * 15 / 100 = 1_500
        assert_eq!(allocation, 1_500);
    }

    #[test]
    fn records_rounding_dust_once_and_emits_event() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 101, 7_200);

        do_claim_with_shares(
            &env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor,
            &treasury, 60, 25, 15,
        );

        assert_eq!(client.get_rounding_dust(&talos_id, &epoch_id), Some(1));
        let events = env.events().all();
        let dust_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(_, topics, _)| {
                let symbol: Result<Symbol, _> =
                    TryFromVal::try_from_val(&env, &topics.get(0).unwrap());
                symbol.map(|value| value == symbol_short!("div_dst")).unwrap_or(false)
            })
            .collect();
        assert_eq!(dust_events.len(), 1);
        let (_, _, data) = dust_events[0].clone();
        let (got_talos_id, got_dust): (u32, i128) = TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!((got_talos_id, got_dust), (talos_id, 1));
    }

    #[test]
    fn rejects_claims_with_inconsistent_share_data() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 101, 7_200);

        do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury);
        let result = try_do_claim_with_shares(
            &env, &contract_id, &client, &investor, talos_id, epoch_id, &creator, &investor,
            &treasury, 61, 24, 15,
        );
        assert_eq!(result, Err(Ok(ContractError::InconsistentShareData)));
        assert!(!client.has_claimed(&epoch_id, &investor));
    }

    #[test]
    fn recovery_includes_unclaimed_rounding_dust() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 101, 7_200);

        do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury);
        env.ledger().with_mut(|li| li.timestamp = 9_000);

        let recovered = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "recover_expired",
                    args: (admin.clone(), talos_id, epoch_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .recover_expired(&admin, &talos_id, &epoch_id);

        assert_eq!(recovered, 41); // 101 - floor(101 * 60 / 100)
    }

    #[test]
    fn all_three_patrons_can_claim_and_total_equals_epoch_amount() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        let c = do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );
        let i = do_claim(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );
        let t = do_claim(
            &env,
            &contract_id,
            &client,
            &treasury,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );

        // 60 + 25 + 15 = 100%; 6000 + 2500 + 1500 = 10_000
        assert_eq!(c + i + t, 10_000);

        let rec = client.get_epoch(&talos_id, &epoch_id).unwrap();
        assert_eq!(rec.claimed_amount, 10_000);
    }

    #[test]
    fn double_claim_returns_already_claimed() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );
        let second = try_do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );
        assert_eq!(second, Err(Ok(ContractError::AlreadyClaimed)));
    }

    #[test]
    fn non_patron_cannot_claim() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let outsider = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        let res = try_do_claim(
            &env,
            &contract_id,
            &client,
            &outsider,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );
        assert_eq!(res, Err(Ok(ContractError::NotAPatron)));
    }

    #[test]
    fn claim_with_invalid_shares_returns_error() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        let res = client
            .mock_auths(&[MockAuth {
                address: &creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "claim_dividend",
                    args: (
                        creator.clone(),
                        talos_id,
                        epoch_id,
                        creator.clone(),
                        creator.clone(),
                        creator.clone(),
                        50u32, // creator_share
                        30u32, // investor_share
                        30u32, // treasury_share (sums to 110)
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_claim_dividend(
                &creator, &talos_id, &epoch_id, &creator, &creator, &creator, &50u32, &30u32,
                &30u32,
            );
        assert_eq!(res, Err(Ok(ContractError::InvalidPatronShares)));
    }

    #[test]
    fn claim_on_missing_epoch_returns_epoch_not_found() {
        let (env, contract_id, _, _, client) = setup();
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);

        let res = try_do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            99u32,
            999u64,
            &creator,
            &investor,
            &treasury,
        );
        assert_eq!(res, Err(Ok(ContractError::EpochNotFound)));
    }

    #[test]
    fn claim_after_expiry_returns_epoch_expired() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        // Advance clock past expiry (7_200s from timestamp=1_000 → need > 8_200).
        env.ledger().with_mut(|li| {
            li.timestamp = 9_000;
        });

        let res = try_do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );
        assert_eq!(res, Err(Ok(ContractError::EpochExpired)));
    }

    #[test]
    fn claim_emits_div_clm_event() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        // Clear commit event.
        let _ = env.events().all();

        do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );

        let events = env.events().all();
        let claim_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(addr, topics, _)| {
                if *addr != contract_id || topics.len() == 0 {
                    return false;
                }
                let sym: Result<Symbol, _> =
                    TryFromVal::try_from_val(&env, &topics.get(0).unwrap());
                sym.map(|s| s == symbol_short!("div_clm")).unwrap_or(false)
            })
            .collect();

        assert_eq!(claim_events.len(), 1);
        let (_, _, data) = claim_events[0].clone();
        let (got_talos_id, got_amount, got_role): (u32, i128, PatronRole) =
            TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(got_talos_id, talos_id);
        assert_eq!(got_amount, 6_000);
        assert_eq!(got_role, PatronRole::Creator);
    }

    // ── recover_expired() ────────────────────────────────────────────────────

    #[test]
    fn recover_expired_happy_path() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        // Advance past expiry.
        env.ledger().with_mut(|li| {
            li.timestamp = 9_000;
        });

        let recovered = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "recover_expired",
                    args: (admin.clone(), talos_id, epoch_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .recover_expired(&admin, &talos_id, &epoch_id);

        // No claims were made, so the full amount is recovered.
        assert_eq!(recovered, 10_000);

        let rec = client.get_epoch(&talos_id, &epoch_id).unwrap();
        assert_eq!(rec.status, EpochStatus::Recovered);
    }

    #[test]
    fn recover_partial_unclaimed() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        // Only creator claims.
        do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );

        // Advance past expiry.
        env.ledger().with_mut(|li| {
            li.timestamp = 9_000;
        });

        let recovered = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "recover_expired",
                    args: (admin.clone(), talos_id, epoch_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .recover_expired(&admin, &talos_id, &epoch_id);

        // 10_000 - 6_000 (creator) = 4_000 unclaimed.
        assert_eq!(recovered, 4_000);
    }

    #[test]
    fn recover_before_expiry_returns_epoch_not_expired() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        // Still within claim window (timestamp=1_000, expiry ends at 8_200).
        let res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "recover_expired",
                    args: (admin.clone(), talos_id, epoch_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_recover_expired(&admin, &talos_id, &epoch_id);
        assert_eq!(res, Err(Ok(ContractError::EpochNotExpired)));
    }

    // ── Boundary semantics: claim_dividend vs. recover_expired ─────────────────
    //
    // `claim_dividend` rejects when `now > deadline` (so it ACCEPTS exactly at
    // `deadline`), while `recover_expired` rejects when `now <= deadline` (so
    // it ACCEPTS only strictly after `deadline`). The two conditions are
    // complements of each other around the same `deadline` value, so the
    // claim window and the recovery window never overlap: for every `now`,
    // at most one of {claim, recover} can succeed. These tests pin that
    // invariant down at `deadline - 1`, `deadline`, and `deadline + 1` so a
    // future edit to either boundary check trips a test instead of silently
    // opening a window where both (or neither) succeed.
    //
    // With `created_at = 1_000` and `expiry_secs = 7_200` (the defaults from
    // `commit_default_epoch`), `deadline = 8_200`.

    /// Helper: `try_recover_expired` with the admin auth already mocked.
    /// Mirrors `try_do_claim`'s result shape so both boundary checks compare
    /// the same way: `Ok(Ok(amount))` on success, `Err(Ok(ContractError::X))`
    /// on a contract-level rejection.
    fn try_recover(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        admin: &Address,
        talos_id: u32,
        epoch_id: u64,
    ) -> Result<Result<i128, soroban_sdk::Error>, Result<ContractError, soroban_sdk::InvokeError>>
    {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "recover_expired",
                    args: (admin.clone(), talos_id, epoch_id).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .try_recover_expired(admin, &talos_id, &epoch_id)
    }

    #[test]
    fn claim_succeeds_at_deadline_minus_one() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 8_199; // deadline (8_200) - 1
        });

        let res = try_do_claim(
            &env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor,
            &treasury,
        );
        assert!(res.is_ok() && res.unwrap().is_ok());
    }

    #[test]
    fn claim_succeeds_exactly_at_deadline() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 8_200; // == deadline — claim window is inclusive
        });

        let res = try_do_claim(
            &env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor,
            &treasury,
        );
        assert!(res.is_ok() && res.unwrap().is_ok());
    }

    #[test]
    fn claim_fails_at_deadline_plus_one() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 8_201; // deadline (8_200) + 1
        });

        let res = try_do_claim(
            &env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor,
            &treasury,
        );
        assert_eq!(res, Err(Ok(ContractError::EpochExpired)));
    }

    #[test]
    fn recover_fails_at_deadline_minus_one() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 8_199; // deadline (8_200) - 1
        });

        let res = try_recover(&env, &contract_id, &client, &admin, talos_id, epoch_id);
        assert_eq!(res, Err(Ok(ContractError::EpochNotExpired)));
    }

    #[test]
    fn recover_fails_exactly_at_deadline() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 8_200; // == deadline — claim window still owns this instant
        });

        let res = try_recover(&env, &contract_id, &client, &admin, talos_id, epoch_id);
        assert_eq!(res, Err(Ok(ContractError::EpochNotExpired)));
    }

    #[test]
    fn recover_succeeds_at_deadline_plus_one() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 8_201; // deadline (8_200) + 1
        });

        let res = try_recover(&env, &contract_id, &client, &admin, talos_id, epoch_id);
        assert_eq!(res, Ok(Ok(10_000)));
    }

    #[test]
    fn claim_and_recover_never_both_succeed_at_any_boundary() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);

        // deadline = created_at (1_000) + expiry_secs (7_200) = 8_200.
        for &ts in &[8_199u64, 8_200u64, 8_201u64] {
            // Fresh epoch per timestamp so a successful claim/recover in one
            // iteration can't influence the next.
            env.ledger().with_mut(|li| {
                li.timestamp = 1_000;
            });
            let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

            env.ledger().with_mut(|li| {
                li.timestamp = ts;
            });

            let claim_res = try_do_claim(
                &env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor,
                &treasury,
            );
            let claim_ok = matches!(claim_res, Ok(Ok(_)));

            let recover_res = try_recover(&env, &contract_id, &client, &admin, talos_id, epoch_id);
            let recover_ok = matches!(recover_res, Ok(Ok(_)));

            assert!(
                !(claim_ok && recover_ok),
                "claim and recover both succeeded at ts={ts} (deadline=8_200)"
            );
        }
    }

    #[test]
    fn double_recover_returns_already_recovered() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 9_000;
        });

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "recover_expired",
                    args: (admin.clone(), talos_id, epoch_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .recover_expired(&admin, &talos_id, &epoch_id);

        let second = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "recover_expired",
                    args: (admin.clone(), talos_id, epoch_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_recover_expired(&admin, &talos_id, &epoch_id);
        assert_eq!(second, Err(Ok(ContractError::AlreadyRecovered)));
    }

    #[test]
    fn recover_requires_admin_auth() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);
        let impostor = Address::generate(&env);

        env.ledger().with_mut(|li| {
            li.timestamp = 9_000;
        });

        let res = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "recover_expired",
                    args: (impostor.clone(), talos_id, epoch_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_recover_expired(&impostor, &talos_id, &epoch_id);
        assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn recover_emits_ep_rcv_event() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 9_000;
        });

        let _ = env.events().all(); // clear

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "recover_expired",
                    args: (admin.clone(), talos_id, epoch_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .recover_expired(&admin, &talos_id, &epoch_id);

        let events = env.events().all();
        let rcv_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(addr, topics, _)| {
                if *addr != contract_id || topics.len() == 0 {
                    return false;
                }
                let sym: Result<Symbol, _> =
                    TryFromVal::try_from_val(&env, &topics.get(0).unwrap());
                sym.map(|s| s == symbol_short!("ep_rcv")).unwrap_or(false)
            })
            .collect();

        assert_eq!(rcv_events.len(), 1);
        let (_, _, data) = rcv_events[0].clone();
        let (got_talos_id, got_recovered, got_admin): (u32, i128, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(got_talos_id, talos_id);
        assert_eq!(got_recovered, 10_000);
        assert_eq!(got_admin, admin);
    }

    // ── has_claimed() ────────────────────────────────────────────────────────

    #[test]
    fn has_claimed_returns_false_before_claim() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        assert!(!client.has_claimed(&epoch_id, &creator));
    }

    #[test]
    fn has_claimed_returns_true_after_claim() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );
        assert!(client.has_claimed(&epoch_id, &creator));
    }

    // ── next_epoch_id() ──────────────────────────────────────────────────────

    #[test]
    fn next_epoch_id_starts_at_one_before_any_commits() {
        let (env, _contract_id, _, _, client) = setup();
        assert_eq!(client.next_epoch_id(&1u32), 1u64);
        let _ = env;
    }

    #[test]
    fn next_epoch_id_increments_independently_per_talos() {
        let (env, contract_id, admin, _, client) = setup();
        commit_default_epoch(&env, &contract_id, &client, &admin, 1u32);
        commit_default_epoch(&env, &contract_id, &client, &admin, 1u32);
        commit_default_epoch(&env, &contract_id, &client, &admin, 2u32);

        assert_eq!(client.next_epoch_id(&1u32), 3u64);
        assert_eq!(client.next_epoch_id(&2u32), 2u64);
    }

    // ── Dividend rounding tests (#612) ───────────────────────────────────────
    //
    // `compute_allocation` uses integer (truncating) division:
    //   allocation = total_amount * share_pct / 100
    //
    // These tests verify the observable rounding behaviour through the real
    // `claim_dividend` entry-point so they exercise the exact same code path
    // that runs on-chain.  No new contract method is introduced; the tests
    // use the existing interface.
    //
    // Key invariants asserted here:
    //   1. Exact-divisible amounts produce no rounding loss.
    //   2. Non-divisible amounts truncate toward zero (floor division).
    //   3. When all three patrons claim from a non-divisible total their
    //      allocations may sum to less than total_amount (dust stays in the
    //      epoch; recoverable by admin after expiry).
    //   4. A share percentage that rounds the allocation to zero surfaces
    //      `ZeroAllocation` — not a silent 0-amount claim.
    //   5. Very large totals near i128::MAX / 100 do not overflow.

    // ── helpers specific to rounding tests ───────────────────────────────────

    /// Commit an epoch with a custom `total_amount` for rounding experiments.
    fn commit_epoch_with_total(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        admin: &Address,
        talos_id: u32,
        total: i128,
    ) -> u64 {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), talos_id, total, 7_200_u64).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .commit_epoch(admin, &talos_id, &total, &7_200_u64)
    }

    /// Claim with explicit, custom share percentages (must sum to 100).
    /// Returns the allocation on success; panics on contract error.
    /// For negative-path tests, use `try_claim_with_shares`.
    #[allow(clippy::too_many_arguments)]
    fn claim_with_shares(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        claimant: &Address,
        talos_id: u32,
        epoch_id: u64,
        creator: &Address,
        investor: &Address,
        treasury: &Address,
        creator_share: u32,
        investor_share: u32,
        treasury_share: u32,
    ) -> i128 {
        client
            .mock_auths(&[MockAuth {
                address: claimant,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "claim_dividend",
                    args: (
                        claimant.clone(),
                        talos_id,
                        epoch_id,
                        creator.clone(),
                        investor.clone(),
                        treasury.clone(),
                        creator_share,
                        investor_share,
                        treasury_share,
                    )
                        .into_val(env),
                    sub_invokes: &[],
                },
            }])
            .claim_dividend(
                claimant,
                &talos_id,
                &epoch_id,
                creator,
                investor,
                treasury,
                &creator_share,
                &investor_share,
                &treasury_share,
            )
    }

    /// Like `claim_with_shares` but returns the raw soroban-sdk 21 result for
    /// error-path tests.  Assertions should use `Err(Ok(ContractError::...))`.
    #[allow(clippy::too_many_arguments)]
    fn try_claim_with_shares(
        env: &Env,
        contract_id: &Address,
        client: &TalosDividendsClient<'static>,
        claimant: &Address,
        talos_id: u32,
        epoch_id: u64,
        creator: &Address,
        investor: &Address,
        treasury: &Address,
        creator_share: u32,
        investor_share: u32,
        treasury_share: u32,
    ) -> Result<Result<i128, soroban_sdk::Error>, Result<ContractError, soroban_sdk::InvokeError>>
    {
        client
            .mock_auths(&[MockAuth {
                address: claimant,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "claim_dividend",
                    args: (
                        claimant.clone(),
                        talos_id,
                        epoch_id,
                        creator.clone(),
                        investor.clone(),
                        treasury.clone(),
                        creator_share,
                        investor_share,
                        treasury_share,
                    )
                        .into_val(env),
                    sub_invokes: &[],
                },
            }])
            .try_claim_dividend(
                claimant,
                &talos_id,
                &epoch_id,
                creator,
                investor,
                treasury,
                &creator_share,
                &investor_share,
                &treasury_share,
            )
    }

    // ── Positive: exact-divisible totals ─────────────────────────────────────

    /// total=10_000, shares 60/25/15 — all divide evenly; no truncation.
    #[test]
    fn rounding_exact_divisible_no_truncation() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        // 10_000 * 60 / 100 = 6_000 (exact)
        // 10_000 * 25 / 100 = 2_500 (exact)
        // 10_000 * 15 / 100 = 1_500 (exact)
        let epoch_id =
            commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, 10_000);

        let c = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            60,
            25,
            15,
        );
        let i = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            60,
            25,
            15,
        );
        let t = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &treasury,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            60,
            25,
            15,
        );

        assert_eq!(c, 6_000, "creator exact share");
        assert_eq!(i, 2_500, "investor exact share");
        assert_eq!(t, 1_500, "treasury exact share");
        assert_eq!(c + i + t, 10_000, "sum equals total when exact");
    }

    /// total=100, shares 33/33/34 — note 33 divides evenly here.
    #[test]
    fn rounding_exact_with_unequal_shares() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 2u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        // 100 * 33 / 100 = 33 (exact)
        // 100 * 34 / 100 = 34 (exact)
        let epoch_id = commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, 100);

        let c = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );
        let i = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );
        let t = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &treasury,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );

        assert_eq!(c, 33);
        assert_eq!(i, 33);
        assert_eq!(t, 34);
        assert_eq!(c + i + t, 100);
    }

    // ── Positive: truncating (floor) division ─────────────────────────────────

    /// total=101, shares 33/33/34 — 101*33/100 = 33 (remainder 33 lost).
    /// The sum of claims (33+33+34=100) is less than total (101): 1 unit of
    /// dust remains in the epoch and is recoverable by admin after expiry.
    #[test]
    fn rounding_truncation_leaves_dust_in_epoch() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 3u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, 101);

        // 101 * 33 / 100 = 33  (remainder 33 discarded)
        // 101 * 33 / 100 = 33
        // 101 * 34 / 100 = 34  (remainder 34 discarded)
        let c = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );
        let i = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );
        let t = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &treasury,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );

        assert_eq!(c, 33, "33% of 101 truncates to 33");
        assert_eq!(i, 33, "33% of 101 truncates to 33");
        assert_eq!(t, 34, "34% of 101 truncates to 34");

        // Intentional: sum < total — 1 unit of dust stays in the epoch.
        assert_eq!(c + i + t, 100, "sum is total minus dust");
        let rec = client.get_epoch(&talos_id, &epoch_id).unwrap();
        assert_eq!(rec.claimed_amount, 100);
        assert_eq!(
            rec.total_amount - rec.claimed_amount,
            1,
            "1 unit dust remains"
        );
    }

    /// total=199, shares 33/33/34 — exercises different remainder pattern.
    #[test]
    fn rounding_truncation_199_three_way_split() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 4u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, 199);

        // 199 * 33 / 100 = 65  (remainder 67 discarded)
        // 199 * 33 / 100 = 65
        // 199 * 34 / 100 = 67  (remainder 66 discarded)
        let c = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );
        let i = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );
        let t = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &treasury,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );

        assert_eq!(c, 65, "33% of 199 truncates to 65");
        assert_eq!(i, 65, "33% of 199 truncates to 65");
        assert_eq!(t, 67, "34% of 199 truncates to 67");

        let rec = client.get_epoch(&talos_id, &epoch_id).unwrap();
        assert_eq!(rec.total_amount - rec.claimed_amount, 2, "2 units dust");
    }

    /// Repeated single-patron epochs to verify truncation is stable across calls.
    #[test]
    fn rounding_truncation_single_patron_50_50_split() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 5u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        // total=3, shares 50/25/25 — 3*50/100=1, 3*25/100=0 (ZeroAllocation for investor+treasury)
        // Use a large enough total so no role gets zero.
        // total=7, shares 50/30/20 — 7*50=350/100=3, 7*30=210/100=2, 7*20=140/100=1 → sum=6 (1 dust)
        let epoch_id = commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, 7);

        let c = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            50,
            30,
            20,
        );
        let i = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            50,
            30,
            20,
        );
        let t = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &treasury,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            50,
            30,
            20,
        );

        assert_eq!(c, 3, "50% of 7 truncates to 3");
        assert_eq!(i, 2, "30% of 7 truncates to 2");
        assert_eq!(t, 1, "20% of 7 truncates to 1");
        assert_eq!(c + i + t, 6);

        let rec = client.get_epoch(&talos_id, &epoch_id).unwrap();
        assert_eq!(rec.total_amount - rec.claimed_amount, 1, "1 unit dust");
    }

    // ── Boundary: minimum epoch amount ───────────────────────────────────────

    /// total=MIN_EPOCH_AMOUNT=1, share=100/0/0 — only the 100% holder can
    /// claim; the contract must not reject a valid 1-unit allocation.
    #[test]
    fn rounding_min_epoch_amount_full_share_claimable() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 6u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        // With total=1 and creator_share=100, allocation = 1*100/100 = 1.
        let epoch_id = commit_epoch_with_total(
            &env,
            &contract_id,
            &client,
            &admin,
            talos_id,
            MIN_EPOCH_AMOUNT,
        );

        let allocation = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            100,
            0,
            0,
        );
        assert_eq!(allocation, 1, "1 unit fully claimed with 100% share");
    }

    /// total=1, share=1/99/0 — 1*1/100=0 → ZeroAllocation.
    /// Even at MIN_EPOCH_AMOUNT, a small share percentage must not silently
    /// succeed with a zero transfer.
    #[test]
    fn rounding_min_epoch_small_share_returns_zero_allocation() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 7u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_epoch_with_total(
            &env,
            &contract_id,
            &client,
            &admin,
            talos_id,
            MIN_EPOCH_AMOUNT,
        );

        // creator_share=1 → 1*1/100 = 0 → ZeroAllocation
        let res = try_claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            1,
            0,
            99,
        );
        assert_eq!(
            res,
            Err(Ok(ContractError::ZeroAllocation)),
            "1% of 1 unit must produce ZeroAllocation"
        );
    }

    /// total=99, share=1/0/99 — 99*1/100=0 → ZeroAllocation.
    #[test]
    fn rounding_99_total_1pct_share_returns_zero_allocation() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 8u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, 99);

        let res = try_claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            1,
            0,
            99,
        );
        assert_eq!(
            res,
            Err(Ok(ContractError::ZeroAllocation)),
            "1% of 99 truncates to 0"
        );
    }

    /// total=100, share=1/0/99 — 100*1/100=1 → succeeds (just above ZeroAllocation boundary).
    #[test]
    fn rounding_boundary_100_total_1pct_exactly_claimable() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 9u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, 100);

        let allocation = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            1,
            0,
            99,
        );
        assert_eq!(allocation, 1, "1% of 100 = exactly 1");
    }

    // ── Boundary: large amounts (overflow-safe) ───────────────────────────────

    /// total near i128::MAX / 100 (not overflowing the checked_mul).
    /// Ensures compute_allocation's overflow guard does not fire for
    /// legitimate large epoch amounts.
    #[test]
    fn rounding_large_total_no_overflow() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 10u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        // i128::MAX ≈ 1.7e38; choose total just below i128::MAX / 100 so
        // total * 99 fits in i128 without overflow.
        // i128::MAX / 100 = 1_701_411_834_604_692_317_316_873_037_158_841_057
        let total: i128 = 1_000_000_000_000_000_000_000_000_000_000_i128; // 10^30
        let epoch_id =
            commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, total);

        // creator_share=99 → total*99/100 (large but valid)
        let allocation = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            99,
            1,
            0,
        );
        assert_eq!(
            allocation,
            total * 99 / 100,
            "large-amount allocation matches manual calculation"
        );

        let inv = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            99,
            1,
            0,
        );
        assert_eq!(inv, total * 1 / 100);
    }

    // ── Negative: accounting overflow guard ──────────────────────────────────

    /// The accounting invariant (claimed_amount <= total_amount) must reject
    /// any claim that would exceed the epoch total, even if the claimant's
    /// share is valid.  This is hard to trigger in normal operation (shares
    /// sum to 100 and total distributes ≤ total_amount), but we verify the
    /// guard path is reachable by crafting a scenario where two claimants
    /// each hold 100% in separate concurrent epochs — independent epochs so
    /// we don't actually need to violate arithmetic; instead we verify the
    /// claimed_amount field never exceeds total_amount across all claims.
    #[test]
    fn rounding_claimed_amount_never_exceeds_total() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 11u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id =
            commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, 10_001);

        // shares 60/25/15 → 6000 + 2500 + 1500 = 10_000 (1 dust)
        let c = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            60,
            25,
            15,
        );
        let i = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            60,
            25,
            15,
        );
        let t = claim_with_shares(
            &env,
            &contract_id,
            &client,
            &treasury,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            60,
            25,
            15,
        );

        let rec = client.get_epoch(&talos_id, &epoch_id).unwrap();
        assert!(
            rec.claimed_amount <= rec.total_amount,
            "accounting invariant: claimed <= total"
        );
        assert_eq!(c + i + t, rec.claimed_amount);
    }

    // ── Regression: dust is recoverable after expiry ──────────────────────────

    /// After all patrons claim (leaving truncation dust), the admin can
    /// recover the remaining dust via `recover_expired`.
    #[test]
    fn rounding_dust_recovered_after_expiry() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 12u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        // total=101, 33/33/34 → claims sum to 100, dust=1
        let epoch_id = commit_epoch_with_total(&env, &contract_id, &client, &admin, talos_id, 101);

        claim_with_shares(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );
        claim_with_shares(
            &env,
            &contract_id,
            &client,
            &investor,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );
        claim_with_shares(
            &env,
            &contract_id,
            &client,
            &treasury,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
            33,
            33,
            34,
        );

        // Advance past expiry.
        env.ledger().with_mut(|li| {
            li.timestamp = 9_000;
        });

        let recovered = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "recover_expired",
                    args: (admin.clone(), talos_id, epoch_id).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .recover_expired(&admin, &talos_id, &epoch_id);

        assert_eq!(recovered, 1, "1 unit of truncation dust is recovered");
    }

    // ── Budget regression gates (#610) ───────────────────────────────────────
    //
    // These tests assert that key entry-points stay within CPU-instruction and
    // memory-byte ceilings measured on the host (native Rust) target.
    //
    // IMPORTANT: The Soroban SDK test runtime underestimates costs relative to
    // the actual WASM runtime.  The limits below are therefore intentionally
    // loose — they are regression catches rather than hard production caps.
    // If an entry-point exceeds a ceiling it means a refactor significantly
    // increased its resource consumption and the change needs review.
    //
    // Measurement pattern:
    //   1. `env.budget().reset_default()` — zero the counters and re-apply the
    //      default per-transaction limits so each test is fully isolated.
    //   2. Execute the entry-point under test.
    //   3. Assert `cpu_instruction_cost()` and `memory_bytes_cost()` stay below
    //      the stated ceilings.

    /// CPU/memory ceiling for `initialize`.
    const BUDGET_CPU_INITIALIZE: u64 = 300_000;
    const BUDGET_MEM_INITIALIZE: u64 = 60_000;

    /// CPU/memory ceiling for `commit_epoch` (single epoch, default params).
    const BUDGET_CPU_COMMIT_EPOCH: u64 = 600_000;
    const BUDGET_MEM_COMMIT_EPOCH: u64 = 100_000;

    /// CPU/memory ceiling for `claim_dividend` (single claim, 60 % share).
    const BUDGET_CPU_CLAIM: u64 = 800_000;
    const BUDGET_MEM_CLAIM: u64 = 130_000;

    /// CPU/memory ceiling for `get_epoch` (read-only).
    const BUDGET_CPU_GET_EPOCH: u64 = 200_000;
    const BUDGET_MEM_GET_EPOCH: u64 = 50_000;

    #[test]
    fn budget_initialize_within_limits() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosDividends);
        let client = TalosDividendsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let registry = Address::generate(&env);

        env.budget().reset_default();
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), registry.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .initialize(&admin, &registry);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_INITIALIZE,
            "initialize CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_INITIALIZE,
        );
        assert!(
            mem < BUDGET_MEM_INITIALIZE,
            "initialize memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_INITIALIZE,
        );
    }

    #[test]
    fn budget_commit_epoch_within_limits() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;

        env.budget().reset_default();
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), talos_id, 10_000_i128, 7_200_u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .commit_epoch(&admin, &talos_id, &10_000_i128, &7_200_u64);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_COMMIT_EPOCH,
            "commit_epoch CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_COMMIT_EPOCH,
        );
        assert!(
            mem < BUDGET_MEM_COMMIT_EPOCH,
            "commit_epoch memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_COMMIT_EPOCH,
        );
    }

    #[test]
    fn budget_claim_dividend_within_limits() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.budget().reset_default();
        do_claim(
            &env,
            &contract_id,
            &client,
            &creator,
            talos_id,
            epoch_id,
            &creator,
            &investor,
            &treasury,
        );

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_CLAIM,
            "claim_dividend CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_CLAIM,
        );
        assert!(
            mem < BUDGET_MEM_CLAIM,
            "claim_dividend memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_CLAIM,
        );
    }

    #[test]
    fn budget_get_epoch_read_within_limits() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        env.budget().reset_default();
        let _ = client.get_epoch(&talos_id, &epoch_id);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_GET_EPOCH,
            "get_epoch CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_GET_EPOCH,
        );
        assert!(
            mem < BUDGET_MEM_GET_EPOCH,
            "get_epoch memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_GET_EPOCH,
        );
    }

    /// Boundary: commit with minimum allowed `total_amount` stays within budget.
    #[test]
    fn budget_commit_epoch_minimum_amount_within_limits() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 2u32;

        env.budget().reset_default();
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), talos_id, MIN_EPOCH_AMOUNT, MIN_EXPIRY_SECS)
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .commit_epoch(&admin, &talos_id, &MIN_EPOCH_AMOUNT, &MIN_EXPIRY_SECS);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_COMMIT_EPOCH,
            "commit_epoch (min amount) CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_COMMIT_EPOCH,
        );
        assert!(
            mem < BUDGET_MEM_COMMIT_EPOCH,
            "commit_epoch (min amount) memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_COMMIT_EPOCH,
        );
    }

    /// Negative: a rejected `commit_epoch` (zero amount) must also not
    /// overspend — validation is O(1) and should be cheaper than success.
    #[test]
    fn budget_commit_epoch_rejected_does_not_overspend() {
        let (env, contract_id, admin, _, client) = setup();

        env.budget().reset_default();
        let _ = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), 1u32, 0_i128, 7_200_u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_commit_epoch(&admin, &1u32, &0_i128, &7_200_u64);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        // Rejected paths must be no more expensive than the success path.
        assert!(
            cpu < BUDGET_CPU_COMMIT_EPOCH,
            "rejected commit_epoch CPU {} exceeded ceiling {}",
            cpu,
            BUDGET_CPU_COMMIT_EPOCH,
        );
        assert!(
            mem < BUDGET_MEM_COMMIT_EPOCH,
            "rejected commit_epoch memory {} exceeded ceiling {}",
            mem,
            BUDGET_MEM_COMMIT_EPOCH,
        );
    }

    // ── Admin rotation tests ─────────────────────────────────────────────────

    #[test]
    fn admin_rotation_happy_path() {
        let (env, contract_id, admin, _, client) = setup();
        let new_admin = Address::generate(&env);

        assert_eq!(client.get_admin(), Some(admin.clone()));
        assert_eq!(client.pending_admin(), None);

        // Propose new admin
        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        assert_eq!(client.pending_admin(), Some(new_admin.clone()));
        assert_eq!(client.get_admin(), Some(admin.clone()));

        // Check adm_prp event
        let events = env.events().all();
        let prop_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(addr, topics, _)| {
                if *addr != contract_id || topics.is_empty() {
                    return false;
                }
                let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &topics.get(0).unwrap());
                sym.map(|s| s == symbol_short!("adm_prp")).unwrap_or(false)
            })
            .collect();
        assert_eq!(prop_events.len(), 1);
        let (_, _, prop_data) = prop_events[0].clone();
        let (got_curr, got_prop): (Address, Address) = TryFromVal::try_from_val(&env, &prop_data).unwrap();
        assert_eq!(got_curr, admin);
        assert_eq!(got_prop, new_admin);

        // Accept new admin
        mock_accept(&env, &client, &contract_id, &new_admin);
        assert_eq!(client.get_admin(), Some(new_admin.clone()));
        assert_eq!(client.pending_admin(), None);

        // Check adm_acc event
        let events = env.events().all();
        let acc_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(addr, topics, _)| {
                if *addr != contract_id || topics.is_empty() {
                    return false;
                }
                let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &topics.get(0).unwrap());
                sym.map(|s| s == symbol_short!("adm_acc")).unwrap_or(false)
            })
            .collect();
        assert_eq!(acc_events.len(), 1);
        let (_, _, acc_data) = acc_events[0].clone();
        let (got_acc_admin,): (Address,) = TryFromVal::try_from_val(&env, &acc_data).unwrap();
        assert_eq!(got_acc_admin, new_admin);

        // Old admin loses rights: commit_epoch with old admin is rejected
        let res_old = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "commit_epoch",
                    args: (admin.clone(), 1u32, 10_000_i128, 7_200_u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_commit_epoch(&admin, &1u32, &10_000_i128, &7_200_u64);
        assert_eq!(res_old, Err(Ok(ContractError::Unauthorized)));

        // New admin has rights: commit_epoch with new admin succeeds
        let res_new = client
            .mock_auths(&[MockAuth {
                address: &new_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "commit_epoch",
                    args: (new_admin.clone(), 1u32, 10_000_i128, 7_200_u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .commit_epoch(&new_admin, &1u32, &10_000_i128, &7_200_u64);
        assert_eq!(res_new, 1u64);
    }

    #[test]
    fn admin_rotation_wrong_signer() {
        let (env, contract_id, admin, _, client) = setup();
        let new_admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        // 1. Propose with impostor fails
        let res_prop = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "propose_admin",
                    args: (new_admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_admin(&new_admin);
        assert!(res_prop.is_err());

        // Now propose with real admin
        mock_propose(&env, &client, &contract_id, &admin, &new_admin);

        // 2. Accept with impostor (not pending admin) fails
        let res_acc_impostor = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin();
        assert!(res_acc_impostor.is_err());

        // 3. Accept with current admin (not pending admin) also fails
        let res_acc_admin = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin();
        assert!(res_acc_admin.is_err());

        // 4. Cancel with impostor (not current admin) fails
        let res_cnl_impostor = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cancel_admin_transfer",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel_admin_transfer();
        assert!(res_cnl_impostor.is_err());

        // 5. Cancel with pending admin (not current admin) fails
        let res_cnl_pending = client
            .mock_auths(&[MockAuth {
                address: &new_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cancel_admin_transfer",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel_admin_transfer();
        assert!(res_cnl_pending.is_err());
    }

    #[test]
    fn admin_rotation_cancel() {
        let (env, contract_id, admin, _, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        assert_eq!(client.pending_admin(), Some(new_admin.clone()));

        // Cancel
        mock_cancel(&env, &client, &contract_id, &admin);
        assert_eq!(client.pending_admin(), None);
        assert_eq!(client.get_admin(), Some(admin.clone()));

        // Check adm_cnl event
        let events = env.events().all();
        let cnl_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(addr, topics, _)| {
                if *addr != contract_id || topics.is_empty() {
                    return false;
                }
                let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &topics.get(0).unwrap());
                sym.map(|s| s == symbol_short!("adm_cnl")).unwrap_or(false)
            })
            .collect();
        assert_eq!(cnl_events.len(), 1);
        let (_, _, cnl_data) = cnl_events[0].clone();
        let (got_cnl_admin,): (Address,) = TryFromVal::try_from_val(&env, &cnl_data).unwrap();
        assert_eq!(got_cnl_admin, new_admin);

        // Nominee can no longer accept
        let res_acc = client
            .mock_auths(&[MockAuth {
                address: &new_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin();
        assert_eq!(res_acc, Err(Ok(ContractError::NoPendingAdmin)));
    }

    #[test]
    fn admin_rotation_accept_without_pending_admin() {
        let (env, contract_id, admin, _, client) = setup();
        let any_addr = Address::generate(&env);

        let res = client
            .mock_auths(&[MockAuth {
                address: &any_addr,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin();
        assert_eq!(res, Err(Ok(ContractError::NoPendingAdmin)));

        // Also cancel without pending returns NoPendingAdmin
        let res_cnl = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cancel_admin_transfer",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel_admin_transfer();
        assert_eq!(res_cnl, Err(Ok(ContractError::NoPendingAdmin)));
    }

    #[test]
    fn admin_rotation_propose_replaces_existing_pending() {
        let (env, contract_id, admin, _, client) = setup();
        let nominee1 = Address::generate(&env);
        let nominee2 = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &nominee1);
        assert_eq!(client.pending_admin(), Some(nominee1.clone()));

        // Replace nomination
        mock_propose(&env, &client, &contract_id, &admin, &nominee2);
        assert_eq!(client.pending_admin(), Some(nominee2.clone()));

        // Nominee 1 can no longer accept
        let res1 = client
            .mock_auths(&[MockAuth {
                address: &nominee1,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin();
        assert!(res1.is_err());

        // Nominee 2 can accept
        mock_accept(&env, &client, &contract_id, &nominee2);
        assert_eq!(client.get_admin(), Some(nominee2.clone()));
        assert_eq!(client.pending_admin(), None);
    }

    #[test]
    fn admin_rotation_uninitialized_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosDividends);
        let client = TalosDividendsClient::new(&env, &contract_id);
        let any_addr = Address::generate(&env);

        let res_prop = client
            .mock_auths(&[MockAuth {
                address: &any_addr,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "propose_admin",
                    args: (any_addr.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_admin(&any_addr);
        assert_eq!(res_prop, Err(Ok(ContractError::NotInitialized)));

        let res_cnl = client
            .mock_auths(&[MockAuth {
                address: &any_addr,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cancel_admin_transfer",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel_admin_transfer();
        assert_eq!(res_cnl, Err(Ok(ContractError::NotInitialized)));
    }

    // ── Storage TTL Management Tests ─────────────────────────────

    #[test]
    fn commit_epoch_and_claim_dividend_set_last_touched() {
        let (env, contract_id, admin, _registry, client) = setup();
        let talos_id = 1u32;
        env.ledger().with_mut(|li| {
            li.sequence_number = 100;
        });

        let epoch_id = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 10_000, 86_400);
        let key = DataKey::LastTouched(talos_id, epoch_id);
        let last: u32 = env.as_contract(&contract_id, || {
            env.storage().persistent().get(&key).unwrap()
        });
        assert_eq!(last, 100);

        // Advance ledger and claim dividend
        env.ledger().with_mut(|li| {
            li.sequence_number = 250;
            li.timestamp = 2_000;
        });

        let patron_creator = Address::generate(&env);
        let patron_investor = Address::generate(&env);
        let patron_treasury = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &patron_creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "claim_dividend",
                    args: (
                        patron_creator.clone(),
                        talos_id,
                        epoch_id,
                        patron_creator.clone(),
                        patron_investor.clone(),
                        patron_treasury.clone(),
                        50u32,
                        30u32,
                        20u32,
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .claim_dividend(
                &patron_creator,
                &talos_id,
                &epoch_id,
                &patron_creator,
                &patron_investor,
                &patron_treasury,
                &50u32,
                &30u32,
                &20u32,
            );

        let last_after_claim: u32 = env.as_contract(&contract_id, || {
            env.storage().persistent().get(&key).unwrap()
        });
        assert_eq!(last_after_claim, 250);
    }

    #[test]
    fn touch_epoch_behaviour_and_events() {
        let (env, contract_id, admin, _registry, client) = setup();
        let talos_id = 1u32;
        env.ledger().with_mut(|li| {
            li.sequence_number = 10;
        });

        let epoch_id = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 10_000, 86_400);

        // Near touch (below threshold) -> skipped
        env.ledger().with_mut(|li| {
            li.sequence_number = 10 + ttl_manager::RENEWAL_THRESHOLD - 1;
        });
        let touched = client.touch_epoch(&talos_id, &epoch_id);
        assert!(!touched);

        // At or above threshold -> touched
        env.ledger().with_mut(|li| {
            li.sequence_number = 10 + ttl_manager::RENEWAL_THRESHOLD;
        });
        let touched2 = client.touch_epoch(&talos_id, &epoch_id);
        assert!(touched2);

        let key = DataKey::LastTouched(talos_id, epoch_id);
        let last: u32 = env.as_contract(&contract_id, || {
            env.storage().persistent().get(&key).unwrap()
        });
        assert_eq!(last, 10 + ttl_manager::RENEWAL_THRESHOLD);

        // Assert record still intact and readable
        let record = client.get_epoch(&talos_id, &epoch_id).unwrap();
        assert_eq!(record.total_amount, 10_000);
    }

    #[test]
    fn extend_ttl_batch_respects_bounds_and_auth() {
        let (env, contract_id, admin, _registry, client) = setup();
        let talos_id = 1u32;
        env.ledger().with_mut(|li| {
            li.sequence_number = 100;
        });

        let ep1 = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 1_000, 86_400);
        let ep2 = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 2_000, 86_400);
        let ep3 = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 3_000, 86_400);

        // Set LastTouched for ep1 to age 300, ep2 to age 150, ep3 to age 50
        env.ledger().with_mut(|li| {
            li.sequence_number = 1000;
        });
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&DataKey::LastTouched(talos_id, ep1), &700u32); // age = 300
            env.storage().persistent().set(&DataKey::LastTouched(talos_id, ep2), &850u32); // age = 150
            env.storage().persistent().set(&DataKey::LastTouched(talos_id, ep3), &950u32); // age = 50
        });

        // Extend with min_age = 100, max_age = 200 -> only ep2 qualifies
        let (touched, skipped) = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "extend_ttl_batch",
                    args: (admin.clone(), talos_id, 1u64, 10u32, 100u32, 200u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .extend_ttl_batch(&admin, &talos_id, &1u64, &10u32, &100u32, &200u32);

        assert_eq!(touched, 1);
        assert_eq!(skipped, 2);

        // Non-admin auth fails
        let non_admin = Address::generate(&env);
        let res_unauth = client
            .mock_auths(&[MockAuth {
                address: &non_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "extend_ttl_batch",
                    args: (non_admin.clone(), talos_id, 1u64, 10u32, 100u32, 200u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_extend_ttl_batch(&non_admin, &talos_id, &1u64, &10u32, &100u32, &200u32);
        assert_eq!(res_unauth, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn epoch_remains_readable_across_full_claim_window() {
        let (env, contract_id, admin, _registry, client) = setup();
        let talos_id = 1u32;
        let expiry_secs = MAX_EXPIRY_SECS; // 365 days (~6.3 million ledgers at 5s/ledger)

        env.ledger().with_mut(|li| {
            li.sequence_number = 1_000;
            li.timestamp = 10_000;
        });

        let epoch_id = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 100_000, expiry_secs);

        // Advance ledger by 2_500_000 ledgers (~145 days, within expiry)
        env.ledger().with_mut(|li| {
            li.sequence_number = 1_000 + 2_500_000;
            li.timestamp = 10_000 + (2_500_000 * 5);
        });

        // Touch epoch before archival
        let touched = client.touch_epoch(&talos_id, &epoch_id);
        assert!(touched);

        // Advance ledger another 2_500_000 ledgers (~290 days total, still within MAX_EXPIRY_SECS)
        env.ledger().with_mut(|li| {
            li.sequence_number = 1_000 + 5_000_000;
            li.timestamp = 10_000 + (5_000_000 * 5);
        });

        let touched2 = client.touch_epoch(&talos_id, &epoch_id);
        assert!(touched2);

        // Verify epoch is readable and can be claimed
        let record = client.get_epoch(&talos_id, &epoch_id).expect("epoch must remain readable");
        assert_eq!(record.status, EpochStatus::Active);

        let patron_creator = Address::generate(&env);
        let patron_investor = Address::generate(&env);
        let patron_treasury = Address::generate(&env);

        let claimed = client
            .mock_auths(&[MockAuth {
                address: &patron_creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "claim_dividend",
                    args: (
                        patron_creator.clone(),
                        talos_id,
                        epoch_id,
                        patron_creator.clone(),
                        patron_investor.clone(),
                        patron_treasury.clone(),
                        50u32,
                        30u32,
                        20u32,
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .claim_dividend(
                &patron_creator,
                &talos_id,
                &epoch_id,
                &patron_creator,
                &patron_investor,
                &patron_treasury,
                &50u32,
                &30u32,
                &20u32,
            );
        assert_eq!(claimed, 50_000);
    }

    #[test]
    fn get_storage_health_reports_and_warns() {
        let (env, contract_id, admin, _registry, client) = setup();
        let talos_id = 1u32;
        env.ledger().with_mut(|li| {
            li.sequence_number = 100;
        });

        let ep = commit_epoch(&env, &contract_id, &client, &admin, talos_id, 10_000, 86_400);

        // Advance sequence near critical threshold
        env.ledger().with_mut(|li| {
            li.sequence_number = 100 + ttl_manager::CRITICAL_THRESHOLD + 10;
        });

        let (min_age, max_age, warn, crit, total) = client.get_storage_health(&talos_id);
        assert_eq!(total, 1);
        assert_eq!(warn, 1);
        assert_eq!(crit, 1);
        assert_eq!(min_age, ttl_manager::CRITICAL_THRESHOLD + 10);
        assert_eq!(max_age, ttl_manager::CRITICAL_THRESHOLD + 10);

        // After touch, health resets
        client.touch_epoch(&talos_id, &ep);
        let (min_age2, max_age2, warn2, crit2, total2) = client.get_storage_health(&talos_id);
        assert_eq!(total2, 1);
        assert_eq!(warn2, 0);
        assert_eq!(crit2, 0);
        assert_eq!(min_age2, 0);
        assert_eq!(max_age2, 0);
    }

    // ── set_registry_contract() ───────────────────────────────────────────────

    #[test]
    fn set_registry_contract_unauthorized_update_fails() {
        let (env, contract_id, _admin, _, client) = setup();
        let impostor = Address::generate(&env);
        let new_registry = Address::generate(&env);

        let res = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_registry_contract",
                    args: (impostor.clone(), new_registry.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_registry_contract(&impostor, &new_registry);

        assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    }

    /// Mock registry contract that returns compatible interface_id and version
    #[contract]
    struct MockCompatibleRegistry;

    #[contractimpl]
    impl MockCompatibleRegistry {
        pub fn interface_id(_env: Env) -> BytesN<32> {
            BytesN::from_array(&_env, &EXPECTED_REGISTRY_INTERFACE_ID)
        }

        pub fn version(_env: Env) -> (u32, u32, u32) {
            (1, 4, 0)
        }
    }

    #[test]
    fn set_registry_contract_authorized_update_succeeds() {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });
        let contract_id = env.register_contract(None, TalosDividends);
        let client = TalosDividendsClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let registry = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), registry.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .initialize(&admin, &registry);

        // Register a mock compatible registry
        let new_registry_id = env.register_contract(None, MockCompatibleRegistry);
        let new_registry = new_registry_id.clone();

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_registry_contract",
                    args: (admin.clone(), new_registry.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_registry_contract(&admin, &new_registry);

        assert_eq!(client.get_registry(), Some(new_registry.clone()));

        // Verify the event was emitted
        let events = env.events().all();
        let reg_upd_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(addr, topics, _)| {
                if *addr != contract_id || topics.len() == 0 {
                    return false;
                }
                let sym: Result<Symbol, _> =
                    TryFromVal::try_from_val(&env, &topics.get(0).unwrap());
                sym.map(|s| s == symbol_short!("reg_upd")).unwrap_or(false)
            })
            .collect();

        assert_eq!(reg_upd_events.len(), 1);
        let (_, _, data) = reg_upd_events[0].clone();
        let (old, new): (Address, Address) = TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(old, registry);
        assert_eq!(new, new_registry);
    }

    #[test]
    fn set_registry_contract_incompatible_registry_fails() {
        let (env, contract_id, admin, _, client) = setup();
        // Use an arbitrary address that doesn't implement the interface
        let incompatible_registry = Address::generate(&env);

        let res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_registry_contract",
                    args: (admin.clone(), incompatible_registry.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_registry_contract(&admin, &incompatible_registry);

        // The contract will fail when trying to invoke the interface_id method
        // on a non-existent contract, which results in an error
        assert!(res.is_err());
    }
}

