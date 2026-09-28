# Soroban contract errors

This page documents errors exposed by the contract sources in this workspace. Numeric values are the `#[contracterror]` discriminants in Rust. Pair a code with its contract address and method when diagnosing a failed invocation. Codes are contract-specific: code `2` means different things in `TalosNameService` and `TalosDividends`.

## Typed contract errors

### TalosNameService (`ContractError`)

| Code | Variant | Meaning / caller action |
|---:|---|---|
| 1 | `AlreadyInitialized` | `initialize` already completed; do not retry initialization. |
| 2 | `UnauthorizedCaller` | Caller is not authorized; use the configured authority. |
| 3 | `TimelockEnabled` | Direct admin operation is disabled; schedule the action instead. |
| 4 | `DomainPaused` | Write operation is blocked by pause state; retry after unpause. |
| 5 | `NotAdminOrGuardian` | Caller cannot change pause state; use an admin or guardian. |
| 6 | `DomainLockedByAdmin` | Guardian cannot change an admin-locked domain; an admin must unlock it. |
| 7 | `InvalidPauseDuration` | Duration is outside allowed bounds; submit an in-range value. |
| 8 | `GuardianLimitReached` | Maximum guardian count reached; remove a guardian before adding one. |

### TalosDividends (`ContractError`)

| Code | Variant | Meaning / caller action |
|---:|---|---|
| 1 | `AlreadyInitialized` | Initialization already completed. |
| 2 | `NotInitialized` | Required state is absent; initialize before calling this method. |
| 3 | `Unauthorized` | Caller is not the configured administrator. |
| 4 | `EpochNotFound` | Requested distribution epoch does not exist. |
| 5 | `AlreadyClaimed` | This patron has already claimed this epoch. |
| 6 | `EpochExpired` | Claim window elapsed; claims are no longer accepted. |
| 7 | `EpochNotExpired` | Recovery is premature; wait until the claim window closes. |
| 8 | `ZeroAllocation` | Computed claim is zero and cannot be transferred. |
| 9 | `InvalidEpochParams` | `total_amount` or `expiry_secs` is outside accepted bounds. |
| 10 | `NotAPatron` | Caller has no recognized patron role for this Talos. |
| 11 | `Overflow` | Checked arithmetic failed and the operation was aborted. Review amounts and state before retrying. |
| 12 | `EpochAlreadyExists` | An epoch with this identifier was already committed. |
| 13 | `TalosNotFound` | Registry has no Talos for the supplied ID; verify ID and registry state. |
| 14 | `AccountingOverflow` | Claim would make claimed amount exceed epoch total; resolve accounting state before retrying. |
| 15 | `AlreadyRecovered` | Epoch has already been recovered. |

### Storage migration helper (`MigrationError`)

These are returned by the `storage_migration` library used by the registry, not by a separately deployed contract.

| Code | Variant | Meaning / caller action |
|---:|---|---|
| 1 | `NotForward` | Target version is not greater than source version. |
| 2 | `OutOfOrder` | Stored/current version does not match requested source; re-read schema version and plan from current state. |
| 3 | `MigrationInProgress` | Another migration holds the lock; wait for it to finish. |
| 4 | `RollbackNotAllowed` | Rollback target is not below current version. |
| 5 | `RollbackTooDeep` | Rollback exceeds the supported depth. |

## String panic diagnostics

`TalosRegistry`, `TalosGovernance`, and many `TalosNameService` validation and timelock paths currently use `panic!("...")` instead of a typed `#[contracterror]`. These strings are diagnostics, not stable numeric codes; Soroban tooling may surface them differently and they may change without changing an error discriminant. Clients must not parse them as an API. Source remains authoritative for method context and exact conditions.

| Contract | Common diagnostic(s) | Cause |
|---|---|---|
| Registry | `Patron shares must sum to 100` | Supplied shares do not total 100. |
| Registry | `Write path paused` | Affected write domain is paused. |
| Registry | `Already initialized` | Initialization already completed. |
| Registry | `Protocol fee cannot exceed 100%` | Fee exceeds 10,000 basis points. |
| Registry | `Timelock enabled: action must be scheduled` | Direct admin call used while timelock is enabled. |
| Registry | `Grace period must be positive`; `Min delay exceeds maximum limit` | Timelock configuration is outside bounds. |
| Registry | `Delay less than minimum required delay`; `Timelock delay not met`; `Proposal expired`; `Proposal not active` | Schedule timing or proposal lifecycle check failed. |
| Registry | `Caller is not admin or guardian`; `Domain locked by admin; guardians cannot modify`; `Duration exceeds admin maximum`; `Guardian pause duration out of bounds` | Caller or requested pause duration is not permitted. |
| Registry | `Guardian limit reached` | Maximum guardian count reached. |
| Registry | `Protocol wallet mismatch`; `Amount must be non-negative` | Wallet does not match configuration, or amount is negative. |
| Registry | `Unsupported event schema major version` | Requested event schema major version is unsupported. |
| Registry | `Name cannot be empty`; `Name exceeds maximum byte length` | Caller-supplied Talos name is missing or exceeds 64 bytes. |
| Registry | `Category exceeds maximum byte length`; `Description exceeds maximum byte length` | Talos category (> 32 bytes) or description (> 512 bytes) metadata is too long. |
| Registry | `Token symbol cannot be empty`; `Token symbol exceeds maximum byte length` | Pulse `token_symbol` is missing or exceeds 12 bytes. |
| Registry | Migration/rollback rejection diagnostics | Migration helper rejected version ordering, range, or in-progress state. |
| Registry, Governance, Name service | `Domain is paused` | The write path's pause domain is active (or was paused indefinitely). |
| Registry, Governance, Name service | `ttl bounds: min_age exceeds max_age`; `ttl bounds: max_keys must be greater than zero`; `ttl bounds: max_keys exceeds MAX_BATCH_KEYS` | `extend_ttl_batch` bounds were rejected by the shared `ttl-manager` validator before any storage read or write. |
| Governance | `Already initialized` | Initialization already completed. |
| Governance | `Quorum must be positive`; `Consensus threshold must be 1..10000 bps`; `Voting period must be positive` | Initial or updated configuration is outside bounds. |
| Governance | `Title cannot be empty`; `Description cannot be empty` | Proposal metadata is missing. |
| Governance | `Proposal is not active`; `Voting period has ended`; `Voting period has not ended`; `Proposal is not approved` | Proposal state or timing disallows the operation. |
| Governance | `Already voted on this proposal`; `No voting power` | Voter already voted or has no eligible weight. |
| Governance | `Balance cannot be negative`; `Unauthorized admin` | Invalid cached balance or caller is not admin. |
| Name service | `Invalid name...`; `Name already taken` | Name validation failed or name is registered already. |
| Name service | `name_fee must be non-negative`; `Asset not in registry allowlist...` | Invalid fee configuration or payment asset. |
| Name service | Registry interface/version diagnostics | Configured registry is incompatible or below required version. |
| Name service | Timelock configuration/schedule/lifecycle diagnostics (see Registry rows) | Timelock bounds, schedule timing, or proposal lifecycle check failed. |
| Name service | `Unsupported event schema major version` | Requested event schema major version is unsupported. |

