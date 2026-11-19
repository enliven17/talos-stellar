# ttl_manager

A Soroban helper crate for **bounded TTL extension** on persistent contract storage. It provides the decision logic for when to refresh an entry's time-to-live, age-windowed batch sweeps, and health aggregation — all without directly calling `get_ttl` / `extend_ttl`, which are unavailable in Soroban SDK v21 production builds.

## How It Works

Soroban persistent storage entries carry a TTL measured in ledgers (~5 s per ledger). When TTL reaches 0 the entry is **archived**. Because `get_ttl()` / `extend_ttl()` are not available in production builds of soroban-sdk v21, this crate uses a different strategy:

1. Each contract tracks a `last_touched` ledger sequence per key in a dedicated `DataKey` variant.
2. `touch` entrypoints re-read the current value and `set()` it back — a no-op on the data but it resets the Soroban TTL to the maximum.
3. `get_storage_health` compares `current_ledger - last_touched` against configurable warning / critical thresholds.

## Thresholds

| Constant | Ledgers | Wall-clock | Meaning |
|----------|---------|------------|---------|
| `WARN_THRESHOLD` | 2 000 000 | ~116 days | Entry should be touched soon |
| `CRITICAL_THRESHOLD` | 3 500 000 | ~202 days | Entry is at risk of archival |
| `RENEWAL_THRESHOLD` | 2 000 000 | ~116 days | Default renewal trigger (same as WARN) |

---

## Public API

### `TtlBounds` (struct)

Age window and work cap for a batched TTL extension sweep. All values are in **ledgers**.

```rust
pub struct TtlBounds {
    pub min_age: u32,  // entries younger than this are skipped
    pub max_age: u32,  // entries older than this are skipped
    pub max_keys: u32, // max ids one sweep may visit (hard cap: MAX_BATCH_KEYS = 1 000)
}
```

Construct with `TtlBounds::new(min_age, max_age, max_keys)` or the preset `TtlBounds::renewal()`, then call `validate()` before sweeping to catch inverted windows or zero/oversized key counts.

| Method | Description |
|--------|-------------|
| `TtlBounds::new(min_age, max_age, max_keys)` | Explicit constructor |
| `TtlBounds::renewal()` | Defaults that mirror `needs_touch` (`min_age = RENEWAL_THRESHOLD`) |
| `validate() -> Result<(), BoundsError>` | Rejects inverted windows, zero `max_keys`, or `max_keys > MAX_BATCH_KEYS` |
| `contains(age) -> bool` | Returns `true` if `age` falls inside `[min_age, max_age]` |
| `clamp_limit(limit) -> Result<u32, BoundsError>` | Clamps `limit` to `max_keys`; propagates validation errors |

---

### `should_extend(last_touched, current_ledger, bounds) -> bool`

Return `true` when an entry's age falls within the bounds window (meaning it is old enough to need a touch but not so old it has already been skipped).

| Parameter | Type | Description |
|-----------|------|-------------|
| `last_touched` | `u32` | Ledger sequence when the entry was last written |
| `current_ledger` | `u32` | Current ledger sequence (`env.ledger().sequence()`) |
| `bounds` | `&TtlBounds` | Age window configuration |

Equivalent to `bounds.contains(age_ledgers(last_touched, current_ledger))`.

---

### `bounded_range(start_id, limit, bounds, end_exclusive) -> Result<Range<u32>, BoundsError>`

Return the `Range<u32>` of IDs a sweep may visit, clipped to `bounds.max_keys` and `end_exclusive`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `start_id` | `u32` | First ID to include |
| `limit` | `u32` | Caller-requested number of IDs |
| `bounds` | `&TtlBounds` | Bounds to enforce |
| `end_exclusive` | `u32` | Hard upper bound (e.g. `next_talos_id`) |

Returns `BoundsError` for invalid bounds; a valid request never causes an unbounded sweep.

---

### `needs_touch(last_touched, current_ledger) -> bool`

Convenience helper — returns `true` when `current_ledger - last_touched >= RENEWAL_THRESHOLD`.

---

### `age_ledgers(last_touched, current_ledger) -> u32`

Compute the age of an entry: `current_ledger.saturating_sub(last_touched)`.

