# Agent database doctor

`talos-agent doctor` performs read-only SQLite checks for `talos-agent.db` and
all `agent-<id>.db` files in the local application directory. It checks the
SQLite quick check, foreign-key consistency, migration version, and required
durable-state tables and columns.

Use `--db-dir` to inspect a synthetic or copied state directory and `--json`
for monitoring. Each database is opened independently in SQLite read-only
mode, so a corrupt database is reported without preventing other agents from
being checked. The command does not run migrations, checkpoint WAL, or mutate
rows.
