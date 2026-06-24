//! TalosGovernance — Soroban smart contract for Talos Protocol governance.
//!
//! Handles:
//! - Proposal creation for Talos governance
//! - Token-weighted voting based on Pulse token holdings
//! - Quorum and consensus-based proposal approval/rejection
//! - Snapshot-based vote weight calculation

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, String,
};

// ── Data Types ──────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoteChoice {
    Approve,
    Reject,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Vote {
    pub voter: Address,
    pub choice: VoteChoice,
    pub weight: i128,
    pub voted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalStatus {
    Active,
    Approved,
    Rejected,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug)]
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
}

#[contracttype]
#[derive(Clone)]
pub struct GovernanceConfig {
    pub quorum_threshold: i128, // Minimum tokens required for quorum
    pub consensus_threshold: i128, // Percentage (basis points) required for approval
    pub voting_period_ledgers: u32, // Duration of voting period in ledgers
    pub pulse_token_address: Address, // Address of Pulse token contract
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    NextProposalId,
    Proposal(u32),
    Vote(u32, Address), // proposal_id, voter
    Config,
    TokenBalanceSnapshot(u32, Address), // snapshot_ledger, address
}

// ── Events ──────────────────────────────────────────────────────────

fn emit_proposal_created(env: &Env, proposal_id: u32, talos_id: u32, proposer: Address) {
    let topics = (symbol_short!("prop_crt"), proposal_id);
    env.events().publish(topics, (talos_id, proposer));
}

fn emit_vote_cast(env: &Env, proposal_id: u32, voter: Address, choice: VoteChoice, weight: i128) {
    let topics = (symbol_short!("vote_cast"), proposal_id);
    env.events().publish(topics, (voter, choice, weight));
}

fn emit_proposal_status_changed(env: &Env, proposal_id: u32, status: ProposalStatus) {
    let topics = (symbol_short!("prop_stat"), proposal_id);
    env.events().publish(topics, status);
}

// ── Contract ────────────────────────────────────────────────────────

#[contract]
pub struct TalosGovernance;

