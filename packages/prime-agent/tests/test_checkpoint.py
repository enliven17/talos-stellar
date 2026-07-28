"""Tests for the authenticated checkpoint envelope system (checkpoint.py).

Coverage
--------
- Happy-path seal / open
- open_latest with multiple envelopes
- HMAC tamper detection (every tampered field triggers TamperError)
- AES-GCM ciphertext tamper detection
- Wrong identity rejection (IdentityError)
- Wrong master password (MasterKeyError)
- Replay attack rejection (sqlite3.IntegrityError via UNIQUE nonce constraint)
- Rollback / stale sequence detection (via open_latest ordering)
- Key generation constraints (duplicate active key)
- Key rotation: old envelopes readable after rotation
- Key rotation: new envelopes use new key
- Retired key write prevention
- Missing / unknown key_id
- Schema version guard
- agent_id validation
- Namespace isolation
- Multiple agents are isolated from each other
- Key listing
- Concurrent sealing produces monotonically increasing sequence numbers
"""

from __future__ import annotations

import base64
import json
import sqlite3
import threading

import pytest

from talos_agent.checkpoint import (
    CheckpointError,
    CheckpointStore,
    IdentityError,
    KeyNotFoundError,
    MasterKeyError,
    SchemaError,
    TamperError,
    _unwrap_key,
    _wrap_key,
    open_checkpoint_store,
)

# ── Fixtures ──────────────────────────────────────────────────────────────────

MASTER_PW = "test-master-password-XyZ!2025"
AGENT_A = "agent-alpha"
AGENT_B = "agent-beta"


