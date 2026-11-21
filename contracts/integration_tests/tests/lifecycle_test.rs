//! Cross-contract lifecycle integration test suite.
//!
//! Registers all four core Talos contracts in a single [`Env`] and walks
//! through the complete protocol lifecycle:
//!
//! 1. Create a Talos in the registry with two patrons.
//! 2. Register a human-readable name in the name service.
//! 3. Create a governance proposal, cast votes, finalize, and execute it.
//! 4. Commit a dividend epoch and have each patron claim their allocation.
//! 5. Pause and unpause a domain — verify the domain state invariant.
//! 6. Deactivate the Talos and confirm the name record is still resolvable.
//!
//! Every step asserts cross-contract invariants so a regression in any
//! contract is caught at the integration boundary rather than in unit tests.
//!
//! Budget note: the three heaviest calls (create_talos, vote, claim_dividend)
//! are exercised in `heaviest_calls_complete_within_instruction_budget` which
//! verifies they do not exhaust the host budget at the current soroban-sdk
//! resource ceiling (100M CPU instructions per call).

#![cfg(not(target_arch = "wasm32"))]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, Env, String,
};

use talos_dividends::TalosDividendsClient;
use talos_governance::{TalosGovernanceClient, VoteChoice};
use talos_name_service::TalosNameServiceClient;
use talos_registry::{Kernel, Patron, Pulse, TalosRegistryClient};

// ── Helpers ──────────────────────────────────────────────────────────────────

fn setup_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set(LedgerInfo {
        timestamp: 1_000_000,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_312_000,
    });
    env
}

fn make_patron(creator: &Address, investor: &Address, treasury: &Address) -> Patron {
    Patron {
        creator_share: 50,
        investor_share: 30,
        treasury_share: 20,
        creator_addr: creator.clone(),
        investor_addr: investor.clone(),
        treasury_addr: treasury.clone(),
    }
}

fn make_kernel() -> Kernel {
    Kernel {
        approval_threshold: 1,
        gtm_budget: 10_000,
        min_patron_pulse: 1,
    }
}

fn make_pulse(env: &Env) -> Pulse {
    Pulse {
        total_supply: 1_000_000,
        price_usd_cents: 100,
        token_symbol: String::from_str(env, "TEST"),
    }
}

// ── Full lifecycle test ───────────────────────────────────────────────────────

