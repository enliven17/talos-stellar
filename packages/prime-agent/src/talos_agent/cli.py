"""CLI entry point — talos-agent start|config|status."""

from __future__ import annotations

import asyncio
from dataclasses import asdict
import json
import os
import re
import sys
import uuid

import click
from rich.console import Console

from talos_agent import __version__
from talos_agent.checkpoint_cli import checkpoint
from talos_agent.config import APP_DIR, Settings, ensure_app_dir

console = Console()


@click.group()
@click.version_option(__version__, prog_name="talos-agent")
def main():
    """Talos Protocol Prime Agent — autonomous GTM agent."""


main.add_command(checkpoint)


@main.command()
@click.option("--talos-id", default=None, help="Talos ID (overrides TALOS_ID in .env)")
@click.option("--env-file", default=".env", help="Path to .env file")
def start(talos_id: str | None, env_file: str):
    """Start the Prime Agent for a Talos."""
    ensure_app_dir()

    # Load .env into os.environ so child processes (Stagehand SEA) inherit them
    env_path = Path(env_file)
    if env_path.exists():
        from talos_agent.crypto import decrypt_with_password

        raw = env_path.read_text().splitlines()
        # detect whether any encrypted entries exist
        has_encrypted = any(
            "ENC::" in line
            for line in raw
            if line and "=" in line and not line.strip().startswith("#")
        )
        master_key = os.environ.get("TALOS_MASTER_KEY")
        if has_encrypted and not master_key:
            master_key = click.prompt("Master password (to decrypt secrets)", hide_input=True)

        for line in raw:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if value.startswith("ENC::"):
                try:
                    if not master_key:
                        console.print(f"[red]Error:[/red] Encrypted value for {key} but no master password available.")
                        sys.exit(1)
                    dec = decrypt_with_password(value, master_key)
                    os.environ.setdefault(key, dec)
                except Exception as e:
                    console.print(f"[red]Error decrypting {key}:[/red] {e}")
                    sys.exit(1)
            else:
                os.environ.setdefault(key, value)

    kwargs: dict = {"_env_file": env_file}
    if talos_id:
        kwargs["talos_id"] = talos_id
    settings = Settings(**kwargs)

    all_keys = settings.get_all_api_keys()
    if not all_keys:
        console.print("[red]Error:[/red] TALOS_API_KEY (or TALOS_API_KEYS) is required.")
        sys.exit(1)
    if not settings.llm_api_key:
        console.print("[red]Error:[/red] GROQ_API_KEY (or OPENAI_API_KEY) is required.")
        sys.exit(1)

    console.print(f"[bold green]Talos Agent v{__version__}[/bold green]")
    console.print(f"  Agents:    {len(all_keys)}")
    console.print(f"  API URL:   {settings.talos_api_url}")
    console.print()

    if len(all_keys) == 1:
        from talos_agent.scheduler import run
        asyncio.run(run(settings))
    else:
        from talos_agent.scheduler import run_multi
        asyncio.run(run_multi(settings, all_keys))


@main.command()
@click.option("--api-key", prompt="Talos API Key", help="API key issued at Talos creation")
@click.option("--openai-key", prompt="OpenAI API Key", help="OpenAI API key")
def config(api_key: str, openai_key: str):
    """Configure agent credentials (saved to ~/.talos-agent/config.json)."""
    if Settings().secret_rotation_enabled:
        raise click.ClickException(
            "plaintext config writes are disabled while secret rotation is enabled; "
            "use `talos-agent secrets rotate`"
        )
    ensure_app_dir()
    cfg_path = APP_DIR / "config.json"

    existing = {}
    if cfg_path.exists():
        existing = json.loads(cfg_path.read_text())

    existing.update({
        k: v for k, v in {
            "talos_api_key": api_key,
            "openai_api_key": openai_key,
        }.items() if v
    })

    cfg_path.write_text(json.dumps(existing, indent=2))
    console.print(f"[green]Config saved to {cfg_path}[/green]")



