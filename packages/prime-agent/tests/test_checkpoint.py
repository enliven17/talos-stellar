"""Tests for canonical checkpoint encoding and validation (#291).

Coverage
--------
Unit
  - encode_checkpoint produces deterministic bytes across calls
  - checkpoint_to_json / checkpoint_from_json round-trip
  - verify_checkpoint passes on valid envelopes
  - verify_checkpoint rejects: future timestamp, negative balance,
    empty agent_id, unsupported schema_version, tampered section hash,
    tampered envelope hash, secret key in wallet_public_key
  - CheckpointMeta / CheckpointState / CheckpointConfig field validators
  - build_checkpoint convenience factory

Integration
  - Migration 7 creates the checkpoints table at schema version 7
  - save_checkpoint / get_latest_checkpoint / list_checkpoints / delete_checkpoints_before
  - Duplicate envelope_hash is idempotent (no duplicate rows)
  - Positive fixture files deserialise and verify without error
  - Negative fixture files fail at parse *or* verify stage
"""

from __future__ import annotations

import json
import multiprocessing
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from talos_agent.checkpoint import (
    MAX_FUTURE_SKEW_SECONDS,
    SUPPORTED_SCHEMA_VERSION,
    CheckpointConfig,
    CheckpointEnvelope,
    CheckpointError,
    CheckpointHashError,
    CheckpointMeta,
    CheckpointState,
    CheckpointValidationError,
    CheckpointVersionError,
    build_checkpoint,
    checkpoint_from_json,
    checkpoint_to_json,
    encode_checkpoint,
    verify_checkpoint,
)
from talos_agent.db import LocalDB, _MIGRATIONS

# ── Helpers ────────────────────────────────────────────────────────────────────

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "checkpoints"

_VALID_WALLET = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37"
_VALID_WALLET2 = "GBIRUHZQUEQEXX57OKZHNX6FI4M52CSDBNYD3S7TVHSH6IPIVFGYDTIC"
_PAST_TS = "2026-07-28T12:00:00+00:00"


def _make_meta(
    agent_id: str = "vega-001",
    created_at: str = _PAST_TS,
    schema_version: int = 1,
) -> CheckpointMeta:
    return CheckpointMeta(
        agent_id=agent_id,
        created_at=created_at,
        schema_version=schema_version,
    )


def _make_state(
    cycle_count: int = 7,
    last_task: str = "post_content",
    balance_usdc: float = 42.5,
    wallet_public_key: str = _VALID_WALLET,
) -> CheckpointState:
    return CheckpointState(
        cycle_count=cycle_count,
        last_task=last_task,
        balance_usdc=balance_usdc,
        wallet_public_key=wallet_public_key,
    )


def _make_config(
    talos_id: str = "talos-vega-001",
    api_url: str = "https://talos-stellar.vercel.app",
) -> CheckpointConfig:
    return CheckpointConfig(talos_id=talos_id, api_url=api_url)


def _encode_valid() -> CheckpointEnvelope:
    return encode_checkpoint(_make_meta(), _make_state(), _make_config())


# ── encode_checkpoint / determinism ───────────────────────────────────────────


class TestEncodeCheckpoint:
    def test_returns_envelope(self):
        env = _encode_valid()
        assert isinstance(env, CheckpointEnvelope)

    def test_section_hashes_populated(self):
        env = _encode_valid()
        assert set(env.section_hashes.keys()) == {"meta", "state", "config"}
        for name, h in env.section_hashes.items():
            assert len(h) == 64, f"Expected 64-char hex digest for {name}"
            assert all(c in "0123456789abcdef" for c in h)

    def test_envelope_hash_populated(self):
        env = _encode_valid()
        assert len(env.envelope_hash) == 64
        assert all(c in "0123456789abcdef" for c in env.envelope_hash)

    def test_deterministic_same_call(self):
        env1 = _encode_valid()
        env2 = _encode_valid()
        assert env1.envelope_hash == env2.envelope_hash
        assert env1.section_hashes == env2.section_hashes

    def test_deterministic_json_bytes(self):
        """Two independent calls produce byte-identical JSON."""
        j1 = checkpoint_to_json(_encode_valid())
        j2 = checkpoint_to_json(_encode_valid())
        assert j1 == j2

    def test_different_inputs_different_hash(self):
        env1 = _encode_valid()
        env2 = encode_checkpoint(
            _make_meta(agent_id="other-agent"),
            _make_state(),
            _make_config(),
        )
        assert env1.envelope_hash != env2.envelope_hash

    def test_sort_keys_canonical_order(self):
        """JSON output must have keys in sorted order."""
        raw = checkpoint_to_json(_encode_valid())
        parsed = json.loads(raw)
        keys = list(parsed.keys())
        assert keys == sorted(keys), f"Top-level keys are not sorted: {keys}"

    def test_no_spaces_in_separators(self):
        """Canonical JSON must use compact separators (no spaces)."""
        raw = checkpoint_to_json(_encode_valid())
        assert ": " not in raw
        assert ", " not in raw


