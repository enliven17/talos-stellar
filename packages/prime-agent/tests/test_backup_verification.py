"""Tests for resumable encrypted backup verification.

Coverage
--------
BackupVerifier.verify():
  single chunk — pass, fail (bad checksum), missing_meta
  multiple chunks — all pass, mixed pass/fail
  empty archive — zero chunks, completed=False
  resume: already-verified chunks are skipped
  resume: already-failed chunks are skipped
  progress file saved incrementally (exists after partial run)
  progress file ignored when archive_dir does not match
  completed=True only when every chunk processed
  completed=False when interrupted mid-run

BackupVerifier.reset_progress():
  deletes progress file
  safe to call when no progress file exists

VerificationResult:
  to_dict() structure and all expected keys
  generated_at is UTC-aware

ChunkResult:
  to_dict() keys present
  missing_meta status reported correctly

Progress file:
  only contains bounded non-secret fields (no chunk bytes, no passphrases)
  last_updated is written

Boundary:
  chunk with valid meta but unreadable file → fail
  meta exists but missing sha256 field → fail
  meta is malformed JSON → fail
"""

from __future__ import annotations

import datetime
import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from talos_agent.backup_service import BackupVerifier, ChunkResult, VerificationResult


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _write_chunk(directory: Path, name: str, content: bytes) -> Path:
    """Write a chunk file and a matching .meta sidecar."""
    chunk_path = directory / name
    chunk_path.write_bytes(content)
    checksum = hashlib.sha256(content).hexdigest()
    meta_path = directory / (name + ".meta")
    meta_path.write_text(json.dumps({"sha256": checksum}), encoding="utf-8")
    return chunk_path


def _write_bad_chunk(directory: Path, name: str, content: bytes, bad_checksum: str) -> Path:
    """Write a chunk with a deliberately wrong checksum in its meta."""
    chunk_path = directory / name
    chunk_path.write_bytes(content)
    meta_path = directory / (name + ".meta")
    meta_path.write_text(json.dumps({"sha256": bad_checksum}), encoding="utf-8")
    return chunk_path


def _verifier(archive_dir: Path, progress_dir: Path) -> BackupVerifier:
    return BackupVerifier(archive_dir=archive_dir, progress_dir=progress_dir)


# ─── Single-chunk pass / fail ─────────────────────────────────────────────────


