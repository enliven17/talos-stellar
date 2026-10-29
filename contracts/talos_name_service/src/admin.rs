//! Admin and timelock types and constants for TalosNameService.

use soroban_sdk::{contracttype, Address};

/// Administrative actions that can be scheduled via timelock.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdminAction {
    SetRegistryContract(Address),
    SetAdmin(Address),
}

/// Status of a timelock proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Scheduled,
    Executed,
    Cancelled,
}

/// A timelock proposal awaiting execution.
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

/// Timelock configuration parameters.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockConfig {
    pub min_delay: u64,
    pub grace_period: u64,
}

/// Default grace period: 7 days in seconds.
pub const DEFAULT_GRACE_PERIOD: u64 = 604_800;

/// Maximum minimum delay: 30 days in seconds.
pub const MAX_MIN_DELAY: u64 = 2_592_000;
