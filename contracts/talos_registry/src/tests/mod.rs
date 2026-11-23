//! TalosRegistry inline tests, extracted from lib.rs.
//!
//! All test helpers and test functions are collected here; logical groupings
//! are preserved via // ── ... ── section comments.

use crate::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal, Symbol, TryFromVal,
};
use std::string::ToString;

fn setup() -> (Env, Address) {
    let env = Env::default();
    let contract_id = env.register_contract(None, TalosRegistry);
    (env, contract_id)
}

#[test]
fn event_schema_version_returns_expected_value() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);

    let version = client.event_schema_version();

    assert_eq!(version.major, 1);
    assert_eq!(version.minor, 0);
}

#[test]
fn event_schema_version_major_is_supported() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);

    assert_eq!(client.event_schema_version().major, SUPPORTED_MAJOR);
}

fn s(env: &Env, value: &str) -> String {
    String::from_str(env, value)
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

fn create_talos_with_auth(
    env: &Env,
    client: &TalosRegistryClient,
    contract_id: &Address,
    creator: &Address,
    protocol_wallet: &Address,
) -> u32 {
    let name = s(env, "Genesis");
    let category = s(env, "Marketing");
    let description = s(env, "Autonomous marketing agent");
    let patron = patron(env, creator);
    let kernel = kernel();
    let pulse = pulse(env);

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
                    protocol_wallet.clone(),
                )
                    .into_val(env),
                sub_invokes: &[],
            },
        }])
        .create_talos(
            &name,
            &category,
            &description,
            &patron,
            &kernel,
            &pulse,
            protocol_wallet,
        )
}

// ── version() tests ──────────────────────────────────────────────

#[test]
fn version_returns_compile_time_constant() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    assert_eq!(client.version(), (1u32, 3u32, 0u32));
}

#[test]
fn version_is_idempotent() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    // Calling version() multiple times must always return the same value.
    assert_eq!(client.version(), client.version());
}

#[test]
fn version_is_unaffected_by_state_changes() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let protocol_wallet = Address::generate(&env);

    let before = client.version();

    // Initialize the contract and change the fee — state writes must not
    // affect the version constant.
    client.initialize(&protocol_wallet);
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

    let after = client.version();
    assert_eq!(before, after);
}

#[test]
fn version_matches_contract_version_constant() {
    // Verify that the public CONTRACT_VERSION constant and the on-chain
    // entry-point are in sync, so tooling that reads the constant directly
    // agrees with what the deployed WASM reports.
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let (maj, min, patch) = client.version();
    assert_eq!((maj, min, patch), CONTRACT_VERSION);
}

// ── interface_id() tests ────────────────────────────────────────

#[test]
fn interface_id_returns_expected_bytes() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let id = client.interface_id();
    // Compare against the compile-time constant byte-for-byte;
    // BytesN<32> implements PartialEq + Debug so we can compare inline.
    let expected = soroban_sdk::BytesN::<32>::from_array(&env, &INTERFACE_ID);
    assert_eq!(id, expected);

    // Spot-check the namespace prefix and version slots are recoverable
    // from the returned BytesN so test vectors remain human-auditable.
    let arr = id.to_array();
    assert_eq!(&arr[..8], b"TalosReg");
    assert_eq!(&arr[8..13], b"istry");
    assert_eq!(arr[13], 0u8);
    // Major/minor/patch slots at offsets 16/20/24
    assert_eq!(&arr[16..20], &CONTRACT_VERSION.0.to_be_bytes());
    assert_eq!(&arr[20..24], &CONTRACT_VERSION.1.to_be_bytes());
    assert_eq!(&arr[24..28], &CONTRACT_VERSION.2.to_be_bytes());
    // Reserved tail is zero-padded.
    assert_eq!(&arr[28..32], &[0u8; 4]);
}

#[test]
fn interface_id_is_unaffected_by_state_changes() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let before = client.interface_id();

    // Initialize the contract and change the fee — state writes must not
    // affect the interface ID constant.
    let protocol_wallet = Address::generate(&env);
    client.initialize(&protocol_wallet);
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

    let after = client.interface_id();
    assert_eq!(before, after);
}

// ── Golden vector: namespace + version → expected INTERFACE_ID ───

/// Independently reproduces `INTERFACE_ID` from the documented
/// derivation rule. If this test ever fails, either the namespace,
/// the version, or the byte layout changed without bumping `major`
/// — a manually-updateable alarm bell that reviewers should not
/// accept silently.
#[test]
fn interface_id_golden_vector_matches_derivation() {
    let (env, _) = setup();
    let expected = soroban_sdk::BytesN::<32>::from_array(&env, &INTERFACE_ID);

    // Reconstruct from scratch using the documented algorithm.
    let namespace = INTERFACE_NAMESPACE.as_bytes();
    let (maj, min, patch) = CONTRACT_VERSION;
    let mut derived = [0u8; 32];
    let n = namespace.len().min(16);
    derived[..n].copy_from_slice(&namespace[..n]);
    derived[16..20].copy_from_slice(&maj.to_be_bytes());
    derived[20..24].copy_from_slice(&min.to_be_bytes());
    derived[24..28].copy_from_slice(&patch.to_be_bytes());
    // derived[28..32] remains zero padding — matches the constant.
    let derived_bytesn = soroban_sdk::BytesN::<32>::from_array(&env, &derived);

    assert_eq!(expected, derived_bytesn);
}

// ── supports_version() tests ─────────────────────────────────────

#[test]
fn supports_version_accepts_exact_match() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let (maj, min, pat) = CONTRACT_VERSION;
    assert!(client.supports_version(&maj, &min, &pat));
}

#[test]
fn supports_version_accepts_lower_minor_and_patch() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let (maj, _min, _pat) = CONTRACT_VERSION;
    // Floor at (major, 0, 0) — deploy has at least all 1.0.x features.
    assert!(client.supports_version(&maj, &0u32, &0u32));
}

#[test]
fn supports_version_rejects_higher_minor() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let (maj, min, _pat) = CONTRACT_VERSION;
    // Caller requires a feature added in a future minor.
    assert!(!client.supports_version(&maj, &(min + 1), &0u32));
}

#[test]
fn supports_version_rejects_higher_patch_when_minor_matches() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let (maj, min, pat) = CONTRACT_VERSION;
    // Caller requires a bug-fix-only patch newer than deployed.
    assert!(!client.supports_version(&maj, &min, &(pat + 1)));
}

#[test]
fn supports_version_rejects_different_major() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let (_maj, min, pat) = CONTRACT_VERSION;
    assert!(!client.supports_version(&99u32, &min, &pat));
    assert!(!client.supports_version(&0u32, &min, &pat));
}

// ── interface_features() tests ──────────────────────────────────

#[test]
fn interface_features_lists_known_capabilities() {
    let (_env, contract_id) = setup();
    let client = TalosRegistryClient::new(&_env, &contract_id);
    let features = client.interface_features();

    let expected: std::vec::Vec<std::string::String> = features_list()
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    assert_eq!(features.len(), expected.len() as u32);
    for (i, want) in expected.iter().enumerate() {
        let sym = features.get(i as u32).unwrap();
        assert_eq!(sym.to_string(), *want, "feature[{}] mismatch", i);
    }
}

#[test]
fn interface_features_is_stable_across_calls() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let a = client.interface_features();
    let b = client.interface_features();
    assert_eq!(a.len(), b.len());
    for i in 0..a.len() {
        assert_eq!(a.get(i).unwrap(), b.get(i).unwrap());
    }
}

#[test]
fn deprecated_entry_count_matches_table() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    assert_eq!(
        client.deprecated_entry_count(),
        DEPRECATED_DIRECT_ADMIN.len() as u32
    );
}

// ── deprecation event tests ──────────────────────────────────────

#[test]
fn set_protocol_fee_emits_dep_path_event_when_timelocked() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let protocol_wallet = Address::generate(&env);
    client.initialize(&protocol_wallet);

    // Enable timelock so set_protocol_fee becomes a deprecated path.
    client
        .mock_auths(&[MockAuth {
            address: &protocol_wallet,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (3600u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&3600, &86400);

    // Attempt the legacy path — must panic after emitting the event.
    let res = client
        .mock_auths(&[MockAuth {
            address: &protocol_wallet,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_protocol_fee",
                args: (500u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_protocol_fee(&500);
    assert!(res.is_err());

    // Find dep_path events; the data must include the recommended
    // replacement so telemetry is self-describing.
    let events = env.events().all();
    let dep_events: std::vec::Vec<_> = events
        .iter()
        .filter(|(a, t, _)| {
            if *a != contract_id {
                return false;
            }
            let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &t.get(0).unwrap());
            sym.map(|s| s == symbol_short!("dep_path")).unwrap_or(false)
        })
        .collect();
    assert_eq!(dep_events.len(), 1);
    let (_, _, data) = dep_events[0].clone();
    let (deprecated, replacement): (String, String) =
        TryFromVal::try_from_val(&env, &data).unwrap();
    assert!(deprecated.to_string().contains("set_protocol_fee"));
    assert!(
        replacement.to_string().contains("schedule_action"),
        "replacement should mention schedule_action, got: {}",
        replacement.to_string()
    );
}

#[test]
fn propose_admin_emits_dep_path_event_when_timelocked() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    client.initialize(&admin);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (3600u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&3600, &86400);

    // Attempt the legacy propose_admin path — must panic after event.
    assert!(client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "propose_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_propose_admin(&new_admin)
        .is_err());

    let dep_events: std::vec::Vec<_> = env
        .events()
        .all()
        .iter()
        .filter(|(a, t, _)| {
            if *a != contract_id {
                return false;
            }
            let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &t.get(0).unwrap());
            sym.map(|s| s == symbol_short!("dep_path")).unwrap_or(false)
        })
        .collect();
    assert_eq!(dep_events.len(), 1);
}

#[test]
fn create_talos_happy_path() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);

    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    assert_eq!(id, 1);
    assert_eq!(client.next_talos_id(), 2);
    assert_eq!(client.creator_of(&id), Some(creator.clone()));
    assert!(client.is_active(&id));

    let talos = client.get_talos(&id).expect("talos should be stored");
    assert_eq!(talos.id, id);
    assert_eq!(talos.name, s(&env, "Genesis"));
    assert_eq!(talos.category, s(&env, "Marketing"));
    assert_eq!(talos.creator, creator);
    assert!(talos.active);
}

#[test]
fn initialize_guard_rejects_reinitialization() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);

    client.initialize(&Address::generate(&env));

    assert!(client.try_initialize(&Address::generate(&env)).is_err());
}

