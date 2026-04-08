//! TalosNameService — Soroban smart contract for human-readable Talos names.
//!
//! Handles:
//! - Name registration (e.g., "marketbot" → Talos ID)
//! - Name resolution (name → Talos ID)
//! - Name availability checks
//! - Validation: 3-32 chars, lowercase alphanumeric + hyphens

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, String,
};

// ── Data Types ──────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    NameRecord(String),  // name → talos_id
    TalosName(u32),      // talos_id → name
}

// ── Events ──────────────────────────────────────────────────────────

fn emit_name_registered(env: &Env, talos_id: u32, name: String) {
    let topics = (symbol_short!("name_reg"), talos_id);
    env.events().publish(topics, name);
}

// ── Validation ──────────────────────────────────────────────────────

fn validate_name(name: &String) -> bool {
    let len = name.len() as usize;
    if len < 3 || len > 32 {
        return false;
    }

    // Check each character
    for i in 0..len {
        let c = name.get(i as u32);
        let is_lowercase = c >= 'a' as u32 && c <= 'z' as u32;
        let is_digit = c >= '0' as u32 && c <= '9' as u32;
        let is_hyphen = c == '-' as u32;

        if !is_lowercase && !is_digit && !is_hyphen {
            return false;
        }
    }

    // No consecutive hyphens
    for i in 0..len.saturating_sub(1) {
        let c1 = name.get(i as u32);
        let c2 = name.get((i + 1) as u32);
        if c1 == '-' as u32 && c2 == '-' as u32 {
            return false;
        }
    }

    true
}

// ── Contract ────────────────────────────────────────────────────────

#[contract]
pub struct TalosNameService;

#[contractimpl]
impl TalosNameService {
    /// Register a name for a Talos.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `talos_id` - The Talos ID to associate with the name
    /// * `name` - Human-readable name (3-32 chars, lowercase alphanumeric + hyphens)
    pub fn register_name(e: Env, talos_id: u32, name: String) {
        if !validate_name(&name) {
            panic!("Invalid name. Must be 3-32 chars, lowercase alphanumeric + hyphens, no consecutive hyphens.");
        }

        if e.storage()
            .persistent()
            .get::<_, u32>(&DataKey::NameRecord(name.clone()))
            .is_some()
        {
            panic!("Name already taken");
        }

        // Store mappings
        e.storage()
            .persistent()
            .set(&DataKey::NameRecord(name.clone()), &talos_id);
        e.storage()
            .persistent()
            .set(&DataKey::TalosName(talos_id), &name);

        emit_name_registered(&e, talos_id, name);
    }

    /// Resolve a name to a Talos ID.
    /// Returns None if the name doesn't exist.
    pub fn resolve_name(e: Env, name: String) -> Option<u32> {
        e.storage()
            .persistent()
            .get(&DataKey::NameRecord(name))
    }

    /// Get the name associated with a Talos ID.
    /// Returns None if the Talos has no name.
    pub fn name_of(e: Env, talos_id: u32) -> Option<String> {
        e.storage()
            .persistent()
            .get(&DataKey::TalosName(talos_id))
    }

    /// Check if a name is available.
    pub fn is_name_available(e: Env, name: String) -> bool {
        if !validate_name(&name) {
            return false;
        }
        e.storage()
            .persistent()
            .get::<_, u32>(&DataKey::NameRecord(name))
            .is_none()
    }

    /// Check if a Talos has a registered name.
    pub fn has_name(e: Env, talos_id: u32) -> bool {
        e.storage()
            .persistent()
            .get::<_, String>(&DataKey::TalosName(talos_id))
            .is_some()
    }
}
