"""Pluggable persistence backends for the encrypted secret store.

Backends own durable state only. Encryption, validation, and lifecycle
orchestration stay in ``SecretStore`` so callers keep one interface.

Supported kinds:
  - ``sqlite`` — transactional SQLite via ``LocalDB`` (default / production)
  - ``memory`` — process-local store for tests and dependency-free fakes
"""

from __future__ import annotations

import copy
import threading
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Final, Mapping

_SUPPORTED: Final[frozenset[str]] = frozenset({"sqlite", "memory"})


class BackendBusyError(Exception):
    """Raised when a backend cannot acquire its transactional lock."""


@dataclass(frozen=True)
class SecretVersionRecord:
    name: str
    version: int
    status: str
    created_at: str
    activated_at: str | None
    revoked_at: str | None
    ciphertext: str
    key_id: str
    request_id: str | None = None


@dataclass(frozen=True)
class SecretHeadRecord:
    active_version: int
    previous_version: int | None
    generation: int = 1


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class SecretStoreBackend(ABC):
    """Persistence contract for versioned encrypted secrets."""

    kind: str

    @abstractmethod
    def begin_immediate(self) -> None:
        """Start a write transaction with exclusive / compare-and-swap semantics."""

    @abstractmethod
    def commit(self) -> None:
        """Commit the open transaction."""

    @abstractmethod
    def rollback(self) -> None:
        """Roll back the open transaction."""

    @abstractmethod
    def get_version_by_request_id(
        self, scope: str, name: str, request_id: str
    ) -> SecretVersionRecord | None:
        ...

    @abstractmethod
    def next_version_number(self, scope: str, name: str) -> int:
        ...

    @abstractmethod
    def insert_version(
        self,
        *,
        scope: str,
        name: str,
        version: int,
        ciphertext: str,
        key_id: str,
        status: str,
        request_id: str,
    ) -> None:
        ...

    @abstractmethod
    def get_version(self, scope: str, name: str, version: int) -> SecretVersionRecord | None:
        ...

    @abstractmethod
    def get_head(self, scope: str, name: str) -> SecretHeadRecord | None:
        ...

    @abstractmethod
    def insert_head(self, scope: str, name: str, active_version: int) -> None:
        ...

    @abstractmethod
    def update_head(
        self,
        scope: str,
        name: str,
        *,
        active_version: int,
        previous_version: int | None,
    ) -> None:
        ...

    @abstractmethod
    def set_version_status(
        self,
        scope: str,
        name: str,
        version: int,
        status: str,
        *,
        set_activated: bool = False,
        set_revoked: bool = False,
        clear_revoked: bool = False,
    ) -> None:
        ...

    @abstractmethod
    def clear_previous_if(self, scope: str, name: str, previous_version: int) -> None:
        ...

    @abstractmethod
    def list_versions(self, scope: str, name: str) -> list[SecretVersionRecord]:
        ...

    @abstractmethod
    def insert_audit(
        self,
        *,
        scope: str,
        name: str,
        version: int | None,
        event_type: str,
        outcome: str,
        actor: str,
        reason: str | None,
        metadata: str,
    ) -> None:
        ...

    @abstractmethod
    def list_audit(self, scope: str, name: str, limit: int) -> list[dict[str, Any]]:
        ...