#[test]
fn update_patron_requires_creator_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    let new_patron = Patron {
        creator_share: 50,
        investor_share: 30,
        treasury_share: 20,
        creator_addr: creator,
        investor_addr: Address::generate(&env),
        treasury_addr: Address::generate(&env),
    };

    assert!(client.try_update_patron(&id, &new_patron).is_err());
}

#[test]
fn set_protocol_fee_requires_admin_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let protocol_wallet = Address::generate(&env);

    client.initialize(&protocol_wallet);

    assert!(client.try_set_protocol_fee(&500).is_err());
}

#[test]
fn protocol_fee_calculation_uses_configured_basis_points() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let protocol_wallet = Address::generate(&env);

    client.initialize(&protocol_wallet);
    assert_eq!(client.protocol_fee_bps(), Some(300));
    assert_eq!(client.calculate_protocol_fee(&10_000), 300);

    client
        .mock_auths(&[MockAuth {
            address: &protocol_wallet,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_protocol_fee",
                args: (250u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_protocol_fee(&250);

    assert_eq!(client.protocol_fee_bps(), Some(250));
    assert_eq!(client.calculate_protocol_fee(&40_000), 1_000);
}

fn assert_topic_symbol(
    env: &Env,
    topics: &soroban_sdk::Vec<soroban_sdk::Val>,
    idx: u32,
    expected: Symbol,
) {
    let val = topics.get(idx).expect("topic index out of range");
    let sym: Symbol = TryFromVal::try_from_val(env, &val).expect("topic is not a Symbol");
    assert_eq!(sym, expected);
}

fn assert_topic_address(
    env: &Env,
    topics: &soroban_sdk::Vec<soroban_sdk::Val>,
    idx: u32,
    expected: &Address,
) {
    let val = topics.get(idx).expect("topic index out of range");
    let addr: Address = TryFromVal::try_from_val(env, &val).expect("topic is not an Address");
    assert_eq!(addr, *expected);
}

fn assert_topic_u32(
    env: &Env,
    topics: &soroban_sdk::Vec<soroban_sdk::Val>,
    idx: u32,
    expected: u32,
) {
    let val = topics.get(idx).expect("topic index out of range");
    let n: u32 = TryFromVal::try_from_val(env, &val).expect("topic is not a u32");
    assert_eq!(n, expected);
}

#[test]
fn create_talos_emits_tls_crt_event() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);

    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    let events = env.events().all();
    assert_eq!(events.len(), 2);
    
    // Assert tls_crt
    let (addr1, topics1, data1) = events.get(0).unwrap();
    assert_eq!(addr1, contract_id);
    assert_eq!(topics1.len(), 2);
    assert_topic_symbol(&env, &topics1, 0, symbol_short!("tls_crt"));
    assert_topic_address(&env, &topics1, 1, &creator);

    let (got_id1, got_name1, got_cat1): (u32, String, String) =
        TryFromVal::try_from_val(&env, &data1).unwrap();
    assert_eq!(got_id1, id);
    assert_eq!(got_name1, s(&env, "Genesis"));
    assert_eq!(got_cat1, s(&env, "Marketing"));

    // Assert tls_crt2
    let (addr2, topics2, data2) = events.get(1).unwrap();
    assert_eq!(addr2, contract_id);
    assert_eq!(topics2.len(), 2);
    assert_topic_symbol(&env, &topics2, 0, symbol_short!("tls_crt2"));
    assert_topic_address(&env, &topics2, 1, &creator);

    let (got_version2, got_id2, got_name2, got_cat2): (u32, u32, String, String) =
        TryFromVal::try_from_val(&env, &data2).unwrap();
    assert_eq!(got_version2, 1);
    assert_eq!(got_id2, id);
    assert_eq!(got_name2, s(&env, "Genesis"));
    assert_eq!(got_cat2, s(&env, "Marketing"));
}

#[test]
fn update_patron_emits_pat_upd_event() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

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
                args: (id, new_patron.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .update_patron(&id, &new_patron);

    // tls_crt and tls_crt2 from create_talos + pat_upd from update_patron
    let events = env.events().all();
    assert_eq!(events.len(), 3);
    let (addr, topics, data) = events.get(2).unwrap();

    assert_eq!(addr, contract_id);
    assert_eq!(topics.len(), 2);
    assert_topic_symbol(&env, &topics, 0, symbol_short!("pat_upd"));
    assert_topic_u32(&env, &topics, 1, id);

    let (got_creator, got_cs, got_is): (Address, u32, u32) =
        TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(got_creator, creator);
    assert_eq!(got_cs, 50);
    assert_eq!(got_is, 30);
}

#[test]
fn set_protocol_fee_emits_fee_chg_event() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let protocol_wallet = Address::generate(&env);

    client.initialize(&protocol_wallet);

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

    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (addr, topics, data) = events.get(0).unwrap();

    assert_eq!(addr, contract_id);
    assert_eq!(topics.len(), 1);
    assert_topic_symbol(&env, &topics, 0, symbol_short!("fee_chg"));

    let (old_bps, new_bps): (u32, u32) = TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(old_bps, 300);
    assert_eq!(new_bps, 500);
}
#[test]
fn get_talos_returns_none_for_missing_id() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);

    // IDs are 1-indexed, 0 does not exist
    assert!(client.get_talos(&0).is_none());
}

#[test]
fn update_kernel_requires_creator_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    let new_kernel = Kernel {
        approval_threshold: 20,
        gtm_budget: 5_000,
        min_patron_pulse: 500,
    };

    // Non-creator must not be able to update kernel
    let imposter = Address::generate(&env);
    assert!(client.try_update_kernel(&id, &new_kernel).is_err());
}

#[test]
fn update_kernel_persists_changes() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    let new_kernel = Kernel {
        approval_threshold: 20,
        gtm_budget: 5_000,
        min_patron_pulse: 500,
    };

    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_kernel",
                args: (id, new_kernel.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .update_kernel(&id, &new_kernel);

    let updated = client.get_talos(&id).expect("talos should exist");
    assert_eq!(updated.kernel.approval_threshold, 20);
    assert_eq!(updated.kernel.gtm_budget, 5_000);
    assert_eq!(updated.kernel.min_patron_pulse, 500);
}

#[test]
fn deactivate_talos_requires_creator_auth_and_sets_inactive() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Initially active
    assert!(client.is_active(&id));

    // Non-creator can't deactivate
    let imposter = Address::generate(&env);
    assert!(client.try_deactivate_talos(&id, &imposter).is_err());

    // Creator can deactivate
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .deactivate_talos(&id, &creator);

    assert!(!client.is_active(&id));
}

#[test]
fn set_pause_controller_requires_creator_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let pause_controller = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Non-creator can't set pause controller
    let _imposter = Address::generate(&env);
    assert!(client.try_set_pause_controller(&id, &pause_controller).is_err());

    // Creator can set pause controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_pause_controller",
                args: (id, pause_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_pause_controller(&id, &pause_controller);

    assert_eq!(client.get_pause_controller(&id), Some(pause_controller));
}

#[test]
fn set_resume_controller_requires_creator_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let resume_controller = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Non-creator can't set resume controller
    let _imposter = Address::generate(&env);
    assert!(client.try_set_resume_controller(&id, &resume_controller).is_err());

    // Creator can set resume controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_resume_controller",
                args: (id, resume_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_resume_controller(&id, &resume_controller);

    assert_eq!(client.get_resume_controller(&id), Some(resume_controller));
}

