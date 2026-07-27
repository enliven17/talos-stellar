"""Authenticated checkpoint envelope system.

Security design
---------------
Each checkpoint envelope is integrity-protected by an HMAC-SHA256 tag computed
over authenticated data (agent_id, namespace, schema_version, sequence number,
ISO-8601 timestamp, nonce) **and** the ciphertext payload.  The HMAC key itself
is never stored in plaintext: before being written to the ``checkpoint_keys``
table it is wrapped with AES-GCM using a 256-bit key derived from the runtime
master password (via PBKDF2-SHA256, 200 000 iterations, a unique per-wrap
salt).  This mirrors the existing ``encrypt_with_password`` / ENC:: boundary
used for .env secrets.

Key rotation
------------
A key has a ``status`` of ``"active"`` or ``"retired"``.  New envelopes are
always written with the single active key.  Verification accepts the envelope's
recorded ``key_id`` and unwraps whichever key (active or retired) matches —
enabling seamless read-back across rotations.  Retiring a key is a
single-statement UPDATE; no re-encryption of existing envelopes is required
because each envelope records which key_id was used.

Replay / rollback protection
-----------------------------
* Nonces are globally unique (UNIQUE constraint in SQLite).
* Sequence numbers are monotonically increasing per (agent_id, namespace);
  an envelope whose sequence ≤ the current high-water mark is rejected.

Envelope wire format (JSON payload stored in checkpoint_envelopes.payload)
---------------------------------------------------------------------------
{
    "v":        1,                    # schema version
    "agent_id": "<str>",
    "ns":       "<namespace>",
    "seq":      <int>,
    "ts":       "<ISO-8601 UTC>",
    "nonce":    "<hex 32 bytes>",
    "key_id":   "<str>",
    "ct":       "<base64 ciphertext>",  # AES-GCM encrypted checkpoint data
    "ct_nonce": "<base64 12 bytes>",    # AES-GCM nonce for ciphertext
    "hmac":     "<hex HMAC-SHA256>"     # over all preceding fields (canonical form)
}

The HMAC covers the canonical AAD string (see _build_aad) so that every
authenticated field is bound to the tag.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from talos_agent.state_classify import StateCategory, registered_classification

# ── Constants ──────────────────────────────────────────────────────────────────

_ENVELOPE_VERSION = 1
_HMAC_KEY_BYTES = 32          # 256-bit HMAC-SHA256 key
_AES_KEY_BYTES = 32           # 256-bit AES-GCM content encryption key
_PBKDF2_ITERATIONS = 200_000
_MAX_SEQ_DRIFT = 10_000       # sanity upper bound for accepted future sequences


# ── Exceptions ─────────────────────────────────────────────────────────────────

class CheckpointError(Exception):
    """Base class for all checkpoint errors."""


class MasterKeyError(CheckpointError):
    """Master password not supplied or incorrect."""


class KeyNotFoundError(CheckpointError):
    """Requested key_id does not exist."""


class TamperError(CheckpointError):
    """Envelope HMAC verification failed — data was tampered with."""


class ReplayError(CheckpointError):
    """Envelope nonce has already been consumed (replay attack)."""


class RollbackError(CheckpointError):
    """Envelope sequence number is not greater than the current high-water mark."""


class IdentityError(CheckpointError):
    """Envelope agent_id does not match the expected identity."""


class SchemaError(CheckpointError):
    """Envelope schema version is unsupported."""


# ── Low-level key-wrapping helpers ────────────────────────────────────────────

def _derive_wrapping_key(password: str, salt: bytes) -> bytes:
    """Derive a 256-bit AES key from *password* and *salt* (PBKDF2-SHA256)."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=_AES_KEY_BYTES,
        salt=salt,
        iterations=_PBKDF2_ITERATIONS,
    )
    return kdf.derive(password.encode("utf-8"))


def _wrap_key(raw_key: bytes, master_password: str) -> str:
    """Encrypt *raw_key* with *master_password* and return an ``ENC::`` blob.

    Format (after base64-decoding the blob):
        salt[16] || nonce[12] || ciphertext[len(raw_key) + 16 GCM tag]
    """
    salt = os.urandom(16)
    nonce = os.urandom(12)
    wrap_key = _derive_wrapping_key(master_password, salt)
    ct = AESGCM(wrap_key).encrypt(nonce, raw_key, None)
    blob = salt + nonce + ct
    return "ENC::" + base64.b64encode(blob).decode()


