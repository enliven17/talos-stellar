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
//! ## Batched extension with bounds
//!
//! Batch sweeps are bounded twice so a single call is predictable:
//!
//! 1. **Age window** — [`TtlBounds::min_age`] / [`TtlBounds::max_age`] decide
//!    which entries are eligible; anything outside the window is reported as
//!    `skipped` rather than silently written.
//! 2. **Work cap** — [`TtlBounds::max_keys`] caps how many ids one sweep may
//!    visit (see [`bounded_range`]).
//!
//! Invalid bounds fail loudly through [`TtlBounds::validate`] with static
//! [`BoundsError`] messages that never embed caller or storage data.
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

use core::ops::Range;

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

// ── Batched TTL Extension with Bounds ───────────────────────────────

/// Default cap on how many ids one bounded sweep may visit.
pub const DEFAULT_MAX_BATCH_KEYS: u32 = 200;

/// Hard upper bound for [`TtlBounds::max_keys`].  Bounds that ask for more
/// keys per call are rejected instead of silently clamped, so the caller
/// always learns that its sweep would exceed the per-transaction budget.
pub const MAX_BATCH_KEYS: u32 = 1_000;

/// Age window and work cap applied to a batched TTL extension sweep.
///
/// Construct bounds with [`TtlBounds::new`] (explicit caller input) or
/// [`TtlBounds::renewal`] (the defaults that mirror [`needs_touch`]), then
/// always call [`TtlBounds::validate`] once before sweeping.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TtlBounds {
    /// Entries younger than this age (ledgers) are skipped.
    pub min_age: u32,
    /// Entries older than this age (ledgers) are skipped.
    pub max_age: u32,
    /// Maximum number of ids a single sweep may visit.
    pub max_keys: u32,
}

/// Bounds that reject malformed batched-extension requests.
///
/// Messages are compile-time constants: they carry no caller, key, or
/// storage data, so a failed bounds check can never leak sensitive input.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoundsError {
    /// `min_age` is greater than `max_age` — the window can never match.
    InvertedAgeWindow,
    /// `max_keys` is zero — the sweep would visit nothing.
    ZeroMaxKeys,
    /// `max_keys` exceeds [`MAX_BATCH_KEYS`].
    MaxKeysTooLarge,
}

impl BoundsError {
    /// Static, privacy-safe diagnostic for this bounds violation.
    pub const fn message(&self) -> &'static str {
        match self {
            Self::InvertedAgeWindow => "ttl bounds: min_age exceeds max_age",
            Self::ZeroMaxKeys => "ttl bounds: max_keys must be greater than zero",
            Self::MaxKeysTooLarge => "ttl bounds: max_keys exceeds MAX_BATCH_KEYS",
        }
    }
}

impl TtlBounds {
    /// Build bounds from explicit caller-supplied values.
    pub const fn new(min_age: u32, max_age: u32, max_keys: u32) -> Self {
        Self {
            min_age,
            max_age,
            max_keys,
        }
    }

    /// Defaults: renew everything at or past [`RENEWAL_THRESHOLD`], capped at
    /// [`DEFAULT_MAX_BATCH_KEYS`] ids per sweep.  Identical decisions to
    /// [`needs_touch`], so existing callers keep their behaviour.
    pub const fn renewal() -> Self {
        Self {
            min_age: RENEWAL_THRESHOLD,
            max_age: u32::MAX,
            max_keys: DEFAULT_MAX_BATCH_KEYS,
        }
    }

    /// Reject malformed bounds before any storage is touched.
    pub fn validate(&self) -> Result<(), BoundsError> {
        if self.min_age > self.max_age {
            return Err(BoundsError::InvertedAgeWindow);
        }
        if self.max_keys == 0 {
            return Err(BoundsError::ZeroMaxKeys);
        }
        if self.max_keys > MAX_BATCH_KEYS {
            return Err(BoundsError::MaxKeysTooLarge);
        }
        Ok(())
    }

