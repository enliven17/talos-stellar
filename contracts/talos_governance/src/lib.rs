//! TalosGovernance — Soroban smart contract for DAO-based governance decisions.
//!
//! Handles:
//! - Creating proposals with title, description, target budget, and status
//! - Voting for or against proposals
//! - Finalizing and executing proposals

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};

// ── Data Types ──────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Failed,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u32,
    pub title: String,
    pub description: String,
    pub target_budget: i128,
    pub status: ProposalStatus,
    pub creator: Address,
    pub votes_for: i128,
    pub votes_against: i128,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    NextProposalId,
    Proposal(u32),
    Voted(u32, Address),
}

// ── Events ──────────────────────────────────────────────────────────

fn emit_proposal_created(env: &Env, id: u32, creator: Address, budget: i128) {
    let topics = (symbol_short!("prop_crt"), id);
    env.events().publish(topics, (creator, budget));
}

fn emit_voted(env: &Env, id: u32, voter: Address, approve: bool) {
    let topics = (symbol_short!("voted"), id);
    env.events().publish(topics, (voter, approve));
}

fn emit_proposal_executed(env: &Env, id: u32, status: ProposalStatus) {
    let topics = (symbol_short!("prop_exe"), id);
    env.events().publish(topics, status);
}

// ── Contract ────────────────────────────────────────────────────────

#[contract]
pub struct TalosGovernance;

#[contractimpl]
impl TalosGovernance {
    /// Create a new proposal for DAO-based governance.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `creator` - Address of the proposal creator
    /// * `title` - Short title of the proposal
    /// * `description` - Detailed description of the proposal
    /// * `target_budget` - Target budget in i128
    pub fn create_proposal(
        e: Env,
        creator: Address,
        title: String,
        description: String,
        target_budget: i128,
    ) -> u32 {
        creator.require_auth();

        if title.len() == 0 {
            panic!("Title cannot be empty");
        }
        if description.len() == 0 {
            panic!("Description cannot be empty");
        }
        if target_budget < 0 {
            panic!("Target budget cannot be negative");
        }

        // Get next proposal ID
        let next_id: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1);

        // Build Proposal
        let proposal = Proposal {
            id: next_id,
            title,
            description,
            target_budget,
            status: ProposalStatus::Active,
            creator: creator.clone(),
            votes_for: 0,
            votes_against: 0,
            created_at: e.ledger().timestamp(),
        };

        // Store proposal
        e.storage()
            .persistent()
            .set(&DataKey::Proposal(next_id), &proposal);

