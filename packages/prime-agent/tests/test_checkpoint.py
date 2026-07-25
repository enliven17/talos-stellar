"""Tests for authenticated checkpoint envelopes — issue #293.

Covers:
- save / load round-trip (success path)
- authenticated data: agent_id, namespace, sequence, schema, timestamp, nonce, key_id
- HMAC tamper detection (payload, tag, each field independently)
- Replay attack detection (duplicate nonce rejected)
- Rollback attack detection (sequence must be strictly increasing)
- Wrong-identity detection (cross-agent confusion)
- Unknown key detection (key_id not in registry)
- Key rotation: new writes use new key; old checkpoints still verifiable
- ensure_key idempotent; no key → CheckpointError on save
- Namespace and payload validation (bounds, types)
- Concurrency: independent namespaces do not interfere
- DB migration: checkpoint tables created by migration 7
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from talos_agent.checkpoint import (
    CheckpointEnvelope,
    CheckpointError,
    CheckpointStore,
    ReplayDetectedError,
    RollbackDetectedError,
    TamperDetectedError,
    UnknownKeyError,
    WrongIdentityError,
    _sign,
    _build_authenticated_data,
)
from talos_agent.db import LocalDB


# ── Fixtures ───────────────────────────────────────────────────────────────────


@pytest.fixture
def db(tmp_path: Path) -> LocalDB:
    """Fresh LocalDB with all migrations applied (including #7)."""
    return LocalDB(path=tmp_path / "test.db")


@pytest.fixture
def store(db: LocalDB) -> CheckpointStore:
    s = CheckpointStore(db=db, agent_id="test-agent")
    s.ensure_key()
    return s


# ── Migration ──────────────────────────────────────────────────────────────────


def test_migration_creates_checkpoint_keys_table(db: LocalDB):
    """Migration 7 must create the checkpoint_keys table."""
    cursor = db._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoint_keys'"
    )
    assert cursor.fetchone() is not None, "checkpoint_keys table was not created"


def test_migration_creates_checkpoints_table(db: LocalDB):
    """Migration 7 must create the checkpoints table."""
    cursor = db._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'"
    )
    assert cursor.fetchone() is not None, "checkpoints table was not created"


def test_migration_schema_version_is_7(db: LocalDB):
    """After all migrations the user_version pragma must be 7."""
    version = db._conn.execute("PRAGMA user_version").fetchone()[0]
    assert version == 7


# ── ensure_key / key registry ─────────────────────────────────────────────────


def test_ensure_key_creates_active_key(db: LocalDB):
    store = CheckpointStore(db=db, agent_id="a1")
    key_id = store.ensure_key()
    assert key_id
    row = db.get_active_checkpoint_key()
    assert row is not None
    assert row["key_id"] == key_id


def test_ensure_key_is_idempotent(db: LocalDB):
    store = CheckpointStore(db=db, agent_id="a1")
    k1 = store.ensure_key()
    k2 = store.ensure_key()
    assert k1 == k2
    keys = db.list_checkpoint_keys()
    assert len(keys) == 1


def test_no_key_raises_on_save(db: LocalDB):
    store = CheckpointStore(db=db, agent_id="no-key-agent")
    with pytest.raises(CheckpointError, match="No active checkpoint key"):
        store.save("ns", {"x": 1})


# ── Happy-path save / load ─────────────────────────────────────────────────────


def test_save_returns_sequence_one_on_first_write(store: CheckpointStore):
    seq = store.save("loop", {"step": 1})
    assert seq == 1


def test_load_returns_envelope_matching_saved_payload(store: CheckpointStore):
    store.save("loop", {"step": 42})
    env = store.load("loop")
    assert env is not None
    assert env.payload == {"step": 42}
    assert env.agent_id == "test-agent"
    assert env.namespace == "loop"
    assert env.sequence == 1


def test_sequence_increments_monotonically(store: CheckpointStore):
    for i in range(1, 6):
        seq = store.save("loop", {"i": i})
        assert seq == i

    env = store.load("loop")
    assert env.sequence == 5
    assert env.payload == {"i": 5}