    /// `limit` clamped to this bound's `max_keys` (after [`Self::validate`]).
    pub fn clamp_limit(&self, limit: u32) -> Result<u32, BoundsError> {
        self.validate()?;
        Ok(limit.min(self.max_keys))
    }

    /// `true` when `age` falls inside `[min_age, max_age]`.
    pub fn contains(&self, age: u32) -> bool {
        age >= self.min_age && age <= self.max_age
    }
}

/// Decide whether an entry whose last touch is `last_touched` should be
/// extended, given `bounds`.
///
/// Generalises [`needs_touch`] over an explicit age window.  Bounds are **not**
/// re-validated here: call [`TtlBounds::validate`] once when the bounds are
/// admitted (contract entry-points do this before sweeping).
pub fn should_extend(last_touched: u32, current_ledger: u32, bounds: &TtlBounds) -> bool {
    bounds.contains(age_ledgers(last_touched, current_ledger))
}

/// Ids a bounded sweep may visit: `[start_id, end_exclusive)` clipped to
/// `limit` and then to `bounds.max_keys`.
///
/// Returns [`BoundsError`] for malformed bounds, so an invalid request never
/// reaches storage.
pub fn bounded_range(
    start_id: u32,
    limit: u32,
    bounds: &TtlBounds,
    end_exclusive: u32,
) -> Result<Range<u32>, BoundsError> {
    let capped = bounds.clamp_limit(limit)?;
    Ok(start_id..end_exclusive.min(start_id.saturating_add(capped)))
}

/// What happened to a single id during a sweep.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntryOutcome {
    /// Entry existed and was re-written (TTL bumped).
    Touched,
    /// Entry existed but fell outside the bounds window.
    Skipped,
    /// No entry for this id — ignored, matching historical sweeps.
    Absent,
}

/// Accumulator for a bounded batch sweep.
///
/// Feeds the `ttl_batch` event: `total` counts only ids that existed
/// (`Touched` + `Skipped`), `Absent` ids are not counted.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BatchSweep {
    pub total: u32,
    pub touched: u32,
    pub skipped: u32,
}

impl BatchSweep {
    pub const fn empty() -> Self {
        Self {
            total: 0,
            touched: 0,
            skipped: 0,
        }
    }

    /// Fold one id's outcome into the accumulator.
    pub fn record(&mut self, outcome: EntryOutcome) {
        match outcome {
            EntryOutcome::Touched => {
                self.total += 1;
                self.touched += 1;
            }
            EntryOutcome::Skipped => {
                self.total += 1;
                self.skipped += 1;
            }
            EntryOutcome::Absent => {}
        }
    }

    /// Emit the `ttl_batch` event for this sweep.
    pub fn emit(&self, env: &Env) {
        emit_ttl_batch(env, self.total, self.touched, self.skipped);
    }
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

    // ── Batched extension with bounds ────────────────────────────

    /// Regression: default bounds must make exactly the decisions that the
    /// long-standing `needs_touch` helper makes, so refactoring callers onto
    /// `should_extend` cannot change behaviour.
    #[test]
    fn renewal_bounds_match_needs_touch() {
        let bounds = TtlBounds::renewal();
        let pairs = [
            (0u32, 0u32),
            (0, 1_999_999),
            (0, 2_000_000),
            (0, 2_000_001),
            (500_000, 2_499_999),
            (500_000, 2_500_000),
            (1_000_000, 500_000),
            (u32::MAX, u32::MAX),
        ];
        for (last_touched, current) in pairs {
            assert_eq!(
                should_extend(last_touched, current, &bounds),
                needs_touch(last_touched, current),
                "mismatch at last_touched={last_touched}, current={current}"
            );
        }
    }

    #[test]
    fn should_extend_respects_min_age_boundary() {
        let bounds = TtlBounds::new(1_000, 10_000, DEFAULT_MAX_BATCH_KEYS);
        assert!(bounds.validate().is_ok());

        // age = 999 → one ledger below the window
        assert!(!should_extend(0, 999, &bounds));
        // age = 1000 → exactly at min_age (inclusive)
        assert!(should_extend(0, 1_000, &bounds));
        // age = 10_000 → exactly at max_age (inclusive)
        assert!(should_extend(0, 10_000, &bounds));
        // age = 10_001 → one ledger above the window
        assert!(!should_extend(0, 10_001, &bounds));
    }

