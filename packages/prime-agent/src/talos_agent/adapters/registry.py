"""AdapterRegistry — maps channel names to BaseSocialAdapter instances."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
import logging
import sqlite3
from typing import TYPE_CHECKING, Any

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities

if TYPE_CHECKING:
    from talos_agent.adapters.capability import AdapterSandbox
    from talos_agent.adapters.publication_intent import (
        PublicationIntent,
        PublicationIntentStore,
    )

logger = logging.getLogger(__name__)


class OperatorDisposition(str, Enum):
    """Explicit operator disposition for uncertain / indeterminate adapter publications."""

    RESOLVE_SUCCEEDED = "resolve_succeeded"
    RESOLVE_FAILED = "resolve_failed"
    ABANDON = "abandon"
    RETRY = "retry"


@dataclass(frozen=True)
class UncertainPublication:
    """An adapter invocation record in an uncertain/indeterminate state requiring disposition."""

    operation_id: str
    adapter_name: str
    operation: str
    input_digest: str
    state: str
    owner_id: str
    attempt_count: int
    lease_expires_at: str
    created_at: str
    updated_at: str
    safe_actions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "adapter_name": self.adapter_name,
            "operation": self.operation,
            "input_digest": self.input_digest,
            "state": self.state,
            "owner_id": self.owner_id,
            "attempt_count": self.attempt_count,
            "lease_expires_at": self.lease_expires_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "safe_actions": list(self.safe_actions),
        }


@dataclass(frozen=True)
class DispositionResult:
    """Outcome of applying an operator disposition to an uncertain publication."""

    operation_id: str
    disposition: str
    previous_state: str
    resulting_state: str
    action_taken: str
    applied_at: str
    operator: str | None = None
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "disposition": self.disposition,
            "previous_state": self.previous_state,
            "resulting_state": self.resulting_state,
            "action_taken": self.action_taken,
            "applied_at": self.applied_at,
            "operator": self.operator,
            "reason": self.reason,
        }


class AdapterRecoveryQueue:
    """Operator queue for inspecting and resolving uncertain adapter publications.

    Guarantees:
    - Never silently retries an action that may already have succeeded.
    - Explicit disposition required for indeterminate operations.
    - Safe actions are listed per uncertain publication based on state and lease.
    """

    SAFE_ACTIONS: list[str] = [
        OperatorDisposition.RESOLVE_SUCCEEDED.value,
        OperatorDisposition.RESOLVE_FAILED.value,
        OperatorDisposition.ABANDON.value,
        OperatorDisposition.RETRY.value,
    ]

    def __init__(self, db: Any) -> None:
        self._conn: sqlite3.Connection = getattr(db, "_conn", db)

    def list_uncertain(self, *, limit: int = 50) -> list[UncertainPublication]:
        """List publications in indeterminate or expired running states requiring operator disposition."""
        try:
            self._ensure_table()
            rows = self._conn.execute(
                """
                SELECT operation_id, adapter_name, operation, input_digest, state,
                       owner_id, lease_expires_at, attempt_count, created_at, updated_at
                FROM adapter_invocations
                WHERE state = 'indeterminate'
                   OR (state = 'running' AND datetime(lease_expires_at) < datetime('now'))
                ORDER BY created_at ASC, operation_id ASC
                LIMIT ?
                """,
                (max(1, min(limit, 200)),),
            ).fetchall()
        except sqlite3.OperationalError:
            return []

        results: list[UncertainPublication] = []
        for r in rows:
            safe_actions = self._compute_safe_actions(r["state"], r["lease_expires_at"])
            results.append(
                UncertainPublication(
                    operation_id=r["operation_id"],
                    adapter_name=r["adapter_name"],
                    operation=r["operation"],
                    input_digest=r["input_digest"],
                    state=r["state"],
                    owner_id=r["owner_id"],
                    attempt_count=r["attempt_count"],
                    lease_expires_at=r["lease_expires_at"],
                    created_at=r["created_at"],
                    updated_at=r["updated_at"],
                    safe_actions=safe_actions,
                )
            )
        return results

    def get_uncertain(self, operation_id: str) -> UncertainPublication | None:
        """Fetch a specific publication if it is in an uncertain state."""
        try:
            self._ensure_table()
            row = self._conn.execute(
                """
                SELECT operation_id, adapter_name, operation, input_digest, state,
                       owner_id, lease_expires_at, attempt_count, created_at, updated_at
                FROM adapter_invocations
                WHERE operation_id = ?
                """,
                (operation_id,),
            ).fetchone()
        except sqlite3.OperationalError:
            return None

        if not row:
            return None

        state = row["state"]
        lease_expires_at = row["lease_expires_at"]
        is_uncertain = state == "indeterminate" or (
            state == "running" and self._is_expired(lease_expires_at)
        )
        if not is_uncertain:
            return None

        return UncertainPublication(
            operation_id=row["operation_id"],
            adapter_name=row["adapter_name"],
            operation=row["operation"],
            input_digest=row["input_digest"],
            state=state,
            owner_id=row["owner_id"],
            attempt_count=row["attempt_count"],
            lease_expires_at=lease_expires_at,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            safe_actions=self._compute_safe_actions(state, lease_expires_at),
        )

    def apply_disposition(
        self,
        operation_id: str,
        disposition: str | OperatorDisposition,
        *,
        operator: str | None = None,
        reason: str | None = None,
    ) -> DispositionResult:
        """Apply an explicit operator disposition to an uncertain publication.

        Raises:
        - ValueError: If disposition is invalid, operation is unknown, or already terminal.
        - RuntimeError: If attempting silent retry or invalid state transition.
        """
        disp_value = (
            disposition.value if isinstance(disposition, OperatorDisposition) else str(disposition).lower().strip()
        )
        valid_dispositions = {d.value for d in OperatorDisposition}
        if disp_value not in valid_dispositions:
            raise ValueError(
                f"Invalid disposition {disposition!r}. Must be one of {sorted(valid_dispositions)}"
            )

        self._ensure_table()
        now_iso = datetime.now(timezone.utc).isoformat()

        try:
            self._conn.execute("BEGIN IMMEDIATE")
            row = self._conn.execute(
                "SELECT * FROM adapter_invocations WHERE operation_id = ?",
                (operation_id,),
            ).fetchone()

            if row is None:
                raise ValueError(f"Operation ID {operation_id!r} not found in adapter invocations")

            current_state = row["state"]
            lease_expires_at = row["lease_expires_at"]
            is_expired_running = current_state == "running" and self._is_expired(lease_expires_at)

            if current_state not in ("indeterminate", "running"):
                raise ValueError(
                    f"Cannot apply disposition to publication in terminal state {current_state!r}"
                )
            if current_state == "running" and not is_expired_running:
                raise ValueError(
                    f"Cannot apply disposition to actively running publication (lease expires {lease_expires_at})"
                )

            # Determine resulting state based on operator disposition
            if disp_value == OperatorDisposition.RESOLVE_SUCCEEDED.value:
                target_state = "succeeded"
                action_taken = "Marked succeeded by operator confirmation"
            elif disp_value in (OperatorDisposition.RESOLVE_FAILED.value, OperatorDisposition.ABANDON.value):
                target_state = "failed"
                action_taken = (
                    "Marked failed by operator disposition"
                    if disp_value == OperatorDisposition.RESOLVE_FAILED.value
                    else "Abandoned by operator disposition"
                )
            elif disp_value == OperatorDisposition.RETRY.value:
                # Explicit operator retry: transitions to 'failed' so it can be re-admitted,
                # ensuring it is NEVER silently retried by automatic background systems.
                target_state = "failed"
                action_taken = "Reset to failed for operator-authorized retry"
            else:
                raise ValueError(f"Unhandled disposition {disp_value!r}")

            self._conn.execute(
                """
                UPDATE adapter_invocations
                SET state = ?, updated_at = ?
                WHERE operation_id = ?
                """,
                (target_state, now_iso, operation_id),
            )
            self._conn.commit()

            return DispositionResult(
                operation_id=operation_id,
                disposition=disp_value,
                previous_state=current_state,
                resulting_state=target_state,
                action_taken=action_taken,
                applied_at=now_iso,
                operator=operator,
                reason=reason,
            )
        except Exception:
            if self._conn.in_transaction:
                self._conn.rollback()
            raise

    def _ensure_table(self) -> None:
        """Ensure adapter_invocations table exists before querying."""
        self._conn.execute(
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
            """
        )

    def _is_expired(self, lease_expires_at: str) -> bool:
        try:
            val = lease_expires_at.replace("Z", "+00:00") if lease_expires_at.endswith("Z") else lease_expires_at
            exp = datetime.fromisoformat(val)
            now = datetime.now(timezone.utc)
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            return exp < now
        except Exception:
            return True

    def _compute_safe_actions(self, state: str, lease_expires_at: str) -> list[str]:
        # Explicit actions allowed for operator intervention:
        # 1. resolve_succeeded: if verified out-of-band to have posted
        # 2. resolve_failed: if verified out-of-band to have failed or not posted
        # 3. abandon: drop without reattempting
        # 4. retry: explicitly reset for retry only under operator direction
        return [
            OperatorDisposition.RESOLVE_SUCCEEDED.value,
            OperatorDisposition.RESOLVE_FAILED.value,
            OperatorDisposition.ABANDON.value,
            OperatorDisposition.RETRY.value,
        ]