#[test]
fn pause_controller_can_deactivate_talos() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let pause_controller = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Set pause controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_pause_controller",
                args: (id, pause_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_pause_controller(&id, &pause_controller);

    // Pause controller can deactivate
    client
        .mock_auths(&[MockAuth {
            address: &pause_controller,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, pause_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .deactivate_talos(&id, &pause_controller);

    assert!(!client.is_active(&id));
}

#[test]
fn resume_controller_can_activate_talos() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let resume_controller = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Deactivate first
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .deactivate_talos(&id, &creator);

    assert!(!client.is_active(&id));

    // Set resume controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_resume_controller",
                args: (id, resume_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_resume_controller(&id, &resume_controller);

    // Resume controller can activate
    client
        .mock_auths(&[MockAuth {
            address: &resume_controller,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "activate_talos",
                args: (id, resume_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .activate_talos(&id, &resume_controller);

    assert!(client.is_active(&id));
}

#[test]
fn unauthorized_pause_controller_cannot_deactivate() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let pause_controller = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Set pause controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_pause_controller",
                args: (id, pause_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_pause_controller(&id, &pause_controller);

    // Unauthorized address cannot deactivate
    assert!(client.try_deactivate_talos(&id, &unauthorized).is_err());
}

#[test]
fn unauthorized_resume_controller_cannot_activate() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let resume_controller = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Deactivate first
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .deactivate_talos(&id, &creator);

    // Set resume controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_resume_controller",
                args: (id, resume_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_resume_controller(&id, &resume_controller);

    // Unauthorized address cannot activate
    assert!(client.try_activate_talos(&id, &unauthorized).is_err());
}

#[test]
fn pause_controller_cannot_activate_talos() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let pause_controller = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Deactivate first
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .deactivate_talos(&id, &creator);

    // Set pause controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_pause_controller",
                args: (id, pause_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_pause_controller(&id, &pause_controller);

    // Pause controller cannot activate (only resume controller or creator)
    assert!(client.try_activate_talos(&id, &pause_controller).is_err());
}

#[test]
fn resume_controller_cannot_deactivate_talos() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let resume_controller = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Set resume controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_resume_controller",
                args: (id, resume_controller.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_resume_controller(&id, &resume_controller);

    // Resume controller cannot deactivate (only pause controller or creator)
    assert!(client.try_deactivate_talos(&id, &resume_controller).is_err());
}

#[test]
fn deactivate_talos_emits_pause_event() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .deactivate_talos(&id, &creator);

    let events = env.events().all();
    let pause_events: std::vec::Vec<_> = events
        .iter()
        .filter(|(a, _, _)| *a == contract_id)
        .collect();

    let pause_event = pause_events.iter().find(|(_, topics, _)| {
        if topics.len() >= 1 {
            let t0: Symbol = TryFromVal::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
            t0 == symbol_short!("tls_paus")
        } else {
            false
        }
    });

    assert!(pause_event.is_some(), "Expected tls_paus event to be emitted");
}

#[test]
fn activate_talos_emits_resume_event() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Deactivate first
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .deactivate_talos(&id, &creator);

    // Activate
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "activate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .activate_talos(&id, &creator);

    let events = env.events().all();
    let resume_events: std::vec::Vec<_> = events
        .iter()
        .filter(|(a, _, _)| *a == contract_id)
        .collect();

    let resume_event = resume_events.iter().find(|(_, topics, _)| {
        if topics.len() >= 1 {
            let t0: Symbol = TryFromVal::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
            t0 == symbol_short!("tls_resu")
        } else {
            false
        }
    });

    assert!(resume_event.is_some(), "Expected tls_resu event to be emitted");
}

#[test]
fn controllers_can_be_updated_by_creator() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let pause_controller1 = Address::generate(&env);
    let pause_controller2 = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Set first pause controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_pause_controller",
                args: (id, pause_controller1.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_pause_controller(&id, &pause_controller1);

    assert_eq!(client.get_pause_controller(&id), Some(pause_controller1.clone()));

    // Update to second pause controller
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_pause_controller",
                args: (id, pause_controller2.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_pause_controller(&id, &pause_controller2);

    assert_eq!(client.get_pause_controller(&id), Some(pause_controller2));
}

#[test]
fn creator_can_always_pause_and_resume() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Creator can deactivate
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .deactivate_talos(&id, &creator);

    assert!(!client.is_active(&id));

    // Creator can activate
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "activate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .activate_talos(&id, &creator);

    assert!(client.is_active(&id));
}

#[test]
fn create_talos_rejects_shares_not_summing_to_100() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);

    let bad_patron = Patron {
        creator_share: 60,
        investor_share: 25,
        treasury_share: 10, // sums to 95
        creator_addr: creator.clone(),
        investor_addr: Address::generate(&env),
        treasury_addr: Address::generate(&env),
    };

    let result = client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "create_talos",
                args: (
                    s(&env, "Bad"),
                    s(&env, "Marketing"),
                    s(&env, "desc"),
                    bad_patron.clone(),
                    kernel(),
                    pulse(&env),
                    protocol_wallet.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_create_talos(
            &s(&env, "Bad"),
            &s(&env, "Marketing"),
            &s(&env, "desc"),
            &bad_patron,
            &kernel(),
            &pulse(&env),
            &protocol_wallet,
        );

    assert!(result.is_err());
}

// ── metadata byte-limit tests ────────────────────────────────────

/// Build a `String` of exactly `len` repeated `ch` bytes for boundary tests.
fn repeated(env: &Env, ch: char, len: usize) -> String {
    let mut buf = std::string::String::new();
    for _ in 0..len {
        buf.push(ch);
    }
    String::from_str(env, buf.as_str())
}

/// Attempt `create_talos` with caller-supplied metadata and report whether
/// the contract accepted it. Used by the negative/boundary metadata tests.
fn metadata_create_is_ok(
    env: &Env,
    client: &TalosRegistryClient,
    contract_id: &Address,
    creator: &Address,
    protocol_wallet: &Address,
    name: &String,
    category: &String,
    description: &String,
    pulse_cfg: &Pulse,
) -> bool {
    let patron_cfg = patron(env, creator);
    let kernel_cfg = kernel();
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
                    patron_cfg.clone(),
                    kernel_cfg.clone(),
                    pulse_cfg.clone(),
                    protocol_wallet.clone(),
                )
                    .into_val(env),
                sub_invokes: &[],
            },
        }])
        .try_create_talos(
            name,
            category,
            description,
            &patron_cfg,
            &kernel_cfg,
            pulse_cfg,
            protocol_wallet,
        )
        .is_ok()
}

#[test]
fn create_talos_at_max_metadata_bytes_is_accepted() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);

    let name = repeated(&env, 'n', MAX_NAME_BYTES as usize);
    let category = repeated(&env, 'c', MAX_CATEGORY_BYTES as usize);
    let description = repeated(&env, 'd', MAX_DESCRIPTION_BYTES as usize);
    let mut pulse_cfg = pulse(&env);
    pulse_cfg.token_symbol = repeated(&env, 's', MAX_TOKEN_SYMBOL_BYTES as usize);

    let patron_cfg = patron(&env, &creator);
    let kernel_cfg = kernel();

    let result = client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "create_talos",
                args: (
                    name.clone(),
                    category.clone(),
                    description.clone(),
                    patron_cfg.clone(),
                    kernel_cfg.clone(),
                    pulse_cfg.clone(),
                    protocol_wallet.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_create_talos(
            &name,
            &category,
            &description,
            &patron_cfg,
            &kernel_cfg,
            &pulse_cfg,
            &protocol_wallet,
        );

    assert!(result.is_ok(), "exactly-at-limit metadata must be accepted");
    let id = result
        .ok()
        .and_then(|outcome| outcome.ok())
        .expect("boundary metadata create must be ok");
    let talos = client.get_talos(&id).expect("talos must be stored");
    assert_eq!(talos.name, name);
    assert_eq!(talos.category, category);
    assert_eq!(talos.description, description);
    assert_eq!(talos.pulse.token_symbol, pulse_cfg.token_symbol);
}

#[test]
fn create_talos_rejects_name_over_max_bytes() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let name = repeated(&env, 'n', MAX_NAME_BYTES as usize + 1);

    assert!(!metadata_create_is_ok(
        &env,
        &client,
        &contract_id,
        &creator,
        &protocol_wallet,
        &name,
        &s(&env, "Marketing"),
        &s(&env, "desc"),
        &pulse(&env),
    ));
}

#[test]
fn create_talos_rejects_empty_name() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);

    assert!(!metadata_create_is_ok(
        &env,
        &client,
        &contract_id,
        &creator,
        &protocol_wallet,
        &s(&env, ""),
        &s(&env, "Marketing"),
        &s(&env, "desc"),
        &pulse(&env),
    ));
}

#[test]
fn create_talos_rejects_category_over_max_bytes() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let category = repeated(&env, 'c', MAX_CATEGORY_BYTES as usize + 1);

    assert!(!metadata_create_is_ok(
        &env,
        &client,
        &contract_id,
        &creator,
        &protocol_wallet,
        &s(&env, "Genesis"),
        &category,
        &s(&env, "desc"),
        &pulse(&env),
    ));
}

#[test]
fn create_talos_rejects_description_over_max_bytes() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let description = repeated(&env, 'd', MAX_DESCRIPTION_BYTES as usize + 1);

    assert!(!metadata_create_is_ok(
        &env,
        &client,
        &contract_id,
        &creator,
        &protocol_wallet,
        &s(&env, "Genesis"),
        &s(&env, "Marketing"),
        &description,
        &pulse(&env),
    ));
}

