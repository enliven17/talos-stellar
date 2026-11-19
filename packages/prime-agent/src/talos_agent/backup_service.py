"""Backup service — resumable encrypted backup verification.

The verifier checks archive chunks and their metadata without restoring any
data.  Progress is persisted to a small JSON file so an interrupted run can
resume from where it left off.  Only bounded, non-secret information is
written to the progress file: chunk indices, checksums and status flags.

Usage
-----
Run a full verification pass::

    from talos_agent.backup_service import BackupVerifier, VerificationResult

    verifier = BackupVerifier(archive_dir="/path/to/backup", progress_dir="/tmp/verify")
    result = verifier.verify()
    print(result.to_dict())

Resume an interrupted pass::

    # Calling verify() again on the same archive_dir + progress_dir resumes
    # automatically; already-verified chunks are skipped.
    result = verifier.verify()

Verification steps
------------------
For each chunk file in the archive directory the verifier:

1. Checks that a corresponding ``.meta`` sidecar file exists.
2. Reads the expected SHA-256 checksum from the metadata.
3. Computes the actual SHA-256 of the chunk bytes.
4. Compares expected vs actual; records PASS or FAIL.

No decryption is performed.  The verifier operates on the raw (encrypted)
bytes so no key material is required or read.

Progress file
-------------
The progress file is written to ``progress_dir`` as
``verify-<archive_name>.json``.  It records only:

* ``archive_dir`` — absolute path of the archive being verified
* ``chunks_verified`` — list of chunk filenames that passed
* ``chunks_failed`` — list of chunk filenames that failed
* ``last_updated`` — UTC ISO-8601 timestamp

Secrets, decrypted payloads, and passphrase hints are never written.
"""

from __future__ import annotations

import datetime
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


# ── Chunk result ──────────────────────────────────────────────────────────────


@dataclass
class ChunkResult:
    """Verification outcome for one archive chunk."""

    filename: str
    """Chunk file name (not full path — basename only)."""

    status: str  # "pass" | "fail" | "missing_meta"
    """Verification status for this chunk."""

    detail: str = ""
    """Human-readable explanation, e.g. the expected vs actual checksum."""

    def to_dict(self) -> dict:
        return {"filename": self.filename, "status": self.status, "detail": self.detail}


# ── Verification result ───────────────────────────────────────────────────────


@dataclass
class VerificationResult:
    """Aggregate result of a (possibly resumed) verification pass."""

    archive_dir: str
    """Absolute path of the archive directory."""

    total_chunks: int = 0
    """Total number of chunk files found in the archive."""

    chunks_verified: int = 0
    """Chunks that passed verification (this run + prior runs via resume)."""

    chunks_failed: int = 0
    """Chunks that failed verification."""

    chunks_skipped: int = 0
    """Chunks skipped because they were already verified in a prior run."""

    chunk_results: list[ChunkResult] = field(default_factory=list)
    """Per-chunk outcomes for the current run only."""

    completed: bool = False
    """``True`` when every chunk in the archive has been verified."""

    generated_at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )

    def to_dict(self) -> dict:
        return {
            "archive_dir": self.archive_dir,
            "total_chunks": self.total_chunks,
            "chunks_verified": self.chunks_verified,
            "chunks_failed": self.chunks_failed,
            "chunks_skipped": self.chunks_skipped,
            "chunk_results": [r.to_dict() for r in self.chunk_results],
            "completed": self.completed,
            "generated_at": self.generated_at.isoformat(),
        }


# ── Progress state ────────────────────────────────────────────────────────────


