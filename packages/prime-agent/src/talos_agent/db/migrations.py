"""Database path helpers, schema migrations, and name validation.

This module is the single source of truth for the SQLite schema version
history.  ``LocalDB._run_migrations`` reads ``_MIGRATIONS`` at startup and
applies any pending entries in a single transaction.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from talos_agent.config import APP_DIR

DB_PATH = APP_DIR / "talos-agent.db"


def get_db_path(agent_id: str | None = None) -> Path:
    """Return per-agent DB path when running multi-agent, else default.

    Resolved lazily so tests (and ops tooling) can monkeypatch ``APP_DIR``
    to redirect ``get_db_path()`` without rewriting module-level constants.
    """
    if agent_id:
        return APP_DIR / f"agent-{agent_id}.db"
    return APP_DIR / "talos-agent.db"


def normalize_playbook_name(name: str) -> str:
    """Validate and normalize a playbook lookup name."""
    if not isinstance(name, str):
        raise ValueError("Playbook name must be a string")

    normalized_name = name.strip()
    if not normalized_name:
        raise ValueError("Playbook name cannot be empty")
    if len(normalized_name) > 200:
        raise ValueError("Playbook name must be 200 characters or fewer")
    if any(ord(char) < 32 for char in normalized_name):
        raise ValueError("Playbook name contains invalid control characters")

    return normalized_name


_MIGRATIONS: list[tuple[int, str]] = [
    (
        1,
        """