#[test]
fn create_talos_rejects_token_symbol_over_max_bytes() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let mut pulse_cfg = pulse(&env);
    pulse_cfg.token_symbol = repeated(&env, 's', MAX_TOKEN_SYMBOL_BYTES as usize + 1);

    assert!(!metadata_create_is_ok(
        &env,
        &client,
        &contract_id,
        &creator,
        &protocol_wallet,
        &s(&env, "Genesis"),
        &s(&env, "Marketing"),
        &s(&env, "desc"),
        &pulse_cfg,
    ));
}

#[test]
fn create_talos_rejects_empty_token_symbol() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let mut pulse_cfg = pulse(&env);
    pulse_cfg.token_symbol = s(&env, "");

    assert!(!metadata_create_is_ok(
        &env,
        &client,
        &contract_id,
        &creator,
        &protocol_wallet,
        &s(&env, "Genesis"),
        &s(&env, "Marketing"),
        &s(&env, "desc"),
        &pulse_cfg,
    ));
}

#[test]
fn create_talos_allows_empty_optional_metadata() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);

    // `category` and `description` are descriptive, so empty is allowed;
    // only the byte ceiling is enforced on them.
    assert!(metadata_create_is_ok(
        &env,
        &client,
        &contract_id,
        &creator,
        &protocol_wallet,
        &s(&env, "Genesis"),
        &s(&env, ""),
        &s(&env, ""),
        &pulse(&env),
    ));
}

#[test]
fn update_pulse_rejects_token_symbol_over_max_bytes() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    let mut bad_pulse = pulse(&env);
    bad_pulse.token_symbol = repeated(&env, 's', MAX_TOKEN_SYMBOL_BYTES as usize + 1);

    let result = client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_pulse",
                args: (id, bad_pulse.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_update_pulse(&id, &bad_pulse);

    assert!(result.is_err(), "over-limit token symbol must be rejected");
}

#[test]
fn update_patron_rejects_shares_not_summing_to_100() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    let bad_patron = Patron {
        creator_share: 50,
        investor_share: 30,
        treasury_share: 30, // sums to 110
        creator_addr: creator.clone(),
        investor_addr: Address::generate(&env),
        treasury_addr: Address::generate(&env),
    };

    let result = client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_patron",
                args: (id, bad_patron.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_update_patron(&id, &bad_patron);

    assert!(result.is_err());
}

// ── Two-step admin transfer tests ────────────────────────────────

fn mock_propose(
    env: &Env,
    client: &TalosRegistryClient,
    contract_id: &Address,
    admin: &Address,
    new_admin: &Address,
) {
    client
        .mock_auths(&[MockAuth {
            address: admin,
            invoke: &MockAuthInvoke {
                contract: contract_id,
                fn_name: "propose_admin",
                args: (new_admin.clone(),).into_val(env),
                sub_invokes: &[],
            },
        }])
        .propose_admin(new_admin);
}

fn mock_accept(
    env: &Env,
    client: &TalosRegistryClient,
    contract_id: &Address,
    pending: &Address,
) {
    client
        .mock_auths(&[MockAuth {
            address: pending,
            invoke: &MockAuthInvoke {
                contract: contract_id,
                fn_name: "accept_admin",
                args: ().into_val(env),
                sub_invokes: &[],
            },
        }])
        .accept_admin();
}

fn mock_cancel(
    env: &Env,
    client: &TalosRegistryClient,
    contract_id: &Address,
    admin: &Address,
) {
    client
        .mock_auths(&[MockAuth {
            address: admin,
            invoke: &MockAuthInvoke {
                contract: contract_id,
                fn_name: "cancel_admin_transfer",
                args: ().into_val(env),
                sub_invokes: &[],
            },
        }])
        .cancel_admin_transfer();
}

/// Happy path: propose → accept transfers admin and clears pending slot.
#[test]
fn propose_then_accept_transfers_admin() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin);
    assert_eq!(client.protocol_wallet(), Some(admin.clone()));
    assert_eq!(client.pending_admin(), None);

    mock_propose(&env, &client, &contract_id, &admin, &new_admin);
    assert_eq!(client.pending_admin(), Some(new_admin.clone()));

    mock_accept(&env, &client, &contract_id, &new_admin);

    // Admin is now new_admin; pending slot is cleared.
    assert_eq!(client.protocol_wallet(), Some(new_admin.clone()));
    assert_eq!(client.pending_admin(), None);
}

/// After transfer the new admin can use admin-only entry-points.
#[test]
fn new_admin_can_set_protocol_fee_after_transfer() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin);
    mock_propose(&env, &client, &contract_id, &admin, &new_admin);
    mock_accept(&env, &client, &contract_id, &new_admin);

    // New admin can update fee; old admin cannot.
    client
        .mock_auths(&[MockAuth {
            address: &new_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_protocol_fee",
                args: (400u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_protocol_fee(&400);

    assert_eq!(client.protocol_fee_bps(), Some(400));
}

/// propose_admin without admin auth must fail.
#[test]
fn propose_admin_requires_current_admin_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let impostor = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin);

    // No mock_auths → auth check fails.
    assert!(client.try_propose_admin(&new_admin).is_err());

    // Impostor auth → still fails.
    let result = client
        .mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "propose_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_propose_admin(&new_admin);
    assert!(result.is_err());
}

/// accept_admin without pending admin auth must fail.
#[test]
fn accept_admin_requires_pending_admin_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let impostor = Address::generate(&env);

    client.initialize(&admin);
    mock_propose(&env, &client, &contract_id, &admin, &new_admin);

    // Impostor pretending to be pending admin.
    let result = client
        .mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_accept_admin();
    assert!(result.is_err());

    // Original admin trying to accept — must also fail (only pending may accept).
    let result2 = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_accept_admin();
    assert!(result2.is_err());
}

/// accept_admin with no pending nomination must panic.
#[test]
fn accept_admin_without_pending_panics() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.initialize(&admin);

    // No propose was called; any auth attempt should fail.
    assert!(client.try_accept_admin().is_err());
}

/// cancel_admin_transfer removes pending and emits adm_cnl.
#[test]
fn cancel_admin_transfer_clears_pending() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin);
    mock_propose(&env, &client, &contract_id, &admin, &new_admin);
    assert_eq!(client.pending_admin(), Some(new_admin.clone()));

    mock_cancel(&env, &client, &contract_id, &admin);

    assert_eq!(client.pending_admin(), None);
    // Admin is unchanged.
    assert_eq!(client.protocol_wallet(), Some(admin.clone()));
}

/// After cancellation the pending admin can no longer accept.
#[test]
fn cancelled_pending_cannot_accept() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin);
    mock_propose(&env, &client, &contract_id, &admin, &new_admin);
    mock_cancel(&env, &client, &contract_id, &admin);

    let result = client
        .mock_auths(&[MockAuth {
            address: &new_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_accept_admin();
    assert!(result.is_err());
}

/// cancel_admin_transfer without pending nomination must panic.
#[test]
fn cancel_without_pending_panics() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.initialize(&admin);

    // No nomination exists.
    assert!(client.try_cancel_admin_transfer().is_err());
}

/// cancel_admin_transfer requires current admin auth.
#[test]
fn cancel_admin_transfer_requires_admin_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let impostor = Address::generate(&env);

    client.initialize(&admin);
    mock_propose(&env, &client, &contract_id, &admin, &new_admin);

    let result = client
        .mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel_admin_transfer",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_cancel_admin_transfer();
    assert!(result.is_err());
}

/// propose_admin replaces an existing pending nomination (no cancel needed).
#[test]
fn propose_admin_replaces_existing_pending() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);

    client.initialize(&admin);
    mock_propose(&env, &client, &contract_id, &admin, &first);
    assert_eq!(client.pending_admin(), Some(first.clone()));

    // Replace with a different nominee.
    mock_propose(&env, &client, &contract_id, &admin, &second);
    assert_eq!(client.pending_admin(), Some(second.clone()));

    // First nominee can no longer accept.
    let result = client
        .mock_auths(&[MockAuth {
            address: &first,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_accept_admin();
    assert!(result.is_err());
}

// ── Admin transfer event tests ───────────────────────────────────

#[test]
fn propose_admin_emits_adm_prp_event() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin);
    mock_propose(&env, &client, &contract_id, &admin, &new_admin);

    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let (addr, topics, data) = events.get(0).unwrap();

    assert_eq!(addr, contract_id);
    assert_eq!(topics.len(), 1);
    assert_topic_symbol(&env, &topics, 0, symbol_short!("adm_prp"));

    let (got_current, got_proposed): (Address, Address) =
        TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(got_current, admin);
    assert_eq!(got_proposed, new_admin);
}

#[test]
fn accept_admin_emits_adm_acc_event() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin);
    mock_propose(&env, &client, &contract_id, &admin, &new_admin);

    // Clear events accumulated by propose.
    let _ = env.events().all();

    mock_accept(&env, &client, &contract_id, &new_admin);

    let events = env.events().all();
    // The accept call is the only event since the last snapshot.
    let accept_events: std::vec::Vec<_> = events
        .iter()
        .filter(|(a, t, _)| {
            if *a != contract_id {
                return false;
            }
            if t.len() == 0 {
                return false;
            }
            let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &t.get(0).unwrap());
            sym.map(|s| s == symbol_short!("adm_acc")).unwrap_or(false)
        })
        .collect();

    assert_eq!(accept_events.len(), 1);
    let (_, _, data) = accept_events[0].clone();
    let (got_new,): (Address,) = TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(got_new, new_admin);
}