@main.command(name="encrypt-keys")
@click.option("--env-file", default=".env", help="Path to .env file to encrypt secrets in")
def encrypt_keys(env_file: str):
    """Encrypt plaintext secret-like values in an .env file using a master password."""
    from pathlib import Path
    from talos_agent.crypto import encrypt_with_password

    path = Path(env_file)
    if not path.exists():
        console.print(f"[red]Error:[/red] {path} not found")
        sys.exit(1)

    master_key = os.environ.get("TALOS_MASTER_KEY")
    if not master_key:
        master_key = click.prompt("Master password (to encrypt .env)", hide_input=True, confirmation_prompt=True)

    text = path.read_text()
    lines = text.splitlines()
    secret_re = re.compile(r"^S[A-Z2-7]{55}$")
    changed = 0
    out_lines = []
    for line in lines:
        raw = line
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            out_lines.append(raw)
            continue
        key, _, value = raw.partition("=")
        k = key.strip()
        v = value.strip()
        if v.startswith("ENC::"):
            out_lines.append(raw)
            continue
        if secret_re.match(v):
            enc = encrypt_with_password(v, master_key)
            out_lines.append(f"{k}={enc}")
            changed += 1
        else:
            out_lines.append(raw)

    if changed == 0:
        console.print("[yellow]No secret-like values found to encrypt.[/yellow]")
        return

    backup = path.with_suffix(path.suffix + ".bak") if path.suffix else Path(str(path) + ".bak")
    path.rename(backup)
    path.write_text("\n".join(out_lines) + "\n")
    console.print(f"[green]Encrypted {changed} values. Original saved to {backup}[/green]")


@main.group()
def jobs():
    """Inspect and safely requeue durable job effects."""


def _job_store(db_path: str | None, talos_id: str):
    from pathlib import Path

    from talos_agent.db import LocalDB
    from talos_agent.job_effects import JobEffectLimits, JobEffectStore

    settings = Settings()
    limits = JobEffectLimits(
        max_inbox_records=settings.talos_job_effect_max_inbox_records,
        max_outbox_records=settings.talos_job_effect_max_outbox_records,
        max_payload_bytes=settings.talos_job_effect_max_payload_bytes,
        max_result_bytes=settings.talos_job_effect_max_result_bytes,
        batch_size=settings.talos_job_effect_batch_size,
        lease_seconds=settings.talos_job_effect_lease_seconds,
        max_attempts=settings.talos_job_effect_max_attempts,
        retry_base_seconds=settings.talos_job_effect_retry_base_seconds,
        dispatch_timeout_seconds=settings.talos_job_effect_dispatch_timeout_seconds,
        remote_lease_ttl_seconds=settings.job_lease_ttl,
        busy_timeout_ms=settings.talos_job_effect_db_timeout_ms,
    )
    db = LocalDB(path=Path(db_path)) if db_path else LocalDB()
    return db, JobEffectStore(db, owner_talos_id=talos_id, limits=limits)


@jobs.command(name="inspect")
@click.option("--talos-id", required=True, help="Talos scope whose effects may be inspected")
@click.option("--db-path", default=None, type=click.Path(dir_okay=False))
@click.option(
    "--status",
    default=None,
    type=click.Choice(
        [
            "pending",
            "dispatching",
            "succeeded",
            "retryable",
            "indeterminate",
            "conflict",
            "dead",
        ],
        case_sensitive=True,
    ),
)
@click.option("--limit", default=50, type=click.IntRange(1, 200))
@click.option("--json", "as_json", is_flag=True, help="Emit metadata as JSON")
def inspect_jobs(
    talos_id: str,
    db_path: str | None,
    status: str | None,
    limit: int,
    as_json: bool,
):
    """List replay metadata without printing payloads or results."""
    from talos_agent.job_effects import JobEffectError

    db = None
    try:
        db, store = _job_store(db_path, talos_id)
        rows = store.inspect(status=status, limit=limit)
        if as_json:
            console.print_json(json.dumps({"effects": rows, "count": len(rows)}))
            return
        if not rows:
            console.print("[dim]No matching durable job effects.[/dim]")
            return
        for row in rows:
            console.print(
                f"{row['effect_id']} job={row['job_id']} state={row['state']} "
                f"attempts={row['attempt_count']} "
                f"error={row['last_error_code'] or '-'}"
            )
    except JobEffectError as exc:
        raise click.ClickException(f"{exc.code}: {exc}") from exc
    finally:
        if db is not None:
            db.close()


@jobs.command(name="retry")
@click.argument("effect_id")
@click.option("--talos-id", required=True, help="Talos scope that owns the effect")
@click.option("--db-path", default=None, type=click.Path(dir_okay=False))
@click.option("--expected-attempt", required=True, type=click.IntRange(min=0))
def retry_job_effect(
    effect_id: str,
    talos_id: str,
    db_path: str | None,
    expected_attempt: int,
):
    """Requeue one failed effect with a stale-decision guard."""
    from talos_agent.job_effects import JobEffectError

    db = None
    try:
        db, store = _job_store(db_path, talos_id)
        result = store.requeue(effect_id, expected_attempt=expected_attempt)
        console.print_json(json.dumps(result))
    except JobEffectError as exc:
        raise click.ClickException(f"{exc.code}: {exc}") from exc
    finally:
        if db is not None:
            db.close()


