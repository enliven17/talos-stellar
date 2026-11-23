//! Migration compatibility manifest for TalosRegistry storage keys.
//!
//! Parses the synthetic JSON fixtures under
//! `contracts/fixtures/registry_schema/migration_manifest/` (the published
//! old → new schema-key mapping) and validates that a simulated v1 → v2
//! upgrade preserves ownership (`CreatorOf`) and name uniqueness (`Talos.name`).
//! No live network — uses `Env::default()` and `serde_json` fixtures only.

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::super::{
        Kernel, Patron, Pulse, SCHEMA_GENESIS, SCHEMA_TIMELOCK_DEFAULTS, DEFAULT_GRACE_PERIOD,
    };
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Env, IntoVal, String as SorobanString, Symbol,
    };
    use std::string::ToString;

    // -- Fixture types (serde mirrors of the JSON documents) ------------

    #[derive(serde::Deserialize, Debug)]
    struct KeyMapping {
        key: std::string::String,
        v1: std::string::String,
        v2: std::string::String,
        changed: bool,
    }

    #[derive(serde::Deserialize, Debug)]
    struct Manifest {
        spec_version: u32,
        from_version: u32,
        to_version: u32,
        key_mappings: std::vec::Vec<KeyMapping>,
    }

    #[derive(serde::Deserialize, Debug)]
    struct KeyEntry {
        key: std::string::String,
        present: bool,
        value_kind: std::string::String,
    }

    #[derive(serde::Deserialize, Debug)]
    struct KeySet {
        schema_version: u32,
        keys: std::vec::Vec<KeyEntry>,
    }

    // -- Raw fixture bytes (include_str!) --------------------------------

    const MANIFEST: &str = include_str!(
        "../../fixtures/registry_schema/migration_manifest/manifest.json"
    );
    const V1_KEYS: &str = include_str!(
        "../../fixtures/registry_schema/migration_manifest/v1_storage_keys.json"
    );
    const V2_KEYS: &str = include_str!(
        "../../fixtures/registry_schema/migration_manifest/v2_storage_keys.json"
    );

    fn parse_manifest() -> Manifest {
        serde_json::from_str(MANIFEST).expect("manifest.json must parse")
    }

    fn parse_key_set(raw: &str, file: &str) -> KeySet {
        serde_json::from_str(raw).unwrap_or_else(|e| panic!("{}: {}", file, e))
    }

    fn entry(set: &KeySet, key: &str) -> &KeyEntry {
        set.keys
            .iter()
            .find(|k| k.key == key)
            .unwrap_or_else(|| panic!("missing key {} in key set", key))
    }

    // -- Manifest coverage ------------------------------------------------

    #[test]
    fn manifest_parses_and_marks_only_timelock_config_changed() {
        let m = parse_manifest();
        assert_eq!(m.spec_version, 1);
        assert_eq!(m.from_version, SCHEMA_GENESIS);
        assert_eq!(m.to_version, SCHEMA_TIMELOCK_DEFAULTS);

        let changed: std::vec::Vec<&KeyMapping> =
            m.key_mappings.iter().filter(|k| k.changed).collect();
        assert_eq!(changed.len(), 1, "exactly one key changes across v1->v2");
        assert_eq!(changed[0].key, "TimelockConfig");
        assert_eq!(changed[0].v1, "implicit_default");
        assert_eq!(changed[0].v2, "explicit_persisted");

        // Every unchanged key must have an identical v1 and v2 representation,
        // so a reader at v1 can keep reading the same bytes at v2.
        for k in &m.key_mappings {
            if !k.changed {
                assert_eq!(
                    k.v1, k.v2,
                    "unchanged key {} must keep the same representation",
                    k.key
                );
            }
        }
    }

    #[test]
    fn v1_and_v2_key_sets_agree_with_manifest() {
        let m = parse_manifest();
        let v1 = parse_key_set(V1_KEYS, "v1_storage_keys.json");
        let v2 = parse_key_set(V2_KEYS, "v2_storage_keys.json");

        assert_eq!(v1.schema_version, SCHEMA_GENESIS);
        assert_eq!(v2.schema_version, SCHEMA_TIMELOCK_DEFAULTS);

        for k in &m.key_mappings {
            let e1 = entry(&v1, &k.key);
            let e2 = entry(&v2, &k.key);
            assert_eq!(e1.value_kind, k.v1, "v1 value_kind mismatch for {}", k.key);
            assert_eq!(e2.value_kind, k.v2, "v2 value_kind mismatch for {}", k.key);
            if k.changed {
                // The only changed key becomes present in v2.
                assert!(!e1.present, "{} should be absent in v1", k.key);
                assert!(e2.present, "{} should be present in v2", k.key);
            } else {
                assert_eq!(
                    e1.present, e2.present,
                    "unchanged key {} presence must match across versions",
                    k.key
                );
            }
        }
    }

    // -- Simulated upgrade preserves ownership and name uniqueness --------

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

    fn run_migrations_with_auth(
        env: &Env,
        client: &crate::TalosRegistryClient,
        contract_id: &soroban_sdk::Address,
        admin: &soroban_sdk::Address,
    ) -> u32 {
        client
            .mock_auths(&[MockAuth {
                address: admin,
                invoke: &MockAuthInvoke {
                    contract: contract_id,
                    fn_name: "run_migrations",
                    args: ().into_val(env),
                    sub_invokes: &[],
                },
            }])
            .run_migrations()
    }

    #[test]
    fn simulated_upgrade_preserves_ownership_and_name_uniqueness() {
        let env = Env::default();
        let contract_id = env.register_contract(None, crate::TalosRegistry);
        let client = crate::TalosRegistryClient::new(&env, &contract_id);

        let admin = soroban_sdk::Address::generate(&env);
        client.initialize(&admin);

        // The protocol wallet is the admin; create_talos must be called with
        // the same wallet so the configured-wallet check passes.
        let creator_a = soroban_sdk::Address::generate(&env);
        let creator_b = soroban_sdk::Address::generate(&env);

        let id_a = create_talos(&env, &client, &contract_id, &creator_a, &admin, "vega");
        let id_b = create_talos(&env, &client, &contract_id, &creator_b, &admin, "atlas");
        assert_ne!(id_a, id_b, "talos ids must be distinct");

        // Snapshot ownership + names before the upgrade.
        assert_eq!(client.creator_of(&id_a), Some(creator_a.clone()));
        assert_eq!(client.creator_of(&id_b), Some(creator_b.clone()));
        let name_a_before = client.get_talos(&id_a).expect("talos a exists").name;
        let name_b_before = client.get_talos(&id_b).expect("talos b exists").name;
        assert_ne!(name_a_before, name_b_before, "names must be unique");

        // Simulate the v1 -> v2 storage upgrade.
        assert_eq!(client.schema_version(), SCHEMA_GENESIS);
        let result = run_migrations_with_auth(&env, &client, &contract_id, &admin);
        assert_eq!(result, SCHEMA_TIMELOCK_DEFAULTS);
        assert_eq!(client.schema_version(), SCHEMA_TIMELOCK_DEFAULTS);

        // Ownership is preserved by the upgrade (CreatorOf is unchanged).
        assert_eq!(client.creator_of(&id_a), Some(creator_a.clone()));
        assert_eq!(client.creator_of(&id_b), Some(creator_b.clone()));

        // Name uniqueness is preserved (Talos.name is unchanged for both).
        let name_a_after = client.get_talos(&id_a).unwrap().name;
        let name_b_after = client.get_talos(&id_b).unwrap().name;
        assert_eq!(name_a_before, name_a_after);
        assert_eq!(name_b_before, name_b_after);
        assert_ne!(name_a_after, name_b_after, "names must remain unique");

        // The migration backfilled an explicit TimelockConfig default.
        let cfg = client.get_timelock_config();
        assert_eq!(cfg.min_delay, 0);
        assert_eq!(cfg.grace_period, DEFAULT_GRACE_PERIOD);
    }

    #[test]
    fn migration_key_manifest_version_is_published() {
        // The contract publishes the manifest version as a stable on-chain
        // marker so off-chain tooling can detect which key mapping applies.
        let env = Env::default();
        let contract_id = env.register_contract(None, crate::TalosRegistry);
        let client = crate::TalosRegistryClient::new(&env, &contract_id);
        client.initialize(&soroban_sdk::Address::generate(&env));

        assert_eq!(client.migration_key_manifest_version(), 1);

        let _ = Symbol::new(&env, "manifest");
    }
}
