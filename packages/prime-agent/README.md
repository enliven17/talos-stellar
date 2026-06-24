# Talos Prime Agent

Autonomous agent corporation runtime for Stellar GTM agents.

## Database Migrations

This package implements an automated schema versioning and migration framework using SQLite's native `PRAGMA user_version` capability.

### How Schema Versioning Works

1. **Schema Version Tracking**: SQLite's native `PRAGMA user_version` integer is used to track the database schema version. Fresh databases start at version `0`.
2. **Ordered Migrations**: Migrations are registered in `_MIGRATIONS` inside [db.py](file:///home/gamp/drips/talos-stellar/packages/prime-agent/src/talos_agent/db.py). They are ordered sequentially ascending by their version integer.
3. **Automatic Upgrades**: When a `LocalDB` connection is initialized:
   - The current `user_version` is checked.
   - Any migrations in `_MIGRATIONS` with a version greater than `user_version` are run sequentially.
   - The run is wrapped in a single database transaction. If any migration fails, the entire transaction is rolled back, leaving `user_version` and the database schema unchanged.
   - Once all pending migrations execute successfully, `PRAGMA user_version` is set to the latest version, and the transaction commits.

### How to Add a Migration

When modifying the SQLite database schema, follow these rules:

1. **Never modify old migrations**: Once a migration version is committed, its SQL script must not be changed.
2. **Always append new migrations**: Add new schema updates to the end of the `_MIGRATIONS` registry.
3. **Increment the version number**: The version of the new migration must be strictly greater than the previous version.
4. **Add tests**: When introducing a new migration, add automated tests to verify the schema updates work correctly.

#### Example

To add a new column `confidence` to the `strategy_learnings` table:

```python
_MIGRATIONS.append(
    (
        5,
        '''
        ALTER TABLE strategy_learnings
        ADD COLUMN confidence REAL DEFAULT 0;
        '''
    )
)
```

### Example Workflow

1. Update the migrations registry in [db.py](file:///home/gamp/drips/talos-stellar/packages/prime-agent/src/talos_agent/db.py):
   ```python
   _MIGRATIONS = [
       (1, "..."),
       (2, "-- no-op example migration"),
       (3, """
       ALTER TABLE approval_cache
       ADD COLUMN notes TEXT;
       """),
   ]
   ```
2. Run pytest to ensure all tests pass:
   ```bash
   pytest tests/
   ```
3. Deploy. The database will automatically upgrade on startup.
