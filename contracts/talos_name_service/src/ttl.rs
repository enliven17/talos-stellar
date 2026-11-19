//! TTL management functions for TalosNameService name records.

use soroban_sdk::Env;
use ttl_manager;

use super::types::DataKey;

/// Touch a name record and its reverse mapping to reset Soroban TTL.
pub fn touch_name(e: &Env, name: soroban_sdk::String) -> bool {
    let key = DataKey::NameRecord(name.clone());
    let talos_id: u32 = e.storage().persistent().get(&key).expect("Name not found");
    let current_ledger = e.ledger().sequence();
    let last_touched: u32 = e
        .storage()
        .persistent()
        .get(&DataKey::LastTouched(talos_id))
        .unwrap_or(0);

    if ttl_manager::needs_touch(last_touched, current_ledger) {
        e.storage().persistent().set(&key, &talos_id);
        // Touch reverse mapping too
        let rev_key = DataKey::TalosName(talos_id);
        if let Some(n) = e.storage().persistent().get::<_, soroban_sdk::String>(&rev_key) {
            e.storage().persistent().set(&rev_key, &n);
        }
        e.storage()
            .persistent()
            .set(&DataKey::LastTouched(talos_id), &current_ledger);
        ttl_manager::emit_ttl_touched(&e, "name_record", 2);
        true
    } else {
        false
    }
}

/// Shared bounded sweep behind `touch_all_ttl` / `extend_ttl_batch`.
///
/// Re-writes the forward and reverse mapping for every talos id in `range`
/// whose age falls inside `bounds`, refreshes the `LastTouched` marker, and
/// returns the accumulator. Ids without a name record are neither touched
/// nor skipped. Callers emit their own `ttl_batch` event: `touch_all_ttl`
/// keeps its historical `(touched, touched, 0)` payload, while
/// `extend_ttl_batch` reports `(total, touched, skipped)`.
pub fn sweep_name_records(
    e: &Env,
    bounds: &ttl_manager::TtlBounds,
    range: core::ops::Range<u32>,
) -> ttl_manager::BatchSweep {
    let current_ledger = e.ledger().sequence();
    let mut sweep = ttl_manager::BatchSweep::empty();

    for tid in range {
        let name: soroban_sdk::String = match e
            .storage()
            .persistent()
            .get::<_, soroban_sdk::String>(&DataKey::TalosName(tid))
        {
            Some(name) => name,
            None => {
                sweep.record(ttl_manager::EntryOutcome::Absent);
                continue;
            }
        };
        let last_touched: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::LastTouched(tid))
            .unwrap_or(0);

        if ttl_manager::should_extend(last_touched, current_ledger, bounds) {
            let name_key = DataKey::NameRecord(name.clone());
            if let Some(rec_id) = e.storage().persistent().get::<_, u32>(&name_key) {
                e.storage().persistent().set(&name_key, &rec_id);
            }
            e.storage()
                .persistent()
                .set(&DataKey::TalosName(tid), &name);
            e.storage()
                .persistent()
                .set(&DataKey::LastTouched(tid), &current_ledger);
            sweep.record(ttl_manager::EntryOutcome::Touched);
        } else {
            sweep.record(ttl_manager::EntryOutcome::Skipped);
        }
    }

    sweep
}

/// Query storage health by scanning name records for tracked talos IDs.
///
/// `max_talos_id` is the upper bound of talos IDs to scan (e.g. from the
/// registry's `next_talos_id`). Returns `(min_age, max_age, keys_below_warn,
/// keys_below_crit, total)`. Emits `ttl_warn` if any entry is at risk.
pub fn get_storage_health(e: &Env, max_talos_id: u32) -> (u32, u32, u32, u32, u32) {
    let mut health = ttl_manager::KeyHealth::empty();
    let current_ledger = e.ledger().sequence();

    for tid in 1..=max_talos_id {
        if e.storage().persistent().has(&DataKey::TalosName(tid)) {
            let last_touched: u32 = e
                .storage()
                .persistent()
                .get(&DataKey::LastTouched(tid))
                .unwrap_or(0);
            health.observe(ttl_manager::age_ledgers(last_touched, current_ledger));
        }
    }

    if health.needs_immediate_attention() {
        ttl_manager::emit_ttl_warning(
            &e,
            "name_record",
            health.keys_below_crit,
            health.max_age,
        );
    }
    if health.is_empty() {
        (0, 0, 0, 0, 0)
    } else {
        (
            health.min_age,
            health.max_age,
            health.keys_below_warn,
            health.keys_below_crit,
            health.total_keys,
        )
    }
}