---

### `KeyHealth` (struct)

Accumulator for storage health scans. Call `observe(age)` for each scanned entry, then inspect the aggregated fields.

```rust
pub struct KeyHealth {
    pub min_age: u32,
    pub max_age: u32,
    pub keys_below_warn: u32,   // count of entries at or above WARN_THRESHOLD
    pub keys_below_crit: u32,   // count of entries at or above CRITICAL_THRESHOLD
    pub total_keys: u32,
}
```

| Method | Description |
|--------|-------------|
| `KeyHealth::empty()` | Zero-initialised accumulator |
| `observe(age)` | Fold one entry's age into the accumulator |
| `is_empty() -> bool` | `true` when no entries have been observed |
| `needs_immediate_attention() -> bool` | `true` when `keys_below_crit > 0` |

---

### `BatchSweep` (struct)

Accumulator tracking the outcome of a bounded batch sweep. Record each entry with `record(EntryOutcome)`, then call `emit(env)` to publish a `ttl_batch` event.

| `EntryOutcome` variant | Meaning |
|------------------------|---------|
| `Touched` | Entry existed and was re-written (TTL bumped) |
| `Skipped` | Entry existed but fell outside the bounds window |
| `Absent` | No entry for this ID |

---

## Emitted Events

| Topic | Data | When |
|-------|------|------|
| `("ttl_touch",)` | `(class_name: String, keys_touched: u32)` | One or more entries touched |
| `("ttl_warn",)` | `(class_name: String, keys_below: u32, max_age: u32)` | Entries near expiry detected |
| `("ttl_batch",)` | `(total: u32, touched: u32, skipped: u32)` | After a batch sweep via `BatchSweep::emit` |

---

## Usage Snippet

```rust
use soroban_sdk::{contract, contractimpl, Env, Vec};
use ttl_manager::{
    TtlBounds, BatchSweep, EntryOutcome,
    bounded_range, should_extend, needs_touch,
    emit_ttl_touched,
};

#[contracttype]
pub enum DataKey {
    LastTouched(u32),   // tracks last-touched ledger for each record
    Record(u32),
}

#[contract]
pub struct MyContract;

#[contractimpl]
impl MyContract {
    /// Touch records that are old enough, within an operator-controlled window.
    /// Returns the number of records touched.
    pub fn sweep_ttl(e: Env, start_id: u32, limit: u32, next_id: u32) -> u32 {
        let bounds = TtlBounds::renewal();
        bounds.validate().expect("invalid bounds");

        let range = bounded_range(start_id, limit, &bounds, next_id)
            .expect("bounded_range failed");

        let current = e.ledger().sequence();
        let mut sweep = BatchSweep::empty();

        for id in range {
            let last: u32 = e.storage().persistent()
                .get(&DataKey::LastTouched(id))
                .unwrap_or(0);

            let outcome = if !should_extend(last, current, &bounds) {
                EntryOutcome::Skipped
            } else {
                // re-set triggers a TTL reset in Soroban v21
                let val: Option<u32> = e.storage().persistent().get(&DataKey::Record(id));
                if let Some(v) = val {
                    e.storage().persistent().set(&DataKey::Record(id), &v);
                    e.storage().persistent().set(&DataKey::LastTouched(id), &current);
                    EntryOutcome::Touched
                } else {
                    EntryOutcome::Absent
                }
            };
            sweep.record(outcome);
        }

        sweep.emit(&e);
        sweep.touched
    }
}
```

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `RENEWAL_THRESHOLD` | 2 000 000 | Default touch trigger (ledgers, ~116 days) |
| `WARN_THRESHOLD` | 2 000 000 | Warning level for health checks |
| `CRITICAL_THRESHOLD` | 3 500 000 | Critical level — archival imminent (~202 days) |
| `DEFAULT_MAX_BATCH_KEYS` | 200 | Default sweep key cap |
| `MAX_BATCH_KEYS` | 1 000 | Hard upper limit for `TtlBounds::max_keys` |

---

## Project Structure

```
contracts/ttl_manager/
├── Cargo.toml
└── src/
    └── lib.rs
```

---

## License

MIT