@dataclass
class _ProgressState:
    archive_dir: str
    chunks_verified: list[str] = field(default_factory=list)
    chunks_failed: list[str] = field(default_factory=list)
    last_updated: str = ""

    def to_dict(self) -> dict:
        return {
            "archive_dir": self.archive_dir,
            "chunks_verified": self.chunks_verified,
            "chunks_failed": self.chunks_failed,
            "last_updated": self.last_updated,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "_ProgressState":
        return cls(
            archive_dir=data.get("archive_dir", ""),
            chunks_verified=data.get("chunks_verified", []),
            chunks_failed=data.get("chunks_failed", []),
            last_updated=data.get("last_updated", ""),
        )


# ── Verifier ──────────────────────────────────────────────────────────────────

_DEFAULT_CHUNK_GLOB = "*.chunk"
_META_SUFFIX = ".meta"


class BackupVerifier:
    """Verifies encrypted archive chunks without restoring them.

    Parameters
    ----------
    archive_dir:
        Directory containing ``.chunk`` files and their ``.meta`` sidecars.
    progress_dir:
        Directory where the bounded progress file is stored.  Created if it
        does not exist.  Must not be inside ``archive_dir``.
    chunk_glob:
        Glob pattern used to discover chunk files (default: ``"*.chunk"``).
    hasher_factory:
        Callable that returns a new hashlib-compatible hash object.  Defaults
        to ``hashlib.sha256``.  Injected for testing without real files.
    read_bytes:
        Callable ``(path: Path) -> bytes`` used to read chunk content.
        Defaults to ``Path.read_bytes``.  Injected for testing.
    """

    def __init__(
        self,
        archive_dir: str | Path,
        progress_dir: str | Path,
        chunk_glob: str = _DEFAULT_CHUNK_GLOB,
        hasher_factory: Callable = hashlib.sha256,
        read_bytes: Callable[[Path], bytes] | None = None,
    ) -> None:
        self._archive_dir = Path(archive_dir)
        self._progress_dir = Path(progress_dir)
        self._chunk_glob = chunk_glob
        self._hasher_factory = hasher_factory
        self._read_bytes: Callable[[Path], bytes] = read_bytes or (lambda p: p.read_bytes())

    # ── Progress file I/O ─────────────────────────────────────

    def _progress_path(self) -> Path:
        name = f"verify-{self._archive_dir.name}.json"
        return self._progress_dir / name

    def _load_progress(self) -> _ProgressState:
        path = self._progress_path()
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if data.get("archive_dir") == str(self._archive_dir):
                    return _ProgressState.from_dict(data)
            except (json.JSONDecodeError, OSError):
                pass
        return _ProgressState(archive_dir=str(self._archive_dir))

    def _save_progress(self, state: _ProgressState) -> None:
        self._progress_dir.mkdir(parents=True, exist_ok=True)
        state.last_updated = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self._progress_path().write_text(
            json.dumps(state.to_dict(), indent=2), encoding="utf-8"
        )

    # ── Chunk verification ────────────────────────────────────

    def _verify_chunk(self, chunk_path: Path) -> ChunkResult:
        """Verify one chunk file against its metadata checksum.

        Returns a :class:`ChunkResult` with status ``"pass"``, ``"fail"``, or
        ``"missing_meta"``.  No decryption is performed.
        """
        filename = chunk_path.name
        meta_path = chunk_path.with_suffix(chunk_path.suffix + _META_SUFFIX)

        if not meta_path.exists():
            return ChunkResult(
                filename=filename,
                status="missing_meta",
                detail=f"Metadata file not found: {meta_path.name}",
            )

        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            return ChunkResult(
                filename=filename,
                status="fail",
                detail=f"Could not read metadata: {exc}",
            )

        expected_checksum: str = meta.get("sha256", "")
        if not expected_checksum:
            return ChunkResult(
                filename=filename,
                status="fail",
                detail="Metadata does not contain a sha256 field.",
            )

        try:
            data = self._read_bytes(chunk_path)
        except OSError as exc:
            return ChunkResult(
                filename=filename,
                status="fail",
                detail=f"Could not read chunk: {exc}",
            )

        h = self._hasher_factory()
        h.update(data)
        actual_checksum = h.hexdigest()

        if actual_checksum == expected_checksum:
            return ChunkResult(filename=filename, status="pass")

        return ChunkResult(
            filename=filename,
            status="fail",
            detail=f"Checksum mismatch: expected {expected_checksum}, got {actual_checksum}",
        )

    # ── Public API ────────────────────────────────────────────

    def verify(self) -> VerificationResult:
        """Run (or resume) the verification pass.

        Chunks already recorded as verified in the progress file are skipped.
        Progress is saved incrementally after each chunk so the run can be
        interrupted and resumed at any point.

        Returns
        -------
        VerificationResult
            Aggregate outcome.  ``completed`` is ``True`` when every chunk
            has been verified (pass or fail).
        """
        state = self._load_progress()
        already_verified = set(state.chunks_verified)
        already_failed = set(state.chunks_failed)
        already_done = already_verified | already_failed

        chunk_paths = sorted(self._archive_dir.glob(self._chunk_glob))
        total = len(chunk_paths)

        chunk_results: list[ChunkResult] = []
        skipped = 0

        for chunk_path in chunk_paths:
            filename = chunk_path.name
            if filename in already_done:
                skipped += 1
                continue

            result = self._verify_chunk(chunk_path)
            chunk_results.append(result)

            if result.status == "pass":
                state.chunks_verified.append(filename)
            else:
                state.chunks_failed.append(filename)

            self._save_progress(state)

        verified_count = len(state.chunks_verified)
        failed_count = len(state.chunks_failed)
        completed = (verified_count + failed_count) == total and total > 0

        return VerificationResult(
            archive_dir=str(self._archive_dir),
            total_chunks=total,
            chunks_verified=verified_count,
            chunks_failed=failed_count,
            chunks_skipped=skipped,
            chunk_results=chunk_results,
            completed=completed,
        )

    def reset_progress(self) -> None:
        """Delete the progress file so the next ``verify()`` starts fresh."""
        path = self._progress_path()
        if path.exists():
            path.unlink()
