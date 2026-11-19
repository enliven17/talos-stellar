//! Soroban storage TTL management helpers for TalosRegistry.

use soroban_sdk::Env;
use ttl_manager;

use crate::{DataKey, Talos};

/// Re-write a single Talos entry to reset its Soroban TTL if it has not
/// been touched recently.
///
/// Returns `true` if the write was performed, `false` if skipped.
///
/// # Panics
/// - `"Talos not found"` — `talos_id` does not exist.
pub(crate) fn touch_talos_inner(e: &Env, talos_id: u32) -> bool {
    let key = DataKey::Talos(talos_id);
    let talos: Talos = e.storage().persistent().get(&key).expect("Talos not found");

    let current_ledger = e.ledger().sequence();
    let last_touched: u32 = e
        .storage()
        .persistent()
        .get(&DataKey::LastTouched(talos_id))
        .unwrap_or(0);

    if ttl_manager::needs_touch(last_touched, current_ledger) {
        e.storage().persistent().set(&key, &talos);
        e.storage()
            .persistent()
            .set(&DataKey::LastTouched(talos_id), &current_ledger);
        ttl_manager::emit_ttl_touched(e, "talos", 1);
        true
    } else {
        false
    }
}

/// Shared bounded sweep behind `touch_batch` / `extend_ttl_batch`.
///
/// Re-writes each Talos in `range` when its age falls inside `bounds`,
/// refreshes the matching `LastTouched` marker, emits `ttl_batch`,
/// and returns `(touched, skipped)`.
pub(crate) fn sweep_talos_ttl(
    e: &Env,
    bounds: &ttl_manager::TtlBounds,
    range: core::ops::Range<u32>,
) -> (u32, u32) {
    let current_ledger = e.ledger().sequence();
    let mut sweep = ttl_manager::BatchSweep::empty();

    for id in range {
        let key = DataKey::Talos(id);
        let talos: Talos = match e.storage().persistent().get(&key) {
            Some(talos) => talos,
            None => {
                sweep.record(ttl_manager::EntryOutcome::Absent);
                continue;
            }
        };
        let last_touched: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::LastTouched(id))
            .unwrap_or(0);

        if ttl_manager::should_extend(last_touched, current_ledger, bounds) {
            e.storage().persistent().set(&key, &talos);
            e.storage()
                .persistent()
                .set(&DataKey::LastTouched(id), &current_ledger);
            sweep.record(ttl_manager::EntryOutcome::Touched);
        } else {
            sweep.record(ttl_manager::EntryOutcome::Skipped);
        }
    }

    sweep.emit(e);
    (sweep.touched, sweep.skipped)
}

/// Compute storage health by comparing per-entry ages against warn/crit
/// thresholds. Returns `(min_age, max_age, keys_below_warn, keys_below_crit, total)`.
/// Emits `ttl_warn` if any entry is at or below the critical threshold.
pub(crate) fn storage_health(e: &Env, next_id: u32) -> (u32, u32, u32, u32, u32) {
    let mut health = ttl_manager::KeyHealth::empty();
    let current_ledger = e.ledger().sequence();

    for id in 1..next_id {
        if e.storage().persistent().has(&DataKey::Talos(id)) {
            let last_touched: u32 = e
                .storage()
                .persistent()
                .get(&DataKey::LastTouched(id))
                .unwrap_or(0);
            health.observe(ttl_manager::age_ledgers(last_touched, current_ledger));
        }
    }

    if health.needs_immediate_attention() {
        ttl_manager::emit_ttl_warning(e, "talos", health.keys_below_crit, health.max_age);
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