        // Increment next proposal ID
        e.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &(next_id + 1));

        // Emit event
        emit_proposal_created(&e, next_id, creator, target_budget);

        next_id
    }

    /// Cast a vote on an active proposal.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `proposal_id` - ID of the proposal to vote on
    /// * `voter` - Address of the voter casting their vote
    /// * `approve` - True to vote in favor, false to vote against
    pub fn vote(e: Env, proposal_id: u32, voter: Address, approve: bool) {
        voter.require_auth();

        // Retrieve proposal
        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        // Check if already voted
        let voted_key = DataKey::Voted(proposal_id, voter.clone());
        if e.storage().persistent().has(&voted_key) {
            panic!("Already voted on this proposal");
        }

        // Record vote
        if approve {
            proposal.votes_for += 1;
        } else {
            proposal.votes_against += 1;
        }

        // Update storage
        e.storage().persistent().set(&voted_key, &true);
        e.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        // Emit vote event
        emit_voted(&e, proposal_id, voter, approve);
    }

    /// Finalize and execute an active proposal based on voting results.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `proposal_id` - ID of the proposal to execute
    pub fn execute_proposal(e: Env, proposal_id: u32) {
        // Retrieve proposal
        let mut proposal: Proposal = e
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("Proposal not found");

        if proposal.status != ProposalStatus::Active {
            panic!("Proposal is not active");
        }

        // Determine outcome: simple majority passing
        if proposal.votes_for > proposal.votes_against {
            proposal.status = ProposalStatus::Passed;
        } else {
            proposal.status = ProposalStatus::Failed;
        }

        // Update proposal in storage
        e.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        // Emit event
        emit_proposal_executed(&e, proposal_id, proposal.status);
    }

    /// Query details of a specific proposal.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `proposal_id` - ID of the proposal to fetch
    pub fn get_proposal(e: Env, proposal_id: u32) -> Option<Proposal> {
        e.storage().persistent().get(&DataKey::Proposal(proposal_id))
    }

    /// Check if an address has voted on a proposal.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `proposal_id` - ID of the proposal
    /// * `voter` - Address of the voter
    pub fn has_voted(e: Env, proposal_id: u32, voter: Address) -> bool {
        e.storage()
            .persistent()
            .has(&DataKey::Voted(proposal_id, voter))
    }

    /// Get the next proposal ID.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    pub fn next_proposal_id(e: Env) -> u32 {
        e.storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1)
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        IntoVal,
    };

    fn setup() -> (Env, Address, TalosGovernanceClient<'static>) {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosGovernance);
        let client = TalosGovernanceClient::new(&env, &contract_id);
        (env, contract_id, client)
    }

    fn s(env: &Env, value: &str) -> String {
        String::from_str(env, value)
    }

    #[test]
    fn test_create_proposal() {
        let (env, contract_id, client) = setup();
        let creator = Address::generate(&env);

        let title = s(&env, "Upgrade core Protocol");
        let description = s(&env, "This proposal upgrades the core contract functions.");
        let target_budget = 50_000_i128;

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (
                        creator.clone(),
                        title.clone(),
                        description.clone(),
                        target_budget,
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&creator, &title, &description, &target_budget);

        assert_eq!(proposal_id, 1);
        assert_eq!(client.next_proposal_id(), 2);

        let proposal = client.get_proposal(&proposal_id).expect("Proposal should exist");
        assert_eq!(proposal.id, 1);
        assert_eq!(proposal.title, title);
        assert_eq!(proposal.description, description);
        assert_eq!(proposal.target_budget, target_budget);
        assert_eq!(proposal.status, ProposalStatus::Active);
        assert_eq!(proposal.creator, creator);
        assert_eq!(proposal.votes_for, 0);
        assert_eq!(proposal.votes_against, 0);
    }

    #[test]
    fn test_voting_flow() {
        let (env, contract_id, client) = setup();
        let creator = Address::generate(&env);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);

        let title = s(&env, "Community Grant");
        let description = s(&env, "Grant for marketing campaigns.");
        let target_budget = 10_000_i128;

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (
                        creator.clone(),
                        title.clone(),
                        description.clone(),
                        target_budget,
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&creator, &title, &description, &target_budget);

        // Cast yes vote from voter1
        client
            .mock_auths(&[MockAuth {
                address: &voter1,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (proposal_id, voter1.clone(), true).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&proposal_id, &voter1, &true);

        // Cast no vote from voter2
        client
            .mock_auths(&[MockAuth {
                address: &voter2,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (proposal_id, voter2.clone(), false).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&proposal_id, &voter2, &false);

        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.votes_for, 1);
        assert_eq!(proposal.votes_against, 1);
        assert!(client.has_voted(&proposal_id, &voter1));
        assert!(client.has_voted(&proposal_id, &voter2));
    }

    #[test]
    fn test_proposal_execution() {
        let (env, contract_id, client) = setup();
        let creator = Address::generate(&env);
        let voter = Address::generate(&env);

        let title = s(&env, "Execute action");
        let description = s(&env, "Description of the action.");
        let target_budget = 5_000_i128;

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (
                        creator.clone(),
                        title.clone(),
                        description.clone(),
                        target_budget,
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&creator, &title, &description, &target_budget);

        // Vote yes
        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (proposal_id, voter.clone(), true).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&proposal_id, &voter, &true);

        // Execute
        client.execute_proposal(&proposal_id);

        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.status, ProposalStatus::Passed);
    }

    #[test]
    #[should_panic(expected = "Already voted on this proposal")]
    fn test_double_voting_panics() {
        let (env, contract_id, client) = setup();
        let creator = Address::generate(&env);
        let voter = Address::generate(&env);

        let title = s(&env, "Unique vote test");
        let description = s(&env, "Should not allow duplicate votes.");
        let target_budget = 0_i128;

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (
                        creator.clone(),
                        title.clone(),
                        description.clone(),
                        target_budget,
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&creator, &title, &description, &target_budget);

        // Vote once
        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (proposal_id, voter.clone(), true).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&proposal_id, &voter, &true);

        // Vote twice
        client
            .mock_auths(&[MockAuth {
                address: &voter,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "vote",
                    args: (proposal_id, voter.clone(), true).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .vote(&proposal_id, &voter, &true);
    }
}