/// Walk the full cross-contract lifecycle from Talos creation through
/// governance, dividend claims, pause/unpause, and deactivation.
///
/// Cross-contract invariants asserted at every step:
/// - Name resolves to the active Talos after registration.
/// - Governance proposal reaches Executed status after vote + finalize.
/// - Claims sum to exactly the committed amount (accounting invariant).
/// - Double-claim is rejected.
/// - Domain pause state is reflected correctly in pause_control storage.
/// - Talos name persists after deactivation (read-only path is not gated).
#[test]
fn full_lifecycle_registry_name_governance_dividends_pause_deactivate() {
    let env = setup_env();

    // ── Actors ───────────────────────────────────────────────────────────────
    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let investor = Address::generate(&env);
    let treasury = Address::generate(&env);
    let governance_admin = Address::generate(&env);
    let dividends_admin = Address::generate(&env);
    let dummy_token = Address::generate(&env);

    // ── Deploy contracts ──────────────────────────────────────────────────────
    let registry_id = env.register_contract(None, talos_registry::TalosRegistry);
    let name_service_id = env.register_contract(None, talos_name_service::TalosNameService);
    let governance_id = env.register_contract(None, talos_governance::TalosGovernance);
    let dividends_id = env.register_contract(None, talos_dividends::TalosDividends);

    let registry = TalosRegistryClient::new(&env, &registry_id);
    let name_service = TalosNameServiceClient::new(&env, &name_service_id);
    let governance = TalosGovernanceClient::new(&env, &governance_id);
    let dividends = TalosDividendsClient::new(&env, &dividends_id);

    // ── Initialization ────────────────────────────────────────────────────────
    name_service.initialize(&registry_id, &admin, &0i128);
    governance.initialize(
        &governance_admin,
        &dummy_token,
        &1i128,    // quorum_threshold — 1 token is enough
        &5000i128, // consensus_threshold — 50% (bps)
        &10u32,    // voting_period_ledgers
    );
    dividends
        .initialize(&dividends_admin, &registry_id)
        .unwrap();

    // ── Step 1: Create a Talos ────────────────────────────────────────────────
    let talos_id = registry.create_talos(
        &String::from_str(&env, "LifecycleBot"),
        &String::from_str(&env, "Marketing"),
        &String::from_str(&env, "Integration test bot for cross-contract lifecycle."),
        &make_patron(&creator, &investor, &treasury),
        &make_kernel(),
        &make_pulse(&env),
        &admin, // protocol_wallet
    );

    // Invariant: Talos exists and is active immediately after creation.
    let talos = registry
        .get_talos(&talos_id)
        .expect("Talos must exist after creation");
    assert!(talos.active, "Newly created Talos must be active");
    assert_eq!(registry.is_active(&talos_id), true);
    assert_eq!(
        registry.creator_of(&talos_id),
        Some(creator.clone()),
        "creator_of must return the creator address"
    );

    // ── Step 2: Register a name ───────────────────────────────────────────────
    let name_str = String::from_str(&env, "lifecycle-bot");
    name_service.register_name(&creator, &talos_id, &name_str);

    // Invariant: name resolves to our Talos.
    let resolved_id = name_service
        .resolve_name(&name_str)
        .expect("Name must resolve after registration");
    assert_eq!(
        resolved_id, talos_id,
        "Registered name must resolve to the correct Talos ID"
    );
    assert_eq!(
        name_service.name_of(&talos_id),
        Some(name_str.clone()),
        "name_of must return the registered name"
    );

    // ── Step 3: Create governance proposal ───────────────────────────────────
    // Pre-cache token balances at the snapshot ledger so voters have weight.
    // create_proposal computes snapshot_ledger = current_sequence - 10.
    let current_seq = env.ledger().sequence();
    let snapshot_ledger = current_seq.saturating_sub(10);
    governance.cache_token_balance(&governance_admin, &snapshot_ledger, &creator, &500i128);
    governance.cache_token_balance(&governance_admin, &snapshot_ledger, &investor, &300i128);

    let proposal_id = governance.create_proposal(
        &creator,
        &talos_id,
        &String::from_str(&env, "Increase GTM Budget"),
        &String::from_str(&env, "Proposal to double the go-to-market budget for Q3."),
    );

    // Invariant: proposal is Active immediately after creation.
    let proposal = governance
        .get_proposal(&proposal_id)
        .expect("Proposal must exist after creation");
    assert_eq!(proposal.talos_id, talos_id);
    assert_eq!(
        proposal.status,
        talos_governance::ProposalStatus::Active,
        "Proposal must be Active immediately after creation"
    );

    // ── Step 4: Cast votes ────────────────────────────────────────────────────
    governance.vote(&creator, &proposal_id, &VoteChoice::Approve);
    governance.vote(&investor, &proposal_id, &VoteChoice::Approve);

    // Invariant: vote counts are updated.
    let proposal_after_votes = governance
        .get_proposal(&proposal_id)
        .expect("Proposal must still exist after votes");
    assert!(
        proposal_after_votes.yes_votes > 0,
        "Yes votes must be recorded (got {})",
        proposal_after_votes.yes_votes
    );
    assert_eq!(
        proposal_after_votes.total_voters, 2,
        "Two distinct voters must be recorded"
    );

    // ── Step 5: Finalize proposal ─────────────────────────────────────────────
    // Advance the ledger past end_ledger (sequence 100 + voting_period 10 = 110).
    env.ledger().set(LedgerInfo {
        timestamp: 1_100_000,
        protocol_version: 22,
        sequence_number: current_seq + 20, // past end_ledger
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_312_000,
    });
    governance.finalize_proposal(&proposal_id);

    let finalized = governance
        .get_proposal(&proposal_id)
        .expect("Proposal must exist after finalization");
    // 500 + 300 = 800 yes votes, 0 no → quorum (1) and majority (50%) met.
    assert_eq!(
        finalized.status,
        talos_governance::ProposalStatus::Approved,
        "Proposal with unanimous yes votes must be Approved after finalization"
    );

    // ── Step 6: Execute proposal ──────────────────────────────────────────────
    governance.execute_proposal(&proposal_id);

    let executed = governance
        .get_proposal(&proposal_id)
        .expect("Proposal must exist after execution");
    assert_eq!(
        executed.status,
        talos_governance::ProposalStatus::Executed,
        "Proposal must be Executed after execute_proposal()"
    );

    // ── Step 7: Commit a dividend epoch ──────────────────────────────────────
    // total_amount = 1000; patron splits: creator=50%, investor=30%, treasury=20%.
    let total_dividend: i128 = 1000;
    let expiry_secs: u64 = 3_600 * 24 * 30; // 30 days

    let epoch_id = dividends
        .commit_epoch(&dividends_admin, &talos_id, &total_dividend, &expiry_secs)
        .unwrap();

    // Invariant: first epoch_id starts at 1.
    assert_eq!(epoch_id, 1u64, "First epoch_id must be 1");

    // ── Step 8: Claim dividends ───────────────────────────────────────────────
    let creator_allocation = dividends
        .claim_dividend(
            &creator, &talos_id, &epoch_id,
            &creator, &investor, &treasury,
            &50u32, &30u32, &20u32,
        )
        .unwrap();

    let investor_allocation = dividends
        .claim_dividend(
            &investor, &talos_id, &epoch_id,
            &creator, &investor, &treasury,
            &50u32, &30u32, &20u32,
        )
        .unwrap();

    let treasury_allocation = dividends
        .claim_dividend(
            &treasury, &talos_id, &epoch_id,
            &creator, &investor, &treasury,
            &50u32, &30u32, &20u32,
        )
        .unwrap();

    // Invariant: exact share-proportional allocations.
    assert_eq!(creator_allocation, 500i128, "Creator (50%) of 1000 = 500");
    assert_eq!(investor_allocation, 300i128, "Investor (30%) of 1000 = 300");
    assert_eq!(treasury_allocation, 200i128, "Treasury (20%) of 1000 = 200");

    // Invariant: sum of claims ≤ total_amount (accounting invariant).
    let claims_sum = creator_allocation + investor_allocation + treasury_allocation;
    assert!(
        claims_sum <= total_dividend,
        "Sum of claims ({}) must not exceed total_amount ({})",
        claims_sum,
        total_dividend
    );

    // ── Step 9: Double-claim is rejected ─────────────────────────────────────
    let double_claim = dividends.claim_dividend(
        &creator, &talos_id, &epoch_id,
        &creator, &investor, &treasury,
        &50u32, &30u32, &20u32,
    );
    assert!(
        double_claim.is_err(),
        "Double-claim must be rejected (AlreadyClaimed error expected)"
    );

    // ── Step 10: Pause a domain and verify state ──────────────────────────────
    // pause_control writes directly to the shared Env storage, which is the
    // same storage the registry's check_not_paused reads from.
    let pause_domain_id: u32 = talos_registry::PAUSE_TALOS_CREATION;
    pause_control::pause_domain(&env, pause_domain_id, &admin, 0u64); // indefinite

    assert!(
        pause_control::is_paused(&env, pause_domain_id),
        "TalosCreation domain must be paused after pause_domain()"
    );

    // Unpause and verify cleared.
    pause_control::unpause_domain(&env, pause_domain_id, &admin);
    assert!(
        !pause_control::is_paused(&env, pause_domain_id),
        "TalosCreation domain must be unpaused after unpause_domain()"
    );

    // ── Step 11: Deactivate the Talos ─────────────────────────────────────────
    registry.deactivate_talos(&talos_id, &creator);

    // Invariant: Talos is now inactive.
    assert_eq!(
        registry.is_active(&talos_id),
        false,
        "Talos must be inactive after deactivation"
    );
    let deactivated = registry
        .get_talos(&talos_id)
        .expect("Talos must still be retrievable after deactivation");
    assert!(!deactivated.active);

    // Invariant: name still resolves (read-only, not gated by active status).
    let still_resolved = name_service
        .resolve_name(&name_str)
        .expect("Name must still resolve after Talos deactivation");
    assert_eq!(
        still_resolved, talos_id,
        "Name must still map to the Talos ID after deactivation"
    );

    // Invariant: the executed proposal still carries the correct talos_id.
    let final_proposal = governance
        .get_proposal(&proposal_id)
        .expect("Executed proposal must remain readable");
    assert_eq!(
        final_proposal.talos_id, talos_id,
        "Executed proposal must reference the correct Talos"
    );
}

