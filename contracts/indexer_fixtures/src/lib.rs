//! indexer_fixtures — Typed event fixtures for Talos Protocol Soroban indexer tests.
//!
//! ## Purpose
//!
//! On-chain Soroban events are a key integration surface for off-chain
//! indexers (e.g. a PostgreSQL-based event store, a webhook dispatcher, or a
//! metrics pipeline). This crate provides:
//!
//! 1. **Typed event structs** that mirror the exact topic + data layout of
//!    every event emitted by `TalosRegistry`, `TalosNameService`, and
//!    `TalosGovernance`. Keeping these structs as a separate crate ensures
//!    indexer code has a single, versioned source of truth rather than
//!    re-deriving shapes from comments in the contract source.
//!
//! 2. **Fixture constructors** (`*_fixture(…)`) that produce canonical
//!    in-memory representations of each event. These are used by
//!    integration tests to assert that live-emitted events can be
//!    deserialized into the expected typed shape without loss.
//!
//! 3. **Round-trip tests** (feature-gated to the host build target) that
//!    exercise the full emit → capture → decode pipeline using the Soroban
//!    test framework. Each test:
//!    a. Sets up a minimal contract environment.
//!    b. Calls the contract entry-point that emits the event.
//!    c. Reads the raw `(contract_id, topics, data)` tuple from
//!       `env.events().all()`.
//!    d. Decodes topics and data into the typed struct.
//!    e. Asserts equality with the fixture value.
//!
//! ## Event schema reference
//!
//! ### TalosRegistry events
//!
//! | Symbol     | Topics                          | Data                                           |
//! |------------|---------------------------------|------------------------------------------------|
//! | `tls_crt`  | `(symbol, creator: Address)`    | `(talos_id: u32, name: String, category: String)` |
//! | `pat_upd`  | `(symbol, talos_id: u32)`       | `(creator: Address, creator_share: u32, investor_share: u32)` |
//! | `fee_chg`  | `(symbol,)`                     | `(old_bps: u32, new_bps: u32)`                 |
//! | `adm_prp`  | `(symbol,)`                     | `(current: Address, proposed: Address)`        |
//! | `adm_acc`  | `(symbol,)`                     | `(new_admin: Address,)`                        |
//! | `adm_cnl`  | `(symbol,)`                     | `(cancelled: Address,)`                        |
//! | `tl_sch`   | `(symbol, proposal_id: u64)`    | `(action: AdminAction, eta: u64, proposer: Address)` |
//! | `tl_exec`  | `(symbol, proposal_id: u64)`    | `(action: AdminAction, executor: Address)`     |
//! | `tl_cnl`   | `(symbol, proposal_id: u64)`    | `(action: AdminAction, canceller: Address)`    |
//! | `tl_cfg`   | `(symbol,)`                     | `(old_min_delay: u64, new_min_delay: u64, grace_period: u64)` |
//!
//! ### TalosNameService events
//!
//! | Symbol     | Topics                          | Data                                           |
//! |------------|---------------------------------|------------------------------------------------|
//! | `name_reg` | `(symbol, talos_id: u32)`       | `(name: String, owner: Address)`               |
//! | `reg_upd`  | `(symbol,)`                     | `(old_registry: Address, new_registry: Address)` |
//! | `tl_sch`   | `(symbol, proposal_id: u64)`    | `(action: NsAdminAction, eta: u64, proposer: Address)` |
//! | `tl_exec`  | `(symbol, proposal_id: u64)`    | `(action: NsAdminAction, executor: Address)`   |
//! | `tl_cnl`   | `(symbol, proposal_id: u64)`    | `(action: NsAdminAction, canceller: Address)`  |
//! | `tl_cfg`   | `(symbol,)`                     | `(old_min_delay: u64, new_min_delay: u64, grace_period: u64)` |
//!
//! ### TalosGovernance events
//!
//! | Symbol      | Topics                          | Data                                           |
//! |-------------|---------------------------------|------------------------------------------------|
//! | `prop_crt`  | `(symbol, proposal_id: u32)`    | `(talos_id: u32, proposer: Address)`           |
//! | `vote`      | `(symbol, proposal_id: u32)`    | `(voter: Address, choice: VoteChoice, weight: i128)` |
//! | `prop_stat` | `(symbol, proposal_id: u32)`    | `(status: ProposalStatus,)`                    |
//! | `ttl_touch` | `(symbol,)`                     | `(class_name: String, keys_touched: u32)`      |
//! | `ttl_warn`  | `(symbol,)`                     | `(class_name: String, keys_below: u32, max_age: u32)` |
//! | `ttl_batch` | `(symbol,)`                     | `(total: u32, touched: u32, skipped: u32)`     |

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{contracttype, Address, Env, String};

// ── Re-export contract action/status types used in event payloads ────

pub use talos_registry::{AdminAction as RegistryAdminAction};
pub use talos_name_service::{AdminAction as NsAdminAction};
pub use talos_governance::{VoteChoice, ProposalStatus};

// ── TalosRegistry typed event structs ──────────────────────────────

