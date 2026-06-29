//! TalosGovernance - Soroban smart contract for token-weighted governance.

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};

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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceConfig {
    pub quorum_threshold: i128,
    pub consensus_threshold: i128,
    pub voting_period_ledgers: u32,
    pub pulse_token_address: Address,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Config,
    NextProposalId,
    Proposal(u32),
    Vote(u32, Address),
    TokenBalanceSnapshot(u32, Address),
}

fn emit_proposal_created(env: &Env, proposal_id: u32, talos_id: u32, proposer: Address) {
    env.events().publish(
        (symbol_short!("prop_crt"), proposal_id),
        (talos_id, proposer),
    );
}

fn emit_vote_cast(env: &Env, proposal_id: u32, voter: Address, choice: VoteChoice, weight: i128) {
    env.events().publish(
        (symbol_short!("vote"), proposal_id),
        (voter, choice, weight),
    );
}

fn emit_proposal_status_changed(env: &Env, proposal_id: u32, status: ProposalStatus) {
    env.events()
        .publish((symbol_short!("prop_stat"), proposal_id), status);
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
        };

        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::Config, &config);
        env.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &1u32);
    }

    pub fn create_proposal(
        env: Env,
        proposer: Address,
        talos_id: u32,
        title: String,
        description: String,
    ) -> u32 {
        proposer.require_auth();

        if title.len() == 0 {
            panic!("Title cannot be empty");
        }
        if description.len() == 0 {
            panic!("Description cannot be empty");
        }

        let config = Self::require_config(&env);
        let current_ledger = env.ledger().sequence();
        let snapshot_ledger = current_ledger.saturating_sub(10);
        let proposal_id = Self::next_proposal_id(env.clone());

        let proposal = Proposal {
            id: proposal_id,
            talos_id,
            proposer: proposer.clone(),
            title,
            description,
            snapshot_ledger,
            start_ledger: current_ledger,
            end_ledger: current_ledger + config.voting_period_ledgers,
            status: ProposalStatus::Active,
            yes_votes: 0,
            no_votes: 0,
            total_voters: 0,
            created_at: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::NextProposalId, &(proposal_id + 1));

        emit_proposal_created(&env, proposal_id, talos_id, proposer);
        proposal_id
    }

    pub fn vote(env: Env, voter: Address, proposal_id: u32, choice: VoteChoice) {
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

        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        emit_proposal_status_changed(&env, proposal_id, ProposalStatus::Executed);
    }

    pub fn cache_token_balance(
        env: Env,
        admin: Address,
        ledger: u32,
        address: Address,
        balance: i128,
    ) {
        Self::require_admin(&env, &admin);
        if balance < 0 {
            panic!("Balance cannot be negative");
        }
        env.storage()
            .persistent()
            .set(&DataKey::TokenBalanceSnapshot(ledger, address), &balance);
    }

    pub fn update_config(env: Env, admin: Address, config: GovernanceConfig) {
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
        env.storage().persistent().set(&DataKey::Config, &config);
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

    pub fn next_proposal_id(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::NextProposalId)
            .unwrap_or(1)
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
        env.storage()
            .persistent()
            .get(&DataKey::TokenBalanceSnapshot(snapshot_ledger, voter))
            .unwrap_or(0)
    }

    fn update_status_if_quorum(env: &Env, proposal: &mut Proposal) {
        let config = Self::require_config(env);
        let total_votes = proposal.yes_votes + proposal.no_votes;
        if total_votes >= config.quorum_threshold {
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
}

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
        IntoVal,
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
}