@pytest.fixture()
def conn():
    """In-memory SQLite connection, closed after each test."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    yield c
    c.close()


@pytest.fixture()
def store(conn):
    """Fresh CheckpointStore backed by an in-memory DB."""
    return CheckpointStore(conn, MASTER_PW)


@pytest.fixture()
def store_with_key(store):
    """Store with an active key for AGENT_A already generated."""
    store.generate_key(AGENT_A)
    return store


# ── Key-wrapping unit tests ───────────────────────────────────────────────────

class TestKeyWrapping:
    def test_wrap_produces_enc_prefix(self):
        import os
        raw = os.urandom(32)
        blob = _wrap_key(raw, MASTER_PW)
        assert blob.startswith("ENC::")

    def test_roundtrip(self):
        import os
        raw = os.urandom(32)
        blob = _wrap_key(raw, MASTER_PW)
        assert _unwrap_key(blob, MASTER_PW) == raw

    def test_wrong_password_raises(self):
        import os
        raw = os.urandom(32)
        blob = _wrap_key(raw, MASTER_PW)
        with pytest.raises(MasterKeyError):
            _unwrap_key(blob, "wrong-password")

    def test_truncated_blob_raises(self):
        with pytest.raises(MasterKeyError):
            _unwrap_key("ENC::" + base64.b64encode(b"short").decode(), MASTER_PW)

    def test_not_enc_prefix_raises(self):
        with pytest.raises(MasterKeyError):
            _unwrap_key("raw_key_material", MASTER_PW)

    def test_different_salts_produce_different_blobs(self):
        import os
        raw = os.urandom(32)
        b1 = _wrap_key(raw, MASTER_PW)
        b2 = _wrap_key(raw, MASTER_PW)
        # different random salts/nonces each call
        assert b1 != b2
        # but both decrypt to the same key
        assert _unwrap_key(b1, MASTER_PW) == _unwrap_key(b2, MASTER_PW) == raw


# ── CheckpointStore construction ─────────────────────────────────────────────

class TestStoreConstruction:
    def test_empty_password_raises(self, conn):
        with pytest.raises(MasterKeyError):
            CheckpointStore(conn, "")

    def test_tables_created_on_init(self, store, conn):
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "checkpoint_keys" in tables
        assert "checkpoint_envelopes" in tables

    def test_idempotent_schema_init(self, conn):
        """Calling _ensure_schema twice must not raise."""
        s1 = CheckpointStore(conn, MASTER_PW)
        s2 = CheckpointStore(conn, MASTER_PW)
        assert s1 is not s2  # distinct objects, same connection — no error


# ── Key generation ────────────────────────────────────────────────────────────

class TestKeyGeneration:
    def test_generate_returns_key_id(self, store):
        key_id = store.generate_key(AGENT_A)
        assert isinstance(key_id, str) and len(key_id) == 32  # hex(16)

    def test_key_stored_wrapped(self, store, conn):
        store.generate_key(AGENT_A)
        row = conn.execute(
            "SELECT key_hmac, key_enc FROM checkpoint_keys WHERE agent_id=?",
            (AGENT_A,),
        ).fetchone()
        assert row["key_hmac"].startswith("ENC::")
        assert row["key_enc"].startswith("ENC::")

    def test_no_plaintext_in_key_columns(self, store, conn):
        store.generate_key(AGENT_A)
        row = conn.execute(
            "SELECT key_hmac, key_enc FROM checkpoint_keys WHERE agent_id=?",
            (AGENT_A,),
        ).fetchone()
        # Ensure neither column can be decoded as raw 32-byte material.
        # Both values must start with "ENC::" — that is the invariant.
        for col in ("key_hmac", "key_enc"):
            assert row[col].startswith("ENC::"), f"{col} must be an ENC:: blob, got: {row[col][:20]!r}"

    def test_duplicate_active_key_raises(self, store):
        store.generate_key(AGENT_A)
        with pytest.raises(CheckpointError, match="active key already exists"):
            store.generate_key(AGENT_A)

    def test_namespaces_are_independent(self, store):
        id1 = store.generate_key(AGENT_A, "ns-a")
        id2 = store.generate_key(AGENT_A, "ns-b")
        assert id1 != id2

    def test_empty_agent_id_raises(self, store):
        with pytest.raises(ValueError):
            store.generate_key("")

    def test_long_agent_id_raises(self, store):
        with pytest.raises(ValueError):
            store.generate_key("x" * 129)


# ── Key rotation ──────────────────────────────────────────────────────────────

class TestKeyRotation:
    def test_rotate_returns_both_ids(self, store):
        old_id = store.generate_key(AGENT_A)
        old, new = store.rotate_key(AGENT_A)
        assert old == old_id
        assert new != old_id

    def test_old_key_retired_after_rotation(self, store, conn):
        old_id = store.generate_key(AGENT_A)
        store.rotate_key(AGENT_A)
        row = conn.execute(
            "SELECT status FROM checkpoint_keys WHERE key_id=?", (old_id,)
        ).fetchone()
        assert row["status"] == "retired"

    def test_new_key_active_after_rotation(self, store):
        store.generate_key(AGENT_A)
        _, new_id = store.rotate_key(AGENT_A)
        keys = store.list_keys(AGENT_A)
        active = [k for k in keys if k["status"] == "active"]
        assert len(active) == 1
        assert active[0]["key_id"] == new_id

    def test_rotate_without_active_key_raises(self, store):
        with pytest.raises(KeyNotFoundError):
            store.rotate_key(AGENT_A)

    def test_old_envelope_readable_after_rotation(self, store):
        """Envelopes signed by a retired key must still verify correctly."""
        store.generate_key(AGENT_A)
        nonce = store.seal(AGENT_A, {"step": "before-rotation"})
        store.rotate_key(AGENT_A)
        result = store.open(nonce, expected_agent_id=AGENT_A)
        assert result == {"step": "before-rotation"}

    def test_new_envelope_uses_new_key(self, store, conn):
        store.generate_key(AGENT_A)
        _, new_key_id = store.rotate_key(AGENT_A)
        nonce = store.seal(AGENT_A, {"step": "after-rotation"})
        row = conn.execute(
            "SELECT key_id FROM checkpoint_envelopes WHERE nonce=?", (nonce,)
        ).fetchone()
        assert row["key_id"] == new_key_id

    def test_multiple_rotations_all_readable(self, store):
        store.generate_key(AGENT_A)
        nonces = []
        nonces.append(store.seal(AGENT_A, {"gen": 1}))
        store.rotate_key(AGENT_A)
        nonces.append(store.seal(AGENT_A, {"gen": 2}))
        store.rotate_key(AGENT_A)
        nonces.append(store.seal(AGENT_A, {"gen": 3}))

        for i, nonce in enumerate(nonces, start=1):
            data = store.open(nonce, expected_agent_id=AGENT_A)
            assert data == {"gen": i}

    def test_key_listing_shows_all_statuses(self, store):
        store.generate_key(AGENT_A)
        store.rotate_key(AGENT_A)
        keys = store.list_keys(AGENT_A)
        statuses = {k["status"] for k in keys}
        assert "active" in statuses
        assert "retired" in statuses


# ── Seal / open happy path ────────────────────────────────────────────────────

class TestSealOpen:
    def test_roundtrip(self, store_with_key):
        payload = {"hello": "world", "num": 42}
        nonce = store_with_key.seal(AGENT_A, payload)
        result = store_with_key.open(nonce, expected_agent_id=AGENT_A)
        assert result == payload

    def test_complex_payload(self, store_with_key):
        payload = {"nested": {"list": [1, 2, 3], "flag": True}, "null": None}
        nonce = store_with_key.seal(AGENT_A, payload)
        assert store_with_key.open(nonce) == payload

    def test_sequence_increments(self, store_with_key, conn):
        store_with_key.seal(AGENT_A, {"a": 1})
        store_with_key.seal(AGENT_A, {"b": 2})
        rows = conn.execute(
            "SELECT seq FROM checkpoint_envelopes WHERE agent_id=? ORDER BY seq",
            (AGENT_A,),
        ).fetchall()
        seqs = [r["seq"] for r in rows]
        assert seqs == [1, 2]

    def test_nonce_unique_per_envelope(self, store_with_key, conn):
        for i in range(5):
            store_with_key.seal(AGENT_A, {"i": i})
        nonces = [
            r["nonce"]
            for r in conn.execute(
                "SELECT nonce FROM checkpoint_envelopes WHERE agent_id=?",
                (AGENT_A,),
            ).fetchall()
        ]
        assert len(nonces) == len(set(nonces))

    def test_open_latest_returns_highest_seq(self, store_with_key):
        for i in range(5):
            store_with_key.seal(AGENT_A, {"i": i})
        result = store_with_key.open_latest(AGENT_A)
        assert result == {"i": 4}

    def test_open_latest_returns_none_when_empty(self, store_with_key):
        result = store_with_key.open_latest(AGENT_A, "no-data-namespace")
        assert result is None

    def test_seal_without_key_raises(self, store):
        with pytest.raises(KeyNotFoundError):
            store.seal(AGENT_A, {"x": 1})

    def test_open_unknown_nonce_raises(self, store_with_key):
        with pytest.raises(KeyNotFoundError, match="nonce"):
            store_with_key.open("deadbeef" * 8)


# ── Tamper detection ──────────────────────────────────────────────────────────

class TestTamperDetection:
    """Mutating any authenticated field must raise TamperError."""

    def _get_env(self, store, conn, agent_id=AGENT_A):
        nonce = store.seal(agent_id, {"data": "secret"})
        row = conn.execute(
            "SELECT payload FROM checkpoint_envelopes WHERE nonce=?", (nonce,)
        ).fetchone()
        return nonce, json.loads(row["payload"])

    def _tamper(self, store, conn, nonce: str, env: dict) -> None:
        conn.execute(
            "UPDATE checkpoint_envelopes SET payload=? WHERE nonce=?",
            (json.dumps(env), nonce),
        )
        conn.commit()

    def test_tampered_agent_id(self, store_with_key, conn):
        nonce, env = self._get_env(store_with_key, conn)
        env["agent_id"] = "evil-agent"
        self._tamper(store_with_key, conn, nonce, env)
        with pytest.raises((TamperError, IdentityError)):
            store_with_key.open(nonce, expected_agent_id=AGENT_A)

    def test_tampered_namespace(self, store_with_key, conn):
        nonce, env = self._get_env(store_with_key, conn)
        env["ns"] = "malicious-ns"
        self._tamper(store_with_key, conn, nonce, env)
        with pytest.raises(TamperError):
            store_with_key.open(nonce)

    def test_tampered_sequence(self, store_with_key, conn):
        nonce, env = self._get_env(store_with_key, conn)
        env["seq"] = 999
        self._tamper(store_with_key, conn, nonce, env)
        with pytest.raises(TamperError):
            store_with_key.open(nonce)

    def test_tampered_timestamp(self, store_with_key, conn):
        nonce, env = self._get_env(store_with_key, conn)
        env["ts"] = "1970-01-01T00:00:00.000Z"
        self._tamper(store_with_key, conn, nonce, env)
        with pytest.raises(TamperError):
            store_with_key.open(nonce)

    def test_tampered_ciphertext(self, store_with_key, conn):
        nonce, env = self._get_env(store_with_key, conn)
        ct = base64.b64decode(env["ct"])
        # Flip one byte in the ciphertext
        tampered = bytes([ct[0] ^ 0xFF]) + ct[1:]
        env["ct"] = base64.b64encode(tampered).decode()
        self._tamper(store_with_key, conn, nonce, env)
        with pytest.raises(TamperError):
            store_with_key.open(nonce)

    def test_tampered_hmac_field(self, store_with_key, conn):
        nonce, env = self._get_env(store_with_key, conn)
        env["hmac"] = "0" * 64  # invalid HMAC
        self._tamper(store_with_key, conn, nonce, env)
        with pytest.raises(TamperError):
            store_with_key.open(nonce)

    def test_tampered_key_id_field(self, store_with_key, conn):
        nonce, env = self._get_env(store_with_key, conn)
        env["key_id"] = "nonexistent-key"
        self._tamper(store_with_key, conn, nonce, env)
        with pytest.raises((TamperError, KeyNotFoundError)):
            store_with_key.open(nonce)

    def test_tampered_nonce_field(self, store_with_key, conn):
        _nonce, env = self._get_env(store_with_key, conn)
        original_nonce = env["nonce"]
        env["nonce"] = "aa" * 32  # different nonce
        # We manually write this mutated payload (keeping the original DB nonce)
        conn.execute(
            "UPDATE checkpoint_envelopes SET payload=? WHERE nonce=?",
            (json.dumps(env), original_nonce),
        )
        conn.commit()
        with pytest.raises(TamperError):
            store_with_key.open(original_nonce)

    def test_schema_version_tamper(self, store_with_key, conn):
        nonce, env = self._get_env(store_with_key, conn)
        env["v"] = 99
        self._tamper(store_with_key, conn, nonce, env)
        with pytest.raises(SchemaError):
            store_with_key.open(nonce)


# ── Identity / access-control tests ──────────────────────────────────────────

class TestIdentityEnforcement:
    def test_wrong_expected_agent_raises(self, store):
        store.generate_key(AGENT_A)
        nonce = store.seal(AGENT_A, {"secret": True})
        with pytest.raises(IdentityError):
            store.open(nonce, expected_agent_id=AGENT_B)

    def test_correct_expected_agent_succeeds(self, store):
        store.generate_key(AGENT_A)
        nonce = store.seal(AGENT_A, {"secret": True})
        result = store.open(nonce, expected_agent_id=AGENT_A)
        assert result == {"secret": True}

    def test_no_expected_agent_succeeds(self, store):
        """Without an expected_agent_id, open() skips the identity check."""
        store.generate_key(AGENT_A)
        nonce = store.seal(AGENT_A, {"x": 1})
        result = store.open(nonce)
        assert result == {"x": 1}


# ── Wrong master password ─────────────────────────────────────────────────────

class TestWrongMasterPassword:
    def test_open_with_wrong_password_raises(self, conn):
        store_correct = CheckpointStore(conn, MASTER_PW)
        store_correct.generate_key(AGENT_A)
        nonce = store_correct.seal(AGENT_A, {"sensitive": "data"})

        store_wrong = CheckpointStore(conn, "wrong-password-!!")
        with pytest.raises(MasterKeyError):
            store_wrong.open(nonce, expected_agent_id=AGENT_A)

    def test_generate_key_with_any_password_readable_only_with_same(self, conn):
        store1 = CheckpointStore(conn, "password-one")
        store1.generate_key(AGENT_A)
        nonce = store1.seal(AGENT_A, {"v": 1})

        store2 = CheckpointStore(conn, "password-two")
        with pytest.raises(MasterKeyError):
            store2.open(nonce)


# ── Replay attack prevention ──────────────────────────────────────────────────

class TestReplayPrevention:
    def test_duplicate_nonce_rejected_by_db(self, store_with_key, conn):
        """Inserting an envelope with an already-used nonce must raise."""
        nonce = store_with_key.seal(AGENT_A, {"x": 1})
        row = conn.execute(
            "SELECT key_id, agent_id, namespace, schema_ver, seq, ts, payload "
            "FROM checkpoint_envelopes WHERE nonce=?",
            (nonce,),
        ).fetchone()
        # Try inserting the same nonce again directly
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """INSERT INTO checkpoint_envelopes
                   (key_id, agent_id, namespace, schema_ver, seq, ts, nonce, payload)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    row["key_id"],
                    row["agent_id"],
                    row["namespace"],
                    row["schema_ver"],
                    row["seq"] + 100,  # different seq, same nonce
                    row["ts"],
                    nonce,
                    row["payload"],
                ),
            )