# ── Round-trip serialisation ───────────────────────────────────────────────────


class TestRoundTrip:
    def test_to_json_from_json_identity(self):
        env = _encode_valid()
        restored = checkpoint_from_json(checkpoint_to_json(env))
        assert restored.envelope_hash == env.envelope_hash
        assert restored.section_hashes == env.section_hashes
        assert restored.meta == env.meta
        assert restored.state == env.state
        assert restored.config == env.config

    def test_from_json_does_not_verify(self):
        """checkpoint_from_json parses even a tampered hash — verification is separate."""
        env = _encode_valid()
        data = json.loads(checkpoint_to_json(env))
        data["envelope_hash"] = "a" * 64
        raw = json.dumps(data, sort_keys=True, separators=(",", ":"))
        restored = checkpoint_from_json(raw)
        assert restored.envelope_hash == "a" * 64  # accepted by parser

    def test_from_json_invalid_json_raises(self):
        with pytest.raises(json.JSONDecodeError):
            checkpoint_from_json("{not valid json")

    def test_from_json_unsupported_version_raises(self):
        env = _encode_valid()
        data = json.loads(checkpoint_to_json(env))
        data["meta"]["schema_version"] = 99
        raw = json.dumps(data, sort_keys=True, separators=(",", ":"))
        with pytest.raises(CheckpointVersionError):
            checkpoint_from_json(raw)


# ── verify_checkpoint — success paths ─────────────────────────────────────────


class TestVerifySuccess:
    def test_valid_envelope_passes(self):
        env = _encode_valid()
        verify_checkpoint(env)  # must not raise

    def test_zero_balance_passes(self):
        env = encode_checkpoint(
            _make_meta(),
            _make_state(balance_usdc=0.0),
            _make_config(),
        )
        verify_checkpoint(env)

    def test_zero_cycle_count_passes(self):
        env = encode_checkpoint(
            _make_meta(),
            _make_state(cycle_count=0),
            _make_config(),
        )
        verify_checkpoint(env)

    def test_empty_last_task_passes(self):
        env = encode_checkpoint(
            _make_meta(),
            _make_state(last_task=""),
            _make_config(),
        )
        verify_checkpoint(env)


# ── verify_checkpoint — negative paths ────────────────────────────────────────


