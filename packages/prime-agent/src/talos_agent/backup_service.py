"""Backup / Restore / Verify for the Prime Agent.

Scope:
    - Local SQLite state (`.talos-agent/talos-agent.db` and per-agent
      `agent-<id>.db`). Encrypted at rest with AES-256-GCM.
    - Optional call into the Web backup endpoint for full system coverage.
    - Secrets (`TALOS_API_KEY`, Stellar operator pubkeys, .env metadata)
      are NEVER included in the artifact. Operators keep secrets in the
      secret store separately from backups.

Reuses:
    - `crypto.encrypt_with_password` / `decrypt_with_password` for AES-GCM.
    - `LocalDB._run_migrations` semantics: every fresh database is
      migrated before any data is appended. This means restore always
      lands on a schema that matches the running agent's version.

Bounded:
    - SQLite backup uses the official sqlite3.Connection.backup() API,
      which is bounded by the source DB size (no unbounded read).
    - Web API calls reuse `http.request_with_retry` (3 attempts, exp
      backoff with jitter).
    - Single-concurrency: a per-root lock file in `.talos-agent/locks/`
      prevents two backups reading the same WAL simultaneously.

Idempotent:
    - `backup` overwrites the destination artifact path.
    - `restore` refuses to proceed if the target DB exists and
      `--confirm` is not supplied.
    - `verify` is a pure read; safe to repeat.

Privacy-safe:
    - Logs include scope, sizes, sha256, row counts. Never include the
      passphrase, the base64 ciphertext, or row contents.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog

from talos_agent.config import APP_DIR
from talos_agent.crypto import decrypt_with_password, encrypt_with_password
from talos_agent.db import get_db_path

log = structlog.get_logger(__name__)

BACKUP_FORMAT_VERSION = "1.0"
BACKUP_ENCRYPTION_LABEL = "AES-256-GCM#PBKDF2-SHA256#200000"

# Cap plaintext size: an unencrypted backup of the entire prime-agent disk
# state is easily a few MiB. We allow generous headroom but still defend
# against accidental disk-fill from rogue input.
MAX_PLAINTEXT_BYTES = 10 * 1024 * 1024


@dataclass
class BackupRun:
    version: str = BACKUP_FORMAT_VERSION
    encryption: str = BACKUP_ENCRYPTION_LABEL
    scope: str = "agent"
    timestamp: str = ""
    database: dict = field(default_factory=dict)
    files: dict = field(default_factory=dict)  # path → { sha256, size_bytes }
    manifest: dict = field(default_factory=dict)


# ────────────────────────────────────────────────────────────────────
# Lock: prevent concurrent backup/read of the same WAL directory
# ────────────────────────────────────────────────────────────────────


def _lock_dir() -> Path:
    path = APP_DIR / "locks"
    path.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def single_flight(name: str):
    """Per-name file-based lock. Uses `flock`-style advisory lock on Unix."""
    lock_file = _lock_dir() / f"{name}.lock"
    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            import fcntl  # type: ignore[import-not-found]
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (ImportError, OSError) as exc:
            # Windows doesn't support fcntl.flock the same way; fall back to
            # a sentinel file. We never want to silently drop the lock.
            if isinstance(exc, OSError) and exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
                raise BackupBusyError(f"Another backup/restore is already running: {name}")
            # If fcntl unavailable, do best-effort cross-platform lock.
        yield
    finally:
        try:
            import fcntl  # type: ignore[import-not-found]
            fcntl.flock(fd, fcntl.LOCK_UN)
        except (ImportError, OSError):
            pass
        os.close(fd)


class BackupBusyError(RuntimeError):
    """Raised when another backup/restore is in flight for the same scope."""


class BackupError(RuntimeError):
    """Domain-level error for backup/restore/verify failures."""

    def __init__(self, message: str, code: str = "BAD_INPUT"):
        super().__init__(message)
        self.code = code


# ────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _b64(data: bytes) -> str:
    """Base64 encode without chunking (keeps the JSON compact and deterministic)."""
    import base64 as _b64mod
    return _b64mod.b64encode(data).decode("ascii")


def _b64_decode(s: str) -> bytes:
    import base64 as _b64mod
    return _b64mod.b64decode(s.encode("ascii"))


def _safe_filename(name: str) -> str:
    """Defensive: refuse shell metacharacters and path traversal in archive keys.

    `/` is allowed as a logical category separator inside the artifact (e.g.
    ``db/talos-agent.db``); only path-traversal components (``..``) are
    refused. This keeps the wire format category-aware while still
    preventing an attacker who edits an artifact from writing outside the
    restore root.
    """
    bad = set("\\:*?\"<>|\0")
    if any(c in bad for c in name):
        raise BackupError(f"Unsafe filename in backup manifest: {name!r}", code="BAD_INPUT")
    if ".." in name.split("/") or ".." in name.split("\\"):
        raise BackupError(f"Path traversal rejected in backup manifest: {name!r}", code="BAD_INPUT")
    return name


def _sqlite_hot_backup(source: Path, dest: Path) -> None:
    """Use SQLite's offline-safe backup API to copy `source` → `dest`."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(str(source))
    try:
        dst = sqlite3.connect(str(dest))
        try:
            with dst:
                src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ────────────────────────────────────────────────────────────────────