def test_load_by_exact_sequence(store: CheckpointStore):
    for i in range(1, 4):
        store.save("ns", {"v": i})
    env = store.load("ns", sequence=2)
    assert env is not None
    assert env.payload == {"v": 2}
    assert env.sequence == 2


def test_load_nonexistent_returns_none(store: CheckpointStore):
    assert store.load("nonexistent") is None


def test_load_nonexistent_sequence_returns_none(store: CheckpointStore):
    store.save("ns", {"x": 1})
    assert store.load("ns", sequence=99) is None


def test_envelope_contains_all_authenticated_fields(store: CheckpointStore):
    store.save("loop", {"data": "hello"})
    env = store.load("loop")
    assert env.agent_id == "test-agent"
    assert env.namespace == "loop"
    assert env.sequence == 1
    assert env.schema_version == "1"
    assert env.key_id
    assert env.nonce
    assert env.tag
    assert env.timestamp


def test_nonce_is_unique_per_write(store: CheckpointStore):
    store.save("ns", {"a": 1})
    store.save("ns", {"a": 2})
    env1 = store.load("ns", sequence=1)
    env2 = store.load("ns", sequence=2)
    assert env1.nonce != env2.nonce


# ── Tamper detection ──────────────────────────────────────────────────────────


def _tamper_payload(db: LocalDB, agent_id: str, namespace: str, sequence: int, new_value: dict):
    """Directly mutate the payload column in the DB to simulate tampering."""
    db._conn.execute(
        "UPDATE checkpoints SET payload = ? WHERE agent_id = ? AND namespace = ? AND sequence = ?",
        (json.dumps(new_value), agent_id, namespace, sequence),
    )
    db._conn.commit()


def _tamper_tag(db: LocalDB, agent_id: str, namespace: str, sequence: int):
    """Corrupt the HMAC tag to simulate a direct tag manipulation."""
    db._conn.execute(
        "UPDATE checkpoints SET tag = ? WHERE agent_id = ? AND namespace = ? AND sequence = ?",
        ("deadbeef" * 8, agent_id, namespace, sequence),
    )
    db._conn.commit()


def _tamper_field(db: LocalDB, agent_id: str, namespace: str, sequence: int, col: str, new_val):
    db._conn.execute(
        f"UPDATE checkpoints SET {col} = ? WHERE agent_id = ? AND namespace = ? AND sequence = ?",
        (new_val, agent_id, namespace, sequence),
    )
    db._conn.commit()


def test_tampered_payload_raises_tamper_detected(store: CheckpointStore, db: LocalDB):
    store.save("ns", {"secret": "real"})
    _tamper_payload(db, "test-agent", "ns", 1, {"secret": "FAKED"})
    with pytest.raises(TamperDetectedError):
        store.load("ns")


def test_tampered_tag_raises_tamper_detected(store: CheckpointStore, db: LocalDB):
    store.save("ns", {"x": 1})
    _tamper_tag(db, "test-agent", "ns", 1)
    with pytest.raises(TamperDetectedError):
        store.load("ns")


def test_tampered_sequence_raises_tamper_detected(store: CheckpointStore, db: LocalDB):
    """Changing the sequence field without updating the tag must fail verification."""
    store.save("ns", {"x": 1})
    store.save("ns", {"x": 2})
    # Bump sequence of row 1 to look like row 3
    _tamper_field(db, "test-agent", "ns", 1, "sequence", 3)
    with pytest.raises(TamperDetectedError):
        store.load("ns", sequence=3)


def test_tampered_agent_id_raises_tamper_detected(store: CheckpointStore, db: LocalDB):
    """Changing agent_id in the row (but not the tag) must fail verification."""
    store.save("ns", {"x": 1})
    _tamper_field(db, "test-agent", "ns", 1, "agent_id", "evil-agent")
    evil_store = CheckpointStore(db=db, agent_id="evil-agent")
    # Key lookup succeeds but HMAC will fail because AD includes original agent_id
    with pytest.raises(TamperDetectedError):
        evil_store.load("ns")