// ── Targeted invariant tests ──────────────────────────────────────────────────

/// Duplicate name registration must fail and preserve the original binding.
#[test]
fn name_service_rejects_duplicate_name() {
    let env = setup_env();

    let admin = Address::generate(&env);
    let creator_a = Address::generate(&env);
    let creator_b = Address::generate(&env);
    let investor = Address::generate(&env);
    let treasury = Address::generate(&env);

    let registry_id = env.register_contract(None, talos_registry::TalosRegistry);
    let name_service_id = env.register_contract(None, talos_name_service::TalosNameService);

    let registry = TalosRegistryClient::new(&env, &registry_id);
    let name_service = TalosNameServiceClient::new(&env, &name_service_id);

    name_service.initialize(&registry_id, &admin, &0i128);

    // Create two independent Taloses.
    let talos_a = registry.create_talos(
        &String::from_str(&env, "BotAlpha"),
        &String::from_str(&env, "Sales"),
        &String::from_str(&env, "First bot"),
        &make_patron(&creator_a, &investor, &treasury),
        &make_kernel(),
        &make_pulse(&env),
        &admin,
    );
    let talos_b = registry.create_talos(
        &String::from_str(&env, "BotBeta"),
        &String::from_str(&env, "Sales"),
        &String::from_str(&env, "Second bot"),
        &make_patron(&creator_b, &investor, &treasury),
        &make_kernel(),
        &make_pulse(&env),
        &admin,
    );

    let shared_name = String::from_str(&env, "shared-name");

    // First registration succeeds.
    name_service.register_name(&creator_a, &talos_a, &shared_name);
    assert_eq!(name_service.resolve_name(&shared_name), Some(talos_a));

    // Second registration of the same name must panic.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        name_service.register_name(&creator_b, &talos_b, &shared_name);
    }));
    assert!(
        result.is_err(),
        "Name service must reject duplicate name registration"
    );

    // Original binding is preserved.
    assert_eq!(
        name_service.resolve_name(&shared_name),
        Some(talos_a),
        "Original name binding must survive the failed duplicate registration"
    );

    let _ = talos_b; // suppress unused warning
}

