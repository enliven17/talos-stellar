"""CLI entry point — talos-agent start|config|status."""

from __future__ import annotations

import asyncio
import json
import os
import sys

import click
from rich.console import Console
import re

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
    from pathlib import Path

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
