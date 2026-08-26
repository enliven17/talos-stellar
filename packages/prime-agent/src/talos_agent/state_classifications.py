"""Registered classification inventory for all agent runtime state.

Every persistent or checkpoint-eligible field in the agent is listed here with
its classification category, sensitivity, retention, bounds, and restore
semantics.  This file is the single source of truth for state portability.

Schema
------
The ``_CLASSIFICATIONS`` dict is registered into the global
:mod:`~talos_agent.state_classify` registry at import time.  Any field that
appears in a checkpoint payload without a registered classification triggers a
:class:`~talos_agent.state_classify.ClassificationError`.
"""

from talos_agent.state_classify import (
    FieldClassification,
    StateCategory,
    register_field,
)

# ── Helper to reduce repetition ─────────────────────────────────────────────

def _r(
    category: StateCategory,
    sensitivity: str = "none",
    retention: str | None = None,
    bounds: str | None = None,
    restore: str | None = None,
    reason: str | None = None,
) -> FieldClassification:
    return FieldClassification(
        category=category,
        sensitivity=sensitivity,  # type: ignore[arg-type]
        retention=retention,
        bounds=bounds,
        restore_semantics=restore,
        reason=reason,
    )


# ─────────────────────────────────────────────────────────────────────────────
# SQLite tables (portable — included in checkpoint export/restore)
# ─────────────────────────────────────────────────────────────────────────────

# schedules — per-task last-run timestamps
register_field("schedules", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "ISO-8601 UTC, reset if >300s in future",
    "capped",
    "Task scheduling timestamps; safe to transfer. Clock-skew capped on restore.",
))
register_field("schedules.task_name", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "string, max 255 chars",
    "full",
    "Unique task identifier; safe to transfer.",
))
register_field("schedules.last_run_at", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "ISO-8601 UTC, reset if >300s future",
    "capped",
    "Last execution timestamp; clock-skew capped on restore.",
))

