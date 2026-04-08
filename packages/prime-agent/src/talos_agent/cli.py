"""CLI entry point — talos-agent start|config|status."""

from __future__ import annotations

import asyncio
import json
import sys

import click
from rich.console import Console

from talos_agent import __version__
from talos_agent.config import APP_DIR, Settings, ensure_app_dir

console = Console()


@click.group()
@click.version_option(__version__, prog_name="talos-agent")
def main():
    """Talos Protocol Prime Agent — autonomous GTM agent."""


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
        import os
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

    kwargs: dict = {"_env_file": env_file}
    if talos_id:
        kwargs["talos_id"] = talos_id
    settings = Settings(**kwargs)

    if not settings.talos_api_key:
        console.print("[red]Error:[/red] TALOS_API_KEY is required. Set it in .env or run `talos-agent config`.")
        sys.exit(1)
    if not settings.openai_api_key:
        console.print("[red]Error:[/red] OPENAI_API_KEY is required. Set it in .env.")
        sys.exit(1)

    console.print(f"[bold green]Talos Agent v{__version__}[/bold green]")
    if settings.talos_id:
        console.print(f"  Talos ID:  {settings.talos_id}")
    else:
        console.print("  Talos ID:  (auto-resolve from API key)")
    console.print(f"  API URL:    {settings.talos_api_url}")
    console.print()

    from talos_agent.scheduler import run

    asyncio.run(run(settings))


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