CREATE TABLE IF NOT EXISTS schedules (
    task_name   TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    content    TEXT NOT NULL,
    channel    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT NOT NULL,
    channel    TEXT NOT NULL,
    posted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commerce_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id          TEXT UNIQUE,
    talos_id       TEXT NOT NULL,
    service_type    TEXT NOT NULL,
    payload         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approval_cache (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id     TEXT UNIQUE,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    amount          REAL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spending_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    amount      REAL NOT NULL,
    currency    TEXT NOT NULL DEFAULT 'USDC',
    category    TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS talos_config (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playbooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    data        TEXT NOT NULL,
    source_talos TEXT,
    applied     INTEGER NOT NULL DEFAULT 0,
    purchased_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_performance (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id  INTEGER REFERENCES content_history(id),
    channel     TEXT NOT NULL,
    likes       INTEGER NOT NULL DEFAULT 0,
    reposts     INTEGER NOT NULL DEFAULT 0,
    replies     INTEGER NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    followers_at INTEGER NOT NULL DEFAULT 0,
    measured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_learnings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    insight     TEXT NOT NULL,
    evidence    TEXT,
    confidence  REAL NOT NULL DEFAULT 0.5,
    applied     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT
);

CREATE TABLE IF NOT EXISTS audience_insights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    segment     TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    engagement_score REAL NOT NULL DEFAULT 0.0,
    keywords    TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
        """,
    ),
    (
        2,
        "-- no-op example migration",
    ),
    (
        3,
        """
CREATE TABLE IF NOT EXISTS loans (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    platform        TEXT NOT NULL,
    amount          REAL NOT NULL,
    collateral_asset TEXT NOT NULL,
    loan_asset      TEXT NOT NULL,
    duration_days   INTEGER NOT NULL,
    purpose         TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    outstanding_amount REAL NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    due_date        TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loan_repayments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id         INTEGER NOT NULL REFERENCES loans(id),
    amount          REAL NOT NULL,
    tx_hash         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
CREATE INDEX IF NOT EXISTS idx_loans_due_date ON loans(due_date);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan_id ON loan_repayments(loan_id);
        """,
    ),
    (
        4,
        """
ALTER TABLE loans ADD COLUMN repayment_address TEXT;
        """,
    ),
    (
        5,
        """
CREATE TABLE IF NOT EXISTS dividends_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    spending_log_id     INTEGER REFERENCES spending_log(id),
    recipient_address   TEXT NOT NULL,
    token_symbol        TEXT NOT NULL,
    amount              REAL NOT NULL,
    currency            TEXT NOT NULL DEFAULT 'USDC',
    status              TEXT NOT NULL DEFAULT 'pending',
    tx_hash             TEXT,
    note                TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dividends_log_status ON dividends_log(status);
CREATE INDEX IF NOT EXISTS idx_dividends_log_recipient ON dividends_log(recipient_address);
        """,
    ),
    (
        6,
        """
CREATE TABLE IF NOT EXISTS retry_state (
    task_name       TEXT PRIMARY KEY,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    terminal        INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
        """,
    ),
    (
        7,
        """
CREATE TABLE IF NOT EXISTS checkpoint_keys (
    key_id       TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    namespace    TEXT NOT NULL DEFAULT '',
    key_hmac     TEXT NOT NULL,
    key_enc      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active', 'retired')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    retired_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_keys_agent_status
    ON checkpoint_keys(agent_id, status);
        """,
    ),
    (
        8,
        """
CREATE TABLE IF NOT EXISTS checkpoint_envelopes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id       TEXT NOT NULL REFERENCES checkpoint_keys(key_id),
    agent_id     TEXT NOT NULL,
    namespace    TEXT NOT NULL DEFAULT '',
    schema_ver   INTEGER NOT NULL DEFAULT 1,
    seq          INTEGER NOT NULL,
    ts           TEXT NOT NULL,
    nonce        TEXT NOT NULL UNIQUE,
    payload      TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_envelopes_agent_ns_seq
    ON checkpoint_envelopes(agent_id, namespace, seq);
        """,
    ),
    (
        9,
        """
CREATE TABLE IF NOT EXISTS claimed_jobs (
    job_id          TEXT PRIMARY KEY,
    fencing_token   INTEGER NOT NULL,
    claimed_at      TEXT NOT NULL DEFAULT (datetime('now')),
    lease_expires_at TEXT,
    ttl_seconds     INTEGER NOT NULL DEFAULT 300
);

CREATE TABLE IF NOT EXISTS completion_markers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id          TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    completed_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_completion_markers_job_id
    ON completion_markers(job_id);
CREATE INDEX IF NOT EXISTS idx_completion_markers_expires_at
    ON completion_markers(expires_at);
        """,
    ),
    (
        10,
        """
CREATE TABLE IF NOT EXISTS secret_versions (
    scope           TEXT NOT NULL,
    name            TEXT NOT NULL,
    version         INTEGER NOT NULL,
    ciphertext      TEXT NOT NULL,
    key_id          TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('staged', 'active', 'superseded', 'revoked')),
    request_id      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at    TEXT,
    revoked_at      TEXT,
    PRIMARY KEY (scope, name, version),
    UNIQUE (scope, name, request_id)
);

CREATE TABLE IF NOT EXISTS secret_heads (
    scope             TEXT NOT NULL,
    name              TEXT NOT NULL,
    active_version    INTEGER NOT NULL,
    previous_version  INTEGER,
    generation        INTEGER NOT NULL DEFAULT 1,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scope, name)
);

CREATE TABLE IF NOT EXISTS secret_audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT NOT NULL UNIQUE,
    scope       TEXT NOT NULL,
    name        TEXT NOT NULL,
    version     INTEGER,
    event_type  TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    actor       TEXT NOT NULL,
    reason      TEXT,
    metadata    TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS secret_rollback_checkpoints (
    scope              TEXT NOT NULL,
    name               TEXT NOT NULL,
    checkpoint_id      TEXT NOT NULL,
    active_version     INTEGER NOT NULL,
    previous_version   INTEGER,
    generation         INTEGER NOT NULL,
    request_id         TEXT NOT NULL,
    actor              TEXT NOT NULL,
    reason             TEXT,
    status             TEXT NOT NULL CHECK (status IN ('open', 'restored', 'discarded')),
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    restored_at        TEXT,
    discarded_at       TEXT,
    PRIMARY KEY (scope, name, checkpoint_id),
    UNIQUE (scope, name, request_id)
);

CREATE INDEX IF NOT EXISTS idx_secret_versions_status
    ON secret_versions(scope, name, status);
CREATE INDEX IF NOT EXISTS idx_secret_audit_lookup
    ON secret_audit_events(scope, name, id);
CREATE INDEX IF NOT EXISTS idx_secret_checkpoints_status
    ON secret_rollback_checkpoints(scope, name, status);
        """,
    ),
    (
        11,
        """
CREATE TABLE IF NOT EXISTS job_inbox (
    owner_talos_id         TEXT NOT NULL,
    job_id                 TEXT NOT NULL,
    requester_talos_id     TEXT,
    service_type           TEXT NOT NULL,
    payload_json           TEXT NOT NULL,
    payload_digest         TEXT NOT NULL,
    state                  TEXT NOT NULL DEFAULT 'received'
                           CHECK (state IN (
                               'received', 'claimed', 'effect_pending',
                               'completed', 'conflict'
                           )),
    fencing_token          INTEGER,
    remote_lease_expires_at TEXT,
    completed_at           TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (owner_talos_id, job_id)
);

CREATE TABLE IF NOT EXISTS job_effect_outbox (
    effect_id          TEXT PRIMARY KEY,
    owner_talos_id     TEXT NOT NULL,
    job_id             TEXT NOT NULL,
    effect_type        TEXT NOT NULL,
    deduplication_key  TEXT NOT NULL,
    result_json        TEXT NOT NULL,
    result_digest      TEXT NOT NULL,
    fencing_token      INTEGER NOT NULL,
    state              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (state IN (
                           'pending', 'dispatching', 'succeeded', 'retryable',
                           'indeterminate', 'conflict', 'dead'
                       )),
    attempt_count      INTEGER NOT NULL DEFAULT 0,
    next_attempt_at    TEXT NOT NULL,
    lease_owner        TEXT,
    lease_until        TEXT,
    last_error_code    TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (owner_talos_id, deduplication_key),
    FOREIGN KEY (owner_talos_id, job_id)
        REFERENCES job_inbox(owner_talos_id, job_id)
);

CREATE TABLE IF NOT EXISTS job_effect_replay_audit (
    audit_id        TEXT PRIMARY KEY,
    owner_talos_id  TEXT NOT NULL,
    effect_id       TEXT NOT NULL,
    job_id          TEXT NOT NULL,
    action          TEXT NOT NULL
                    CHECK (action IN (
                        'effect_prepared',
                        'dispatch_claimed',
                        'dispatch_succeeded',
                        'dispatch_reconciled',
                        'dispatch_failed',
                        'dispatch_conflict',
                        'operator_requeued'
                    )),
    from_state      TEXT,
    to_state        TEXT NOT NULL,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    error_code      TEXT,
    actor           TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_inbox_state
    ON job_inbox(owner_talos_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_job_effect_outbox_due
    ON job_effect_outbox(owner_talos_id, state, next_attempt_at, lease_until);
CREATE INDEX IF NOT EXISTS idx_job_effect_replay_audit_effect
    ON job_effect_replay_audit(owner_talos_id, effect_id, created_at);
CREATE INDEX IF NOT EXISTS idx_job_effect_replay_audit_job
    ON job_effect_replay_audit(owner_talos_id, job_id, created_at);
        """,
    ),
    (
        11,
        """
CREATE TABLE IF NOT EXISTS telegram_send_queue (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key          TEXT UNIQUE,
    chat_id             TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('post', 'reply')),
    text                TEXT NOT NULL,
    reply_to_message_id INTEGER,
    state               TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'indeterminate')),
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     REAL NOT NULL,
    last_attempt_at     REAL,
    lease_expires_at    REAL,
    message_id          INTEGER,
    last_error_code     TEXT,
    created_at          REAL NOT NULL,
    updated_at          REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_rate_state (
    chat_id       TEXT PRIMARY KEY,
    blocked_until REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_send_queue_state
    ON telegram_send_queue(state, id);
CREATE INDEX IF NOT EXISTS idx_telegram_send_queue_attempts
    ON telegram_send_queue(chat_id, last_attempt_at);
        """,
    ),
    (
        12,
        """
CREATE TABLE IF NOT EXISTS adapter_invocations (
    operation_id       TEXT PRIMARY KEY,
    adapter_name       TEXT NOT NULL,
    operation          TEXT NOT NULL,
    input_digest       TEXT NOT NULL,
    state              TEXT NOT NULL CHECK (
        state IN ('running', 'succeeded', 'failed', 'indeterminate')
    ),
    owner_id           TEXT NOT NULL,
    lease_expires_at   TEXT NOT NULL,
    attempt_count      INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_adapter_invocations_state_lease
    ON adapter_invocations(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS replay_sessions (
    session_id    TEXT PRIMARY KEY,
    talos_id      TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    status        TEXT NOT NULL DEFAULT 'recording',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS replay_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES replay_sessions(session_id),
    event_id     TEXT NOT NULL UNIQUE,
    event_type   TEXT NOT NULL,
    payload      TEXT NOT NULL,
    redacted     INTEGER NOT NULL DEFAULT 0,
    recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_replay_events_session ON replay_events(session_id);
        """,
    ),
    (
        13,
        """
CREATE TABLE IF NOT EXISTS cycle_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    talos_id        TEXT NOT NULL DEFAULT '',
    cycle_id        TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT NOT NULL,
    duration_ms     REAL NOT NULL DEFAULT 0,
    tool_calls      INTEGER NOT NULL DEFAULT 0,
    tool_names      TEXT NOT NULL DEFAULT '[]',
    error_type      TEXT,
    error_category  TEXT,
    outcome         TEXT NOT NULL DEFAULT 'completed',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cycle_summaries_talos_id
    ON cycle_summaries(talos_id, created_at DESC);
        """,
    ),
]


def run_migrations(
    conn: "sqlite3.Connection",
    migrations: "list[tuple[int, str]] | None" = None,
) -> None:
    """Run all pending migrations against *conn* in a single transaction.

    ``migrations`` defaults to the module-level ``_MIGRATIONS`` list.  Pass a
    custom list (or monkeypatch ``talos_agent.db._MIGRATIONS``) to control
    which migrations are applied during testing.
    """
    import talos_agent.db as _db_pkg  # late import avoids circular dep at module load

    migration_list = migrations if migrations is not None else _db_pkg._MIGRATIONS

    cursor = conn.cursor()
    cursor.execute("PRAGMA user_version;")
    current_version = cursor.fetchone()[0]

    pending = [m for m in migration_list if m[0] > current_version]
    if not pending:
        return

    try:
        conn.execute("BEGIN TRANSACTION;")
        for version, sql in pending:
            statements = []
            current: list[str] = []
            for line in sql.splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("--"):
                    continue
                current.append(line)
                joined = "\n".join(current)
                if sqlite3.complete_statement(joined):
                    statements.append(joined)
                    current = []

            if current:
                remaining = "\n".join(current).strip()
                if remaining:
                    statements.append(remaining)

            for stmt in statements:
                cursor.execute(stmt)

        latest_version = pending[-1][0]
        cursor.execute(f"PRAGMA user_version = {latest_version};")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
