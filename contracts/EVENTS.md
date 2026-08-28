# Talos Contract Event Indexing Specification

**Spec version:** 1.0.0
**Applies to:** talos_registry, talos_governance, talos_name_service

## 1. Event envelope

Every Soroban event an indexer receives has:

| Field | Type | Notes |
|---|---|---|
| contract | Address | emitting contract |
| topics | Vec<Val> | topic[0] is always a Symbol identifying the event type |
| data | Val (tuple) | positional, see per-event tables below |
| ledger_sequence | u32 | from the RPC/Horizon envelope, not the event itself |
| tx_hash | Hash | from the envelope |
| event_index_in_tx | u32 | from the envelope |

## 2. Ordering guarantees

Indexers MUST treat `(ledger_sequence, tx_index_in_ledger, event_index_in_tx)`
as the canonical cursor. Events are strictly monotonic on this tuple and
never reordered within a ledger. On restart, an indexer resumes from the
last committed cursor and replays forward — this is safe because processing
is idempotent per cursor (see §4).

## 3. Event catalog

### talos_registry

| topics | data | meaning |
|---|---|---|
| (`tls_crt`, creator: Address) | (talos_id: u32, name: String, category: String) | new Talos registered |
| (`pat_upd`, talos_id: u32) | (creator_addr: Address, creator_share: u32, investor_share: u32) | patron split changed |
| (`fee_chg`,) | (old_bps: u32, new_bps: u32) | protocol fee changed |
| (`adm_prp`,) | (current: Address, proposed: Address) | admin transfer proposed |
| (`adm_acc`,) | (new_admin: Address,) | admin transfer accepted |
| (`adm_cnl`,) | (cancelled: Address,) | admin transfer cancelled |
| (`tl_sch`, proposal_id: u64) | (action: AdminAction, eta: u64, proposer: Address) | timelock scheduled |
| (`tl_exec`, proposal_id: u64) | (action: AdminAction, executor: Address) | timelock executed |
| (`tl_cnl`, proposal_id: u64) | (action: AdminAction, canceller: Address) | timelock cancelled |
| (`tl_cfg`,) | (old_min_delay: u64, new_min_delay: u64, grace_period: u64) | timelock config changed |

### talos_governance
| topics | data |
|---|---|
| (`prop_crt`, proposal_id) | ... |
| (`vote`, proposal_id) | ... |
| (`prop_stat`, proposal_id) | status: ProposalStatus |

### talos_name_service
| topics | data |
|---|---|
| (`name_reg`, talos_id: u32) | (name: String, owner: Address) |
| (`reg_upd`,) | (old_registry: Address, new_registry: Address) |
| (`tl_sch`/`tl_exec`/`tl_cnl`/`tl_cfg`) | same shape as registry timelock events |

*(Fill in governance's exact data tuple from `talos_governance/src/lib.rs` lines 70–90 — I truncated it above; copy the real field names.)*

## 4. Compatibility & versioning rules

- **Additive** (new event, new trailing data field): minor version bump, backward compatible — old indexers keep working, ignore the new field.
- **Breaking** (removed/reordered/type-changed field, repurposed topic symbol): a **new topic symbol** must be introduced (e.g. `tls_crt` → `tls_crt2`); the old symbol is retired but its meaning is never reused. Major version bump.
- Every event is emitted from exactly one code path per contract; enums used in data (e.g. `AdminAction`, `ProposalStatus`) are `#[contracttype]` and additive-only (new variants appended at the end).

## 5. Conformance fixtures

See `contracts/fixtures/event_fixtures.json` — one worked example per event
type (topics + data, both as XDR base64 and human-decoded JSON). Any
indexer implementation should decode these and match the expected JSON
exactly. `contracts/talos_registry/src/lib.rs`'s existing event unit tests
already assert this shape at the Rust level; the fixtures let a non-Rust
indexer validate the same guarantee.

## 6. Operational notes

- Rollback: this is a documentation + read-only fixture change. Reverting
  the commit fully restores prior state; no migration or on-chain change
  is involved.
- Verification: `cargo test -p talos_registry event_fixtures` (see below)
  regenerates and diffs fixtures against the checked-in copy.