/// `tls_crt` — emitted when a new Talos is created.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TalosCreatedEvent {
    // topics
    pub creator: Address,
    // data
    pub talos_id: u32,
    pub name: String,
    pub category: String,
}

/// `pat_upd` — emitted when a Talos patron configuration is updated.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PatronUpdatedEvent {
    // topics
    pub talos_id: u32,
    // data
    pub creator: Address,
    pub creator_share: u32,
    pub investor_share: u32,
}

/// `fee_chg` — emitted when the protocol fee is changed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeChangedEvent {
    // data
    pub old_bps: u32,
    pub new_bps: u32,
}

/// `adm_prp` — emitted when a new admin is proposed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposedEvent {
    // data
    pub current: Address,
    pub proposed: Address,
}

/// `adm_acc` — emitted when the pending admin accepts the transfer.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminAcceptedEvent {
    // data
    pub new_admin: Address,
}

/// `adm_cnl` — emitted when an in-progress admin transfer is cancelled.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminCancelledEvent {
    // data
    pub cancelled: Address,
}

/// `tl_sch` (registry) — emitted when a timelock action is scheduled.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryTimelockScheduledEvent {
    // topics
    pub proposal_id: u64,
    // data
    pub action: RegistryAdminAction,
    pub eta: u64,
    pub proposer: Address,
}

/// `tl_exec` (registry) — emitted when a timelock action is executed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryTimelockExecutedEvent {
    // topics
    pub proposal_id: u64,
    // data
    pub action: RegistryAdminAction,
    pub executor: Address,
}

/// `tl_cnl` (registry) — emitted when a timelock action is cancelled.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryTimelockCancelledEvent {
    // topics
    pub proposal_id: u64,
    // data
    pub action: RegistryAdminAction,
    pub canceller: Address,
}

/// `tl_cfg` — emitted when timelock configuration is changed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockConfigChangedEvent {
    // data
    pub old_min_delay: u64,
    pub new_min_delay: u64,
    pub grace_period: u64,
}

// ── TalosNameService typed event structs ───────────────────────────

/// `name_reg` — emitted when a name is registered for a Talos.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NameRegisteredEvent {
    // topics
    pub talos_id: u32,
    // data
    pub name: String,
    pub owner: Address,
}

/// `reg_upd` — emitted when the registry contract pointer is updated.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryUpdatedEvent {
    // data
    pub old_registry: Address,
    pub new_registry: Address,
}

/// `tl_sch` (name service) — emitted when a timelock action is scheduled.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NsTimelockScheduledEvent {
    // topics
    pub proposal_id: u64,
    // data
    pub action: NsAdminAction,
    pub eta: u64,
    pub proposer: Address,
}

/// `tl_exec` (name service) — emitted when a timelock action is executed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NsTimelockExecutedEvent {
    // topics
    pub proposal_id: u64,
    // data
    pub action: NsAdminAction,
    pub executor: Address,
}

/// `tl_cnl` (name service) — emitted when a timelock action is cancelled.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NsTimelockCancelledEvent {
    // topics
    pub proposal_id: u64,
    // data
    pub action: NsAdminAction,
    pub canceller: Address,
}

// ── TalosGovernance typed event structs ────────────────────────────

/// `prop_crt` — emitted when a governance proposal is created.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreatedEvent {
    // topics
    pub proposal_id: u32,
    // data
    pub talos_id: u32,
    pub proposer: Address,
}

/// `vote` — emitted when a vote is cast on a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCastEvent {
    // topics
    pub proposal_id: u32,
    // data
    pub voter: Address,
    pub choice: VoteChoice,
    pub weight: i128,
}

/// `prop_stat` — emitted when a proposal's status changes.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalStatusChangedEvent {
    // topics
    pub proposal_id: u32,
    // data
    pub status: ProposalStatus,
}

// ── TTL manager typed event structs ────────────────────────────────

/// `ttl_touch` — emitted when one or more storage entries are touched.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TtlTouchedEvent {
    // data
    pub class_name: String,
    pub keys_touched: u32,
}

/// `ttl_warn` — emitted when entries are at risk of archival.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TtlWarningEvent {
    // data
    pub class_name: String,
    pub keys_below: u32,
    pub max_age: u32,
}

/// `ttl_batch` — emitted after a batch maintenance sweep.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TtlBatchEvent {
    // data
    pub total: u32,
    pub touched: u32,
    pub skipped: u32,
}

// ── Fixture constructors ────────────────────────────────────────────
//
// Each constructor takes the values that would be present in a real emission
// and produces a canonical instance of the typed event struct. Tests use
// these to compare against decoded on-chain events without hard-coding
// arbitrary field values.

pub fn talos_created_fixture(
    env: &Env,
    creator: Address,
    talos_id: u32,
    name: &str,
    category: &str,
) -> TalosCreatedEvent {
    TalosCreatedEvent {
        creator,
        talos_id,
        name: String::from_str(env, name),
        category: String::from_str(env, category),
    }
}

pub fn patron_updated_fixture(
    env: &Env,
    talos_id: u32,
    creator: Address,
    creator_share: u32,
    investor_share: u32,
) -> PatronUpdatedEvent {
    PatronUpdatedEvent {
        talos_id,
        creator,
        creator_share,
        investor_share,
    }
}

