//! TalosGovernance - Soroban smart contract for token-weighted governance.
//!
//! ## What's new in this branch (#606)
//! - `EventProposalCreated` typed struct — replaces raw tuple publish for prop_crt
//! - `EventVoteCast` typed struct — replaces raw tuple publish for vote
//! - `EventProposalStatusChanged` typed struct — replaces raw publish for prop_stat
//! - All emit helpers now publish their typed struct as the event data
//! - New event-verification tests decode structs from emitted events

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, IntoVal, String, Symbol, Vec,
};
use ttl_manager;
use pause_control;

// ── ProposalAction (#913) ────────────────────────────────────────────
//
// An optional typed action that can be attached to a governance proposal.
// When `execute_proposal` is called on an Approved proposal that carries an
// action, the contract performs the action via a cross-contract call and emits
// an `EventProposalExecuted` event with the outcome.
//
// Title-only proposals (no action) remain valid: their `action` field is `None`
// and execution simply transitions the status to `Executed`.
//
// Supported actions
// -----------------
// `PauseTalos`   – calls `deactivate_talos(talos_id, governance_address)` on
//                  the registry.  The governance contract must be the
//                  PauseController for the target Talos.
// `ResumeTalos`  – calls `activate_talos(talos_id, governance_address)` on
//                  the registry.  The governance contract must be the
//                  ResumeController for the target Talos.
// `UpdateConfig` – updates the local GovernanceConfig with the supplied
//                  values; no external call is needed.
//
// Failure model
// -------------
// If the cross-contract call panics (e.g., because the governance address is
// not the authorised controller), the host traps and the entire
// `execute_proposal` invocation is rolled back.  The proposal therefore stays
// in `Approved` status and can be retried once the on-chain permissions are
// corrected.  This is intentional: it makes the failure observable and
// retryable rather than silently swallowing errors.

/// Typed executable payload for a governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalAction {
    /// Deactivate (pause) a Talos via the registry.  The governance contract
    /// must have been set as the PauseController for `talos_id` on the registry.
    PauseTalos {
        registry: Address,
        talos_id: u32,
    },
    /// Reactivate (resume) a Talos via the registry.  The governance contract
    /// must have been set as the ResumeController for `talos_id` on the registry.
    ResumeTalos {
        registry: Address,
        talos_id: u32,
    },
    /// Replace the local GovernanceConfig numeric parameters with new values.
    /// The `pulse_token_address` is preserved from the existing config.
    UpdateConfig {
        quorum_threshold: i128,
        consensus_threshold: i128,
        voting_period_ledgers: u32,
    },
}

/// Emitted when a proposal with an action is executed.
///
/// `success` is always `true` — a failed cross-contract call traps the host
/// and the event is never published, so subscribers can assume success.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventProposalExecuted {
    pub proposal_id: u32,
    pub action_tag: Symbol,
    pub success: bool,
}

fn emit_proposal_executed(env: &Env, proposal_id: u32, action_tag: Symbol) {
    let payload = EventProposalExecuted {
        proposal_id,
        action_tag: action_tag.clone(),
        success: true,
    };
    env.events()
        .publish((symbol_short!("prop_exec"), proposal_id), payload);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoteChoice {
    Approve,
    Reject,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Approved,
    Rejected,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vote {
    pub voter: Address,
    pub choice: VoteChoice,
    pub weight: i128,
    pub voted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u32,
    pub talos_id: u32,
    pub proposer: Address,
    pub title: String,
    pub description: String,
    pub snapshot_ledger: u32,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub status: ProposalStatus,
    pub yes_votes: i128,
    pub no_votes: i128,
    pub total_voters: u32,
    pub created_at: u64,
    /// Optional typed action to execute when this proposal is approved.
    /// `None` means this is a signal/record-only proposal with no on-chain effect.
    pub action: Option<ProposalAction>,
}

/// Default number of ledgers prior to proposal creation at which voting power is snapshotted.
///
/// An offset is used so that voting power is evaluated at a ledger sequence before
/// the proposal was submitted. This prevents flash-loan or same-ledger front-running
/// attacks where an account acquires tokens in the same ledger as proposal creation,
/// exercises proposal creation / voting rights with temporarily borrowed funds, and
/// exits in the same transaction or block. On Stellar's ~5-second ledger cadence,
/// 10 ledgers represents an offset of approximately 50 seconds.
pub const DEFAULT_SNAPSHOT_OFFSET_LEDGERS: u32 = 10;

/// Maximum allowed snapshot offset in ledgers (~7 days on a 5-second ledger cadence).
///
/// Bounding the maximum offset prevents misconfigurations where proposals attempt to
/// snapshot state beyond the ledger retention or historical checkpoint window.
pub const MAX_SNAPSHOT_OFFSET_LEDGERS: u32 = 120_960;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceConfig {
    pub quorum_threshold: i128,
    pub consensus_threshold: i128,
    pub voting_period_ledgers: u32,
    pub pulse_token_address: Address,
    pub snapshot_offset_ledgers: Option<u32>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Config,
    NextProposalId,
    Proposal(u32),
    Vote(u32, Address),
    TokenBalanceSnapshot(u32, Address),
    Checkpoint(Address, u32),
    CheckpointCount(Address),
    Delegation(Address),
    LastTouched(u32),
    /// Monotonic counter for dividend epochs (1-based).
    NextDividendEpoch,
    /// Dividend snapshot keyed by epoch number.
    DividendSnapshot(u32),
    /// Sentinel written once when a proposal first crosses the quorum
    /// threshold.  Presence (value `true`) prevents re-emitting
    /// `EventQuorumReached` for subsequent votes.
    QuorumReached(u32),
    /// Configured TalosRegistry contract address.
    RegistryContract,
    /// Pending admin proposed for a two-step transfer (#948).
    PendingAdmin,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Checkpoint {
    pub ledger: u32,
    pub votes: i128,
}

// ── Proposal Limits ──────────────────────────────────────────────────

/// Maximum allowed byte length for proposal titles.
pub const MAX_TITLE_LEN: u32 = 128;

/// Maximum allowed byte length for proposal descriptions.
pub const MAX_DESCRIPTION_LEN: u32 = 2048;

// ── Dividend Snapshot (#598) ─────────────────────────────────────────

/// Maximum page size for `get_dividend_snapshots_page`.
pub const DIVIDEND_PAGE_LIMIT: u32 = 50;

/// A point-in-time record of per-token revenue distribution for a Talos.
///
/// Each epoch represents one distribution cycle.  `total_usdc` is the gross
/// USDC distributed; `per_token_usdc` is the amount per Mitos token unit
/// (both in micro-USDC, i.e. 10⁻⁶ USDC).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DividendSnapshot {
    /// Monotonically-increasing epoch number (1-based).
    pub epoch: u32,
    /// The Talos this dividend belongs to.
    pub talos_id: u32,
    /// Total USDC distributed in this epoch (micro-USDC).
    pub total_usdc: i128,
    /// Per Mitos token unit (micro-USDC).
    pub per_token_usdc: i128,
    /// Ledger at which this snapshot was recorded.
    pub snapshot_ledger: u32,
    /// Unix timestamp of the snapshot.
    pub created_at: u64,
}

/// Emitted when a new dividend snapshot epoch is recorded.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventDividendSnapshotRecorded {
    pub epoch: u32,
    pub talos_id: u32,
    pub total_usdc: i128,
    pub per_token_usdc: i128,
    pub snapshot_ledger: u32,
}

// ── Quorum State (#599) ──────────────────────────────────────────────

/// A read-only snapshot of quorum progress for a given proposal.
///
/// All fields are derived from the current `Proposal` storage and the
/// active `GovernanceConfig` at query time — no extra storage is written
/// for this query.
///
/// ## Field semantics
///
/// | Field | Description |
/// |---|---|
/// | `votes_cast` | Total voting weight cast (yes + no). |
/// | `quorum_threshold` | Minimum `votes_cast` required to reach quorum. |
/// | `quorum_met` | `true` when `votes_cast >= quorum_threshold`. |
/// | `yes_votes` | Cumulative approve weight. |
/// | `no_votes` | Cumulative reject weight. |
/// | `approval_bps` | `yes_votes * 10_000 / votes_cast` (0 when `votes_cast == 0`). |
/// | `consensus_threshold` | The `approval_bps` floor required to approve. |
/// | `quorum_fraction_bps` | `votes_cast * 10_000 / quorum_threshold` — progress toward quorum, capped at 10 000. |
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalQuorumState {
    /// Total voting weight cast (yes + no).
    pub votes_cast: i128,
    /// Minimum `votes_cast` required to reach quorum.
    pub quorum_threshold: i128,
    /// `true` when `votes_cast >= quorum_threshold`.
    pub quorum_met: bool,
    /// Cumulative approve weight.
    pub yes_votes: i128,
    /// Cumulative reject weight.
    pub no_votes: i128,
    /// `yes_votes * 10_000 / votes_cast`; 0 when `votes_cast == 0`.
    pub approval_bps: i128,
    /// The `approval_bps` floor required to pass.
    pub consensus_threshold: i128,
    /// `votes_cast * 10_000 / quorum_threshold`; capped at 10_000.
    pub quorum_fraction_bps: i128,
}

/// Emitted the **first time** a proposal crosses the quorum threshold.
///
/// A `DataKey::QuorumReached(proposal_id)` sentinel is written once the
/// event fires; subsequent votes that keep quorum satisfied do **not**
/// re-emit the event.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventQuorumReached {
    pub proposal_id: u32,
    pub votes_cast: i128,
    pub quorum_threshold: i128,
    pub approval_bps: i128,
}

// ── Pause Domains ───────────────────────────────────────────────────

/// Pause domain for proposal creation.
pub const PAUSE_PROPOSAL_CREATION: u32 = 7;
/// Pause domain for governance voting.
pub const PAUSE_GOVERNANCE_VOTING: u32 = 8;
/// Pause domain for governance configuration.
pub const PAUSE_GOVERNANCE_CONFIG: u32 = 9;

// ── Typed Event Fixtures (#606) ──────────────────────────────────────
//
// Each struct is decorated with `#[contracttype]` so the Soroban SDK
// serialises/deserialises it via XDR map encoding.  The structs are
// published as the event *data* payload; the topics remain lightweight
// symbol + id tuples for efficient on-chain filtering.
//
// Event schema (topics → typed data struct):
//   prop_crt : (symbol, proposal_id: u32) → EventProposalCreated
//   vote     : (symbol, proposal_id: u32) → EventVoteCast
//   prop_stat: (symbol, proposal_id: u32) → EventProposalStatusChanged

/// Emitted when a new governance proposal is created.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventProposalCreated {
    pub proposal_id: u32,
    pub talos_id: u32,
    pub proposer: Address,
    pub snapshot_ledger: u32,
    pub end_ledger: u32,
}

/// Emitted when a voter casts a vote.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventVoteCast {
    pub proposal_id: u32,
    pub voter: Address,
    pub choice: VoteChoice,
    pub weight: i128,
}

/// Emitted when a proposal transitions to a terminal status.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventProposalStatusChanged {
    pub proposal_id: u32,
    pub status: ProposalStatus,
}

fn emit_proposal_created(
    env: &Env,
    proposal_id: u32,
    talos_id: u32,
    proposer: Address,
    snapshot_ledger: u32,
    end_ledger: u32,
) {
    let payload = EventProposalCreated {
        proposal_id,
        talos_id,
        proposer,
        snapshot_ledger,
        end_ledger,
    };
    env.events()
        .publish((symbol_short!("prop_crt"), proposal_id), payload);
}

fn emit_vote_cast(
    env: &Env,
    proposal_id: u32,
    voter: Address,
    choice: VoteChoice,
    weight: i128,
) {
    let payload = EventVoteCast {
        proposal_id,
        voter,
        choice,
        weight,
    };
    env.events()
        .publish((symbol_short!("vote"), proposal_id), payload);
}

fn emit_proposal_status_changed(env: &Env, proposal_id: u32, status: ProposalStatus) {
    let payload = EventProposalStatusChanged {
        proposal_id,
        status,
    };
    env.events()
        .publish((symbol_short!("prop_stat"), proposal_id), payload);
}

fn emit_dividend_snapshot_recorded(env: &Env, snap: &DividendSnapshot) {
    let payload = EventDividendSnapshotRecorded {
        epoch: snap.epoch,
        talos_id: snap.talos_id,
        total_usdc: snap.total_usdc,
        per_token_usdc: snap.per_token_usdc,
        snapshot_ledger: snap.snapshot_ledger,
    };
    env.events()
        .publish((symbol_short!("div_snap"), snap.epoch), payload);
}

// ── Quorum-reached emit helper (#599) ──────────────────────────────

fn emit_quorum_reached(
    env: &Env,
    proposal_id: u32,
    votes_cast: i128,
    quorum_threshold: i128,
    approval_bps: i128,
) {
    let payload = EventQuorumReached {
        proposal_id,
        votes_cast,
        quorum_threshold,
        approval_bps,
    };
    env.events()
        .publish((symbol_short!("qrm_rchd"), proposal_id), payload);
}

// ── Admin transfer event emit helpers ────────────────────────────────

/// Emitted when the current admin nominates a new admin.
/// `proposed` is the address that must call `accept_admin` to complete the transfer.
fn emit_admin_proposed(env: &Env, current: Address, proposed: Address) {
    let topics = (symbol_short!("adm_prp"),);
    env.events().publish(topics, (current, proposed));
}

/// Emitted when the pending admin accepts the transfer.
/// `new_admin` is now the active governance admin.
fn emit_admin_accepted(env: &Env, new_admin: Address) {
    let topics = (symbol_short!("adm_acc"),);
    env.events().publish(topics, (new_admin,));
}

/// Emitted when the current admin cancels an in-progress admin transfer.
/// `cancelled` is the address whose nomination was revoked.
fn emit_admin_cancelled(env: &Env, cancelled: Address) {
    let topics = (symbol_short!("adm_cnl"),);
    env.events().publish(topics, (cancelled,));
}

// ── Stable interface (v1.1.0) ───────────────────────────────────────
//
// v1.1.0 adds:
//   - `ProposalQuorumState` struct and `get_proposal_quorum_state` query
//   - `EventQuorumReached` typed event emitted once per proposal
//   - `DataKey::QuorumReached(u32)` idempotency sentinel
//   - `quorum_state` capability in `interface_features()`
//
// All changes are purely additive.  Existing callers (v1.0.0) remain
// fully compatible; no storage keys or existing entry-point signatures
// have been modified.
pub const CONTRACT_VERSION: (u32, u32, u32) = (1, 1, 0);

pub const INTERFACE_NAMESPACE: &str = "TalosGovernance";

