//! Focused tests for the bounded name-transfer history.
//!
//! Exercises the proposal/acceptance/cancellation/expiry event references and
//! the bounded on-chain log, and asserts historical agent identifiers stay
//! stable across ownership changes. Synthetic data via `Env::default()` —
//! no live network.

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal, TryFromVal,
    };
    use std::string::ToString;
    use talos_registry::{Kernel, Patron, Pulse, TalosRegistry, TalosRegistryClient};

    fn s(env: &Env, v: &str) -> String {
        String::from_str(env, v)
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

    fn pulse(env: &Env, sym: &str) -> Pulse {
        Pulse {
            total_supply: 1_000_000,
            price_usd_cents: 100,
            token_symbol: s(env, sym),
        }
    }

    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        TalosRegistryClient<'static>,
        TalosNameServiceClient<'static>,
    ) {
        let env = Env::default();
        let registry_contract = env.register_contract(None, TalosRegistry);
        let name_service_contract = env.register_contract(None, TalosNameService);
        let name_service_client = TalosNameServiceClient::new(&env, &name_service_contract);
        let admin = Address::generate(&env);
        name_service_client.initialize(&registry_contract, &admin, &0i128);
        let registry_client = TalosRegistryClient::new(&env, &registry_contract);
        (
            env,
            registry_contract,
            name_service_contract,
            admin,
            registry_client,
            name_service_client,
        )
    }

    fn create_talos(
        env: &Env,
        client: &TalosRegistryClient,
        contract_id: &Address,
        creator: &Address,
        wallet: &Address,
    ) -> u32 {
        let name = s(env, "vega");
        let category = s(env, "Marketing");
        let description = s(env, "Autonomous marketing agent");
        let patron = patron(env, creator);
        let kernel = kernel();
        let pulse = pulse(env, "TLOS");

        client
            .mock_auths(&[MockAuth {
                address: creator,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "create_talos",
                    args: (
                        name.clone(),
                        category.clone(),
                        description.clone(),
                        patron.clone(),
                        kernel.clone(),
                        pulse.clone(),
                        wallet.clone(),
                    )
                        .into_val(env),
                    sub_invokes: &[],
                },
            }])
            .create_talos(&name, &category, &description, &patron, &kernel, &pulse, wallet)
    }

    fn register_name(
        env: &Env,
        client: &TalosNameServiceClient,
        ns_id: &Address,
        registry_contract: &Address,
        owner: &Address,
        talos_id: u32,
        name: &String,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: owner,
                invoke: &MockAuthInvoke {
                    contract: ns_id,
                    fn_name: "register_name",
                    args: (owner.clone(), talos_id, name.clone()).into_val(env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: registry_contract,
                        fn_name: "creator_of",
                        args: (talos_id,).into_val(env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .register_name(owner, &talos_id, name);
    }

    fn schedule_action(
        env: &Env,
        client: &TalosNameServiceClient,
        ns_id: &Address,
        admin: &Address,
        action: AdminAction,
        delay: u64,
    ) -> u64 {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: ns_id,
                    fn_name: "schedule_action",
                    args: (action.clone(), delay).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .schedule_action(&action, &delay)
    }

    fn cancel_action(
        env: &Env,
        client: &TalosNameServiceClient,
        ns_id: &Address,
        admin: &Address,
        proposal_id: u64,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: ns_id,
                    fn_name: "cancel_action",
                    args: (proposal_id,).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .cancel_action(&proposal_id);
    }

    fn expire_transfer(
        env: &Env,
        client: &TalosNameServiceClient,
        ns_id: &Address,
        admin: &Address,
        proposal_id: u64,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: ns_id,
                    fn_name: "expire_transfer",
                    args: (proposal_id,).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .expire_transfer(&proposal_id);
    }

    fn set_timelock_config(
        env: &Env,
        client: &TalosNameServiceClient,
        ns_id: &Address,
        admin: &Address,
        min_delay: u64,
        grace_period: u64,
    ) {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: ns_id,
                    fn_name: "set_timelock_config",
                    args: (min_delay, grace_period).into_val(env),
                    sub_invokes: &[],
                },
            }])
            .set_timelock_config(&min_delay, &grace_period);
    }

    /// Collect events emitted by `ns_id` whose first topic equals `sym`.
    fn events_for(env: &Env, ns_id: &Address, sym: Symbol) -> std::vec::Vec<(Address, soroban_sdk::Vec<soroban_sdk::Val>, soroban_sdk::Val)> {
        env.events()
            .all()
            .iter()
            .filter(|(a, t, _)| {
                if a != ns_id {
                    return false;
                }
                t.get(0)
                    .and_then(|v| TryFromVal::try_from_val(env, &v).ok())
                    .map(|s: Symbol| s == sym)
                    .unwrap_or(false)
            })
            .cloned()
            .collect()
    }

    // -- proposal + acceptance references, agent ids stay stable ----------

    #[test]
    fn schedule_and_execute_emits_proposal_and_acceptance_and_keeps_agent_ids_stable() {
        let (env, registry_id, ns_id, admin, registry_client, client) = setup();
        let owner = Address::generate(&env);
        let name = s(&env, "vega");

        let talos_id = create_talos(&env, &registry_client, &registry_id, &owner, &admin);
        register_name(&env, &client, &ns_id, &registry_id, &owner, talos_id, &name);

        // Snapshot agent identifiers before the ownership transfer.
        assert_eq!(client.name_of(&talos_id), Some(name.clone()));
        assert_eq!(registry_client.creator_of(&talos_id), Some(owner.clone()));

        let new_admin = Address::generate(&env);
        let action = AdminAction::SetAdmin(new_admin.clone());
        let proposal_id = schedule_action(&env, &client, &ns_id, &admin, action.clone(), 0);

        // Proposal reference emitted + logged.
        let proposed = events_for(&env, &ns_id, symbol_short!("nm_prp"));
        assert_eq!(proposed.len(), 1);
        let (_, topics, data) = proposed.get(0).unwrap();
        let pid: u64 = TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        assert_eq!(pid, proposal_id);
        let (kind, subject, actor, recorded_at): (Symbol, Address, Address, u64) =
            TryFromVal::try_from_val(&env, data).unwrap();
        assert_eq!(kind, Symbol::new(&env, "set_admin"));
        assert_eq!(subject, new_admin);
        assert_eq!(actor, admin);
        assert!(recorded_at > 0);

        // Execute immediately (delay 0, ETA is now).
        client.execute_action(&proposal_id);

        // Acceptance reference emitted + logged.
        let accepted = events_for(&env, &ns_id, symbol_short!("nm_acc"));
        assert_eq!(accepted.len(), 1);
        let (_, _, adata) = accepted.get(0).unwrap();
        let (akind, asubject, aactor, _): (Symbol, Address, Address, u64) =
            TryFromVal::try_from_val(&env, adata).unwrap();
        assert_eq!(akind, Symbol::new(&env, "set_admin"));
        assert_eq!(asubject, new_admin);
        assert_eq!(aactor, admin);

        // Bounded log grew to two records: proposed then accepted.
        assert_eq!(client.transfer_history_len(), 2);
        let r0 = client.transfer_record_at(&0u32).unwrap();
        let r1 = client.transfer_record_at(&1u32).unwrap();
        assert_eq!(r0.reference, Symbol::new(&env, "proposed"));
        assert_eq!(r1.reference, Symbol::new(&env, "accepted"));
        assert_eq!(r0.subject, new_admin);
        assert_eq!(r1.subject, new_admin);

        // Ownership transferred; historical agent identifiers stay stable.
        assert_eq!(client.admin(), Some(new_admin));
        assert_eq!(client.name_of(&talos_id), Some(name.clone()), "name must survive admin transfer");
        assert_eq!(
            registry_client.creator_of(&talos_id),
            Some(owner.clone()),
            "creator_of must survive admin transfer"
        );
    }

    // -- cancellation reference ------------------------------------------

    #[test]
    fn cancel_emits_cancellation_reference_and_logs_it() {
        let (env, _registry_id, ns_id, admin, _registry_client, client) = setup();
        let new_admin = Address::generate(&env);
        let action = AdminAction::SetAdmin(new_admin.clone());
        let proposal_id = schedule_action(&env, &client, &ns_id, &admin, action, 0);

        cancel_action(&env, &client, &ns_id, &admin, proposal_id);

        let cancelled = events_for(&env, &ns_id, symbol_short!("nm_cnl"));
        assert_eq!(cancelled.len(), 1);
        let (_, topics, data) = cancelled.get(0).unwrap();
        let pid: u64 = TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        assert_eq!(pid, proposal_id);
        let (kind, _, actor, _): (Symbol, Address, Address, u64) =
            TryFromVal::try_from_val(&env, data).unwrap();
        assert_eq!(kind, Symbol::new(&env, "set_admin"));
        assert_eq!(actor, admin);

        assert_eq!(client.transfer_history_len(), 2);
        let r1 = client.transfer_record_at(&1u32).unwrap();
        assert_eq!(r1.reference, Symbol::new(&env, "cancelled"));
        assert_eq!(r1.proposal_id, proposal_id);

        let proposal = client.get_timelock_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.status, ProposalStatus::Cancelled);
    }

    // -- expiry reference -------------------------------------------------

    #[test]
    fn expire_emits_expiry_reference_after_grace_and_blocks_reuse() {
        let (env, _registry_id, ns_id, admin, _registry_client, client) = setup();
        // Tight grace window so expiry is reachable from the test harness.
        set_timelock_config(&env, &client, &ns_id, &admin, 0, 100);

        let new_admin = Address::generate(&env);
        let action = AdminAction::SetAdmin(new_admin.clone());
        let proposal_id = schedule_action(&env, &client, &ns_id, &admin, action, 0);

        // Advance past eta + grace so the proposal is matured.
        env.ledger().with_mut(|li| {
            li.timestamp += 200;
        });

        expire_transfer(&env, &client, &ns_id, &admin, proposal_id);

        let expired = events_for(&env, &ns_id, symbol_short!("nm_exp"));
        assert_eq!(expired.len(), 1);
        let (_, topics, data) = expired.get(0).unwrap();
        let pid: u64 = TryFromVal::try_from_val(&env, &topics.get(1).unwrap()).unwrap();
        assert_eq!(pid, proposal_id);
        let (kind, subject, _, _): (Symbol, Address, Address, u64) =
            TryFromVal::try_from_val(&env, data).unwrap();
        assert_eq!(kind, Symbol::new(&env, "set_admin"));
        assert_eq!(subject, new_admin);

        assert_eq!(client.transfer_history_len(), 2);
        let r1 = client.transfer_record_at(&1u32).unwrap();
        assert_eq!(r1.reference, Symbol::new(&env, "expired"));

        let proposal = client.get_timelock_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.status, ProposalStatus::Expired);

        // Boundary: an expired proposal can no longer be executed or cancelled.
        assert!(
            client.try_execute_action(&proposal_id).is_err(),
            "expired proposal must not be executable"
        );
        assert!(
            client.try_cancel_action(&proposal_id).is_err(),
            "expired proposal must not be cancellable"
        );
        // Re-expiring is rejected (not active).
        assert!(
            client.try_expire_transfer(&proposal_id).is_err(),
            "already-expired proposal must not be re-expirable"
        );
    }

    // -- failure: expiring before the grace window is rejected ------------

    #[test]
    fn expire_rejects_proposal_that_has_not_matured() {
        let (env, _registry_id, ns_id, admin, _registry_client, client) = setup();
        set_timelock_config(&env, &client, &ns_id, &admin, 0, 100);

        let new_admin = Address::generate(&env);
        let action = AdminAction::SetAdmin(new_admin);
        let proposal_id = schedule_action(&env, &client, &ns_id, &admin, action, 0);

        // No time advance: the proposal is still within its grace window.
        assert!(
            client.try_expire_transfer(&proposal_id).is_err(),
            "expiring a not-yet-matured proposal must be rejected"
        );
        assert_eq!(client.transfer_history_len(), 1, "failed expire must not log");
    }

    // -- bounded log evicts oldest (FIFO) --------------------------------

    #[test]
    fn bounded_history_evicts_oldest_fifo() {
        let (env, _registry_id, ns_id, admin, _registry_client, client) = setup();

        // Each schedule+cancel cycle appends two records (proposed, cancelled).
        // After enough cycles the log saturates at MAX_TRANSFER_HISTORY.
        let cycles = (MAX_TRANSFER_HISTORY / 2) + 2;
        let mut last_id = 0u64;
        for _ in 0..cycles {
            let new_admin = Address::generate(&env);
            let id = schedule_action(
                &env,
                &client,
                &ns_id,
                &admin,
                AdminAction::SetAdmin(new_admin),
                0,
            );
            cancel_action(&env, &client, &ns_id, &admin, id);
            last_id = id;
        }

        // The log is bounded — it never grows beyond the cap.
        assert!(
            client.transfer_history_len() == MAX_TRANSFER_HISTORY,
            "history must be capped at MAX_TRANSFER_HISTORY, got {}",
            client.transfer_history_len()
        );

        // The oldest records were evicted: the first proposal is no longer present.
        let oldest = client.transfer_record_at(&0u32).unwrap();
        assert!(
            oldest.proposal_id > 1,
            "first proposal must have been evicted, got {}",
            oldest.proposal_id
        );

        // The newest record is the last cancellation.
        let newest = client
            .transfer_record_at(&(MAX_TRANSFER_HISTORY - 1))
            .unwrap();
        assert_eq!(newest.proposal_id, last_id);
        assert_eq!(newest.reference, Symbol::new(&env, "cancelled"));
    }
}
