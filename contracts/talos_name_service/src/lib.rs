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


#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

// Module declarations
mod admin;
mod contract;
mod events;
mod interface;
mod pause;
mod tests;
mod timelock;
mod ttl;
mod types;
mod validation;

// Re-exports for public interface
pub use admin::{AdminAction, ProposalStatus, TimelockConfig, TimelockProposal};
pub use types::{PauseDomain, PauseState, PauseInfo};
pub use types::{DataKey, ContractError, EventSchemaVersion, EVENT_SCHEMA_VERSION};
pub use types::{NamesPage, MAX_REVERSE_PAGE_SIZE, MAX_REVERSE_SCAN_WINDOW};
pub use interface::{INTERFACE_ID, INTERFACE_NAMESPACE, CONTRACT_VERSION};
pub use interface::{EXPECTED_REGISTRY_INTERFACE_ID, features_list, DEPRECATED_DIRECT_ADMIN};
pub use interface::{version_supports, check_registry_compatible};
pub use pause::{PAUSE_NAME_REGISTRATION, PAUSE_NAME_CONFIG};
pub use validation::{validate_name, canonicalize_name};

// Re-export the contract struct and implementation
pub use contract::TalosNameService;