pub fn fee_changed_fixture(old_bps: u32, new_bps: u32) -> FeeChangedEvent {
    FeeChangedEvent { old_bps, new_bps }
}

pub fn admin_proposed_fixture(current: Address, proposed: Address) -> AdminProposedEvent {
    AdminProposedEvent { current, proposed }
}

pub fn admin_accepted_fixture(new_admin: Address) -> AdminAcceptedEvent {
    AdminAcceptedEvent { new_admin }
}

pub fn admin_cancelled_fixture(cancelled: Address) -> AdminCancelledEvent {
    AdminCancelledEvent { cancelled }
}

pub fn registry_timelock_scheduled_fixture(
    proposal_id: u64,
    action: RegistryAdminAction,
    eta: u64,
    proposer: Address,
) -> RegistryTimelockScheduledEvent {
    RegistryTimelockScheduledEvent {
        proposal_id,
        action,
        eta,
        proposer,
    }
}

pub fn registry_timelock_executed_fixture(
    proposal_id: u64,
    action: RegistryAdminAction,
    executor: Address,
) -> RegistryTimelockExecutedEvent {
    RegistryTimelockExecutedEvent {
        proposal_id,
        action,
        executor,
    }
}

pub fn registry_timelock_cancelled_fixture(
    proposal_id: u64,
    action: RegistryAdminAction,
    canceller: Address,
) -> RegistryTimelockCancelledEvent {
    RegistryTimelockCancelledEvent {
        proposal_id,
        action,
        canceller,
    }
}

pub fn timelock_config_changed_fixture(
    old_min_delay: u64,
    new_min_delay: u64,
    grace_period: u64,
) -> TimelockConfigChangedEvent {
    TimelockConfigChangedEvent {
        old_min_delay,
        new_min_delay,
        grace_period,
    }
}

pub fn name_registered_fixture(
    env: &Env,
    talos_id: u32,
    name: &str,
    owner: Address,
) -> NameRegisteredEvent {
    NameRegisteredEvent {
        talos_id,
        name: String::from_str(env, name),
        owner,
    }
}

pub fn registry_updated_fixture(
    old_registry: Address,
    new_registry: Address,
) -> RegistryUpdatedEvent {
    RegistryUpdatedEvent {
        old_registry,
        new_registry,
    }
}

pub fn ns_timelock_scheduled_fixture(
    proposal_id: u64,
    action: NsAdminAction,
    eta: u64,
    proposer: Address,
) -> NsTimelockScheduledEvent {
    NsTimelockScheduledEvent {
        proposal_id,
        action,
        eta,
        proposer,
    }
}

pub fn ns_timelock_executed_fixture(
    proposal_id: u64,
    action: NsAdminAction,
    executor: Address,
) -> NsTimelockExecutedEvent {
    NsTimelockExecutedEvent {
        proposal_id,
        action,
        executor,
    }
}

pub fn ns_timelock_cancelled_fixture(
    proposal_id: u64,
    action: NsAdminAction,
    canceller: Address,
) -> NsTimelockCancelledEvent {
    NsTimelockCancelledEvent {
        proposal_id,
        action,
        canceller,
    }
}

pub fn proposal_created_fixture(
    proposal_id: u32,
    talos_id: u32,
    proposer: Address,
) -> ProposalCreatedEvent {
    ProposalCreatedEvent {
        proposal_id,
        talos_id,
        proposer,
    }
}

pub fn vote_cast_fixture(
    proposal_id: u32,
    voter: Address,
    choice: VoteChoice,
    weight: i128,
) -> VoteCastEvent {
    VoteCastEvent {
        proposal_id,
        voter,
        choice,
        weight,
    }
}

pub fn proposal_status_changed_fixture(
    proposal_id: u32,
    status: ProposalStatus,
) -> ProposalStatusChangedEvent {
    ProposalStatusChangedEvent { proposal_id, status }
}

pub fn ttl_touched_fixture(env: &Env, class_name: &str, keys_touched: u32) -> TtlTouchedEvent {
    TtlTouchedEvent {
        class_name: String::from_str(env, class_name),
        keys_touched,
    }
}

pub fn ttl_warning_fixture(env: &Env, class_name: &str, keys_below: u32, max_age: u32) -> TtlWarningEvent {
    TtlWarningEvent {
        class_name: String::from_str(env, class_name),
        keys_below,
        max_age,
    }
}

pub fn ttl_batch_fixture(total: u32, touched: u32, skipped: u32) -> TtlBatchEvent {
    TtlBatchEvent { total, touched, skipped }
}