@main.command()
def status():
    """Show agent status."""
    from talos_agent.db import LocalDB

    ensure_app_dir()
    db = LocalDB()

    talos_cfg = db.get_talos_config()
    if talos_cfg:
        console.print(f"[bold]Talos:[/bold] {talos_cfg.get('name', 'Unknown')}")
    else:
        console.print("[yellow]No Talos config cached. Run `talos-agent start` first.[/yellow]")

    last_cycle = db.get_last_run("agent_cycle")
    if last_cycle:
        console.print(f"[bold]Last agent cycle:[/bold] {last_cycle.isoformat()}")

    posts_today = db.count_today("post")
    console.print(f"[bold]Posts today:[/bold] {posts_today}")

    playbook = db.get_active_playbook()
    if playbook:
        console.print(f"[bold]Active playbook:[/bold] {playbook['name']}")

    pending = db.get_pending_approvals()
    console.print(f"[bold]Pending approvals:[/bold] {len(pending)}")

    db.close()


# ─── Backup / Restore / Verify ──────────────────────────────────────


@main.command()
@click.option("--output", default=None, help="Output artifact path (default: ~/.talos-agent/backups/talos-agent-YYYYMMDD-HHMMSS.enc)")
@click.option("--agent-id", default=None, help="Talos ID for multi-agent mode")
@click.option("--passphrase", default=None, help="Backup passphrase (≥ 8 chars). Prompted if not provided.")
@click.option("--web-endpoint", is_flag=True, help="Also trigger POST /api/ops/backup on the Talos web API for Postgres coverage.")
@click.option(
    "--web-api-url",
    default=None,
    help="Talos web API URL for --web-endpoint (defaults to TALOS_API_URL env or https://talos-stellar.vercel.app)",
)
@click.option(
    "--ops-token",
    default=None,
    help="OPS_ADMIN_SECRET for the web endpoint (env: TALOS_OPS_TOKEN). Required when --web-endpoint is set.",
)
def backup(output, agent_id, passphrase, web_endpoint, web_api_url, ops_token):
    """Create an encrypted backup of this agent's local state.

    The artifact is smaller and independent from the web-side Postgres
    backup. With --web-endpoint, also kicks the web /api/ops/backup route
    so a single `backup` covers both the SQLite state and the Postgres
    rows.

    Bounded: writes are streamed through a tempdir, the encrypted output
    is bounded by MAX_PLAINTEXT_BYTES (10 MiB by default), and a
    single-flight lock prevents concurrent overwrites of the same WAL.
    """
    from pathlib import Path as _Path
    from talos_agent.backup_service import (
        BACKUP_ENCRYPTION_LABEL,
        BackupBusyError,
        BackupError,
        build_backup,
    )

    ensure_app_dir()
    if not passphrase:
        passphrase = click.prompt("Backup passphrase (≥8 chars)", hide_input=True, confirmation_prompt=True)
    if len(passphrase) < 8:
        console.print("[red]Error:[/red] passphrase must be ≥ 8 chars.")
        sys.exit(2)

    default_name = f"talos-agent-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.enc"
    out = _Path(output) if output else (APP_DIR / "backups" / default_name)
    out.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.monotonic()
    try:
        run = build_backup(
            password=passphrase,
            out_path=out,
            agent_id=agent_id,
            scope="agent",
        )
    except BackupBusyError as exc:
        console.print(f"[red]Busy:[/red] {exc}")
        sys.exit(75)
    except BackupError as exc:
        console.print(f"[red]Backup failed:[/red] {exc}")
        sys.exit(1)

    elapsed = time.monotonic() - t0
    console.print(f"[green]Backup written to[/green] {out}")
    console.print(f"  encryption:    {BACKUP_ENCRYPTION_LABEL}")
    console.print(f"  scope:         {run.scope}")
    console.print(f"  files:         {len(run.files)}")
    console.print(f"  row_count:     {run.manifest.get('rowCountTotal', 0)}")
    console.print(f"  duration_s:    {elapsed:.2f}")

    if web_endpoint:
        import asyncio
        import os

        from talos_agent.backup_service import trigger_web_backup

        url = (
            web_api_url
            or os.environ.get("TALOS_API_URL")
            or "https://talos-stellar.vercel.app"
        )
        token = ops_token or os.environ.get("TALOS_OPS_TOKEN")
        if not token:
            console.print("[red]--web-endpoint requires --ops-token or TALOS_OPS_TOKEN[/red]")
            sys.exit(2)
        try:
            result = asyncio.run(
                trigger_web_backup(
                    api_url=url,
                    api_key=token,
                    passphrase=passphrase,
                    scope="system",
                    timeout_s=60.0,
                )
            )
            console.print("[green]Web /api/ops/backup completed[/green]")
            console.print(f"  run_id:        {result.get('runId')}")
            console.print(f"  row_count:     {result.get('rowCountTotal')}")
        except Exception as exc:  # noqa: BLE001 — boundary, re-format below
            console.print(f"[red]Web backup trigger failed:[/red] {exc}")
            sys.exit(1)


