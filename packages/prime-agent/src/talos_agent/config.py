"""Configuration via environment variables and ~/.talos-agent/config.json."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

from pydantic import Field, PrivateAttr
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_DIR = Path.home() / ".talos-agent"


def _json_config_source() -> dict:
    path = APP_DIR / "config.json"
    if path.exists():
        return json.loads(path.read_text())
    return {}


class Settings(BaseSettings):
    _secret_store: object | None = PrivateAttr(default=None)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    # Talos Web API
    talos_api_url: str = "https://talos-stellar.vercel.app"
    talos_api_key: str = ""
    talos_id: str = ""

    # Multi-agent mode: comma-separated list of API keys
    # e.g. TALOS_API_KEYS=tak_aaa,tak_bbb,tak_ccc
    talos_api_keys: str = ""

    def get_all_api_keys(self) -> list[str]:
        """Return all agent API keys — multi-agent list if set, else single key."""
        if self.talos_api_keys:
            return [k.strip() for k in self.talos_api_keys.split(",") if k.strip()]
        if self.talos_api_key:
            return [self.talos_api_key]
        return []

    # LLM (Groq preferred — free, OpenAI-compatible)
    groq_api_key: str = ""
    groq_model: str = "llama-3.3-70b-versatile"

    # OpenAI (fallback if groq_api_key is not set)
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"

    @property
    def llm_api_key(self) -> str:
        groq_key = self.secret_value("groq_api_key")
        return groq_key or self.secret_value("openai_api_key")

    @property
    def llm_model(self) -> str:
        return self.groq_model if self.secret_value("groq_api_key") else self.openai_model

    @property
    def llm_base_url(self) -> str | None:
        return "https://api.groq.com/openai/v1" if self.secret_value("groq_api_key") else None

    # Model routing (Issue #233) — disabled by default, backward compatible
    model_routing_enabled: bool = Field(
        default=False,
        description="Enable policy-driven model routing and fallback. When enabled, provider "
        "selection considers task type, cost, latency, privacy, and availability. "
        "When disabled (default), the legacy Groq-first/OpenAI-fallback behaviour is used.",
    )
    routing_fallback_enabled: bool = Field(
        default=True,
        description="When model routing is enabled, attempt fallback to alternative providers "
        "if the primary provider fails or is unavailable. Only meaningful when "
        "model_routing_enabled is True.",
    )
    routing_max_cost_usd: Decimal = Field(
        default=Decimal("0"),
        description="Maximum cost per LLM call in USD when routing is enabled. "
        "0 means no cost limit. Used by the routing policy to prefer "
        "cheaper providers when cost is constrained.",
    )
    routing_preferred_provider: str = Field(
        default="",
        description="Explicit provider name to prefer when routing is enabled. "
        "Empty string means auto-select based on policy. When set, the "
        "router uses this provider if it is available and meets capability "
        "requirements.",
    )
    routing_budget_enabled: bool = Field(
        default=False,
        description="Enable usage accounting and budget tracking for provider calls. "
        "When enabled, the UsageTracker records token counts, costs, and "
        "checks budgets before allowing further calls.",
    )

    # X (Twitter)
    x_username: str = ""
    x_password: str = ""
    x_email: str = ""

    # Discord
    # Webhook URL is sufficient for posting. Bot token + channel/guild IDs
    # unlock replies, mentions, and analytics via the REST API.
    discord_webhook_url: str = ""
    discord_bot_token: str = ""
    discord_channel_id: str = ""
    discord_guild_id: str = ""

    # Per-channel credential configs for additional adapters.
    # Set as JSON in env: CHANNEL_CONFIGS={"telegram": {"bot_token": "...", "chat_id": "@channel"}}
    channel_configs: dict = Field(default_factory=dict, description="Per-channel credentials map")
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""

    # Versioned encrypted secret rotation (opt-in for backward compatibility).
    secret_rotation_enabled: bool = Field(
        default=False, validation_alias="TALOS_SECRET_ROTATION_ENABLED"
    )
    secret_keyring: str = Field(default="", validation_alias="TALOS_SECRET_KEYRING")
    secret_active_key_id: str = Field(
        default="", validation_alias="TALOS_SECRET_ACTIVE_KEY_ID"
    )
    secret_scope: str = Field(default="default", validation_alias="TALOS_SECRET_SCOPE")
    secret_dual_read: bool = Field(
        default=True, validation_alias="TALOS_SECRET_DUAL_READ"
    )
    secret_legacy_fallback: bool = Field(
        default=True, validation_alias="TALOS_SECRET_LEGACY_FALLBACK"
    )
    secret_max_bytes: int = Field(
        default=65536,
        ge=1,
        le=1048576,
        validation_alias="TALOS_SECRET_MAX_BYTES",
    )
    secret_db_timeout_ms: int = Field(
        default=5000,
        ge=1,
        le=60000,
        validation_alias="TALOS_SECRET_DB_TIMEOUT_MS",
    )

    # Third-party adapter capability sandbox (opt-in rollout).
    adapter_sandbox_enabled: bool = Field(
        default=False, validation_alias="TALOS_ADAPTER_SANDBOX_ENABLED"
    )
    adapter_capability_manifests: str = Field(
        default="", validation_alias="TALOS_ADAPTER_CAPABILITY_MANIFESTS"
    )
    adapter_timeout_seconds: int = Field(
        default=30,
        ge=1,
        le=120,
        validation_alias="TALOS_ADAPTER_TIMEOUT_SECONDS",
    )
    adapter_max_concurrency: int = Field(
        default=2,
        ge=1,
        le=16,
        validation_alias="TALOS_ADAPTER_MAX_CONCURRENCY",
    )
    adapter_max_input_bytes: int = Field(
        default=16384,
        ge=1,
        le=1048576,
        validation_alias="TALOS_ADAPTER_MAX_INPUT_BYTES",
    )
    adapter_max_output_bytes: int = Field(
        default=262144,
        ge=1,
        le=2097152,
        validation_alias="TALOS_ADAPTER_MAX_OUTPUT_BYTES",
    )
    adapter_max_network_requests: int = Field(
        default=8,
        ge=1,
        le=32,
        validation_alias="TALOS_ADAPTER_MAX_NETWORK_REQUESTS",
    )
    adapter_invocation_lease_seconds: int = Field(
        default=120,
        ge=5,
        le=900,
        validation_alias="TALOS_ADAPTER_INVOCATION_LEASE_SECONDS",
    )
    adapter_max_invocation_records: int = Field(
        default=100000,
        ge=100,
        le=1000000,
        validation_alias="TALOS_ADAPTER_MAX_INVOCATION_RECORDS",
    )

    # Policy engine (disabled by default — backward compatible)
    policy_engine_enabled: bool = Field(default=False, description="Enable the declarative policy engine for autonomous actions")

    # Tool permission manifests (audit-only by default — backward compatible).
    # "off" disables the check entirely, "audit" evaluates and logs without
    # blocking, "enforce" denies calls that exceed their manifest or grants.
    tool_permission_mode: str = Field(default="audit", description="Tool permission enforcement: off | audit | enforce")
    # Operator grants as JSON, e.g.
    # TOOL_PERMISSION_GRANTS={"capabilities":["network.http","wallet.read"],"hosts":["*.stellar.org"],"max_spend_usd":"50"}
    # Empty means "use the legacy grant set", which matches pre-manifest behaviour.
    tool_permission_grants: dict = Field(default_factory=dict, description="Operator-approved capability grants for tools")

    # Agent behaviour
    agent_cycle_interval: int = Field(default=30, description="Seconds between agent cycles")
    polling_interval: int = Field(default=10, description="Seconds between API polls")
    heartbeat_interval: int = Field(default=60, description="Seconds between heartbeats")
    max_iterations: int = Field(default=20, description="Max tool-call iterations per cycle")
    approval_threshold: Decimal = Field(default=Decimal("10"), description="USD threshold for auto-approval")
    browser_headless: bool = Field(default=False, description="Run browser in headless mode")
    auto_repay_loans: bool = Field(default=False, description="Enable automatic loan repayment from treasury")

    # Job leasing
    job_lease_ttl: int = Field(
        default=300,
        ge=1,
        le=600,
        description="Seconds for a claimed job lease TTL",
    )
    job_heartbeat_interval: int = Field(
        default=60,
        ge=1,
        le=300,
        description="Seconds between job lease heartbeats",
    )

    # Durable provider-job inbox/outbox (opt-in)
    talos_durable_job_effects_enabled: bool = Field(
        default=False,
        description="Persist provider jobs and completion effects before external delivery",
    )
    talos_job_effect_dispatch_interval: int = Field(default=2, ge=1, le=300)
    talos_job_effect_lease_seconds: int = Field(default=30, ge=5, le=900)
    talos_job_effect_max_attempts: int = Field(default=8, ge=1, le=100)
    talos_job_effect_retry_base_seconds: int = Field(default=2, ge=1, le=300)
    talos_job_effect_batch_size: int = Field(default=20, ge=1, le=200)
    talos_job_effect_max_inbox_records: int = Field(
        default=100_000, ge=100, le=1_000_000
    )
    talos_job_effect_max_outbox_records: int = Field(
        default=100_000, ge=100, le=1_000_000
    )
    talos_job_effect_max_payload_bytes: int = Field(
        default=65_536, ge=1_024, le=1_048_576
    )
    talos_job_effect_max_result_bytes: int = Field(
        default=262_144, ge=1_024, le=2_097_152
    )
    talos_job_effect_dispatch_timeout_seconds: int = Field(default=20, ge=1, le=120)
    talos_job_effect_db_timeout_ms: int = Field(default=5_000, ge=1, le=30_000)

    # Graceful shutdown (#182)
    shutdown_deadline: float = Field(
        default=30.0,
        description=(
            "Seconds to wait for in-flight tasks to finish after shutdown is requested "
            "before they are forcibly cancelled. Set to 0 to cancel immediately."
        ),
    )

    # Dividend distribution
    dividend_distribution_interval: int = Field(default=3600, description="Seconds between dividend distribution checks")
    dividend_usdc_threshold: Decimal = Field(default=Decimal("100"), description="USDC threshold to trigger dividend distribution")

    # Execution replay (Issue #235) — disabled by default
    replay_enabled: bool = Field(default=False, description="Enable execution replay recording for incident analysis")
    replay_redact_payloads: bool = Field(default=True, description="Redact sensitive values in replay event payloads")

    def __init__(self, **kwargs):
        overrides = _json_config_source()
        overrides.update(kwargs)
        super().__init__(**overrides)

    def bind_secret_store(self, store: object) -> None:
        """Attach the runtime resolver after the local database is available."""
        self._secret_store = store

    def secret_value(self, name: str, legacy_value: str | None = None) -> str:
        """Resolve a credential at point of use, preserving legacy defaults."""
        legacy = legacy_value
        if legacy is None:
            value = getattr(self, name, "")
            legacy = value if isinstance(value, str) else ""
        if not self.secret_rotation_enabled or self._secret_store is None:
            return legacy or ""
        resolution = self._secret_store.resolve(name, legacy or "")
        return resolution.value


def ensure_app_dir() -> Path:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    (APP_DIR / "logs").mkdir(exist_ok=True)
    return APP_DIR


def resolve_setting_secret(settings: object, name: str, legacy_value: str | None = None) -> str:
    """Resolve secrets on real Settings while remaining friendly to test doubles."""
    resolver = getattr(type(settings), "secret_value", None)
    if callable(resolver):
        return resolver(settings, name, legacy_value)
    if legacy_value is not None:
        return legacy_value
    value = getattr(settings, name, "")
    return value if isinstance(value, str) else ""
