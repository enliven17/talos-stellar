# Talos Contract Interface Specification

This document is the canonical, contributor-facing specification for the
public contract interface of every Talos Soroban contract. It defines the
exposed `interface_id()`, `version()`, `supports_version()`, and
`interface_features()` entry-points, the rules for bumping any of the
returned values, the deprecation table for legacy direct-admin paths,
and the deterministic derivation algorithm used to compute the
golden-vector `INTERFACE_ID` byte sequences.

Anyone integrating with Talos **must** consult this document before
depending on a returned identifier — tools that regenerate the bytes
from `(INTERFACE_NAMESPACE, CONTRACT_VERSION)` MUST agree with the
emitted bytes (otherwise the deployed WASM has been tampered with).

## 1. Contract catalogue

| Contract                | `CONTRACT_VERSION` | `INTERFACE_NAMESPACE` | Interface ID prefix (first 16 bytes) |
|-------------------------|--------------------|-----------------------|--------------------------------------|
| `TalosRegistry`         | `(1, 1, 0)`        | `"TalosRegistry"`     | `54 61 6C 6F 73 52 65 67 69 73 74 72 79 00 00 00` ("TalosRegistry\0\0\0") |
| `TalosNameService`      | `(1, 1, 0)`        | `"TalosNameService"`  | `54 61 6C 6F 73 4E 61 6D 65 53 65 72 76 69 63 65` ("TalosNameService") |
| `TalosGovernance`       | `(1, 0, 0)`        | `"TalosGovernance"`   | `54 61 6C 6F 73 47 6F 76 65 72 6E 61 6E 63 65 00` ("TalosGovernance\0") |

A new contract added later MUST keep `major = 1` until a hard upgrade is
scheduled — bumping `major` is a deployment-grade event and operators
should plan a coordinated swap.

## 2. Interface queries (entry-points)

Every contract exposes the following entry-points. They are read-only,
do not require any authorization, do not modify ledger state, and are
deterministic (i.e. the same answer across repeated calls and across
all contract instances of the same WASM).

| Method                                  | Returns                    | Purpose                                                         |
|-----------------------------------------|----------------------------|-----------------------------------------------------------------|
| `version() -> (u32, u32, u32)`          | `(major, minor, patch)`    | SemVer of the deployed WASM. Compile-time constant.             |
| `interface_id() -> BytesN<32>`          | 32-byte ID                 | Stable identifier content-derived from (namespace, version).    |
| `supports_version(maj, min, patch) -> bool` | `bool`                 | True iff deployed >= requested. See §3.                         |
| `interface_features() -> Vec<Symbol>`   | list of capability tags    | Stable capability markers for feature gating (see §4).          |
| `deprecated_entry_count() -> u32`\*     | count of legacy entries    | Telemetry hook; lets indexers enumerate the deprecation table.  |

\* `deprecated_entry_count()` is exposed on Registry and Name Service
(those have admin paths that may be deprecated). Governance has no
direct-admin path to deprecate, so its table is empty by design and the
helper is omitted intentionally.

## 3. SemVer compatibility rule (`supports_version`)

```
actual.major == required.major
  AND (actual.minor > required.minor
       OR (actual.minor == required.minor
           AND actual.patch >= required.patch))
```

