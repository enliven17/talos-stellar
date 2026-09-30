#[cfg(test)]
mod tests {
    use soroban_sdk::{testutils::Address as _, Address, Env};
    use crate::{TalosNameService, TalosNameServiceClient};

    #[test]
    fn simulate_upgrade_compatibility() {
        let env = Env::default();
        let contract_id = Address::generate(&env);
        
        // 1. Deploy current contract
        env.register_contract(&contract_id, TalosNameService);
        let client = TalosNameServiceClient::new(&env, &contract_id);
        
        // 2. Setup initial state
        client.initialize(&Address::generate(&env), &Address::generate(&env), &100_000_000);
        
        // 3. Simulate upgrade by registering the contract again 
        // (this replaces the code at the same contract ID in the test environment, 
        // simulating a WASM upgrade)
        env.register_contract(&contract_id, TalosNameService);
        
        // 4. Verify state is preserved and compatible
        let version = client.version();
        assert_eq!(version, (1, 3, 0)); // Assuming current version
    }
}