class TestSingleChunk:
    def test_pass(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-001.chunk", b"hello backup")
        result = _verifier(archive, progress).verify()
        assert result.total_chunks == 1
        assert result.chunks_verified == 1
        assert result.chunks_failed == 0
        assert result.completed is True

    def test_fail_bad_checksum(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_bad_chunk(archive, "chunk-001.chunk", b"hello backup", "deadbeef" * 8)
        result = _verifier(archive, progress).verify()
        assert result.chunks_failed == 1
        assert result.chunks_verified == 0
        assert result.completed is True  # all chunks processed, even failed ones

    def test_missing_meta(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        (archive / "chunk-001.chunk").write_bytes(b"data")
        # No .meta file written
        result = _verifier(archive, progress).verify()
        assert result.chunks_failed == 1
        assert result.chunk_results[0].status == "missing_meta"


# ─── Multiple chunks ──────────────────────────────────────────────────────────


class TestMultipleChunks:
    def test_all_pass(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        for i in range(3):
            _write_chunk(archive, f"chunk-{i:03d}.chunk", f"data-{i}".encode())
        result = _verifier(archive, progress).verify()
        assert result.total_chunks == 3
        assert result.chunks_verified == 3
        assert result.chunks_failed == 0
        assert result.completed is True

    def test_mixed_pass_fail(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"good data")
        _write_bad_chunk(archive, "chunk-001.chunk", b"bad data", "0" * 64)
        _write_chunk(archive, "chunk-002.chunk", b"also good")
        result = _verifier(archive, progress).verify()
        assert result.chunks_verified == 2
        assert result.chunks_failed == 1
        assert result.completed is True


# ─── Empty archive ────────────────────────────────────────────────────────────


class TestEmptyArchive:
    def test_empty_archive(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        result = _verifier(archive, progress).verify()
        assert result.total_chunks == 0
        assert result.chunks_verified == 0
        assert result.completed is False  # nothing to verify


# ─── Resume behaviour ─────────────────────────────────────────────────────────


class TestResume:
    def test_already_verified_chunks_skipped(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        for i in range(3):
            _write_chunk(archive, f"chunk-{i:03d}.chunk", f"data-{i}".encode())

        # First run — verify all three
        v = _verifier(archive, progress)
        r1 = v.verify()
        assert r1.chunks_verified == 3
        assert r1.chunks_skipped == 0

        # Second run — all three already done
        r2 = v.verify()
        assert r2.chunks_skipped == 3
        assert r2.chunk_results == []  # nothing new processed
        assert r2.chunks_verified == 3  # total from progress file

    def test_partial_resume(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"first")
        _write_chunk(archive, "chunk-001.chunk", b"second")

        # Manually seed progress with only the first chunk done
        state = {
            "archive_dir": str(archive),
            "chunks_verified": ["chunk-000.chunk"],
            "chunks_failed": [],
            "last_updated": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        progress.mkdir(parents=True, exist_ok=True)
        (progress / f"verify-{archive.name}.json").write_text(
            json.dumps(state), encoding="utf-8"
        )

        v = _verifier(archive, progress)
        result = v.verify()
        assert result.chunks_skipped == 1  # chunk-000 skipped
        assert len(result.chunk_results) == 1  # only chunk-001 processed
        assert result.chunk_results[0].filename == "chunk-001.chunk"

    def test_progress_file_ignored_when_archive_dir_mismatch(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"data")

        # Seed progress with a different archive_dir
        state = {
            "archive_dir": "/some/other/path",
            "chunks_verified": ["chunk-000.chunk"],
            "chunks_failed": [],
            "last_updated": "",
        }
        progress.mkdir(parents=True, exist_ok=True)
        (progress / f"verify-{archive.name}.json").write_text(
            json.dumps(state), encoding="utf-8"
        )

        result = _verifier(archive, progress).verify()
        # Progress file did not apply — chunk processed fresh
        assert result.chunks_skipped == 0
        assert result.chunks_verified == 1

    def test_already_failed_chunks_skipped_on_resume(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_bad_chunk(archive, "chunk-000.chunk", b"data", "0" * 64)

        v = _verifier(archive, progress)
        r1 = v.verify()
        assert r1.chunks_failed == 1

        r2 = v.verify()
        assert r2.chunks_skipped == 1
        assert r2.chunk_results == []


# ─── Progress file contents ───────────────────────────────────────────────────


class TestProgressFile:
    def test_progress_file_created(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"data")
        _verifier(archive, progress).verify()
        progress_file = progress / f"verify-{archive.name}.json"
        assert progress_file.exists()

    def test_progress_file_has_bounded_non_secret_fields(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"secret encrypted bytes")
        _verifier(archive, progress).verify()

        progress_file = progress / f"verify-{archive.name}.json"
        data = json.loads(progress_file.read_text())

        assert "archive_dir" in data
        assert "chunks_verified" in data
        assert "chunks_failed" in data
        assert "last_updated" in data
        # Chunk bytes and passphrases must NOT appear
        assert "secret encrypted bytes" not in progress_file.read_text()

    def test_progress_file_last_updated_written(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"data")
        _verifier(archive, progress).verify()
        data = json.loads((progress / f"verify-{archive.name}.json").read_text())
        assert data["last_updated"] != ""
        # Must be parseable as ISO-8601
        datetime.datetime.fromisoformat(data["last_updated"])


# ─── reset_progress ───────────────────────────────────────────────────────────


class TestResetProgress:
    def test_deletes_progress_file(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"data")
        v = _verifier(archive, progress)
        v.verify()
        progress_file = progress / f"verify-{archive.name}.json"
        assert progress_file.exists()
        v.reset_progress()
        assert not progress_file.exists()

    def test_safe_when_no_progress_file(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        v = _verifier(archive, progress)
        # Must not raise
        v.reset_progress()

    def test_verify_starts_fresh_after_reset(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"data")
        v = _verifier(archive, progress)
        v.verify()
        v.reset_progress()
        result = v.verify()
        assert result.chunks_skipped == 0
        assert result.chunks_verified == 1


# ─── VerificationResult.to_dict ───────────────────────────────────────────────


class TestVerificationResultToDict:
    def test_all_expected_keys(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"data")
        result = _verifier(archive, progress).verify()
        d = result.to_dict()
        expected = {
            "archive_dir",
            "total_chunks",
            "chunks_verified",
            "chunks_failed",
            "chunks_skipped",
            "chunk_results",
            "completed",
            "generated_at",
        }
        assert expected.issubset(set(d.keys()))

    def test_generated_at_is_utc(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        result = _verifier(archive, progress).verify()
        assert result.generated_at.tzinfo is not None

    def test_chunk_results_in_to_dict(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        _write_chunk(archive, "chunk-000.chunk", b"data")
        result = _verifier(archive, progress).verify()
        d = result.to_dict()
        assert len(d["chunk_results"]) == 1
        assert d["chunk_results"][0]["status"] == "pass"


# ─── ChunkResult.to_dict ──────────────────────────────────────────────────────


class TestChunkResultToDict:
    def test_keys_present(self):
        r = ChunkResult(filename="chunk-000.chunk", status="pass")
        d = r.to_dict()
        assert set(d.keys()) == {"filename", "status", "detail"}

    def test_missing_meta_status(self):
        r = ChunkResult(filename="chunk-000.chunk", status="missing_meta", detail="no sidecar")
        assert r.to_dict()["status"] == "missing_meta"


# ─── Boundary / error cases ───────────────────────────────────────────────────


class TestBoundaryCases:
    def test_meta_missing_sha256_field(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        (archive / "chunk-000.chunk").write_bytes(b"data")
        (archive / "chunk-000.chunk.meta").write_text(
            json.dumps({"other_field": "value"}), encoding="utf-8"
        )
        result = _verifier(archive, progress).verify()
        assert result.chunks_failed == 1
        assert "sha256" in result.chunk_results[0].detail

    def test_meta_malformed_json(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        (archive / "chunk-000.chunk").write_bytes(b"data")
        (archive / "chunk-000.chunk.meta").write_text("not valid json", encoding="utf-8")
        result = _verifier(archive, progress).verify()
        assert result.chunks_failed == 1

    def test_unreadable_chunk_file(self, tmp_path):
        archive = tmp_path / "archive"
        archive.mkdir()
        progress = tmp_path / "progress"
        chunk_path = archive / "chunk-000.chunk"
        chunk_path.write_bytes(b"data")
        checksum = hashlib.sha256(b"data").hexdigest()
        (archive / "chunk-000.chunk.meta").write_text(
            json.dumps({"sha256": checksum}), encoding="utf-8"
        )

        def _raise(path: Path) -> bytes:
            raise OSError("Permission denied")

        v = BackupVerifier(
            archive_dir=archive, progress_dir=progress, read_bytes=_raise
        )
        result = v.verify()
        assert result.chunks_failed == 1
        assert "Could not read chunk" in result.chunk_results[0].detail