# activity_log — activity buffer
register_field("activity_log", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    None, "full",
    "Activity buffer for cross-node visibility; no secrets.",
))
register_field("activity_log.type", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("activity_log.content", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "max 4096 chars, no raw credentials",
    "full",
    "Safe to transfer; user-facing content must not contain secrets.",
))
register_field("activity_log.channel", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("activity_log.status", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "pending|sent", "full",
))
register_field("activity_log.created_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

# content_history — published content archive
register_field("content_history", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    None, "full",
    "Published content; safe for transfer. No unredacted tool output.",
))
register_field("content_history.content", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "no raw credentials, no unredacted tool output",
    "full",
))
register_field("content_history.channel", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("content_history.posted_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

# commerce_queue — purchased service queue
register_field("commerce_queue", _r(
    StateCategory.PORTABLE, "medium", "until_consumed",
    "no raw user payloads", "full",
    "Job queue for purchased services. Payload must be redacted before checkpoint.",
))
register_field("commerce_queue.job_id", _r(
    StateCategory.PORTABLE, "low", "until_consumed", None, "full",
))
register_field("commerce_queue.talos_id", _r(
    StateCategory.PORTABLE, "low", "until_consumed", None, "full",
))
register_field("commerce_queue.service_type", _r(
    StateCategory.PORTABLE, "low", "until_consumed", None, "full",
))
register_field("commerce_queue.payload", _r(
    StateCategory.PORTABLE, "medium", "until_consumed",
    "redacted; no raw user payloads",
    "full",
    "Must be redacted before checkpoint inclusion.",
))
register_field("commerce_queue.status", _r(
    StateCategory.PORTABLE, "low", "until_consumed",
    "pending|claimed|completed|failed", "full",
))
register_field("commerce_queue.created_at", _r(
    StateCategory.PORTABLE, "low", "until_consumed", None, "full",
))
register_field("commerce_queue.updated_at", _r(
    StateCategory.PORTABLE, "low", "until_consumed", None, "full",
))

# approval_cache — cached approvals
register_field("approval_cache", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    None, "full",
    "Approval records; no secrets.",
))
register_field("approval_cache.approval_id", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("approval_cache.type", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("approval_cache.title", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("approval_cache.description", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("approval_cache.amount", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "non-negative float", "full",
))
register_field("approval_cache.status", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "pending|approved|rejected", "full",
))
register_field("approval_cache.created_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("approval_cache.updated_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

# spending_log — go-to-market spend
register_field("spending_log", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    None, "full",
    "Financial spend records; no credentials.",
))
register_field("spending_log.amount", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "non-negative float", "full",
))
register_field("spending_log.currency", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("spending_log.category", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("spending_log.description", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("spending_log.created_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

# talos_config — configuration KV store
register_field("talos_config", _r(
    StateCategory.PORTABLE, "high", "permanent",
    "no keys, no credentials", "full",
    "Agent configuration. Values must not contain keys or credentials.",
))
register_field("talos_config.key", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "string key, no secrets in key name", "full",
))
register_field("talos_config.value", _r(
    StateCategory.PORTABLE, "high", "permanent",
    "no keys, no credentials, no tokens",
    "full",
    "Config values must be redacted for checkpoint. No secrets in values.",
))

# playbooks — GTM playbooks
register_field("playbooks", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    None, "full",
    "GTM strategy playbooks; safe to transfer.",
))
register_field("playbooks.name", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("playbooks.data", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "no credentials, redacted tool output",
    "full",
    "Playbook content must not contain raw credentials.",
))
register_field("playbooks.source_talos", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("playbooks.applied", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "0 or 1", "full",
))
register_field("playbooks.purchased_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

# content_performance — engagement metrics
register_field("content_performance", _r(
    StateCategory.PORTABLE, "low", "permanent",
    None, "full",
    "Aggregate engagement metrics; no PII.",
))
register_field("content_performance.likes", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "non-negative int", "full",
))
register_field("content_performance.reposts", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "non-negative int", "full",
))
register_field("content_performance.replies", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "non-negative int", "full",
))
register_field("content_performance.impressions", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "non-negative int", "full",
))
register_field("content_performance.followers_at", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "non-negative int", "full",
))
register_field("content_performance.measured_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

# strategy_learnings — ML learnings
register_field("strategy_learnings", _r(
    StateCategory.PORTABLE, "low", "temporary (30d TTL)",
    None, "full",
    "ML strategy learnings with TTL; no secrets.",
))
register_field("strategy_learnings.category", _r(
    StateCategory.PORTABLE, "low", "temporary (30d TTL)", None, "full",
))
register_field("strategy_learnings.insight", _r(
    StateCategory.PORTABLE, "low", "temporary (30d TTL)", None, "full",
))
register_field("strategy_learnings.evidence", _r(
    StateCategory.PORTABLE, "low", "temporary (30d TTL)", None, "full",
))
register_field("strategy_learnings.confidence", _r(
    StateCategory.PORTABLE, "low", "temporary (30d TTL)",
    "0.0 to 1.0", "full",
))
register_field("strategy_learnings.applied", _r(
    StateCategory.PORTABLE, "low", "temporary (30d TTL)",
    "0 or 1", "full",
))
register_field("strategy_learnings.created_at", _r(
    StateCategory.PORTABLE, "low", "temporary (30d TTL)", None, "full",
))
register_field("strategy_learnings.expires_at", _r(
    StateCategory.PORTABLE, "low", "temporary (30d TTL)",
    "ISO-8601 UTC; pruned on expiry", "pruned",
))

# audience_insights — audience segments
register_field("audience_insights", _r(
    StateCategory.PORTABLE, "low", "permanent",
    None, "full",
    "Aggregate audience analytics; no PII.",
))
register_field("audience_insights.segment", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("audience_insights.description", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("audience_insights.engagement_score", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "0.0 to 100.0", "full",
))
register_field("audience_insights.keywords", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("audience_insights.updated_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

# loans — active loans
register_field("loans", _r(
    StateCategory.PORTABLE, "high", "until_repaid",
    None, "full",
    "Financial loan records; no credentials.",
))
register_field("loans.platform", _r(
    StateCategory.PORTABLE, "low", "until_repaid", None, "full",
))
register_field("loans.amount", _r(
    StateCategory.PORTABLE, "high", "until_repaid",
    "non-negative float", "full",
))
register_field("loans.collateral_asset", _r(
    StateCategory.PORTABLE, "medium", "until_repaid", None, "full",
))
register_field("loans.loan_asset", _r(
    StateCategory.PORTABLE, "medium", "until_repaid", None, "full",
))
register_field("loans.duration_days", _r(
    StateCategory.PORTABLE, "low", "until_repaid",
    "positive int", "full",
))
register_field("loans.purpose", _r(
    StateCategory.PORTABLE, "low", "until_repaid", None, "full",
))
register_field("loans.status", _r(
    StateCategory.PORTABLE, "low", "until_repaid",
    "active|repaid|defaulted", "full",
))
register_field("loans.outstanding_amount", _r(
    StateCategory.PORTABLE, "high", "until_repaid",
    "non-negative float", "full",
))
register_field("loans.created_at", _r(
    StateCategory.PORTABLE, "low", "until_repaid", None, "full",
))
register_field("loans.due_date", _r(
    StateCategory.PORTABLE, "low", "until_repaid", None, "full",
))
register_field("loans.updated_at", _r(
    StateCategory.PORTABLE, "low", "until_repaid", None, "full",
))
register_field("loans.repayment_address", _r(
    StateCategory.PORTABLE, "high", "until_repaid",
    "Stellar public key (G...56 chars)",
    "full",
    "Public key — safe to transfer; not a secret.",
))

# loan_repayments — loan repayment history
register_field("loan_repayments", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    None, "full",
    "Repayment transaction records.",
))
register_field("loan_repayments.amount", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "non-negative float", "full",
))
register_field("loan_repayments.tx_hash", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "on-chain tx hash string", "full",
))
register_field("loan_repayments.created_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

# dividends_log — dividend distributions
register_field("dividends_log", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    None, "full",
    "Dividend distribution records.",
))
register_field("dividends_log.recipient_address", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "Stellar public key (G...56 chars)", "full",
))
register_field("dividends_log.token_symbol", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("dividends_log.amount", _r(
    StateCategory.PORTABLE, "medium", "permanent",
    "non-negative float", "full",
))
register_field("dividends_log.currency", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("dividends_log.status", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "pending|completed|failed", "full",
))
register_field("dividends_log.tx_hash", _r(
    StateCategory.PORTABLE, "medium", "permanent", None, "full",
))
register_field("dividends_log.note", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("dividends_log.created_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

# retry_state — durable backoff state
register_field("retry_state", _r(
    StateCategory.PORTABLE, "low", "until_resolved",
    None, "capped",
    "Backoff retry timestamps; capped on restore to prevent freezes.",
))
register_field("retry_state.task_name", _r(
    StateCategory.PORTABLE, "low", "until_resolved", None, "full",
))
register_field("retry_state.attempt_count", _r(
    StateCategory.PORTABLE, "low", "until_resolved",
    "non-negative int", "full",
))
register_field("retry_state.next_attempt_at", _r(
    StateCategory.PORTABLE, "low", "until_resolved",
    "ISO-8601 UTC; capped to +60s on restore",
    "capped",
    "Restored capped to now+60s to prevent frozen agents.",
))
register_field("retry_state.terminal", _r(
    StateCategory.PORTABLE, "low", "until_resolved",
    "0 or 1", "full",
))
register_field("retry_state.updated_at", _r(
    StateCategory.PORTABLE, "low", "until_resolved", None, "full",
))


# ─────────────────────────────────────────────────────────────────────────────
# claimed_jobs — fencing-token persistence (portable, reverified on restore)
# ─────────────────────────────────────────────────────────────────────────────

register_field("claimed_jobs", _r(
    StateCategory.PORTABLE, "high", "until_fulfilled_or_expired",
    None, "reverified",
    "Job fencing tokens. Restored only after API re-verification.",
))
register_field("claimed_jobs.job_id", _r(
    StateCategory.PORTABLE, "medium", "until_fulfilled_or_expired",
    None, "reverified",
))
register_field("claimed_jobs.fencing_token", _r(
    StateCategory.PORTABLE, "high", "until_fulfilled_or_expired",
    "non-negative int", "reverified",
    "Monotonic fencing token; verified via API heartbeat on restore.",
))
register_field("claimed_jobs.claimed_at", _r(
    StateCategory.PORTABLE, "low", "until_fulfilled_or_expired", None, "reverified",
))
register_field("claimed_jobs.lease_expires_at", _r(
    StateCategory.PORTABLE, "medium", "until_fulfilled_or_expired",
    "ISO-8601 UTC", "reverified",
))
register_field("claimed_jobs.ttl_seconds", _r(
    StateCategory.PORTABLE, "low", "until_fulfilled_or_expired",
    "positive int", "reverified",
))


# ─────────────────────────────────────────────────────────────────────────────
# completion_markers — idempotency log (portable, pruned on restore)
# ─────────────────────────────────────────────────────────────────────────────

register_field("completion_markers", _r(
    StateCategory.PORTABLE, "low", "7d TTL",
    None, "pruned",
    "Idempotency markers; pruned after 7 days.",
))
register_field("completion_markers.job_id", _r(
    StateCategory.PORTABLE, "low", "7d TTL", None, "pruned",
))
register_field("completion_markers.idempotency_key", _r(
    StateCategory.PORTABLE, "low", "7d TTL", None, "pruned",
))
register_field("completion_markers.completed_at", _r(
    StateCategory.PORTABLE, "low", "7d TTL", None, "pruned",
))
register_field("completion_markers.expires_at", _r(
    StateCategory.PORTABLE, "low", "7d TTL",
    "ISO-8601 UTC; pruned at restore", "pruned",
))


# ─────────────────────────────────────────────────────────────────────────────
# checkpoint_keys and checkpoint_envelopes (local-only — never transferred)
# ─────────────────────────────────────────────────────────────────────────────

register_field("checkpoint_keys", _r(
    StateCategory.LOCAL_ONLY, "critical", "permanent",
    "wrapped ENC:: blobs only — no plaintext keys",
    "full",
    "Encryption key material; wrapped with master password. Never leaves node.",
))
register_field("checkpoint_keys.key_hmac", _r(
    StateCategory.LOCAL_ONLY, "critical", "permanent",
    "ENC:: wrapped blob; never plaintext",
    "full",
    "HMAC-SHA256 key — never exported. FORBIDDEN in checkpoint payloads.",
))
register_field("checkpoint_keys.key_enc", _r(
    StateCategory.LOCAL_ONLY, "critical", "permanent",
    "ENC:: wrapped blob; never plaintext",
    "full",
    "AES-GCM content-encryption key — never exported. FORBIDDEN in payloads.",
))
register_field("checkpoint_keys.key_id", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "hex token 16 bytes", "full",
    "Key identifier is portable; actual key material is LOCAL_ONLY.",
))
register_field("checkpoint_keys.agent_id", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("checkpoint_keys.namespace", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("checkpoint_keys.status", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "active|retired", "full",
))
register_field("checkpoint_keys.created_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("checkpoint_keys.retired_at", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))

register_field("checkpoint_envelopes", _r(
    StateCategory.LOCAL_ONLY, "critical", "permanent",
    "HMAC-authenticated, AES-GCM encrypted",
    "full",
    "Encrypted checkpoint envelopes; already-encrypted payload.",
))
register_field("checkpoint_envelopes.nonce", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "unique hex nonce", "full",
    "Nonce is safe to expose; it is an identifier, not a secret.",
))
register_field("checkpoint_envelopes.seq", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "monotonic int", "full",
))
register_field("checkpoint_envelopes.schema_ver", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))
register_field("checkpoint_envelopes.ts", _r(
    StateCategory.PORTABLE, "low", "permanent", None, "full",
))


# ─────────────────────────────────────────────────────────────────────────────
# Scheduler / Backoff state (in-memory and durable)
# ─────────────────────────────────────────────────────────────────────────────

register_field("scheduler.Backoff.fail_count", _r(
    StateCategory.LOCAL_ONLY, "low", "until_reset",
    "non-negative int", "rebuilt",
    "In-memory fail count; not persisted in non-durable backoff.",
))
register_field("scheduler.Backoff.base_delay", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "positive float", "full",
))
register_field("scheduler.Backoff.initial_backoff", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "positive float", "full",
))
register_field("scheduler.Backoff.max_backoff", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "positive float", "full",
))
register_field("scheduler.Backoff.jitter", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "0.0 to 1.0", "full",
))

