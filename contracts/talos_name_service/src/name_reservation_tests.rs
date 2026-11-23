//! Focused tests for the bounded name reservation expiry query.
//!
//! Asserts `name_reservation` exposes the reservation owner and ledger
//! expiry without mutation, and distinguishes expired, active and
//! nonexistent reservations. Synthetic data via `Env::default()` — no network.

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal,
    };
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

    fn setup_with_ledger(sequence: u32) -> (
        Env,
        Address,
        Address,
        Address,
        TalosRegistryClient<'static>,
        TalosNameServiceClient<'static>,
    ) {
        let env = Env::default();
        env.ledger().with_mut(|li| li.sequence_number = sequence);
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

    fn register_vega(
        env: &Env,
        registry_id: &Address,
        ns_id: &Address,
        registry_client: &TalosRegistryClient,
        ns_client: &TalosNameServiceClient,
        admin: &Address,
    ) -> (Address, u32, String) {
        let owner = Address::generate(env);
        let talos_id = create_talos(env, registry_client, registry_id, &owner, admin);
        let name = s(env, "vega");
        register_name(env, ns_client, ns_id, registry_id, &owner, talos_id, &name);
        (owner, talos_id, name)
    }

    // -- nonexistent ------------------------------------------------------

    #[test]
    fn query_returns_none_for_nonexistent_name() {
        let (env, _reg, _ns, _admin, _rc, client) = setup_with_ledger(0);
        let unregistered = s(&env, "never-registered");
        assert_eq!(client.name_reservation(&unregistered), None);
    }

    #[test]
    fn query_returns_none_for_invalid_name() {
        let (env, _reg, _ns, _admin, _rc, client) = setup_with_ledger(0);
        // An invalid name was never stored, so it is nonexistent (not expired).
        assert_eq!(client.name_reservation(&s(&env, "ab")), None);
    }

    // -- active -----------------------------------------------------------

    #[test]
    fn query_returns_active_with_owner_and_expiry_for_registered_name() {
        let (env, registry_id, ns_id, admin, registry_client, client) = setup_with_ledger(0);
        let (owner, talos_id, name) =
            register_vega(&env, &registry_id, &ns_id, &registry_client, &client, &admin);

        let reservation = client.name_reservation(&name).expect("registered name must resolve");
        assert_eq!(reservation.name, name);
        assert_eq!(reservation.talos_id, talos_id);
        assert_eq!(reservation.owner, Some(owner), "owner must mirror the Talos creator");
        assert_eq!(reservation.status, Symbol::new(&env, "active"));
        // register_name does not set LastTouched (it defaults to 0), so the
        // expiry ledger is exactly the reservation window.
        assert_eq!(reservation.expiry_ledger, NAME_RESERVATION_LEDGERS);
    }

    // -- expired ----------------------------------------------------------

    #[test]
    fn query_returns_expired_when_ledger_advanced_past_expiry() {
        // Register the name at a ledger already past the reservation window.
        // The underlying record is freshly created at this ledger (so it is
        // still live), but LastTouched defaults to 0, so expiry_ledger =
        // NAME_RESERVATION_LEDGERS, which the current ledger has passed.
        let (env, registry_id, ns_id, admin, registry_client, client) =
            setup_with_ledger(NAME_RESERVATION_LEDGERS + 1);
        let (owner, talos_id, name) =
            register_vega(&env, &registry_id, &ns_id, &registry_client, &client, &admin);

        let reservation = client.name_reservation(&name).expect("record still present");
        assert_eq!(reservation.talos_id, talos_id);
        assert_eq!(reservation.owner, Some(owner));
        assert_eq!(reservation.expiry_ledger, NAME_RESERVATION_LEDGERS);
        assert_eq!(
            reservation.status,
            Symbol::new(&env, "expired"),
            "ledger past the reservation window must read as expired"
        );

        // The record itself is still present (the entry is live), so the name
        // is not yet gone — it is lapsed, not nonexistent.
        assert_eq!(client.resolve_name(&name), Some(talos_id));
    }

    // -- read-only: the query never mutates storage -----------------------

    #[test]
    fn query_is_read_only_and_does_not_touch_storage() {
        let (env, registry_id, ns_id, admin, registry_client, client) = setup_with_ledger(0);
        let (_owner, talos_id, name) =
            register_vega(&env, &registry_id, &ns_id, &registry_client, &client, &admin);

        // register_name does not write LastTouched; the query must not either.
        let last_touched_before: Option<u32> =
            env.as_contract(&ns_id, || {
                env.storage().persistent().get(&DataKey::LastTouched(talos_id))
            });
        assert!(last_touched_before.is_none(), "register must not set LastTouched");

        let r1 = client.name_reservation(&name).expect("registered");
        let last_touched_after: Option<u32> =
            env.as_contract(&ns_id, || {
                env.storage().persistent().get(&DataKey::LastTouched(talos_id))
            });
        assert!(last_touched_after.is_none(), "query must not create LastTouched");

        // Deterministic + non-destructive: a second query is identical and the
        // registration is untouched.
        let r2 = client.name_reservation(&name).expect("registered");
        assert_eq!(r1, r2);
        assert_eq!(client.resolve_name(&name), Some(talos_id));
        assert_eq!(client.name_of(&talos_id), Some(name));
    }
}
