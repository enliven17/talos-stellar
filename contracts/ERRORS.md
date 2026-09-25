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
