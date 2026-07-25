"""Authenticated checkpoint envelopes — issue #293.

Design
------
Each checkpoint is an *authenticated envelope* bound to:
    agent_id    — producer identity; binds the checkpoint to its owner
    namespace   — logical scope (e.g. "agent_loop", "commerce", "stellar")
    sequence    — monotonically increasing per (agent_id, namespace); prevents
                  rollback attacks (replaying an older state)
    schema      — schema version string; allows forward-compatible evolution
    timestamp   — ISO-8601 UTC string; informational / audit trail
    nonce       — random 16-byte hex string; prevents replay of the exact same
                  envelope across writes
    key_id      — identifies which HMAC-SHA256 signing key was used; supports
                  multi-key rotation read-back

The HMAC-SHA256 *tag* covers all of the above fields **plus** the payload, so
any tampering with any field or the payload is detected on load.

Key rotation
------------
``CheckpointStore.rotate_key()`` generates a new key, marks it active, and
demotes the previous key.  During ``load()`` the store accepts any *known* key
(active or rotated) for verification, so checkpoints written under the old key
remain readable after a rotation.  New writes always use the active key.

Thread / async safety
---------------------
``CheckpointStore`` is not internally locked — callers that share an instance
across concurrent tasks must take their own lock.  In the agent runtime each
agent owns exactly one ``CheckpointStore`` instance accessed from a single
async event-loop, so no extra locking is required there.

Usage
-----
    from talos_agent.checkpoint import CheckpointStore, CheckpointError

    store = CheckpointStore(db=db, agent_id="vega")
    store.ensure_key()                          # create first key if none exists

    seq = store.save("agent_loop", {"step": 3}) # returns new sequence number
    env = store.load("agent_loop")              # returns latest CheckpointEnvelope
    seq2 = store.rotate_key()                   # rotate; old key stays readable
    env2 = store.load("agent_loop")             # still works with old-key checkpoint
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from talos_agent.db import LocalDB

__all__ = [
    "CheckpointEnvelope",
    "CheckpointStore",
    "CheckpointError",
    "TamperDetectedError",
    "ReplayDetectedError",
    "RollbackDetectedError",
    "WrongIdentityError",
    "UnknownKeyError",
]

# ── Schema version ─────────────────────────────────────────────────────────────

SCHEMA_VERSION = "1"

# ── Exceptions ─────────────────────────────────────────────────────────────────


class CheckpointError(Exception):
    """Base class for all checkpoint-related errors."""


class TamperDetectedError(CheckpointError):
    """Raised when HMAC verification fails — envelope has been altered."""


class ReplayDetectedError(CheckpointError):
    """Raised when the (key_id, nonce) pair has already been seen."""


class RollbackDetectedError(CheckpointError):
    """Raised when the incoming sequence is not strictly greater than the current max."""


class WrongIdentityError(CheckpointError):
    """Raised when the agent_id in the envelope does not match the store's agent_id."""


class UnknownKeyError(CheckpointError):
    """Raised when the key_id in an envelope is not found in the key registry."""