@main.command()
@click.argument("artifact", type=click.Path(exists=True, dir_okay=False))
@click.option("--passphrase", default=None, help="Backup passphrase (Prompted if not provided.)")
@click.option("--confirm", is_flag=True, help="Overwrite existing agent DB. Required if state already exists.")
@click.option("--agent-id", default=None, help="Talos ID for multi-agent mode")
@click.option("--restore-root", default=None, help="Override restore root (default: ~/.talos-agent)")
def restore(artifact, passphrase, confirm, agent_id, restore_root):
    """Restore agent state from an encrypted backup artifact.

    By default this is a dry run that prints the manifest. Pass --confirm
    to actually replace the local SQLite state. Any existing files are
    backed up to `.pre-restore` siblings first.
    """
    from pathlib import Path as _Path
    from talos_agent.backup_service import (
        BACKUP_ENCRYPTION_LABEL,
        BackupError,
        restore_backup,
        verify_backup,
    )

    ensure_app_dir()
    if not passphrase:
        passphrase = click.prompt("Backup passphrase", hide_input=True)

    path = _Path(artifact).resolve()
    try:
        verified = verify_backup(artifact_path=path, password=passphrase)
    except BackupError as exc:
        code = getattr(exc, "code", "BAD_INPUT")
        if code == "AUTH_FAILED":
            console.print("[red]Passphrase rejected[/red]")
            sys.exit(3)
        console.print(f"[red]Verify failed:[/red] {exc}")
        sys.exit(1)

    files = list(verified.files.keys())
    console.print(f"[green]Verified[/green] {path}")
    console.print(f"  encryption:     {BACKUP_ENCRYPTION_LABEL}")
    console.print(f"  scope:          {verified.scope}")
    console.print(f"  timestamp:      {verified.timestamp}")
    console.print(f"  files:          {files}")
    console.print(f"  row_count:      {verified.manifest.get('rowCountTotal', 0)}")
    console.print(f"  plaintext_size: {verified.manifest.get('size_bytes', 0)} B")

    if not confirm:
        console.print("[yellow]Dry run only.[/yellow] Re-run with --confirm to apply the restore.")
        return

    try:
        restore_backup(
            artifact_path=path,
            password=passphrase,
            confirm=True,
            agent_id=agent_id,
            restore_root=_Path(restore_root) if restore_root else None,
        )
    except BackupError as exc:
        console.print(f"[red]Restore failed:[/red] {exc}")
        sys.exit(1)
    console.print(f"[green]Restore applied to {_Path(restore_root) if restore_root else APP_DIR}[/green]")