#[test]
fn cancel_admin_transfer_emits_adm_cnl_event() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin);
    mock_propose(&env, &client, &contract_id, &admin, &new_admin);
    mock_cancel(&env, &client, &contract_id, &admin);

    let events = env.events().all();
    let cancel_events: std::vec::Vec<_> = events
        .iter()
        .filter(|(a, t, _)| {
            if *a != contract_id {
                return false;
            }
            if t.len() == 0 {
                return false;
            }
            let sym: Result<Symbol, _> = TryFromVal::try_from_val(&env, &t.get(0).unwrap());
            sym.map(|s| s == symbol_short!("adm_cnl")).unwrap_or(false)
        })
        .collect();

    assert_eq!(cancel_events.len(), 1);
    let (_, _, data) = cancel_events[0].clone();
    let (got_cancelled,): (Address,) = TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(got_cancelled, new_admin);
}

// ── Timelock unit tests ──────────────────────────────────────────

#[test]
fn timelock_config_defaults_and_updates() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let default_cfg = client.get_timelock_config();
    assert_eq!(default_cfg.min_delay, 0);
    assert_eq!(default_cfg.grace_period, 604_800);

    // Non-admin cannot set config
    let impostor = Address::generate(&env);
    let err_res = client
        .mock_auths(&[MockAuth {
            address: &impostor,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (3600u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_timelock_config(&3600, &86400);
    assert!(err_res.is_err());

    // Admin updates config
    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (3600u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&3600, &86400);

    let updated = client.get_timelock_config();
    assert_eq!(updated.min_delay, 3600);
    assert_eq!(updated.grace_period, 86400);
}

#[test]
fn set_timelock_config_emits_tl_cfg_event() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (3600u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&3600, &86400);

    let events = env.events().all();
    let (addr, topics, data) = events.get(events.len() - 1).unwrap();

    assert_eq!(addr, contract_id);
    assert_eq!(topics.len(), 1);
    assert_topic_symbol(&env, &topics, 0, symbol_short!("tl_cfg"));

    let (old_delay, new_delay, grace): (u64, u64, u64) =
        TryFromVal::try_from_val(&env, &data).unwrap();
    assert_eq!(old_delay, 0);
    assert_eq!(new_delay, 3600);
    assert_eq!(grace, 86400);
}

#[test]
fn timelock_schedule_execute_happy_path() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (3600u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&3600, &86400);

    let action = AdminAction::SetProtocolFee(500);

    let proposal_id = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "schedule_action",
                args: (action.clone(), 3600u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .schedule_action(&action, &3600);

    assert_eq!(proposal_id, 1);

    let prop = client.get_timelock_proposal(&proposal_id).unwrap();
    assert_eq!(prop.status, ProposalStatus::Scheduled);
    assert_eq!(prop.eta, env.ledger().timestamp() + 3600);

    // Advance ledger timestamp to ETA
    env.ledger().with_mut(|li| {
        li.timestamp += 3600;
    });

    client.execute_action(&proposal_id);

    let executed_prop = client.get_timelock_proposal(&proposal_id).unwrap();
    assert_eq!(executed_prop.status, ProposalStatus::Executed);
    assert_eq!(client.protocol_fee_bps(), Some(500));
}

#[test]
fn timelock_schedule_propose_admin_happy_path() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    client.initialize(&admin);

    let action = AdminAction::ProposeAdmin(new_admin.clone());

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
    assert_eq!(client.pending_admin(), Some(new_admin.clone()));

    mock_accept(&env, &client, &contract_id, &new_admin);
    assert_eq!(client.protocol_wallet(), Some(new_admin));
}

#[test]
fn timelock_early_execution_fails() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (3600u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&3600, &86400);

    let action = AdminAction::SetProtocolFee(400);
    let proposal_id = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "schedule_action",
                args: (action.clone(), 3600u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .schedule_action(&action, &3600);

    // Attempt execution immediately before ETA
    let res = client.try_execute_action(&proposal_id);
    assert!(res.is_err());
}

#[test]
fn timelock_expired_execution_fails() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (100u64, 500u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&100, &500);

    let action = AdminAction::SetProtocolFee(400);
    let proposal_id = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "schedule_action",
                args: (action.clone(), 100u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .schedule_action(&action, &100);

    // Advance ledger timestamp beyond eta + grace_period (100 + 500 + 1 = 601)
    env.ledger().with_mut(|li| {
        li.timestamp += 601;
    });

    let res = client.try_execute_action(&proposal_id);
    assert!(res.is_err());
}

#[test]
fn timelock_cancellation_clears_proposal() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let action = AdminAction::SetProtocolFee(400);
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

    // Admin cancels action
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

    let cancelled = client.get_timelock_proposal(&proposal_id).unwrap();
    assert_eq!(cancelled.status, ProposalStatus::Cancelled);

    // Execution of cancelled proposal must fail
    assert!(client.try_execute_action(&proposal_id).is_err());
}

#[test]
fn timelock_direct_admin_calls_rejected_when_min_delay_active() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (3600u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&3600, &86400);

    // Direct set_protocol_fee call should fail because min_delay > 0
    let res = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_protocol_fee",
                args: (500u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_protocol_fee(&500);
    assert!(res.is_err());

    // Direct propose_admin call should fail because min_delay > 0
    let new_admin = Address::generate(&env);
    let res_prop = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "propose_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_propose_admin(&new_admin);
    assert!(res_prop.is_err());
}

// ── Storage schema migration tests ───────────────────────────────

fn run_migrations_with_auth(
    env: &Env,
    client: &TalosRegistryClient,
    contract_id: &Address,
    admin: &Address,
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

fn rollback_schema_with_auth(
    env: &Env,
    client: &TalosRegistryClient,
    contract_id: &Address,
    admin: &Address,
    target_version: u32,
) {
    client
        .mock_auths(&[MockAuth {
            address: admin,
            invoke: &MockAuthInvoke {
                contract: contract_id,
                fn_name: "rollback_schema",
                args: (target_version,).into_val(env),
                sub_invokes: &[],
            },
        }])
        .rollback_schema(&target_version);
}

#[test]
fn schema_version_starts_at_genesis_after_initialize() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env));

    assert_eq!(client.schema_version(), SCHEMA_GENESIS);
    assert_eq!(client.migration_history_len(), 1);
}

#[test]
fn run_migrations_applies_v1_to_v2_and_backfills_timelock_config() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let result = run_migrations_with_auth(&env, &client, &contract_id, &admin);

    assert_eq!(result, SCHEMA_TIMELOCK_DEFAULTS);
    assert_eq!(client.schema_version(), SCHEMA_TIMELOCK_DEFAULTS);

    // TimelockConfig is now explicitly persisted, matching the same
    // defaults get_timelock_config previously only returned implicitly.
    let cfg = client.get_timelock_config();
    assert_eq!(cfg.min_delay, 0);
    assert_eq!(cfg.grace_period, DEFAULT_GRACE_PERIOD);

    assert_eq!(client.migration_history_len(), 2);
    let record = client.migration_record_at(&1).expect("migration record");
    assert_eq!(record.from_version, SCHEMA_GENESIS);
    assert_eq!(record.to_version, SCHEMA_TIMELOCK_DEFAULTS);
    assert!(!record.rolled_back);
}

#[test]
fn run_migrations_is_idempotent_on_repeat_call() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    run_migrations_with_auth(&env, &client, &contract_id, &admin);
    assert_eq!(client.migration_history_len(), 2);

    // Calling again once fully migrated must not reapply the step or
    // append a duplicate history entry.
    let result = run_migrations_with_auth(&env, &client, &contract_id, &admin);
    assert_eq!(result, SCHEMA_TIMELOCK_DEFAULTS);
    assert_eq!(client.schema_version(), SCHEMA_TIMELOCK_DEFAULTS);
    assert_eq!(client.migration_history_len(), 2);
}

#[test]
#[should_panic]
fn run_migrations_requires_admin_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    // No auth mocked for this call: the admin's require_auth() must reject it.
    client.run_migrations();
}

#[test]
fn rollback_schema_within_depth_succeeds() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    run_migrations_with_auth(&env, &client, &contract_id, &admin);
    assert_eq!(client.schema_version(), SCHEMA_TIMELOCK_DEFAULTS);

    rollback_schema_with_auth(&env, &client, &contract_id, &admin, SCHEMA_GENESIS);

    assert_eq!(client.schema_version(), SCHEMA_GENESIS);
    let record = client.migration_record_at(&2).expect("rollback record");
    assert_eq!(record.from_version, SCHEMA_TIMELOCK_DEFAULTS);
    assert_eq!(record.to_version, SCHEMA_GENESIS);
    assert!(record.rolled_back);

    // The version pointer moved back, but the migration is re-appliable.
    let result = run_migrations_with_auth(&env, &client, &contract_id, &admin);
    assert_eq!(result, SCHEMA_TIMELOCK_DEFAULTS);
}