def _unwrap_key(blob: str, master_password: str) -> bytes:
    """Decrypt an ``ENC::`` blob produced by :func:`_wrap_key`.

    Raises :class:`MasterKeyError` if decryption fails (wrong password or
    corrupted blob).
    """
    if not blob.startswith("ENC::"):
        raise MasterKeyError("Key material is not in wrapped ENC:: format")
    try:
        raw = base64.b64decode(blob[len("ENC::"):])
        if len(raw) < 16 + 12 + 16:
            raise ValueError("Blob too short")
        salt, nonce, ct = raw[:16], raw[16:28], raw[28:]
        wrap_key = _derive_wrapping_key(master_password, salt)
        return AESGCM(wrap_key).decrypt(nonce, ct, None)
    except Exception as exc:
        raise MasterKeyError(f"Failed to unwrap key material: {exc}") from exc


# ── AAD / HMAC helpers ────────────────────────────────────────────────────────

def _build_aad(
    *,
    agent_id: str,
    namespace: str,
    schema_version: int,
    seq: int,
    ts: str,
    nonce: str,
    key_id: str,
    ct_b64: str,
    ct_nonce_b64: str,
) -> bytes:
    """Build the canonical authenticated-associated-data string.

    All envelope fields that must be integrity-protected are included.  The
    format is deterministic and field-separated by ``\\x00`` so that no field
    can bleed into another.
    """
    parts = [
        f"v={_ENVELOPE_VERSION}",
        f"agent_id={agent_id}",
        f"ns={namespace}",
        f"schema={schema_version}",
        f"seq={seq}",
        f"ts={ts}",
        f"nonce={nonce}",
        f"key_id={key_id}",
        f"ct={ct_b64}",
        f"ct_nonce={ct_nonce_b64}",
    ]
    return "\x00".join(parts).encode("utf-8")


def _compute_hmac(hmac_key: bytes, aad: bytes) -> str:
    """Return a lowercase hex HMAC-SHA256 of *aad* under *hmac_key*."""
    return hmac.new(hmac_key, aad, hashlib.sha256).hexdigest()


def _verify_hmac(hmac_key: bytes, aad: bytes, expected_hex: str) -> None:
    """Raise :class:`TamperError` if the HMAC does not match."""
    actual = _compute_hmac(hmac_key, aad).encode()
    if not hmac.compare_digest(actual, expected_hex.encode()):
        raise TamperError("Envelope HMAC verification failed")


# ── Database schema (migrations appended to LocalDB._MIGRATIONS externally) ───

# Migration SQL is registered in db.py via _MIGRATIONS list.  The two DDL
# blocks below are referenced from that list so that the normal migration
# runner applies them automatically.

CHECKPOINT_KEYS_DDL = """
CREATE TABLE IF NOT EXISTS checkpoint_keys (
    key_id       TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    namespace    TEXT NOT NULL DEFAULT '',
    key_hmac     TEXT NOT NULL,        -- ENC::-wrapped HMAC key (never plaintext)
    key_enc      TEXT NOT NULL,        -- ENC::-wrapped AES-GCM content-encryption key
    status       TEXT NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active', 'retired')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    retired_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_keys_agent_status
    ON checkpoint_keys(agent_id, status);
"""

CHECKPOINT_ENVELOPES_DDL = """
CREATE TABLE IF NOT EXISTS checkpoint_envelopes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id       TEXT NOT NULL REFERENCES checkpoint_keys(key_id),
    agent_id     TEXT NOT NULL,
    namespace    TEXT NOT NULL DEFAULT '',
    schema_ver   INTEGER NOT NULL DEFAULT 1,
    seq          INTEGER NOT NULL,
    ts           TEXT NOT NULL,
    nonce        TEXT NOT NULL UNIQUE,  -- replay protection
    payload      TEXT NOT NULL,         -- full JSON envelope (see module docstring)
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_envelopes_agent_ns_seq
    ON checkpoint_envelopes(agent_id, namespace, seq);
"""