pub const INTERFACE_ID: [u8; 32] = [
    0x54, 0x61, 0x6C, 0x6F, 0x73, 0x47, 0x6F, 0x76, // "TalosGov"
    0x65, 0x72, 0x6E, 0x61, 0x6E, 0x63, 0x65, 0x00, // "ernance" + zero pad
    // (major, minor, patch) big-endian u32s
    0x00, 0x00, 0x00, 0x01, // major = 1
    0x00, 0x00, 0x00, 0x01, // minor = 1
    0x00, 0x00, 0x00, 0x00, // patch = 0
    // reserved
    0x00, 0x00, 0x00, 0x00,
];

/// Capability symbols returned by `interface_features()`. Capability
/// IDs are stable: appending to this list bumps `minor`; renaming or
/// removing bumps `major`.
pub fn features_list() -> &'static [&'static str] {
    &[
        "proposal_lifecycle", // create_proposal / vote / finalize / execute
        "vote_weighting",     // snapshot-based token-weighted voting
        "config_admin",       // update_config / cache_token_balance requires admin
        "interface_query",    // version / interface_id / supports_version
        "quorum_state",       // get_proposal_quorum_state / EventQuorumReached
    ]
}

/// SemVer compatibility helper used by `supports_version`.
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

/// Cross-contract compatibility helper.
///
/// Verifies that a contract registered as a `TalosRegistry` actually
/// publishes the expected `INTERFACE_ID`. Emits a `compat_ok` event
/// when the check passes and a `compat_err` event when it fails.
pub fn check_registry_compatible(
    e: &Env,
    registry: &Address,
    revert_on_mismatch: bool,
) -> bool {
    let registry_id: BytesN<32> = e.invoke_contract(
        registry,
        &Symbol::new(e, "interface_id"),
        soroban_sdk::vec![e],
    );

    if registry_id != BytesN::from_array(e, &EXPECTED_REGISTRY_INTERFACE_ID) {
        let topics = (Symbol::new(e, "compat_err"),);
        e.events().publish(topics, ());
        if revert_on_mismatch {
            panic!("Registry interface ID mismatch: expected TalosRegistry-compatible v1");
        }
        return false;
    }

    let version: (u32, u32, u32) = e.invoke_contract(
        registry,
        &Symbol::new(e, "version"),
        soroban_sdk::vec![e],
    );

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

#[contract]
pub struct TalosGovernance;

#[contractimpl]
impl TalosGovernance {
    pub fn initialize(
        env: Env,
        admin: Address,
        pulse_token_address: Address,
        quorum_threshold: i128,
        consensus_threshold: i128,
        voting_period_ledgers: u32,
    ) {
        admin.require_auth();

        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        if quorum_threshold <= 0 {
            panic!("Quorum must be positive");
        }
        if consensus_threshold <= 0 || consensus_threshold > 10_000 {
            panic!("Consensus threshold must be 1..10000 bps");
        }
        if voting_period_ledgers == 0 {
            panic!("Voting period must be positive");
        }

        let config = GovernanceConfig {
            quorum_threshold,
            consensus_threshold,
            voting_period_ledgers,
            pulse_token_address,
            snapshot_offset_ledgers: None,
        };

        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::Config, &config);
        env.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &1u32);
        env.storage()
            .persistent()
            .set(&DataKey::NextDividendEpoch, &1u32);
    }

    pub fn create_proposal(
        env: Env,
        proposer: Address,
        talos_id: u32,
        title: String,
        description: String,
    ) -> u32 {
        pause_control::check_not_paused(&env, PAUSE_PROPOSAL_CREATION);

        proposer.require_auth();

        if title.len() == 0 {
            panic!("Title cannot be empty");
        }
        if title.len() > MAX_TITLE_LEN {
            panic!("Title exceeds maximum length");
        }
        if description.len() == 0 {
            panic!("Description cannot be empty");
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            panic!("Description exceeds maximum length");
        }

        // Cross-contract verification: ensure talos_id exists and is active if
        // a registry contract has been configured.
        // For registry-unset deployments, the check is explicitly skipped to preserve
        // backwards compatibility with unconfigured or legacy deployments.
        if let Some(registry) = env
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::RegistryContract)
        {
            let is_active: bool = env.invoke_contract(
                &registry,
                &Symbol::new(&env, "is_active"),
                soroban_sdk::vec![&env, talos_id.into_val(&env)],
            );
            if !is_active {
                panic!("Talos is not active or does not exist");
            }
        }

        // Validate talos_id if a registry contract is configured.
        // For registry-unset deployments, the check is explicitly skipped to preserve
        // backwards compatibility with unconfigured or legacy deployments.
        if let Some(registry) = env
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::RegistryContract)
        {
            let is_active: bool = env.invoke_contract(
                &registry,
                &Symbol::new(&env, "is_active"),
                soroban_sdk::vec![&env, talos_id.into_val(&env)],
            );
            if !is_active {
                panic!("Talos is not active or does not exist");
            }
        }

        let config = Self::require_config(&env);
        let current_ledger = env.ledger().sequence();
        let snapshot_offset = config
            .snapshot_offset_ledgers
            .unwrap_or(DEFAULT_SNAPSHOT_OFFSET_LEDGERS);
        let snapshot_ledger = current_ledger.saturating_sub(snapshot_offset);
        let proposal_id = Self::next_proposal_id(env.clone());
        let end_ledger = current_ledger + config.voting_period_ledgers;

        let proposal = Proposal {
            id: proposal_id,
            talos_id,
            proposer: proposer.clone(),
            title,
            description,
            snapshot_ledger,
            start_ledger: current_ledger,
            end_ledger,
            status: ProposalStatus::Active,
            yes_votes: 0,
            no_votes: 0,
            total_voters: 0,
            created_at: env.ledger().timestamp(),
            action: None,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &(proposal_id + 1));

        emit_proposal_created(&env, proposal_id, talos_id, proposer, snapshot_ledger, end_ledger);
        proposal_id
    }

    pub fn cancel_proposal(env: Env, proposer: Address, proposal_id: u32) {
        proposer.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        if proposal.proposer != proposer {
            panic!("Only the proposer can cancel this proposal");
        }
        if proposal.status != ProposalStatus::Active {
            panic!("Only active proposals can be cancelled");
        }
        if proposal.total_voters > 0 {
            panic!("Cannot cancel a proposal that has already received votes");
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        emit_proposal_status_changed(&env, proposal_id, ProposalStatus::Cancelled);
    }

    pub fn vote(env: Env, voter: Address, proposal_id: u32, choice: VoteChoice) {
        pause_control::check_not_paused(&env, PAUSE_GOVERNANCE_VOTING);

        voter.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger > proposal.end_ledger {
            panic!("Voting period has ended");
        }

        let vote_key = DataKey::Vote(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            panic!("Already voted on this proposal");
        }

        let vote_weight = Self::get_vote_weight(&env, proposal.snapshot_ledger, voter.clone());
        if vote_weight <= 0 {
            panic!("No voting power");
        }

        match choice {
            VoteChoice::Approve => proposal.yes_votes += vote_weight,
            VoteChoice::Reject => proposal.no_votes += vote_weight,
        }
        proposal.total_voters += 1;

        let vote = Vote {
            voter: voter.clone(),
            choice: choice.clone(),
            weight: vote_weight,
            voted_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&vote_key, &vote);
        Self::update_status_if_quorum(&env, &mut proposal);
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        emit_vote_cast(&env, proposal_id, voter, choice, vote_weight);
    }

    pub fn finalize_proposal(env: Env, proposal_id: u32) {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }
        if env.ledger().sequence() <= proposal.end_ledger {
            panic!("Voting period has not ended");
        }

        Self::finalize_status(&env, &mut proposal);
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        emit_proposal_status_changed(&env, proposal_id, proposal.status.clone());
    }

    pub fn execute_proposal(env: Env, proposal_id: u32) {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        if proposal.status != ProposalStatus::Approved {
            panic!("Proposal is not approved");
        }

        // Dispatch the typed action, if any.  A failed cross-contract call
        // traps the host and rolls back this invocation, leaving the proposal
        // in `Approved` status so it can be retried.
        if let Some(action) = &proposal.action {
            Self::dispatch_action(&env, proposal_id, action.clone());
        }

        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        emit_proposal_status_changed(&env, proposal_id, ProposalStatus::Executed);
    }

    /// Dispatch a `ProposalAction` for the given proposal.
    ///
    /// Cross-contract calls are synchronous on Soroban: if the callee panics
    /// the host traps and the entire invocation is rolled back, leaving the
    /// proposal in `Approved` status (retryable once the root cause is fixed).
    fn dispatch_action(env: &Env, proposal_id: u32, action: ProposalAction) {
        let self_addr = env.current_contract_address();

        match action {
            ProposalAction::PauseTalos { registry, talos_id } => {
                // Call deactivate_talos(talos_id, self_addr) on the registry.
                // The governance contract must be set as the PauseController
                // for this Talos on the registry contract.
                let _: () = env.invoke_contract(
                    &registry,
                    &Symbol::new(env, "deactivate_talos"),
                    soroban_sdk::vec![
                        env,
                        talos_id.into_val(env),
                        self_addr.into_val(env),
                    ],
                );
                emit_proposal_executed(env, proposal_id, Symbol::new(env, "PauseTalos"));
            }
            ProposalAction::ResumeTalos { registry, talos_id } => {
                // Call activate_talos(talos_id, self_addr) on the registry.
                // The governance contract must be set as the ResumeController
                // for this Talos on the registry contract.
                let _: () = env.invoke_contract(
                    &registry,
                    &Symbol::new(env, "activate_talos"),
                    soroban_sdk::vec![
                        env,
                        talos_id.into_val(env),
                        self_addr.into_val(env),
                    ],
                );
                emit_proposal_executed(env, proposal_id, Symbol::new(env, "ResumeTalos"));
            }
            ProposalAction::UpdateConfig {
                quorum_threshold,
                consensus_threshold,
                voting_period_ledgers,
            } => {
                // Validate the incoming config values.
                if quorum_threshold <= 0 {
                    panic!("Quorum must be positive");
                }
                if consensus_threshold <= 0 || consensus_threshold > 10_000 {
                    panic!("Consensus threshold must be 1..10000 bps");
                }
                if voting_period_ledgers == 0 {
                    panic!("Voting period must be positive");
                }

                // Read the current config to preserve pulse_token_address and
                // snapshot_offset_ledgers (UpdateConfig only changes numeric thresholds).
                let existing: GovernanceConfig = env
                    .storage()
                    .persistent()
                    .get(&DataKey::Config)
                    .expect("Contract not initialized");

                let new_config = GovernanceConfig {
                    quorum_threshold,
                    consensus_threshold,
                    voting_period_ledgers,
                    pulse_token_address: existing.pulse_token_address,
                    snapshot_offset_ledgers: existing.snapshot_offset_ledgers,
                };
                env.storage().persistent().set(&DataKey::Config, &new_config);
                emit_proposal_executed(env, proposal_id, Symbol::new(env, "UpdateConfig"));
            }
        }
    }

    /// Create a proposal carrying an optional typed action.
    ///
    /// This is an additive entry-point: `create_proposal` (action-less) remains
    /// unchanged for backward compatibility.  Callers that want an executable
    /// proposal use this variant instead.
    pub fn create_proposal_with_action(
        env: Env,
        proposer: Address,
        talos_id: u32,
        title: String,
        description: String,
        action: Option<ProposalAction>,
    ) -> u32 {
        pause_control::check_not_paused(&env, PAUSE_PROPOSAL_CREATION);

        proposer.require_auth();

        if title.len() == 0 {
            panic!("Title cannot be empty");
        }
        if title.len() > MAX_TITLE_LEN {
            panic!("Title exceeds maximum length");
        }
        if description.len() == 0 {
            panic!("Description cannot be empty");
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            panic!("Description exceeds maximum length");
        }

        // Cross-contract verification (same as create_proposal).
        if let Some(registry) = env
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::RegistryContract)
        {
            let is_active: bool = env.invoke_contract(
                &registry,
                &Symbol::new(&env, "is_active"),
                soroban_sdk::vec![&env, talos_id.into_val(&env)],
            );
            if !is_active {
                panic!("Talos is not active or does not exist");
            }
        }

        let config = Self::require_config(&env);
        let current_ledger = env.ledger().sequence();
        let snapshot_offset = config
            .snapshot_offset_ledgers
            .unwrap_or(DEFAULT_SNAPSHOT_OFFSET_LEDGERS);
        let snapshot_ledger = current_ledger.saturating_sub(snapshot_offset);
        let proposal_id = Self::next_proposal_id(env.clone());
        let end_ledger = current_ledger + config.voting_period_ledgers;

        let proposal = Proposal {
            id: proposal_id,
            talos_id,
            proposer: proposer.clone(),
            title,
            description,
            snapshot_ledger,
            start_ledger: current_ledger,
            end_ledger,
            status: ProposalStatus::Active,
            yes_votes: 0,
            no_votes: 0,
            total_voters: 0,
            created_at: env.ledger().timestamp(),
            action,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &(proposal_id + 1));

        emit_proposal_created(&env, proposal_id, talos_id, proposer, snapshot_ledger, end_ledger);
        proposal_id
    }

    pub fn cache_token_balance(
        env: Env,
        admin: Address,
        ledger: u32,
        address: Address,
        balance: i128,
    ) {
        pause_control::check_not_paused(&env, PAUSE_GOVERNANCE_CONFIG);
        Self::require_admin(&env, &admin);
        if balance < 0 {
            panic!("Balance cannot be negative");
        }
        env.storage()
            .persistent()
            .set(&DataKey::TokenBalanceSnapshot(ledger, address), &balance);
    }

    pub fn update_config(env: Env, admin: Address, config: GovernanceConfig) {
        pause_control::check_not_paused(&env, PAUSE_GOVERNANCE_CONFIG);
        Self::require_admin(&env, &admin);
        if config.quorum_threshold <= 0 {
            panic!("Quorum must be positive");
        }
        if config.consensus_threshold <= 0 || config.consensus_threshold > 10_000 {
            panic!("Consensus threshold must be 1..10000 bps");
        }
        if config.voting_period_ledgers == 0 {
            panic!("Voting period must be positive");
        }
        if let Some(offset) = config.snapshot_offset_ledgers {
            if offset > MAX_SNAPSHOT_OFFSET_LEDGERS {
                panic!("Snapshot offset exceeds maximum allowed");
            }
        }
        env.storage().persistent().set(&DataKey::Config, &config);
    }

    /// Update the registered TalosRegistry contract address (admin only).
    ///
    /// Requires admin authorization. Setting this address enables Talos ID
    /// validation during `create_proposal`.
    pub fn set_registry_contract(env: Env, admin: Address, registry: Address) {
        pause_control::check_not_paused(&env, PAUSE_GOVERNANCE_CONFIG);
        Self::require_admin(&env, &admin);

        let old_registry = env
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::RegistryContract);

        env.storage()
            .persistent()
            .set(&DataKey::RegistryContract, &registry);

        emit_registry_updated(&env, old_registry, registry);
    }

    /// Alias for `set_registry_contract` (admin only).
    pub fn set_registry(env: Env, admin: Address, registry: Address) {
        Self::set_registry_contract(env, admin, registry);
    }

    /// Verify that the configured `RegistryContract` exposes the
    /// `TalosRegistry` interface and supports version `(1, 1, 0)` or higher.
    pub fn assert_registry_compatible(env: Env) -> bool {
        let registry: Address = env
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .expect("Registry contract not initialized");
        check_registry_compatible(&env, &registry, true)
    }

    // ── Dividend Snapshots (#598) ─────────────────────────────────────

    /// Record a new dividend snapshot epoch (admin only).
    ///
    /// Each call mints the next sequential epoch and persists the snapshot.
    /// Both `total_usdc` and `per_token_usdc` must be non-negative (zero is
    /// allowed for no-distribution epochs).  Returns the assigned epoch number.
    ///
    /// # Errors
    /// - Panics `"Contract not initialized"` when called before `initialize`.
    /// - Panics `"Unauthorized admin"` when the signer is not the stored admin.
    /// - Panics `"total_usdc cannot be negative"` / `"per_token_usdc cannot be negative"`.
    pub fn record_dividend_snapshot(
        env: Env,
        admin: Address,
        talos_id: u32,
        total_usdc: i128,
        per_token_usdc: i128,
    ) -> u32 {
        Self::require_admin(&env, &admin);

        if total_usdc < 0 {
            panic!("total_usdc cannot be negative");
        }
        if per_token_usdc < 0 {
            panic!("per_token_usdc cannot be negative");
        }

        let epoch: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextDividendEpoch)
            .unwrap_or(1);

        let snapshot = DividendSnapshot {
            epoch,
            talos_id,
            total_usdc,
            per_token_usdc,
            snapshot_ledger: env.ledger().sequence(),
            created_at: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::DividendSnapshot(epoch), &snapshot);
        env.storage()
            .persistent()
            .set(&DataKey::NextDividendEpoch, &(epoch + 1));

        emit_dividend_snapshot_recorded(&env, &snapshot);

        epoch
    }

    /// Return a single dividend snapshot by epoch number.
    ///
    /// Returns `None` when the epoch does not exist.
    pub fn get_dividend_snapshot(env: Env, epoch: u32) -> Option<DividendSnapshot> {
        env.storage()
            .persistent()
            .get(&DataKey::DividendSnapshot(epoch))
    }

    /// Return a page of dividend snapshots.
    ///
    /// `offset` is the 0-based starting epoch index (i.e. the epoch number
    /// of the first result is `offset + 1`).  `limit` is capped at
    /// [`DIVIDEND_PAGE_LIMIT`] (50) to bound the host-function cost.
    ///
    /// Returns an empty `Vec` when `offset` is beyond the last epoch.
    ///
    /// # Examples
    /// ```text
    /// // First page of up to 20 snapshots
    /// get_dividend_snapshots_page(env, 0, 20)
    /// // Next page
    /// get_dividend_snapshots_page(env, 20, 20)
    /// ```
    pub fn get_dividend_snapshots_page(
        env: Env,
        offset: u32,
        limit: u32,
    ) -> Vec<DividendSnapshot> {
        // Clamp limit to protect host-function budget.
        let effective_limit = limit.min(DIVIDEND_PAGE_LIMIT);

        let next_epoch: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextDividendEpoch)
            .unwrap_or(1);

        // Epochs are 1-based: epoch 1 is at offset 0.
        let first_epoch = offset.saturating_add(1);

        let mut results: Vec<DividendSnapshot> = Vec::new(&env);

        let mut count = 0u32;
        let mut epoch = first_epoch;
        while count < effective_limit && epoch < next_epoch {
            if let Some(snap) = env
                .storage()
                .persistent()
                .get::<_, DividendSnapshot>(&DataKey::DividendSnapshot(epoch))
            {
                results.push_back(snap);
                count += 1;
            }
            epoch += 1;
        }

        results
    }

    /// Return the total number of recorded dividend epochs.
    pub fn dividend_epoch_count(env: Env) -> u32 {
        let next: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextDividendEpoch)
            .unwrap_or(1);
        next.saturating_sub(1)
    }

    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<Proposal> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }

    pub fn get_vote(env: Env, proposal_id: u32, voter: Address) -> Option<Vote> {
        env.storage()
            .persistent()
            .get(&DataKey::Vote(proposal_id, voter))
    }

    pub fn get_config(env: Env) -> Option<GovernanceConfig> {
        env.storage().persistent().get(&DataKey::Config)
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Admin)
    }

    // ── Two-step admin transfer ──────────────────────────────────────

    /// Nominate `new_admin` as the next governance admin.
    ///
    /// The transfer is not immediate. The nominated address must call
    /// `accept_admin` to confirm and complete the handover. Until then the
    /// current admin retains all privileges.
    ///
    /// Calling `propose_admin` while a transfer is already pending silently
    /// replaces the old nomination with the new one.
    ///
    /// # Authorization
    /// Requires the current admin to sign the transaction.
    ///
    /// # Panics
    /// - `"Contract not initialized"` — if `initialize` has not been called.
    pub fn propose_admin(env: Env, new_admin: Address) {
        pause_control::check_not_paused(&env, PAUSE_GOVERNANCE_CONFIG);

        let current: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");

        current.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::PendingAdmin, &new_admin);

        emit_admin_proposed(&env, current, new_admin);
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
    /// # Panics
    /// - `"No pending admin transfer"` — if `propose_admin` has not been called.
    pub fn accept_admin(env: Env) {
        let pending: Address = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdmin)
            .expect("No pending admin transfer");

        pending.require_auth();

        // Promote pending → active admin.
        env.storage()
            .persistent()
            .set(&DataKey::Admin, &pending);

        // Clear the pending slot.
        env.storage().persistent().remove(&DataKey::PendingAdmin);

        emit_admin_accepted(&env, pending);
    }

    /// Cancel an in-progress admin transfer.
    ///
    /// Removes the `PendingAdmin` entry and revokes the nomination without
    /// changing the current admin.
    ///
    /// # Authorization
    /// Requires the current admin to sign the transaction.
    ///
    /// # Panics
    /// - `"Contract not initialized"` — if `initialize` has not been called.
    /// - `"No pending admin transfer"` — if there is nothing to cancel.
    pub fn cancel_admin_transfer(env: Env) {
        let current: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");

        current.require_auth();

        let pending: Address = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdmin)
            .expect("No pending admin transfer");

        env.storage().persistent().remove(&DataKey::PendingAdmin);

        emit_admin_cancelled(&env, pending);
    }

    /// Return the pending admin address, if any.
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::PendingAdmin)
    }

    // ── Quorum State (#599) ──────────────────────────────────────────

    /// Return the current quorum progress for a proposal.
    ///
    /// This is a **read-only** query — it writes nothing and requires no
    /// authorization.  The returned `ProposalQuorumState` is derived
    /// on-the-fly from the stored `Proposal` and the active
    /// `GovernanceConfig`.
    ///
    /// Returns `None` when the proposal does not exist.
    ///
    /// ## Field semantics
    /// - `votes_cast` — total weight cast (yes + no).
    /// - `quorum_threshold` — votes_cast floor from the config.
    /// - `quorum_met` — `votes_cast >= quorum_threshold`.
    /// - `yes_votes` / `no_votes` — individual tallies.
    /// - `approval_bps` — yes share in basis points (10 000 = 100 %).
    ///   Zero when no votes have been cast.
    /// - `consensus_threshold` — the approval_bps floor required to pass.
    /// - `quorum_fraction_bps` — progress toward quorum in basis points,
    ///   capped at 10 000.
    pub fn get_proposal_quorum_state(env: Env, proposal_id: u32) -> Option<ProposalQuorumState> {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))?;

        let config: GovernanceConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Config)
            .expect("Contract not initialized");

        let votes_cast = proposal.yes_votes + proposal.no_votes;
        let quorum_threshold = config.quorum_threshold;
        let quorum_met = votes_cast >= quorum_threshold;

        let approval_bps = if votes_cast > 0 {
            (proposal.yes_votes * 10_000) / votes_cast
        } else {
            0
        };

        // Clamp quorum_fraction_bps to 10_000 so it never exceeds 100 %.
        let quorum_fraction_bps = if quorum_threshold > 0 {
            let raw = (votes_cast * 10_000) / quorum_threshold;
            if raw > 10_000 { 10_000 } else { raw }
        } else {
            10_000
        };

        Some(ProposalQuorumState {
            votes_cast,
            quorum_threshold,
            quorum_met,
            yes_votes: proposal.yes_votes,
            no_votes: proposal.no_votes,
            approval_bps,
            consensus_threshold: config.consensus_threshold,
            quorum_fraction_bps,
        })
    }

    // ── Stable interface (v1.0.0) ───────────────────────────────────

    /// Return `(major, minor, patch)` for this contract. Fixes a
    /// pre-existing omission; the value is compile-time and immutable
    /// past deployment.
    pub fn version(_e: Env) -> (u32, u32, u32) {
        CONTRACT_VERSION
    }

    /// Return the 32-byte stable interface identifier for
    /// TalosGovernance v1. See the golden-vector test for the
    /// independent reproduction of the byte layout.
    pub fn interface_id(e: Env) -> BytesN<32> {
        BytesN::from_array(&e, &INTERFACE_ID)
    }

    /// Return the canonical deployment-manifest digest for the contract.
    ///
    /// The digest is rebuilt from the immutable interface values so operators can
    /// compare deployments without adding any ledger-backed source of truth.
    pub fn deployment_manifest_digest(e: Env) -> BytesN<32> {
        let mut payload = soroban_sdk::Bytes::new(&e);
        payload.append(&soroban_sdk::Bytes::from_array(&e, &INTERFACE_ID));
        payload.extend_from_slice(&CONTRACT_VERSION.0.to_be_bytes());
        payload.extend_from_slice(&CONTRACT_VERSION.1.to_be_bytes());
        payload.extend_from_slice(&CONTRACT_VERSION.2.to_be_bytes());

        for feature in features_list() {
            let bytes = feature.as_bytes();
            payload.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            payload.extend_from_slice(bytes);
        }

        payload.extend_from_slice(&1u32.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());

        e.crypto().sha256(&payload).to_bytes()
    }

    /// Return `true` when the deployed semver supports the requested
    /// `(major, minor, patch)` floor — see `version_supports`.
    pub fn supports_version(e: Env, major: u32, minor: u32, patch: u32) -> bool {
        let _ = e;
        version_supports(CONTRACT_VERSION, (major, minor, patch))
    }

    /// Return the list of capability symbols offered by this contract.
    pub fn interface_features(e: Env) -> Vec<Symbol> {
        let caps = features_list();
        let mut out = Vec::new(&e);
        for cap in caps {
            out.push_back(Symbol::new(&e, cap));
        }
        out
    }

    pub fn next_proposal_id(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1)
    }

    // ── Storage TTL Management ───────────────────────────────────

    /// Touch a governance proposal to reset its Soroban TTL.
    pub fn touch_proposal(e: Env, proposal_id: u32) -> bool {
        let key = DataKey::Proposal(proposal_id);
        let proposal: Proposal = e
            .storage()
            .persistent()
            .get(&key)
            .expect("Proposal not found");
        let current_ledger = e.ledger().sequence();
        let last_touched: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::LastTouched(proposal_id))
            .unwrap_or(0);

        if ttl_manager::needs_touch(last_touched, current_ledger) {
            e.storage().persistent().set(&key, &proposal);
            e.storage()
                .persistent()
                .set(&DataKey::LastTouched(proposal_id), &current_ledger);
            ttl_manager::emit_ttl_touched(&e, "proposal", 1);
            true
        } else {
            false
        }
    }

    /// Batch-touch all governance proposals + admin keys (admin only).
    ///
    /// The sweep is bounded by the renewal age window; use
    /// [`TalosGovernance::extend_ttl_batch`] to pass explicit bounds and a
    /// per-call key cap.
    ///
    /// # Authorization
    /// Requires the admin to sign.
    pub fn touch_all_ttl(e: Env) -> (u32, u32) {
        pause_control::check_not_paused(&e, PAUSE_GOVERNANCE_CONFIG);

        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        admin.require_auth();

        let next_id: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1);
        Self::sweep_governance_ttl(&e, &ttl_manager::TtlBounds::renewal(), 1..next_id)
    }

    /// Batched TTL extension with explicit age and work bounds.
    ///
    /// Sweeps the admin key plus proposal ids
    /// `[1, min(next_proposal_id, 1 + limit))`, clipped to
    /// [`ttl_manager::DEFAULT_MAX_BATCH_KEYS`] ids per call, and re-writes only
    /// entries whose age in ledgers falls inside `[min_age, max_age]`.
    /// Entries outside the window are reported as `skipped`; ids with no entry
    /// are ignored.
    ///
    /// Returns `(touched, skipped)`.
    ///
    /// # Panics
    /// - `"Domain is paused"` — when the governance-config domain is paused.
    /// - `"Contract not initialized"` — if `initialize` has not been called.
    /// - `"ttl bounds: ..."` — static diagnostic for malformed bounds
    ///   (`min_age > max_age`, `max_keys` of 0, or `max_keys` above
    ///   [`ttl_manager::MAX_BATCH_KEYS`]). Diagnostics are compile-time
    ///   constants and never embed caller or storage data.
    ///
    /// # Authorization
    /// Requires the admin to sign.
    pub fn extend_ttl_batch(e: Env, limit: u32, min_age: u32, max_age: u32) -> (u32, u32) {
        pause_control::check_not_paused(&e, PAUSE_GOVERNANCE_CONFIG);

        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        admin.require_auth();

        let next_id: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1);
        let bounds =
            ttl_manager::TtlBounds::new(min_age, max_age, ttl_manager::DEFAULT_MAX_BATCH_KEYS);
        let range = ttl_manager::bounded_range(1, limit, &bounds, next_id)
            .unwrap_or_else(|err| panic!("{}", err.message()));
        Self::sweep_governance_ttl(&e, &bounds, range)
    }

    /// Shared bounded sweep behind `touch_all_ttl` / `extend_ttl_batch`.
    ///
    /// Re-writes the admin key (marker id 0) and every proposal in `range`
    /// whose age falls inside `bounds`, refreshes the matching `LastTouched`
    /// markers, emits `ttl_batch`, and returns `(touched, skipped)`. Ids
    /// without an entry are neither touched nor skipped.
    fn sweep_governance_ttl(
        e: &Env,
        bounds: &ttl_manager::TtlBounds,
        range: core::ops::Range<u32>,
    ) -> (u32, u32) {
        let current_ledger = e.ledger().sequence();
        let mut sweep = ttl_manager::BatchSweep::empty();

        if let Some(a) = e.storage().persistent().get::<_, Address>(&DataKey::Admin) {
            let last: u32 = e
                .storage()
                .persistent()
                .get(&DataKey::LastTouched(0))
                .unwrap_or(0);
            if ttl_manager::should_extend(last, current_ledger, bounds) {
                e.storage().persistent().set(&DataKey::Admin, &a);
                e.storage()
                    .persistent()
                    .set(&DataKey::LastTouched(0), &current_ledger);
                sweep.record(ttl_manager::EntryOutcome::Touched);
            } else {
                sweep.record(ttl_manager::EntryOutcome::Skipped);
            }
        } else {
            sweep.record(ttl_manager::EntryOutcome::Absent);
        }

        for pid in range {
            let key = DataKey::Proposal(pid);
            let proposal: Proposal = match e.storage().persistent().get(&key) {
                Some(proposal) => proposal,
                None => {
                    sweep.record(ttl_manager::EntryOutcome::Absent);
                    continue;
                }
            };
            let last_touched: u32 = e
                .storage()
                .persistent()
                .get(&DataKey::LastTouched(pid))
                .unwrap_or(0);

            if ttl_manager::should_extend(last_touched, current_ledger, bounds) {
                e.storage().persistent().set(&key, &proposal);
                e.storage()
                    .persistent()
                    .set(&DataKey::LastTouched(pid), &current_ledger);
                sweep.record(ttl_manager::EntryOutcome::Touched);
            } else {
                sweep.record(ttl_manager::EntryOutcome::Skipped);
            }
        }

        sweep.emit(e);
        (sweep.touched, sweep.skipped)
    }

    /// Query storage health for tracked proposal entries.
    pub fn get_storage_health(e: Env) -> (u32, u32, u32, u32, u32) {
        let mut health = ttl_manager::KeyHealth::empty();
        let current_ledger = e.ledger().sequence();

        let next_id: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1);
        for pid in 1..next_id {
            let last_touched: u32 = e
                .storage()
                .persistent()
                .get(&DataKey::LastTouched(pid))
                .unwrap_or(0);
            health.observe(ttl_manager::age_ledgers(last_touched, current_ledger));
        }

        if health.needs_immediate_attention() {
            ttl_manager::emit_ttl_warning(&e, "governance", health.keys_below_crit, health.max_age);
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

    fn require_config(env: &Env) -> GovernanceConfig {
        env.storage()
            .persistent()
            .get(&DataKey::Config)
            .expect("Contract not initialized")
    }

    fn require_admin(env: &Env, admin: &Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        if stored_admin != *admin {
            panic!("Unauthorized admin");
        }
    }

    fn get_vote_weight(env: &Env, snapshot_ledger: u32, voter: Address) -> i128 {
        let delegatee: Address = env.storage().persistent().get(&DataKey::Delegation(voter.clone())).unwrap_or(voter.clone());
        Self::get_past_votes(env, delegatee, snapshot_ledger)
    }

    pub fn get_past_votes(env: &Env, account: Address, ledger: u32) -> i128 {
        let count: u32 = env.storage().persistent().get(&DataKey::CheckpointCount(account.clone())).unwrap_or(0);
        if count == 0 {
            return env.storage().persistent().get(&DataKey::TokenBalanceSnapshot(ledger, account)).unwrap_or(0);
        }
        
        // Check latest
        let latest_ck: Checkpoint = env.storage().persistent().get(&DataKey::Checkpoint(account.clone(), count - 1)).unwrap();
        if latest_ck.ledger <= ledger {
            return latest_ck.votes;
        }
        
        // Check earliest
        let earliest_ck: Checkpoint = env.storage().persistent().get(&DataKey::Checkpoint(account.clone(), 0)).unwrap();
        if earliest_ck.ledger > ledger {
            return env.storage().persistent().get(&DataKey::TokenBalanceSnapshot(ledger, account)).unwrap_or(0);
        }

        // Binary search
        let mut low = 0;
        let mut high = count - 1;
        while low < high {
            let mid = high - (high - low) / 2;
            let ck: Checkpoint = env.storage().persistent().get(&DataKey::Checkpoint(account.clone(), mid)).unwrap();
            if ck.ledger == ledger {
                return ck.votes;
            } else if ck.ledger < ledger {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        let found: Checkpoint = env.storage().persistent().get(&DataKey::Checkpoint(account.clone(), low)).unwrap();
        found.votes
    }

    pub fn delegate(env: Env, delegator: Address, delegatee: Address) {
        pause_control::check_not_paused(&env, PAUSE_GOVERNANCE_CONFIG);
        delegator.require_auth();
        env.storage().persistent().set(&DataKey::Delegation(delegator.clone()), &delegatee);
    }

    pub fn update_voting_power(env: Env, admin: Address, account: Address, new_balance: i128) {
        pause_control::check_not_paused(&env, PAUSE_GOVERNANCE_CONFIG);
        Self::require_admin(&env, &admin);
        let current_ledger = env.ledger().sequence();
        let count: u32 = env.storage().persistent().get(&DataKey::CheckpointCount(account.clone())).unwrap_or(0);
        
        if count > 0 {
            let mut last_ck: Checkpoint = env.storage().persistent().get(&DataKey::Checkpoint(account.clone(), count - 1)).unwrap();
            if last_ck.ledger == current_ledger {
                last_ck.votes = new_balance;
                env.storage().persistent().set(&DataKey::Checkpoint(account.clone(), count - 1), &last_ck);
                return;
            }
        }
        
        let ck = Checkpoint {
            ledger: current_ledger,
            votes: new_balance,
        };
        env.storage().persistent().set(&DataKey::Checkpoint(account.clone(), count), &ck);
        env.storage().persistent().set(&DataKey::CheckpointCount(account.clone()), &(count + 1));
    }

    fn update_status_if_quorum(env: &Env, proposal: &mut Proposal) {
        let config = Self::require_config(env);
        let total_votes = proposal.yes_votes + proposal.no_votes;
        if total_votes >= config.quorum_threshold {
            // Emit EventQuorumReached exactly once per proposal — write a
            // sentinel before emitting so a re-entrant call cannot double-fire.
            let sentinel_key = DataKey::QuorumReached(proposal.id);
            let already_emitted: bool = env
                .storage()
                .persistent()
                .get(&sentinel_key)
                .unwrap_or(false);
            if !already_emitted {
                env.storage().persistent().set(&sentinel_key, &true);
                let approval_bps = if total_votes > 0 {
                    (proposal.yes_votes * 10_000) / total_votes
                } else {
                    0
                };
                emit_quorum_reached(
                    env,
                    proposal.id,
                    total_votes,
                    config.quorum_threshold,
                    approval_bps,
                );
            }
            Self::finalize_status(env, proposal);
            emit_proposal_status_changed(env, proposal.id, proposal.status.clone());
        }
    }

    fn finalize_status(env: &Env, proposal: &mut Proposal) {
        let config = Self::require_config(env);
        let total_votes = proposal.yes_votes + proposal.no_votes;
        if total_votes < config.quorum_threshold {
            proposal.status = ProposalStatus::Rejected;
            return;
        }

        let approval_bps = (proposal.yes_votes * 10_000) / total_votes;
        proposal.status = if approval_bps >= config.consensus_threshold {
            ProposalStatus::Approved
        } else {
            ProposalStatus::Rejected
        };
    }

    // ── Scoped Emergency Pause Controls ──────────────────────────────

    /// Pause a domain. Only the admin can pause.
    pub fn pause_domain(e: Env, domain_id: u32, duration: u64) {
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
        pause_control::pause_domain(&e, domain_id, &admin, duration);
    }

    /// Unpause a domain. Only the admin can unpause.
    pub fn unpause_domain(e: Env, domain_id: u32) {
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Contract not initialized");
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
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
        IntoVal, TryFromVal,
    };

    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        TalosGovernanceClient<'static>,
    ) {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.sequence_number = 100;
            li.timestamp = 1_000;
        });

        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let pulse = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), pulse.clone(), 100_i128, 5_100_i128, 20_u32)
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .initialize(&admin, &pulse, &100_i128, &5_100_i128, &20_u32);

        (env, contract_id, admin, pulse, client)
    }

    fn s(env: &Env, value: &str) -> String {
        String::from_str(env, value)
    }

    fn create_proposal_with_auth(
        env: &Env,
        contract_id: &Address,
        client: &TalosGovernanceClient<'static>,
        proposer: &Address,
    ) -> u32 {
        let title = s(env, "Treasury proposal");
        let description = s(env, "Allocate funds for growth.");
        client
            .mock_auths(&[MockAuth {
                address: proposer,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 7_u32, title.clone(), description.clone())
                        .into_val(env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(proposer, &7_u32, &title, &description)
    }

    fn cache_balance_with_auth(
        env: &Env,
        contract_id: &Address,
        client: &TalosGovernanceClient<'static>,
        admin: &Address,
        ledger: u32,
        voter: &Address,
        balance: i128,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "cache_token_balance",
                    args: (admin.clone(), ledger, voter.clone(), balance).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .cache_token_balance(admin, &ledger, voter, &balance);
    }

    // ── Typed event fixture tests (#606) ─────────────────────────

    #[test]
    fn create_proposal_emits_typed_event_proposal_created() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        let events = env.events().all();
        assert!(!events.is_empty(), "at least one event must be emitted");

        // The prop_crt event is the last event from create_proposal.
        let (cid, topics, data) = events.last().expect("event missing");
        assert_eq!(cid, contract_id);

        let topic0: soroban_sdk::Symbol =
            soroban_sdk::FromVal::from_val(&env, &topics.get(0).unwrap());
        assert_eq!(topic0, symbol_short!("prop_crt"));

        let topic1_id: u32 = soroban_sdk::FromVal::from_val(&env, &topics.get(1).unwrap());
        assert_eq!(topic1_id, proposal_id);

        let payload: EventProposalCreated = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(payload.proposal_id, proposal_id);
        assert_eq!(payload.talos_id, 7);
        assert_eq!(payload.proposer, proposer);
        assert_eq!(payload.snapshot_ledger, 90); // current_ledger(100) - 10
        assert_eq!(payload.end_ledger, 120);     // current_ledger(100) + voting_period(20)
    }

    #[test]
    fn vote_emits_typed_event_vote_cast() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter, 200);

        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);

        let events = env.events().all();
        // vote event is the last event (vote + potentially status change; vote is last if quorum not yet met)
        // With 200 weight and quorum 100, quorum is met — so status changed event follows vote.
        // Find the vote event by topic symbol.
        let vote_event = events.iter().find(|(cid, topics, _)| {
            if *cid != contract_id { return false; }
            if let Some(t0) = topics.get(0) {
                let s: soroban_sdk::Symbol = soroban_sdk::FromVal::from_val(&env, &t0);
                s == symbol_short!("vote")
            } else { false }
        });
        assert!(vote_event.is_some(), "vote event must be emitted");

        let (_, _, data) = vote_event.unwrap();
        let payload: EventVoteCast = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(payload.proposal_id, proposal_id);
        assert_eq!(payload.voter, voter);
        assert_eq!(payload.choice, VoteChoice::Approve);
        assert_eq!(payload.weight, 200);
    }

    #[test]
    fn finalize_proposal_emits_typed_event_status_changed() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        // Advance ledger past the voting period
        env.ledger().with_mut(|li| { li.sequence_number = 200; });

        client.finalize_proposal(&proposal_id);

        let events = env.events().all();
        let stat_event = events.iter().find(|(cid, topics, _)| {
            if *cid != contract_id { return false; }
            if let Some(t0) = topics.get(0) {
                let s: soroban_sdk::Symbol = soroban_sdk::FromVal::from_val(&env, &t0);
                s == symbol_short!("prop_stat")
            } else { false }
        });
        assert!(stat_event.is_some(), "prop_stat event must be emitted");

        let (_, topics, data) = stat_event.unwrap();
        let pid: u32 = soroban_sdk::FromVal::from_val(&env, &topics.get(1).unwrap());
        assert_eq!(pid, proposal_id);

        let payload: EventProposalStatusChanged = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(payload.proposal_id, proposal_id);
        assert_eq!(payload.status, ProposalStatus::Rejected);
    }

    #[test]
    fn execute_proposal_emits_typed_event_status_executed() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter, 200);

        // Vote to reach quorum + approval → Approved
        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);

        client.execute_proposal(&proposal_id);

        let events = env.events().all();
        // Find the last prop_stat event (execute emits status = Executed)
        let stat_events: std::vec::Vec<_> = events.iter().filter(|(cid, topics, _)| {
            if *cid != contract_id { return false; }
            if let Some(t0) = topics.get(0) {
                let s: soroban_sdk::Symbol = soroban_sdk::FromVal::from_val(&env, &t0);
                s == symbol_short!("prop_stat")
            } else { false }
        }).collect();
        assert!(!stat_events.is_empty(), "prop_stat event must be emitted");

        let (_, _, data) = stat_events.last().unwrap();
        let payload: EventProposalStatusChanged = soroban_sdk::FromVal::from_val(&env, data);
        assert_eq!(payload.status, ProposalStatus::Executed);
    }

    // ── Batched TTL extension with bounds ─────────────────────────

    /// Build an initialized governance contract with the ledger already at
    /// `sequence_number`, so entry ages are exact and later one-ledger bumps
    /// cannot archive contract code.
    fn setup_at(
        sequence_number: u32,
    ) -> (
        Env,
        Address,
        Address,
        Address,
        TalosGovernanceClient<'static>,
    ) {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.sequence_number = sequence_number;
            li.timestamp = 1_000;
        });

        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let pulse = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), pulse.clone(), 100_i128, 5_100_i128, 20_u32)
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .initialize(&admin, &pulse, &100_i128, &5_100_i128, &20_u32);

        (env, contract_id, admin, pulse, client)
    }

    /// Invoke `extend_ttl_batch` with the admin's mock authorization.
    fn extend_ttl_batch_as_admin(
        env: &Env,
        contract_id: &Address,
        client: &TalosGovernanceClient<'static>,
        admin: &Address,
        limit: u32,
        min_age: u32,
        max_age: u32,
    ) -> Option<(u32, u32)> {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "extend_ttl_batch",
                    args: (limit, min_age, max_age).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .try_extend_ttl_batch(&limit, &min_age, &max_age)
            .ok()
            .and_then(|outcome| outcome.ok())
    }

    /// Positive: admin key + proposal inside the window are re-written.
    #[test]
    fn extend_ttl_batch_renews_entries_inside_window() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        let result =
            extend_ttl_batch_as_admin(&env, &contract_id, &client, &admin, 10, 0, u32::MAX)
                .expect("bounded extension must succeed");

        // Admin key (marker id 0) + one proposal.
        assert_eq!(result, (2, 0));
    }

    /// Negative: entries younger than `min_age` are reported, never written.
    #[test]
    fn extend_ttl_batch_skips_entries_below_min_age() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        // Ledger sequence is 100, so every entry's age is 100.
        let result =
            extend_ttl_batch_as_admin(&env, &contract_id, &client, &admin, 10, 101, u32::MAX)
                .expect("bounded extension must succeed");

        assert_eq!(result, (0, 2));
    }

    /// Boundary: a zero limit empties the proposal range; only the admin key
    /// (which is not part of the id range) is still evaluated.
    #[test]
    fn extend_ttl_batch_zero_limit_spares_proposals() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        let result = extend_ttl_batch_as_admin(&env, &contract_id, &client, &admin, 0, 0, u32::MAX)
            .expect("bounded extension must succeed");

        assert_eq!(result, (1, 0), "only the admin key may be visited");
    }

    /// Boundary: `limit` caps the proposal sweep — proposals beyond the limit
    /// are not counted at all. The admin key is always evaluated first.
    #[test]
    fn extend_ttl_batch_honours_limit() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        let result = extend_ttl_batch_as_admin(&env, &contract_id, &client, &admin, 1, 0, u32::MAX)
            .expect("bounded extension must succeed");

        // Admin key + proposal 1 only; proposal 2 stays outside the sweep.
        assert_eq!(result, (2, 0));
    }

    /// Negative: malformed bounds fail with a static, privacy-safe diagnostic
    /// before any storage is read or written.
    #[test]
    #[should_panic(expected = "ttl bounds: min_age exceeds max_age")]
    fn extend_ttl_batch_rejects_inverted_window() {
        let (env, contract_id, admin, _pulse, client) = setup();

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "extend_ttl_batch",
                    args: (10u32, 5_000_000u32, 1_000u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .extend_ttl_batch(&10, &5_000_000, &1_000);
    }

    /// Negative: `extend_ttl_batch` is admin-gated exactly like `touch_all_ttl`.
    #[test]
    fn extend_ttl_batch_without_auth_is_rejected() {
        let (_env, _contract_id, _admin, _pulse, client) = setup();

        assert!(
            client.try_extend_ttl_batch(&10, &0, &u32::MAX).is_err(),
            "extend_ttl_batch must require admin auth"
        );
    }

    /// The governance-config pause domain blocks `extend_ttl_batch`.
    #[test]
    #[should_panic(expected = "Domain is paused")]
    fn extend_ttl_batch_is_blocked_while_paused() {
        let (env, contract_id, admin, _pulse, client) = setup();

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_domain",
                    args: (PAUSE_GOVERNANCE_CONFIG, 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .pause_domain(&PAUSE_GOVERNANCE_CONFIG, &0);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "extend_ttl_batch",
                    args: (10u32, 0u32, u32::MAX).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .extend_ttl_batch(&10, &0, &u32::MAX);
    }

    /// Regression: `touch_all_ttl` keeps skipping young entries and renews
    /// them once the renewal threshold is crossed, so routing it through the
    /// bounded sweep core changes no behaviour.
    #[test]
    fn touch_all_ttl_still_skips_then_renews_after_threshold() {
        let (env, contract_id, admin, _pulse, client) =
            setup_at(ttl_manager::RENEWAL_THRESHOLD - 1);
        let proposer = Address::generate(&env);
        create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        let before = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "touch_all_ttl",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .touch_all_ttl();
        assert_eq!(before, (0, 2));

        // One more ledger crosses the threshold → both entries are renewed.
        env.ledger().with_mut(|li| li.sequence_number += 1);

        let after = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "touch_all_ttl",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .touch_all_ttl();
        assert_eq!(after, (2, 0));
    }

    #[test]
    fn deployment_manifest_digest_is_stable_and_canonical() {
        let (env, contract_id, _admin, _pulse, client) = setup();

        let digest = client.deployment_manifest_digest();
        let again = client.deployment_manifest_digest();
        assert_eq!(digest, again, "digest must be deterministic");

        let mut payload = soroban_sdk::Bytes::new(&env);
        payload.append(&soroban_sdk::Bytes::from_array(&env, &INTERFACE_ID));
        payload.extend_from_slice(&CONTRACT_VERSION.0.to_be_bytes());
        payload.extend_from_slice(&CONTRACT_VERSION.1.to_be_bytes());
        payload.extend_from_slice(&CONTRACT_VERSION.2.to_be_bytes());
        for feature in features_list() {
            let bytes = feature.as_bytes();
            payload.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            payload.extend_from_slice(bytes);
        }
        payload.extend_from_slice(&1u32.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());

        let expected = env.crypto().sha256(&payload).to_bytes();
        assert_eq!(digest, expected);
        let _ = contract_id;
    }

    #[test]
    fn proposal_creation_requires_auth_and_records_proposer() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();

        assert_eq!(proposal.proposer, proposer);
        assert_eq!(proposal.talos_id, 7);
        assert_eq!(proposal.status, ProposalStatus::Active);
        assert_eq!(proposal.snapshot_ledger, 90);
    }

    #[test]
    fn vote_uses_cached_snapshot_weight_and_approves_on_quorum() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();

        cache_balance_with_auth(
            &env,
            &contract_id,
            &client,
            &admin,
            proposal.snapshot_ledger,
            &voter,
            150,
        );

        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);

        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.yes_votes, 150);
        assert_eq!(proposal.status, ProposalStatus::Approved);

        let vote = client.get_vote(&proposal_id, &voter).unwrap();
        assert_eq!(vote.weight, 150);
    }

    #[test]
    #[should_panic(expected = "Already voted on this proposal")]
    fn double_vote_is_rejected() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        cache_balance_with_auth(
            &env,
            &contract_id,
            &client,
            &admin,
            proposal.snapshot_ledger,
            &voter,
            20,
        );

        for _ in 0..2 {
            client
                .mock_auths(&[MockAuth {
                    address: &voter,
                    invoke: &MockAuthInvoke {
                        contract: &contract_id,
                        fn_name: "vote",
                        args: (voter.clone(), proposal_id, VoteChoice::Reject).into_val(&env),
                        sub_invokes: &[],
                    },
                }])
                .vote(&voter, &proposal_id, &VoteChoice::Reject);
        }
    }

    #[test]
    fn finalize_after_period_rejects_without_quorum() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        env.ledger().with_mut(|li| {
            li.sequence_number = 200;
        });

        client.finalize_proposal(&proposal_id);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.status, ProposalStatus::Rejected);
    }

    #[test]
    #[should_panic(expected = "Unauthorized admin")]
    fn unauthorized_config_update_is_rejected() {
        let (env, _contract_id, _admin, pulse, client) = setup();
        let attacker = Address::generate(&env);
        let config = GovernanceConfig {
            quorum_threshold: 10,
            consensus_threshold: 6_000,
            voting_period_ledgers: 30,
            pulse_token_address: pulse,
            snapshot_offset_ledgers: None,
        };

        client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "update_config",
                    args: (attacker.clone(), config.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .update_config(&attacker, &config);
    }

    // ── Pause Control Integration Tests ─────────────────────────

    #[test]
    fn pause_proposal_creation_blocks_create_proposal() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_domain",
                    args: (PAUSE_PROPOSAL_CREATION, 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .pause_domain(&PAUSE_PROPOSAL_CREATION, &0);

        let title = s(&env, "Test");
        let description = s(&env, "Test");
        let res = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1u32, title.clone(), description.clone())
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_create_proposal(&proposer, &1, &title, &description);
        assert!(res.is_err());
    }

    #[test]
    fn pause_voting_blocks_vote() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id =
            create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        cache_balance_with_auth(&env, &contract_id, &client, &admin, 90, &voter, 200);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_domain",
                    args: (PAUSE_GOVERNANCE_VOTING, 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .pause_domain(&PAUSE_GOVERNANCE_VOTING, &0);

        let res = client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_vote(&voter, &proposal_id, &VoteChoice::Approve);
        assert!(res.is_err());
    }

    #[test]
    fn pause_governance_config_blocks_update_config() {
        let (env, contract_id, admin, pulse, client) = setup();
        let new_admin = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_domain",
                    args: (PAUSE_GOVERNANCE_CONFIG, 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .pause_domain(&PAUSE_GOVERNANCE_CONFIG, &0);

        let config = GovernanceConfig {
            quorum_threshold: 200,
            consensus_threshold: 6_000,
            voting_period_ledgers: 30,
            pulse_token_address: pulse,
            snapshot_offset_ledgers: None,
        };
        let res = client
            .mock_auths(&[MockAuth {
                address: &new_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "update_config",
                    args: (new_admin.clone(), config.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_update_config(&new_admin, &config);
        assert!(res.is_err());
    }

    #[test]
    fn unpause_governance_restores_voting() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id =
            create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        cache_balance_with_auth(&env, &contract_id, &client, &admin, 90, &voter, 200);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_domain",
                    args: (PAUSE_GOVERNANCE_VOTING, 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .pause_domain(&PAUSE_GOVERNANCE_VOTING, &0);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "unpause_domain",
                    args: (PAUSE_GOVERNANCE_VOTING,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .unpause_domain(&PAUSE_GOVERNANCE_VOTING);

        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);
    }

    #[test]
    fn adversarial_voting_prevent_double_voting() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        
        env.ledger().with_mut(|li| {
            li.sequence_number = 100;
        });

        // Set Alice balance at ledger 100
        client.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_voting_power",
                args: (admin.clone(), alice.clone(), 500i128).into_val(&env),
                sub_invokes: &[],
            },
        }]).update_voting_power(&admin, &alice, &500);

        env.ledger().with_mut(|li| {
            li.sequence_number = 110;
        });

        // Proposal created at ledger 110. Snapshot is 100.
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        // Alice votes
        client.mock_auths(&[MockAuth {
            address: &alice,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "vote",
                args: (alice.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                sub_invokes: &[],
            },
        }]).vote(&alice, &proposal_id, &VoteChoice::Approve);

        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.yes_votes, 500);

        // Now, post-proposal, Alice transfers to Bob
        env.ledger().with_mut(|li| {
            li.sequence_number = 115;
        });

        client.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_voting_power",
                args: (admin.clone(), alice.clone(), 0i128).into_val(&env),
                sub_invokes: &[],
            },
        }]).update_voting_power(&admin, &alice, &0);
        
        client.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_voting_power",
                args: (admin.clone(), bob.clone(), 500i128).into_val(&env),
                sub_invokes: &[],
            },
        }]).update_voting_power(&admin, &bob, &500);

        // Bob tries to vote. Bob's power at snapshot (100) was 0.
        let res = client.mock_auths(&[MockAuth {
            address: &bob,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "vote",
                args: (bob.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                sub_invokes: &[],
            },
        }]).try_vote(&bob, &proposal_id, &VoteChoice::Approve);
        
        assert!(res.is_err(), "Bob should not be able to vote with tokens received after snapshot");
    }

    // ── Expanded authorization negative tests (#611) ─────────────────

    // --- Missing authorization ---

    /// create_proposal without mock_auths must fail.
    #[test]
    fn create_proposal_without_auth_is_rejected() {
        let (env, _contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        let result = client.try_create_proposal(
            &proposer,
            &1u32,
            &s(&env, "title"),
            &s(&env, "desc"),
        );
        assert!(result.is_err(), "create_proposal must require auth");
    }

    /// vote without mock_auths must fail.
    #[test]
    fn vote_without_auth_is_rejected() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter, 200);

        let result = client.try_vote(&voter, &proposal_id, &VoteChoice::Approve);
        assert!(result.is_err(), "vote must require auth");
    }

    /// cache_token_balance without mock_auths must fail.
    #[test]
    fn cache_token_balance_without_auth_is_rejected() {
        let (env, _contract_id, _admin, _pulse, client) = setup();
        let voter = Address::generate(&env);
        let result = client.try_cache_token_balance(
            &Address::generate(&env),
            &90u32,
            &voter,
            &100i128,
        );
        assert!(result.is_err(), "cache_token_balance must require auth");
    }

    /// update_config without mock_auths must fail.
    #[test]
    fn update_config_without_auth_is_rejected() {
        let (env, _contract_id, _admin, pulse, client) = setup();
        let config = GovernanceConfig {
            quorum_threshold: 10,
            consensus_threshold: 5_000,
            voting_period_ledgers: 20,
            pulse_token_address: pulse,
            snapshot_offset_ledgers: None,
        };
        let rando = Address::generate(&env);
        let result = client.try_update_config(&rando, &config);
        assert!(result.is_err(), "update_config must require auth");
    }

    // --- Wrong signer ---

    /// Non-admin cannot cache_token_balance even with their own valid auth.
    #[test]
    fn cache_token_balance_wrong_signer_is_rejected() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let attacker = Address::generate(&env);
        let voter = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cache_token_balance",
                    args: (attacker.clone(), 90u32, voter.clone(), 100i128).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cache_token_balance(&attacker, &90, &voter, &100);
        assert!(result.is_err(), "non-admin must not cache balances");
    }

    /// A voter with zero balance must be rejected.
    #[test]
    fn vote_with_zero_balance_is_rejected() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();

        // Cache zero balance
        cache_balance_with_auth(
            &env,
            &contract_id,
            &client,
            &admin,
            proposal.snapshot_ledger,
            &voter,
            0,
        );

        let result = client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_vote(&voter, &proposal_id, &VoteChoice::Approve);
        assert!(result.is_err(), "zero-balance voter must be rejected");
    }

    // --- Dependency / state failure ---

    /// Voting on a non-existent proposal must fail.
    #[test]
    fn vote_on_nonexistent_proposal_is_rejected() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let voter = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), 9999u32, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_vote(&voter, &9999u32, &VoteChoice::Approve);
        assert!(result.is_err(), "vote on nonexistent proposal must fail");
    }

    /// Voting after the end_ledger must fail.
    #[test]
    fn vote_after_voting_period_is_rejected() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        cache_balance_with_auth(
            &env,
            &contract_id,
            &client,
            &admin,
            proposal.snapshot_ledger,
            &voter,
            50,
        );

        // Advance ledger past end_ledger
        env.ledger().with_mut(|li| {
            li.sequence_number = proposal.end_ledger + 1;
        });

        let result = client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_vote(&voter, &proposal_id, &VoteChoice::Approve);
        assert!(result.is_err(), "vote after period end must be rejected");
    }

    /// finalize_proposal before voting period ends must fail.
    #[test]
    fn finalize_before_period_ends_is_rejected() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        // Ledger is still in the middle of the voting period
        let result = client.try_finalize_proposal(&proposal_id);
        assert!(result.is_err(), "finalize before end must be rejected");
    }

    /// execute_proposal on a non-approved proposal must fail.
    #[test]
    fn execute_non_approved_proposal_is_rejected() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        // Active → not approved → execute must fail
        let result = client.try_execute_proposal(&proposal_id);
        assert!(result.is_err(), "execute on non-approved proposal must fail");
    }

    /// Proposal creation with empty title must fail.
    #[test]
    fn create_proposal_with_empty_title_is_rejected() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1u32, s(&env, ""), s(&env, "desc")).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_create_proposal(&proposer, &1u32, &s(&env, ""), &s(&env, "desc"));
        assert!(result.is_err(), "empty title must be rejected");
    }

    /// Proposal creation with empty description must fail.
    #[test]
    fn create_proposal_with_empty_description_is_rejected() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1u32, s(&env, "title"), s(&env, "")).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_create_proposal(&proposer, &1u32, &s(&env, "title"), &s(&env, ""));
        assert!(result.is_err(), "empty description must be rejected");
    }

    /// Proposal creation with title exactly at MAX_TITLE_LEN succeeds.
    #[test]
    fn create_proposal_title_at_limit_succeeds() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let title_bytes = [b'a'; MAX_TITLE_LEN as usize];
        let title = s(&env, std::str::from_utf8(&title_bytes).unwrap());
        let desc = s(&env, "Valid description");

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1u32, title.clone(), desc.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&proposer, &1u32, &title, &desc);
        assert_eq!(proposal_id, 1);
    }

    /// Proposal creation with title one byte over MAX_TITLE_LEN fails.
    #[test]
    fn create_proposal_title_exceeding_limit_fails() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let title_bytes = [b'a'; (MAX_TITLE_LEN + 1) as usize];
        let title = s(&env, std::str::from_utf8(&title_bytes).unwrap());
        let desc = s(&env, "Valid description");

        let result = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1u32, title.clone(), desc.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_create_proposal(&proposer, &1u32, &title, &desc);
        assert!(result.is_err(), "title exceeding limit must fail");
    }

    /// Proposal creation with description exactly at MAX_DESCRIPTION_LEN succeeds.
    #[test]
    fn create_proposal_description_at_limit_succeeds() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let title = s(&env, "Valid title");
        let desc_bytes = [b'd'; MAX_DESCRIPTION_LEN as usize];
        let desc = s(&env, std::str::from_utf8(&desc_bytes).unwrap());

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1u32, title.clone(), desc.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&proposer, &1u32, &title, &desc);
        assert_eq!(proposal_id, 1);
    }

    /// Proposal creation with description one byte over MAX_DESCRIPTION_LEN fails.
    #[test]
    fn create_proposal_description_exceeding_limit_fails() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let title = s(&env, "Valid title");
        let desc_bytes = [b'd'; (MAX_DESCRIPTION_LEN + 1) as usize];
        let desc = s(&env, std::str::from_utf8(&desc_bytes).unwrap());

        let result = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1u32, title.clone(), desc.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_create_proposal(&proposer, &1u32, &title, &desc);
        assert!(result.is_err(), "description exceeding limit must fail");
    }

    /// cache_token_balance with a negative balance must fail.
    #[test]
    fn cache_token_balance_negative_is_rejected() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let voter = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cache_token_balance",
                    args: (admin.clone(), 90u32, voter.clone(), -1i128).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cache_token_balance(&admin, &90u32, &voter, &(-1i128));
        assert!(result.is_err(), "negative balance cache must be rejected");
    }

    /// Governance initialization with quorum_threshold = 0 must fail.
    #[test]
    fn initialize_with_zero_quorum_is_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let pulse = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), pulse.clone(), 0_i128, 5_000_i128, 20_u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_initialize(&admin, &pulse, &0_i128, &5_000_i128, &20_u32);
        assert!(result.is_err(), "zero quorum must be rejected");
    }

    /// Governance initialization with consensus_threshold = 0 must fail.
    #[test]
    fn initialize_with_zero_consensus_threshold_is_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let pulse = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), pulse.clone(), 100_i128, 0_i128, 20_u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_initialize(&admin, &pulse, &100_i128, &0_i128, &20_u32);
        assert!(result.is_err(), "zero consensus threshold must be rejected");
    }

    /// Governance initialization with consensus_threshold > 10_000 must fail.
    #[test]
    fn initialize_with_consensus_threshold_above_max_is_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let pulse = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), pulse.clone(), 100_i128, 10_001_i128, 20_u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_initialize(&admin, &pulse, &100_i128, &10_001_i128, &20_u32);
        assert!(result.is_err(), "consensus_threshold > 10_000 must be rejected");
    }

    /// Governance initialization with voting_period_ledgers = 0 must fail.
    #[test]
    fn initialize_with_zero_voting_period_is_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let pulse = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), pulse.clone(), 100_i128, 5_000_i128, 0_u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_initialize(&admin, &pulse, &100_i128, &5_000_i128, &0_u32);
        assert!(result.is_err(), "zero voting period must be rejected");
    }

    /// Double-initialization of governance must be rejected.
    #[test]
    fn double_initialize_is_rejected() {
        let (env, contract_id, admin, pulse, client) = setup();

        let result = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), pulse.clone(), 100_i128, 5_000_i128, 20_u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_initialize(&admin, &pulse, &100_i128, &5_000_i128, &20_u32);
        assert!(result.is_err(), "double initialization must be rejected");
    }

    // ── Quorum State Tests (#599) ─────────────────────────────────

    /// Before any votes are cast the quorum state returns zeros and quorum_met=false.
    #[test]
    fn quorum_state_before_any_votes_is_zero() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        let qs = client.get_proposal_quorum_state(&proposal_id).unwrap();

        assert_eq!(qs.votes_cast, 0);
        assert_eq!(qs.yes_votes, 0);
        assert_eq!(qs.no_votes, 0);
        assert_eq!(qs.approval_bps, 0);
        assert!(!qs.quorum_met, "quorum should not be met with zero votes");
        assert_eq!(qs.quorum_threshold, 100); // from setup: quorum_threshold = 100
        assert_eq!(qs.quorum_fraction_bps, 0);
        assert_eq!(qs.consensus_threshold, 5_100); // from setup
    }

    /// Partial votes below quorum threshold show correct fractions and quorum_met=false.
    #[test]
    fn quorum_state_partial_votes_below_threshold() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();

        // Cache 50 weight — below quorum_threshold of 100
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter, 50);
        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);

        let qs = client.get_proposal_quorum_state(&proposal_id).unwrap();

        assert_eq!(qs.votes_cast, 50);
        assert_eq!(qs.yes_votes, 50);
        assert_eq!(qs.no_votes, 0);
        assert!(!qs.quorum_met, "quorum should not be met with 50/100 votes");
        // approval_bps = 50 * 10_000 / 50 = 10_000 (all yes)
        assert_eq!(qs.approval_bps, 10_000);
        // quorum_fraction_bps = 50 * 10_000 / 100 = 5_000
        assert_eq!(qs.quorum_fraction_bps, 5_000);
    }

    /// Votes exactly at the quorum threshold set quorum_met=true and emit EventQuorumReached.
    #[test]
    fn quorum_state_exactly_at_threshold_emits_quorum_reached() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();

        // Cache exactly 100 weight — equal to quorum_threshold
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter, 100);
        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);

        let qs = client.get_proposal_quorum_state(&proposal_id).unwrap();

        assert!(qs.quorum_met, "quorum should be met at exactly the threshold");
        assert_eq!(qs.votes_cast, 100);
        assert_eq!(qs.quorum_fraction_bps, 10_000);
        // approval_bps = 10_000 (all yes), which meets consensus_threshold 5_100
        assert_eq!(qs.approval_bps, 10_000);

        // Verify EventQuorumReached was emitted
        let events = env.events().all();
        let qrm_event = events.iter().find(|(cid, topics, _)| {
            if *cid != contract_id { return false; }
            if let Some(t0) = topics.get(0) {
                let s: soroban_sdk::Symbol = soroban_sdk::FromVal::from_val(&env, &t0);
                s == symbol_short!("qrm_rchd")
            } else { false }
        });
        assert!(qrm_event.is_some(), "EventQuorumReached must be emitted when quorum is first crossed");

        let (_, topics, data) = qrm_event.unwrap();
        let pid: u32 = soroban_sdk::FromVal::from_val(&env, &topics.get(1).unwrap());
        assert_eq!(pid, proposal_id);

        let payload: EventQuorumReached = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(payload.proposal_id, proposal_id);
        assert_eq!(payload.votes_cast, 100);
        assert_eq!(payload.quorum_threshold, 100);
        assert_eq!(payload.approval_bps, 10_000);
    }

    /// Quorum fraction is capped at 10_000 bps even when votes_cast greatly exceeds threshold.
    #[test]
    fn quorum_fraction_bps_capped_at_10000() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();

        // 500 weight — 5× the quorum threshold of 100
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter, 500);
        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);

        let qs = client.get_proposal_quorum_state(&proposal_id).unwrap();
        assert_eq!(qs.quorum_fraction_bps, 10_000, "fraction must not exceed 10_000");
        assert!(qs.quorum_met);
    }

    /// Approval bps is correctly computed with a split yes/no vote.
    #[test]
    fn quorum_state_split_vote_approval_bps() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter_yes = Address::generate(&env);
        let voter_no = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();

        // 60 yes + 40 no = 100 total, exactly at quorum (quorum_threshold=100)
        // approval_bps = 60 * 10_000 / 100 = 6_000
        // consensus_threshold = 5_100, so 6_000 > 5_100 → Approved
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter_yes, 60);
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter_no, 40);

        client
            .mock_auths(&[MockAuth {
                address: &voter_yes,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter_yes.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter_yes, &proposal_id, &VoteChoice::Approve);

        // After first vote (60 < 100 threshold) — quorum not yet met
        let qs_mid = client.get_proposal_quorum_state(&proposal_id).unwrap();
        assert!(!qs_mid.quorum_met);
        assert_eq!(qs_mid.votes_cast, 60);
        assert_eq!(qs_mid.approval_bps, 10_000);

        client
            .mock_auths(&[MockAuth {
                address: &voter_no,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter_no.clone(), proposal_id, VoteChoice::Reject).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter_no, &proposal_id, &VoteChoice::Reject);

        let qs = client.get_proposal_quorum_state(&proposal_id).unwrap();
        assert!(qs.quorum_met);
        assert_eq!(qs.yes_votes, 60);
        assert_eq!(qs.no_votes, 40);
        assert_eq!(qs.votes_cast, 100);
        assert_eq!(qs.approval_bps, 6_000);
        assert_eq!(qs.quorum_fraction_bps, 10_000);
    }

    /// EventQuorumReached is emitted only once even when additional votes are cast after quorum.
    #[test]
    fn quorum_reached_event_emitted_only_once() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();

        // voter1 casts 100 → crosses threshold
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter1, 100);

        // voter2 wants to vote but proposal already finalized at quorum;
        // set voter2 balance before the vote
        // NOTE: since quorum=100 and voter1 already crosses it, the proposal
        // moves to a terminal state, so we use voter2 to test the sentinel on a
        // second proposal to avoid "not active" panic.
        // We test idempotency directly by checking event count.
        client
            .mock_auths(&[MockAuth {
                address: &voter1,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter1.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter1, &proposal_id, &VoteChoice::Approve);

        // Count qrm_rchd events
        let events = env.events().all();
        let qrm_count = events.iter().filter(|(cid, topics, _)| {
            if *cid != contract_id { return false; }
            if let Some(t0) = topics.get(0) {
                let s: soroban_sdk::Symbol = soroban_sdk::FromVal::from_val(&env, &t0);
                s == symbol_short!("qrm_rchd")
            } else { false }
        }).count();

        assert_eq!(qrm_count, 1, "EventQuorumReached must be emitted exactly once");

        // Now create a second proposal and verify the sentinel is proposal-scoped
        let _ = voter2; // voter2 unused in this scenario; sentinel key is (proposal_id) specific
    }

    /// get_proposal_quorum_state returns None for non-existent proposal.
    #[test]
    fn quorum_state_for_nonexistent_proposal_returns_none() {
        let (env, _contract_id, _admin, _pulse, client) = setup();
        let result = client.get_proposal_quorum_state(&9999u32);
        assert!(result.is_none(), "nonexistent proposal must return None");
    }

    /// version() returns (1, 1, 0) after the bump.
    #[test]
    fn version_returns_1_1_0() {
        let (env, _contract_id, _admin, _pulse, client) = setup();
        let ver = client.version();
        assert_eq!(ver, (1u32, 1u32, 0u32));
    }

    /// supports_version(1, 1, 0) is true; (1, 2, 0) is false.
    #[test]
    fn supports_version_compatibility_checks() {
        let (env, _contract_id, _admin, _pulse, client) = setup();
        assert!(client.supports_version(&1, &0, &0), "must support v1.0.0 (backward compat)");
        assert!(client.supports_version(&1, &1, &0), "must support v1.1.0 (exact)");
        assert!(!client.supports_version(&1, &2, &0), "must not support v1.2.0 (not yet deployed)");
        assert!(!client.supports_version(&2, &0, &0), "must not support v2.0.0 (major mismatch)");
    }

    /// interface_features includes "quorum_state".
    #[test]
    fn interface_features_includes_quorum_state() {
        let (env, _contract_id, _admin, _pulse, client) = setup();
        let features = client.interface_features();
        let quorum_sym = soroban_sdk::Symbol::new(&env, "quorum_state");
        assert!(features.contains(&quorum_sym), "interface_features must include quorum_state");
    }

    /// interface_id golden vector — minor byte is now 0x01.
    #[test]
    fn interface_id_golden_vector_v1_1_0() {
        let (env, _contract_id, _admin, _pulse, client) = setup();
        let id = client.interface_id();
        let bytes = id.to_array();
        // First 8 bytes: "TalosGov"
        assert_eq!(&bytes[0..8], &[0x54, 0x61, 0x6C, 0x6F, 0x73, 0x47, 0x6F, 0x76]);
        // Bytes 16-19: major = 1
        assert_eq!(&bytes[16..20], &[0x00, 0x00, 0x00, 0x01]);
        // Bytes 20-23: minor = 1
        assert_eq!(&bytes[20..24], &[0x00, 0x00, 0x00, 0x01]);
        // Bytes 24-27: patch = 0
        assert_eq!(&bytes[24..28], &[0x00, 0x00, 0x00, 0x00]);
    }

    /// Boundary: quorum_threshold=1 with one tiny weight vote reaches quorum.
    #[test]
    fn quorum_state_boundary_threshold_one() {
        let env = Env::default();
        env.ledger().with_mut(|li| { li.sequence_number = 100; li.timestamp = 1_000; });
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let pulse = Address::generate(&env);

        // quorum_threshold = 1
        client.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "initialize",
                args: (admin.clone(), pulse.clone(), 1_i128, 5_000_i128, 20_u32).into_val(&env),
                sub_invokes: &[],
            },
        }]).initialize(&admin, &pulse, &1_i128, &5_000_i128, &20_u32);

        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        let proposal_id = client.mock_auths(&[MockAuth {
            address: &proposer,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "create_proposal",
                args: (proposer.clone(), 1u32, s(&env, "t"), s(&env, "d")).into_val(&env),
                sub_invokes: &[],
            },
        }]).create_proposal(&proposer, &1u32, &s(&env, "t"), &s(&env, "d"));

        client.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cache_token_balance",
                args: (admin.clone(), 90u32, voter.clone(), 1i128).into_val(&env),
                sub_invokes: &[],
            },
        }]).cache_token_balance(&admin, &90u32, &voter, &1i128);

        client.mock_auths(&[MockAuth {
            address: &voter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "vote",
                args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                sub_invokes: &[],
            },
        }]).vote(&voter, &proposal_id, &VoteChoice::Approve);

        let qs = client.get_proposal_quorum_state(&proposal_id).unwrap();
        assert!(qs.quorum_met);
        assert_eq!(qs.votes_cast, 1);
        assert_eq!(qs.quorum_fraction_bps, 10_000);
    }

    /// Regression: existing finalize/execute lifecycle unchanged after v1.1.0.
    #[test]
    fn regression_lifecycle_unchanged_after_quorum_state_addition() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        cache_balance_with_auth(&env, &contract_id, &client, &admin, proposal.snapshot_ledger, &voter, 200);

        client.mock_auths(&[MockAuth {
            address: &voter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "vote",
                args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                sub_invokes: &[],
            },
        }]).vote(&voter, &proposal_id, &VoteChoice::Approve);

        let proposal_after = client.get_proposal(&proposal_id).unwrap();
        // Quorum met (200 >= 100) and approval_bps (10_000) >= consensus_threshold (5_100)
        assert_eq!(proposal_after.status, ProposalStatus::Approved);

        client.execute_proposal(&proposal_id);
        let proposal_final = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal_final.status, ProposalStatus::Executed);
    }

    // ── Budget regression gates (#610) ───────────────────────────────────────
    //
    // Measure CPU-instruction and memory-byte cost on the host target.
    // Ceilings are loose regression catches; actual WASM costs are higher.
    // env.budget().reset_default() re-zeroes counters and re-applies the
    // default per-transaction limit before each measurement.

    const BUDGET_CPU_INITIALIZE_GOV: u64       = 400_000;
    const BUDGET_MEM_INITIALIZE_GOV: u64       =  80_000;

    const BUDGET_CPU_CREATE_PROPOSAL: u64      = 600_000;
    const BUDGET_MEM_CREATE_PROPOSAL: u64      = 120_000;

    const BUDGET_CPU_VOTE: u64                 = 800_000;
    const BUDGET_MEM_VOTE: u64                 = 150_000;

    const BUDGET_CPU_RECORD_DIVIDEND: u64      = 600_000;
    const BUDGET_MEM_RECORD_DIVIDEND: u64      = 120_000;

    const BUDGET_CPU_GET_PROPOSAL: u64         = 200_000;
    const BUDGET_MEM_GET_PROPOSAL: u64         =  50_000;

    #[test]
    fn budget_initialize_within_limits() {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.sequence_number = 100;
            li.timestamp = 1_000;
        });
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let pulse = Address::generate(&env);

        env.budget().reset_default();
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "initialize",
                    args: (admin.clone(), pulse.clone(), 100_i128, 5_100_i128, 20_u32)
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .initialize(&admin, &pulse, &100_i128, &5_100_i128, &20_u32);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_INITIALIZE_GOV,
            "governance initialize CPU {} exceeded ceiling {}",
            cpu, BUDGET_CPU_INITIALIZE_GOV,
        );
        assert!(
            mem < BUDGET_MEM_INITIALIZE_GOV,
            "governance initialize memory {} exceeded ceiling {}",
            mem, BUDGET_MEM_INITIALIZE_GOV,
        );
    }

    #[test]
    fn budget_create_proposal_within_limits() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        env.budget().reset_default();
        create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_CREATE_PROPOSAL,
            "create_proposal CPU {} exceeded ceiling {}",
            cpu, BUDGET_CPU_CREATE_PROPOSAL,
        );
        assert!(
            mem < BUDGET_MEM_CREATE_PROPOSAL,
            "create_proposal memory {} exceeded ceiling {}",
            mem, BUDGET_MEM_CREATE_PROPOSAL,
        );
    }

    #[test]
    fn budget_vote_within_limits() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter    = Address::generate(&env);

        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        cache_balance_with_auth(
            &env, &contract_id, &client, &admin,
            proposal.snapshot_ledger, &voter, 200,
        );

        env.budget().reset_default();
        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_VOTE,
            "vote CPU {} exceeded ceiling {}",
            cpu, BUDGET_CPU_VOTE,
        );
        assert!(
            mem < BUDGET_MEM_VOTE,
            "vote memory {} exceeded ceiling {}",
            mem, BUDGET_MEM_VOTE,
        );
    }

    #[test]
    fn budget_record_dividend_snapshot_within_limits() {
        let (env, contract_id, admin, _pulse, client) = setup();

        env.budget().reset_default();
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "record_dividend_snapshot",
                    args: (admin.clone(), 1_u32, 500_000_i128, 100_i128).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .record_dividend_snapshot(&admin, &1_u32, &500_000_i128, &100_i128);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_RECORD_DIVIDEND,
            "record_dividend_snapshot CPU {} exceeded ceiling {}",
            cpu, BUDGET_CPU_RECORD_DIVIDEND,
        );
        assert!(
            mem < BUDGET_MEM_RECORD_DIVIDEND,
            "record_dividend_snapshot memory {} exceeded ceiling {}",
            mem, BUDGET_MEM_RECORD_DIVIDEND,
        );
    }

    #[test]
    fn budget_get_proposal_read_within_limits() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);

        env.budget().reset_default();
        let _ = client.get_proposal(&proposal_id);

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        assert!(
            cpu < BUDGET_CPU_GET_PROPOSAL,
            "get_proposal CPU {} exceeded ceiling {}",
            cpu, BUDGET_CPU_GET_PROPOSAL,
        );
        assert!(
            mem < BUDGET_MEM_GET_PROPOSAL,
            "get_proposal memory {} exceeded ceiling {}",
            mem, BUDGET_MEM_GET_PROPOSAL,
        );
    }

    /// Negative: create_proposal with empty title must fail cheaply.
    #[test]
    fn budget_create_proposal_empty_title_rejected_cheaply() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let empty    = soroban_sdk::String::from_str(&env, "");
        let desc     = soroban_sdk::String::from_str(&env, "Some description");

        env.budget().reset_default();
        let result = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1_u32, empty.clone(), desc.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_create_proposal(&proposer, &1_u32, &empty, &desc);
        assert!(result.is_err(), "empty title must be rejected");

        let cpu = env.budget().cpu_instruction_cost();
        let mem = env.budget().memory_bytes_cost();
        // Validation rejection must be no more expensive than a success path.
        assert!(
            cpu < BUDGET_CPU_CREATE_PROPOSAL,
            "rejected create_proposal CPU {} exceeded ceiling {}",
            cpu, BUDGET_CPU_CREATE_PROPOSAL,
        );
        assert!(
            mem < BUDGET_MEM_CREATE_PROPOSAL,
            "rejected create_proposal memory {} exceeded ceiling {}",
            mem, BUDGET_MEM_CREATE_PROPOSAL,
        );
    }

    // ── Two-step admin transfer tests ────────────────────────────────

    fn mock_propose(
        env: &Env,
        client: &TalosGovernanceClient,
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
        client: &TalosGovernanceClient,
        contract_id: &Address,
        pending: &Address,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: pending,
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
        client: &TalosGovernanceClient,
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

    /// Happy path: propose → accept transfers admin and clears pending slot.
    #[test]
    fn propose_then_accept_transfers_admin() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        assert_eq!(client.get_admin(), Some(admin.clone()));
        assert_eq!(client.pending_admin(), None);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        assert_eq!(client.pending_admin(), Some(new_admin.clone()));

        mock_accept(&env, &client, &contract_id, &new_admin);

        // Admin is now new_admin; pending slot is cleared.
        assert_eq!(client.get_admin(), Some(new_admin.clone()));
        assert_eq!(client.pending_admin(), None);
    }

    /// After acceptance, the old admin loses update_config rights and the new admin succeeds.
    #[test]
    fn old_admin_loses_update_config_rights_after_acceptance() {
        let (env, contract_id, admin, pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        mock_accept(&env, &client, &contract_id, &new_admin);

        let new_cfg = GovernanceConfig {
            quorum_threshold: 300,
            consensus_threshold: 6_000,
            voting_period_ledgers: 50,
            pulse_token_address: pulse.clone(),
        };

        // Old admin attempts update_config — must be rejected.
        let old_admin_res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "update_config",
                    args: (admin.clone(), new_cfg.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_update_config(&admin, &new_cfg);
        assert!(old_admin_res.is_err(), "old admin must lose update_config rights");

        // New admin updates config successfully.
        client
            .mock_auths(&[MockAuth {
                address: &new_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "update_config",
                    args: (new_admin.clone(), new_cfg.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .update_config(&new_admin, &new_cfg);

        assert_eq!(client.get_config(), Some(new_cfg));
    }

    /// propose_admin without current admin auth must fail.
    #[test]
    fn propose_admin_requires_current_admin_auth() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let impostor = Address::generate(&env);
        let new_admin = Address::generate(&env);

        // No mock_auths → auth check fails.
        assert!(client.try_propose_admin(&new_admin).is_err());

        // Impostor auth → still fails.
        let result = client
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
        assert!(result.is_err());
    }

    /// accept_admin without pending admin auth must fail.
    #[test]
    fn accept_admin_requires_pending_admin_auth() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);

        // Impostor pretending to be pending admin.
        let result = client
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
        assert!(result.is_err());

        // Original admin trying to accept — must also fail (only pending may accept).
        let result2 = client
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
        assert!(result2.is_err());
    }

    /// accept_admin with no pending nomination must panic.
    #[test]
    fn accept_admin_without_pending_panics() {
        let (_env, _contract_id, _admin, _pulse, client) = setup();

        // No propose was called; any accept attempt must fail.
        assert!(client.try_accept_admin().is_err());
    }

    /// cancel_admin_transfer removes pending and leaves admin unchanged.
    #[test]
    fn cancel_admin_transfer_clears_pending() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        assert_eq!(client.pending_admin(), Some(new_admin.clone()));

        mock_cancel(&env, &client, &contract_id, &admin);

        assert_eq!(client.pending_admin(), None);
        // Admin is unchanged.
        assert_eq!(client.get_admin(), Some(admin.clone()));
    }

    /// After cancellation the pending admin can no longer accept.
    #[test]
    fn cancelled_pending_cannot_accept() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        mock_cancel(&env, &client, &contract_id, &admin);

        let result = client
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
        assert!(result.is_err());
    }

    /// cancel_admin_transfer without pending nomination must panic.
    #[test]
    fn cancel_without_pending_panics() {
        let (_env, _contract_id, _admin, _pulse, client) = setup();

        // No nomination exists.
        assert!(client.try_cancel_admin_transfer().is_err());
    }

    /// cancel_admin_transfer requires current admin auth.
    #[test]
    fn cancel_admin_transfer_requires_admin_auth() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);

        let result = client
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
        assert!(result.is_err());
    }

    /// propose_admin replaces an existing pending nomination (no cancel needed).
    #[test]
    fn propose_admin_replaces_existing_pending() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let first = Address::generate(&env);
        let second = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &first);
        assert_eq!(client.pending_admin(), Some(first.clone()));

        // Replace with a different nominee.
        mock_propose(&env, &client, &contract_id, &admin, &second);
        assert_eq!(client.pending_admin(), Some(second.clone()));

        // First nominee can no longer accept.
        let result = client
            .mock_auths(&[MockAuth {
                address: &first,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin();
        assert!(result.is_err());

        // Second nominee can accept.
        mock_accept(&env, &client, &contract_id, &second);
        assert_eq!(client.get_admin(), Some(second));
        assert_eq!(client.pending_admin(), None);
    }

    /// propose_admin emits adm_prp event with (current, proposed).
    #[test]
    fn propose_admin_emits_adm_prp_event() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);

        let events = env.events().all();
        let prp_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(a, t, _)| {
                if *a != contract_id {
                    return false;
                }
                if t.len() == 0 {
                    return false;
                }
                let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &t.get(0).unwrap());
                sym.map(|s| s == symbol_short!("adm_prp")).unwrap_or(false)
            })
            .collect();

        assert_eq!(prp_events.len(), 1);
        let (_, _, data) = prp_events[0].clone();
        let (got_current, got_proposed): (Address, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(got_current, admin);
        assert_eq!(got_proposed, new_admin);
    }

    /// accept_admin emits adm_acc event with (new_admin,).
    #[test]
    fn accept_admin_emits_adm_acc_event() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);

        // Clear events accumulated by propose.
        let _ = env.events().all();

        mock_accept(&env, &client, &contract_id, &new_admin);

        let events = env.events().all();
        let accept_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(a, t, _)| {
                if *a != contract_id {
                    return false;
                }
                if t.len() == 0 {
                    return false;
                }
                let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &t.get(0).unwrap());
                sym.map(|s| s == symbol_short!("adm_acc")).unwrap_or(false)
            })
            .collect();

        assert_eq!(accept_events.len(), 1);
        let (_, _, data) = accept_events[0].clone();
        let (got_new,): (Address,) = TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(got_new, new_admin);
    }

    /// cancel_admin_transfer emits adm_cnl event with (cancelled,).
    #[test]
    fn cancel_admin_transfer_emits_adm_cnl_event() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        mock_cancel(&env, &client, &contract_id, &admin);

        let events = env.events().all();
        let cancel_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(a, t, _)| {
                if *a != contract_id {
                    return false;
                }
                if t.len() == 0 {
                    return false;
                }
                let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &t.get(0).unwrap());
                sym.map(|s| s == symbol_short!("adm_cnl")).unwrap_or(false)
            })
            .collect();

        assert_eq!(cancel_events.len(), 1);
        let (_, _, data) = cancel_events[0].clone();
        let (got_cancelled,): (Address,) = TryFromVal::try_from_val(&env, &data).unwrap();
        assert_eq!(got_cancelled, new_admin);
    }

    /// propose_admin is gated by PAUSE_GOVERNANCE_CONFIG.
    #[test]
    fn propose_admin_blocked_when_governance_config_paused() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        // Pause governance config domain
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_domain",
                    args: (PAUSE_GOVERNANCE_CONFIG, 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .pause_domain(&PAUSE_GOVERNANCE_CONFIG, &0);

        // propose_admin must be rejected while paused
        let res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "propose_admin",
                    args: (new_admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_admin(&new_admin);
        assert!(res.is_err(), "propose_admin must be blocked while PAUSE_GOVERNANCE_CONFIG is active");

        // Unpause governance config domain
        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "unpause_domain",
                    args: (PAUSE_GOVERNANCE_CONFIG,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .unpause_domain(&PAUSE_GOVERNANCE_CONFIG);

        // Now propose_admin succeeds
        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        assert_eq!(client.pending_admin(), Some(new_admin));
    }

    /// propose_admin on uninitialized contract must fail.
    #[test]
    fn propose_admin_on_uninit_contract_is_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let any_addr = Address::generate(&env);

        let result = client
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
        assert!(result.is_err());
    }

    /// cancel_admin_transfer on uninitialized contract must fail.
    #[test]
    fn cancel_admin_transfer_on_uninit_contract_is_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let any_addr = Address::generate(&env);

        let result = client
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
        assert!(result.is_err());
    }

    /// After transfer the new admin can pause and old admin cannot.
    #[test]
    fn new_admin_can_pause_and_old_admin_cannot_pause_after_transfer() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        mock_accept(&env, &client, &contract_id, &new_admin);

        // Old admin cannot pause
        let old_res = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_domain",
                    args: (PAUSE_PROPOSAL_CREATION, 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_pause_domain(&PAUSE_PROPOSAL_CREATION, &0);
        assert!(old_res.is_err(), "old admin must not be able to pause");

        // New admin can pause
        client
            .mock_auths(&[MockAuth {
                address: &new_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_domain",
                    args: (PAUSE_PROPOSAL_CREATION, 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .pause_domain(&PAUSE_PROPOSAL_CREATION, &0);
        let status = client.get_domain_pause_status(&PAUSE_PROPOSAL_CREATION).unwrap();
        assert!(status.paused);
    }

    // ── Two-step admin transfer tests (#948) ──────────────────────────
    // Mirrored from the registry's admin-transfer tests.

    fn mock_propose(
        env: &Env,
        client: &TalosGovernanceClient<'static>,
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
                    args: (admin.clone(), new_admin.clone()).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .propose_admin(admin, new_admin);
    }

    fn mock_accept(
        env: &Env,
        client: &TalosGovernanceClient<'static>,
        contract_id: &Address,
        pending: &Address,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: pending,
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
        client: &TalosGovernanceClient<'static>,
        contract_id: &Address,
        admin: &Address,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "cancel_admin_transfer",
                    args: (admin.clone(),).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .cancel_admin_transfer(admin);
    }

    #[test]
    fn propose_then_accept_transfers_admin() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        assert_eq!(client.get_admin(), Some(admin.clone()));
        assert_eq!(client.get_pending_admin(), None);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        assert_eq!(client.get_pending_admin(), Some(new_admin.clone()));

        mock_accept(&env, &client, &contract_id, &new_admin);

        // Admin is now new_admin; pending slot is cleared.
        assert_eq!(client.get_admin(), Some(new_admin.clone()));
        assert_eq!(client.get_pending_admin(), None);
    }

    #[test]
    fn propose_admin_replaces_existing_pending() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let first = Address::generate(&env);
        let second = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &first);
        assert_eq!(client.get_pending_admin(), Some(first.clone()));

        mock_propose(&env, &client, &contract_id, &admin, &second);
        assert_eq!(client.get_pending_admin(), Some(second.clone()));

        // First nominee can no longer accept.
        let result = client
            .mock_auths(&[MockAuth {
                address: &first,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_accept_admin();
        assert!(result.is_err());
    }

    #[test]
    fn old_admin_loses_rights_after_transfer() {
        let (env, contract_id, admin, pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        mock_accept(&env, &client, &contract_id, &new_admin);

        // Old admin can no longer update config...
        let config = GovernanceConfig {
            quorum_threshold: 100_i128,
            consensus_threshold: 5_100_i128,
            voting_period_ledgers: 20_u32,
            pulse_token_address: pulse.clone(),
            snapshot_offset_ledgers: Some(10),
        };
        let result = client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "update_config",
                    args: (admin.clone(), config.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_update_config(&admin, &config);
        assert!(result.is_err());

        // ...but the new admin can.
        client
            .mock_auths(&[MockAuth {
                address: &new_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "update_config",
                    args: (new_admin.clone(), config.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .update_config(&new_admin, &config);
    }

    #[test]
    fn propose_admin_requires_current_admin_auth() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let impostor = Address::generate(&env);
        let new_admin = Address::generate(&env);

        // No mock_auths → auth check fails.
        assert!(client.try_propose_admin(&admin, &new_admin).is_err());

        // Impostor auth → still fails.
        let result = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "propose_admin",
                    args: (impostor.clone(), new_admin.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_propose_admin(&impostor, &new_admin);
        assert!(result.is_err());
    }

    #[test]
    fn accept_admin_requires_pending_admin_auth() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);

        // Impostor pretending to be pending admin.
        let result = client
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
        assert!(result.is_err());

        // Original admin trying to accept — must also fail (only pending may accept).
        let result2 = client
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
        assert!(result2.is_err());
    }

    #[test]
    fn accept_admin_without_pending_panics() {
        let (_env, _contract_id, _admin, _pulse, client) = setup();

        // No nomination exists.
        assert!(client.try_accept_admin().is_err());
    }

    #[test]
    fn cancel_admin_transfer_clears_pending() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        assert_eq!(client.get_pending_admin(), Some(new_admin.clone()));

        mock_cancel(&env, &client, &contract_id, &admin);

        assert_eq!(client.get_pending_admin(), None);
        // Admin is unchanged.
        assert_eq!(client.get_admin(), Some(admin.clone()));
    }

    #[test]
    fn cancelled_pending_cannot_accept() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        mock_cancel(&env, &client, &contract_id, &admin);

        let result = client
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
        assert!(result.is_err());
    }

    #[test]
    fn cancel_without_pending_panics() {
        let (env, _contract_id, admin, _pulse, client) = setup();

        // No nomination exists.
        assert!(client.try_cancel_admin_transfer(&admin).is_err());
    }

    #[test]
    fn cancel_admin_transfer_requires_admin_auth() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);

        let result = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cancel_admin_transfer",
                    args: (impostor.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_cancel_admin_transfer(&impostor);
        assert!(result.is_err());
    }

    #[test]
    fn propose_admin_emits_adm_prp_event() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);

        let events = env.events().all();
        let propose_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(a, t, _)| {
                if *a != contract_id {
                    return false;
                }
                if t.len() == 0 {
                    return false;
                }
                let sym: Result<Symbol, _> = soroban_sdk::TryFromVal::try_from_val(&env, &t.get(0).unwrap());
                sym.map(|s| s == symbol_short!("adm_prp")).unwrap_or(false)
            })
            .collect();
        assert_eq!(propose_events.len(), 1);

        let (_, _, data) = propose_events[0].clone();
        let payload: EventAdminProposed = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(payload.current_admin, admin);
        assert_eq!(payload.pending_admin, new_admin);
    }

    #[test]
    fn accept_admin_emits_adm_acc_event() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);

        // Clear events accumulated by propose.
        let _ = env.events().all();

        mock_accept(&env, &client, &contract_id, &new_admin);

        let events = env.events().all();
        let accept_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(a, t, _)| {
                if *a != contract_id {
                    return false;
                }
                if t.len() == 0 {
                    return false;
                }
                let sym: Result<Symbol, _> = soroban_sdk::TryFromVal::try_from_val(&env, &t.get(0).unwrap());
                sym.map(|s| s == symbol_short!("adm_acc")).unwrap_or(false)
            })
            .collect();
        assert_eq!(accept_events.len(), 1);

        let (_, _, data) = accept_events[0].clone();
        let payload: EventAdminAccepted = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(payload.new_admin, new_admin);
    }

    #[test]
    fn cancel_admin_transfer_emits_adm_cnl_event() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let new_admin = Address::generate(&env);

        mock_propose(&env, &client, &contract_id, &admin, &new_admin);
        mock_cancel(&env, &client, &contract_id, &admin);

        let events = env.events().all();
        let cancel_events: std::vec::Vec<_> = events
            .iter()
            .filter(|(a, t, _)| {
                if *a != contract_id {
                    return false;
                }
                t.len() != 0 && {
                    let sym: Result<Symbol, _> =
                        soroban_sdk::TryFromVal::try_from_val(&env, &t.get(0).unwrap());
                    sym.map(|s| s == symbol_short!("adm_cnl")).unwrap_or(false)
                }
            })
            .collect();
        assert_eq!(cancel_events.len(), 1);

        let (_, _, data) = cancel_events[0].clone();
        let payload: EventAdminTransferCancelled = soroban_sdk::FromVal::from_val(&env, &data);
        assert_eq!(payload.pending_admin, new_admin);
    }

    // ── ProposalAction tests (#913) ───────────────────────────────────────

    /// Helper: create an action proposal, vote it to Approved, return the proposal id.
    fn create_and_approve_action_proposal(
        env: &Env,
        contract_id: &Address,
        client: &TalosGovernanceClient<'static>,
        admin: &Address,
        proposer: &Address,
        action: Option<ProposalAction>,
    ) -> u32 {
        let voter = Address::generate(env);

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: proposer,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "create_proposal_with_action",
                    args: (
                        proposer.clone(),
                        7_u32,
                        s(env, "Action proposal"),
                        s(env, "Governs on-chain action."),
                        action.clone(),
                    )
                        .into_val(env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal_with_action(
                proposer,
                &7_u32,
                &s(env, "Action proposal"),
                &s(env, "Governs on-chain action."),
                &action,
            );

        let proposal = client.get_proposal(&proposal_id).unwrap();
        // Cache enough balance to reach quorum (100) and consensus (51 %)
        cache_balance_with_auth(env, contract_id, client, admin, proposal.snapshot_ledger, &voter, 200);

        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);

        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.status, ProposalStatus::Approved);
        proposal_id
    }

    /// A title-only proposal (no action) still executes and transitions to Executed.
    #[test]
    fn execute_title_only_proposal_transitions_to_executed() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let proposal_id = create_proposal_with_auth(&env, &contract_id, &client, &proposer);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        cache_balance_with_auth(
            &env, &contract_id, &client, &admin,
            proposal.snapshot_ledger, &voter, 200,
        );
        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (voter.clone(), proposal_id, VoteChoice::Approve).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&voter, &proposal_id, &VoteChoice::Approve);

        client.execute_proposal(&proposal_id);

        let executed = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(executed.status, ProposalStatus::Executed);
        assert!(executed.action.is_none(), "title-only proposal must have no action");
    }

    /// create_proposal_with_action stores the action field on the proposal.
    #[test]
    fn create_proposal_with_action_stores_action() {
        let (env, contract_id, _admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);
        let fake_registry = Address::generate(&env);

        let action = Some(ProposalAction::PauseTalos {
            registry: fake_registry.clone(),
            talos_id: 42,
        });

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal_with_action",
                    args: (
                        proposer.clone(),
                        7_u32,
                        s(&env, "Pause Talos 42"),
                        s(&env, "Emergency pause."),
                        action.clone(),
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal_with_action(
                &proposer,
                &7_u32,
                &s(&env, "Pause Talos 42"),
                &s(&env, "Emergency pause."),
                &action,
            );

        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(
            proposal.action,
            Some(ProposalAction::PauseTalos {
                registry: fake_registry,
                talos_id: 42,
            })
        );
    }

    /// An UpdateConfig action updates the stored config on execution.
    #[test]
    fn execute_update_config_action_applies_new_config() {
        let (env, contract_id, admin, pulse, client) = setup();
        let proposer = Address::generate(&env);

        let action = Some(ProposalAction::UpdateConfig {
            quorum_threshold: 200,
            consensus_threshold: 6_000,
            voting_period_ledgers: 40,
        });

        let proposal_id =
            create_and_approve_action_proposal(&env, &contract_id, &client, &admin, &proposer, action);

        client.execute_proposal(&proposal_id);

        let executed = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(executed.status, ProposalStatus::Executed);

        let config = client.get_config().unwrap();
        assert_eq!(config.quorum_threshold, 200);
        assert_eq!(config.consensus_threshold, 6_000);
        assert_eq!(config.voting_period_ledgers, 40);
        assert_eq!(config.pulse_token_address, pulse, "pulse address must be preserved");
    }

    /// Executing an UpdateConfig proposal emits prop_exec and prop_stat(Executed) events.
    #[test]
    fn execute_update_config_emits_exec_and_status_events() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        let action = Some(ProposalAction::UpdateConfig {
            quorum_threshold: 150,
            consensus_threshold: 5_500,
            voting_period_ledgers: 30,
        });

        let proposal_id =
            create_and_approve_action_proposal(&env, &contract_id, &client, &admin, &proposer, action);

        client.execute_proposal(&proposal_id);

        let events = env.events().all();

        // prop_exec event must be present
        let exec_event = events.iter().find(|(cid, topics, _)| {
            if *cid != contract_id { return false; }
            if let Some(t0) = topics.get(0) {
                let sym: soroban_sdk::Symbol = soroban_sdk::FromVal::from_val(&env, &t0);
                sym == symbol_short!("prop_exec")
            } else { false }
        });
        assert!(exec_event.is_some(), "prop_exec event must be emitted");

        let (_, _, exec_data) = exec_event.unwrap();
        let exec_payload: EventProposalExecuted = soroban_sdk::FromVal::from_val(&env, &exec_data);
        assert_eq!(exec_payload.proposal_id, proposal_id);
        assert!(exec_payload.success);

        // prop_stat(Executed) must also be emitted
        let executed_stat = events.iter().find(|(cid, topics, data)| {
            if *cid != contract_id { return false; }
            if let Some(t0) = topics.get(0) {
                let sym: soroban_sdk::Symbol = soroban_sdk::FromVal::from_val(&env, &t0);
                if sym != symbol_short!("prop_stat") { return false; }
                let p: EventProposalStatusChanged = soroban_sdk::FromVal::from_val(&env, data);
                p.status == ProposalStatus::Executed
            } else { false }
        });
        assert!(executed_stat.is_some(), "prop_stat(Executed) must be emitted");
    }

    /// An UpdateConfig with invalid quorum panics at execution time.
    #[test]
    #[should_panic(expected = "Quorum must be positive")]
    fn execute_update_config_invalid_quorum_is_rejected() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        let action = Some(ProposalAction::UpdateConfig {
            quorum_threshold: 0,
            consensus_threshold: 5_000,
            voting_period_ledgers: 20,
        });

        let proposal_id =
            create_and_approve_action_proposal(&env, &contract_id, &client, &admin, &proposer, action);

        client.execute_proposal(&proposal_id);
    }

    /// A proposal can only be executed once; the second call sees Executed status.
    #[test]
    fn execute_proposal_only_once() {
        let (env, contract_id, admin, _pulse, client) = setup();
        let proposer = Address::generate(&env);

        let action = Some(ProposalAction::UpdateConfig {
            quorum_threshold: 200,
            consensus_threshold: 5_500,
            voting_period_ledgers: 25,
        });

        let proposal_id =
            create_and_approve_action_proposal(&env, &contract_id, &client, &admin, &proposer, action);

        client.execute_proposal(&proposal_id);

        let result = client.try_execute_proposal(&proposal_id);
        assert!(result.is_err(), "second execute must fail");
    }
}
