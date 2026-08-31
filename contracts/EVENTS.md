# Talos Contract Event Indexing Specification

**Spec version:** 1.1.0
**Applies to:** talos_registry, talos_governance, talos_name_service, talos_dividends

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

## 1.1. Topic positions and data decoding rules

- **`topics[0]` is always the event-type `Symbol`.** Indexers dispatch on it.
- **Filterable entities live in `topics[1..]`** in a fixed per-event order so
  topic-indexed subscriptions can narrow results without fetching every event.
  For example `tls_crt` puts the `creator: Address` at `topics[1]` and
  `div_clm` puts `(epoch_id, patron)` at `topics[1..2]`.
- **`data` is a positional tuple** decoded strictly left-to-right using the
  per-event `data` column below. Field order is part of the stable contract:
  it is never reordered except under a breaking (major) version bump per §4.
- **Decoded JSON shape.** The canonical fixtures (`contracts/fixtures/`)
  represent each event as `{ event, contract, ledger_sequence, topics, data }`
  where `topics` and `data` are objects keyed by the field names in the
  catalog. Addresses stay as `G…`/`C…` strings, symbols stay as strings,
  and `u32`/`u64`/`i128` are numbers. The `event-query` helper decodes a raw
  event to exactly this shape and rejects anything that does not match.
- **Malformed payloads** (empty topics, `topics[0]` not a symbol, wrong topic
  type, wrong data arity, wrong data type) are rejected by the helper rather
  than silently mis-decoded.

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
| (`prop_crt`, proposal_id: u32) | (talos_id: u32, proposer: Address) |
| (`vote`, proposal_id: u32) | (voter: Address, choice: VoteChoice, weight: i128) |
| (`prop_stat`, proposal_id: u32) | status: ProposalStatus |

### talos_name_service
| topics | data |
|---|---|
| (`name_reg`, talos_id: u32) | (name: String, owner: Address) |
| (`reg_upd`,) | (old_registry: Address, new_registry: Address) |
| (`tl_sch`/`tl_exec`/`tl_cnl`/`tl_cfg`) | same shape as registry timelock events |

### talos_dividends
| topics | data |
|---|---|
| (`ep_cmt`, talos_id: u32) | (epoch_id: u64, total: i128, expiry_secs: u64) |
| (`div_clm`, epoch_id: u64, patron: Address) | (talos_id: u32, amount: i128, role: PatronRole) |
| (`ep_rcv`, epoch_id: u64) | (talos_id: u32, recovered: i128, admin: Address) |

`VoteChoice` is `{ Approve | Reject }`; `ProposalStatus` is
`{ Active | Approved | Rejected | Executed }`; `PatronRole` is
`{ Creator | Investor | Treasury }`. These enums are `#[contracttype]` and
additive-only (new variants are appended at the end).

## 4. Compatibility & versioning rules

- **Additive** (new event, new trailing data field): minor version bump, backward compatible — old indexers keep working, ignore the new field.
- **Breaking** (removed/reordered/type-changed field, repurposed topic symbol): a **new topic symbol** must be introduced (e.g. `tls_crt` → `tls_crt2`); the old symbol is retired but its meaning is never reused. Major version bump.
- Every event is emitted from exactly one code path per contract; enums used in data (e.g. `AdminAction`, `ProposalStatus`) are `#[contracttype]` and additive-only (new variants appended at the end).
- **Fixture format versioning note:** the canonical fixture file
  `contracts/fixtures/event_fixtures.json` carries a top-level `spec_version`
  field. Any change that alters how events decode (a new topic position, a
  reordered/retargeted data field, a new event family, or a changed type)
  **MUST** bump `spec_version` in the same commit as the fixture change and
  keep the `event_catalog` in lock-step with the Rust event definitions.
  Additive fixture additions (a new example event that reuses an existing
  catalog entry, new empty-range rows) only need a minor bump. Consumers
  should assert the `spec_version` they expect before decoding.

## 5. Conformance fixtures

See `contracts/fixtures/event_fixtures.json` — a versioned fixture document
with:

- `event_catalog` — the canonical topic-position + data-shape catalog per
  event family (`creation`, `update`, `governance`, `payment`).
- `fixtures` — one worked example per event type. Each entry carries the raw
  `topics`/`data` plus a fully-decoded `decoded` payload; any indexer
  implementation should decode the raw form and match `decoded` exactly.
- `empty_ranges` — representative ledger ranges that must return zero events.
- `malformed` — payloads that must be rejected (empty topics, non-symbol
  `topics[0]`, topic-type mismatch, wrong data arity/type).

### Bounded query helper

`contracts/fixtures/event-query.ts` is the reference TypeScript helper:

- `parseFixtureSet` / `parseEventFixture` — validate the document and decode
  each event against the catalog (throws on malformed payloads / unknown
  events).
- `queryEvents(set, { contract?, topic?, fromLedger, toLedger, pageSize, page? })` —
  queries by topic and **inclusive** ledger range with 1-based pagination.
- **Bounds are enforced, never silently clamped:** both `fromLedger` and
  `toLedger` are required (an unbounded range throws `UnboundedRangeError`);
  `pageSize` is required and must fall within
  `[bounds.min_page_size, bounds.max_page_size]` (an unbounded page size
  throws `UnboundedPageSizeError`); the span
  `toLedger - fromLedger + 1` cannot exceed `bounds.max_ledger_span`.

Run the fixture and helper tests with:

```bash
pnpm --dir contracts test:fixtures   # vitest run fixtures
```

Existing `cargo test -p talos_registry event_fixtures`-style Rust assertions
remain authoritative for on-chain shape; the JSON fixtures let a non-Rust
indexer validate the same guarantee without the Soroban toolchain.

## 6. Operational notes

- Rollback: this is a documentation + read-only fixture change. Reverting
  the commit fully restores prior state; no migration or on-chain change
  is involved.
- Verification: `pnpm --dir contracts test:fixtures` runs fixture parsing,
  per-family end-to-end decode, empty-range, malformed-payload, and
  bounded-query tests against the checked-in fixture file.