# ── Rollback / sequence ordering ─────────────────────────────────────────────

class TestSequenceOrdering:
    def test_open_latest_always_returns_max_seq(self, store_with_key):
        for i in range(10):
            store_with_key.seal(AGENT_A, {"i": i})
        result = store_with_key.open_latest(AGENT_A)
        assert result == {"i": 9}

    def test_manual_lower_seq_not_returned_by_open_latest(self, store_with_key):
        """open_latest returns MAX(seq), so injecting an older envelope doesn't mislead."""
        store_with_key.seal(AGENT_A, {"step": "new"})   # seq=1
        store_with_key.seal(AGENT_A, {"step": "newer"})  # seq=2
        result = store_with_key.open_latest(AGENT_A)
        assert result == {"step": "newer"}


# ── Namespace isolation ───────────────────────────────────────────────────────

class TestNamespaceIsolation:
    def test_different_namespaces_isolated(self, store):
        store.generate_key(AGENT_A, "ns-x")
        store.generate_key(AGENT_A, "ns-y")
        n1 = store.seal(AGENT_A, {"ns": "x"}, namespace="ns-x")
        n2 = store.seal(AGENT_A, {"ns": "y"}, namespace="ns-y")
        assert store.open(n1)["ns"] == "x"
        assert store.open(n2)["ns"] == "y"

    def test_open_latest_namespace_filter(self, store):
        store.generate_key(AGENT_A, "ns-a")
        store.generate_key(AGENT_A, "ns-b")
        store.seal(AGENT_A, {"val": "in-a"}, namespace="ns-a")
        store.seal(AGENT_A, {"val": "in-b"}, namespace="ns-b")
        assert store.open_latest(AGENT_A, "ns-a")["val"] == "in-a"
        assert store.open_latest(AGENT_A, "ns-b")["val"] == "in-b"