    #[test]
    fn should_extend_uses_saturating_age() {
        // last_touched in the future must saturate to age 0, never wrap into
        // an in-window age.
        let bounds = TtlBounds::new(0, u32::MAX, DEFAULT_MAX_BATCH_KEYS);
        assert!(should_extend(1_000, 500, &bounds));
        let strict = TtlBounds::new(1, u32::MAX, DEFAULT_MAX_BATCH_KEYS);
        assert!(!should_extend(1_000, 500, &strict));
    }

    #[test]
    fn validate_accepts_renewal_defaults() {
        assert_eq!(TtlBounds::renewal().validate(), Ok(()));
        assert_eq!(TtlBounds::renewal().min_age, RENEWAL_THRESHOLD);
        assert_eq!(TtlBounds::renewal().max_age, u32::MAX);
        assert_eq!(TtlBounds::renewal().max_keys, DEFAULT_MAX_BATCH_KEYS);
        assert!(DEFAULT_MAX_BATCH_KEYS <= MAX_BATCH_KEYS);
    }

    #[test]
    fn validate_rejects_inverted_window() {
        let bounds = TtlBounds::new(5_000, 1_000, DEFAULT_MAX_BATCH_KEYS);
        assert_eq!(bounds.validate(), Err(BoundsError::InvertedAgeWindow));
        assert_eq!(
            bounds.validate().unwrap_err().message(),
            "ttl bounds: min_age exceeds max_age"
        );
    }

    #[test]
    fn validate_rejects_zero_max_keys() {
        let bounds = TtlBounds::new(0, u32::MAX, 0);
        assert_eq!(bounds.validate(), Err(BoundsError::ZeroMaxKeys));
        assert_eq!(
            bounds.validate().unwrap_err().message(),
            "ttl bounds: max_keys must be greater than zero"
        );
    }

    #[test]
    fn validate_rejects_max_keys_above_hard_cap() {
        let bounds = TtlBounds::new(0, u32::MAX, MAX_BATCH_KEYS + 1);
        assert_eq!(bounds.validate(), Err(BoundsError::MaxKeysTooLarge));
    }

    #[test]
    fn validate_accepts_exact_hard_cap() {
        let bounds = TtlBounds::new(0, u32::MAX, MAX_BATCH_KEYS);
        assert_eq!(bounds.validate(), Ok(()));
    }

    #[test]
    fn clamp_limit_caps_request_at_max_keys() {
        let bounds = TtlBounds::new(0, u32::MAX, 3);
        assert_eq!(bounds.clamp_limit(10), Ok(3));
        assert_eq!(bounds.clamp_limit(3), Ok(3));
        assert_eq!(bounds.clamp_limit(0), Ok(0));
    }

    #[test]
    fn clamp_limit_propagates_invalid_bounds() {
        let bounds = TtlBounds::new(10, 0, 0);
        // Inverted window is reported before the zero cap.
        assert_eq!(bounds.clamp_limit(5), Err(BoundsError::InvertedAgeWindow));
    }

    #[test]
    fn bounded_range_applies_limit_and_key_cap() {
        let bounds = TtlBounds::new(0, u32::MAX, 3);

        // limit above the key cap is clamped to 3 ids
        assert_eq!(bounded_range(1, 50, &bounds, 100), Ok(1..4));
        // limit below the key cap is honoured
        assert_eq!(bounded_range(1, 2, &bounds, 100), Ok(1..3));
        // end_exclusive clips the range when the domain is smaller
        assert_eq!(bounded_range(1, 50, &bounds, 2), Ok(1..2));
    }

