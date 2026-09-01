use soroban_sdk::{Address, Env};

pub struct AssetAllowlist;

impl AssetAllowlist {
    pub fn add(env: &Env, admin: Address, asset: Address) {
        admin.require_auth();
        env.storage().instance().set(&asset, &true);
    }
}