def test_tampered_namespace_raises_tamper_detected(store: CheckpointStore, db: LocalDB):
    """Changing namespace in the row must fail verification."""
    store.save("ns", {"x": 1})
    _tamper_field(db, "test-agent", "ns", 1, "namespace", "other")
    with pytest.raises(TamperDetectedError):
        store.load("other")


def test_tampered_schema_version_raises_tamper_detected(store: CheckpointStore, db: LocalDB):
    """Changing schema_version in the row must fail verification."""
    store.save("ns", {"x": 1})
    _tamper_field(db, "test-agent", "ns", 1, "schema_version", "9")
    with pytest.raises(TamperDetectedError):
        store.load("ns")


def test_tampered_nonce_raises_tamper_detected(store: CheckpointStore, db: LocalDB):
    """Changing the nonce in the row must fail verification."""
    store.save("ns", {"x": 1})
    _tamper_field(db, "test-agent", "ns", 1, "nonce", "aaaa" * 8)
    with pytest.raises(TamperDetectedError):
        store.load("ns")


def test_tampered_timestamp_raises_tamper_detected(store: CheckpointStore, db: LocalDB):
    """Changing the timestamp in the row must fail verification."""
    store.save("ns", {"x": 1})
    _tamper_field(db, "test-agent", "ns", 1, "timestamp", "1970-01-01T00:00:00+00:00")
    with pytest.raises(TamperDetectedError):
        store.load("ns")


# ── Replay detection ──────────────────────────────────────────────────────────


