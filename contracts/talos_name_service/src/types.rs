use soroban_sdk::{contracterror, contracttype, Address, String, Vec};

// Re-export admin types for convenience
pub use super::admin::{AdminAction, ProposalStatus, TimelockConfig, TimelockProposal};

// ── Event Schema Version ────────────────────────────────────────────

/// Major event-schema version supported by this contract.
const SUPPORTED_MAJOR: u32 = 1;

/// Typed event-schema version returned to off-chain indexers.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventSchemaVersion {
    pub major: u32,
    pub minor: u32,
}

/// Canonical event-schema version for this contract.
pub const EVENT_SCHEMA_VERSION: EventSchemaVersion = EventSchemaVersion {
    major: SUPPORTED_MAJOR,
    minor: 0,
};

// ── Pause Types ─────────────────────────────────────────────────────

/// A narrowly-scoped write path that can be independently paused.
///
/// Reads (`resolve_name`, `name_of`, `is_name_available`, `has_name`) are
/// never gated by any pause domain. Admin entry-points (`set_registry_contract`,
/// timelock management) are intentionally not pausable — they already carry
/// their own admin-auth (and optional timelock) protection.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PauseDomain {
    NameRegistration,
}

/// Persisted record of an active pause on a single [`PauseDomain`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseState {
    pub paused_by: Address,
    pub paused_at: u64,
    /// Unix timestamp after which the pause automatically lifts.
    /// `0` means indefinite — only settable by the admin, never by a guardian.
    pub expires_at: u64,
}

/// Computed, read-friendly view of a domain's pause status.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseInfo {
    pub active: bool,
    pub paused_by: Option<Address>,
    pub paused_at: Option<u64>,
    /// `None` when not paused, or when paused indefinitely by the admin.
    pub expires_at: Option<u64>,
}

/// Maximum number of results returned by a single [`TalosNameService::names_page`] call.
pub const MAX_REVERSE_PAGE_SIZE: u32 = 50;

/// Maximum number of storage keys scanned per [`TalosNameService::names_page`] call.
///
/// Bounds ledger-read cost regardless of how sparse the ID space is.
/// A sparse registry (many IDs with no name) can exhaust the window before
/// filling the page; callers should detect `next_start == 0` and stop.
pub const MAX_REVERSE_SCAN_WINDOW: u32 = 500;

/// A page of reverse-lookup results from [`TalosNameService::names_page`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NamesPage {
    /// Up to `limit` `(talos_id, name)` pairs in ascending `talos_id` order.
    pub items: Vec<(u32, String)>,
    /// Cursor for the next page.  Pass as `start_id` on the next call.
    /// `0` means there are no more results within the scan window.
    pub next_start: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    NameRecord(String), // name → talos_id
    TalosName(u32),     // talos_id → name
    RegistryContract,
    Admin,
    TimelockConfig,
    TimelockProposal(u64),
    NextTimelockId,
    LastTouched(u32),
    NameFeeAmount,
    Guardians,
    PauseState(PauseDomain),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    UnauthorizedCaller = 2,
    TimelockEnabled = 3,
    DomainPaused = 4,
    NotAdminOrGuardian = 5,
    DomainLockedByAdmin = 6,
    InvalidPauseDuration = 7,
    GuardianLimitReached = 8,
}