@main.command(name="backup-doctor")
@click.argument("artifact", type=click.Path(exists=True, dir_okay=False))
@click.option("--passphrase", default=None, help="Backup passphrase (Prompted if not provided.)")
def backup_doctor(artifact, passphrase):
    """Print integrity-check results for a backup artifact without applying it.

    Useful for incident-response checklists: this command reveals scope,
    timestamp, row counts, file sha256s, and the cipher label so an
    operator can sanity-check a backup years later without source code
    at hand.
    """
    from pathlib import Path as _Path
    from talos_agent.backup_service import (
        BACKUP_ENCRYPTION_LABEL,
        BackupError,
        verify_backup,
    )

    if not passphrase:
        passphrase = click.prompt("Backup passphrase", hide_input=True)
    path = _Path(artifact).resolve()
    try:
        verified = verify_backup(artifact_path=path, password=passphrase)
    except BackupError as exc:
        code = getattr(exc, "code", "BAD_INPUT")
        if code == "AUTH_FAILED":
            console.print("[red]Passphrase mismatched or artifact tampered[/red]")
            sys.exit(3)
        console.print(f"[red]Doctor failed:[/red] {exc}")
        sys.exit(1)

    console.print(f"[bold green]OK[/bold green] {path}")
    console.print(f"  encryption:     {BACKUP_ENCRYPTION_LABEL}")
    console.print(f"  formatVersion:  {verified.version}")
    console.print(f"  scope:          {verified.scope}")
    console.print(f"  timestamp:      {verified.timestamp}")
    console.print(f"  rows_total:     {verified.manifest.get('rowCountTotal', 0)}")
    console.print(f"  plaintext_size: {verified.manifest.get('size_bytes', 0)} B")
    console.print("  files:")
    for name, meta in verified.files.items():
        console.print(f"    - {name}")
        console.print(f"        sha256:    {meta.get('sha256')}")
        console.print(f"        size_bytes:{meta.get('size_bytes')}")
@main.command()
@click.option("--json", "json_output", is_flag=True, help="Output raw JSON instead of a formatted summary.")
def telemetry(json_output: bool):
    """Show privacy-safe runtime telemetry for the agent.

    Aggregates task counts, retries, queue depth, and circuit-breaker
    metrics.  The output is safe to log or forward to a dashboard — no
    prompts, API keys, signatures, or wallet secrets are exposed.
    """
    from talos_agent.db import LocalDB
    from talos_agent.telemetry import TelemetryCollector
    from talos_agent.circuit_breaker import cb_registry

    ensure_app_dir()
    db = LocalDB()

    talos_cfg = db.get_talos_config()
    agent_name = talos_cfg.get("name", "unknown") if talos_cfg else "unknown"

    collector = TelemetryCollector(db=db, agent_name=agent_name)
    report = collector.collect(cb_registry=cb_registry)

    if json_output:
        console.print(report.to_json())
        return

    # ── Formatted summary ─────────────────────────────────────
    console.print(f"[bold]Runtime Telemetry:[/bold] {agent_name}")
    console.print(f"  Collected at: {report.collected_at}")
    console.print()

    console.print("[bold]Scheduler Tasks[/bold]")
    for task in report.tasks:
        if task.last_run_at or task.retry_attempts > 0:
            retry_info = ""
            if task.retry_attempts > 0:
                retry_info = f" [yellow]retries={task.retry_attempts}[/yellow]"
                if task.retry_remaining_seconds > 0:
                    retry_info += f" [dim](next in {task.retry_remaining_seconds:.0f}s)[/dim]"
                if task.is_terminal:
                    retry_info += " [red]TERMINAL[/red]"
            console.print(f"  {task.name}: last_run={task.last_run_at or 'never'}{retry_info}")
    console.print()

    console.print("[bold]Queue Depth[/bold]")
    for q in report.queues:
        console.print(f"  {q.name}: {q.pending_count} pending / {q.total_count} total")
    console.print()

    if report.circuit_breakers:
        console.print("[bold]Circuit Breakers[/bold]")
        for cb in report.circuit_breakers:
            state = cb.get("state", "unknown")
            color = {"closed": "green", "half_open": "yellow", "open": "red"}.get(state, "dim")
            console.print(
                f"  {cb.get('provider', '?')}: [{color}]{state}[/{color}] "
                f"(failures={cb.get('failures_in_window', 0)}, "
                f"successes={cb.get('total_successes', 0)})"
            )
        console.print()

    if report.adapters:
        console.print("[bold]Adapter Health[/bold]")
        for a in report.adapters:
            color = {"healthy": "green", "disabled": "dim", "degraded": "yellow", "timeout": "red"}.get(a.state, "dim")
            console.print(f"  {a.name}: [{color}]{a.state}[/{color}] — {a.detail}")
        console.print()

    console.print("[bold]Content Performance (7d)[/bold]")
    console.print(f"  Posts: {report.total_posts_7d}")
    console.print(f"  Impressions: {report.total_impressions_7d}")
    console.print(f"  Avg engagement: {report.avg_engagement_7d:.1f}")
    console.print()

    console.print("[bold]Policy Engine[/bold]")
    console.print(f"  Evaluations: {report.policy_evaluation_count}")
    console.print(f"  Denies: {report.policy_deny_count}")
    console.print(f"  Escalations: {report.policy_escalate_count}")

    db.close()
