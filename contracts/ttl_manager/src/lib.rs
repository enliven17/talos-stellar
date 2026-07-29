//! ttl_manager — Storage TTL tracking for Talos Protocol Soroban contracts.
//!
//! ## How it works
//!
//! Soroban persistent storage entries carry a Time-To-Live (TTL) measured in
//! ledgers (~5 s per ledger).  When TTL reaches 0 the entry is **archived**.
//!
//! In soroban-sdk v21.0.0, `get_ttl()` / `extend_ttl()` are **not** available
//! in production builds.  However **every `set()` call on a persistent entry
//! automatically resets its TTL to the maximum**.  This crate exploits that
//! behaviour:
//!
//! 1. Each contract tracks `last_touched` (ledger sequence) per key via a
//!    dedicated `DataKey` variant.
//! 2. `touch` entrypoints re-read the current value and `set()` it back —
//!    this is a no-op on the data but bumps the Soroban TTL.
//! 3. `get_storage_health` compares `current_ledger - last_touched` against
//!    warning / critical thresholds.
//!
//! ## Thresholds
//!
//! | Threshold | Ledgers | Wall-clock | Meaning |
//! |-----------|---------|------------|---------|
//! | WARN      | 2 000 000 | ~116 days | Entry should be touched soon |
//! | CRITICAL  | 3 500 000 | ~202 days | Entry is at risk of archival |
//! | MAX_TTL   | ~4 100 000 | ~237 days | Soroban's default maximum TTL |
//!
//! ## Events
//!
//! | Event       | Topic         | Data |
//! |-------------|---------------|------|
//! | `ttl_touch` | `(symbol,)`   | `(class_name: String, keys_touched: u32)` |
//! | `ttl_warn`  | `(symbol,)`   | `(class_name: String, keys_below: u32, max_age: u32)` |
//! | `ttl_batch` | `(symbol,)`   | `(total: u32, touched: u32, skipped: u32)` |

#![no_std]

#[cfg(all(test, not(target_arch = "wasm32")))]
extern crate std;

use soroban_sdk::{symbol_short, Env};

// ── Thresholds (ledgers) ────────────────────────────────────────────

/// Renewal threshold: touch entries whose age exceeds this (~116 days).
pub const RENEWAL_THRESHOLD: u32 = 2_000_000;

/// Warning threshold for health checks (~116 days).
pub const WARN_THRESHOLD: u32 = 2_000_000;

/// Critical threshold (~202 days).  Archival is imminent.
pub const CRITICAL_THRESHOLD: u32 = 3_500_000;

// ── Storage Health ──────────────────────────────────────────────────

/// Accumulator for storage health scans.
///
/// Use `KeyHealth::empty()` to start, then `observe(age_in_ledgers)` for
/// each scanned key.  The `age` is `current_ledger - last_touched_ledger`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyHealth {
    pub min_age: u32,
    pub max_age: u32,
    pub keys_below_warn: u32,
    pub keys_below_crit: u32,
    pub total_keys: u32,
}

impl KeyHealth {
    pub const fn empty() -> Self {
        Self {
            min_age: u32::MAX,
            max_age: 0,
            keys_below_warn: 0,
            keys_below_crit: 0,
            total_keys: 0,
        }
    }

    /// Fold a single key's age into the accumulator.
    pub fn observe(&mut self, age: u32) {
        if age < self.min_age {
            self.min_age = age;
        }
        if age > self.max_age {
            self.max_age = age;
        }
        if age >= WARN_THRESHOLD {
            self.keys_below_warn += 1;
        }
        if age >= CRITICAL_THRESHOLD {
            self.keys_below_crit += 1;
        }
        self.total_keys += 1;
    }

    pub fn is_empty(&self) -> bool {
        self.total_keys == 0
    }

    pub fn needs_immediate_attention(&self) -> bool {
        self.keys_below_crit > 0
    }
}

// ── Events ──────────────────────────────────────────────────────────

/// Emit `ttl_touch` when one or more entries are touched.
pub fn emit_ttl_touched(env: &Env, class_name: &str, keys_touched: u32) {
    let topics = (symbol_short!("ttl_touch"),);
    let name = soroban_sdk::String::from_str(env, class_name);
    env.events().publish(topics, (name, keys_touched));
}

/// Emit `ttl_warn` when entries are at risk.
pub fn emit_ttl_warning(env: &Env, class_name: &str, keys_below: u32, max_age: u32) {
    let topics = (symbol_short!("ttl_warn"),);
    let name = soroban_sdk::String::from_str(env, class_name);
    env.events().publish(topics, (name, keys_below, max_age));
}

