"""Versioned encrypted secret storage with transactional activation.

Plaintext exists only in caller memory and is never persisted or included in
logs/audit events. Persistence is delegated to a pluggable ``SecretStoreBackend``
(``sqlite`` by default, ``memory`` for tests/fakes). SQLite transactions provide
cross-process compare-and-swap semantics; no correctness decision relies on
process-local state when using the sqlite backend.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Mapping

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from talos_agent.observability import log
from talos_agent.secret_store_backends import (
    BackendBusyError,
    SecretStoreBackend,
    SecretVersionRecord,
    create_secret_store_backend,
)

_ENVELOPE_PREFIX = "TALOS-SECRET::1::"
_NAME_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,127}$")
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_REASON_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_MAX_HARD_LIMIT = 1024 * 1024
_ACTIVATABLE = {"staged", "superseded"}


class SecretStoreError(Exception):
    """Base class for errors safe to report without sensitive context."""


class SecretConfigurationError(SecretStoreError):
    pass


class SecretValidationError(SecretStoreError):
    pass


class SecretNotFoundError(SecretStoreError):
    pass


class SecretConflictError(SecretStoreError):
    pass


class SecretBusyError(SecretStoreError):
    pass


class SecretDecryptionError(SecretStoreError):
    pass


class ActiveSecretRevocationError(SecretStoreError):
    pass


@dataclass(frozen=True)
class SecretVersion:
    name: str
    version: int
    status: str
    created_at: str
    activated_at: str | None
    revoked_at: str | None


@dataclass(frozen=True)
class SecretResolution:
    value: str
    source: str
    version: int | None = None


@dataclass(frozen=True)
class SecretRollbackCheckpoint:
    """Named snapshot of a secret head for safe rotation rollback."""

    name: str
    checkpoint_id: str
    active_version: int
    previous_version: int | None
    generation: int
    status: str
    created_at: str
    restored_at: str | None
    discarded_at: str | None


def decode_keyring(raw: str | Mapping[str, str]) -> dict[str, bytes]:
    """Decode and validate a key-id -> URL-safe-base64 AES-256 key mapping."""
    if isinstance(raw, str):
        if not raw.strip():
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SecretConfigurationError("TALOS_SECRET_KEYRING must be valid JSON") from exc
    else:
        parsed = dict(raw)
    if not isinstance(parsed, dict) or len(parsed) > 32:
        raise SecretConfigurationError("secret keyring must be an object with at most 32 keys")

    result: dict[str, bytes] = {}
    for key_id, encoded in parsed.items():
        if not isinstance(key_id, str) or not _NAME_RE.fullmatch(key_id):
            raise SecretConfigurationError("secret key IDs must use lowercase safe identifiers")
        if not isinstance(encoded, str) or len(encoded) > 128:
            raise SecretConfigurationError("keyring contains an invalid encoded key")
        try:
            padded = encoded + "=" * (-len(encoded) % 4)
            key = base64.urlsafe_b64decode(padded.encode("ascii"))
        except (ValueError, UnicodeEncodeError, binascii.Error) as exc:
            raise SecretConfigurationError("keyring contains invalid base64") from exc
        if len(key) != 32:
            raise SecretConfigurationError("every keyring key must contain exactly 32 bytes")
        result[key_id] = key
    return result


class SecretStore:
    """Encrypted versions and atomic lifecycle transitions for one scope."""

    def __init__(
        self,
        db=None,
        *,
        keyring: Mapping[str, bytes],
        active_key_id: str,
        scope: str = "default",
        max_value_bytes: int = 65536,
        dual_read: bool = True,
        legacy_fallback: bool = True,
        backend: SecretStoreBackend | None = None,
    ) -> None:
        if backend is None:
            if db is None:
                raise SecretConfigurationError("secret store requires db or backend")
            backend = create_secret_store_backend("sqlite", db=db)
        self._backend = backend
        self._keyring = dict(keyring)
        self._active_key_id = active_key_id
        self._scope = self._validate_identifier(scope, "scope")
        self._max_value_bytes = min(max(max_value_bytes, 1), _MAX_HARD_LIMIT)
        self._dual_read = dual_read
        self._legacy_fallback = legacy_fallback
        if active_key_id not in self._keyring:
            raise SecretConfigurationError("active secret key ID is missing from the keyring")

    @property
    def backend_kind(self) -> str:
        return getattr(self._backend, "kind", "unknown")

    @staticmethod
    def _validate_identifier(value: str, label: str) -> str:
        if not isinstance(value, str) or not _NAME_RE.fullmatch(value):
            raise SecretValidationError(
                f"{label} must match {_NAME_RE.pattern} and be at most 128 characters"
            )
        return value

    def _validate_value(self, value: str) -> bytes:
        if not isinstance(value, str):
            raise SecretValidationError("secret value must be a string")
        encoded = value.encode("utf-8")
        if not encoded:
            raise SecretValidationError("secret value cannot be empty")
        if len(encoded) > self._max_value_bytes:
            raise SecretValidationError(
                f"secret value exceeds configured {self._max_value_bytes}-byte limit"
            )
        return encoded

    def _aad(self, name: str, version: int, key_id: str) -> bytes:
        return json.dumps(
            {
                "format": 1,
                "scope": self._scope,
                "name": name,
                "version": version,
                "key_id": key_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")

    def _encrypt(self, name: str, version: int, plaintext: bytes) -> str:
        import os

        nonce = os.urandom(12)
        key = self._keyring[self._active_key_id]
        ciphertext = AESGCM(key).encrypt(
            nonce, plaintext, self._aad(name, version, self._active_key_id)
        )
        return _ENVELOPE_PREFIX + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")

    def _decrypt(self, row: SecretVersionRecord) -> str:
        key_id = row.key_id
        key = self._keyring.get(key_id)
        if key is None:
            raise SecretDecryptionError("encryption key is unavailable")
        envelope = row.ciphertext
        if not isinstance(envelope, str) or not envelope.startswith(_ENVELOPE_PREFIX):
            raise SecretDecryptionError("unsupported encrypted envelope")
        try:
            raw = base64.b64decode(
                envelope[len(_ENVELOPE_PREFIX) :],
                altchars=b"-_",
                validate=True,
            )
            if len(raw) < 12 + 16:
                raise ValueError("short envelope")
            plaintext = AESGCM(key).decrypt(
                raw[:12],
                raw[12:],
                self._aad(row.name, row.version, key_id),
            )
            return plaintext.decode("utf-8")
        except Exception as exc:
            raise SecretDecryptionError("secret envelope authentication failed") from exc

    def _audit(
        self,
        *,
        name: str,
        version: int | None,
        event_type: str,
        outcome: str,
        actor: str,
        reason: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> None:
        if not _REQUEST_ID_RE.fullmatch(actor):
            raise SecretValidationError("actor must be a safe identifier of at most 128 characters")
        if reason is not None and not _REASON_RE.fullmatch(reason):
            raise SecretValidationError("reason must be a lowercase reason code of at most 64 characters")
        safe_metadata = json.dumps(dict(metadata or {}), sort_keys=True)
        if len(safe_metadata.encode("utf-8")) > 2048:
            raise SecretValidationError("audit metadata exceeds 2048-byte limit")
        self._backend.insert_audit(
            scope=self._scope,
            name=name,
            version=version,
            event_type=event_type,
            outcome=outcome,
            actor=actor,
            reason=reason,
            metadata=safe_metadata,
        )

    def _transition_log(
        self, name: str, version: int | None, transition: str, outcome: str, error: Exception | None = None
    ) -> None:
        fields = {
            "scope": self._scope,
            "secret_name": name,
            "secret_version": version,
            "transition": transition,
            "outcome": outcome,
            "backend": self.backend_kind,
        }
        try:
            if error is not None:
                fields["error_type"] = type(error).__name__
                log.warning("secret_rotation_transition", **fields)
            else:
                log.info("secret_rotation_transition", **fields)
        except Exception:
            # Logging must never change a committed secret transition.
            pass

    @staticmethod
    def _map_busy(exc: Exception) -> Exception | None:
        if isinstance(exc, BackendBusyError):
            return SecretBusyError("secret store is busy; retry the idempotent operation")
        if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
            return SecretBusyError("secret store is busy; retry the idempotent operation")
        return None

    def stage(
        self,
        name: str,
        value: str,
        *,
        request_id: str,
        actor: str = "operator",
        reason: str | None = None,
    ) -> SecretVersion:
        """Persist one encrypted staged version; duplicate request IDs are idempotent."""
        name = self._validate_identifier(name, "secret name")
        plaintext = self._validate_value(value)
        if not isinstance(request_id, str) or not _REQUEST_ID_RE.fullmatch(request_id):
            raise SecretValidationError("request ID must be a safe identifier of at most 128 characters")
        try:
            self._backend.begin_immediate()
            existing = self._backend.get_version_by_request_id(self._scope, name, request_id)
            if existing:
                self._backend.commit()
                return self._public_version(existing)
            version = self._backend.next_version_number(self._scope, name)
            ciphertext = self._encrypt(name, version, plaintext)
            self._backend.insert_version(
                scope=self._scope,
                name=name,
                version=version,
                ciphertext=ciphertext,
                key_id=self._active_key_id,
                status="staged",
                request_id=request_id,
            )
            self._audit(
                name=name,
                version=version,
                event_type="staged",
                outcome="success",
                actor=actor,
                reason=reason,
            )
            result_row = self._backend.get_version(self._scope, name, version)
            assert result_row is not None
            self._backend.commit()
            result = self._public_version(result_row)
            self._transition_log(name, version, "stage", "success")
            return result
        except Exception as exc:
            self._backend.rollback()
            self._transition_log(name, None, "stage", "failure", exc)
            busy = self._map_busy(exc)
            if busy is not None:
                raise busy from exc
            raise

    def current_version(self, name: str) -> int | None:
        name = self._validate_identifier(name, "secret name")
        head = self._backend.get_head(self._scope, name)
        return int(head.active_version) if head else None

    def activate(
        self,
        name: str,
        version: int,
        *,
        expected_active_version: int | None,
        actor: str = "operator",
        reason: str | None = None,
        event_type: str = "activated",
        checkpoint_request_id: str | None = None,
    ) -> SecretVersion:
        """Atomically activate a version if the caller's head is still current.

        When ``checkpoint_request_id`` is set, a rollback checkpoint of the
        pre-activation head is recorded in the same transaction.
        """
        name = self._validate_identifier(name, "secret name")
        if version < 1:
            raise SecretValidationError("version must be positive")
        if checkpoint_request_id is not None and (
            not isinstance(checkpoint_request_id, str)
            or not _REQUEST_ID_RE.fullmatch(checkpoint_request_id)
        ):
            raise SecretValidationError(
                "checkpoint request ID must be a safe identifier of at most 128 characters"
            )
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            head = self._conn.execute(
                "SELECT active_version, previous_version, generation "
                "FROM secret_heads WHERE scope = ? AND name = ?",
                (self._scope, name),
            ).fetchone()
            actual = int(head["active_version"]) if head else None
            self._backend.begin_immediate()
            head = self._backend.get_head(self._scope, name)
            actual = int(head.active_version) if head else None
            if actual == version:
                self._backend.commit()
                row = self._require_version(name, version)
                return self._public_version(row)
            if actual != expected_active_version:
                raise SecretConflictError(
                    f"active version changed: expected {expected_active_version}, found {actual}"
                )
            if checkpoint_request_id is not None:
                if actual is None:
                    raise SecretValidationError(
                        "cannot create a rollback checkpoint before the first activation"
                    )
                self._insert_rollback_checkpoint_unlocked(
                    name,
                    active_version=actual,
                    previous_version=int(head["previous_version"])
                    if head["previous_version"] is not None
                    else None,
                    generation=int(head["generation"]),
                    request_id=checkpoint_request_id,
                    actor=actor,
                    reason=reason,
                    checkpoint_id=None,
                )
            target = self._get_version_row(name, version)
            if target["status"] not in _ACTIVATABLE:
            target = self._require_version(name, version)
            if target.status not in _ACTIVATABLE:
                raise SecretConflictError(
                    f"version {version} cannot be activated from state {target.status}"
                )
            # Prove the target can be decrypted before changing the head.
            self._decrypt(target)
            if actual is not None:
                self._backend.set_version_status(
                    self._scope, name, actual, "superseded"
                )
            self._backend.set_version_status(
                self._scope,
                name,
                version,
                "active",
                set_activated=True,
                clear_revoked=True,
            )
            if head:
                self._backend.update_head(
                    self._scope,
                    name,
                    active_version=version,
                    previous_version=actual,
                )
            else:
                self._backend.insert_head(self._scope, name, version)
            self._audit(
                name=name,
                version=version,
                event_type=event_type,
                outcome="success",
                actor=actor,
                reason=reason,
                metadata={"previous_version": actual},
            )
            row = self._require_version(name, version)
            self._backend.commit()
            result = self._public_version(row)
            self._transition_log(name, version, event_type, "success")
            return result
        except Exception as exc:
            self._backend.rollback()
            self._transition_log(name, version, event_type, "failure", exc)
            busy = self._map_busy(exc)
            if busy is not None:
                raise busy from exc
            raise

    def recover(
        self,
        name: str,
        version: int,
        *,
        expected_active_version: int,
        actor: str = "operator",
        reason: str | None = None,
    ) -> SecretVersion:
        return self.activate(
            name,
            version,
            expected_active_version=expected_active_version,
            actor=actor,
            reason=reason,
            event_type="recovered",
        )

    def revoke(
        self,
        name: str,
        version: int,
        *,
        actor: str = "operator",
        reason: str | None = None,
    ) -> SecretVersion:
        """Revoke a non-active version. Active revocation is deliberately rejected."""
        name = self._validate_identifier(name, "secret name")
        try:
            self._backend.begin_immediate()
            row = self._require_version(name, version)
            if row.status == "revoked":
                self._backend.commit()
                return self._public_version(row)
            head = self._backend.get_head(self._scope, name)
            if head and int(head.active_version) == version:
                raise ActiveSecretRevocationError(
                    "cannot revoke the active version; activate or recover another version first"
                )
            self._backend.set_version_status(
                self._scope, name, version, "revoked", set_revoked=True
            )
            self._backend.clear_previous_if(self._scope, name, version)
            self._audit(
                name=name,
                version=version,
                event_type="revoked",
                outcome="success",
                actor=actor,
                reason=reason,
            )
            updated = self._require_version(name, version)
            self._backend.commit()
            result = self._public_version(updated)
            self._transition_log(name, version, "revoke", "success")
            return result
        except Exception as exc:
            self._backend.rollback()
            self._transition_log(name, version, "revoke", "failure", exc)
            busy = self._map_busy(exc)
            if busy is not None:
                raise busy from exc
            raise


    def _public_checkpoint(self, row: sqlite3.Row) -> SecretRollbackCheckpoint:
        return SecretRollbackCheckpoint(
            name=row["name"],
            checkpoint_id=row["checkpoint_id"],
            active_version=int(row["active_version"]),
            previous_version=int(row["previous_version"])
            if row["previous_version"] is not None
            else None,
            generation=int(row["generation"]),
            status=row["status"],
            created_at=row["created_at"],
            restored_at=row["restored_at"],
            discarded_at=row["discarded_at"],
        )

    def _insert_rollback_checkpoint_unlocked(
        self,
        name: str,
        *,
        active_version: int,
        previous_version: int | None,
        generation: int,
        request_id: str,
        actor: str,
        reason: str | None,
        checkpoint_id: str | None,
    ) -> SecretRollbackCheckpoint:
        """Insert or return an idempotent checkpoint. Caller holds the transaction."""
        existing = self._conn.execute(
            """
            SELECT name, checkpoint_id, active_version, previous_version, generation,
                   status, created_at, restored_at, discarded_at
            FROM secret_rollback_checkpoints
            WHERE scope = ? AND name = ? AND request_id = ?
            """,
            (self._scope, name, request_id),
        ).fetchone()
        if existing:
            return self._public_checkpoint(existing)

        cid = checkpoint_id or str(uuid.uuid4())
        if not _REQUEST_ID_RE.fullmatch(cid):
            raise SecretValidationError(
                "checkpoint ID must be a safe identifier of at most 128 characters"
            )
        self._conn.execute(
            """
            INSERT INTO secret_rollback_checkpoints
                (scope, name, checkpoint_id, active_version, previous_version,
                 generation, request_id, actor, reason, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
            """,
            (
                self._scope,
                name,
                cid,
                active_version,
                previous_version,
                generation,
                request_id,
                actor,
                reason,
            ),
        )
        self._audit(
            name=name,
            version=active_version,
            event_type="checkpoint_created",
            outcome="success",
            actor=actor,
            reason=reason,
            metadata={
                "checkpoint_id": cid,
                "previous_version": previous_version,
                "generation": generation,
            },
        )
        row = self._conn.execute(
            """
            SELECT name, checkpoint_id, active_version, previous_version, generation,
                   status, created_at, restored_at, discarded_at
            FROM secret_rollback_checkpoints
            WHERE scope = ? AND name = ? AND checkpoint_id = ?
            """,
            (self._scope, name, cid),
        ).fetchone()
        return self._public_checkpoint(row)

    def create_rollback_checkpoint(
        self,
        name: str,
        *,
        request_id: str,
        actor: str = "operator",
        reason: str | None = None,
        checkpoint_id: str | None = None,
    ) -> SecretRollbackCheckpoint:
        """Snapshot the current secret head for a later CAS rollback."""
        name = self._validate_identifier(name, "secret name")
        if not isinstance(request_id, str) or not _REQUEST_ID_RE.fullmatch(request_id):
            raise SecretValidationError(
                "request ID must be a safe identifier of at most 128 characters"
            )
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            head = self._conn.execute(
                """
                SELECT active_version, previous_version, generation
                FROM secret_heads WHERE scope = ? AND name = ?
                """,
                (self._scope, name),
            ).fetchone()
            if not head:
                raise SecretNotFoundError(f"no active head for secret {name!r}")
            result = self._insert_rollback_checkpoint_unlocked(
                name,
                active_version=int(head["active_version"]),
                previous_version=int(head["previous_version"])
                if head["previous_version"] is not None
                else None,
                generation=int(head["generation"]),
                request_id=request_id,
                actor=actor,
                reason=reason,
                checkpoint_id=checkpoint_id,
            )
            self._conn.commit()
            self._transition_log(name, result.active_version, "checkpoint_created", "success")
            return result
        except Exception as exc:
            self._conn.rollback()
            self._transition_log(name, None, "checkpoint_created", "failure", exc)
            if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
                raise SecretBusyError(
                    "secret store is busy; retry the idempotent operation"
                ) from exc
            raise

    def list_rollback_checkpoints(self, name: str) -> list[SecretRollbackCheckpoint]:
        name = self._validate_identifier(name, "secret name")
        rows = self._conn.execute(
            """
            SELECT name, checkpoint_id, active_version, previous_version, generation,
                   status, created_at, restored_at, discarded_at
            FROM secret_rollback_checkpoints
            WHERE scope = ? AND name = ?
            ORDER BY created_at DESC, checkpoint_id DESC
            """,
            (self._scope, name),
        ).fetchall()
        return [self._public_checkpoint(row) for row in rows]

    def discard_rollback_checkpoint(
        self,
        name: str,
        checkpoint_id: str,
        *,
        actor: str = "operator",
        reason: str | None = None,
    ) -> SecretRollbackCheckpoint:
        """Mark an open checkpoint as discarded so it cannot be restored."""
        name = self._validate_identifier(name, "secret name")
        if not isinstance(checkpoint_id, str) or not _REQUEST_ID_RE.fullmatch(checkpoint_id):
            raise SecretValidationError(
                "checkpoint ID must be a safe identifier of at most 128 characters"
            )
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            row = self._conn.execute(
                """
                SELECT name, checkpoint_id, active_version, previous_version, generation,
                       status, created_at, restored_at, discarded_at
                FROM secret_rollback_checkpoints
                WHERE scope = ? AND name = ? AND checkpoint_id = ?
                """,
                (self._scope, name, checkpoint_id),
            ).fetchone()
            if not row:
                raise SecretNotFoundError(f"checkpoint {checkpoint_id!r} does not exist")
            if row["status"] == "discarded":
                self._conn.commit()
                return self._public_checkpoint(row)
            if row["status"] != "open":
                raise SecretConflictError(
                    f"checkpoint {checkpoint_id!r} cannot be discarded from state {row['status']}"
                )
            self._conn.execute(
                """
                UPDATE secret_rollback_checkpoints
                SET status = 'discarded', discarded_at = datetime('now')
                WHERE scope = ? AND name = ? AND checkpoint_id = ?
                """,
                (self._scope, name, checkpoint_id),
            )
            self._audit(
                name=name,
                version=int(row["active_version"]),
                event_type="checkpoint_discarded",
                outcome="success",
                actor=actor,
                reason=reason,
                metadata={"checkpoint_id": checkpoint_id},
            )
            updated = self._conn.execute(
                """
                SELECT name, checkpoint_id, active_version, previous_version, generation,
                       status, created_at, restored_at, discarded_at
                FROM secret_rollback_checkpoints
                WHERE scope = ? AND name = ? AND checkpoint_id = ?
                """,
                (self._scope, name, checkpoint_id),
            ).fetchone()
            self._conn.commit()
            result = self._public_checkpoint(updated)
            self._transition_log(
                name, result.active_version, "checkpoint_discarded", "success"
            )
            return result
        except Exception as exc:
            self._conn.rollback()
            self._transition_log(name, None, "checkpoint_discarded", "failure", exc)
            if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
                raise SecretBusyError(
                    "secret store is busy; retry the idempotent operation"
                ) from exc
            raise

    def rollback_to_checkpoint(
        self,
        name: str,
        checkpoint_id: str,
        *,
        expected_active_version: int,
        actor: str = "operator",
        reason: str | None = None,
    ) -> SecretVersion:
        """Restore the secret head captured by an open rollback checkpoint (CAS)."""
        name = self._validate_identifier(name, "secret name")
        if not isinstance(checkpoint_id, str) or not _REQUEST_ID_RE.fullmatch(checkpoint_id):
            raise SecretValidationError(
                "checkpoint ID must be a safe identifier of at most 128 characters"
            )
        if expected_active_version < 1:
            raise SecretValidationError("expected active version must be positive")
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            checkpoint = self._conn.execute(
                """
                SELECT name, checkpoint_id, active_version, previous_version, generation,
                       status, created_at, restored_at, discarded_at
                FROM secret_rollback_checkpoints
                WHERE scope = ? AND name = ? AND checkpoint_id = ?
                """,
                (self._scope, name, checkpoint_id),
            ).fetchone()
            if not checkpoint:
                raise SecretNotFoundError(f"checkpoint {checkpoint_id!r} does not exist")
            if checkpoint["status"] == "discarded":
                raise SecretConflictError(
                    f"checkpoint {checkpoint_id!r} has been discarded"
                )

            head = self._conn.execute(
                """
                SELECT active_version, previous_version, generation
                FROM secret_heads WHERE scope = ? AND name = ?
                """,
                (self._scope, name),
            ).fetchone()
            actual = int(head["active_version"]) if head else None
            target_version = int(checkpoint["active_version"])
            target_previous = (
                int(checkpoint["previous_version"])
                if checkpoint["previous_version"] is not None
                else None
            )

            head_previous = (
                int(head["previous_version"])
                if head is not None and head["previous_version"] is not None
                else None
            )
            # Idempotent: already restored to the checkpointed head.
            if (
                checkpoint["status"] == "restored"
                and actual == target_version
                and head_previous == target_previous
            ):
                self._conn.commit()
                return self._public_version(self._get_version_row(name, target_version))

            if checkpoint["status"] == "restored":
                raise SecretConflictError(
                    f"checkpoint {checkpoint_id!r} was restored but the head has moved"
                )
            if checkpoint["status"] != "open":
                raise SecretConflictError(
                    f"checkpoint {checkpoint_id!r} cannot be restored from state {checkpoint['status']}"
                )
            if actual != expected_active_version:
                raise SecretConflictError(
                    f"active version changed: expected {expected_active_version}, found {actual}"
                )

            target = self._get_version_row(name, target_version)
            if target["status"] == "revoked":
                raise SecretConflictError(
                    f"checkpoint target version {target_version} is revoked"
                )
            if target["status"] not in (_ACTIVATABLE | {"active"}):
                raise SecretConflictError(
                    f"version {target_version} cannot be restored from state {target['status']}"
                )
            self._decrypt(target)
            if target_previous is not None:
                prev_row = self._get_version_row(name, target_previous)
                if prev_row["status"] == "revoked":
                    raise SecretConflictError(
                        f"checkpoint previous version {target_previous} is revoked"
                    )

            if actual is not None and actual != target_version:
                self._conn.execute(
                    """
                    UPDATE secret_versions SET status = 'superseded'
                    WHERE scope = ? AND name = ? AND version = ? AND status = 'active'
                    """,
                    (self._scope, name, actual),
                )
            self._conn.execute(
                """
                UPDATE secret_versions
                SET status = 'active',
                    activated_at = COALESCE(activated_at, datetime('now')),
                    revoked_at = NULL
                WHERE scope = ? AND name = ? AND version = ?
                """,
                (self._scope, name, target_version),
            )
            if target_previous is not None:
                self._conn.execute(
                    """
                    UPDATE secret_versions
                    SET status = 'superseded', revoked_at = NULL
                    WHERE scope = ? AND name = ? AND version = ? AND status != 'revoked'
                    """,
                    (self._scope, name, target_previous),
                )

            if head:
                self._conn.execute(
                    """
                    UPDATE secret_heads
                    SET active_version = ?, previous_version = ?,
                        generation = generation + 1, updated_at = datetime('now')
                    WHERE scope = ? AND name = ?
                    """,
                    (target_version, target_previous, self._scope, name),
                )
            else:
                self._conn.execute(
                    """
                    INSERT INTO secret_heads (scope, name, active_version, previous_version)
                    VALUES (?, ?, ?, ?)
                    """,
                    (self._scope, name, target_version, target_previous),
                )

            self._conn.execute(
                """
                UPDATE secret_rollback_checkpoints
                SET status = 'restored', restored_at = datetime('now')
                WHERE scope = ? AND name = ? AND checkpoint_id = ?
                """,
                (self._scope, name, checkpoint_id),
            )
            self._audit(
                name=name,
                version=target_version,
                event_type="checkpoint_restored",
                outcome="success",
                actor=actor,
                reason=reason,
                metadata={
                    "checkpoint_id": checkpoint_id,
                    "previous_version": target_previous,
                    "from_version": actual,
                },
            )
            row = self._get_version_row(name, target_version)
            self._conn.commit()
            result = self._public_version(row)
            self._transition_log(name, target_version, "checkpoint_restored", "success")
            return result
        except Exception as exc:
            self._conn.rollback()
            self._transition_log(name, None, "checkpoint_restored", "failure", exc)
            if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
                raise SecretBusyError(
                    "secret store is busy; retry the idempotent operation"
                ) from exc
            raise

    def _get_version_row(self, name: str, version: int) -> sqlite3.Row:
        row = self._conn.execute(
            """
            SELECT name, version, status, created_at, activated_at, revoked_at,
                   ciphertext, key_id
            FROM secret_versions WHERE scope = ? AND name = ? AND version = ?
            """,
            (self._scope, name, version),
        ).fetchone()
    def _require_version(self, name: str, version: int) -> SecretVersionRecord:
        row = self._backend.get_version(self._scope, name, version)
        if not row:
            raise SecretNotFoundError(f"secret version {version} does not exist")
        return row

    @staticmethod
    def _public_version(row: SecretVersionRecord) -> SecretVersion:
        return SecretVersion(
            name=row.name,
            version=int(row.version),
            status=row.status,
            created_at=row.created_at,
            activated_at=row.activated_at,
            revoked_at=row.revoked_at,
        )

    def resolve(self, name: str, legacy_value: str = "") -> SecretResolution:
        """Resolve active -> previous -> legacy according to rollout configuration."""
        name = self._validate_identifier(name, "secret name")
        head = self._backend.get_head(self._scope, name)
        candidates: list[tuple[str, int]] = []
        if head:
            candidates.append(("active", int(head.active_version)))
            if self._dual_read and head.previous_version is not None:
                candidates.append(("previous", int(head.previous_version)))

        last_error: Exception | None = None
        for source, version in candidates:
            try:
                row = self._require_version(name, version)
                if row.status == "revoked":
                    continue
                return SecretResolution(self._decrypt(row), source, version)
            except (SecretNotFoundError, SecretDecryptionError) as exc:
                last_error = exc
                log.warning(
                    "secret_resolution",
                    scope=self._scope,
                    secret_name=name,
                    secret_version=version,
                    source=source,
                    outcome="fallback",
                    error_type=type(exc).__name__,
                    backend=self.backend_kind,
                )
        if self._legacy_fallback and legacy_value:
            return SecretResolution(legacy_value, "legacy", None)
        if last_error:
            raise last_error
        raise SecretNotFoundError(f"no active value for secret {name!r}")

    def list_versions(self, name: str) -> list[SecretVersion]:
        name = self._validate_identifier(name, "secret name")
        rows = self._backend.list_versions(self._scope, name)
        return [self._public_version(row) for row in rows]

    def audit_events(self, name: str, limit: int = 50) -> list[dict]:
        name = self._validate_identifier(name, "secret name")
        bounded_limit = min(max(limit, 1), 500)
        return self._backend.list_audit(self._scope, name, bounded_limit)


def build_secret_store(
    *,
    backend: str | SecretStoreBackend = "sqlite",
    db=None,
    keyring: Mapping[str, bytes],
    active_key_id: str,
    scope: str = "default",
    max_value_bytes: int = 65536,
    dual_read: bool = True,
    legacy_fallback: bool = True,
) -> SecretStore:
    """Construct a ``SecretStore`` with an explicit backend kind or instance."""
    if isinstance(backend, SecretStoreBackend):
        resolved = backend
    else:
        resolved = create_secret_store_backend(backend, db=db)
    return SecretStore(
        backend=resolved,
        keyring=keyring,
        active_key_id=active_key_id,
        scope=scope,
        max_value_bytes=max_value_bytes,
        dual_read=dual_read,
        legacy_fallback=legacy_fallback,
    )


__all__ = [
    "ActiveSecretRevocationError",
    "SecretConfigurationError",
    "SecretBusyError",
    "SecretConflictError",
    "SecretDecryptionError",
    "SecretNotFoundError",
    "SecretResolution",
    "SecretRollbackCheckpoint",
    "SecretStore",
    "SecretStoreError",
    "SecretValidationError",
    "SecretVersion",
    "build_secret_store",
    "decode_keyring",
]