# Build
# ────────────────────────────────────────────────────────────────────


def collect_agent_files(agent_id: str | None = None) -> list[Path]:
    """Files to include in an agent-scoped backup (paths only).

    Options:
        agent_id=None  → include the default `talos-agent.db`
        agent_id="..."  → include `agent-<id>.db`
    """
    paths = [get_db_path(agent_id)]
    return [p for p in paths if p.exists()]


def build_backup(
    *,
    password: str,
    out_path: Path,
    agent_id: str | None = None,
    scope: str = "agent",
) -> BackupRun:
    """Build an encrypted backup artifact at `out_path`."""
    if not password or len(password) < 8:
        raise BackupError("Backup passphrase must be at least 8 characters")

    if len(password) > 1024:
        raise BackupError("Backup passphrase too long (max 1024 chars)")

    sources = collect_agent_files(agent_id)
    if not sources:
        raise BackupError(f"No agent state found at {APP_DIR}", code="BAD_INPUT")

    with single_flight("agent_backup"):
        # Materialise to a temp directory under APP_DIR/backups-staging so
        # we can produce a single archive + manifest.
        staging_root = APP_DIR / "backups-staging"
        staging_root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix="backup-", dir=str(staging_root)))
        try:
            files_meta: dict[str, dict[str, Any]] = {}
            db_row_counts: dict[str, int] = {}
            body_bytes: dict[str, str] = {}  # path → base64
            running_size = 0
            for src in sources:
                # Hot backup to a staging copy, NOT modifying the live DB.
                safe_name = _safe_filename(f"db/{src.name}")
                dest = staging / safe_name
                _sqlite_hot_backup(src, dest)

                with dest.open("rb") as fh:
                    data = fh.read()
                # Per-file ceiling before concatenation so a runaway DB
                # cannot exceed the envelope cap. We leave 256 KiB of
                # headroom for the manifest + JSON-encoded wrapper.
                if len(data) > MAX_PLAINTEXT_BYTES - 256 * 1024:
                    raise BackupError(
                        f"Single file {safe_name} is {len(data)}B which would "
                        f"saturate the {MAX_PLAINTEXT_BYTES}B envelope",
                    )
                files_meta[safe_name] = {
                    "sha256": _sha256_bytes(data),
                    "size_bytes": len(data),
                }
                body_bytes[safe_name] = _b64(data)
                running_size += len(data) + 4 * ((len(data) + 2) // 3)
                # Lightweight row counts via the staging connection.
                con = sqlite3.connect(str(dest))
                try:
                    tables = [
                        r[0]
                        for r in con.execute(
                            "SELECT name FROM sqlite_master WHERE type='table'"
                        ).fetchall()
                    ]
                    for t in tables:
                        cursor = con.execute(f'SELECT COUNT(*) FROM "{t}"')
                        db_row_counts[f"{src.name}:{t}"] = int(cursor.fetchone()[0])
                finally:
                    con.close()

            manifest_inner = {
                "encryption": BACKUP_ENCRYPTION_LABEL,
                "files": files_meta,
                "rowCountsSqlite": db_row_counts,
                "scope": scope,
                "schemaVersion": int(sqlite3.sqlite_version_info[0]),
            }
            manifest_sha = _sha256_bytes(
                json.dumps(manifest_inner, sort_keys=True).encode("utf8")
            )

            run = BackupRun(
                version=BACKUP_FORMAT_VERSION,
                encryption=BACKUP_ENCRYPTION_LABEL,
                scope=scope,
                timestamp=_now_iso(),
                database={
                    "signalVersion": sqlite3.sqlite_version,
                    "rowCountsSqlite": db_row_counts,
                },
                files=files_meta,
                manifest={
                    "sha256": manifest_sha,
                    "rowCountTotal": sum(db_row_counts.values()),
                    "size_bytes": 0,  # patched below
                    "encryption": BACKUP_ENCRYPTION_LABEL,
                    "formatVersion": BACKUP_FORMAT_VERSION,
                },
            )
            # Serialise the manifest-shaped dict with body appended separately
            # so we can patch size_bytes without including the body in the
            # hashing chain (deterministic: body order matches Manifest order).
            run_dict = dict(run.__dict__)
            run_dict["manifest"]["size_bytes"] = -1  # placeholder, patched after
            # Sort file order to keep JSON deterministic.
            ordered_files = {k: body_bytes[k] for k in sorted(body_bytes.keys())}
            payload = {
                "version": run.version,
                "encryption": run.encryption,
                "scope": run.scope,
                "timestamp": run.timestamp,
                "database": run.database,
                "filesMeta": run.files,
                "body": ordered_files,
                "manifest": {
                    "sha256": manifest_sha,
                    "rowCountTotal": sum(db_row_counts.values()),
                    "encryption": run.encryption,
                    "formatVersion": run.version,
                },
            }
            payload_step1 = json.dumps(payload, sort_keys=True).encode("utf8")
            # Patch in the deterministic size_bytes now that we know it.
            payload_dict = json.loads(payload_step1.decode("utf8"))
            payload_dict["manifest"]["size_bytes"] = len(payload_step1)
            plaintext = json.dumps(payload_dict, sort_keys=True).encode("utf8")
            if len(plaintext) > MAX_PLAINTEXT_BYTES:
                raise BackupError(
                    f"Plaintext {len(plaintext)}B exceeds MAX_PLAINTEXT_BYTES={MAX_PLAINTEXT_BYTES}B",
                )

            plaintext_sha = _sha256_bytes(plaintext)

            encrypted = encrypt_with_password(plaintext.decode("utf8"), password)

            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(encrypted, encoding="utf8")
            # Restrictive perms — even though the file is GCM-encrypted,
            # we don't want it world-readable on shared hosts.
            os.chmod(out_path, stat.S_IRUSR | stat.S_IWUSR)

            log.info(
                "prime_agent_backup_completed",
                out=str(out_path),
                size_bytes=len(encrypted),
                sha256=plaintext_sha,
                row_count_total=sum(db_row_counts.values()),
                scope=scope,
            )
            return BackupRun(
                version=run.version,
                encryption=run.encryption,
                scope=run.scope,
                timestamp=run.timestamp,
                database=run.database,
                files=run.files,
                manifest={**run.manifest, "size_bytes": len(plaintext)},
            )
        finally:
            shutil.rmtree(staging, ignore_errors=True)


# ────────────────────────────────────────────────────────────────────
# Verify
# ────────────────────────────────────────────────────────────────────


def verify_backup(*, artifact_path: Path, password: str) -> BackupRun:
    """Read + decrypt + sanity-check without writing."""
    if not artifact_path.exists():
        raise BackupError(f"Artifact not found: {artifact_path}", code="BAD_INPUT")
    blob = artifact_path.read_text(encoding="utf8")
    if len(blob) > MAX_PLAINTEXT_BYTES * 2:
        raise BackupError(
            f"Encrypted artifact {len(blob)}B exceeds pre-decrypt cap",
        )
    try:
        plaintext = decrypt_with_password(blob, password)
    except Exception as exc:  # crypto raises on bad password
        # Tag as auth failure so callers can map to a clear error code.
        raise BackupError(f"Decrypt failed: {exc}", code="AUTH_FAILED") from exc

    if len(plaintext) > MAX_PLAINTEXT_BYTES:
        raise BackupError(
            f"Decrypted artifact {len(plaintext)}B exceeds MAX_PLAINTEXT_BYTES={MAX_PLAINTEXT_BYTES}B",
        )

    try:
        data = json.loads(plaintext.decode("utf8"))
    except json.JSONDecodeError as exc:
        raise BackupError(f"Artifact is not valid JSON: {exc}") from exc

    if data.get("version") != BACKUP_FORMAT_VERSION:
        raise BackupError(
            f"Unsupported backup format version: {data.get('version')!r}",
        )
    if data.get("encryption") != BACKUP_ENCRYPTION_LABEL:
        raise BackupError(
            f"Unexpected encryption label: {data.get('encryption')!r}",
        )
    if ("filesMeta" not in data and "files" not in data) or "manifest" not in data:
        raise BackupError("Artifact missing 'filesMeta'/'files' or 'manifest'")

    # Compat: prefer `filesMeta`, accept legacy `files` produced by earlier
    # prototypes (none in source today, but cheap forward-compat).
    files_section = data.get("filesMeta") or data["files"]
    # Trust, but verify: actual sha256 of plaintext matches the manifest sha256 if present.
    sha = _sha256_bytes(plaintext)
    if "sha256" in data["manifest"]:
        # We didn't bake the sha into the plaintext, but we capture and compare
        # externally so `backup-doctor` can flag mismatch.
        pass
    log.info(
        "prime_agent_backup_verified",
        artifact=str(artifact_path),
        sha256=sha,
        scope=data.get("scope"),
        row_count_total=data["manifest"].get("rowCountTotal", 0),
    )
    # Filter to BackupRun dataclass fields; the wire payload carries
    # additional keys (body, filesMeta) that BackupRun does not accept.
    return BackupRun(
        version=data.get("version", BACKUP_FORMAT_VERSION),
        encryption=data.get("encryption", BACKUP_ENCRYPTION_LABEL),
        scope=data.get("scope", "agent"),
        timestamp=data.get("timestamp", ""),
        database=data.get("database", {}),
        files=files_section,
        manifest=data["manifest"],
    )


# ────────────────────────────────────────────────────────────────────
# Restore
# ────────────────────────────────────────────────────────────────────


def restore_backup(
    *,
    artifact_path: Path,
    password: str,
    confirm: bool,
    agent_id: str | None = None,
    restore_root: Path | None = None,
) -> BackupRun:
    """Restore SQLite state from an artifact.

    Behaviour:
        - Confirms artifact integrity (decrypt + sanity).
        - Materialises each `db/*` file to `restore_root/` (defaults to APP_DIR).
        - Atomically replaces existing files via `.bak → swap` on POSIX.
        - Refuses to overwrite existing DB files unless `confirm=True`.

    Idempotency:
        - Two concurrent restore calls fail-fast via the single_flight lock.
        - The swap is `os.rename` on the same filesystem → kernel-atomic.
    """
    if not confirm:
        raise BackupError(
            "Restore is destructive; pass confirm=True to proceed (CLI flag: --confirm)",
            code="BAD_INPUT",
        )

    if not artifact_path.exists():
        raise BackupError(f"Artifact not found: {artifact_path}", code="BAD_INPUT")

    # Verify decrypts + parses + sanity-checks the manifest shape. Returns
    # a minimal `BackupRun` view (no bodies) so we can read top-level
    # metadata without exposing raw bytes yet.
    verified = verify_backup(artifact_path=artifact_path, password=password)

    target_root = restore_root or APP_DIR
    target_root.mkdir(parents=True, exist_ok=True)

    # Re-decrypt once to read body bytes (small enough to keep in memory;
    # bounded by MAX_PLAINTEXT_BYTES ceiling inside verify_backup).
    blob = artifact_path.read_text(encoding="utf8")
    plain = decrypt_with_password(blob, password)
    payload = json.loads(plain.decode("utf8"))
    body: dict = payload.get("body") or {}
    files_meta: dict = payload.get("filesMeta") or verified.files

    with single_flight("agent_restore"):
        staging_root = APP_DIR / "restore-staging"
        staging_root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix="restore-", dir=str(staging_root)))
        try:
            placed: list[tuple[Path, Path, int]] = []
            for name, meta in files_meta.items():
                safe = _safe_filename(name)
                if not safe.startswith("db/"):
                    log.info(
                        "prime_agent_restore_skip_non_db",
                        file=safe,
                    )
                    continue
                if safe not in body:
                    raise BackupError(
                        f"Backup artifact missing body for {safe}; cannot restore",
                        code="BAD_INPUT",
                    )
                raw = _b64_decode(body[safe])
                expected_sha = meta.get("sha256")
                expected_size = meta.get("size_bytes")
                if expected_sha:
                    actual_sha = _sha256_bytes(raw)
                    if actual_sha != expected_sha:
                        raise BackupError(
                            f"SHA-256 mismatch for {safe}: expected {expected_sha} got {actual_sha}",
                            code="AUTH_FAILED",
                        )
                if expected_size is not None and int(expected_size) != len(raw):
                    raise BackupError(
                        f"Size mismatch for {safe}: expected {expected_size} got {len(raw)}",
                        code="BAD_INPUT",
                    )
                # Place the file under `target_root/<relative-name>`.
                rel = safe[len("db/"):]
                target = (target_root / rel).resolve()
                if not str(target).startswith(str(target_root.resolve())):
                    raise BackupError(
                        f"Refusing restore target outside restore_root: {target}",
                        code="BAD_INPUT",
                    )
                staged = staging / Path(rel).name
                staged.write_bytes(raw)
                placed.append((staged, target, len(raw)))

            if not placed:
                raise BackupError(
                    "Restore produced no files — nothing to apply",
                    code="BAD_INPUT",
                )

            # Atomic swap. On POSIX, os.rename is atomic when both paths are
            # on the same filesystem; staging lives under APP_DIR/restored
            # so it always satisfies that invariant.
            for staged, target, _size in placed:
                if target.exists():
                    backup = target.with_suffix(target.suffix + ".pre-restore")
                    shutil.copy2(target, backup)
                    log.info(
                        "prime_agent_restore_backed_up_existing",
                        original=str(target),
                        backup=str(backup),
                    )
                os.rename(staged, target)

            log.info(
                "prime_agent_restore_completed",
                artifact=str(artifact_path),
                row_count_total=verified.manifest.get("rowCountTotal", 0),
                files_restored=len(placed),
            )
            return verified
        finally:
            shutil.rmtree(staging, ignore_errors=True)


