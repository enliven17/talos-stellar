//! Storage schema migration logic for TalosRegistry.

use soroban_sdk::Env;
use storage_migration;

use crate::{DataKey, TimelockConfig, DEFAULT_GRACE_PERIOD, SCHEMA_GENESIS, SCHEMA_TIMELOCK_DEFAULTS};

/// Apply all pending migrations in order, returning the new schema version.
///
/// Idempotent: calling when already at the latest version is a no-op.
///
/// # Panics
/// - `"Migration out of order or already in progress"` — guard violation.
pub(crate) fn run_migrations_inner(e: &Env) -> u32 {
    let mut current = storage_migration::schema_version(e).unwrap_or(SCHEMA_GENESIS);

    // v1 → v2: backfill an explicit TimelockConfig default for instances
    // that were deployed before `set_timelock_config` was introduced.
    if current == SCHEMA_GENESIS {
        storage_migration::begin_migration(e, current, SCHEMA_GENESIS, SCHEMA_TIMELOCK_DEFAULTS)
            .unwrap_or_else(|_| panic!("Migration out of order or already in progress"));

        if !e.storage().persistent().has(&DataKey::TimelockConfig) {
            e.storage().persistent().set(
                &DataKey::TimelockConfig,
                &TimelockConfig {
                    min_delay: 0,
                    grace_period: DEFAULT_GRACE_PERIOD,
                },
            );
        }

        storage_migration::complete_migration(e, SCHEMA_GENESIS, SCHEMA_TIMELOCK_DEFAULTS);
        current = SCHEMA_TIMELOCK_DEFAULTS;
    }

    current
}