#[test]
fn rollback_schema_rejects_target_beyond_max_depth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    run_migrations_with_auth(&env, &client, &contract_id, &admin);

    // Current version is 2; MAX_ROLLBACK_DEPTH is 1, so target 0 is out of range.
    let res = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "rollback_schema",
                args: (0u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_rollback_schema(&0u32);
    assert!(res.is_err());
    assert_eq!(client.schema_version(), SCHEMA_TIMELOCK_DEFAULTS);
}

#[test]
fn auth_create_talos_unauthorized_fails_and_leaves_storage_and_events_unchanged() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let imposter = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    client.initialize(&protocol_wallet);

    let initial_events_count = env.events().all().len();
    let name = s(&env, "TestTalos");
    let category = s(&env, "AI");
    let description = s(&env, "Test Desc");
    let patron_cfg = patron(&env, &creator);
    let kernel_cfg = kernel();
    let pulse_cfg = pulse(&env);

    // Attempt creation with imposter auth instead of creator auth
    let res = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "create_talos",
                args: (
                    name.clone(),
                    category.clone(),
                    description.clone(),
                    patron_cfg.clone(),
                    kernel_cfg.clone(),
                    pulse_cfg.clone(),
                    protocol_wallet.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_create_talos(
            &name,
            &category,
            &description,
            &patron_cfg,
            &kernel_cfg,
            &pulse_cfg,
            &protocol_wallet,
        );

    assert!(res.is_err(), "Unauthorized creator caller must fail");
    assert_eq!(client.next_talos_id(), 1, "NextTalosId must not increment on auth rejection");
    assert!(client.get_talos(&1).is_none(), "No Talos record should be created");
    assert_eq!(env.events().all().len(), initial_events_count, "No new events should be emitted");
}

#[test]
fn auth_update_patron_unauthorized_fails_and_preserves_state_and_events() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let imposter = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    client.initialize(&protocol_wallet);

    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);
    let original_talos = client.get_talos(&id).expect("talos exists");
    let events_before = env.events().all().len();

    let new_patron = Patron {
        creator_share: 40,
        investor_share: 40,
        treasury_share: 20,
        creator_addr: creator.clone(),
        investor_addr: Address::generate(&env),
        treasury_addr: Address::generate(&env),
    };

    // Unauthorized call (imposter auth)
    let res = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_patron",
                args: (id, new_patron.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_update_patron(&id, &new_patron);

    assert!(res.is_err(), "Unauthorized update_patron must fail");
    let current_talos = client.get_talos(&id).expect("talos exists");
    assert_eq!(current_talos.patron.creator_share, original_talos.patron.creator_share);
    assert_eq!(current_talos.patron.investor_share, original_talos.patron.investor_share);
    assert_eq!(current_talos.patron.treasury_share, original_talos.patron.treasury_share);
    assert_eq!(env.events().all().len(), events_before, "No events should be emitted on auth failure");
}

#[test]
fn auth_update_kernel_unauthorized_fails_and_preserves_state() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let imposter = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    client.initialize(&protocol_wallet);

    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);
    let original_talos = client.get_talos(&id).expect("talos exists");

    let new_kernel = Kernel {
        approval_threshold: 999,
        gtm_budget: 88888,
        min_patron_pulse: 777,
    };

    // Unauthorized call with no auth or imposter auth
    let res = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_kernel",
                args: (id, new_kernel.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_update_kernel(&id, &new_kernel);

    assert!(res.is_err(), "Unauthorized update_kernel must fail");
    let current_talos = client.get_talos(&id).expect("talos exists");
    assert_eq!(current_talos.kernel.approval_threshold, original_talos.kernel.approval_threshold);
    assert_eq!(current_talos.kernel.gtm_budget, original_talos.kernel.gtm_budget);
    assert_eq!(current_talos.kernel.min_patron_pulse, original_talos.kernel.min_patron_pulse);
}

#[test]
fn auth_update_pulse_unauthorized_fails_and_preserves_state() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let imposter = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    client.initialize(&protocol_wallet);

    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);
    let original_talos = client.get_talos(&id).expect("talos exists");

    let new_pulse = Pulse {
        total_supply: 99_999_999,
        price_usd_cents: 500,
        token_symbol: s(&env, "NEWPULSE"),
    };

    // Unauthorized update_pulse call
    let res = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_pulse",
                args: (id, new_pulse.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_update_pulse(&id, &new_pulse);

    assert!(res.is_err(), "Unauthorized update_pulse must fail");
    let current_talos = client.get_talos(&id).expect("talos exists");
    assert_eq!(current_talos.pulse.total_supply, original_talos.pulse.total_supply);
    assert_eq!(current_talos.pulse.price_usd_cents, original_talos.pulse.price_usd_cents);
    assert_eq!(current_talos.pulse.token_symbol, original_talos.pulse.token_symbol);
}

#[test]
fn auth_deactivate_talos_unauthorized_fails_and_remains_active() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let imposter = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    client.initialize(&protocol_wallet);

    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);
    assert!(client.is_active(&id));

    // Imposter attempts deactivation
    let res = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, imposter.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_deactivate_talos(&id, &imposter);

    assert!(res.is_err(), "Unauthorized deactivation must fail");
    assert!(client.is_active(&id), "Talos must remain active after unauthorized deactivation attempt");
}

#[test]
fn auth_governance_and_timelock_unauthorized_mutations_fail() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let imposter = Address::generate(&env);
    client.initialize(&admin);

    // 1. Unauthorized set_timelock_config
    let res_cfg = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (1000u64, 2000u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_timelock_config(&1000, &2000);
    assert!(res_cfg.is_err(), "Unauthorized set_timelock_config must fail");

    // 2. Unauthorized schedule_action
    let action = AdminAction::SetProtocolFee(500);
    let res_sch = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "schedule_action",
                args: (action.clone(), 100u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_schedule_action(&action, &100);
    assert!(res_sch.is_err(), "Unauthorized schedule_action must fail");

    // Schedule a legitimate action by admin
    let prop_id = client
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

    // 3. Unauthorized cancel_action by non-admin
    let res_cnl = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel_action",
                args: (prop_id,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_cancel_action(&prop_id);
    assert!(res_cnl.is_err(), "Unauthorized cancel_action must fail");

    let prop = client.get_timelock_proposal(&prop_id).expect("proposal exists");
    assert_eq!(prop.status, ProposalStatus::Scheduled, "Proposal must remain Scheduled");

    // 4. Unauthorized touch_batch by non-admin
    let res_touch = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "touch_batch",
                args: (1u32, 10u32).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_touch_batch(&1, &10);
    assert!(res_touch.is_err(), "Unauthorized touch_batch must fail");
}


// ── Expanded authorization negative tests (#611) ─────────────────

// --- Missing authorization ---

/// create_talos without any mock_auths must be rejected.
#[test]
fn create_talos_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);

    let result = client.try_create_talos(
        &s(&env, "Alpha"),
        &s(&env, "Marketing"),
        &s(&env, "desc"),
        &patron(&env, &creator),
        &kernel(),
        &pulse(&env),
        &protocol_wallet,
    );
    assert!(result.is_err(), "create_talos must require creator auth");
}

/// update_patron called without any auth must be rejected.
#[test]
fn update_patron_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    let new_patron = Patron {
        creator_share: 50,
        investor_share: 30,
        treasury_share: 20,
        creator_addr: creator.clone(),
        investor_addr: Address::generate(&env),
        treasury_addr: Address::generate(&env),
    };
    assert!(client.try_update_patron(&id, &new_patron).is_err());
}

/// update_kernel called without any auth must be rejected.
#[test]
fn update_kernel_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    assert!(
        client
            .try_update_kernel(&id, &kernel())
            .is_err(),
        "update_kernel must require creator auth"
    );
}

/// update_pulse called without any auth must be rejected.
#[test]
fn update_pulse_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    assert!(
        client.try_update_pulse(&id, &pulse(&env)).is_err(),
        "update_pulse must require creator auth"
    );
}

/// deactivate_talos called without any auth must be rejected.
#[test]
fn deactivate_talos_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    assert!(
        client.try_deactivate_talos(&id, &creator).is_err(),
        "deactivate_talos must require creator auth"
    );
}

/// set_protocol_fee called without any auth must be rejected.
#[test]
fn set_protocol_fee_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let protocol_wallet = Address::generate(&env);
    client.initialize(&protocol_wallet);

    assert!(
        client.try_set_protocol_fee(&500).is_err(),
        "set_protocol_fee must require admin auth"
    );
}

/// schedule_action called without any auth must be rejected.
#[test]
fn schedule_action_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let protocol_wallet = Address::generate(&env);
    client.initialize(&protocol_wallet);

    let action = AdminAction::SetProtocolFee(500);
    assert!(
        client.try_schedule_action(&action, &0).is_err(),
        "schedule_action must require admin auth"
    );
}

/// cancel_action called without any auth must be rejected.
#[test]
fn cancel_action_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let action = AdminAction::SetProtocolFee(400);
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

    // No auth → must fail
    assert!(
        client.try_cancel_action(&proposal_id).is_err(),
        "cancel_action must require admin auth"
    );
}