// ── Round-trip tests ────────────────────────────────────────────────
//
// These tests exercise the full emit → capture → decode pipeline.
// They are compiled only in the host (non-WASM) test environment.

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
        IntoVal, Symbol, TryFromVal,
    };
    use talos_registry::{
        AdminAction as RegAction, Kernel, Patron, Pulse, TalosRegistry,
        TalosRegistryClient,
    };
    use talos_name_service::{AdminAction as NsAction, TalosNameService, TalosNameServiceClient};
    use talos_governance::{TalosGovernance, TalosGovernanceClient};

    // ── helpers ──────────────────────────────────────────────────────

    fn s(env: &Env, value: &str) -> soroban_sdk::String {
        soroban_sdk::String::from_str(env, value)
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

    /// Create a registry contract, initialize it, and create one Talos.
    /// Returns `(env, contract_id, client, creator, protocol_wallet, talos_id)`.
    fn setup_registry() -> (
        Env,
        Address,
        TalosRegistryClient<'static>,
        Address,
        Address,
        u32,
    ) {
        let env = Env::default();
        let contract_id = env.register_contract(None, TalosRegistry);
        let client = TalosRegistryClient::new(&env, &contract_id);
        let creator = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);

        client.initialize(&protocol_wallet);

        let name = s(&env, "genesis");
        let category = s(&env, "Marketing");
        let description = s(&env, "Autonomous agent");
        let p = patron(&env, &creator);
        let k = kernel();
        let pu = pulse(&env);

        let talos_id = client
            .mock_auths(&[MockAuth {
                address: &creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_talos",
                    args: (
                        name.clone(),
                        category.clone(),
                        description.clone(),
                        p.clone(),
                        k.clone(),
                        pu.clone(),
                        protocol_wallet.clone(),
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_talos(
                &name,
                &category,
                &description,
                &p,
                &k,
                &pu,
                &protocol_wallet,
            );

        (env, contract_id, client, creator, protocol_wallet, talos_id)
    }

    // ── Helper to decode a single named event from the log ────────────

    /// Find the first event whose first topic matches `expected_sym` and
    /// return the raw topics + data triple.
    fn find_event(
        env: &Env,
        contract_id: &Address,
        expected_sym: Symbol,
    ) -> Option<(soroban_sdk::Vec<soroban_sdk::Val>, soroban_sdk::Val)> {
        for (addr, topics, data) in env.events().all().iter() {
            if addr != *contract_id {
                continue;
            }
            if topics.len() == 0 {
                continue;
            }
            let sym: Result<Symbol, _> =
                TryFromVal::try_from_val(env, &topics.get(0).unwrap());
            if sym.map(|s| s == expected_sym).unwrap_or(false) {
                return Some((topics, data));
            }
        }
        None
    }

    // ─────────────────────────────────────────────────────────────────
    // TalosRegistry event round-trip tests
    // ─────────────────────────────────────────────────────────────────

    /// `tls_crt` event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_tls_crt_round_trip() {
        let (env, contract_id, _client, creator, _pw, talos_id) = setup_registry();

        let (topics, data) = find_event(&env, &contract_id, symbol_short!("tls_crt"))
            .expect("tls_crt event not found");

        // Decode
        let decoded_creator: Address =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_id, decoded_name, decoded_cat): (u32, soroban_sdk::String, soroban_sdk::String) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = talos_created_fixture(&env, creator.clone(), talos_id, "genesis", "Marketing");

        assert_eq!(decoded_creator, fixture.creator);
        assert_eq!(decoded_id, fixture.talos_id);
        assert_eq!(decoded_name, fixture.name);
        assert_eq!(decoded_cat, fixture.category);
    }

    /// `pat_upd` event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_pat_upd_round_trip() {
        let (env, contract_id, client, creator, _pw, talos_id) = setup_registry();

        let new_patron = Patron {
            creator_share: 50,
            investor_share: 30,
            treasury_share: 20,
            creator_addr: creator.clone(),
            investor_addr: Address::generate(&env),
            treasury_addr: Address::generate(&env),
        };

        client
            .mock_auths(&[MockAuth {
                address: &creator,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "update_patron",
                    args: (talos_id, new_patron.clone()).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .update_patron(&talos_id, &new_patron);

        let (topics, data) = find_event(&env, &contract_id, symbol_short!("pat_upd"))
            .expect("pat_upd event not found");

        let decoded_tid: u32 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_creator, decoded_cs, decoded_is): (Address, u32, u32) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture =
            patron_updated_fixture(&env, talos_id, creator.clone(), 50, 30);

        assert_eq!(decoded_tid, fixture.talos_id);
        assert_eq!(decoded_creator, fixture.creator);
        assert_eq!(decoded_cs, fixture.creator_share);
        assert_eq!(decoded_is, fixture.investor_share);
    }

    /// `fee_chg` event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_fee_chg_round_trip() {
        let (env, contract_id, client, _creator, protocol_wallet, _id) = setup_registry();

        client
            .mock_auths(&[MockAuth {
                address: &protocol_wallet,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_protocol_fee",
                    args: (500u32,).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_protocol_fee(&500);

        let (_topics, data) = find_event(&env, &contract_id, symbol_short!("fee_chg"))
            .expect("fee_chg event not found");

        let (decoded_old, decoded_new): (u32, u32) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = fee_changed_fixture(300, 500);

        assert_eq!(decoded_old, fixture.old_bps);
        assert_eq!(decoded_new, fixture.new_bps);
    }

    /// `adm_prp` event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_adm_prp_round_trip() {
        let (env, contract_id, client, _creator, admin, _id) = setup_registry();
        let new_admin = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "propose_admin",
                    args: (new_admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .propose_admin(&new_admin);

        let (_topics, data) = find_event(&env, &contract_id, symbol_short!("adm_prp"))
            .expect("adm_prp event not found");

        let (decoded_current, decoded_proposed): (Address, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = admin_proposed_fixture(admin.clone(), new_admin.clone());

        assert_eq!(decoded_current, fixture.current);
        assert_eq!(decoded_proposed, fixture.proposed);
    }

    /// `adm_acc` event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_adm_acc_round_trip() {
        let (env, contract_id, client, _creator, admin, _id) = setup_registry();
        let new_admin = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "propose_admin",
                    args: (new_admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .propose_admin(&new_admin);

        client
            .mock_auths(&[MockAuth {
                address: &new_admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "accept_admin",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .accept_admin();

        let (_topics, data) = find_event(&env, &contract_id, symbol_short!("adm_acc"))
            .expect("adm_acc event not found");

        let (decoded_new_admin,): (Address,) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = admin_accepted_fixture(new_admin.clone());
        assert_eq!(decoded_new_admin, fixture.new_admin);
    }

    /// `adm_cnl` event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_adm_cnl_round_trip() {
        let (env, contract_id, client, _creator, admin, _id) = setup_registry();
        let new_admin = Address::generate(&env);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "propose_admin",
                    args: (new_admin.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .propose_admin(&new_admin);

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cancel_admin_transfer",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .cancel_admin_transfer();

        let (_topics, data) = find_event(&env, &contract_id, symbol_short!("adm_cnl"))
            .expect("adm_cnl event not found");

        let (decoded_cancelled,): (Address,) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = admin_cancelled_fixture(new_admin.clone());
        assert_eq!(decoded_cancelled, fixture.cancelled);
    }

    /// `tl_sch` (registry) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_registry_tl_sch_round_trip() {
        let (env, contract_id, client, _creator, admin, _id) = setup_registry();

        let action = RegAction::SetProtocolFee(400);
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

        let (topics, data) = find_event(&env, &contract_id, symbol_short!("tl_sch"))
            .expect("tl_sch event not found");

        let decoded_pid: u64 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_action, decoded_eta, decoded_proposer): (RegAction, u64, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = registry_timelock_scheduled_fixture(
            proposal_id,
            action.clone(),
            decoded_eta,   // use live eta — we just validate the shape
            admin.clone(),
        );

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_action, fixture.action);
        assert_eq!(decoded_eta, fixture.eta);
        assert_eq!(decoded_proposer, fixture.proposer);
    }

    /// `tl_exec` (registry) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_registry_tl_exec_round_trip() {
        let (env, contract_id, client, _creator, admin, _id) = setup_registry();

        let action = RegAction::SetProtocolFee(400);
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

        client.execute_action(&proposal_id);

        let (topics, data) = find_event(&env, &contract_id, symbol_short!("tl_exec"))
            .expect("tl_exec event not found");

        let decoded_pid: u64 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_action, decoded_executor): (RegAction, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = registry_timelock_executed_fixture(proposal_id, action.clone(), admin.clone());

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_action, fixture.action);
        assert_eq!(decoded_executor, fixture.executor);
    }

    /// `tl_cnl` (registry) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_registry_tl_cnl_round_trip() {
        let (env, contract_id, client, _creator, admin, _id) = setup_registry();

        let action = RegAction::SetProtocolFee(400);
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

        let (topics, data) = find_event(&env, &contract_id, symbol_short!("tl_cnl"))
            .expect("tl_cnl event not found");

        let decoded_pid: u64 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_action, decoded_canceller): (RegAction, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = registry_timelock_cancelled_fixture(proposal_id, action.clone(), admin.clone());

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_action, fixture.action);
        assert_eq!(decoded_canceller, fixture.canceller);
    }

    /// `tl_cfg` (registry) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_tl_cfg_round_trip() {
        let (env, contract_id, client, _creator, admin, _id) = setup_registry();

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "set_timelock_config",
                    args: (7200u64, 86400u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .set_timelock_config(&7200, &86400);

        let (_topics, data) = find_event(&env, &contract_id, symbol_short!("tl_cfg"))
            .expect("tl_cfg event not found");

        let (decoded_old, decoded_new, decoded_grace): (u64, u64, u64) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = timelock_config_changed_fixture(0, 7200, 86400);

        assert_eq!(decoded_old, fixture.old_min_delay);
        assert_eq!(decoded_new, fixture.new_min_delay);
        assert_eq!(decoded_grace, fixture.grace_period);
    }

    // ─────────────────────────────────────────────────────────────────
    // TalosNameService event round-trip tests
    // ─────────────────────────────────────────────────────────────────

    fn setup_name_service() -> (
        Env,
        Address,   // registry_contract_id
        Address,   // name_service_contract_id
        TalosRegistryClient<'static>,
        TalosNameServiceClient<'static>,
        Address,   // owner
        Address,   // protocol_wallet
        u32,       // talos_id
    ) {
        let env = Env::default();
        let registry_id = env.register_contract(None, TalosRegistry);
        let ns_id = env.register_contract(None, TalosNameService);

        let ns_client = TalosNameServiceClient::new(&env, &ns_id);
        ns_client.initialize(&registry_id);

        let reg_client = TalosRegistryClient::new(&env, &registry_id);
        let owner = Address::generate(&env);
        let protocol_wallet = Address::generate(&env);

        let talos_id = reg_client
            .mock_auths(&[MockAuth {
                address: &owner,
                invoke: &MockAuthInvoke {
                    contract: &registry_id,
                    fn_name: "create_talos",
                    args: (
                        s(&env, "genesis"),
                        s(&env, "Marketing"),
                        s(&env, "desc"),
                        patron(&env, &owner),
                        kernel(),
                        pulse(&env),
                        protocol_wallet.clone(),
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_talos(
                &s(&env, "genesis"),
                &s(&env, "Marketing"),
                &s(&env, "desc"),
                &patron(&env, &owner),
                &kernel(),
                &pulse(&env),
                &protocol_wallet,
            );

        (env, registry_id, ns_id, reg_client, ns_client, owner, protocol_wallet, talos_id)
    }

    /// `name_reg` event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_name_reg_round_trip() {
        let (env, registry_id, ns_id, _reg, ns, owner, _pw, talos_id) = setup_name_service();

        ns.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &MockAuthInvoke {
                contract: &ns_id,
                fn_name: "register_name",
                args: (owner.clone(), talos_id, s(&env, "vega")).into_val(&env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &registry_id,
                    fn_name: "creator_of",
                    args: (talos_id,).into_val(&env),
                    sub_invokes: &[],
                }],
            },
        }])
        .register_name(&owner, &talos_id, &s(&env, "vega"));

        let (topics, data) = find_event(&env, &ns_id, symbol_short!("name_reg"))
            .expect("name_reg event not found");

        let decoded_tid: u32 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_name, decoded_owner): (soroban_sdk::String, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = name_registered_fixture(&env, talos_id, "vega", owner.clone());

        assert_eq!(decoded_tid, fixture.talos_id);
        assert_eq!(decoded_name, fixture.name);
        assert_eq!(decoded_owner, fixture.owner);
    }

    /// `reg_upd` (name service) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_reg_upd_round_trip() {
        let (env, registry_id, ns_id, _reg, ns, _owner, _pw, _tid) = setup_name_service();
        let admin = Address::generate(&env);
        ns.set_admin(&admin);

        let new_registry = Address::generate(&env);
        ns.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &ns_id,
                fn_name: "set_registry_contract",
                args: (new_registry.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_registry_contract(&new_registry);

        let (_topics, data) = find_event(&env, &ns_id, symbol_short!("reg_upd"))
            .expect("reg_upd event not found");

        let (decoded_old, decoded_new): (Address, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = registry_updated_fixture(registry_id.clone(), new_registry.clone());

        assert_eq!(decoded_old, fixture.old_registry);
        assert_eq!(decoded_new, fixture.new_registry);
    }

    /// `tl_sch` (name service) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_ns_tl_sch_round_trip() {
        let (env, _registry_id, ns_id, _reg, ns, _owner, _pw, _tid) = setup_name_service();
        let admin = Address::generate(&env);
        ns.set_admin(&admin);

        let new_registry = Address::generate(&env);
        let action = NsAction::SetRegistryContract(new_registry);
        let proposal_id = ns
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &ns_id,
                    fn_name: "schedule_action",
                    args: (action.clone(), 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .schedule_action(&action, &0);

        let (topics, data) = find_event(&env, &ns_id, symbol_short!("tl_sch"))
            .expect("tl_sch event not found");

        let decoded_pid: u64 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_action, decoded_eta, decoded_proposer): (NsAction, u64, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = ns_timelock_scheduled_fixture(proposal_id, action.clone(), decoded_eta, admin.clone());

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_action, fixture.action);
        assert_eq!(decoded_eta, fixture.eta);
        assert_eq!(decoded_proposer, fixture.proposer);
    }

    /// `tl_exec` (name service) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_ns_tl_exec_round_trip() {
        let (env, _registry_id, ns_id, _reg, ns, _owner, _pw, _tid) = setup_name_service();
        let admin = Address::generate(&env);
        ns.set_admin(&admin);

        let new_registry = Address::generate(&env);
        let action = NsAction::SetRegistryContract(new_registry);
        let proposal_id = ns
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &ns_id,
                    fn_name: "schedule_action",
                    args: (action.clone(), 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .schedule_action(&action, &0);

        ns.execute_action(&proposal_id);

        let (topics, data) = find_event(&env, &ns_id, symbol_short!("tl_exec"))
            .expect("tl_exec event not found");

        let decoded_pid: u64 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_action, decoded_executor): (NsAction, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = ns_timelock_executed_fixture(proposal_id, action.clone(), admin.clone());

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_action, fixture.action);
        assert_eq!(decoded_executor, fixture.executor);
    }

    /// `tl_cnl` (name service) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_ns_tl_cnl_round_trip() {
        let (env, _registry_id, ns_id, _reg, ns, _owner, _pw, _tid) = setup_name_service();
        let admin = Address::generate(&env);
        ns.set_admin(&admin);

        let new_registry = Address::generate(&env);
        let action = NsAction::SetRegistryContract(new_registry);
        let proposal_id = ns
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &ns_id,
                    fn_name: "schedule_action",
                    args: (action.clone(), 0u64).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .schedule_action(&action, &0);

        ns.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &ns_id,
                fn_name: "cancel_action",
                args: (proposal_id,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .cancel_action(&proposal_id);

        let (topics, data) = find_event(&env, &ns_id, symbol_short!("tl_cnl"))
            .expect("tl_cnl event not found");

        let decoded_pid: u64 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_action, decoded_canceller): (NsAction, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = ns_timelock_cancelled_fixture(proposal_id, action.clone(), admin.clone());

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_action, fixture.action);
        assert_eq!(decoded_canceller, fixture.canceller);
    }

    // ─────────────────────────────────────────────────────────────────
    // TalosGovernance event round-trip tests
    // ─────────────────────────────────────────────────────────────────

    fn setup_governance() -> (
        Env,
        Address,
        TalosGovernanceClient<'static>,
        Address, // admin
        Address, // pulse
    ) {
        use soroban_sdk::testutils::Ledger as _;

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

        (env, contract_id, client, admin, pulse)
    }

    /// `prop_crt` event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_prop_crt_round_trip() {
        let (env, contract_id, client, _admin, _pulse) = setup_governance();
        let proposer = Address::generate(&env);

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 7_u32, s(&env, "title"), s(&env, "desc"))
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&proposer, &7u32, &s(&env, "title"), &s(&env, "desc"));

        let (topics, data) = find_event(&env, &contract_id, symbol_short!("prop_crt"))
            .expect("prop_crt event not found");

        let decoded_pid: u32 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_talos_id, decoded_proposer): (u32, Address) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = proposal_created_fixture(proposal_id, 7, proposer.clone());

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_talos_id, fixture.talos_id);
        assert_eq!(decoded_proposer, fixture.proposer);
    }

    /// `vote` event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_vote_round_trip() {
        let (env, contract_id, client, admin, _pulse) = setup_governance();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 7_u32, s(&env, "title"), s(&env, "desc"))
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&proposer, &7u32, &s(&env, "title"), &s(&env, "desc"));

        let proposal = client.get_proposal(&proposal_id).unwrap();

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cache_token_balance",
                    args: (admin.clone(), proposal.snapshot_ledger, voter.clone(), 150_i128)
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .cache_token_balance(&admin, &proposal.snapshot_ledger, &voter, &150_i128);

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

        let (topics, data) = find_event(&env, &contract_id, symbol_short!("vote"))
            .expect("vote event not found");

        let decoded_pid: u32 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let (decoded_voter, decoded_choice, decoded_weight): (Address, VoteChoice, i128) =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = vote_cast_fixture(proposal_id, voter.clone(), VoteChoice::Approve, 150);

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_voter, fixture.voter);
        assert_eq!(decoded_choice, fixture.choice);
        assert_eq!(decoded_weight, fixture.weight);
    }

    /// `prop_stat` (Rejected) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_prop_stat_rejected_round_trip() {
        use soroban_sdk::testutils::Ledger as _;
        let (env, contract_id, client, _admin, _pulse) = setup_governance();
        let proposer = Address::generate(&env);

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1_u32, s(&env, "t"), s(&env, "d")).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&proposer, &1u32, &s(&env, "t"), &s(&env, "d"));

        let proposal = client.get_proposal(&proposal_id).unwrap();

        // Advance past the voting period without any votes → Rejected
        env.ledger().with_mut(|li| {
            li.sequence_number = proposal.end_ledger + 1;
        });

        client.finalize_proposal(&proposal_id);

        let (topics, data) = find_event(&env, &contract_id, symbol_short!("prop_stat"))
            .expect("prop_stat event not found");

        let decoded_pid: u32 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let decoded_status: ProposalStatus =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = proposal_status_changed_fixture(proposal_id, ProposalStatus::Rejected);

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_status, fixture.status);
    }

    /// `prop_stat` (Approved) event: verify typed fixture matches the emitted event.
    #[test]
    fn fixture_prop_stat_approved_round_trip() {
        let (env, contract_id, client, admin, _pulse) = setup_governance();
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let proposal_id = client
            .mock_auths(&[MockAuth {
                address: &proposer,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_proposal",
                    args: (proposer.clone(), 1_u32, s(&env, "t"), s(&env, "d")).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .create_proposal(&proposer, &1u32, &s(&env, "t"), &s(&env, "d"));

        let proposal = client.get_proposal(&proposal_id).unwrap();

        client
            .mock_auths(&[MockAuth {
                address: &admin,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "cache_token_balance",
                    args: (admin.clone(), proposal.snapshot_ledger, voter.clone(), 200_i128)
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .cache_token_balance(&admin, &proposal.snapshot_ledger, &voter, &200_i128);

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

        let (topics, data) = find_event(&env, &contract_id, symbol_short!("prop_stat"))
            .expect("prop_stat event not found");

        let decoded_pid: u32 =
            TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        let decoded_status: ProposalStatus =
            TryFromVal::try_from_val(&env, &data).unwrap();

        let fixture = proposal_status_changed_fixture(proposal_id, ProposalStatus::Approved);

        assert_eq!(decoded_pid, fixture.proposal_id);
        assert_eq!(decoded_status, fixture.status);
    }

    // ─────────────────────────────────────────────────────────────────
    // Fixture constructor unit tests (no contract required)
    // ─────────────────────────────────────────────────────────────────

    /// Fixture constructors produce the expected field values without
    /// requiring a live contract environment.
    #[test]
    fn fixture_constructors_produce_correct_field_values() {
        let env = Env::default();
        let addr_a = Address::generate(&env);
        let addr_b = Address::generate(&env);

        let fee = fee_changed_fixture(300, 500);
        assert_eq!(fee.old_bps, 300);
        assert_eq!(fee.new_bps, 500);

        let adm_prp = admin_proposed_fixture(addr_a.clone(), addr_b.clone());
        assert_eq!(adm_prp.current, addr_a);
        assert_eq!(adm_prp.proposed, addr_b);

        let adm_acc = admin_accepted_fixture(addr_b.clone());
        assert_eq!(adm_acc.new_admin, addr_b);

        let adm_cnl = admin_cancelled_fixture(addr_a.clone());
        assert_eq!(adm_cnl.cancelled, addr_a);

        let tl_cfg = timelock_config_changed_fixture(0, 3600, 86400);
        assert_eq!(tl_cfg.old_min_delay, 0);
        assert_eq!(tl_cfg.new_min_delay, 3600);
        assert_eq!(tl_cfg.grace_period, 86400);

        let reg_upd = registry_updated_fixture(addr_a.clone(), addr_b.clone());
        assert_eq!(reg_upd.old_registry, addr_a);
        assert_eq!(reg_upd.new_registry, addr_b);

        let prop_crt = proposal_created_fixture(1, 7, addr_a.clone());
        assert_eq!(prop_crt.proposal_id, 1);
        assert_eq!(prop_crt.talos_id, 7);
        assert_eq!(prop_crt.proposer, addr_a);

        let vote = vote_cast_fixture(1, addr_b.clone(), VoteChoice::Reject, 42);
        assert_eq!(vote.proposal_id, 1);
        assert_eq!(vote.voter, addr_b);
        assert_eq!(vote.choice, VoteChoice::Reject);
        assert_eq!(vote.weight, 42);

        let ps = proposal_status_changed_fixture(1, ProposalStatus::Executed);
        assert_eq!(ps.proposal_id, 1);
        assert_eq!(ps.status, ProposalStatus::Executed);

        let ttl_t = ttl_touched_fixture(&env, "talos", 3);
        assert_eq!(ttl_t.keys_touched, 3);

        let ttl_w = ttl_warning_fixture(&env, "talos", 2, 4_000_000);
        assert_eq!(ttl_w.keys_below, 2);
        assert_eq!(ttl_w.max_age, 4_000_000);

        let ttl_b = ttl_batch_fixture(10, 7, 3);
        assert_eq!(ttl_b.total, 10);
        assert_eq!(ttl_b.touched, 7);
        assert_eq!(ttl_b.skipped, 3);
    }

    // ─────────────────────────────────────────────────────────────────
    // Boundary / negative fixture tests
    // ─────────────────────────────────────────────────────────────────

    /// Boundary: fee_changed_fixture with both values equal (no-op update).
    #[test]
    fn fixture_fee_chg_same_value_boundary() {
        let f = fee_changed_fixture(300, 300);
        assert_eq!(f.old_bps, f.new_bps);
    }

    /// Boundary: fee_changed_fixture at the maximum allowed value.
    #[test]
    fn fixture_fee_chg_max_boundary() {
        let f = fee_changed_fixture(9_999, 10_000);
        assert_eq!(f.new_bps, 10_000);
    }

    /// Boundary: vote_cast_fixture with the minimum positive weight.
    #[test]
    fn fixture_vote_min_weight_boundary() {
        let env = Env::default();
        let voter = Address::generate(&env);
        let f = vote_cast_fixture(1, voter, VoteChoice::Approve, 1);
        assert_eq!(f.weight, 1);
    }

    /// Boundary: ttl_batch_fixture with all entries skipped (touched = 0).
    #[test]
    fn fixture_ttl_batch_all_skipped_boundary() {
        let f = ttl_batch_fixture(5, 0, 5);
        assert_eq!(f.touched, 0);
        assert_eq!(f.skipped, 5);
        assert_eq!(f.total, 5);
    }

    /// Boundary: ttl_batch_fixture with zero entries.
    #[test]
    fn fixture_ttl_batch_empty_boundary() {
        let f = ttl_batch_fixture(0, 0, 0);
        assert_eq!(f.total, 0);
    }

    /// Boundary: proposal_created_fixture with talos_id = 0 (sentinel).
    #[test]
    fn fixture_proposal_created_zero_talos_id_boundary() {
        let env = Env::default();
        let addr = Address::generate(&env);
        let f = proposal_created_fixture(1, 0, addr);
        assert_eq!(f.talos_id, 0);
    }
}