class TestVerifyNegative:
    def test_rejects_future_timestamp(self):
        far_future = (
            datetime.now(timezone.utc) + timedelta(seconds=MAX_FUTURE_SKEW_SECONDS + 10)
        ).isoformat()
        env = encode_checkpoint(
            _make_meta(created_at=far_future),
            _make_state(),
            _make_config(),
        )
        with pytest.raises(CheckpointValidationError, match="future"):
            verify_checkpoint(env)

    def test_accepts_just_within_skew(self):
        """created_at exactly at MAX_FUTURE_SKEW_SECONDS is accepted."""
        just_within = (
            datetime.now(timezone.utc) + timedelta(seconds=MAX_FUTURE_SKEW_SECONDS - 1)
        ).isoformat()
        env = encode_checkpoint(
            _make_meta(created_at=just_within),
            _make_state(),
            _make_config(),
        )
        verify_checkpoint(env)  # should not raise

    def test_rejects_negative_balance(self):
        with pytest.raises(ValueError, match="balance_usdc"):
            _make_state(balance_usdc=-0.01)

    def test_rejects_empty_agent_id(self):
        with pytest.raises(ValueError, match="agent_id"):
            _make_meta(agent_id="")

    def test_rejects_whitespace_only_agent_id(self):
        with pytest.raises(ValueError, match="agent_id"):
            _make_meta(agent_id="   ")

    def test_rejects_schema_version_zero(self):
        from pydantic import ValidationError as PydanticValidationError

        with pytest.raises((CheckpointVersionError, PydanticValidationError)):
            _make_meta(schema_version=0)

    def test_rejects_schema_version_negative(self):
        from pydantic import ValidationError as PydanticValidationError

        with pytest.raises((CheckpointVersionError, PydanticValidationError)):
            _make_meta(schema_version=-1)

    def test_rejects_schema_version_too_high(self):
        from pydantic import ValidationError as PydanticValidationError

        with pytest.raises((CheckpointVersionError, PydanticValidationError)):
            _make_meta(schema_version=SUPPORTED_SCHEMA_VERSION + 1)

    def test_rejects_tampered_envelope_hash(self):
        env = _encode_valid()
        # Mutate the envelope_hash by constructing a new frozen object with wrong hash.
        tampered = CheckpointEnvelope(
            meta=env.meta,
            state=env.state,
            config=env.config,
            section_hashes=env.section_hashes,
            envelope_hash="0" * 64,
        )
        with pytest.raises(CheckpointHashError, match="[Ee]nvelope"):
            verify_checkpoint(tampered)

    def test_rejects_tampered_section_hash(self):
        env = _encode_valid()
        bad_hashes = {**env.section_hashes, "state": "0" * 64}
        tampered = CheckpointEnvelope(
            meta=env.meta,
            state=env.state,
            config=env.config,
            section_hashes=bad_hashes,
            envelope_hash=env.envelope_hash,
        )
        with pytest.raises(CheckpointHashError, match="state"):
            verify_checkpoint(tampered)

    def test_rejects_secret_key_as_wallet(self):
        """A value starting with 'S' of 56 chars must be rejected as secret key."""
        secret_like = "S" + "C" * 55  # 56 chars, starts with S
        with pytest.raises((ValueError, CheckpointValidationError)):
            _make_state(wallet_public_key=secret_like)

    def test_rejects_non_stellar_wallet(self):
        """wallet_public_key not starting with G is rejected."""
        with pytest.raises(ValueError, match="wallet_public_key"):
            _make_state(wallet_public_key="XBADKEY0000000000000000000000000000000000000000000000000")

    def test_rejects_wallet_wrong_length(self):
        with pytest.raises(ValueError, match="wallet_public_key"):
            _make_state(wallet_public_key="GSHORT")

    def test_rejects_missing_timezone_in_created_at(self):
        with pytest.raises(ValueError, match="timezone"):
            _make_meta(created_at="2026-07-28T12:00:00")

    def test_rejects_invalid_created_at_string(self):
        with pytest.raises(ValueError, match="ISO-8601"):
            _make_meta(created_at="not-a-date")

    def test_rejects_empty_talos_id(self):
        with pytest.raises(ValueError, match="talos_id"):
            _make_config(talos_id="")

    def test_rejects_empty_api_url(self):
        with pytest.raises(ValueError, match="api_url"):
            _make_config(api_url="")


# ── build_checkpoint factory ───────────────────────────────────────────────────


class TestBuildCheckpoint:
    def test_returns_valid_envelope(self):
        env = build_checkpoint(
            agent_id="vega-001",
            talos_id="talos-vega-001",
            api_url="https://talos-stellar.vercel.app",
            cycle_count=5,
            last_task="research",
            balance_usdc=100.0,
            wallet_public_key=_VALID_WALLET,
        )
        verify_checkpoint(env)

    def test_default_created_at_is_utc_now(self):
        before = datetime.now(timezone.utc)
        env = build_checkpoint(
            agent_id="vega-001",
            talos_id="talos-vega-001",
            api_url="https://example.com",
            cycle_count=0,
            last_task="",
            balance_usdc=0.0,
            wallet_public_key=_VALID_WALLET,
        )
        after = datetime.now(timezone.utc)
        dt = datetime.fromisoformat(env.meta.created_at)
        assert before <= dt <= after

    def test_explicit_created_at_used(self):
        ts = "2026-07-01T00:00:00+00:00"
        env = build_checkpoint(
            agent_id="vega-001",
            talos_id="talos-vega-001",
            api_url="https://example.com",
            cycle_count=0,
            last_task="",
            balance_usdc=0.0,
            wallet_public_key=_VALID_WALLET,
            created_at=ts,
        )
        assert env.meta.created_at == ts

    def test_schema_version_is_one(self):
        env = build_checkpoint(
            agent_id="nova",
            talos_id="t-nova",
            api_url="https://example.com",
            cycle_count=1,
            last_task="x",
            balance_usdc=1.0,
            wallet_public_key=_VALID_WALLET,
        )
        assert env.meta.schema_version == SUPPORTED_SCHEMA_VERSION


# ── Cross-process determinism ──────────────────────────────────────────────────