class SqliteSecretStoreBackend(SecretStoreBackend):
    """SQLite-backed store using the agent LocalDB connection."""

    kind = "sqlite"

    def __init__(self, db: Any) -> None:
        if db is None or not hasattr(db, "_conn"):
            raise ValueError("sqlite secret-store backend requires a LocalDB instance")
        self._db = db
        self._conn = db._conn

    def begin_immediate(self) -> None:
        self._conn.execute("BEGIN IMMEDIATE")

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def get_version_by_request_id(
        self, scope: str, name: str, request_id: str
    ) -> SecretVersionRecord | None:
        row = self._conn.execute(
            """
            SELECT name, version, status, created_at, activated_at, revoked_at,
                   ciphertext, key_id, request_id
            FROM secret_versions WHERE scope = ? AND name = ? AND request_id = ?
            """,
            (scope, name, request_id),
        ).fetchone()
        return self._row_to_version(row) if row else None

    def next_version_number(self, scope: str, name: str) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 AS version "
            "FROM secret_versions WHERE scope = ? AND name = ?",
            (scope, name),
        ).fetchone()
        return int(row["version"])

    def insert_version(
        self,
        *,
        scope: str,
        name: str,
        version: int,
        ciphertext: str,
        key_id: str,
        status: str,
        request_id: str,
    ) -> None:
        self._conn.execute(
            """
            INSERT INTO secret_versions
                (scope, name, version, ciphertext, key_id, status, request_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (scope, name, version, ciphertext, key_id, status, request_id),
        )

    def get_version(self, scope: str, name: str, version: int) -> SecretVersionRecord | None:
        row = self._conn.execute(
            """
            SELECT name, version, status, created_at, activated_at, revoked_at,
                   ciphertext, key_id, request_id
            FROM secret_versions WHERE scope = ? AND name = ? AND version = ?
            """,
            (scope, name, version),
        ).fetchone()
        return self._row_to_version(row) if row else None

    def get_head(self, scope: str, name: str) -> SecretHeadRecord | None:
        row = self._conn.execute(
            "SELECT active_version, previous_version, generation "
            "FROM secret_heads WHERE scope = ? AND name = ?",
            (scope, name),
        ).fetchone()
        if not row:
            return None
        return SecretHeadRecord(
            active_version=int(row["active_version"]),
            previous_version=(
                int(row["previous_version"]) if row["previous_version"] is not None else None
            ),
            generation=int(row["generation"]),
        )

    def insert_head(self, scope: str, name: str, active_version: int) -> None:
        self._conn.execute(
            """
            INSERT INTO secret_heads (scope, name, active_version, previous_version)
            VALUES (?, ?, ?, NULL)
            """,
            (scope, name, active_version),
        )

    def update_head(
        self,
        scope: str,
        name: str,
        *,
        active_version: int,
        previous_version: int | None,
    ) -> None:
        self._conn.execute(
            """
            UPDATE secret_heads
            SET active_version = ?, previous_version = ?, generation = generation + 1,
                updated_at = datetime('now')
            WHERE scope = ? AND name = ?
            """,
            (active_version, previous_version, scope, name),
        )

    def set_version_status(
        self,
        scope: str,
        name: str,
        version: int,
        status: str,
        *,
        set_activated: bool = False,
        set_revoked: bool = False,
        clear_revoked: bool = False,
    ) -> None:
        if set_activated and clear_revoked:
            self._conn.execute(
                """
                UPDATE secret_versions
                SET status = ?, activated_at = datetime('now'), revoked_at = NULL
                WHERE scope = ? AND name = ? AND version = ?
                """,
                (status, scope, name, version),
            )
        elif set_activated:
            self._conn.execute(
                """
                UPDATE secret_versions
                SET status = ?, activated_at = datetime('now')
                WHERE scope = ? AND name = ? AND version = ?
                """,
                (status, scope, name, version),
            )
        elif set_revoked:
            self._conn.execute(
                """
                UPDATE secret_versions
                SET status = ?, revoked_at = datetime('now')
                WHERE scope = ? AND name = ? AND version = ?
                """,
                (status, scope, name, version),
            )
        else:
            self._conn.execute(
                """
                UPDATE secret_versions SET status = ?
                WHERE scope = ? AND name = ? AND version = ?
                """,
                (status, scope, name, version),
            )

    def clear_previous_if(self, scope: str, name: str, previous_version: int) -> None:
        self._conn.execute(
            """
            UPDATE secret_heads SET previous_version = NULL, updated_at = datetime('now')
            WHERE scope = ? AND name = ? AND previous_version = ?
            """,
            (scope, name, previous_version),
        )

    def list_versions(self, scope: str, name: str) -> list[SecretVersionRecord]:
        rows = self._conn.execute(
            """
            SELECT name, version, status, created_at, activated_at, revoked_at,
                   ciphertext, key_id, request_id
            FROM secret_versions WHERE scope = ? AND name = ? ORDER BY version DESC
            """,
            (scope, name),
        ).fetchall()
        return [self._row_to_version(row) for row in rows]

    def insert_audit(
        self,
        *,
        scope: str,
        name: str,
        version: int | None,
        event_type: str,
        outcome: str,
        actor: str,
        reason: str | None,
        metadata: str,
    ) -> None:
        self._conn.execute(
            """
            INSERT INTO secret_audit_events
                (event_id, scope, name, version, event_type, outcome, actor, reason, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                scope,
                name,
                version,
                event_type,
                outcome,
                actor,
                reason,
                metadata,
            ),
        )

    def list_audit(self, scope: str, name: str, limit: int) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT event_id, name, version, event_type, outcome, actor, reason, metadata, created_at
            FROM secret_audit_events
            WHERE scope = ? AND name = ? ORDER BY id DESC LIMIT ?
            """,
            (scope, name, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    @staticmethod
    def _row_to_version(row: Any) -> SecretVersionRecord:
        return SecretVersionRecord(
            name=row["name"],
            version=int(row["version"]),
            status=row["status"],
            created_at=row["created_at"],
            activated_at=row["activated_at"],
            revoked_at=row["revoked_at"],
            ciphertext=row["ciphertext"],
            key_id=row["key_id"],
            request_id=row["request_id"] if "request_id" in row.keys() else None,
        )


class MemorySecretStoreBackend(SecretStoreBackend):
    """Process-local backend for tests and dependency-free fakes.

    Holds an exclusive lock for the duration of each transaction so concurrent
    callers surface ``BackendBusyError`` instead of corrupting state.
    """

    kind = "memory"

    def __init__(self, *, lock_timeout_seconds: float = 0.05) -> None:
        self._lock = threading.Lock()
        self._lock_timeout = lock_timeout_seconds
        self._in_tx = False
        self._versions: dict[tuple[str, str, int], dict[str, Any]] = {}
        self._by_request: dict[tuple[str, str, str], int] = {}
        self._heads: dict[tuple[str, str], dict[str, Any]] = {}
        self._audit: list[dict[str, Any]] = []
        self._snapshot: dict[str, Any] | None = None

    def begin_immediate(self) -> None:
        acquired = self._lock.acquire(timeout=self._lock_timeout)
        if not acquired:
            raise BackendBusyError("secret store is busy; retry the idempotent operation")
        if self._in_tx:
            self._lock.release()
            raise BackendBusyError("secret store is busy; retry the idempotent operation")
        self._snapshot = {
            "versions": copy.deepcopy(self._versions),
            "by_request": copy.deepcopy(self._by_request),
            "heads": copy.deepcopy(self._heads),
            "audit": copy.deepcopy(self._audit),
        }
        self._in_tx = True

    def commit(self) -> None:
        if not self._in_tx:
            return
        self._in_tx = False
        self._snapshot = None
        self._lock.release()

    def rollback(self) -> None:
        if not self._in_tx:
            return
        assert self._snapshot is not None
        self._versions = self._snapshot["versions"]
        self._by_request = self._snapshot["by_request"]
        self._heads = self._snapshot["heads"]
        self._audit = self._snapshot["audit"]
        self._in_tx = False
        self._snapshot = None
        self._lock.release()

    def get_version_by_request_id(
        self, scope: str, name: str, request_id: str
    ) -> SecretVersionRecord | None:
        version = self._by_request.get((scope, name, request_id))
        if version is None:
            return None
        return self.get_version(scope, name, version)

    def next_version_number(self, scope: str, name: str) -> int:
        versions = [v for (s, n, v) in self._versions if s == scope and n == name]
        return (max(versions) if versions else 0) + 1

    def insert_version(
        self,
        *,
        scope: str,
        name: str,
        version: int,
        ciphertext: str,
        key_id: str,
        status: str,
        request_id: str,
    ) -> None:
        key = (scope, name, version)
        if key in self._versions:
            raise ValueError("duplicate secret version")
        now = _utcnow()
        self._versions[key] = {
            "name": name,
            "version": version,
            "status": status,
            "created_at": now,
            "activated_at": None,
            "revoked_at": None,
            "ciphertext": ciphertext,
            "key_id": key_id,
            "request_id": request_id,
        }
        self._by_request[(scope, name, request_id)] = version

    def get_version(self, scope: str, name: str, version: int) -> SecretVersionRecord | None:
        raw = self._versions.get((scope, name, version))
        if raw is None:
            return None
        return SecretVersionRecord(**raw)

    def get_head(self, scope: str, name: str) -> SecretHeadRecord | None:
        raw = self._heads.get((scope, name))
        if raw is None:
            return None
        return SecretHeadRecord(
            active_version=int(raw["active_version"]),
            previous_version=raw["previous_version"],
            generation=int(raw["generation"]),
        )

    def insert_head(self, scope: str, name: str, active_version: int) -> None:
        self._heads[(scope, name)] = {
            "active_version": active_version,
            "previous_version": None,
            "generation": 1,
        }

    def update_head(
        self,
        scope: str,
        name: str,
        *,
        active_version: int,
        previous_version: int | None,
    ) -> None:
        head = self._heads[(scope, name)]
        head["active_version"] = active_version
        head["previous_version"] = previous_version
        head["generation"] = int(head["generation"]) + 1

    def set_version_status(
        self,
        scope: str,
        name: str,
        version: int,
        status: str,
        *,
        set_activated: bool = False,
        set_revoked: bool = False,
        clear_revoked: bool = False,
    ) -> None:
        raw = self._versions[(scope, name, version)]
        raw["status"] = status
        if set_activated:
            raw["activated_at"] = _utcnow()
        if clear_revoked:
            raw["revoked_at"] = None
        if set_revoked:
            raw["revoked_at"] = _utcnow()

    def clear_previous_if(self, scope: str, name: str, previous_version: int) -> None:
        head = self._heads.get((scope, name))
        if head and head.get("previous_version") == previous_version:
            head["previous_version"] = None

    def list_versions(self, scope: str, name: str) -> list[SecretVersionRecord]:
        rows = [
            SecretVersionRecord(**raw)
            for (s, n, _v), raw in self._versions.items()
            if s == scope and n == name
        ]
        rows.sort(key=lambda r: r.version, reverse=True)
        return rows

    def insert_audit(
        self,
        *,
        scope: str,
        name: str,
        version: int | None,
        event_type: str,
        outcome: str,
        actor: str,
        reason: str | None,
        metadata: str,
    ) -> None:
        self._audit.append(
            {
                "event_id": str(uuid.uuid4()),
                "scope": scope,
                "name": name,
                "version": version,
                "event_type": event_type,
                "outcome": outcome,
                "actor": actor,
                "reason": reason,
                "metadata": metadata,
                "created_at": _utcnow(),
            }
        )

    def list_audit(self, scope: str, name: str, limit: int) -> list[dict[str, Any]]:
        rows = [row for row in self._audit if row["scope"] == scope and row["name"] == name]
        rows = list(reversed(rows))[:limit]
        return [
            {
                "event_id": r["event_id"],
                "name": r["name"],
                "version": r["version"],
                "event_type": r["event_type"],
                "outcome": r["outcome"],
                "actor": r["actor"],
                "reason": r["reason"],
                "metadata": r["metadata"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]


def normalize_backend_kind(raw: str | None) -> str:
    """Validate and normalize a backend kind string."""
    kind = (raw or "sqlite").strip().lower()
    if kind not in _SUPPORTED:
        supported = ", ".join(sorted(_SUPPORTED))
        raise ValueError(f"unsupported secret-store backend {kind!r}; expected one of: {supported}")
    return kind


def create_secret_store_backend(
    kind: str | None = "sqlite",
    *,
    db: Any | None = None,
) -> SecretStoreBackend:
    """Construct a backend by kind. ``sqlite`` requires ``db``; ``memory`` ignores it."""
    normalized = normalize_backend_kind(kind)
    if normalized == "sqlite":
        return SqliteSecretStoreBackend(db)
    return MemorySecretStoreBackend()


def supported_secret_store_backends() -> frozenset[str]:
    return _SUPPORTED


__all__ = [
    "BackendBusyError",
    "MemorySecretStoreBackend",
    "SecretHeadRecord",
    "SecretStoreBackend",
    "SecretVersionRecord",
    "SqliteSecretStoreBackend",
    "create_secret_store_backend",
    "normalize_backend_kind",
    "supported_secret_store_backends",
]
