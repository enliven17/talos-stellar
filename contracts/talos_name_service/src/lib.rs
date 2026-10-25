//! TalosNameService — Soroban smart contract for human-readable Talos names.
//!
//! Handles:
//! - Name registration (e.g., "marketbot" → Talos ID)
//! - Name resolution (name → Talos ID)
//! - Name availability checks
//! - Validation: 3-32 chars, lowercase alphanumeric + hyphens

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
mod upgrade_simulation_tests;

#[cfg(all(test, not(target_arch = "wasm32")))]

