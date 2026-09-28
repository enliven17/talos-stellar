"""SQLite WAL health diagnostics — privacy-safe operator checks.

Inspects journal mode, WAL/SHM sidecars, checkpoint progress, and a quick
integrity probe without logging secrets, seeds, payment proofs, or row data.
"""

from __future__ import annotations

import enum
import json
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Soft thresholds for operator warnings (not hard failures).
_WAL_SIZE_WARN_BYTES = 16 * 1024 * 1024
_CHECKPOINT_LAG_WARN_FRAMES = 1000
_MAX_RETRIES = 3
_RETRY_SLEEP_SEC = 0.05


class WalHealthState(str, enum.Enum):
    """Overall WAL health classification."""

    HEALTHY = "healthy"
    DEGRADED = "degraded"
    MISSING = "missing"
    ERROR = "error"


@dataclass
class WalHealthReport:
    """Privacy-safe snapshot of SQLite WAL health for one database file."""

    state: WalHealthState
    detail: str
    db_basename: str
    journal_mode: str | None = None
    wal_autocheckpoint: int | None = None
    busy_timeout_ms: int | None = None
    synchronous: str | None = None
    page_count: int | None = None
    page_size: int | None = None
    freelist_count: int | None = None
    db_size_bytes: int | None = None
    wal_exists: bool = False
    wal_size_bytes: int | None = None
    shm_exists: bool = False
    shm_size_bytes: int | None = None
    checkpoint_busy: int | None = None
    checkpoint_log: int | None = None
    checkpoint_checkpointed: int | None = None
    integrity: str | None = None
    findings: list[str] = field(default_factory=list)
    checked_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state.value if isinstance(self.state, enum.Enum) else str(self.state),
            "detail": self.detail,
            "db_basename": self.db_basename,
            "journal_mode": self.journal_mode,
            "wal_autocheckpoint": self.wal_autocheckpoint,
            "busy_timeout_ms": self.busy_timeout_ms,
            "synchronous": self.synchronous,
            "page_count": self.page_count,
            "page_size": self.page_size,
            "freelist_count": self.freelist_count,
            "db_size_bytes": self.db_size_bytes,
            "wal_exists": self.wal_exists,
            "wal_size_bytes": self.wal_size_bytes,
            "shm_exists": self.shm_exists,
            "shm_size_bytes": self.shm_size_bytes,
            "checkpoint_busy": self.checkpoint_busy,
            "checkpoint_log": self.checkpoint_log,
            "checkpoint_checkpointed": self.checkpoint_checkpointed,
            "integrity": self.integrity,
            "findings": list(self.findings),
            "checked_at": self.checked_at.isoformat(),
        }

    def to_json(self, *, indent: int | None = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)


def _safe_basename(path: Path | None) -> str:
    if path is None:
        return "<connection>"
    name = path.name.strip()
    return name or "<unnamed>"


def _file_size(path: Path) -> int | None:
    try:
        if path.is_file():
            return path.stat().st_size
    except OSError:
        return None
    return None


def _pragma_scalar(conn: sqlite3.Connection, pragma: str) -> Any:
    row = conn.execute(f"PRAGMA {pragma}").fetchone()
    if row is None:
        return None
    return row[0]


def _with_retry(fn, *, retries: int = _MAX_RETRIES):
    last_exc: Exception | None = None
    for attempt in range(max(retries, 1)):
        try:
            return fn()
        except sqlite3.OperationalError as exc:
            last_exc = exc
            msg = str(exc).lower()
            if "locked" not in msg and "busy" not in msg:
                raise
            if attempt + 1 >= retries:
                raise
            time.sleep(_RETRY_SLEEP_SEC * (attempt + 1))
    if last_exc:
        raise last_exc
    raise RuntimeError("retry loop exited unexpectedly")