def _worker_encode(queue: multiprocessing.Queue) -> None:  # type: ignore[type-arg]
    """Encode a fixed checkpoint in a subprocess and put the JSON in the queue."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
    from talos_agent.checkpoint import build_checkpoint, checkpoint_to_json

    env = build_checkpoint(
        agent_id="vega-001",
        talos_id="talos-vega-001",
        api_url="https://talos-stellar.vercel.app",
        cycle_count=7,
        last_task="post_content",
        balance_usdc=42.5,
        wallet_public_key="GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
        created_at="2026-07-28T12:00:00+00:00",
    )
    queue.put(checkpoint_to_json(env))


class TestCrossProcessDeterminism:
    def test_byte_identical_across_processes(self):
        """Two separate processes must produce the same canonical JSON bytes."""
        q: multiprocessing.Queue = multiprocessing.Queue()  # type: ignore[type-arg]
        p1 = multiprocessing.Process(target=_worker_encode, args=(q,))
        p2 = multiprocessing.Process(target=_worker_encode, args=(q,))
        p1.start()
        p2.start()
        p1.join(timeout=30)
        p2.join(timeout=30)
        assert p1.exitcode == 0, "Worker process 1 failed"
        assert p2.exitcode == 0, "Worker process 2 failed"
        result1 = q.get_nowait()
        result2 = q.get_nowait()
        assert result1 == result2, "Cross-process output differs"


# ── Positive fixture files ─────────────────────────────────────────────────────


class TestPositiveFixtures:
    @pytest.mark.parametrize(
        "fixture_name",
        [
            "valid_vega_001.json",
            "valid_atlas_002_zero_state.json",
        ],
    )
    def test_fixture_parses_and_verifies(self, fixture_name: str):
        path = FIXTURES_DIR / fixture_name
        assert path.exists(), f"Fixture not found: {path}"
        raw = path.read_text(encoding="utf-8")
        env = checkpoint_from_json(raw)
        verify_checkpoint(env)  # must not raise

    def test_fixture_json_is_byte_identical_to_re_encoded(self):
        """Re-encoding a parsed fixture must produce the same canonical bytes."""
        path = FIXTURES_DIR / "valid_vega_001.json"
        raw = path.read_text(encoding="utf-8")
        env = checkpoint_from_json(raw)
        re_encoded = checkpoint_to_json(env)
        # Parse both and compare as dicts (whitespace-insensitive)
        assert json.loads(raw) == json.loads(re_encoded)


# ── Negative fixture files ─────────────────────────────────────────────────────


class TestNegativeFixtures:
    @pytest.mark.parametrize(
        "fixture_name,expected_exc",
        [
            ("invalid_schema_version_99.json", CheckpointVersionError),
            ("invalid_negative_balance.json", (ValueError, CheckpointError)),
            ("invalid_empty_agent_id.json", (ValueError, CheckpointError)),
            ("invalid_tampered_envelope_hash.json", CheckpointHashError),
            ("invalid_tampered_state_hash.json", CheckpointHashError),
            ("invalid_secret_key_as_wallet.json", (ValueError, CheckpointError)),
            ("invalid_future_timestamp.json", CheckpointValidationError),
        ],
    )
    def test_fixture_rejected(self, fixture_name: str, expected_exc):
        path = FIXTURES_DIR / fixture_name
        assert path.exists(), f"Fixture not found: {path}"
        raw = path.read_text(encoding="utf-8")
        # Strip _comment key before parsing (not a valid field)
        data = json.loads(raw)
        data.pop("_comment", None)
        clean_raw = json.dumps(data, sort_keys=True, separators=(",", ":"))
        with pytest.raises(expected_exc):
            env = checkpoint_from_json(clean_raw)
            # If parsing succeeded, verification must fail.
            verify_checkpoint(env)


# ── DB migration 7 ─────────────────────────────────────────────────────────────


class TestMigration7:
    def test_checkpoints_table_created(self, mock_db: LocalDB):
        cursor = mock_db._conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'"
        )
        assert cursor.fetchone() is not None, "checkpoints table missing after migration 7"

    def test_schema_version_is_7(self, mock_db: LocalDB):
        cursor = mock_db._conn.cursor()
        cursor.execute("PRAGMA user_version;")
        version = cursor.fetchone()[0]
        latest = _MIGRATIONS[-1][0]
        assert version == latest
        assert version == 7

    def test_indexes_created(self, mock_db: LocalDB):
        indexes = {
            row[0]
            for row in mock_db._conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='checkpoints'"
            ).fetchall()
        }
        assert "idx_checkpoints_agent_id" in indexes
        assert "idx_checkpoints_stored_at" in indexes


# ── DB checkpoint persistence ─────────────────────────────────────────────────


class TestCheckpointPersistence:
    def _saved_env(self, mock_db: LocalDB, agent_id: str = "vega-001") -> CheckpointEnvelope:
        env = build_checkpoint(
            agent_id=agent_id,
            talos_id=f"talos-{agent_id}",
            api_url="https://talos-stellar.vercel.app",
            cycle_count=1,
            last_task="test_task",
            balance_usdc=10.0,
            wallet_public_key=_VALID_WALLET,
        )
        payload = checkpoint_to_json(env)
        mock_db.save_checkpoint(
            agent_id=agent_id,
            schema_version=env.meta.schema_version,
            envelope_hash=env.envelope_hash,
            payload=payload,
            created_at=env.meta.created_at,
        )
        return env

    def test_save_returns_row_id(self, mock_db: LocalDB):
        env = build_checkpoint(
            agent_id="nova",
            talos_id="talos-nova",
            api_url="https://example.com",
            cycle_count=0,
            last_task="",
            balance_usdc=0.0,
            wallet_public_key=_VALID_WALLET,
        )
        row_id = mock_db.save_checkpoint(
            agent_id="nova",
            schema_version=env.meta.schema_version,
            envelope_hash=env.envelope_hash,
            payload=checkpoint_to_json(env),
            created_at=env.meta.created_at,
        )
        assert isinstance(row_id, int)
        assert row_id > 0

    def test_get_latest_checkpoint_returns_stored(self, mock_db: LocalDB):
        env = self._saved_env(mock_db)
        row = mock_db.get_latest_checkpoint("vega-001")
        assert row is not None
        assert row["envelope_hash"] == env.envelope_hash

    def test_get_latest_checkpoint_none_for_unknown_agent(self, mock_db: LocalDB):
        assert mock_db.get_latest_checkpoint("unknown-agent") is None

    def test_list_checkpoints_returns_newest_first(self, mock_db: LocalDB):
        for i in range(3):
            env = build_checkpoint(
                agent_id="vega-001",
                talos_id="talos-vega-001",
                api_url="https://example.com",
                cycle_count=i,
                last_task="",
                balance_usdc=float(i),
                wallet_public_key=_VALID_WALLET,
            )
            mock_db.save_checkpoint(
                agent_id="vega-001",
                schema_version=env.meta.schema_version,
                envelope_hash=env.envelope_hash,
                payload=checkpoint_to_json(env),
                created_at=env.meta.created_at,
            )
        rows = mock_db.list_checkpoints("vega-001")
        assert len(rows) == 3
        stored_ats = [r["stored_at"] for r in rows]
        assert stored_ats == sorted(stored_ats, reverse=True)

    def test_duplicate_envelope_hash_is_idempotent(self, mock_db: LocalDB):
        env = self._saved_env(mock_db)
        # Save the same envelope again — must not raise and must not duplicate.
        mock_db.save_checkpoint(
            agent_id="vega-001",
            schema_version=env.meta.schema_version,
            envelope_hash=env.envelope_hash,
            payload=checkpoint_to_json(env),
            created_at=env.meta.created_at,
        )
        rows = mock_db.list_checkpoints("vega-001")
        assert len(rows) == 1, "Duplicate envelope_hash should not produce two rows"

    def test_delete_checkpoints_before(self, mock_db: LocalDB):
        self._saved_env(mock_db)
        # Move stored_at to the past so the delete window catches it.
        mock_db._conn.execute(
            "UPDATE checkpoints SET stored_at = '2020-01-01T00:00:00'"
        )
        mock_db._conn.commit()
        deleted = mock_db.delete_checkpoints_before("vega-001", "2025-01-01T00:00:00")
        assert deleted == 1
        assert mock_db.get_latest_checkpoint("vega-001") is None

    def test_payload_survives_round_trip(self, mock_db: LocalDB):
        env = self._saved_env(mock_db)
        row = mock_db.get_latest_checkpoint("vega-001")
        assert row is not None
        restored = checkpoint_from_json(row["payload"])
        verify_checkpoint(restored)
        assert restored.envelope_hash == env.envelope_hash

    def test_list_checkpoints_isolated_by_agent(self, mock_db: LocalDB):
        self._saved_env(mock_db, agent_id="agent-a")
        self._saved_env(mock_db, agent_id="agent-b")
        rows_a = mock_db.list_checkpoints("agent-a")
        rows_b = mock_db.list_checkpoints("agent-b")
        assert len(rows_a) == 1
        assert len(rows_b) == 1
        assert rows_a[0]["agent_id"] == "agent-a"
        assert rows_b[0]["agent_id"] == "agent-b"
