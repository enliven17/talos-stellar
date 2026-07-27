# Talos Prime Agent

Autonomous agent corporation runtime for Stellar GTM agents.

## Checkpoint Export and Inspection

The checkpoint CLI provides safe operator commands for exporting and inspecting an agent checkpoint without modifying the running agent or its SQLite database.

Exports are deterministic, size-bounded, and written atomically. Inspection supports both human-readable and JSON output while exposing only non-sensitive checkpoint metadata.

### Export a Checkpoint

```bash
talos-agent checkpoint export \
  --agent agent-1 \
  --output checkpoint.json
```

Available options:

* `--agent`: Agent identifier. Required.
* `--output`: Destination checkpoint file. Required.
* `--schema-version`: Checkpoint schema version. Defaults to `1`.
* `--max-size`: Maximum permitted output size in bytes. Defaults to 10 MiB.

The source database is opened using SQLite read-only mode with query-only enforcement. Export runs inside a consistent read transaction so all table counts come from one database snapshot, even when the agent is active.

The destination is written through a temporary file, flushed to disk, and atomically moved into place. Repeated exports to the same destination replace the previous file with a complete checkpoint and never leave partial output.

The command refuses to use the source agent database as the output path.

### Inspect a Checkpoint

Human-readable output:

```bash
talos-agent checkpoint inspect \
  --input checkpoint.json
```

JSON output:

```bash
talos-agent checkpoint inspect \
  --input checkpoint.json \
  --json
```

Available options:

* `--input`: Checkpoint file to inspect. Required.
* `--json`: Return the summary as JSON.
* `--max-size`: Maximum permitted input size in bytes. Defaults to 10 MiB.

Inspection validates:

* JSON document structure
* Supported schema version
* Agent identifier format
* Recognised checkpoint table names
* Non-negative integer row counts
* Configured file-size bounds

### Checkpoint Contents

Checkpoint schema version `1` contains operator-safe metadata:

* Agent identifier
* Schema version
* Row counts for recognised agent-state tables

Stored row values are not included. This prevents the commands from exposing credentials, configuration values, generated content, job payloads, wallet details, transaction data, approval descriptions, or other sensitive information.

### Exit Codes

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| `0`  | Command completed successfully                                    |
| `2`  | Invalid arguments, invalid checkpoint data, or size-limit failure |
| `3`  | Unsupported checkpoint schema version                             |
| `4`  | Database, filesystem, or permission failure                       |

These exit codes are stable and may be used by shell scripts and operator tooling.

### Authorisation

Checkpoint access follows the local operating-system permission boundary.

The invoking user must have permission to:

* Read the selected agent database
* Read checkpoint files being inspected
* Write to the selected export directory

Permission failures produce a clear access-denied message and return exit code `4`.

### Deterministic Behaviour

* Concurrent exports never leave partial checkpoint files.
* Repeated exports of unchanged state produce identical checkpoint bytes.
* Interrupted exports remove temporary files and preserve any existing destination.
* Failed exports do not modify the source database or damage an existing checkpoint.
* Exported checkpoints remain inspectable across separate CLI invocations and process restarts.

Retry and network-timeout behaviour are not required because export and inspection operate only on bounded local SQLite and filesystem resources.

### Observability

A successful export prints the final checkpoint destination.

Validation, compatibility, permission, and I/O failures print a clear error message and return the corresponding stable exit code. Sensitive database values are never written to command output.

### Migration and Rollback

Checkpoint export does not initialise `LocalDB`, run migrations, change `PRAGMA user_version`, create database tables, or modify runtime state.

No database rollback procedure is required because the source operation is read-only. To remove an exported checkpoint, delete the generated file.

Failed or cancelled exports preserve the previous destination file and clean up temporary files automatically.

### Scope Boundaries

These commands provide the operator-facing export and inspection workflow for checkpoint schema version `1`.

Checkpoint restoration, encryption, remote storage, retention policies, and scheduled exports are separate lifecycle capabilities and are not performed by these commands.

### Implementation Files

* [`src/talos_agent/checkpoint_cli.py`](./src/talos_agent/checkpoint_cli.py) contains the checkpoint export and inspection commands, validation, atomic file handling, read-only database access, summary formatting, and stable exit-code handling.
* [`src/talos_agent/cli.py`](./src/talos_agent/cli.py) registers the `checkpoint` command group with the main `talos-agent` CLI.
* [`tests/test_checkpoint_cli.py`](./tests/test_checkpoint_cli.py) contains unit and real SQLite boundary tests covering successful exports, inspection, validation failures, permissions, size limits, concurrency, duplicate exports, cancellation, restart behaviour, and source-state protection.

## Database Migrations

This package implements an automated schema versioning and migration framework using SQLite's native `PRAGMA user_version` capability.

### How Schema Versioning Works

1. **Schema Version Tracking**: SQLite's native `PRAGMA user_version` integer is used to track the database schema version. Fresh databases start at version `0`.
2. **Ordered Migrations**: Migrations are registered in `_MIGRATIONS` inside [db.py](./src/talos_agent/db.py). They are ordered sequentially ascending by their version integer.
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

1. Update the migrations registry in [db.py](./src/talos_agent/db.py):
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

## Deployment

### Running the Docker Container

The container is configured to run as an unprivileged non-root user `talos` (UID 1000) for security hardening.

To build and run the Docker container locally:
```bash
# Build the image
docker build -t prime-agent .

# Run the container (which automatically runs as user 'talos')
docker run --rm prime-agent
```