# DurableBackoff fields
register_field("scheduler.DurableBackoff.fail_count", _r(
    StateCategory.PORTABLE, "low", "until_resolved",
    "non-negative int", "capped",
    "Persisted via retry_state table; survives restarts.",
))
register_field("scheduler.DurableBackoff._next_attempt_at", _r(
    StateCategory.PORTABLE, "low", "until_resolved",
    "ISO-8601 UTC; capped to +60s on restore",
    "capped",
))
register_field("scheduler.DurableBackoff._terminal", _r(
    StateCategory.PORTABLE, "low", "until_resolved",
    "bool", "full",
))
register_field("scheduler.DurableBackoff.max_attempts", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "non-negative int; 0=unlimited", "full",
))
register_field("scheduler.DurableBackoff.task_name", _r(
    StateCategory.PORTABLE, "low", "until_resolved", None, "full",
))


# ─────────────────────────────────────────────────────────────────────────────
# Commerce in-memory state
# ─────────────────────────────────────────────────────────────────────────────

register_field("commerce._claimed_jobs", _r(
    StateCategory.PORTABLE, "high", "until_fulfilled_or_expired",
    "dict[job_id -> fencing_token]; reverified on restore",
    "reverified",
    "In-memory mirror of claimed_jobs table. Must be reverified via API.",
))
register_field("commerce._api", _r(
    StateCategory.LOCAL_ONLY, "high", "runtime only",
    None, "rebuilt",
    "API client reference; not persisted. Rebuilt on restart.",
))
register_field("commerce._db", _r(
    StateCategory.LOCAL_ONLY, "medium", "runtime only",
    None, "rebuilt",
    "Database reference; not persisted. Rebuilt on restart.",
))
register_field("commerce._settings", _r(
    StateCategory.LOCAL_ONLY, "medium", "runtime only",
    None, "rebuilt",
    "Settings reference; not persisted. Rebuilt from env on restart.",
))