    #[test]
    fn bounded_range_boundary_values() {
        let bounds = TtlBounds::renewal();

        // zero limit → empty sweep
        assert_eq!(bounded_range(1, 0, &bounds, 100), Ok(1..1));
        // start beyond the domain → empty sweep (end is clipped below start)
        let beyond = bounded_range(100, 10, &bounds, 50).unwrap();
        assert_eq!(beyond, 100..50);
        assert_eq!(beyond.count(), 0);
        // start at the last id must not overflow when adding the cap
        assert_eq!(
            bounded_range(u32::MAX - 1, 10, &bounds, u32::MAX),
            Ok((u32::MAX - 1)..u32::MAX)
        );
        // u32::MAX start with a large domain stays finite
        assert_eq!(
            bounded_range(u32::MAX, 10, &bounds, u32::MAX),
            Ok(u32::MAX..u32::MAX)
        );
    }

    #[test]
    fn bounded_range_rejects_malformed_bounds() {
        let bounds = TtlBounds::new(9_000, 100, 0);
        assert_eq!(
            bounded_range(1, 10, &bounds, 100),
            Err(BoundsError::InvertedAgeWindow)
        );
    }

    #[test]
    fn batch_sweep_records_outcomes() {
        let mut sweep = BatchSweep::empty();
        assert_eq!(sweep, BatchSweep::default());
        assert_eq!((sweep.total, sweep.touched, sweep.skipped), (0, 0, 0));

        sweep.record(EntryOutcome::Touched);
        sweep.record(EntryOutcome::Touched);
        sweep.record(EntryOutcome::Skipped);
        sweep.record(EntryOutcome::Absent);

        // Absent ids are not counted in `total`, matching legacy sweeps.
        assert_eq!((sweep.total, sweep.touched, sweep.skipped), (3, 2, 1));
    }

    #[test]
    fn batch_sweep_all_absent_stays_empty() {
        let mut sweep = BatchSweep::empty();
        for _ in 0..5 {
            sweep.record(EntryOutcome::Absent);
        }
        assert_eq!((sweep.total, sweep.touched, sweep.skipped), (0, 0, 0));
    }
}