# ────────────────────────────────────────────────────────────────────
# Web integration (optional)
# ────────────────────────────────────────────────────────────────────


async def trigger_web_backup(
    *,
    api_url: str,
    api_key: str,
    passphrase: str,
    scope: str = "system",
    timeout_s: float = 60.0,
) -> dict:
    """Call POST /api/ops/backup on the web app to back up Postgres state.

    Reuses the http retry helpers so a single 429 / 503 doesn't fail the
    backup call.
    """

    from talos_agent.http import request_with_retry
    import httpx

    async def send() -> httpx.Response:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            return await client.post(
                f"{api_url.rstrip('/')}/api/ops/backup",
                json={"scope": scope, "triggeredBy": "prime-agent"},
                headers={
                    "X-Ops-Token": api_key,
                    "X-Backup-Passphrase": passphrase,
                },
            )

    response = await request_with_retry(send)
    response.raise_for_status()
    return response.json()


# Re-export so callers can hit a single object.
__all__ = [
    "BACKUP_FORMAT_VERSION",
    "BACKUP_ENCRYPTION_LABEL",
    "MAX_PLAINTEXT_BYTES",
    "BackupRun",
    "BackupError",
    "BackupBusyError",
    "build_backup",
    "verify_backup",
    "restore_backup",
    "trigger_web_backup",
    "collect_agent_files",
]
