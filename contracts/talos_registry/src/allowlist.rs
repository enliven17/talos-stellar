use soroban_sdk::{Address, Env};

/// A helper for managing the asset allowlist.
pub struct AssetAllowlist;

impl AssetAllowlist {
    /// Add an asset to the allowlist. Only the admin can perform this action.
    pub fn add(env: &Env, admin: Address, asset: Address) {
        admin.require_auth();
        env.storage().instance().set(&asset, &true);
    }

    /// Remove an asset from the allowlist. Only the admin can perform this action.
    pub fn remove(env: &Env, admin: Address, asset: Address) {
        admin.require_auth();
        env.storage().instance().remove(&asset);
    }
}

#[cfg(test)]
mod tests {
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn authorized_admin_can_add_asset() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let asset = Address::generate(&env);
        env.mock_all_auths();

        AssetAllowlist::add(&env, admin.clone(), asset.clone());

        // The asset should now be stored as approved.
        assert!(env.storage().instance().get(&asset).unwrap_or(false));
    }

    #[test]
    fn unauthorized_caller_cannot_add_asset() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let asset = Address::generate(&env);
        // Do not call `mock_all_auths`; the `require_auth` for `admin` will fail.

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            AssetAllowlist::add(&env, admin, asset.clone());
        }));

        assert!(result.is_err());
        // Storage must remain unchanged (the asset is not present) and no events emitted.
        assert!(!env.storage().instance().get(&asset).unwrap_or(false));
        assert!(env.events().all().is_empty());
    }

    #[test]
    fn authorized_admin_can_remove_asset() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let asset = Address::generate(&env);
        env.mock_all_auths();

        // First add the asset so we can remove it.
        AssetAllowlist::add(&env, admin.clone(), asset.clone());
        assert!(env.storage().instance().get(&asset).unwrap_or(false));

        // Remove it and verify it is gone.
        AssetAllowlist::remove(&env, admin.clone(), asset.clone());
        assert!(!env.storage().instance().get(&asset).unwrap_or(false));
    }

    #[test]
    fn unauthorized_caller_cannot_remove_asset() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let asset = Address::generate(&env);
        env.mock_all_auths();

        // Pre-populate the allowlist with an asset.
        AssetAllowlist::add(&env, admin.clone(), asset.clone());
        assert!(env.storage().instance().get(&asset).unwrap_or(false));

        // Now attempt to remove without any auth. `require_auth` will fail.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            AssetAllowlist::remove(&env, admin, asset.clone());
        }));

        assert!(result.is_err());
        // The asset must still be present and no events emitted.
        assert!(env.storage().instance().get(&asset).unwrap_or(false));
        assert!(env.events().all().is_empty());
    }
}