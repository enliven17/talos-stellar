use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    xdr::ToXdr,
    Address, Env, IntoVal,
};
use talos_dividends::{ContractError, TalosDividends, TalosDividendsClient};

fn digest(
    env: &Env,
    talos_id: u32,
    epoch_id: u64,
    funded: i128,
    creator: &Address,
    investor: &Address,
    treasury: &Address,
) -> soroban_sdk::BytesN<32> {
    let bytes = (
        talos_id,
        epoch_id,
        funded,
        creator.clone(),
        investor.clone(),
        treasury.clone(),
        33_u32,
        33_u32,
        34_u32,
    )
        .to_xdr(env);
    env.crypto().sha256(&bytes).to_bytes()
}

#[test]
fn manifest_binds_recipients_and_conserves_rounding() {
    let env = Env::default();
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
    let contract_id = env.register_contract(None, TalosDividends);
    let client = TalosDividendsClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let registry = Address::generate(&env);
    client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "initialize",
                args: (admin.clone(), registry.clone()).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &registry);

    let creator = Address::generate(&env);
    let investor = Address::generate(&env);
    let treasury = Address::generate(&env);
    let funded = 101_i128;
    let entitlement_digest = digest(
        &env, 42, 1, funded, &creator, &investor, &treasury,
    );
    let epoch = client
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "commit_epoch_manifest",
                args: (
                    admin.clone(),
                    42_u32,
                    funded,
                    entitlement_digest.clone(),
                    7_200_u64,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .commit_epoch_manifest(&admin, &42, &funded, &entitlement_digest, &7_200);

    let claim = |claimant: &Address| {
        client
            .mock_auths(&[MockAuth {
                address: claimant,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "claim_dividend",
                    args: (
                        claimant.clone(),
                        42_u32,
                        epoch,
                        creator.clone(),
                        investor.clone(),
                        treasury.clone(),
                        33_u32,
                        33_u32,
                        34_u32,
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .claim_dividend(
                claimant,
                &42,
                &epoch,
                &creator,
                &investor,
                &treasury,
                &33,
                &33,
                &34,
            )
    };
    let claimed = claim(&creator) + claim(&investor) + claim(&treasury);
    let manifest = client.get_round_manifest(&42, &epoch).unwrap();
    assert_eq!(claimed, 100);
    assert_eq!(manifest.entitlement_digest, entitlement_digest);
    assert_eq!(manifest.claimed_amount + manifest.rounding_dust, funded);
    assert_eq!(manifest.rounding_dust, 1);

    let changed_investor = Address::generate(&env);
    let result = client
        .mock_auths(&[MockAuth {
            address: &changed_investor,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "claim_dividend",
                args: (
                    changed_investor.clone(),
                    42_u32,
                    epoch,
                    creator.clone(),
                    changed_investor.clone(),
                    treasury.clone(),
                    33_u32,
                    33_u32,
                    34_u32,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_claim_dividend(
            &changed_investor,
            &42,
            &epoch,
            &creator,
            &changed_investor,
            &treasury,
            &33,
            &33,
            &34,
        );
    assert_eq!(result, Err(Ok(ContractError::InvalidEntitlementDigest)));
}
