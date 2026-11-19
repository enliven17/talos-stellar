# pause_control

A Soroban helper crate that adds **domain-scoped emergency pausing** to any Stellar smart contract. Contracts call these functions to gate state-mutating operations behind a per-domain pause flag with optional TTL-based auto-expiry.

`DomainId` is a plain `u32` so pause domains map directly to any numeric identifier already in use (Talos IDs, contract-defined enums, etc.).

## Purpose

Operational incidents sometimes require halting a specific feature area without deactivating the entire contract. `pause_control` solves this with lightweight, composable helpers that any Soroban contract can import and call with a single line, while still requiring caller authentication via Soroban's `require_auth`.

---

## Data Types

### `PauseStatus`

Stored state for a single paused domain.

```rust
pub struct PauseStatus {
    pub paused: bool,
    pub paused_by: Address,   // address that triggered the pause/unpause
    pub paused_at: u64,       // ledger timestamp when pause was set
    pub expires_at: u64,      // Unix timestamp (seconds) of auto-expiry; 0 = indefinite
}
```

### `DomainId`

```rust
pub type DomainId = u32;
```

---

## Public API

### `pause_domain(env, domain_id, auth_addr, duration)`

Pause a domain for `duration` seconds. Pass `0` for an indefinite pause.

| Parameter | Type | Description |
|-----------|------|-------------|
| `env` | `&Env` | Soroban environment |
| `domain_id` | `DomainId` | Numeric ID of the domain to pause |
| `auth_addr` | `&Address` | Address that must authorise this call (calls `require_auth`) |
| `duration` | `u64` | Seconds until auto-expiry. `0` = indefinite |

- Calls `auth_addr.require_auth()`.
- Writes a `PauseStatus { paused: true, expires_at: now + duration }` to persistent storage.
- Emits event `("dom_paus", auth_addr)` with data `(domain_id, duration)`.

---

### `unpause_domain(env, domain_id, auth_addr)`

Lift an active pause immediately.

| Parameter | Type | Description |
|-----------|------|-------------|
| `env` | `&Env` | Soroban environment |
| `domain_id` | `DomainId` | The domain to unpause |
| `auth_addr` | `&Address` | Address that must authorise this call |

- Panics with `"Domain is not paused"` if no active pause exists.
- Emits event `("dom_resm", auth_addr)` with data `(domain_id,)`.

---

### `expire_if_elapsed(env, domain_id) -> bool`

Check whether a time-limited pause has passed its `expires_at` timestamp and clear it if so. Returns `true` if the pause was cleared, `false` otherwise.

This is a no-op (returns `false`) when:
- No pause record exists for the domain.
- `paused` is `false`.
- `expires_at` is `0` (indefinite pause).
- `now < expires_at`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `env` | `&Env` | Soroban environment |
| `domain_id` | `DomainId` | The domain to inspect |

- Emits event `("dom_expd",)` with data `(domain_id,)` when a pause is lifted by expiry.

---

### `check_not_paused(env, domain_id)`

Assert that a domain is not paused. Call this at the top of any guarded function.

Internally calls `expire_if_elapsed` first, so a time-limited pause that has naturally elapsed is transparently cleared before the check.

| Parameter | Type | Description |
|-----------|------|-------------|
| `env` | `&Env` | Soroban environment |
| `domain_id` | `DomainId` | The domain to check |

- Panics with `"Domain is paused"` if the domain is active and has not expired.

---

### `is_paused(env, domain_id) -> bool`

Read-only check — returns `true` if the domain is currently paused (does **not** run expiry).

---

### `get_pause_status(env, domain_id) -> Option<PauseStatus>`

Return the full `PauseStatus` record, or `None` if the domain has never been paused.

---

### `require_not_paused(env, domain_id)`

Low-level panic guard — panics with `"Domain is paused"` without running expiry first. Prefer `check_not_paused` for most use cases.

---

## Emitted Events

| Topic | Data | When |
|-------|------|------|
| `("dom_paus", auth_addr)` | `(domain_id: DomainId, duration: u64)` | `pause_domain` called |
| `("dom_resm", auth_addr)` | `(domain_id: DomainId,)` | `unpause_domain` called |
| `("dom_expd",)` | `(domain_id: DomainId,)` | `expire_if_elapsed` clears an expired pause |

---

## Usage Snippet

```rust
use soroban_sdk::{contract, contractimpl, Address, Env};
use pause_control::{check_not_paused, pause_domain, unpause_domain, DomainId};

// Assign a stable u32 to each pausable feature domain.
const DOMAIN_TRANSFER: DomainId = 1;
const DOMAIN_WITHDRAW: DomainId = 2;

#[contract]
pub struct MyContract;

#[contractimpl]
impl MyContract {
    /// Emergency pause the transfer domain for 1 hour (3 600 seconds).
    /// The caller must be authorised (e.g. a multisig admin).
    pub fn emergency_pause(e: Env, admin: Address) {
        pause_domain(&e, DOMAIN_TRANSFER, &admin, 3_600);
    }

    /// Lift the pause before it expires.
    pub fn resume(e: Env, admin: Address) {
        unpause_domain(&e, DOMAIN_TRANSFER, &admin);
    }

    /// Transfer tokens — blocked while the transfer domain is paused.
    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        check_not_paused(&e, DOMAIN_TRANSFER); // auto-expires if elapsed, then panics if still active
        // ... transfer logic ...
    }
}
```

---

## Storage

Pause records are kept in **persistent storage** under `PauseDataKey::PauseStatus(domain_id)`. Unlike temporary storage, persistent entries survive ledger archival pressure and are explicitly cleared by `unpause_domain` or `expire_if_elapsed`.

---

## Project Structure

```
contracts/pause_control/
├── Cargo.toml
└── src/
    └── lib.rs
```

---

## License

MIT