def collect_wal_health(
    path: Path | str | None = None,
    *,
    conn: sqlite3.Connection | None = None,
    run_checkpoint: bool = True,
    run_quick_check: bool = True,
) -> WalHealthReport:
    """Collect WAL health diagnostics for a SQLite database.

    Parameters
    ----------
    path:
        Filesystem path to the ``.db`` file. Used for sidecar size checks and
        for opening a short-lived connection when ``conn`` is omitted.
    conn:
        Optional existing connection (e.g. from :class:`LocalDB`). When
        provided, diagnostics reuse it and do not close it.
    run_checkpoint:
        When True, run ``PRAGMA wal_checkpoint(PASSIVE)`` (non-blocking).
    run_quick_check:
        When True, run ``PRAGMA quick_check(1)`` and surface a truncated result.

    Returns
    -------
    WalHealthReport
        Privacy-safe report suitable for CLI, logs, and dashboards.
    """
    db_path = Path(path) if path is not None else None
    basename = _safe_basename(db_path)
    findings: list[str] = []
    owns_conn = False

    if conn is None:
        if db_path is None:
            return WalHealthReport(
                state=WalHealthState.ERROR,
                detail="No database path or connection provided",
                db_basename=basename,
                findings=["missing_input"],
            )
        if not db_path.exists():
            return WalHealthReport(
                state=WalHealthState.MISSING,
                detail=f"Database file not found: {basename}",
                db_basename=basename,
                findings=["db_missing"],
            )
        if not db_path.is_file():
            return WalHealthReport(
                state=WalHealthState.ERROR,
                detail=f"Database path is not a regular file: {basename}",
                db_basename=basename,
                findings=["db_not_file"],
            )
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
            owns_conn = True
        except sqlite3.Error as exc:
            err_type = type(exc).__name__
            return WalHealthReport(
                state=WalHealthState.ERROR,
                detail=f"Failed to open database ({err_type})",
                db_basename=basename,
                findings=["open_failed"],
            )

    assert conn is not None

    wal_path = db_path.with_suffix(db_path.suffix + "-wal") if db_path else None
    shm_path = db_path.with_suffix(db_path.suffix + "-shm") if db_path else None
    wal_exists = bool(wal_path and wal_path.is_file())
    shm_exists = bool(shm_path and shm_path.is_file())
    wal_size = _file_size(wal_path) if wal_path else None
    shm_size = _file_size(shm_path) if shm_path else None
    db_size = _file_size(db_path) if db_path else None

    journal_mode: str | None = None
    wal_autocheckpoint: int | None = None
    busy_timeout_ms: int | None = None
    synchronous: str | None = None
    page_count: int | None = None
    page_size: int | None = None
    freelist_count: int | None = None
    checkpoint_busy: int | None = None
    checkpoint_log: int | None = None
    checkpoint_checkpointed: int | None = None
    integrity: str | None = None

    try:
        def _read_core() -> None:
            nonlocal journal_mode, wal_autocheckpoint, busy_timeout_ms
            nonlocal synchronous, page_count, page_size, freelist_count
            journal_mode = str(_pragma_scalar(conn, "journal_mode") or "").lower() or None
            wal_autocheckpoint = _pragma_scalar(conn, "wal_autocheckpoint")
            busy_timeout_ms = _pragma_scalar(conn, "busy_timeout")
            sync_val = _pragma_scalar(conn, "synchronous")
            # PRAGMA synchronous returns an int; map common values.
            sync_map = {0: "off", 1: "normal", 2: "full", 3: "extra"}
            if isinstance(sync_val, int):
                synchronous = sync_map.get(sync_val, str(sync_val))
            elif sync_val is not None:
                synchronous = str(sync_val).lower()
            page_count = _pragma_scalar(conn, "page_count")
            page_size = _pragma_scalar(conn, "page_size")
            freelist_count = _pragma_scalar(conn, "freelist_count")

        _with_retry(_read_core)
    except sqlite3.Error as exc:
        if owns_conn:
            conn.close()
        err_type = type(exc).__name__
        return WalHealthReport(
            state=WalHealthState.ERROR,
            detail=f"Failed reading SQLite pragmas ({err_type})",
            db_basename=basename,
            db_size_bytes=db_size,
            wal_exists=wal_exists,
            wal_size_bytes=wal_size,
            shm_exists=shm_exists,
            shm_size_bytes=shm_size,
            findings=["pragma_failed"],
        )

    if run_checkpoint and journal_mode == "wal":
        try:
            def _checkpoint() -> None:
                nonlocal checkpoint_busy, checkpoint_log, checkpoint_checkpointed
                row = conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
                if row is not None:
                    checkpoint_busy = int(row[0])
                    checkpoint_log = int(row[1])
                    checkpoint_checkpointed = int(row[2])

            _with_retry(_checkpoint)
        except sqlite3.Error as exc:
            err_type = type(exc).__name__
            findings.append(f"checkpoint_failed:{err_type}")

    if run_quick_check:
        try:
            def _quick() -> None:
                nonlocal integrity
                row = conn.execute("PRAGMA quick_check(1)").fetchone()
                if row is not None:
                    # Truncate — never return large diagnostic blobs.
                    integrity = str(row[0])[:120]

            _with_retry(_quick)
        except sqlite3.Error as exc:
            err_type = type(exc).__name__
            findings.append(f"quick_check_failed:{err_type}")
            integrity = None

    if owns_conn:
        conn.close()

    # ── Classify ──────────────────────────────────────────────
    if journal_mode is None:
        findings.append("journal_mode_unknown")
    elif journal_mode != "wal":
        findings.append(f"journal_mode_{journal_mode}")

    if wal_size is not None and wal_size >= _WAL_SIZE_WARN_BYTES:
        findings.append("wal_size_large")

    if (
        checkpoint_log is not None
        and checkpoint_checkpointed is not None
        and (checkpoint_log - checkpoint_checkpointed) >= _CHECKPOINT_LAG_WARN_FRAMES
    ):
        findings.append("checkpoint_lag")

    if checkpoint_busy == 1:
        findings.append("checkpoint_busy")

    if integrity is not None and integrity.lower() != "ok":
        findings.append("integrity_failed")

    if journal_mode == "wal" and db_path is not None and not wal_exists:
        # Fresh DB after open may not have flushed a WAL yet — informational.
        findings.append("wal_sidecar_absent")

    state = WalHealthState.HEALTHY
    detail = "SQLite WAL mode is active and healthy"

    if integrity is not None and integrity.lower() != "ok":
        state = WalHealthState.ERROR
        detail = "SQLite quick_check reported integrity problems"
    elif journal_mode != "wal":
        state = WalHealthState.DEGRADED
        detail = f"Expected journal_mode=wal, got {journal_mode or 'unknown'}"
    elif "checkpoint_failed" in " ".join(findings) or "quick_check_failed" in " ".join(findings):
        state = WalHealthState.DEGRADED
        detail = "WAL mode active but one or more probes failed"
    elif "wal_size_large" in findings or "checkpoint_lag" in findings:
        state = WalHealthState.DEGRADED
        detail = "WAL mode active with checkpoint pressure or large WAL file"
    elif "checkpoint_busy" in findings:
        # Writers/readers blocked a passive checkpoint — usually transient.
        state = WalHealthState.HEALTHY
        detail = "SQLite WAL mode active; passive checkpoint was busy (transient)"
        findings = [f for f in findings if f != "checkpoint_busy"]
        findings.append("checkpoint_busy_transient")

    # wal_sidecar_absent alone is not degraded on a healthy WAL connection.
    if state == WalHealthState.HEALTHY and findings == ["wal_sidecar_absent"]:
        detail = "SQLite WAL mode active; WAL sidecar not yet created"

    return WalHealthReport(
        state=state,
        detail=detail,
        db_basename=basename,
        journal_mode=journal_mode,
        wal_autocheckpoint=int(wal_autocheckpoint) if wal_autocheckpoint is not None else None,
        busy_timeout_ms=int(busy_timeout_ms) if busy_timeout_ms is not None else None,
        synchronous=synchronous,
        page_count=int(page_count) if page_count is not None else None,
        page_size=int(page_size) if page_size is not None else None,
        freelist_count=int(freelist_count) if freelist_count is not None else None,
        db_size_bytes=db_size,
        wal_exists=wal_exists,
        wal_size_bytes=wal_size,
        shm_exists=shm_exists,
        shm_size_bytes=shm_size,
        checkpoint_busy=checkpoint_busy,
        checkpoint_log=checkpoint_log,
        checkpoint_checkpointed=checkpoint_checkpointed,
        integrity=integrity,
        findings=findings,
    )