# ─────────────────────────────────────────────────────────────────────────────
# BrowserSession state (local-only / derived)
# ─────────────────────────────────────────────────────────────────────────────

register_field("browser.BrowserSession._client", _r(
    StateCategory.LOCAL_ONLY, "high", "runtime only",
    "Stagehand instance; not serializable",
    "rebuilt",
    "Browser automation client; never checkpointed.",
))
register_field("browser.BrowserSession._session_id", _r(
    StateCategory.LOCAL_ONLY, "medium", "runtime only",
    "Stagehand session ID; ephemeral",
    "rebuilt",
    "Browser session identifier; scoped to local Chrome instance.",
))
register_field("browser.BrowserSession._closed", _r(
    StateCategory.LOCAL_ONLY, "low", "runtime only",
    "bool", "rebuilt",
))
register_field("browser.BrowserSession.CHROME_PROFILE_DIR", _r(
    StateCategory.LOCAL_ONLY, "high", "session only",
    "local filesystem path; contains browser cache/cookies",
    "rebuilt",
    "Chrome user data directory. FORBIDDEN in checkpoints — contains cookies, "
    "local storage, and session state.",
))


# ─────────────────────────────────────────────────────────────────────────────
# AgentContext (derived — rebuilt from DB each cycle)
# ─────────────────────────────────────────────────────────────────────────────