## Host and authorization failures

Soroban authorization failures, missing entry points, invalid XDR/value types, resource limits, and failures propagated from token or cross-contract calls are host or dependency errors, not values in the enums above. Inspect the transaction result and diagnostic events. Correct the caller, resource budget, or dependency state as appropriate; retry only if the condition is transient. These errors must not expose secrets, signing material, or payment proofs.

## Maintaining this reference

Update this page when adding or changing a `#[contracterror]` variant, and preserve existing discriminants for deployed contracts. Document new panic diagnostics as non-stable text; do not assign numeric codes to panic strings unless the contract exposes a typed error.

## Budget regression gates (#610)

Budget regression gates are host-side (non-WASM) test assertions that verify each entry-point stays within CPU-instruction and memory-byte ceilings measured by `env.budget()`. They are implemented in the `#[cfg(test)]` modules of every contract crate and in `indexer_fixtures`.

### What the gates are

Each gate follows this pattern:

```rust
env.budget().reset_default();       // zero counters, re-apply default limit
client.some_entry_point(…);         // call under measurement
let cpu = env.budget().cpu_instruction_cost();
let mem = env.budget().memory_bytes_cost();
assert!(cpu < CEILING_CPU, "…");
assert!(mem < CEILING_MEM, "…");
```

`env.budget().reset_default()` re-zeroes both accumulators and re-applies the default per-transaction limit before each measured call, so tests are fully isolated from any setup cost.

### Cost dimensions

| Dimension | Method | Unit |
|---|---|---|
| CPU | `env.budget().cpu_instruction_cost()` | abstract instructions |
| Memory | `env.budget().memory_bytes_cost()` | bytes |

> **Note:** The Soroban SDK test runtime runs Rust natively and **underestimates** costs relative to the WASM runtime deployed on-chain. Ceilings in the tests are therefore loose regression sentinels, not hard production transaction limits. If an entry-point exceeds a ceiling in CI it means a change significantly increased its resource consumption and requires explicit review.

### Coverage per crate

| Crate | Entry-points gated | Notes |
|---|---|---|
| `talos_registry` | `initialize`, `create_talos`, `get_talos`, `update_patron`, `deactivate_talos` | Includes boundary test at max metadata byte lengths and malformed-shares rejection. |
| `talos_governance` | `initialize`, `create_proposal`, `vote`, `record_dividend_snapshot`, `get_proposal` | Includes empty-title rejection gate. |
| `talos_name_service` | `initialize`, `register_name`, `resolve_name`, `name_of` | Includes duplicate-name rejection gate. |
| `talos_dividends` | `initialize`, `commit_epoch`, `claim_dividend`, `get_epoch` | Includes minimum-amount boundary and zero-amount rejection gates. |
| `ttl_manager` | `KeyHealth::observe` (×100), `BatchSweep::record` (×200), `TtlBounds::validate`, `bounded_range` | Pure function gates; no contract struct needed. |
| `storage_migration` | `initialize_schema`, `begin_migration`, `complete_migration`, `dry_run` | Uses `env.as_contract()` context; includes up-to-date dry-run and out-of-order rejection gates. |

### BudgetGateEvent (indexer_fixtures)

`indexer_fixtures` exports a `BudgetGateEvent` typed struct and a `budget_gate_fixture` constructor for use by off-chain test tooling that needs a canonical typed representation of a budget measurement:

```rust
pub struct BudgetGateEvent {
    pub entry_point: String,  // e.g. "create_talos"
    pub cpu_cost: u64,
    pub mem_cost: u64,
}
```

This struct is `#[contracttype]` and round-trips through the Soroban XDR codec. It is **never emitted by production contract code** — budget gates exist only in `#[cfg(test)]` modules.

### Rollout and compatibility notes

- Adding or tightening a ceiling is a non-breaking change; it is safe to raise ceilings when the host-side cost of an operation genuinely increases.
- Removing a gate requires the same justification as removing a test.
- Budget gates do not require migration, schema changes, or on-chain deployment. They run entirely on the host target (`cargo test --workspace`).
- Errors must not expose secrets, seeds, payment proofs, or other sensitive input — the same rule that governs all other error paths in this workspace.