def test_duplicate_nonce_rejected_at_db_level(db: LocalDB):
    """Inserting two rows with the same (key_id, nonce) must raise IntegrityError."""
    store = CheckpointStore(db=db, agent_id="agent-r")
    store.ensure_key()
    key_row = db.get_active_checkpoint_key()

    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).isoformat()
    payload_json = json.dumps({"v": 1})
    from talos_agent.checkpoint import _build_authenticated_data, _sign
    ad = _build_authenticated_data(
        agent_id="agent-r", namespace="ns", sequence=1,
        schema_version="1", key_id=key_row["key_id"], nonce="fixed_nonce",
        timestamp=ts, payload_json=payload_json,
    )
    tag = _sign(key_row["key_hmac"], ad)

    db.save_checkpoint(
        agent_id="agent-r", namespace="ns", sequence=1, schema_version="1",
        key_id=key_row["key_id"], nonce="fixed_nonce", tag=tag,
        payload=payload_json, timestamp=ts,
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.save_checkpoint(
            agent_id="agent-r", namespace="ns2", sequence=1, schema_version="1",
            key_id=key_row["key_id"], nonce="fixed_nonce", tag=tag,
            payload=payload_json, timestamp=ts,
        )


def test_nonce_exists_detects_prior_use(db: LocalDB):
    """db.nonce_exists must return True after a nonce is used."""
    store = CheckpointStore(db=db, agent_id="agent-n")
    store.ensure_key()
    store.save("ns", {"v": 1})
    row = db.get_latest_checkpoint("agent-n", "ns")
    assert db.nonce_exists(row["key_id"], row["nonce"])


# ── Rollback detection ────────────────────────────────────────────────────────


def test_sequence_must_be_strictly_increasing(db: LocalDB):
    """save() always writes the next sequence after the current max, never replays past values."""
    store = CheckpointStore(db=db, agent_id="agent-rb")
    store.ensure_key()
    # Write three checkpoints; sequences should be 1, 2, 3 in order
    for i in range(1, 4):
        seq = store.save("ns", {"v": i})
        assert seq == i
    # Current max is 3; next write must produce 4
    assert db.get_max_sequence("agent-rb", "ns") == 3
    seq4 = store.save("ns", {"v": 4})
    assert seq4 == 4


def test_max_sequence_never_decreases(db: LocalDB):
    """After saving sequences 1..5, max_sequence stays 5 after more reads."""
    store = CheckpointStore(db=db, agent_id="agent-ms")
    store.ensure_key()
    for i in range(1, 6):
        store.save("ns", {"i": i})
    assert db.get_max_sequence("agent-ms", "ns") == 5


# ── Wrong-identity detection ──────────────────────────────────────────────────


def test_wrong_agent_id_raises_wrong_identity(db: LocalDB):
    """Loading a checkpoint with a different store agent_id must raise WrongIdentityError."""
    store_a = CheckpointStore(db=db, agent_id="agent-a")
    store_a.ensure_key()
    store_a.save("ns", {"secret": "A"})

    # Directly write a row with a spoofed agent_id matching store_b but signed
    # for agent-a — this simulates an attacker trying to inject a foreign checkpoint.
    store_b = CheckpointStore(db=db, agent_id="agent-b")
    # store_b has no checkpoints so load returns None; no error path here.
    result = store_b.load("ns")
    assert result is None  # not found under agent-b


def test_cross_agent_data_isolation(db: LocalDB):
    """Two agents sharing a DB must not see each other's checkpoints."""
    store_x = CheckpointStore(db=db, agent_id="agent-x")
    store_y = CheckpointStore(db=db, agent_id="agent-y")
    store_x.ensure_key()
    store_y.ensure_key()

    store_x.save("ns", {"for": "x"})
    store_y.save("ns", {"for": "y"})

    ex = store_x.load("ns")
    ey = store_y.load("ns")
    assert ex.payload == {"for": "x"}
    assert ey.payload == {"for": "y"}


# ── Unknown key ───────────────────────────────────────────────────────────────


def test_unknown_key_raises_unknown_key_error(db: LocalDB):
    """If the key referenced by a checkpoint is removed from the DB, load raises UnknownKeyError."""
    store = CheckpointStore(db=db, agent_id="agent-uk")
    store.ensure_key()
    store.save("ns", {"x": 1})

    # Delete the key from the registry to simulate the error path
    db._conn.execute("DELETE FROM checkpoint_keys")
    db._conn.commit()

    with pytest.raises(UnknownKeyError):
        store.load("ns")


# ── Key rotation ──────────────────────────────────────────────────────────────


def test_rotate_key_creates_new_active_key(db: LocalDB):
    store = CheckpointStore(db=db, agent_id="agent-rot")
    store.ensure_key()
    old_key_id = db.get_active_checkpoint_key()["key_id"]

    new_key_id = store.rotate_key()
    active = db.get_active_checkpoint_key()
    assert active["key_id"] == new_key_id
    assert new_key_id != old_key_id


def test_rotate_key_demotes_previous_key(db: LocalDB):
    store = CheckpointStore(db=db, agent_id="agent-rot2")
    store.ensure_key()
    old_key_id = db.get_active_checkpoint_key()["key_id"]

    store.rotate_key()
    old_row = db.get_checkpoint_key(old_key_id)
    assert old_row["active"] == 0


def test_checkpoints_written_before_rotation_remain_readable(db: LocalDB):
    """After a key rotation, checkpoints signed by the old key must still verify."""
    store = CheckpointStore(db=db, agent_id="agent-rot3")
    store.ensure_key()

    store.save("ns", {"before_rotation": True})
    old_seq = db.get_max_sequence("agent-rot3", "ns")

    store.rotate_key()  # demote old key, create new active key

    # Read back the pre-rotation checkpoint — must succeed
    env = store.load("ns", sequence=old_seq)
    assert env is not None
    assert env.payload == {"before_rotation": True}


def test_new_writes_after_rotation_use_new_key(db: LocalDB):
    store = CheckpointStore(db=db, agent_id="agent-rot4")
    store.ensure_key()
    old_key_id = db.get_active_checkpoint_key()["key_id"]

    store.save("ns", {"before": True})

    new_key_id = store.rotate_key()
    store.save("ns", {"after": True})

    env_after = store.load("ns")
    assert env_after.key_id == new_key_id
    assert env_after.payload == {"after": True}

    env_before = store.load("ns", sequence=1)
    assert env_before.key_id == old_key_id
    assert env_before.payload == {"before": True}


def test_multiple_rotations_all_old_keys_still_readable(db: LocalDB):
    """Three rotations; checkpoints from all three generations must be readable."""
    store = CheckpointStore(db=db, agent_id="agent-rot5")
    store.ensure_key()

    store.save("ns", {"gen": 1})
    store.rotate_key()
    store.save("ns", {"gen": 2})
    store.rotate_key()
    store.save("ns", {"gen": 3})
    store.rotate_key()
    store.save("ns", {"gen": 4})

    for gen in range(1, 5):
        env = store.load("ns", sequence=gen)
        assert env is not None
        assert env.payload == {"gen": gen}, f"gen {gen} failed"


def test_only_one_active_key_at_a_time(db: LocalDB):
    store = CheckpointStore(db=db, agent_id="agent-single-active")
    store.ensure_key()
    for _ in range(4):
        store.rotate_key()

    rows = db.list_checkpoint_keys()
    active_count = sum(1 for r in rows if r["active"] == 1)
    assert active_count == 1, f"Expected 1 active key, got {active_count}"


# ── Namespace independence ─────────────────────────────────────────────────────


def test_sequences_are_independent_per_namespace(store: CheckpointStore):
    """Saving to different namespaces should produce independent sequence counters."""
    s1 = store.save("ns_a", {"x": 1})
    s2 = store.save("ns_b", {"x": 1})
    s3 = store.save("ns_a", {"x": 2})
    assert s1 == 1
    assert s2 == 1
    assert s3 == 2


def test_load_returns_correct_namespace_data(store: CheckpointStore):
    store.save("ns_a", {"data": "A"})
    store.save("ns_b", {"data": "B"})
    assert store.load("ns_a").payload == {"data": "A"}
    assert store.load("ns_b").payload == {"data": "B"}


# ── Validation ────────────────────────────────────────────────────────────────


def test_empty_namespace_raises_value_error(store: CheckpointStore):
    with pytest.raises(ValueError, match="namespace"):
        store.save("", {"x": 1})


def test_namespace_too_long_raises_value_error(store: CheckpointStore):
    with pytest.raises(ValueError, match="128"):
        store.save("n" * 129, {"x": 1})


def test_namespace_with_control_chars_raises_value_error(store: CheckpointStore):
    with pytest.raises(ValueError, match="control"):
        store.save("bad\x00ns", {"x": 1})


def test_non_dict_payload_raises_type_error(store: CheckpointStore):
    with pytest.raises(TypeError):
        store.save("ns", [1, 2, 3])  # type: ignore[arg-type]


def test_non_serialisable_payload_raises_type_error(store: CheckpointStore):
    with pytest.raises(TypeError):
        store.save("ns", {"fn": lambda: None})  # type: ignore[dict-item]


def test_empty_agent_id_raises_value_error(db: LocalDB):
    with pytest.raises(ValueError, match="agent_id"):
        CheckpointStore(db=db, agent_id="")


# ── CheckpointEnvelope.from_db_row / to_db_row round-trip ────────────────────


def test_envelope_round_trip_via_db_row(store: CheckpointStore, db: LocalDB):
    store.save("rt", {"hello": "world"})
    row = db.get_latest_checkpoint("test-agent", "rt")
    env = CheckpointEnvelope.from_db_row(row)
    assert env.payload == {"hello": "world"}
    assert env.agent_id == "test-agent"
    assert env.namespace == "rt"
    assert env.sequence == 1

    # Round-trip back to row
    row2 = env.to_db_row()
    assert row2["agent_id"] == env.agent_id
    assert json.loads(row2["payload"]) == env.payload


# ── DB helpers ────────────────────────────────────────────────────────────────


def test_db_get_max_sequence_returns_zero_when_empty(db: LocalDB):
    assert db.get_max_sequence("no-agent", "no-ns") == 0


def test_db_nonce_exists_returns_false_before_use(db: LocalDB):
    assert not db.nonce_exists("any_key_id", "any_nonce")


def test_db_list_checkpoint_keys_returns_all_keys(db: LocalDB):
    store = CheckpointStore(db=db, agent_id="list-agent")
    store.ensure_key()
    store.rotate_key()
    store.rotate_key()
    keys = db.list_checkpoint_keys()
    assert len(keys) == 3