@dataclass(frozen=True)
class CapabilityChange:
    """Differences between old and new capabilities for an adapter channel."""

    before: dict[str, Any]
    after: dict[str, Any]
    differences: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "before": dict(self.before),
            "after": dict(self.after),
            "differences": dict(self.differences),
        }


@dataclass(frozen=True)
class AdapterReloadPreview:
    """Preview of changes and impact when reloading adapter configuration."""

    valid: bool
    added_channels: list[str] = field(default_factory=list)
    removed_channels: list[str] = field(default_factory=list)
    modified_channels: list[str] = field(default_factory=list)
    unchanged_channels: list[str] = field(default_factory=list)
    capability_diff: dict[str, CapabilityChange] = field(default_factory=dict)
    affected_scheduled_tasks: list[str] = field(default_factory=list)
    validation_errors: list[str] = field(default_factory=list)

    @property
    def has_changes(self) -> bool:
        """Return True if any channel was added, removed, or modified."""
        return bool(self.added_channels or self.removed_channels or self.modified_channels)

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "has_changes": self.has_changes,
            "added_channels": list(self.added_channels),
            "removed_channels": list(self.removed_channels),
            "modified_channels": list(self.modified_channels),
            "unchanged_channels": list(self.unchanged_channels),
            "capability_diff": {k: v.to_dict() for k, v in self.capability_diff.items()},
            "affected_scheduled_tasks": list(self.affected_scheduled_tasks),
            "validation_errors": list(self.validation_errors),
        }