/// set_timelock_config called without any auth must be rejected.
#[test]
fn set_timelock_config_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert!(
        client.try_set_timelock_config(&100, &86400).is_err(),
        "set_timelock_config must require admin auth"
    );
}

/// touch_batch called without any auth must be rejected.
#[test]
fn touch_batch_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert!(
        client.try_touch_batch(&1, &10).is_err(),
        "touch_batch must require admin auth"
    );
}

// ── Batched TTL extension with bounds ─────────────────────────

// ── Batched TTL extension with bounds ─────────────────────────

/// Build an initialized contract with one Talos record at id 1, with the
/// ledger already positioned at `sequence_number` so entry ages are exact.
///
/// Soroban test mode archives contract code when the ledger jumps by
/// millions of ledgers mid-test, so tests age entries by starting the
/// environment at the target ledger instead of advancing after setup.
fn setup_with_talos_at(
    sequence_number: u32,
) -> (Env, Address, TalosRegistryClient<'static>, Address) {
    let env = Env::default();
    env.ledger()
        .with_mut(|li| li.sequence_number = sequence_number);
    let contract_id = env.register_contract(None, TalosRegistry);
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let creator = Address::generate(&env);
    create_talos_with_auth(&env, &client, &contract_id, &creator, &admin);
    (env, contract_id, client, admin)
}

/// Invoke `extend_ttl_batch` with the admin's mock authorization.
fn extend_ttl_batch_as_admin(
    env: &Env,
    contract_id: &Address,
    client: &TalosRegistryClient<'static>,
    admin: &Address,
    start_id: u32,
    limit: u32,
    min_age: u32,
    max_age: u32,
) -> Option<(u32, u32)> {
    client
        .mock_auths(&[MockAuth {
            address: admin,
            invoke: &MockAuthInvoke {
                contract: contract_id,
                fn_name: "extend_ttl_batch",
                args: (start_id, limit, min_age, max_age).into_val(env),
                sub_invokes: &[],
            },
        }])
        .try_extend_ttl_batch(&start_id, &limit, &min_age, &max_age)
        .ok()
        .and_then(|outcome| outcome.ok())
}

/// Positive: an entry past the renewal threshold is re-written.
#[test]
fn extend_ttl_batch_renews_entries_inside_window() {
    let (env, contract_id, client, admin) =
        setup_with_talos_at(ttl_manager::RENEWAL_THRESHOLD + 1);

    let result = extend_ttl_batch_as_admin(
        &env,
        &contract_id,
        &client,
        &admin,
        1,
        10,
        ttl_manager::RENEWAL_THRESHOLD,
        u32::MAX,
    )
    .expect("bounded extension must succeed");

    assert_eq!(result, (1, 0));
}

/// Negative: entries younger than `min_age` are reported, never written.
#[test]
fn extend_ttl_batch_skips_entries_below_min_age() {
    let (env, contract_id, client, admin) =
        setup_with_talos_at(ttl_manager::RENEWAL_THRESHOLD - 1);

    let result = extend_ttl_batch_as_admin(
        &env,
        &contract_id,
        &client,
        &admin,
        1,
        10,
        ttl_manager::RENEWAL_THRESHOLD,
        u32::MAX,
    )
    .expect("bounded extension must succeed");

    assert_eq!(result, (0, 1));
}

/// Boundary: an entry one ledger past `max_age` falls outside the window.
#[test]
fn extend_ttl_batch_skips_entries_above_max_age() {
    let (env, contract_id, client, admin) = setup_with_talos_at(1_001);

    let result = extend_ttl_batch_as_admin(
        &env,
        &contract_id,
        &client,
        &admin,
        1,
        10,
        0,
        1_000, // age is 1_001 → outside the window
    )
    .expect("bounded extension must succeed");

    assert_eq!(result, (0, 1));
}

/// Boundary: `limit` caps how many ids are visited — ids beyond the limit
/// are not counted at all (neither touched nor skipped).
#[test]
fn extend_ttl_batch_honours_limit() {
    let (env, contract_id) = {
        let env = Env::default();
        env.ledger()
            .with_mut(|li| li.sequence_number = ttl_manager::RENEWAL_THRESHOLD + 1);
        let contract_id = env.register_contract(None, TalosRegistry);
        (env, contract_id)
    };
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let creator = Address::generate(&env);
    create_talos_with_auth(&env, &client, &contract_id, &creator, &admin);
    create_talos_with_auth(&env, &client, &contract_id, &creator, &admin);

    let result = extend_ttl_batch_as_admin(
        &env,
        &contract_id,
        &client,
        &admin,
        1,
        1, // only id 1 may be visited
        ttl_manager::RENEWAL_THRESHOLD,
        u32::MAX,
    )
    .expect("bounded extension must succeed");

    assert_eq!(result, (1, 0), "id 2 must stay outside the sweep");
}

/// Boundary: a zero limit produces an empty sweep without touching state.
#[test]
fn extend_ttl_batch_zero_limit_is_a_no_op() {
    let (env, contract_id, client, admin) =
        setup_with_talos_at(ttl_manager::RENEWAL_THRESHOLD + 1);

    let result = extend_ttl_batch_as_admin(
        &env,
        &contract_id,
        &client,
        &admin,
        1,
        0,
        ttl_manager::RENEWAL_THRESHOLD,
        u32::MAX,
    )
    .expect("bounded extension must succeed");

    assert_eq!(result, (0, 0));
}

/// Negative: malformed bounds fail with a static, privacy-safe diagnostic
/// before any storage is read or written.
#[test]
#[should_panic(expected = "ttl bounds: min_age exceeds max_age")]
fn extend_ttl_batch_rejects_inverted_window() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "extend_ttl_batch",
                args: (1u32, 10u32, 5_000_000u32, 1_000u32).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .extend_ttl_batch(&1, &10, &5_000_000, &1_000);
}

/// Negative: `extend_ttl_batch` is admin-gated exactly like `touch_batch`.
#[test]
fn extend_ttl_batch_without_auth_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert!(
        client
            .try_extend_ttl_batch(&1, &10, &ttl_manager::RENEWAL_THRESHOLD, &u32::MAX)
            .is_err(),
        "extend_ttl_batch must require admin auth"
    );
}

/// The protocol-config pause domain blocks `extend_ttl_batch` before any
/// The protocol-config pause domain blocks `extend_ttl_batch` before any
/// storage is read.
#[test]
#[should_panic(expected = "Domain is paused")]
fn extend_ttl_batch_is_blocked_while_paused() {
    let (env, contract_id, client, admin) =
        setup_with_talos_at(ttl_manager::RENEWAL_THRESHOLD + 1);

    // Registry exposes no domain-id pause entry-point, so seed the shared
    // `pause-control` status for the protocol-config domain directly.
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(
            &pause_control::PauseDataKey::PauseStatus(PAUSE_PROTOCOL_CONFIG),
            &pause_control::PauseStatus {
                paused: true,
                paused_by: admin.clone(),
                paused_at: 0,
                expires_at: 0,
            },
        );
    });

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "extend_ttl_batch",
                args: (1u32, 10u32, ttl_manager::RENEWAL_THRESHOLD, u32::MAX).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .extend_ttl_batch(&1, &10, &ttl_manager::RENEWAL_THRESHOLD, &u32::MAX);
}

/// Regression: the pre-existing `touch_batch` entry-point keeps skipping
/// entries below the renewal threshold and renews them once it is crossed,
/// so routing it through the bounded sweep core changes no behaviour.
#[test]
fn touch_batch_still_skips_then_renews_after_threshold() {
    let (env, contract_id) = {
        let env = Env::default();
        env.ledger()
            .with_mut(|li| li.sequence_number = ttl_manager::RENEWAL_THRESHOLD - 1);
        let contract_id = env.register_contract(None, TalosRegistry);
        (env, contract_id)
    };
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    let creator = Address::generate(&env);
    create_talos_with_auth(&env, &client, &contract_id, &creator, &admin);

    // age = 1_999_999 → one ledger short of the renewal threshold.
    let before = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "touch_batch",
                args: (1u32, 10u32).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .touch_batch(&1, &10);
    assert_eq!(before, (0, 1));

    // One more ledger crosses the threshold → the entry is renewed.
    env.ledger().with_mut(|li| li.sequence_number += 1);

    let after = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "touch_batch",
                args: (1u32, 10u32).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .touch_batch(&1, &10);
    assert_eq!(after, (1, 0));
}

// --- Wrong signer (impersonation) ---

/// A non-creator cannot update_patron even with their own valid auth.
#[test]
fn update_patron_wrong_signer_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let imposter = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    let new_patron = Patron {
        creator_share: 40,
        investor_share: 40,
        treasury_share: 20,
        creator_addr: creator.clone(),
        investor_addr: Address::generate(&env),
        treasury_addr: Address::generate(&env),
    };

    let result = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "update_patron",
                args: (id, new_patron.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_update_patron(&id, &new_patron);
    assert!(result.is_err(), "imposter must not update patron");
}

/// A non-admin impersonator cannot set_protocol_fee.
#[test]
fn set_protocol_fee_wrong_signer_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let imposter = Address::generate(&env);
    client.initialize(&admin);

    let result = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_protocol_fee",
                args: (500u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_protocol_fee(&500);
    assert!(result.is_err(), "imposter must not set protocol fee");
}

