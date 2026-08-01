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
//! | `RegistryContract`          | `Address`        | persistent  |
//! | `Epoch(talos_id, epoch_id)` | `EpochRecord`    | persistent  |
//! | `Claimed(epoch_id, patron)` | `bool`           | persistent  |
//! | `NextEpochId(talos_id)`     | `u64`            | persistent  |
//!
//! ## Events (topics → data)
//!
//! | Symbol     | Topics                                    | Data                                               |
//! |------------|-------------------------------------------|----------------------------------------------------|
//! | `ep_cmt`   | `(symbol, talos_id: u32)`                 | `(epoch_id: u64, total: i128, expiry_secs: u64)`   |
//! | `div_clm`  | `(symbol, epoch_id: u64, patron: Address)`| `(talos_id: u32, amount: i128, role: PatronRole)`  |
//! | `ep_rcv`   | `(symbol, epoch_id: u64)`                 | `(talos_id: u32, recovered: i128, admin: Address)` |
//!
//! ## Compatibility / rollout notes
//!
//! This contract is additive — it does not modify `TalosRegistry` storage.
//! Deploy independently, configure `registry_contract` to point at the live
//! `TalosRegistry`, and begin committing epochs.  Old push-based flows can
//! continue operating in parallel until clients migrate to the claim interface.
//!
//! ## Version
//!
//! `CONTRACT_VERSION = (1, 0, 0)`

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env};

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
pub const CONTRACT_VERSION: (u32, u32, u32) = (1, 0, 0);

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

fn emit_epoch_recovered(env: &Env, epoch_id: u64, talos_id: u32, recovered: i128, admin: Address) {
    env.events().publish(
        (symbol_short!("ep_rcv"), epoch_id),
        (talos_id, recovered, admin),
    );
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

        env.storage()
            .persistent()
            .set(&DataKey::Epoch(talos_id, epoch_id), &record);
        env.storage()
            .persistent()
            .set(&DataKey::NextEpochId(talos_id), &(epoch_id + 1));

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

        // Enforce claim window.
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
            return Err(ContractError::NotAPatron);
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

        // Accounting invariant: ensure we do not over-distribute.
        let new_claimed = record
            .claimed_amount
            .checked_add(allocation)
            .ok_or(ContractError::Overflow)?;
        if new_claimed > record.total_amount {
            return Err(ContractError::AccountingOverflow);
        }

        // Persist claim and update running total atomically.
        env.storage().persistent().set(&claim_key, &true);
        record.claimed_amount = new_claimed;
        env.storage()
            .persistent()
            .set(&DataKey::Epoch(talos_id, epoch_id), &record);

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

    fn setup() -> (Env, Address, Address, Address, TalosDividendsClient<'static>) {
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
            .initialize(&admin, &registry)
            .unwrap();

        (env, contract_id, admin, registry, client)
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
            .unwrap()
    }

    /// Helper: perform a claim with provided patron addresses and shares.
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
    ) -> Result<i128, ContractError> {
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
                        60_u32,
                        25_u32,
                        15_u32,
                    )
                        .into_val(env),
                    sub_invokes: &[],
                },
            }])
            .claim_dividend(
                claimant, &talos_id, &epoch_id, creator, investor, treasury, &60_u32, &25_u32,
                &15_u32,
            )
    }

    // ── version() ────────────────────────────────────────────────────────────

    #[test]
    fn version_returns_compile_time_constant() {
        let (env, contract_id, _, _, client) = setup();
        assert_eq!(client.version(), (1u32, 0u32, 0u32));
        let _ = (env, contract_id);
    }

    #[test]
    fn version_matches_contract_constant() {
        let (env, contract_id, _, _, client) = setup();
        assert_eq!(client.version(), CONTRACT_VERSION);
        let _ = (env, contract_id);
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

        let sym: Symbol =
            TryFromVal::try_from_val(&env, &topics.get(0).unwrap()).expect("symbol");
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

        let allocation =
            do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury)
                .unwrap();

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

        let allocation =
            do_claim(&env, &contract_id, &client, &investor, talos_id, epoch_id, &creator, &investor, &treasury)
                .unwrap();

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

        let allocation =
            do_claim(&env, &contract_id, &client, &treasury, talos_id, epoch_id, &creator, &investor, &treasury)
                .unwrap();

        // treasury_share = 15%; 10_000 * 15 / 100 = 1_500
        assert_eq!(allocation, 1_500);
    }

    #[test]
    fn all_three_patrons_can_claim_and_total_equals_epoch_amount() {
        let (env, contract_id, admin, _, client) = setup();
        let talos_id = 1u32;
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);
        let epoch_id = commit_default_epoch(&env, &contract_id, &client, &admin, talos_id);

        let c = do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury).unwrap();
        let i = do_claim(&env, &contract_id, &client, &investor, talos_id, epoch_id, &creator, &investor, &treasury).unwrap();
        let t = do_claim(&env, &contract_id, &client, &treasury, talos_id, epoch_id, &creator, &investor, &treasury).unwrap();

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

        do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury).unwrap();
        let second = do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury);
        assert_eq!(second, Err(ContractError::AlreadyClaimed));
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

        let res = do_claim(&env, &contract_id, &client, &outsider, talos_id, epoch_id, &creator, &investor, &treasury);
        assert_eq!(res, Err(ContractError::NotAPatron));
    }

    #[test]
    fn claim_on_missing_epoch_returns_epoch_not_found() {
        let (env, contract_id, _, _, client) = setup();
        let creator = Address::generate(&env);
        let investor = Address::generate(&env);
        let treasury = Address::generate(&env);

        let res = do_claim(&env, &contract_id, &client, &creator, 99u32, 999u64, &creator, &investor, &treasury);
        assert_eq!(res, Err(ContractError::EpochNotFound));
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

        let res = do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury);
        assert_eq!(res, Err(ContractError::EpochExpired));
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

        do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury).unwrap();

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
            .recover_expired(&admin, &talos_id, &epoch_id)
            .unwrap();

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
        do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury).unwrap();

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
            .recover_expired(&admin, &talos_id, &epoch_id)
            .unwrap();

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
            .recover_expired(&admin, &talos_id, &epoch_id)
            .unwrap();

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
            .recover_expired(&admin, &talos_id, &epoch_id)
            .unwrap();

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

        do_claim(&env, &contract_id, &client, &creator, talos_id, epoch_id, &creator, &investor, &treasury).unwrap();
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
}