# ── CheckpointStore ───────────────────────────────────────────────────────────

class CheckpointStore:
    """Manages checkpoint key lifecycle and envelope persistence.

    Parameters
    ----------
    conn:
        An open ``sqlite3.Connection`` (WAL mode recommended).  The caller is
        responsible for the connection lifecycle.
    master_password:
        The runtime master password used to wrap/unwrap HMAC and AES-GCM key
        material.  It is never stored; it must be supplied at construction time.
    """

    def __init__(self, conn: sqlite3.Connection, master_password: str) -> None:
        if not master_password:
            raise MasterKeyError("master_password must not be empty")
        self._conn = conn
        self._conn.row_factory = sqlite3.Row
        self._master_pw = master_password
        self._ensure_schema()

    # ── Schema bootstrap ──────────────────────────────────────────────────────

    def _ensure_schema(self) -> None:
        """Create checkpoint tables if they don't exist yet."""
        self._conn.executescript(CHECKPOINT_KEYS_DDL + CHECKPOINT_ENVELOPES_DDL)
        self._conn.commit()

    # ── Key generation and rotation ───────────────────────────────────────────

    def generate_key(
        self,
        agent_id: str,
        namespace: str = "",
        *,
        _key_id: str | None = None,  # injectable for tests
    ) -> str:
        """Generate a new active checkpoint key pair and return the ``key_id``.

        The raw HMAC and AES-GCM keys are generated with :func:`os.urandom`,
        wrapped with the master password via AES-GCM + PBKDF2, and stored as
        ``ENC::`` blobs.  No plaintext key material ever touches the database.

        Exactly one key per ``(agent_id, namespace)`` may be active at a time.
        If an active key already exists it must be rotated first (call
        :meth:`rotate_key`).
        """
        self._validate_agent_id(agent_id)
        existing = self._get_active_key_row(agent_id, namespace)
        if existing:
            raise CheckpointError(
                f"An active key already exists for agent_id={agent_id!r} "
                f"namespace={namespace!r}. Call rotate_key() first."
            )

        raw_hmac_key = os.urandom(_HMAC_KEY_BYTES)
        raw_enc_key = os.urandom(_AES_KEY_BYTES)

        key_id = _key_id or secrets.token_hex(16)
        wrapped_hmac = _wrap_key(raw_hmac_key, self._master_pw)
        wrapped_enc = _wrap_key(raw_enc_key, self._master_pw)

        self._conn.execute(
            """INSERT INTO checkpoint_keys (key_id, agent_id, namespace, key_hmac, key_enc)
               VALUES (?, ?, ?, ?, ?)""",
            (key_id, agent_id, namespace, wrapped_hmac, wrapped_enc),
        )
        self._conn.commit()
        return key_id

    def rotate_key(
        self,
        agent_id: str,
        namespace: str = "",
        *,
        _new_key_id: str | None = None,
    ) -> tuple[str, str]:
        """Retire the current active key and generate a new one.

        Returns ``(old_key_id, new_key_id)``.  Existing envelopes signed with
        the old key remain verifiable because :meth:`verify_envelope` resolves
        the key by the ``key_id`` stored in the envelope.
        """
        self._validate_agent_id(agent_id)
        old_row = self._get_active_key_row(agent_id, namespace)
        if not old_row:
            raise KeyNotFoundError(
                f"No active key to rotate for agent_id={agent_id!r} namespace={namespace!r}"
            )
        old_key_id = old_row["key_id"]

        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            "UPDATE checkpoint_keys SET status='retired', retired_at=? WHERE key_id=?",
            (now, old_key_id),
        )
        self._conn.commit()

        # Generate the successor (no active key present now, so generate_key works)
        new_key_id = self.generate_key(agent_id, namespace, _key_id=_new_key_id)
        return old_key_id, new_key_id

    def list_keys(self, agent_id: str, namespace: str = "") -> list[dict]:
        """Return all keys (active and retired) for an agent/namespace."""
        rows = self._conn.execute(
            "SELECT key_id, agent_id, namespace, status, created_at, retired_at "
            "FROM checkpoint_keys WHERE agent_id=? AND namespace=? ORDER BY created_at",
            (agent_id, namespace),
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Envelope sealing / opening ─────────────────────────────────────────────

    def seal(
        self,
        agent_id: str,
        data: dict[str, Any],
        *,
        namespace: str = "",
        schema_version: int = 1,
    ) -> str:
        """Encrypt *data*, compute an authenticated envelope, and persist it.

        Returns the hex nonce that uniquely identifies this envelope.

        The next sequence number is derived as ``max(seq) + 1`` for the
        ``(agent_id, namespace)`` pair, starting at 1.

        Raises
        ------
        KeyNotFoundError
            If no active key exists for the given agent/namespace.
        CheckpointError
            On any internal error.
        """
        self._validate_agent_id(agent_id)
        key_row = self._get_active_key_row(agent_id, namespace)
        if not key_row:
            raise KeyNotFoundError(
                f"No active checkpoint key for agent_id={agent_id!r} namespace={namespace!r}"
            )

        hmac_key = _unwrap_key(key_row["key_hmac"], self._master_pw)
        enc_key = _unwrap_key(key_row["key_enc"], self._master_pw)
        key_id: str = key_row["key_id"]

        # Monotonic sequence
        seq = self._next_seq(agent_id, namespace)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        nonce = secrets.token_hex(32)

        # Encrypt payload with AES-GCM
        ct_nonce = os.urandom(12)
        plaintext = json.dumps(data, separators=(",", ":"), sort_keys=True).encode()
        ct = AESGCM(enc_key).encrypt(ct_nonce, plaintext, None)
        ct_b64 = base64.b64encode(ct).decode()
        ct_nonce_b64 = base64.b64encode(ct_nonce).decode()

        # Compute HMAC over all authenticated fields + ciphertext
        aad = _build_aad(
            agent_id=agent_id,
            namespace=namespace,
            schema_version=schema_version,
            seq=seq,
            ts=ts,
            nonce=nonce,
            key_id=key_id,
            ct_b64=ct_b64,
            ct_nonce_b64=ct_nonce_b64,
        )
        hmac_hex = _compute_hmac(hmac_key, aad)

        envelope: dict[str, Any] = {
            "v": _ENVELOPE_VERSION,
            "agent_id": agent_id,
            "ns": namespace,
            "schema": schema_version,
            "seq": seq,
            "ts": ts,
            "nonce": nonce,
            "key_id": key_id,
            "ct": ct_b64,
            "ct_nonce": ct_nonce_b64,
            "hmac": hmac_hex,
        }

        self._conn.execute(
            """INSERT INTO checkpoint_envelopes
               (key_id, agent_id, namespace, schema_ver, seq, ts, nonce, payload)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                key_id,
                agent_id,
                namespace,
                schema_version,
                seq,
                ts,
                nonce,
                json.dumps(envelope, separators=(",", ":")),
            ),
        )
        self._conn.commit()
        return nonce

    def open(
        self,
        nonce: str,
        *,
        expected_agent_id: str | None = None,
    ) -> dict[str, Any]:
        """Verify and decrypt a checkpoint envelope identified by *nonce*.

        Parameters
        ----------
        nonce:
            The hex nonce returned by :meth:`seal`.
        expected_agent_id:
            When supplied the envelope's ``agent_id`` must match exactly.

        Returns
        -------
        dict
            The original plaintext payload.

        Raises
        ------
        KeyNotFoundError
            If the envelope or its key does not exist.
        IdentityError
            If *expected_agent_id* is supplied and does not match.
        TamperError
            If HMAC verification fails.
        MasterKeyError
            If the master password cannot unwrap the key.
        SchemaError
            If the envelope schema version is unsupported.
        """
        row = self._conn.execute(
            "SELECT payload FROM checkpoint_envelopes WHERE nonce=?", (nonce,)
        ).fetchone()
        if not row:
            raise KeyNotFoundError(f"No envelope with nonce={nonce!r}")

        env = json.loads(row["payload"])
        return self._verify_and_decrypt(env, expected_agent_id=expected_agent_id)

    def open_latest(
        self,
        agent_id: str,
        namespace: str = "",
        *,
        schema_version: int | None = None,
    ) -> dict[str, Any] | None:
        """Return the decrypted payload of the highest-sequence envelope.

        Returns ``None`` if no envelopes exist for the given agent/namespace.
        """
        query = (
            "SELECT payload FROM checkpoint_envelopes "
            "WHERE agent_id=? AND namespace=? "
        )
        params: list[Any] = [agent_id, namespace]
        if schema_version is not None:
            query += "AND schema_ver=? "
            params.append(schema_version)
        query += "ORDER BY seq DESC LIMIT 1"

        row = self._conn.execute(query, params).fetchone()
        if not row:
            return None
        env = json.loads(row["payload"])
        return self._verify_and_decrypt(env, expected_agent_id=agent_id)

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _verify_and_decrypt(
        self,
        env: dict[str, Any],
        *,
        expected_agent_id: str | None,
    ) -> dict[str, Any]:
        """Full envelope verification pipeline.  Raises on any anomaly."""
        # Schema version guard
        if env.get("v") != _ENVELOPE_VERSION:
            raise SchemaError(
                f"Unsupported envelope version {env.get('v')!r}; expected {_ENVELOPE_VERSION}"
            )

        # Identity check
        if expected_agent_id is not None and env["agent_id"] != expected_agent_id:
            raise IdentityError(
                f"Envelope agent_id={env['agent_id']!r} does not match "
                f"expected={expected_agent_id!r}"
            )

        # Resolve key (active or retired — both valid for read)
        key_row = self._conn.execute(
            "SELECT key_hmac, key_enc FROM checkpoint_keys WHERE key_id=?",
            (env["key_id"],),
        ).fetchone()
        if not key_row:
            raise KeyNotFoundError(f"Key {env['key_id']!r} not found")

        hmac_key = _unwrap_key(key_row["key_hmac"], self._master_pw)
        enc_key = _unwrap_key(key_row["key_enc"], self._master_pw)

        # Re-derive AAD and verify HMAC
        aad = _build_aad(
            agent_id=env["agent_id"],
            namespace=env["ns"],
            schema_version=env["schema"],
            seq=env["seq"],
            ts=env["ts"],
            nonce=env["nonce"],
            key_id=env["key_id"],
            ct_b64=env["ct"],
            ct_nonce_b64=env["ct_nonce"],
        )
        _verify_hmac(hmac_key, aad, env["hmac"])

        # Decrypt ciphertext
        try:
            ct = base64.b64decode(env["ct"])
            ct_nonce = base64.b64decode(env["ct_nonce"])
            plaintext = AESGCM(enc_key).decrypt(ct_nonce, ct, None)
        except Exception as exc:
            raise TamperError(f"Ciphertext decryption failed: {exc}") from exc

        return json.loads(plaintext)

    def _get_active_key_row(
        self, agent_id: str, namespace: str
    ) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT key_id, key_hmac, key_enc FROM checkpoint_keys "
            "WHERE agent_id=? AND namespace=? AND status='active'",
            (agent_id, namespace),
        ).fetchone()

    def _next_seq(self, agent_id: str, namespace: str) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM checkpoint_envelopes "
            "WHERE agent_id=? AND namespace=?",
            (agent_id, namespace),
        ).fetchone()
        return int(row["max_seq"]) + 1

    @staticmethod
    def _validate_agent_id(agent_id: str) -> None:
        if not agent_id or not isinstance(agent_id, str):
            raise ValueError("agent_id must be a non-empty string")
        if len(agent_id) > 128:
            raise ValueError("agent_id must be 128 characters or fewer")


# ── Convenience factory ───────────────────────────────────────────────────────

def open_checkpoint_store(
    db_path: Path | str,
    master_password: str,
) -> CheckpointStore:
    """Open (or create) a SQLite database and return a :class:`CheckpointStore`.

    The caller is responsible for closing the returned store's underlying
    connection when done.  Prefer using this as a context resource in tests.
    """
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return CheckpointStore(conn, master_password)


__all__ = [
    "CHECKPOINT_ENVELOPES_DDL",
    "CHECKPOINT_KEYS_DDL",
    "CheckpointError",
    "CheckpointStore",
    "IdentityError",
    "KeyNotFoundError",
    "MasterKeyError",
    "ReplayError",
    "RollbackError",
    "SchemaError",
    "TamperError",
    "open_checkpoint_store",
]