/// A non-admin cannot schedule_action.
#[test]
fn schedule_action_wrong_signer_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let imposter = Address::generate(&env);
    client.initialize(&admin);

    let action = AdminAction::SetProtocolFee(500);
    let result = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "schedule_action",
                args: (action.clone(), 0u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_schedule_action(&action, &0);
    assert!(result.is_err(), "non-admin must not schedule actions");
}

/// A non-admin cannot cancel_action.
#[test]
fn cancel_action_wrong_signer_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let imposter = Address::generate(&env);
    client.initialize(&admin);

    let action = AdminAction::SetProtocolFee(400);
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

    let result = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel_action",
                args: (proposal_id,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_cancel_action(&proposal_id);
    assert!(result.is_err(), "non-admin must not cancel actions");
}

// --- Uninitialized contract (dependency-failure) ---

/// set_protocol_fee on an uninitialized contract must panic.
#[test]
fn set_protocol_fee_on_uninit_contract_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    // No initialize() called
    let imposter = Address::generate(&env);
    let result = client
        .mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_protocol_fee",
                args: (300u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_protocol_fee(&300);
    assert!(result.is_err());
}

/// propose_admin on an uninitialized contract must panic.
#[test]
fn propose_admin_on_uninit_contract_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let any_addr = Address::generate(&env);
    let result = client
        .mock_auths(&[MockAuth {
            address: &any_addr,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "propose_admin",
                args: (any_addr.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_propose_admin(&any_addr);
    assert!(result.is_err());
}

/// accept_admin on an uninitialized contract (no pending) must panic.
#[test]
fn accept_admin_on_uninit_contract_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let any_addr = Address::generate(&env);
    let result = client
        .mock_auths(&[MockAuth {
            address: &any_addr,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_accept_admin();
    assert!(result.is_err());
}

/// schedule_action on an uninitialized contract must panic.
#[test]
fn schedule_action_on_uninit_contract_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let any_addr = Address::generate(&env);
    let action = AdminAction::SetProtocolFee(300);
    let result = client
        .mock_auths(&[MockAuth {
            address: &any_addr,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "schedule_action",
                args: (action.clone(), 0u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_schedule_action(&action, &0);
    assert!(result.is_err());
}

// --- Boundary input validation ---

/// Protocol fee at the maximum boundary (10 000 bps = 100%) is accepted.
#[test]
fn set_protocol_fee_at_max_boundary_is_accepted() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_protocol_fee",
                args: (10_000u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_protocol_fee(&10_000);

    assert_eq!(client.protocol_fee_bps(), Some(10_000));
}

/// Protocol fee above the maximum boundary must be rejected.
#[test]
fn set_protocol_fee_exceeds_max_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let result = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_protocol_fee",
                args: (10_001u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_protocol_fee(&10_001);
    assert!(result.is_err(), "fee > 10 000 bps must be rejected");
}

/// calculate_protocol_fee with a negative amount must panic.
#[test]
fn calculate_protocol_fee_negative_amount_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert!(
        client.try_calculate_protocol_fee(&(-1i128)).is_err(),
        "negative amount must be rejected"
    );
}

/// calculate_protocol_fee with zero amount returns zero.
#[test]
fn calculate_protocol_fee_zero_amount_returns_zero() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert_eq!(client.calculate_protocol_fee(&0), 0);
}

/// Patron shares summing to exactly 100 (boundary) must be accepted.
#[test]
fn patron_shares_summing_to_100_is_accepted() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);

    // All-to-creator boundary: 100 + 0 + 0 = 100
    let boundary_patron = Patron {
        creator_share: 100,
        investor_share: 0,
        treasury_share: 0,
        creator_addr: creator.clone(),
        investor_addr: Address::generate(&env),
        treasury_addr: Address::generate(&env),
    };

    let result = client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "create_talos",
                args: (
                    s(&env, "Edge"),
                    s(&env, "Sales"),
                    s(&env, "d"),
                    boundary_patron.clone(),
                    kernel(),
                    pulse(&env),
                    protocol_wallet.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_create_talos(
            &s(&env, "Edge"),
            &s(&env, "Sales"),
            &s(&env, "d"),
            &boundary_patron,
            &kernel(),
            &pulse(&env),
            &protocol_wallet,
        );
    assert!(result.is_ok(), "shares summing to 100 must be accepted");
}

/// Patron shares summing to 0 must be rejected.
#[test]
fn patron_shares_summing_to_zero_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);

    let zero_patron = Patron {
        creator_share: 0,
        investor_share: 0,
        treasury_share: 0,
        creator_addr: creator.clone(),
        investor_addr: Address::generate(&env),
        treasury_addr: Address::generate(&env),
    };

    let result = client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "create_talos",
                args: (
                    s(&env, "Zero"),
                    s(&env, "Sales"),
                    s(&env, "d"),
                    zero_patron.clone(),
                    kernel(),
                    pulse(&env),
                    protocol_wallet.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_create_talos(
            &s(&env, "Zero"),
            &s(&env, "Sales"),
            &s(&env, "d"),
            &zero_patron,
            &kernel(),
            &pulse(&env),
            &protocol_wallet,
        );
    assert!(result.is_err(), "shares summing to 0 must be rejected");
}

/// Timelock min_delay at the maximum allowed value must be accepted.
#[test]
fn set_timelock_config_at_max_min_delay_is_accepted() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    // MAX_MIN_DELAY = 2_592_000
    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (2_592_000u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&2_592_000, &86400);

    assert_eq!(client.get_timelock_config().min_delay, 2_592_000);
}

/// Timelock min_delay above the maximum must be rejected.
#[test]
fn set_timelock_config_above_max_min_delay_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let result = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (2_592_001u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_timelock_config(&2_592_001, &86400);
    assert!(result.is_err(), "min_delay above MAX must be rejected");
}

/// Timelock grace_period of zero must be rejected.
#[test]
fn set_timelock_config_zero_grace_period_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let result = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (0u64, 0u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_timelock_config(&0, &0);
    assert!(result.is_err(), "grace_period of 0 must be rejected");
}

/// Scheduling an action with delay less than min_delay must be rejected.
#[test]
fn schedule_action_below_min_delay_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "set_timelock_config",
                args: (3600u64, 86400u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_timelock_config(&3600, &86400);

    let action = AdminAction::SetProtocolFee(200);
    let result = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "schedule_action",
                args: (action.clone(), 3599u64).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_schedule_action(&action, &3599);
    assert!(result.is_err(), "delay < min_delay must be rejected");
}

// --- Retry / double-action scenarios ---

/// Executing an already-executed proposal must be rejected.
#[test]
fn execute_already_executed_proposal_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let action = AdminAction::SetProtocolFee(500);
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

    // Second execution must fail
    assert!(
        client.try_execute_action(&proposal_id).is_err(),
        "double execution must be rejected"
    );
}

/// Cancelling an already-executed proposal must be rejected.
#[test]
fn cancel_already_executed_proposal_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let action = AdminAction::SetProtocolFee(500);
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

    let result = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "cancel_action",
                args: (proposal_id,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_cancel_action(&proposal_id);
    assert!(result.is_err(), "cancelling executed proposal must fail");
}

/// Executing a non-existent proposal must be rejected.
#[test]
fn execute_nonexistent_proposal_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    assert!(
        client.try_execute_action(&9999).is_err(),
        "nonexistent proposal must not execute"
    );
}

/// Protocol wallet mismatch during create_talos must be rejected.
#[test]
fn create_talos_protocol_wallet_mismatch_is_rejected() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let wallet_a = Address::generate(&env);
    let wallet_b = Address::generate(&env);

    // Initialize with wallet_a
    client.initialize(&wallet_a);

    let p = patron(&env, &creator);
    let result = client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "create_talos",
                args: (
                    s(&env, "Mismatch"),
                    s(&env, "Sales"),
                    s(&env, "d"),
                    p.clone(),
                    kernel(),
                    pulse(&env),
                    wallet_b.clone(), // wrong wallet
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_create_talos(
            &s(&env, "Mismatch"),
            &s(&env, "Sales"),
            &s(&env, "d"),
            &p,
            &kernel(),
            &pulse(&env),
            &wallet_b,
        );
    assert!(result.is_err(), "protocol wallet mismatch must be rejected");
}

/// get_talos, creator_of, is_active on a non-existent ID return sensible defaults.
#[test]
fn read_queries_on_nonexistent_talos_return_defaults() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);

    assert!(client.get_talos(&999).is_none());
    assert!(client.creator_of(&999).is_none());
    assert!(!client.is_active(&999));
}

/// Operations on deactivated Talos still require creator auth (auth is
/// checked before any domain logic).
#[test]
fn operations_on_deactivated_talos_still_require_auth() {
    let (env, contract_id) = setup();
    let client = TalosRegistryClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    let protocol_wallet = Address::generate(&env);
    let id = create_talos_with_auth(&env, &client, &contract_id, &creator, &protocol_wallet);

    // Deactivate
    client
        .mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "deactivate_talos",
                args: (id, creator.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .deactivate_talos(&id, &creator);

    // Attempting update_kernel on a deactivated talos without auth must fail
    assert!(client.try_update_kernel(&id, &kernel()).is_err());
}