// ── TTL near-expiration tests ────────────────────────────────────────────────
//
// These tests exercise the boundary between "healthy", "warn", and "critical"
// states and verify that the helpers behave correctly as an entry approaches
// its archival deadline.
//
// Test matrix
// ───────────
// needs_touch / age_ledgers
//   ├── one ledger below WARN           → should NOT touch
//   ├── exactly at WARN                 → MUST touch
//   ├── one ledger above WARN           → MUST touch
//   ├── exactly at CRITICAL             → MUST touch  +  immediate attention
//   ├── one ledger below CRITICAL       → MUST touch  (warn zone)
//   ├── last_touched = current_ledger   → age 0, no touch
//   ├── last_touched in the future      → saturates to 0, no touch
//   └── extreme: current = u32::MAX     → age = u32::MAX, must touch
//
// KeyHealth::observe
//   ├── single key at WARN-1            → no warn, no crit
//   ├── single key at WARN              → warn count increments
//   ├── single key at WARN+1            → warn count increments
//   ├── single key at CRIT-1            → warn only
//   ├── single key at CRIT              → warn + crit
//   └── progression from healthy → warn → crit over many observations
//
// should_extend with custom TtlBounds
//   ├── age exactly at custom min_age   → included
//   ├── age exactly at custom max_age   → included
//   ├── age below custom min_age        → excluded
//   └── age above custom max_age        → excluded
//
// Regression: behaviour is identical whether the caller uses needs_touch or
// should_extend(bounds = TtlBounds::renewal()) — covered in the existing
// `renewal_bounds_match_needs_touch` test above.

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod ttl_near_expiration_tests {
    use super::*;

    // ── needs_touch near WARN_THRESHOLD ───────────────────────────────────────

    #[test]
    fn needs_touch_one_below_warn() {
        // age = WARN_THRESHOLD - 1  → must NOT trigger a touch
        let current = WARN_THRESHOLD - 1;
        let last_touched = 0;
        assert!(!needs_touch(last_touched, current),
            "age {} should not require touch (threshold is {})", current, WARN_THRESHOLD);
    }

    #[test]
    fn needs_touch_exactly_at_warn() {
        // age = WARN_THRESHOLD exactly → touch must trigger
        let current = WARN_THRESHOLD;
        let last_touched = 0;
        assert!(needs_touch(last_touched, current),
            "age {} (== WARN_THRESHOLD) should require touch", current);
    }

    #[test]
    fn needs_touch_one_above_warn() {
        // age = WARN_THRESHOLD + 1 → touch must trigger
        let current = WARN_THRESHOLD + 1;
        let last_touched = 0;
        assert!(needs_touch(last_touched, current),
            "age {} should require touch", current);
    }

    // ── needs_touch near CRITICAL_THRESHOLD ───────────────────────────────────

    #[test]
    fn needs_touch_one_below_critical() {
        // age = CRITICAL - 1 → still in the warn zone, touch required
        let current = CRITICAL_THRESHOLD - 1;
        let last_touched = 0;
        assert!(needs_touch(last_touched, current),
            "age {} (just below CRITICAL) should still require touch", current);
    }

    #[test]
    fn needs_touch_exactly_at_critical() {
        // age = CRITICAL → touch required + immediate attention
        let current = CRITICAL_THRESHOLD;
        let last_touched = 0;
        assert!(needs_touch(last_touched, current),
            "age {} (== CRITICAL_THRESHOLD) should require touch", current);
    }

    #[test]
    fn needs_touch_one_above_critical() {
        // age = CRITICAL + 1 → archival imminent, touch required
        let current = CRITICAL_THRESHOLD + 1;
        let last_touched = 0;
        assert!(needs_touch(last_touched, current),
            "age {} (above CRITICAL) should require touch", current);
    }

    // ── age_ledgers boundary behaviour ────────────────────────────────────────

    #[test]
    fn age_at_exactly_warn_threshold() {
        // last_touched = 100, current = 100 + WARN_THRESHOLD
        let last_touched = 100_u32;
        let current = last_touched + WARN_THRESHOLD;
        assert_eq!(age_ledgers(last_touched, current), WARN_THRESHOLD,
            "age must equal WARN_THRESHOLD exactly");
    }

    #[test]
    fn age_at_exactly_critical_threshold() {
        let last_touched = 50_u32;
        let current = last_touched + CRITICAL_THRESHOLD;
        assert_eq!(age_ledgers(last_touched, current), CRITICAL_THRESHOLD,
            "age must equal CRITICAL_THRESHOLD exactly");
    }

    #[test]
    fn age_zero_when_last_touched_equals_current() {
        let ledger = 5_000_000_u32;
        assert_eq!(age_ledgers(ledger, ledger), 0,
            "entry touched in the same ledger must have age 0");
        assert!(!needs_touch(ledger, ledger),
            "entry touched this ledger must not require touch");
    }

    #[test]
    fn age_saturates_to_zero_for_future_last_touched() {
        // If last_touched > current_ledger (e.g., clock skew or test data),
        // age must saturate to 0 rather than wrapping.
        let last_touched = 3_000_000_u32;
        let current = 1_000_000_u32;
        assert_eq!(age_ledgers(last_touched, current), 0,
            "future last_touched must saturate to age 0");
        assert!(!needs_touch(last_touched, current),
            "future last_touched must not require touch");
    }

    #[test]
    fn age_at_u32_max_current_ledger() {
        // Extreme: current = u32::MAX, last_touched = 0 → age = u32::MAX
        assert_eq!(age_ledgers(0, u32::MAX), u32::MAX,
            "maximum possible age must be u32::MAX");
        assert!(needs_touch(0, u32::MAX),
            "maximum age must require touch");
    }

    // ── KeyHealth near-expiration observations ────────────────────────────────

    #[test]
    fn observe_one_ledger_below_warn_is_healthy() {
        let mut h = KeyHealth::empty();
        h.observe(WARN_THRESHOLD - 1);
        assert_eq!(h.keys_below_warn, 0, "age below WARN should not flag warn");
        assert_eq!(h.keys_below_crit, 0, "age below WARN should not flag crit");
        assert!(!h.needs_immediate_attention());
    }

    #[test]
    fn observe_exactly_at_warn_increments_warn_count() {
        let mut h = KeyHealth::empty();
        h.observe(WARN_THRESHOLD);
        assert_eq!(h.keys_below_warn, 1, "age == WARN_THRESHOLD should flag warn");
        assert_eq!(h.keys_below_crit, 0, "age == WARN_THRESHOLD should NOT flag crit");
        assert!(!h.needs_immediate_attention());
    }

    #[test]
    fn observe_one_above_warn_is_in_warn_zone() {
        let mut h = KeyHealth::empty();
        h.observe(WARN_THRESHOLD + 1);
        assert_eq!(h.keys_below_warn, 1);
        assert_eq!(h.keys_below_crit, 0);
    }

    #[test]
    fn observe_one_below_critical_is_warn_only() {
        // age = CRITICAL - 1: in the warn zone but NOT yet critical
        let mut h = KeyHealth::empty();
        h.observe(CRITICAL_THRESHOLD - 1);
        assert_eq!(h.keys_below_warn, 1, "age just below CRITICAL should still flag warn");
        assert_eq!(h.keys_below_crit, 0, "age just below CRITICAL should NOT flag crit");
        assert!(!h.needs_immediate_attention());
    }

    #[test]
    fn observe_exactly_at_critical_flags_both() {
        let mut h = KeyHealth::empty();
        h.observe(CRITICAL_THRESHOLD);
        assert_eq!(h.keys_below_warn, 1, "age == CRITICAL should flag warn");
        assert_eq!(h.keys_below_crit, 1, "age == CRITICAL should flag crit");
        assert!(h.needs_immediate_attention());
    }

    #[test]
    fn health_progression_across_thresholds() {
        // Simulate a scan that captures keys at every distinct health tier.
        let mut h = KeyHealth::empty();

        // Tier 1: healthy (below WARN)
        h.observe(100_000);
        h.observe(1_999_999);

        // Tier 2: warn zone (>= WARN, < CRIT)
        h.observe(WARN_THRESHOLD);
        h.observe(WARN_THRESHOLD + 500_000);
        h.observe(CRITICAL_THRESHOLD - 1);

        // Tier 3: critical zone (>= CRIT)
        h.observe(CRITICAL_THRESHOLD);
        h.observe(CRITICAL_THRESHOLD + 100_000);

        assert_eq!(h.total_keys, 7);
        assert_eq!(h.min_age, 100_000);
        assert_eq!(h.max_age, CRITICAL_THRESHOLD + 100_000);

        // 5 keys are at or above WARN (tiers 2 + 3)
        assert_eq!(h.keys_below_warn, 5,
            "5 keys should be in warn or critical zone");
        // 2 keys are at or above CRITICAL
        assert_eq!(h.keys_below_crit, 2,
            "2 keys should be in critical zone");
        assert!(h.needs_immediate_attention());
    }

    // ── should_extend with custom TtlBounds (near-expiration window) ──────────

    #[test]
    fn should_extend_custom_window_includes_boundary_ages() {
        // A window that targets only the near-expiration band:
        // min = WARN, max = CRITICAL (inclusive on both ends).
        let bounds = TtlBounds::new(WARN_THRESHOLD, CRITICAL_THRESHOLD, DEFAULT_MAX_BATCH_KEYS);
        assert!(bounds.validate().is_ok());

        // At the lower boundary
        assert!(should_extend(0, WARN_THRESHOLD, &bounds),
            "age == WARN_THRESHOLD must be in the near-expiration window");

        // Inside the window
        assert!(should_extend(0, WARN_THRESHOLD + 1, &bounds));
        assert!(should_extend(0, CRITICAL_THRESHOLD - 1, &bounds));

        // At the upper boundary
        assert!(should_extend(0, CRITICAL_THRESHOLD, &bounds),
            "age == CRITICAL_THRESHOLD must be in the near-expiration window");
    }

    #[test]
    fn should_extend_custom_window_excludes_outside_ages() {
        let bounds = TtlBounds::new(WARN_THRESHOLD, CRITICAL_THRESHOLD, DEFAULT_MAX_BATCH_KEYS);

        // One ledger below the window
        assert!(!should_extend(0, WARN_THRESHOLD - 1, &bounds),
            "age one below WARN should be outside the window");

        // One ledger above the window
        assert!(!should_extend(0, CRITICAL_THRESHOLD + 1, &bounds),
            "age one above CRITICAL should be outside the window");
    }

    // ── Regression: near-expiration does not affect healthy entries ───────────

    #[test]
    fn healthy_entry_is_never_touched_by_renewal_bounds() {
        // An entry touched 1 000 000 ledgers ago (well under WARN) must
        // not be selected by the default renewal sweep.
        let bounds = TtlBounds::renewal();
        let last_touched = 500_000_u32;
        let current = last_touched + 1_000_000;
        assert!(!should_extend(last_touched, current, &bounds),
            "healthy entry should not be touched by default renewal bounds");
    }

    #[test]
    fn near_expiration_entry_is_always_touched_by_renewal_bounds() {
        // An entry that has not been touched for WARN_THRESHOLD ledgers must
        // be selected by the default renewal sweep.
        let bounds = TtlBounds::renewal();
        let last_touched = 0_u32;
        let current = WARN_THRESHOLD;
        assert!(should_extend(last_touched, current, &bounds),
            "near-expiration entry must be touched by default renewal bounds");
    }

    // ── BatchSweep near-expiration scenarios ──────────────────────────────────

    #[test]
    fn batch_sweep_all_near_expiration_all_touched() {
        // Simulate a sweep that finds only near-expiration entries.
        let mut sweep = BatchSweep::empty();
        for _ in 0..5 {
            sweep.record(EntryOutcome::Touched);
        }
        assert_eq!(sweep.total, 5);
        assert_eq!(sweep.touched, 5);
        assert_eq!(sweep.skipped, 0);
    }

    #[test]
    fn batch_sweep_mixed_near_expiration_and_healthy() {
        // Simulate a sweep where some entries are healthy (skipped) and
        // some are near-expiration (touched).
        let mut sweep = BatchSweep::empty();

        // 3 near-expiration → touched
        for _ in 0..3 {
            sweep.record(EntryOutcome::Touched);
        }
        // 2 healthy → skipped (outside the age window)
        for _ in 0..2 {
            sweep.record(EntryOutcome::Skipped);
        }
        // 1 absent → not counted
        sweep.record(EntryOutcome::Absent);

        assert_eq!(sweep.total, 5, "total counts only existing entries");
        assert_eq!(sweep.touched, 3);
        assert_eq!(sweep.skipped, 2);
    }

    #[test]
    fn batch_sweep_single_critical_entry_is_counted() {
        // Verify that a single critical entry flowing through the sweep
        // produces a non-zero touched count in the accumulator.
        let mut sweep = BatchSweep::empty();
        sweep.record(EntryOutcome::Touched);
        assert_eq!(sweep.touched, 1);
        assert!(sweep.total > 0, "a critical touch must be counted in total");
    }

    // ── BoundsError messages are privacy-safe ─────────────────────────────────

    #[test]
    fn bounds_errors_contain_no_caller_data() {
        // The BoundsError messages are compile-time constants and must not
        // embed any run-time values (ages, ids, storage data).
        let messages = [
            BoundsError::InvertedAgeWindow.message(),
            BoundsError::ZeroMaxKeys.message(),
            BoundsError::MaxKeysTooLarge.message(),
        ];
        for msg in messages {
            // Each message must be a non-empty static string.
            assert!(!msg.is_empty(), "BoundsError message must not be empty");
            // Must not contain any numeric values from the test inputs.
            assert!(!msg.contains("5_000"),
                "BoundsError message must not embed caller values");
        }
    }
}