- `major` mismatch ⇒ **not supported** (ABI shape potentially different).
- `minor` ahead ⇒ **supported** (additive features only).
- `minor` equal, `patch` ahead ⇒ **supported** (bug-fix only).
- `minor` behind ⇒ **not supported** (caller needs a feature we don't expose).
- `minor` equal, `patch` behind ⇒ **not supported** (caller needs a fix we don't ship).

The rule is intentionally strict on the upper end: a caller pinning
`patch` higher than deployed will get `false` so they don't accidentally
mis-rely on a bug fix that isn't there.

## 4. Capability catalogue

Capabilities are stable feature markers exposed via
`interface_features()`. They are **stable strings**: appending a new
capability is `minor`-bump compatible; renaming or removing a capability
is a `major` bump.

### TalosRegistry

| Capability          | Description                                                  |
|---------------------|--------------------------------------------------------------|
| `create_talos`      | Primary mutator: register a Talos.                           |
| `talos_lifecycle`   | `update_kernel` / `update_pulse` / `update_patron`.          |
| `admin_transfer`    | `propose_admin` / `accept_admin` / `cancel_admin_transfer`.  |
| `timelock_admin`    | `schedule_action` / `execute_action` / `cancel_action`.      |
| `protocol_fee`      | `set_protocol_fee` / `calculate_protocol_fee`.               |
| `interface_query`   | `version` / `interface_id` / `supports_version`.             |
| `fees_collector`    | Capture 3% fee on Talos creation (configurable).             |

### TalosNameService

| Capability          | Description                                                  |
|---------------------|--------------------------------------------------------------|
| `name_registration` | `register_name` / `resolve_name` / `is_name_available`.      |
| `name_lifecycle`    | `update_name` / `has_name` / `name_of` — revoke + aliasing.  |
| `admin_transfer`    | `set_admin` for admin handover.                              |
| `timelock_admin`    | `schedule_action` / `execute_action` / `cancel_action`.      |
| `registry_pointer`  | `set_registry_contract` — points at the TalosRegistry.       |
| `interface_query`   | `version` / `interface_id` / `supports_version`.             |
| `cross_contract`    | `creator_of` invoke against the configured registry pointer. |

### TalosGovernance

| Capability          | Description                                                  |
|---------------------|--------------------------------------------------------------|
| `proposal_lifecycle`| `create_proposal` / `vote` / `finalize_proposal` / `execute_proposal`. |
| `vote_weighting`    | Snapshot-based token-weighted voting.                        |
| `config_admin`      | `update_config` / `cache_token_balance` (admin only).        |
| `interface_query`   | `version` / `interface_id` / `supports_version`.             |

## 5. Deprecation table

When a deployment has timelock enabled (`min_delay > 0`), the direct
admin paths below become deprecated and must be replaced with the
listed alternative.

| Contract                | Deprecated entry                              | Replacement                                                   |
|-------------------------|-----------------------------------------------|---------------------------------------------------------------|
| `TalosRegistry`         | `set_protocol_fee(fee_bps)` (direct)          | `schedule_action(SetProtocolFee(fee_bps), delay)` → `execute_action` |
| `TalosRegistry`         | `propose_admin(new_admin)` (direct)           | `schedule_action(ProposeAdmin(new_admin), delay)` → `execute_action` |
| `TalosNameService`      | `set_registry_contract(addr)` (direct)        | `schedule_action(SetRegistryContract(addr), delay)` → `execute_action` |

**Telemetry contract:** the deprecated path emits a `dep_path` event
with topics `(dep_path,)` and data `(deprecated: String, replacement: String)`
**before** panicking with the canonical panic message. Both fields in
the event are hard-coded strings; no caller or value data is exposed.
Indexers can scrape `dep_path` events to count how many callers are
still trying to use the legacy path and how long to keep the deprecation
window open after a timelock upgrade.

**Recommended deprecation window:** emit `dep_path` until the next
`minor` release (≥ 6 weeks), then drop the entry-point entirely on a
subsequent `major` bump.

## 6. `INTERFACE_ID` derivation (golden vectors)

Each contract emits a 32-byte `INTERFACE_ID` from its WASM binary.
The bytes are content-derived from the pair
`(INTERFACE_NAMESPACE, CONTRACT_VERSION)` according to the following
deterministic rule:

```
bytes = [0u8; 32]
bytes[0..min(16, len(namespace))] = namespace.bytes()
bytes[16..20] = major.to_be_bytes()              // u32, big-endian
bytes[20..24] = minor.to_be_bytes()              // u32, big-endian
bytes[24..28] = patch.to_be_bytes()              // u32, big-endian
bytes[28..32] = 0                                // reserved (future use)
```

This rule is reproduced in the test suite for every contract as the
`interface_id_golden_vector_matches_derivation` test, ensuring that
the constant cannot drift from the algorithm silently. **Reviewers MUST
reject** any diff that changes either `INTERFACE_ID`, `INTERFACE_NAMESPACE`,
or `CONTRACT_VERSION.major` without an accompanying `CHANGELOG.md` entry
explaining the breaking compatibility impact.

### Currently published golden vectors

The version is **not** redundantly encoded in the namespace slot —
it lives at offsets 16-27 only — so the namespace tail is zero-padded
to align the byte slices at canonical boundaries.

#### TalosRegistry `(1, 1, 0)` @ `"TalosRegistry"`

```
54 61 6C 6F 73 52 65 67   69 73 74 72 79 00 00 00
00 00 00 01 00 00 00 01   00 00 00 00 00 00 00 00
```

#### TalosNameService `(1, 1, 0)` @ `"TalosNameService"`

```
54 61 6C 6F 73 4E 61 6D   65 53 65 72 76 69 63 65
00 00 00 01 00 00 00 01   00 00 00 00 00 00 00 00
```

#### TalosGovernance `(1, 0, 0)` @ `"TalosGovernance"`

```
54 61 6C 6F 73 47 6F 76   65 72 6E 61 6E 63 65 00
00 00 00 01 00 00 00 00   00 00 00 00 00 00 00 00
```

## 7. Cross-contract compatibility

`TalosNameService` depends on the configured `RegistryContract` to
resolve `creator_of` for incoming name registrations. To make this
explicit (rather than implicit from a contract address being "alive"):

1. `TalosNameService::assert_registry_compatible()` cross-invokes the
   registered address's `interface_id()` and `version()`.
2. The expected `INTERFACE_ID` is the constant `INTERFACE_ID` exposed
   **inline** in this directory (mirrors the Registry's published
   bytes).
3. The minimum version is `>= (1, 1, 0)`.
4. On success it emits `compat_ok` with the remote version tuple.
5. On failure it either emits `compat_err` and reverts (default) or
   returns `false` if the caller chose the non-reverting path.

Both telemetry events are privacy-safe: no caller or value data is
exposed; only structural compatibility information (success + version,
or failure + flag).

## 8. Verification

Local reproduction:

```bash
cd contracts
cargo test --workspace
```

The tests will:

1. Verify the binary interface IDs round-trip cleanly with `interface_id()`.
2. Reproduce the IDs from scratch using the §6 algorithm
   (`interface_id_golden_vector_matches_derivation`).
3. Verify version compatibility semantics (`supports_version_*`).
4. Verify capability catalogue stability (`interface_features_*`).
5. Verify deprecation event flows (`set_protocol_fee_emits_dep_path_*`,
   `propose_admin_emits_dep_path_*`, `set_registry_contract_emits_dep_path_*`).
6. Verify cross-contract compatibility (`assert_registry_compatible_returns_true_for_real_registry`).

## 9. Rollout and rollback

This change is **additive** for callers:

- `version()` already existed on Registry and Name Service; the
  pre-published values are unchanged.
- `interface_id()`, `supports_version()`, `interface_features()` add
  read-only entry-points. Callers reading the new entry-points behave
  exactly as before if they ignore them.
- `deprecated_entry_count()` is a read-only telemetry helper.
- TalosGovernance gains `version()` and the three companions for the
  first time, but the contract previously returned no version at all,
  so there is no behavioral surprise.
- `assert_registry_compatible()` is a new explicit public entry-point
  on Name Service. It is safe to leave un-called by existing clients.

To roll back, redeploy a previous WASM that does not contain the new
entry-point symbols — Soroban CLI rejects invokes against unknown
entry-points, so clients calling them will simply fail with a clear
error rather than hitting silent misbehaviour.

## 10. Operator runbook

| Symptom                                         | Cause                                                | Action                                                                                              |
|-------------------------------------------------|------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `interface_id()` returns unexpected bytes       | Tampering or wrong WASM deployed                     | Pause integration; verify `INTERFACE_ID` from §6.                                                  |
| `supports_version()` keeps returning `false`    | Deployed contract older than client expectation      | Coordinate upgrade to a later `patch`.                                                             |
| `dep_path` events spike                          | Clients still using legacy paths after timelock flip | Reach out, document replacement in CHANGELOG, raise deprecation window.                            |
| `compat_err` event fires                        | Name service pointed at a non-TalosRegistry contract| Re-run `set_registry_contract` after deploying the correct WASM; or schedule recovery timelock action.|
| `assert_registry_compatible()` panic            | Mismatch or too-old version                          | Halt downstream registrations until compatibility is restored.                                      |