register_field("agent.AgentContext", _r(
    StateCategory.DERIVED, "low", "runtime only",
    None, "rebuilt",
    "Full AgentContext is rebuilt from DB each agent cycle. Never persisted.",
))
register_field("agent.AgentContext.current_time", _r(
    StateCategory.DERIVED, "none", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.posts_today", _r(
    StateCategory.DERIVED, "low", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.research_today", _r(
    StateCategory.DERIVED, "low", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.replies_today", _r(
    StateCategory.DERIVED, "low", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.pending_approvals", _r(
    StateCategory.DERIVED, "medium", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.pending_jobs", _r(
    StateCategory.DERIVED, "medium", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.last_agent_cycle", _r(
    StateCategory.DERIVED, "low", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.recent_content", _r(
    StateCategory.DERIVED, "medium", "runtime only",
    "redacted; no raw user payloads", "rebuilt",
))
register_field("agent.AgentContext.active_playbook", _r(
    StateCategory.DERIVED, "medium", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.talos_config", _r(
    StateCategory.DERIVED, "high", "runtime only",
    "redacted; no keys or credentials", "rebuilt",
))
register_field("agent.AgentContext.spending_today", _r(
    StateCategory.DERIVED, "medium", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.spending_month", _r(
    StateCategory.DERIVED, "medium", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.gtm_budget", _r(
    StateCategory.DERIVED, "medium", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.performance_summary", _r(
    StateCategory.DERIVED, "low", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.active_learnings", _r(
    StateCategory.DERIVED, "low", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.audience_insights", _r(
    StateCategory.DERIVED, "low", "runtime only", None, "rebuilt",
))
register_field("agent.AgentContext.unmeasured_count", _r(
    StateCategory.DERIVED, "low", "runtime only", None, "rebuilt",
))