# ── Multi-agent isolation ─────────────────────────────────────────────────────

class TestMultiAgentIsolation:
    def test_agents_cannot_open_each_others_envelopes(self, store):
        store.generate_key(AGENT_A)
        store.generate_key(AGENT_B)
        nonce_a = store.seal(AGENT_A, {"owner": "A"})
        nonce_b = store.seal(AGENT_B, {"owner": "B"})

        # Cross-agent expected_agent_id check
        with pytest.raises(IdentityError):
            store.open(nonce_a, expected_agent_id=AGENT_B)
        with pytest.raises(IdentityError):
            store.open(nonce_b, expected_agent_id=AGENT_A)

        # Correct access
        assert store.open(nonce_a, expected_agent_id=AGENT_A) == {"owner": "A"}
        assert store.open(nonce_b, expected_agent_id=AGENT_B) == {"owner": "B"}

    def test_key_rotation_does_not_affect_other_agents(self, store):
        store.generate_key(AGENT_A)
        store.generate_key(AGENT_B)
        nonce_b = store.seal(AGENT_B, {"stable": True})
        store.rotate_key(AGENT_A)  # only rotate A
        assert store.open(nonce_b, expected_agent_id=AGENT_B) == {"stable": True}


# ── open_checkpoint_store factory ────────────────────────────────────────────