class AdapterRegistry:
    """Holds all registered channel adapters and routes publishing calls.

    Duplicate registration behaviour is controlled by the ``on_duplicate``
    constructor parameter:

    * ``"raise"`` (default) — raise :class:`ValueError` immediately so
      mis-configuration is caught at startup.
    * ``"warn"``            — log a warning and keep the *existing* adapter
      (the duplicate is silently dropped).
    * ``"skip"``            — silently ignore the duplicate and keep the
      existing adapter without any log output.

    Use :meth:`replace` for intentional, deliberate adapter swaps.
    """

    #: Accepted values for the ``on_duplicate`` parameter.
    _VALID_ON_DUPLICATE = frozenset({"raise", "warn", "skip"})

    def __init__(
        self,
        sandbox: AdapterSandbox | None = None,
        *,
        on_duplicate: str = "raise",
        recovery_queue: AdapterRecoveryQueue | None = None,
    ) -> None:
        if on_duplicate not in self._VALID_ON_DUPLICATE:
            raise ValueError(
                f"on_duplicate must be one of {sorted(self._VALID_ON_DUPLICATE)!r}, "
                f"got {on_duplicate!r}"
            )
        self._adapters: dict[str, BaseSocialAdapter] = {}
        self._sandbox = sandbox
        self._on_duplicate = on_duplicate
        self._recovery_queue = recovery_queue

    @property
    def recovery_queue(self) -> AdapterRecoveryQueue | None:
        """Access the adapter recovery queue if configured, or from sandbox store."""
        if self._recovery_queue is not None:
            return self._recovery_queue
        if self._sandbox is not None and getattr(self._sandbox, "_store", None) is not None:
            return AdapterRecoveryQueue(self._sandbox._store)
        return None

    # ── Registration ─────────────────────────────────────────────────

    def register(self, adapter: BaseSocialAdapter) -> None:
        """Register *adapter* under its ``channel_name`` (case-insensitive key).

        Raises :class:`ValueError` (or logs / skips, depending on
        ``on_duplicate``) when a channel with the same key is already
        registered.  Use :meth:`replace` for intentional swaps.
        """
        if self._sandbox is not None:
            adapter = self._sandbox.wrap(adapter)

        key = adapter.channel_name.lower()

        if key in self._adapters:
            existing = self._adapters[key]
            msg = (
                f"Duplicate adapter registration for channel {key!r}: "
                f"an adapter of type {type(existing).__name__!r} is already "
                f"registered. Use replace() for intentional swaps."
            )
            if self._on_duplicate == "raise":
                raise ValueError(msg)
            elif self._on_duplicate == "warn":
                logger.warning(msg)
                return  # keep the existing adapter
            else:  # "skip"
                return  # silently ignore

        self._adapters[key] = adapter

    def replace(self, adapter: BaseSocialAdapter) -> BaseSocialAdapter | None:
        """Intentionally swap out the adapter for *adapter.channel_name*.

        Unlike :meth:`register`, ``replace`` never raises on a pre-existing
        entry — it is the explicit, deliberate path for hot-swapping adapters
        at runtime (e.g. rotating credentials or switching environments).

        Parameters
        ----------
        adapter:
            The new adapter to install.  Its ``channel_name`` determines
            which key is replaced.

        Returns
        -------
        BaseSocialAdapter | None
            The previously registered adapter for that channel, or ``None``
            if no adapter was registered beforehand.
        """
        if self._sandbox is not None:
            adapter = self._sandbox.wrap(adapter)

        key = adapter.channel_name.lower()
        previous = self._adapters.get(key)
        self._adapters[key] = adapter
        return previous

    # ── Lookup ───────────────────────────────────────────────────────

    def get(self, channel: str) -> BaseSocialAdapter | None:
        return self._adapters.get(channel.lower())

    def available_channels(self) -> list[str]:
        return [a.channel_name for a in self._adapters.values()]

    def capabilities(self) -> dict[str, dict]:
        return {
            a.channel_name: a.get_capabilities().__dict__
            for a in self._adapters.values()
        }

    async def publish(self, channel: str, content: str, **kwargs):
        """Route a publish through *channel* with a durable intent record.

        When the registry was constructed without an ``intent_store``, this is
        exactly ``adapter.post(content, **kwargs)`` — no intent is written, and
        the return value is the adapter's own ``PublishResult``.

        With an ``intent_store``, the sequence is:

        1. Look up the adapter; if none, return ``None`` (same as ``get``).
        2. Write a ``pending`` :class:`PublicationIntent` before calling the
           adapter, so a crash mid-publish leaves a recoverable record.
        3. Call ``adapter.post`` and inspect ``PublishResult.status``:
           * ``"success"``  → intent becomes ``confirmed``.
           * anything else  → intent becomes ``rejected`` (with ``last_error``).
           * raised exception → intent stays ``pending`` (reconcile on restart).
        4. Return the ``PublishResult`` unchanged.

        ``action_id`` is ``f"{channel}:{payload_hash}"`` so a re-submit of the
        same content to the same channel produces the same identity, and the
        reconcile pass can match it.
        """
        from talos_agent.adapters.publication_intent import (
            PublicationIntent,
            PublicationIntentStatus,
            payload_hash,
        )

        adapter = self.get(channel)
        if adapter is None:
            return None
        if self._intent_store is None:
            return await adapter.post(content, **kwargs)

        action_id = f"{adapter.channel_name.lower()}:{payload_hash(content)}"
        intent = PublicationIntent(
            action_id=action_id,
            adapter=adapter.channel_name.lower(),
            payload_hash=payload_hash(content),
            status=PublicationIntentStatus.PENDING,
        )
        self._intent_store.write(intent)

        result = await adapter.post(content, **kwargs)
        status = getattr(result, "status", None)
        intent.resolved_at = intent.resolved_at or _now_iso()
        if status == "success":
            intent.status = PublicationIntentStatus.CONFIRMED
        else:
            intent.status = PublicationIntentStatus.REJECTED
            intent.last_error = getattr(result, "error", None) or status
        self._intent_store.write(intent)
        return result

    def __len__(self) -> int:
        return len(self._adapters)

    # ── Configuration Reload Preview ─────────────────────────────────

    def preview_reload(
        self,
        candidate: Any,
    ) -> AdapterReloadPreview:
        """Preview changes and affected tasks from a candidate adapter configuration.

        Validates the candidate without connecting to external networks or
        using external credentials.

        Accepts:
        - An :class:`AdapterRegistry` instance
        - An iterable of :class:`BaseSocialAdapter` instances
        - A mapping of channel name -> :class:`BaseSocialAdapter` | :class:`ChannelCapabilities` | dict
        """
        validation_errors: list[str] = []
        candidate_channels: dict[str, tuple[str, dict[str, Any]]] = {}

        # 1. Parse and validate candidate without invoking external credentials
        try:
            if candidate is None:
                validation_errors.append("Candidate configuration cannot be None")
            elif isinstance(candidate, AdapterRegistry):
                for ch in candidate.available_channels():
                    adapter = candidate.get(ch)
                    if adapter is None:
                        continue
                    try:
                        caps = adapter.get_capabilities()
                        candidate_channels[ch.lower()] = (
                            adapter.channel_name,
                            asdict(caps) if hasattr(caps, "__dataclass_fields__") else dict(caps.__dict__),
                        )
                    except Exception as exc:
                        validation_errors.append(f"Channel {ch!r} failed capability extraction: {exc}")
            elif isinstance(candidate, (list, tuple, set)):
                seen_keys: set[str] = set()
                for idx, item in enumerate(candidate):
                    if not isinstance(item, BaseSocialAdapter):
                        validation_errors.append(
                            f"Candidate item at index {idx} is not a BaseSocialAdapter (got {type(item).__name__})"
                        )
                        continue
                    ch_name = getattr(item, "channel_name", None)
                    if not ch_name or not isinstance(ch_name, str):
                        validation_errors.append(
                            f"Candidate adapter at index {idx} has invalid channel_name {ch_name!r}"
                        )
                        continue
                    key = ch_name.lower()
                    if key in seen_keys:
                        validation_errors.append(f"Duplicate channel {ch_name!r} in candidate adapter list")
                        continue
                    seen_keys.add(key)
                    try:
                        caps = item.get_capabilities()
                        candidate_channels[key] = (
                            item.channel_name,
                            asdict(caps) if hasattr(caps, "__dataclass_fields__") else dict(caps.__dict__),
                        )
                    except Exception as exc:
                        validation_errors.append(f"Channel {ch_name!r} failed capability extraction: {exc}")
            elif isinstance(candidate, dict):
                for raw_name, item in candidate.items():
                    if not isinstance(raw_name, str) or not raw_name.strip():
                        validation_errors.append(f"Invalid channel identifier in candidate map: {raw_name!r}")
                        continue
                    key = raw_name.strip().lower()
                    if key in candidate_channels:
                        validation_errors.append(f"Duplicate channel key in candidate map: {raw_name!r}")
                        continue

                    if isinstance(item, BaseSocialAdapter):
                        try:
                            caps = item.get_capabilities()
                            candidate_channels[key] = (
                                item.channel_name,
                                asdict(caps) if hasattr(caps, "__dataclass_fields__") else dict(caps.__dict__),
                            )
                        except Exception as exc:
                            validation_errors.append(f"Channel {raw_name!r} failed capability extraction: {exc}")
                    elif isinstance(item, ChannelCapabilities):
                        candidate_channels[key] = (raw_name, asdict(item))
                    elif isinstance(item, dict):
                        # Candidate is directly a capabilities dict or config map
                        candidate_channels[key] = (raw_name, dict(item))
                    else:
                        validation_errors.append(
                            f"Channel {raw_name!r} has invalid candidate type {type(item).__name__}"
                        )
            else:
                validation_errors.append(
                    f"Unsupported candidate type: {type(candidate).__name__}. "
                    "Expected AdapterRegistry, list/tuple of BaseSocialAdapter, or mapping."
                )
        except Exception as exc:
            validation_errors.append(f"Unexpected candidate validation error: {exc}")

        # 2. Extract current capabilities
        current_channels: dict[str, tuple[str, dict[str, Any]]] = {}
        for ch in self.available_channels():
            adapter = self.get(ch)
            if adapter is not None:
                try:
                    caps = adapter.get_capabilities()
                    caps_dict = asdict(caps) if hasattr(caps, "__dataclass_fields__") else dict(caps.__dict__)
                except Exception:
                    caps_dict = {}
                current_channels[ch.lower()] = (adapter.channel_name, caps_dict)

        # If invalid candidate, return failed preview immediately
        if validation_errors:
            return AdapterReloadPreview(
                valid=False,
                validation_errors=validation_errors,
            )

        # 3. Compute capability differences
        added_channels: list[str] = []
        removed_channels: list[str] = []
        modified_channels: list[str] = []
        unchanged_channels: list[str] = []
        capability_diff: dict[str, CapabilityChange] = {}

        curr_keys = set(current_channels.keys())
        cand_keys = set(candidate_channels.keys())

        # Added channels
        for key in sorted(cand_keys - curr_keys):
            ch_name, caps = candidate_channels[key]
            added_channels.append(ch_name)
            capability_diff[ch_name] = CapabilityChange(
                before={},
                after=caps,
                differences={k: {"before": None, "after": v} for k, v in caps.items()},
            )

        # Removed channels
        for key in sorted(curr_keys - cand_keys):
            ch_name, caps = current_channels[key]
            removed_channels.append(ch_name)
            capability_diff[ch_name] = CapabilityChange(
                before=caps,
                after={},
                differences={k: {"before": v, "after": None} for k, v in caps.items()},
            )

        # Existing in both: check modifications
        for key in sorted(curr_keys & cand_keys):
            curr_name, curr_caps = current_channels[key]
            cand_name, cand_caps = candidate_channels[key]
            display_name = cand_name

            all_field_names = set(curr_caps.keys()) | set(cand_caps.keys())
            diffs: dict[str, dict[str, Any]] = {}
            for field_name in sorted(all_field_names):
                val_before = curr_caps.get(field_name)
                val_after = cand_caps.get(field_name)
                if val_before != val_after:
                    diffs[field_name] = {"before": val_before, "after": val_after}

            if diffs:
                modified_channels.append(display_name)
                capability_diff[display_name] = CapabilityChange(
                    before=curr_caps,
                    after=cand_caps,
                    differences=diffs,
                )
            else:
                unchanged_channels.append(display_name)

        # 4. Determine affected scheduled tasks
        # Known tasks in prime-agent scheduler:
        # - "agent_cycle": consumes all active publishing adapters & capabilities
        # - "learning_cycle": consumes active channels & capabilities for review/learning
        # - "telemetry_log": collects health snapshots across all configured adapters
        # - "telegram_queue": worker task for Telegram queue rate-limiting
        affected_tasks_set: set[str] = set()

        any_channel_changes = bool(added_channels or removed_channels or modified_channels)
        if any_channel_changes:
            affected_tasks_set.add("agent_cycle")
            affected_tasks_set.add("learning_cycle")
            affected_tasks_set.add("telemetry_log")

        # Telegram-specific tasks
        has_curr_telegram = "telegram" in curr_keys
        has_cand_telegram = "telegram" in cand_keys
        if has_curr_telegram != has_cand_telegram or (
            has_cand_telegram and "telegram" in (k.lower() for k in modified_channels)
        ):
            affected_tasks_set.add("telegram_queue")

        # Order affected tasks deterministically
        task_order = [
            "agent_cycle",
            "learning_cycle",
            "telemetry_log",
            "telegram_queue",
        ]
        affected_scheduled_tasks = [t for t in task_order if t in affected_tasks_set]

        return AdapterReloadPreview(
            valid=True,
            added_channels=added_channels,
            removed_channels=removed_channels,
            modified_channels=modified_channels,
            unchanged_channels=unchanged_channels,
            capability_diff=capability_diff,
            affected_scheduled_tasks=affected_scheduled_tasks,
            validation_errors=[],
        )
