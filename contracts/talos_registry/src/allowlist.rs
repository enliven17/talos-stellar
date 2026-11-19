use soroban_sdk::{contracttype, Address, Env};

#[contracttype]
#[derive(Clone)]
pub enum AllowlistDataKey {
    AllowedAsset(Address),
}

pub struct AssetAllowlist;

impl AssetAllowlist {
    pub fn add(env: &Env, admin: &Address, asset: &Address) {
        admin.require_auth();
        env.storage()
            .instance()
            .set(&AllowlistDataKey::AllowedAsset(asset.clone()), &true);
    }

    pub fn remove(env: &Env, admin: &Address, asset: &Address) {
        admin.require_auth();
        env.storage()
            .instance()
            .remove(&AllowlistDataKey::AllowedAsset(asset.clone()));
    }

    pub fn is_allowed(env: &Env, asset: &Address) -> bool {
        env.storage()
            .instance()
            .get(&AllowlistDataKey::AllowedAsset(asset.clone()))
            .unwrap_or(false)
    }

    pub fn enforce(env: &Env, asset: &Address) {
        if !Self::is_allowed(env, asset) {
            panic!("Asset not in allowlist");
        }
    }
}