/// Emit `ttl_batch` after batch maintenance.
pub fn emit_ttl_batch(env: &Env, total: u32, touched: u32, skipped: u32) {
    let topics = (symbol_short!("ttl_batch"),);
    env.events().publish(topics, (total, touched, skipped));
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Return `true` when `current_ledger - last_touched >= RENEWAL_THRESHOLD`,
/// signalling the entry should be touched.
pub fn needs_touch(last_touched: u32, current_ledger: u32) -> bool {
    current_ledger.saturating_sub(last_touched) >= RENEWAL_THRESHOLD
}

/// Compute the age of an entry in ledgers.
pub fn age_ledgers(last_touched: u32, current_ledger: u32) -> u32 {
    current_ledger.saturating_sub(last_touched)
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::*;

    #[test]
    fn key_health_empty_sentinels() {
        let h = KeyHealth::empty();
        assert_eq!(h.min_age, u32::MAX);
        assert_eq!(h.max_age, 0);
        assert_eq!(h.total_keys, 0);
        assert!(h.is_empty());
        assert!(!h.needs_immediate_attention());
    }

    #[test]
    fn key_health_observe_updates_bounds() {
        let mut h = KeyHealth::empty();

        h.observe(500_000);
        assert_eq!(h.min_age, 500_000);
        assert_eq!(h.max_age, 500_000);
        assert_eq!(h.total_keys, 1);
        assert_eq!(h.keys_below_warn, 0);
        assert_eq!(h.keys_below_crit, 0);

        h.observe(3_600_000);
        assert_eq!(h.min_age, 500_000);
        assert_eq!(h.max_age, 3_600_000);
        assert_eq!(h.total_keys, 2);
        assert_eq!(h.keys_below_warn, 1);
        assert_eq!(h.keys_below_crit, 1);
        assert!(h.needs_immediate_attention());
    }

    #[test]
    fn needs_touch_below_threshold() {
        assert!(!needs_touch(1_500_000, 3_000_000)); // age = 1.5M < 2M
        assert!(needs_touch(500_000, 2_500_001)); // age >= 2M
    }

    #[test]
    fn age_ledgers_computes_correctly() {
        assert_eq!(age_ledgers(100, 200), 100);
        assert_eq!(age_ledgers(200, 100), 0); // saturating
    }

    // ── Ledger-boundary & resource-exhaustion tests ────────────────

    #[test]
    fn key_health_single_key_at_extremes() {
        let mut h = KeyHealth::empty();

        // Age 0 should update bounds correctly
        h.observe(0);
        assert_eq!(h.min_age, 0);
        assert_eq!(h.max_age, 0);
        assert_eq!(h.total_keys, 1);
        assert_eq!(h.keys_below_warn, 0);
        assert_eq!(h.keys_below_crit, 0);
        assert!(!h.needs_immediate_attention());
    }

    #[test]
    fn key_health_max_age() {
        let mut h = KeyHealth::empty();
        h.observe(u32::MAX);
        assert_eq!(h.min_age, u32::MAX);
        assert_eq!(h.max_age, u32::MAX);
        assert_eq!(h.keys_below_warn, 1);
        assert_eq!(h.keys_below_crit, 1);
    }

    #[test]
    fn key_health_multiple_keys_mixed_ages() {
        let mut h = KeyHealth::empty();

        // Below all thresholds
        h.observe(1_000_000);
        // At WARN but below CRITICAL
        h.observe(2_000_000);
        // Above CRITICAL
        h.observe(3_500_000);

        assert_eq!(h.min_age, 1_000_000);
        assert_eq!(h.max_age, 3_500_000);
        assert_eq!(h.total_keys, 3);
        assert_eq!(h.keys_below_warn, 2); // 2_000_000 and 3_500_000
        assert_eq!(h.keys_below_crit, 1); // only 3_500_000
        assert!(h.needs_immediate_attention());
    }

    #[test]
    fn needs_touch_exactly_at_threshold() {
        // age = 2_000_000 exactly (last_touched=0, current=2_000_000)
        assert!(needs_touch(0, 2_000_000));
    }

    #[test]
    fn needs_touch_just_below_threshold() {
        // age = 1_999_999 (last_touched=0, current=1_999_999)
        assert!(!needs_touch(0, 1_999_999));
    }

    #[test]
    fn needs_touch_just_above_threshold() {
        // age = 2_000_001
        assert!(needs_touch(0, 2_000_001));
    }

    #[test]
    fn needs_touch_last_touched_zero() {
        // last_touched=0 means entry has never been touched
        assert!(needs_touch(0, 2_000_000));
        assert!(!needs_touch(0, 1_000_000));
    }

    #[test]
    fn age_ledgers_saturating_when_last_greater_than_current() {
        // last_touched > current_ledger should saturate to 0
        assert_eq!(age_ledgers(1_000_000, 500_000), 0);
        assert_eq!(age_ledgers(u32::MAX, 0), 0);
    }

    #[test]
    fn age_ledgers_max_delta() {
        // Maximum possible age: current=u32::MAX, last_touched=0
        assert_eq!(age_ledgers(0, u32::MAX), u32::MAX);
    }

    #[test]
    fn key_health_no_critical_when_below_threshold() {
        let mut h = KeyHealth::empty();

        // All keys just below CRITICAL
        h.observe(3_499_999);
        h.observe(3_499_999);

        assert_eq!(h.keys_below_warn, 2);
        assert_eq!(h.keys_below_crit, 0);
        assert!(!h.needs_immediate_attention());
    }

    #[test]
    fn key_health_exactly_at_critical() {
        let mut h = KeyHealth::empty();
        h.observe(3_500_000);

        assert_eq!(h.keys_below_crit, 1);
        assert!(h.needs_immediate_attention());
    }

    #[test]
    fn key_health_large_observation_count() {
        // Verify accumulator handles many observations without overflow
        let mut h = KeyHealth::empty();
        for _ in 0..10_000 {
            h.observe(500_000);
        }
        assert_eq!(h.total_keys, 10_000);
        assert_eq!(h.min_age, 500_000);
        assert_eq!(h.max_age, 500_000);
        assert_eq!(h.keys_below_warn, 0);
        assert_eq!(h.keys_below_crit, 0);
    }

    #[test]
    fn threshold_constants_are_ordered_correctly() {
        // RENEWAL_THRESHOLD must equal WARN_THRESHOLD by design
        assert_eq!(RENEWAL_THRESHOLD, WARN_THRESHOLD);
        // CRITICAL must be greater than WARN
        assert!(CRITICAL_THRESHOLD > WARN_THRESHOLD);
    }
}
