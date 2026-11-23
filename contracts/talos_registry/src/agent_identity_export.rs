//! Agent identity export fixtures for offline ownership verification.
//!
//! Parses deterministic positive and malformed synthetic JSON vectors under
//! `contracts/fixtures/agent_identity/` and validates them with a
//! reference verifier. Also exercises the on-chain
//! `TalosRegistry::export_agent_identity` entry-point against a freshly
//! registered Talos to prove the export binds registry id, name, owner and
//! network metadata. No live network — `Env::default()` and `serde_json` only.

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::super::{Kernel, Patron, Pulse};
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Env, IntoVal, String as SorobanString,
    };
    use std::string::ToString;

    // -- Fixture types (serde mirrors of the JSON documents) ------------

    #[derive(serde::Deserialize, Debug)]
    struct AgentIdentityFixture {
        kind: std::string::String,
        registry_id: std::string::String,
        talos_id: u32,
        name: std::string::String,
        owner: Option<std::string::String>,
        network: std::string::String,
        exported_at: u64,
    }

    // -- Raw fixture bytes (include_str!) --------------------------------

    const POS_001: &str =
        include_str!("../../fixtures/agent_identity/positive/agent_identity_001.json");
    const POS_002: &str =
        include_str!("../../fixtures/agent_identity/positive/agent_identity_002_null_owner.json");

    const MAL_MISSING: &str =
        include_str!("../../fixtures/agent_identity/malformed/missing_registry_id.json");
    const MAL_TYPE: &str =
        include_str!("../../fixtures/agent_identity/malformed/wrong_type_talos_id.json");
    const MAL_ADDR: &str =
        include_str!("../../fixtures/agent_identity/malformed/invalid_registry_address.json");
    const MAL_NAME: &str =
        include_str!("../../fixtures/agent_identity/malformed/empty_name.json");
    const MAL_OWNER: &str =
        include_str!("../../fixtures/agent_identity/malformed/invalid_owner_address.json");

    // -- Reference verifier (offline ownership verification) ------------

    fn is_strkey(s: &str) -> bool {
        s.len() == 56 && (s.starts_with('G') || s.starts_with('C'))
    }

    fn is_account(s: &str) -> bool {
        s.len() == 56 && s.starts_with('G')
    }

    /// Offline verification of a parsed `AgentIdentity` vector.
    ///
    /// Returns an actionable error (file name + `regen:` hint) so a
    /// non-Rust operator can regenerate the fixture.
    fn verify_agent_identity(
        rec: &AgentIdentityFixture,
        file: &str,
    ) -> Result<(), std::string::String> {
        if !is_strkey(&rec.registry_id) {
            return Err(std::format!(
                "{}: registry_id is not a valid 56-char G…/C… StrKey: regen: pnpm fixtures:gen",
                file
            ));
        }
        if rec.name.is_empty() {
            return Err(std::format!(
                "{}: name must be non-empty: regen: pnpm fixtures:gen",
                file
            ));
        }
        if rec.network.is_empty() {
            return Err(std::format!(
                "{}: network must be non-empty: regen: pnpm fixtures:gen",
                file
            ));
        }
        if let Some(owner) = &rec.owner {
            if !is_account(owner) {
                return Err(std::format!(
                    "{}: owner must be a valid 56-char G… account StrKey: regen: pnpm fixtures:gen",
                    file
                ));
            }
        }
        Ok(())
    }

    /// Parse + verify a vector; returns the parsed record only when both pass.
    fn load(raw: &str, file: &str) -> Result<AgentIdentityFixture, std::string::String> {
        let rec: AgentIdentityFixture = serde_json::from_str(raw)
            .map_err(|e| std::format!("{}: parse error: {}: regen: pnpm fixtures:gen", file, e))?;
        verify_agent_identity(&rec, file)?;
        Ok(rec)
    }

    // -- Positive vectors -------------------------------------------------

    #[test]
    fn positive_vectors_parse_and_verify() {
        let r1 = load(POS_001, "agent_identity_001.json").expect("positive 001 must verify");
        assert_eq!(r1.kind, "AgentIdentity");
        assert_eq!(r1.talos_id, 1);
        assert_eq!(r1.name, "vega");
        assert_eq!(r1.network, "testnet");
        assert!(r1.owner.is_some(), "001 has a populated owner");

        let r2 = load(POS_002, "agent_identity_002_null_owner.json").expect("positive 002 must verify");
        assert_eq!(r2.talos_id, 7);
        assert_eq!(r2.name, "atlas");
        assert_eq!(r2.network, "public");
        assert!(r2.owner.is_none(), "002 binds a null owner (unregistered)");
    }

    // -- Malformed vectors are rejected ----------------------------------

    #[test]
    fn malformed_missing_registry_id_is_rejected() {
        let err = load(MAL_MISSING, "missing_registry_id.json").unwrap_err();
        assert!(err.contains("missing_registry_id.json"));
        assert!(err.contains("regen:"));
    }

    #[test]
    fn malformed_wrong_type_talos_id_is_rejected() {
        let err = load(MAL_TYPE, "wrong_type_talos_id.json").unwrap_err();
        assert!(err.contains("wrong_type_talos_id.json"));
        assert!(err.contains("regen:"));
    }

    #[test]
    fn malformed_invalid_registry_address_is_rejected() {
        let err = load(MAL_ADDR, "invalid_registry_address.json").unwrap_err();
        assert!(err.contains("invalid_registry_address.json"));
        assert!(err.contains("StrKey") || err.contains("registry_id"));
        assert!(err.contains("regen:"));
    }

    #[test]
    fn malformed_empty_name_is_rejected() {
        let err = load(MAL_NAME, "empty_name.json").unwrap_err();
        assert!(err.contains("empty_name.json"));
        assert!(err.contains("name"));
        assert!(err.contains("regen:"));
    }

    #[test]
    fn malformed_invalid_owner_address_is_rejected() {
        let err = load(MAL_OWNER, "invalid_owner_address.json").unwrap_err();
        assert!(err.contains("invalid_owner_address.json"));
        assert!(err.contains("owner"));
        assert!(err.contains("regen:"));
    }

    #[test]
    fn all_malformed_vectors_fail() {
        for (file, raw) in [
            ("missing_registry_id.json", MAL_MISSING),
            ("wrong_type_talos_id.json", MAL_TYPE),
            ("invalid_registry_address.json", MAL_ADDR),
            ("empty_name.json", MAL_NAME),
            ("invalid_owner_address.json", MAL_OWNER),
        ] {
            let res = load(raw, file);
            assert!(res.is_err(), "malformed {} should be rejected but got {:?}", file, res);
            let msg = res.unwrap_err();
            assert!(msg.contains(file) && msg.contains("regen:"), "not actionable for {}: {}", file, msg);
        }
    }

    // -- On-chain export binds registry id, name, owner, network ----------

    fn s(env: &Env, v: &str) -> SorobanString {
        SorobanString::from_str(env, v)
    }

    fn patron(env: &Env, creator: &soroban_sdk::Address) -> Patron {
        Patron {
            creator_share: 60,
            investor_share: 25,
            treasury_share: 15,
            creator_addr: creator.clone(),
            investor_addr: soroban_sdk::Address::generate(env),
            treasury_addr: soroban_sdk::Address::generate(env),
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

    fn create_talos(
        env: &Env,
        client: &crate::TalosRegistryClient,
        contract_id: &soroban_sdk::Address,
        creator: &soroban_sdk::Address,
        wallet: &soroban_sdk::Address,
        name: &str,
    ) -> u32 {
        let name_s = s(env, name);
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
                        name_s.clone(),
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
            .create_talos(&name_s, &category, &description, &patron, &kernel, &pulse, wallet)
    }

    #[test]
    fn export_agent_identity_binds_on_chain_state() {
        let env = Env::default();
        let contract_id = env.register_contract(None, crate::TalosRegistry);
        let client = crate::TalosRegistryClient::new(&env, &contract_id);

        let admin = soroban_sdk::Address::generate(&env);
        client.initialize(&admin);

        let creator = soroban_sdk::Address::generate(&env);
        let talos_id = create_talos(&env, &client, &contract_id, &creator, &admin, "vega");

        let name = s(&env, "vega");
        let network = s(&env, "testnet");
        let identity = client.export_agent_identity(&talos_id, &name, &network);

        // registry_id binds the exporting contract.
        assert_eq!(identity.registry_id, contract_id);
        // agent identifier is stable.
        assert_eq!(identity.talos_id, talos_id);
        // name + network are bound verbatim.
        assert_eq!(identity.name, name);
        assert_eq!(identity.network, network);
        // owner binds the Talos creator (offline ownership verification).
        assert_eq!(identity.owner, Some(creator));
    }

    #[test]
    fn export_agent_identity_binds_null_owner_for_unregistered_talos() {
        let env = Env::default();
        let contract_id = env.register_contract(None, crate::TalosRegistry);
        let client = crate::TalosRegistryClient::new(&env, &contract_id);
        client.initialize(&soroban_sdk::Address::generate(&env));

        let name = s(&env, "ghost");
        let network = s(&env, "testnet");
        // talos_id 999 was never created, so creator_of is None.
        let identity = client.export_agent_identity(&999u32, &name, &network);

        assert_eq!(identity.talos_id, 999);
        assert_eq!(identity.name, name);
        assert_eq!(identity.owner, None);
        assert_eq!(identity.network, network);
    }
}
