use soroban_sdk::{Address, Env};

pub struct AssetAllowlist;

impl AssetAllowlist {
    pub fn add(env: &Env, admin: Address, asset: Address) {
        admin.require_auth();
        env.storage().instance().set(&asset, &true);
    }
}

[cfg(test)]
mod tests {
    use soroban_sdk::testutils::Address as _;
    #[test]
    fn authorized_adds() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let asset = Address::generate(&env);
        env.mock_all_auths();
        AssetAllowlist::add(&env, admin, asset);
        assert(env.storage().instance().get(&asset).unwrap_or(false));
    }
    #[test]
    fn unauthorized_rejected() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let asset = Address::generate(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(::| AssetAllowlist::add(&env, admin, asset));
        assert(result.is_ers());
        assert(!env.storage().instance().get(&asset).unwrap_or(false));
    }
}