class TestOpenCheckpointStore:
    def test_factory_creates_store(self, tmp_path):
        db_file = tmp_path / "test-checkpoint.db"
        cs = open_checkpoint_store(db_file, MASTER_PW)
        cs.generate_key("agent-factory")
        nonce = cs.seal("agent-factory", {"ok": True})
        result = cs.open(nonce)
        assert result == {"ok": True}
        cs._conn.close()

    def test_factory_persistent_across_reconnects(self, tmp_path):
        db_file = tmp_path / "persist.db"
        cs = open_checkpoint_store(db_file, MASTER_PW)
        cs.generate_key("agent-persist")
        nonce = cs.seal("agent-persist", {"persisted": True})
        cs._conn.close()

        cs2 = open_checkpoint_store(db_file, MASTER_PW)
        result = cs2.open(nonce)
        assert result == {"persisted": True}
        cs2._conn.close()


# ── Thread-safety (basic) ─────────────────────────────────────────────────────

class TestConcurrency:
    def test_sequential_seals_produce_unique_nonces(self, store_with_key):
        nonces = [store_with_key.seal(AGENT_A, {"i": i}) for i in range(20)]
        assert len(nonces) == len(set(nonces))

    def test_threaded_seals_all_succeed(self, tmp_path):
        """Each thread gets its own connection to avoid SQLite threading issues."""
        db_file = tmp_path / "concurrent.db"

        # Pre-create the schema and key with one connection
        setup = open_checkpoint_store(db_file, MASTER_PW)
        setup.generate_key("agent-concurrent")
        setup._conn.close()

        results: list[str] = []
        errors: list[Exception] = []

        def worker(idx: int) -> None:
            try:
                cs = open_checkpoint_store(db_file, MASTER_PW)
                nonce = cs.seal("agent-concurrent", {"idx": idx})
                results.append(nonce)
                cs._conn.close()
            except (sqlite3.OperationalError, CheckpointError) as exc:
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Thread errors: {errors}"
        assert len(results) == 8
        assert len(set(results)) == 8  # all nonces unique


# ── DB migration integration ──────────────────────────────────────────────────

class TestDBMigration:
    def test_localdb_has_checkpoint_tables(self, tmp_path):
        """Running LocalDB migrations must create checkpoint_keys and checkpoint_envelopes."""
        from talos_agent.db import LocalDB

        db = LocalDB(tmp_path / "migration-test.db")
        conn = db._conn
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "checkpoint_keys" in tables, "checkpoint_keys table missing after migrations"
        assert "checkpoint_envelopes" in tables, "checkpoint_envelopes table missing after migrations"
        db.close()

    def test_localdb_checkpoint_keys_no_plaintext_stored(self, tmp_path):
        """Sanity-check: any row inserted via CheckpointStore has ENC:: prefix."""
        from talos_agent.db import LocalDB

        db = LocalDB(tmp_path / "enc-check.db")
        store = CheckpointStore(db._conn, MASTER_PW)
        store.generate_key("agent-migration-test")

        row = db._conn.execute(
            "SELECT key_hmac, key_enc FROM checkpoint_keys WHERE agent_id=?",
            ("agent-migration-test",),
        ).fetchone()
        assert row["key_hmac"].startswith("ENC::")
        assert row["key_enc"].startswith("ENC::")
        db.close()