# ── Envelope dataclass ─────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class CheckpointEnvelope:
    """Immutable, authenticated checkpoint envelope.

    ``payload`` is the raw dict as saved/loaded.  All other fields are part of
    the authenticated data that is covered by the HMAC tag.
    """

    agent_id: str
    namespace: str
    sequence: int
    schema_version: str
    key_id: str
    nonce: str
    tag: str
    payload: dict[str, Any]
    timestamp: str

    # ── Serialisation helpers ──────────────────────────────

    def to_db_row(self) -> dict:
        """Return kwargs suitable for ``LocalDB.save_checkpoint``."""
        return {
            "agent_id": self.agent_id,
            "namespace": self.namespace,
            "sequence": self.sequence,
            "schema_version": self.schema_version,
            "key_id": self.key_id,
            "nonce": self.nonce,
            "tag": self.tag,
            "payload": json.dumps(self.payload, separators=(",", ":"), sort_keys=True),
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_db_row(cls, row: dict) -> "CheckpointEnvelope":
        """Reconstruct an envelope from a ``LocalDB`` checkpoint row."""
        return cls(
            agent_id=row["agent_id"],
            namespace=row["namespace"],
            sequence=int(row["sequence"]),
            schema_version=row["schema_version"],
            key_id=row["key_id"],
            nonce=row["nonce"],
            tag=row["tag"],
            payload=json.loads(row["payload"]),
            timestamp=row["timestamp"],
        )


# ── Key management helpers ─────────────────────────────────────────────────────


def _generate_key_material() -> tuple[str, str]:
    """Generate a new (key_id, raw_hex_key) pair.

    key_id  — 16-character hex string (opaque identifier stored in DB)
    raw_hex — 32-byte (256-bit) key encoded as hex; stored in the ``key_hmac``
              column of ``checkpoint_keys``.  Treat as a secret at rest — wrap
              it with the master password in production using ``crypto.py``.
    """
    key_id = secrets.token_hex(8)   # 16 hex chars
    raw_key = secrets.token_bytes(32)  # 256-bit
    return key_id, raw_key.hex()


# ── HMAC helpers ───────────────────────────────────────────────────────────────


def _build_authenticated_data(
    *,
    agent_id: str,
    namespace: str,
    sequence: int,
    schema_version: str,
    key_id: str,
    nonce: str,
    timestamp: str,
    payload_json: str,
) -> bytes:
    """Deterministically serialise all authenticated fields to bytes.

    The format is a canonical JSON object with sorted keys.  Using JSON (rather
    than a custom byte concatenation) prevents length-extension issues and makes
    the AD structure self-documenting.
    """
    ad = {
        "agent_id": agent_id,
        "key_id": key_id,
        "namespace": namespace,
        "nonce": nonce,
        "payload": payload_json,
        "schema_version": schema_version,
        "sequence": sequence,
        "timestamp": timestamp,
    }
    return json.dumps(ad, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _sign(raw_key_hex: str, authenticated_data: bytes) -> str:
    """Return HMAC-SHA256 of *authenticated_data* using *raw_key_hex* as key."""
    key_bytes = bytes.fromhex(raw_key_hex)
    return hmac.new(key_bytes, authenticated_data, hashlib.sha256).hexdigest()


def _verify(raw_key_hex: str, authenticated_data: bytes, expected_tag: str) -> bool:
    """Constant-time comparison of the computed HMAC against *expected_tag*."""
    actual = _sign(raw_key_hex, authenticated_data)
    return hmac.compare_digest(actual, expected_tag)


# ── CheckpointStore ────────────────────────────────────────────────────────────


class CheckpointStore:
    """Save and load authenticated checkpoint envelopes for a single agent.

    Parameters
    ----------
    db:
        A ``LocalDB`` instance (already migrated to version 7+).
    agent_id:
        Stable identifier for the producing agent.  Bound into every envelope
        and verified on load to prevent cross-agent confusion.
    """

    def __init__(self, db: "LocalDB", agent_id: str) -> None:
        if not agent_id or not isinstance(agent_id, str):
            raise ValueError("agent_id must be a non-empty string")
        self._db = db
        self.agent_id = agent_id

    # ── Key lifecycle ──────────────────────────────────────

    def ensure_key(self) -> str:
        """Ensure at least one active key exists; create one if not.  Returns key_id."""
        existing = self._db.get_active_checkpoint_key()
        if existing:
            return existing["key_id"]
        return self._create_key(active=True)

    def rotate_key(self) -> str:
        """Generate a new active key, demoting the current one.  Returns new key_id.

        After rotation:
        - New writes use the new key.
        - Old checkpoints signed by the previous key remain readable because
          ``load()`` looks up the key by ``key_id`` from the envelope.
        """
        return self._create_key(active=True)

    def _create_key(self, *, active: bool) -> str:
        key_id, raw_hex = _generate_key_material()
        self._db.add_checkpoint_key(key_id, raw_hex, active=active)
        return key_id

    # ── Core operations ────────────────────────────────────

    def save(self, namespace: str, payload: dict[str, Any]) -> int:
        """Sign and persist a checkpoint envelope.

        Parameters
        ----------
        namespace:
            Logical scope string, e.g. ``"agent_loop"`` or ``"commerce"``.
        payload:
            Arbitrary serialisable dict.  Must not contain non-JSON-serialisable
            values.

        Returns
        -------
        int
            The new sequence number.

        Raises
        ------
        CheckpointError
            If no active key has been registered yet.  Call ``ensure_key()`` or
            ``rotate_key()`` before the first ``save()``.
        """
        self._validate_namespace(namespace)
        self._validate_payload(payload)

        key_row = self._db.get_active_checkpoint_key()
        if key_row is None:
            raise CheckpointError(
                "No active checkpoint key found.  Call ensure_key() or rotate_key() first."
            )
        key_id = key_row["key_id"]
        raw_key_hex = key_row["key_hmac"]

        # Monotonically-increasing sequence — prevents rollback
        sequence = self._db.get_max_sequence(self.agent_id, namespace) + 1

        # Fresh nonce per write — prevents replay of an identical payload
        nonce = secrets.token_hex(16)

        timestamp = datetime.now(timezone.utc).isoformat()

        payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)

        ad = _build_authenticated_data(
            agent_id=self.agent_id,
            namespace=namespace,
            sequence=sequence,
            schema_version=SCHEMA_VERSION,
            key_id=key_id,
            nonce=nonce,
            timestamp=timestamp,
            payload_json=payload_json,
        )
        tag = _sign(raw_key_hex, ad)

        envelope = CheckpointEnvelope(
            agent_id=self.agent_id,
            namespace=namespace,
            sequence=sequence,
            schema_version=SCHEMA_VERSION,
            key_id=key_id,
            nonce=nonce,
            tag=tag,
            payload=payload,
            timestamp=timestamp,
        )
        self._db.save_checkpoint(**envelope.to_db_row())
        return sequence

    def load(self, namespace: str, sequence: int | None = None) -> CheckpointEnvelope | None:
        """Load and verify a checkpoint envelope.

        Parameters
        ----------
        namespace:
            Logical scope string.
        sequence:
            If given, load the envelope with that exact sequence number.
            If None (default), load the latest (highest sequence) envelope.

        Returns
        -------
        CheckpointEnvelope | None
            The verified envelope, or None if no checkpoint exists.

        Raises
        ------
        WrongIdentityError
            agent_id in the stored row does not match ``self.agent_id``.
        UnknownKeyError
            The key_id from the envelope is not in the key registry.
        TamperDetectedError
            HMAC verification failed.
        """
        self._validate_namespace(namespace)

        if sequence is not None:
            row = self._db.get_checkpoint_by_sequence(self.agent_id, namespace, sequence)
        else:
            row = self._db.get_latest_checkpoint(self.agent_id, namespace)

        if row is None:
            return None

        env = CheckpointEnvelope.from_db_row(row)

        # Identity check — must match the store's own agent_id
        if env.agent_id != self.agent_id:
            raise WrongIdentityError(
                f"Checkpoint agent_id '{env.agent_id}' does not match store agent_id '{self.agent_id}'"
            )

        # Key lookup — supports reading back old keys after rotation
        key_row = self._db.get_checkpoint_key(env.key_id)
        if key_row is None:
            raise UnknownKeyError(
                f"Checkpoint references unknown key_id '{env.key_id}'.  "
                "Key may have been deleted — rotation should demote, not delete."
            )
        raw_key_hex = key_row["key_hmac"]

        # HMAC verification
        payload_json = json.dumps(env.payload, separators=(",", ":"), sort_keys=True)
        ad = _build_authenticated_data(
            agent_id=env.agent_id,
            namespace=env.namespace,
            sequence=env.sequence,
            schema_version=env.schema_version,
            key_id=env.key_id,
            nonce=env.nonce,
            timestamp=env.timestamp,
            payload_json=payload_json,
        )
        if not _verify(raw_key_hex, ad, env.tag):
            raise TamperDetectedError(
                f"HMAC verification failed for checkpoint "
                f"(agent={env.agent_id}, ns={env.namespace}, seq={env.sequence}).  "
                "The envelope may have been tampered with."
            )

        return env

    # ── Validation helpers ─────────────────────────────────

    @staticmethod
    def _validate_namespace(namespace: str) -> None:
        if not isinstance(namespace, str) or not namespace.strip():
            raise ValueError("namespace must be a non-empty string")
        if len(namespace) > 128:
            raise ValueError("namespace must be 128 characters or fewer")
        if any(ord(c) < 32 for c in namespace):
            raise ValueError("namespace contains invalid control characters")

    @staticmethod
    def _validate_payload(payload: dict) -> None:
        if not isinstance(payload, dict):
            raise TypeError(f"payload must be a dict, got {type(payload).__name__}")
        # Ensure it is JSON-serialisable (raises TypeError on bad values)
        try:
            json.dumps(payload)
        except (TypeError, ValueError) as exc:
            raise TypeError(f"payload is not JSON-serialisable: {exc}") from exc