#[contractimpl]
impl TalosGovernance {
    /// Initialize the governance contract with configuration.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `pulse_token_address` - Address of the Pulse token contract
    /// * `quorum_threshold` - Minimum tokens required for quorum
    /// * `consensus_threshold` - Approval threshold in basis points (e.g., 5100 = 51%)
    /// * `voting_period_ledgers` - Duration of voting period in ledgers
    pub fn initialize(
        e: Env,
        pulse_token_address: Address,
        quorum_threshold: i128,
        consensus_threshold: i128,
        voting_period_ledgers: u32,
    ) {
        let config = GovernanceConfig {
            quorum_threshold,
            consensus_threshold,
            voting_period_ledgers,
            pulse_token_address,
        };

        e.storage()
            .persistent()
            .set(&DataKey::Config, &config);
        e.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &1u32);
    }

    /// Create a new governance proposal.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `talos_id` - The Talos ID this proposal concerns
    /// * `title` - Proposal title
    /// * `description` - Proposal description
    ///
    /// Returns the new proposal ID.
    pub fn create_proposal(
        e: Env,
        talos_id: u32,
        title: String,
        description: String,
    ) -> u32 {
        let config: GovernanceConfig = e
            .storage()
            .persistent()
            .get(&DataKey::Config)
            .expect("Contract not initialized");

        let current_ledger = e.ledger().sequence();
        let snapshot_ledger = current_ledger.saturating_sub(10); // Snapshot 10 ledgers ago

        let next_id: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1);

        let proposal = Proposal {
            id: next_id,
            talos_id,
            proposer: e.current_contract_address(),
            title: title.clone(),
            description,
            snapshot_ledger,
            start_ledger: current_ledger,
            end_ledger: current_ledger + config.voting_period_ledgers,
            status: ProposalStatus::Active,
            yes_votes: 0,
            no_votes: 0,
            total_voters: 0,
            created_at: e.ledger().timestamp(),
        };

        e.storage()
            .persistent()
            .set(&DataKey::Proposal(next_id), &proposal);
        e.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &(next_id + 1));

        emit_proposal_created(&e, next_id, talos_id, proposal.proposer);

        next_id
    }

    /// Cast a vote on a proposal.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `proposal_id` - The proposal ID to vote on
    /// * `choice` - Vote choice (Approve or Reject)
    ///
    /// Vote weight is calculated based on the voter's Pulse token balance at the snapshot ledger.
    pub fn vote(e: Env, proposal_id: u32, choice: VoteChoice) {
        let config: GovernanceConfig = e
            .storage()
            .persistent()
            .get(&DataKey::Config)
            .expect("Contract not initialized");

        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        // Check if proposal is still active
        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        let current_ledger = e.ledger().sequence();

        // Check if voting period has ended
        if current_ledger > proposal.end_ledger {
            panic!("Voting period has ended");
        }

        // Check if voting period has started
        if current_ledger < proposal.start_ledger {
            panic!("Voting period has not started");
        }

        let voter = e.current_contract_address();

        // Check if already voted
        if e.storage()
            .persistent()
            .get::<_, Vote>(&DataKey::Vote(proposal_id, voter.clone()))
            .is_some()
        {
            panic!("Already voted on this proposal");
        }

        // Calculate vote weight based on Pulse token balance at snapshot
        let vote_weight = Self::get_vote_weight(&e, &config, &proposal, &voter);

        if vote_weight == 0 {
            panic!("No voting power (zero token balance at snapshot)");
        }

        // Record the vote
        let vote = Vote {
            voter: voter.clone(),
            choice: choice.clone(),
            weight: vote_weight,
            voted_at: e.ledger().timestamp(),
        };

        e.storage()
            .persistent()
            .set(&DataKey::Vote(proposal_id, voter.clone()), &vote);

        // Update proposal tallies
        match choice {
            VoteChoice::Approve => proposal.yes_votes += vote_weight,
            VoteChoice::Reject => proposal.no_votes += vote_weight,
        }
        proposal.total_voters += 1;

        // Check if proposal should be finalized
        let total_votes = proposal.yes_votes + proposal.no_votes;
        let config_ref = &config;
        
        if total_votes >= config_ref.quorum_threshold {
            // Quorum reached, check consensus
            let approval_percentage = if total_votes > 0 {
                (proposal.yes_votes * 10_000) / total_votes
            } else {
                0
            };

            if approval_percentage >= config_ref.consensus_threshold {
                proposal.status = ProposalStatus::Approved;
            } else {
                proposal.status = ProposalStatus::Rejected;
            }

            emit_proposal_status_changed(&e, proposal_id, proposal.status.clone());
        }

        e.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        emit_vote_cast(&e, proposal_id, voter, choice, vote_weight);
    }

    /// Get vote weight based on Pulse token balance at snapshot.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `config` - Governance configuration
    /// * `proposal` - The proposal being voted on
    /// * `voter` - The voter's address
    ///
    /// Returns the vote weight (token balance at snapshot).
    fn get_vote_weight(
        e: &Env,
        _config: &GovernanceConfig,
        proposal: &Proposal,
        voter: &Address,
    ) -> i128 {
        // In a real implementation, this would query the Pulse token contract
        // for the balance at the snapshot ledger using historical data
        // For now, we'll use a simplified approach
        
        // Note: In production, you would use the token contract's interface
        // to query historical balances or implement a snapshot mechanism
        // This is a placeholder that demonstrates the logic
        
        // Try to get cached snapshot balance
        if let Some(cached_balance) = e.storage().persistent().get::<_, i128>(
            &DataKey::TokenBalanceSnapshot(proposal.snapshot_ledger, voter.clone())
        ) {
            return cached_balance;
        }

        // If no cached balance, return 0 (in production, query token contract)
        0
    }

    /// Get a proposal by ID.
    pub fn get_proposal(e: Env, proposal_id: u32) -> Option<Proposal> {
        e.storage().persistent().get(&DataKey::Proposal(proposal_id))
    }

    /// Get a vote for a specific proposal and voter.
    pub fn get_vote(e: Env, proposal_id: u32, voter: Address) -> Option<Vote> {
        e.storage()
            .persistent()
            .get(&DataKey::Vote(proposal_id, voter))
    }

    /// Get the governance configuration.
    pub fn get_config(e: Env) -> Option<GovernanceConfig> {
        e.storage().persistent().get(&DataKey::Config)
    }

    /// Get the next proposal ID.
    pub fn next_proposal_id(e: Env) -> u32 {
        e.storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1)
    }

    /// Update governance configuration (admin only).
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `config` - New governance configuration
    pub fn update_config(e: Env, config: GovernanceConfig) {
        // In production, add admin authentication here
        e.storage().persistent().set(&DataKey::Config, &config);
    }

    /// Manually finalize a proposal if voting period has ended.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `proposal_id` - The proposal ID to finalize
    pub fn finalize_proposal(e: Env, proposal_id: u32) {
        let config: GovernanceConfig = e
            .storage()
            .persistent()
            .get(&DataKey::Config)
            .expect("Contract not initialized");

        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        let current_ledger = e.ledger().sequence();

        if current_ledger <= proposal.end_ledger {
            panic!("Voting period has not ended");
        }

        let total_votes = proposal.yes_votes + proposal.no_votes;

        if total_votes < config.quorum_threshold {
            proposal.status = ProposalStatus::Rejected;
        } else {
            let approval_percentage = if total_votes > 0 {
                (proposal.yes_votes * 10_000) / total_votes
            } else {
                0
            };

            if approval_percentage >= config.consensus_threshold {
                proposal.status = ProposalStatus::Approved;
            } else {
                proposal.status = ProposalStatus::Rejected;
            }
        }

        e.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        emit_proposal_status_changed(&e, proposal_id, proposal.status.clone());
    }

    /// Cache a token balance snapshot for a voter at a specific ledger.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `ledger` - The ledger number for the snapshot
    /// * `address` - The address to snapshot
    /// * `balance` - The token balance at that ledger
    ///
    /// This is a helper function for testing and should be called by
    /// an off-chain process that queries historical token balances.
    pub fn cache_token_balance(e: Env, ledger: u32, address: Address, balance: i128) {
        e.storage()
            .persistent()
            .set(&DataKey::TokenBalanceSnapshot(ledger, address), &balance);
    }
}