# ─────────────────────────────────────────────────────────────────────────────
# Adapter state (local-only)
# ─────────────────────────────────────────────────────────────────────────────

register_field("adapters.storage.LocalStorageAdapter.base_dir", _r(
    StateCategory.LOCAL_ONLY, "low", "permanent",
    "local filesystem path", "rebuilt",
    "Storage base directory path; machine-local.",
))
register_field("adapters.storage.MemoryStorageAdapter.store_dict", _r(
    StateCategory.LOCAL_ONLY, "high", "runtime only",
    None, "rebuilt",
    "In-memory checkpoint store; for testing only.",
))
register_field("adapters.storage.VerifiedCheckpointStorage.encryption_password", _r(
    StateCategory.LOCAL_ONLY, "critical", "runtime only",
    "in-memory only; never logged or checkpointed",
    "rebuilt",
    "FORBIDDEN in checkpoints — encryption password must never be persisted.",
))
register_field("adapters.storage.VerifiedCheckpointStorage.adapter", _r(
    StateCategory.LOCAL_ONLY, "low", "runtime only",
    None, "rebuilt",
))
register_field("adapters.storage.VerifiedCheckpointStorage.max_size_bytes", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "positive int", "full",
))
register_field("adapters.storage.VerifiedCheckpointStorage.max_retries", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "positive int", "full",
))
register_field("adapters.storage.VerifiedCheckpointStorage.timeout_seconds", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "positive float", "full",
))
register_field("adapters.storage.VerifiedCheckpointStorage.retention_count", _r(
    StateCategory.PORTABLE, "low", "permanent",
    "positive int", "full",
))


# ─────────────────────────────────────────────────────────────────────────────
# FORBIDDEN fields — must never appear in checkpoints, logs, or exports
# ─────────────────────────────────────────────────────────────────────────────

register_field("config.Settings.talos_api_key", _r(
    StateCategory.FORBIDDEN, "critical", "never",
    "API key; never persisted outside env",
    "never",
    "API key must never be stored in checkpoints or logs.",
))
register_field("crypto._derive_wrapping_key", _r(
    StateCategory.FORBIDDEN, "critical", "never",
    "derived AES key; in-memory only",
    "never",
    "Derived key material; must never be checkpointed.",
))
register_field("browser.BrowserSession.chrome_profile_data", _r(
    StateCategory.FORBIDDEN, "critical", "never",
    "browser profile directory; contains cookies, storage, sessions",
    "never",
    "Chrome user profile data. Contains cookies, local storage, and session "
    "auth state. Must never be included in checkpoints.",
))
register_field("commerce.commerce_queue.raw_payload", _r(
    StateCategory.FORBIDDEN, "high", "never",
    "unprocessed user request payload",
    "never",
    "Raw user-provided payloads must not be checkpointed without redaction.",
))
register_field("tools.unredacted_tool_output", _r(
    StateCategory.FORBIDDEN, "high", "never",
    "unredacted LLM tool execution output",
    "never",
    "Tool output may contain sensitive data. Must be redacted before "
    "checkpointing.",
))
register_field("checkpoint.checkpoint_envelopes.payload.raw", _r(
    StateCategory.FORBIDDEN, "critical", "never",
    "unencrypted checkpoint payload",
    "never",
    "Unencrypted payload must never be stored or exported.",
))
register_field("api_client.TalosAPIClient._session_headers", _r(
    StateCategory.FORBIDDEN, "critical", "never",
    "HTTP auth headers/tokens",
    "never",
    "HTTP session headers containing auth tokens. Must never be checkpointed.",
))
register_field("agent.loop.unredacted_llm_response", _r(
    StateCategory.FORBIDDEN, "high", "never",
    "unredacted LLM response",
    "never",
    "LLM responses may contain sensitive data. Must redact before checkpoint.",
))
register_field("adapters.storage.VerifiedCheckpointStorage.plaintext_payload", _r(
    StateCategory.FORBIDDEN, "critical", "never",
    "unencrypted plaintext",
    "never",
    "Plaintext payload before encryption must never be checkpointed or logged.",
))