/// Dividend claims must satisfy the accounting invariant.
#[test]
fn dividend_claims_satisfy_accounting_invariant() {
    let env = setup_env();

    let creator = Address::generate(&env);
    let investor = Address::generate(&env);
    let treasury = Address::generate(&env);
    let admin = Address::generate(&env);
    let dividends_admin = Address::generate(&env);

    let registry_id = env.register_contract(None, talos_registry::TalosRegistry);
    let dividends_id = env.register_contract(None, talos_dividends::TalosDividends);

    let registry = TalosRegistryClient::new(&env, &registry_id);
    let dividends = TalosDividendsClient::new(&env, &dividends_id);

    dividends.initialize(&dividends_admin, &registry_id).unwrap();

    let talos_id = registry.create_talos(
        &String::from_str(&env, "AccountingBot"),
        &String::from_str(&env, "Finance"),
        &String::from_str(&env, "Tests the dividend accounting invariant"),
        &make_patron(&creator, &investor, &treasury),
        &make_kernel(),
        &make_pulse(&env),
        &admin,
    );

    // total = 9000 so all 50%/30%/20% allocations are whole integers.
    let total: i128 = 9000;
    let epoch_id = dividends
        .commit_epoch(&dividends_admin, &talos_id, &total, &86_400u64)
        .unwrap();

    let c = dividends
        .claim_dividend(&creator, &talos_id, &epoch_id, &creator, &investor, &treasury, &50u32, &30u32, &20u32)
        .unwrap();
    let i = dividends
        .claim_dividend(&investor, &talos_id, &epoch_id, &creator, &investor, &treasury, &50u32, &30u32, &20u32)
        .unwrap();
    let t = dividends
        .claim_dividend(&treasury, &talos_id, &epoch_id, &creator, &investor, &treasury, &50u32, &30u32, &20u32)
        .unwrap();

    assert_eq!(c, 4500i128, "Creator (50%) of 9000 = 4500");
    assert_eq!(i, 2700i128, "Investor (30%) of 9000 = 2700");
    assert_eq!(t, 1800i128, "Treasury (20%) of 9000 = 1800");

    // Key invariant: no over-distribution.
    assert!(
        c + i + t <= total,
        "Sum of claims {} must not exceed total_amount {}",
        c + i + t,
        total
    );
}

