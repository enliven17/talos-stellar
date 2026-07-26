## Summary

Add proposal-based admin timelocks for `TalosRegistry` and `TalosNameService` Soroban contracts.

This enforces a configurable minimum delay between scheduling and executing high-impact administrative actions (protocol fee changes, admin transfers, registry pointer updates), giving on-chain observers a guaranteed visibility window before any change takes effect.

## Changes

### TalosRegistry

- **New types**: `AdminAction` enum (`SetProtocolFee`, `ProposeAdmin`), `ProposalStatus` enum (`Scheduled`, `Executed`, `Cancelled`), `TimelockProposal` struct, `TimelockConfig` struct
- **New entry-points**: `schedule_action`, `execute_action`, `cancel_action`, `set_timelock_config`, `get_timelock_config`, `get_timelock_proposal`
- **Direct-call guard**: `set_protocol_fee` and `propose_admin` panic with `"Timelock enabled: action must be scheduled"` when `min_delay > 0`
- **New events**: `tl_sch`, `tl_exec`, `tl_cnl`, `tl_cfg`
- **Version bump**: `CONTRACT_VERSION` `(1, 0, 0)` → `(1, 1, 0)`
- **Backward-compatible default**: `min_delay = 0` — no behaviour change for existing callers

### TalosNameService

- **New types**: same `AdminAction`, `ProposalStatus`, `TimelockProposal`, `TimelockConfig` pattern as Registry
- **New entry-points**: `schedule_action`, `execute_action`, `cancel_action`, `set_timelock_config`, `get_timelock_config`, `get_timelock_proposal`
- **New `AdminAction` variants**: `SetRegistryContract`, `SetAdmin`
- **Direct-call guard**: `set_registry_contract` and `set_admin` blocked when `min_delay > 0`
- **New events**: `tl_sch`, `tl_exec`, `tl_cnl`, `tl_cfg`, `reg_upd`
- **Version bump**: `CONTRACT_VERSION` `(1, 0, 0)` → `(1, 1, 0)`
- **Backward-compatible default**: `min_delay = 0`

### Documentation

- `contracts/README.md` updated with full timelock architecture, entry-points table, auth matrix, event schema, operational runbook (schedule / execute / cancel / rollback CLI examples), known limitations, and version bump notes

## Related Issues

Closes #N

## Test Plan

- [x] All existing tests continue to pass
- [x] New timelock tests added to both contracts:
  - `timelock_config_defaults_and_updates` — verifies defaults and non-admin guard
  - `timelock_schedule_execute_happy_path` — full schedule → advance ledger → execute flow
  - `timelock_schedule_propose_admin_happy_path` — ProposeAdmin action via timelock
  - `timelock_early_execution_fails` — panics before ETA
  - `timelock_expired_execution_fails` — panics after grace window
  - `timelock_cancellation_clears_proposal` — cancel marks Cancelled and blocks re-execution
  - `timelock_direct_admin_calls_rejected_when_min_delay_active` — direct bypass rejected
  - `name_service_timelock_schedule_execute_registry_update` — Name Service full flow
  - `name_service_timelock_direct_call_guarded` — Name Service direct bypass rejected
  - `name_service_timelock_cancellation` — Name Service cancel flow
- [x] Automated tests run: `cargo test` (from `contracts/`)
- [x] WASM build verified: `cargo build --target wasm32-unknown-unknown --release`
- [x] Manual verification:
  - Confirmed `version()` returns `(1, 1, 0)` in both contracts
  - Confirmed `get_timelock_config()` returns `{ min_delay: 0, grace_period: 604800 }` by default
  - Confirmed direct admin calls succeed when `min_delay = 0` (backward-compatible)
  - Confirmed direct admin calls fail when `min_delay > 0`

## Visual Changes

No UI changes.

## Checklist

- [x] I have read the [CONTRIBUTING.md](CONTRIBUTING.md) guide.
- [x] My code follows the style guidelines of this project.
- [x] I have commented my code, particularly in hard-to-understand areas.
- [x] I have made corresponding changes to the documentation.
- [x] My changes generate no new warnings or errors.
- [x] I have added tests that prove my fix is effective or that my feature works.
- [x] New and existing unit tests pass locally with my changes.
- [x] This change is backward-compatible by default (`min_delay = 0`).
