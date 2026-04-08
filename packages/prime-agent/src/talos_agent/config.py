"""Configuration via environment variables and ~/.talos-agent/config.json."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_DIR = Path.home() / ".talos-agent"


def _json_config_source() -> dict:
    path = APP_DIR / "config.json"
    if path.exists():
        return json.loads(path.read_text())
    return {}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Talos Web API
    talos_api_url: str = "https://talos.app"
    talos_api_key: str = ""
    talos_id: str = ""

    # OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"

    # X (Twitter)
    x_username: str = ""
    x_password: str = ""
    x_email: str = ""

    # Agent behaviour
    agent_cycle_interval: int = Field(default=30, description="Seconds between agent cycles")
    polling_interval: int = Field(default=10, description="Seconds between API polls")
    heartbeat_interval: int = Field(default=60, description="Seconds between heartbeats")
    max_iterations: int = Field(default=20, description="Max tool-call iterations per cycle")
    approval_threshold: Decimal = Field(default=Decimal("10"), description="USD threshold for auto-approval")
    browser_headless: bool = Field(default=False, description="Run browser in headless mode")

    def __init__(self, **kwargs):
        overrides = _json_config_source()
        overrides.update(kwargs)
        super().__init__(**overrides)


def ensure_app_dir() -> Path:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    (APP_DIR / "logs").mkdir(exist_ok=True)
    return APP_DIR