/// Pausing the TalosCreation domain must block create_talos.
#[test]
#[should_panic]
fn paused_registry_creation_domain_blocks_create_talos() {
    let env = setup_env();

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let investor = Address::generate(&env);
    let treasury = Address::generate(&env);

    let registry_id = env.register_contract(None, talos_registry::TalosRegistry);
    let registry = TalosRegistryClient::new(&env, &registry_id);

    // Pause the TalosCreation domain indefinitely.
    pause_control::pause_domain(&env, talos_registry::PAUSE_TALOS_CREATION, &admin, 0u64);

    // Must panic because the domain is paused.
    registry.create_talos(
        &String::from_str(&env, "ShouldFail"),
        &String::from_str(&env, "Marketing"),
        &String::from_str(&env, "Should not be created while domain is paused"),
        &make_patron(&creator, &investor, &treasury),
        &make_kernel(),
        &make_pulse(&env),
        &admin,
    );
}

/// The three heaviest calls must complete without exhausting the host budget.
/// (Soroban's per-call ceiling is 100 million CPU instructions.)
#[test]
fn heaviest_calls_complete_within_instruction_budget() {
    let env = setup_env();

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let investor = Address::generate(&env);
    let treasury = Address::generate(&env);
    let governance_admin = Address::generate(&env);
    let dividends_admin = Address::generate(&env);
    let dummy_token = Address::generate(&env);

    let registry_id = env.register_contract(None, talos_registry::TalosRegistry);
    let governance_id = env.register_contract(None, talos_governance::TalosGovernance);
    let dividends_id = env.register_contract(None, talos_dividends::TalosDividends);

    let registry = TalosRegistryClient::new(&env, &registry_id);
    let governance = TalosGovernanceClient::new(&env, &governance_id);
    let dividends = TalosDividendsClient::new(&env, &dividends_id);

    dividends.initialize(&dividends_admin, &registry_id).unwrap();
    governance.initialize(&governance_admin, &dummy_token, &1i128, &5000i128, &10u32);

    // Heaviest registry call: create_talos.
    let talos_id = registry.create_talos(
        &String::from_str(&env, "BudgetBot"),
        &String::from_str(&env, "Marketing"),
        &String::from_str(&env, "Budget assertion bot"),
        &make_patron(&creator, &investor, &treasury),
        &make_kernel(),
        &make_pulse(&env),
        &admin,
    );

    // Heaviest governance call: vote (requires balance snapshot lookup).
    let seq = env.ledger().sequence();
    governance.cache_token_balance(&governance_admin, &seq.saturating_sub(10), &creator, &100i128);
    let pid = governance.create_proposal(
        &creator,
        &talos_id,
        &String::from_str(&env, "Budget Test"),
        &String::from_str(&env, "Budget test proposal"),
    );
    governance.vote(&creator, &pid, &VoteChoice::Approve);

    // Heaviest dividend call: claim_dividend (requires epoch + accounting update).
    let epoch_id = dividends
        .commit_epoch(&dividends_admin, &talos_id, &1000i128, &86_400u64)
        .unwrap();
    dividends
        .claim_dividend(
            &creator, &talos_id, &epoch_id,
            &creator, &investor, &treasury,
            &50u32, &30u32, &20u32,
        )
        .unwrap();

    // If all calls reached this point the budget ceiling was not exceeded.
}
