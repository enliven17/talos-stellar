//! TalosGovernance — Soroban smart contract for DAO-based governance decisions.
//!
//! Handles:
//! - Proposal creation and lifecycle management
//! - Proposal status tracking (Pending, Active, Approved, Rejected, Executed)
//! - Per-Talos proposal indexing

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, String, Vec,
};

// ── Data Types ──────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalStatus {
    Pending,
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
    pub title: String,
    pub description: String,
    pub target_budget: i128,
    pub status: ProposalStatus,
    pub proposer: Address,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    NextProposalId,
    Proposal(u32),
    TalosProposals(u32),
}

// ── Events ──────────────────────────────────────────────────────────

fn emit_proposal_created(
    env: &Env,
    proposal_id: u32,
    talos_id: u32,
    title: String,
    proposer: Address,
) {
    let topics = (symbol_short!("prop_new"), proposal_id);
    env.events().publish(topics, (talos_id, title, proposer));
}

fn emit_proposal_status_updated(env: &Env, proposal_id: u32, new_status: ProposalStatus) {
    let topics = (symbol_short!("prop_sts"), proposal_id);
    env.events().publish(topics, new_status);
}

// ── Contract ────────────────────────────────────────────────────────

#[contract]
pub struct TalosGovernance;

#[contractimpl]
impl TalosGovernance {
    /// Initialize the governance contract.
    pub fn initialize(e: Env) {
        e.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &1u32);
    }

    /// Create a new governance proposal.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `talos_id` - The Talos ID this proposal belongs to
    /// * `title` - Proposal title
    /// * `description` - Detailed description
    /// * `target_budget` - Budget requested in USDC cents (i128)
    /// * `proposer` - Address of the proposal creator
    ///
    /// Returns the new proposal ID.
    pub fn create_proposal(
        e: Env,
        talos_id: u32,
        title: String,
        description: String,
        target_budget: i128,
        proposer: Address,
    ) -> u32 {
        proposer.require_auth();

        let next_id: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1);

        let proposal = Proposal {
            id: next_id,
            talos_id,
            title: title.clone(),
            description,
            target_budget,
            status: ProposalStatus::Pending,
            proposer: proposer.clone(),
            created_at: e.ledger().timestamp(),
        };

        // Store proposal
        e.storage()
            .persistent()
            .set(&DataKey::Proposal(next_id), &proposal);

        // Index by Talos ID
        let mut talos_proposals: Vec<u32> = e
            .storage()
            .persistent()
            .get(&DataKey::TalosProposals(talos_id))
            .unwrap_or(Vec::new(&e));
        talos_proposals.push_back(next_id);
        e.storage()
            .persistent()
            .set(&DataKey::TalosProposals(talos_id), &talos_proposals);

        // Increment next ID
        e.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &(next_id + 1));

        emit_proposal_created(&e, next_id, talos_id, title, proposer);

        next_id
    }

    /// Get a proposal by its ID.
    /// Returns None if the proposal doesn't exist.
    pub fn get_proposal(e: Env, proposal_id: u32) -> Option<Proposal> {
        e.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }

    /// Update the status of a proposal.
    /// Only the original proposer can update while Pending/Active.
    pub fn update_proposal_status(
        e: Env,
        proposal_id: u32,
        new_status: ProposalStatus,
        caller: Address,
    ) {
        caller.require_auth();

        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        // Only allow status transitions from Pending/Active to new status
        if proposal.status != ProposalStatus::Pending && proposal.status != ProposalStatus::Active
        {
            panic!("Proposal status is already final");
        }

        // Only proposer can update status before finalization
        if proposal.proposer != caller {
            panic!("Only proposer can update status");
        }

        proposal.status = new_status.clone();

        e.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        emit_proposal_status_updated(&e, proposal_id, new_status);
    }

    /// Get all proposal IDs for a given Talos.
    pub fn get_proposals_by_talos(e: Env, talos_id: u32) -> Vec<u32> {
        e.storage()
            .persistent()
            .get(&DataKey::TalosProposals(talos_id))
            .unwrap_or(Vec::new(&e))
    }

    /// Get the total number of proposals created.
    pub fn proposal_count(e: Env) -> u32 {
        let next_id: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1);
        next_id.saturating_sub(1)
    }

    /// Get the next proposal ID (useful for counting).
    pub fn next_proposal_id(e: Env) -> u32 {
        e.storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1)
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);

        client.initialize();
        assert_eq!(client.next_proposal_id(), 1);
    }

    #[test]
    fn test_create_proposal() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let proposer = Address::generate(&env);

        client.initialize();

        let title = String::from_str(&env, "Marketing Campaign");
        let description = String::from_str(&env, "Q3 social media campaign budget");
        let budget = 50000i128;

        env.mock_all_auths();
        let id = client.create_proposal(&1, &title, &description, &budget, &proposer);
        assert_eq!(id, 1);
        assert_eq!(client.next_proposal_id(), 2);
        assert_eq!(client.proposal_count(), 1);

        let proposal = client.get_proposal(&id).unwrap();
        assert_eq!(proposal.id, 1);
        assert_eq!(proposal.talos_id, 1);
        assert_eq!(proposal.title, title);
        assert_eq!(proposal.description, description);
        assert_eq!(proposal.target_budget, budget);
        assert_eq!(proposal.status, ProposalStatus::Pending);
        assert_eq!(proposal.proposer, proposer);
    }

    #[test]
    fn test_update_proposal_status() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let proposer = Address::generate(&env);

        client.initialize();

        let title = String::from_str(&env, "Strategy Update");
        let description = String::from_str(&env, "Update GTM strategy");
        let budget = 10000i128;

        env.mock_all_auths();
        let id = client.create_proposal(&1, &title, &description, &budget, &proposer);

        env.mock_all_auths();
        client.update_proposal_status(&id, &ProposalStatus::Active, &proposer);

        let proposal = client.get_proposal(&id).unwrap();
        assert_eq!(proposal.status, ProposalStatus::Active);
    }

    #[test]
    fn test_get_proposals_by_talos() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let proposer = Address::generate(&env);

        client.initialize();

        let t1 = String::from_str(&env, "Title 1");
        let t2 = String::from_str(&env, "Title 2");
        let desc = String::from_str(&env, "Desc");

        env.mock_all_auths();
        let id1 = client.create_proposal(&1, &t1, &desc, &1000, &proposer);
        let id2 = client.create_proposal(&1, &t2, &desc, &2000, &proposer);
        let id3 = client.create_proposal(&2, &t1, &desc, &3000, &proposer);

        let talos_1_proposals = client.get_proposals_by_talos(&1);
        assert_eq!(talos_1_proposals.len(), 2);
        assert!(talos_1_proposals.contains(&id1));
        assert!(talos_1_proposals.contains(&id2));

        let talos_2_proposals = client.get_proposals_by_talos(&2);
        assert_eq!(talos_2_proposals.len(), 1);
        assert!(talos_2_proposals.contains(&id3));
    }

    #[test]
    #[should_panic(expected = "Only proposer can update status")]
    fn test_unauthorized_status_update() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        let proposer = Address::generate(&env);
        let attacker = Address::generate(&env);

        client.initialize();

        let title = String::from_str(&env, "Title");
        let desc = String::from_str(&env, "Desc");

        env.mock_all_auths();
        let id = client.create_proposal(&1, &title, &desc, &1000, &proposer);

        env.mock_all_auths();
        client.update_proposal_status(&id, &ProposalStatus::Active, &attacker);
    }
}
