"""Provider abstractions, metadata, and registry for LLM model routing.

Defines the :class:`LLMProvider` interface that all providers must implement,
along with :class:`ProviderMetadata` for routing decisions and the singleton
:class:`ProviderRegistry` that holds all available providers.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from typing import Any

from openai import AsyncOpenAI

from talos_agent.circuit_breaker import cb_registry

logger = logging.getLogger(__name__)


# ── Enums ──────────────────────────────────────────────────────────────────────


class TaskType(str, Enum):
    """Classification of the task being routed.

    Each task type maps to different provider suitability scores.  For
    example, structured extraction wants JSON mode; reasoning benefits
    from larger models; simple chat can use cheaper/faster providers.
    """

    CHAT = "chat"
    JSON = "json"
    REASONING = "reasoning"
    CODE = "code"
    VISION = "vision"
    EMBEDDING = "embedding"


class ProviderStatus(str, Enum):
    """Operational status of a provider as seen by the router."""

    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"


# ── Metadata ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ProviderCapabilities:
    """Capabilities that a provider supports.

    Used by :class:`RoutingPolicy` to match against
    :class:`RoutingConstraints`.
    """

    tool_calling: bool = True
    """Whether the provider supports OpenAI-style function/tool calling."""

    json_mode: bool = True
    """Whether the provider supports ``response_format: {"type": "json_object"}``."""

    vision: bool = False
    """Whether the provider supports image inputs."""

    streaming: bool = True
    """Whether the provider supports streaming responses."""

    parallel_tool_calls: bool = True
    """Whether the provider supports parallel tool calls in one response."""

    max_tokens: int = 4096
    """Maximum output tokens the provider supports."""

    supported_models: tuple[str, ...] = ()
    """Explicit list of model names this provider can serve."""


@dataclass(frozen=True)
class ProviderMetadata:
    """Immutable metadata about a provider for routing decisions.

    These values are typically static and configured at registration time.
    Dynamic state (circuit breaker status, current usage) is checked at
    routing time via the registry.
    """

    name: str
    """Unique provider name (e.g. ``"groq"``, ``"openai"``)."""

    capabilities: ProviderCapabilities
    """What this provider can do."""

    cost_per_1k_input: Decimal = Decimal("0")
    """USD per 1,000 input tokens (prompt)."""

    cost_per_1k_output: Decimal = Decimal("0")
    """USD per 1,000 output tokens (completion)."""

    avg_latency_ms: float = 1000.0
    """Approximate average latency in milliseconds (used for preference)."""

    privacy_level: str = "external"
    """Privacy classification: ``"local"``, ``"trusted"``, ``"external"``."""

    default_model: str = ""
    """Default model to use when no specific model is requested."""

    models: tuple[str, ...] = ()
    """All models available through this provider."""


# ── Abstract Provider ─────────────────────────────────────────────────────────


class LLMProvider(ABC):
    """Abstract base class for an LLM provider.

    Each concrete provider wraps access to a model endpoint (OpenAI, Groq,
    Anthropic, etc.) and exposes its metadata for routing decisions.

    Implementations must be stateless with respect to the call itself;
    state such as circuit breakers and usage counters is managed externally
    by the registry and routing infrastructure.
    """

    @property
    @abstractmethod
    def metadata(self) -> ProviderMetadata:
        """Return the static metadata for this provider."""

    @abstractmethod
    async def complete(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Send a completion request and return the response.

        The return value is a dict that must contain at least:
        ``{"choices": [{"message": {...}}], "usage": {"prompt_tokens": ...,
        "completion_tokens": ..., "total_tokens": ...}}``

        This roughly mirrors the OpenAI chat completion response format
        so that the agent loop can consume it identically regardless of
        which provider served the request.
        """

    async def check_health(self) -> bool:
        """Return ``True`` if the provider is reachable and responsive.

        Base implementation pings the provider's default model with a
        minimal request.  Providers may override for a cheaper check.
        """
        try:
            await self.complete(
                model=self.metadata.default_model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
            )
            return True
        except Exception:
            return False


# ── OpenAI-compatible provider ────────────────────────────────────────────────


@dataclass
class OpenAIClientProvider(LLMProvider):
    """A provider backed by an OpenAI-compatible API (OpenAI, Groq, etc.).

    Wraps an :class:`openai.AsyncOpenAI` client so the routing layer can
    treat every provider uniformly.
    """

    _metadata: ProviderMetadata
    _client: AsyncOpenAI
    _provider_name: str = ""

    @property
    def metadata(self) -> ProviderMetadata:
        return self._metadata

    @staticmethod
    def build(
        name: str,
        api_key: str,
        base_url: str | None = None,
        *,
        capabilities: ProviderCapabilities | None = None,
        cost_per_1k_input: Decimal = Decimal("0"),
        cost_per_1k_output: Decimal = Decimal("0"),
        avg_latency_ms: float = 1000.0,
        privacy_level: str = "external",
        default_model: str = "",
        models: tuple[str, ...] = (),
    ) -> OpenAIClientProvider:
        """Factory method that builds a provider from raw parameters.

        Parameters
        ----------
        name:
            Unique provider name.
        api_key:
            API key for the provider.
        base_url:
            Optional base URL (e.g. ``"https://api.groq.com/openai/v1"``).
            ``None`` uses the OpenAI SDK default.
        capabilities:
            Provider capabilities.  If omitted, sensible defaults are
            inferred from the provider name.
        cost_per_1k_input, cost_per_1k_output:
            USD per 1,000 tokens.
        avg_latency_ms:
            Approximate average latency.
        privacy_level:
            Privacy classification.
        default_model:
            Default model to use.
        models:
            All available models.

        Returns
        -------
        OpenAIClientProvider
            Configured provider instance.
        """
        if capabilities is None:
            capabilities = _default_capabilities(name, default_model)

        client_kwargs: dict[str, Any] = {"api_key": api_key}
        if base_url:
            client_kwargs["base_url"] = base_url
        client = AsyncOpenAI(**client_kwargs)

        meta = ProviderMetadata(
            name=name,
            capabilities=capabilities,
            cost_per_1k_input=cost_per_1k_input,
            cost_per_1k_output=cost_per_1k_output,
            avg_latency_ms=avg_latency_ms,
            privacy_level=privacy_level,
            default_model=default_model,
            models=models,
        )
        return OpenAIClientProvider(
            _metadata=meta,
            _client=client,
            _provider_name=name,
        )

    async def complete(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        response_format: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Send a completion request and return a normalized response dict."""
        create_kwargs: dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        if tools is not None:
            create_kwargs["tools"] = tools
        if tools:
            create_kwargs["tool_choice"] = "auto"
        if response_format is not None:
            create_kwargs["response_format"] = response_format
        create_kwargs.update(kwargs)

        response = await self._client.chat.completions.create(**create_kwargs)

        # Normalise to a plain dict so the agent loop doesn't depend on
        # the openai SDK response object.
        choice = response.choices[0]
        message: dict[str, Any] = {"role": "assistant"}
        if choice.message.content:
            message["content"] = choice.message.content
        if choice.message.tool_calls:
            message["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in choice.message.tool_calls
            ]

        usage = response.usage
        result: dict[str, Any] = {
            "choices": [{"message": message}],
            "usage": {
                "prompt_tokens": usage.prompt_tokens if usage else 0,
                "completion_tokens": usage.completion_tokens if usage else 0,
                "total_tokens": usage.total_tokens if usage else 0,
            },
            "model": model,
            "provider": self._provider_name,
        }
        return result


def _default_capabilities(name: str, default_model: str) -> ProviderCapabilities:
    """Return appropriate capabilities for well-known provider names."""
    lower = name.lower()
    if lower == "groq":
        return ProviderCapabilities(
            tool_calling=True,
            json_mode=True,
            vision=True,
            streaming=True,
            parallel_tool_calls=True,
            max_tokens=8192 if "70b" in default_model else 4096,
            supported_models=(
                "llama-3.3-70b-versatile",
                "llama-3.1-8b-instant",
                "mixtral-8x7b-32768",
            ),
        )
    if lower == "openai":
        return ProviderCapabilities(
            tool_calling=True,
            json_mode=True,
            vision=True,
            streaming=True,
            parallel_tool_calls=True,
            max_tokens=16384,
            supported_models=(
                "gpt-4o",
                "gpt-4o-mini",
                "gpt-4-turbo",
                "gpt-3.5-turbo",
            ),
        )
    if lower == "anthropic":
        return ProviderCapabilities(
            tool_calling=True,
            json_mode=False,
            vision=True,
            streaming=True,
            parallel_tool_calls=True,
            max_tokens=8192,
            supported_models=("claude-3-5-sonnet", "claude-3-haiku"),
        )
    # Generic fallback
    return ProviderCapabilities()


# ── Registry ───────────────────────────────────────────────────────────────────


class ProviderRegistry:
    """Registry of all available LLM providers.

    The registry is a singleton-like container that holds provider
    instances and exposes them for routing.  Providers are registered
    by name and looked up by the routing policy.

    Usage
    -----
    >>> registry = ProviderRegistry()
    >>> registry.register(groq_provider)
    >>> registry.register(openai_provider)
    >>> provider = registry.get("groq")
    """

    def __init__(self) -> None:
        self._providers: dict[str, LLMProvider] = {}

    # ── Registration ──────────────────────────────────────────────────────

    def register(self, provider: LLMProvider) -> None:
        """Register a provider.

        Raises
        ------
        ValueError
            If a provider with the same name is already registered.
        """
        name = provider.metadata.name
        if name in self._providers:
            raise ValueError(f"Provider '{name}' is already registered")
        self._providers[name] = provider
        logger.info("Registered provider '%s' (default model: %s)", name, provider.metadata.default_model)

    def register_or_replace(self, provider: LLMProvider) -> None:
        """Register or replace an existing provider with the same name."""
        name = provider.metadata.name
        self._providers[name] = provider
        logger.info("Registered/replaced provider '%s'", name)

    # ── Lookup ────────────────────────────────────────────────────────────

    def get(self, name: str) -> LLMProvider:
        """Get a provider by name.

        Raises
        ------
        KeyError
            If the provider is not registered.
        """
        if name not in self._providers:
            raise KeyError(f"Provider '{name}' is not registered. Available: {list(self._providers)}")
        return self._providers[name]

    def available(self) -> list[str]:
        """Return names of all registered providers."""
        return list(self._providers)

    def get_healthy(self) -> list[str]:
        """Return names of providers whose circuit breaker is not OPEN."""
        healthy: list[str] = []
        for name, provider in self._providers.items():
            breaker = cb_registry.get(name)
            if breaker.state.value != "open":
                healthy.append(name)
        return healthy

    def all_providers(self) -> dict[str, LLMProvider]:
        """Return a copy of the internal provider map."""
        return dict(self._providers)

    # ── Convenience ───────────────────────────────────────────────────────

    def count(self) -> int:
        """Number of registered providers."""
        return len(self._providers)

    def status(self, name: str) -> ProviderStatus:
        """Return the current operational status of a provider.

        Combines circuit breaker state and registration status.
        """
        if name not in self._providers:
            return ProviderStatus.UNAVAILABLE

        breaker = cb_registry.get(name)
        if breaker.state.value == "open":
            return ProviderStatus.UNAVAILABLE
        if breaker.state.value == "half_open":
            return ProviderStatus.DEGRADED
        return ProviderStatus.HEALTHY

    def get_cost_estimate(
        self,
        provider_name: str,
        input_tokens: int,
        output_tokens: int,
    ) -> Decimal:
        """Estimate the cost in USD for a given token count on a provider."""
        provider = self.get(provider_name)
        meta = provider.metadata
        input_cost = meta.cost_per_1k_input * Decimal(str(input_tokens)) / Decimal("1000")
        output_cost = meta.cost_per_1k_output * Decimal(str(output_tokens)) / Decimal("1000")
        return input_cost + output_cost


def _build_default_registry(settings: object) -> ProviderRegistry:
    """Build a :class:`ProviderRegistry` pre-populated with providers
    configured from *settings*.

    This is a convenience factory used by the agent loop during
    initialisation.  It reads the Groq and OpenAI credentials from the
    settings object and registers providers for each configured credential.
    """
    from talos_agent.config import resolve_setting_secret

    registry = ProviderRegistry()

    # Groq
    groq_key = resolve_setting_secret(settings, "groq_api_key")
    groq_model = getattr(settings, "groq_model", "llama-3.3-70b-versatile")
    if groq_key:
        groq_provider = OpenAIClientProvider.build(
            name="groq",
            api_key=groq_key,
            base_url="https://api.groq.com/openai/v1",
            cost_per_1k_input=Decimal("0.0001"),
            cost_per_1k_output=Decimal("0.0002"),
            avg_latency_ms=500.0,
            default_model=groq_model,
            models=(
                "llama-3.3-70b-versatile",
                "llama-3.1-8b-instant",
                "mixtral-8x7b-32768",
            ),
        )
        registry.register(groq_provider)

    # OpenAI
    openai_key = resolve_setting_secret(settings, "openai_api_key")
    openai_model = getattr(settings, "openai_model", "gpt-4o-mini")
    if openai_key:
        openai_provider = OpenAIClientProvider.build(
            name="openai",
            api_key=openai_key,
            base_url=None,  # Use OpenAI SDK default
            cost_per_1k_input=Decimal("0.00015"),
            cost_per_1k_output=Decimal("0.0006"),
            avg_latency_ms=1200.0,
            default_model=openai_model,
            models=(
                "gpt-4o",
                "gpt-4o-mini",
                "gpt-4-turbo",
            ),
        )
        registry.register(openai_provider)

    return registry


__all__ = [
    "LLMProvider",
    "OpenAIClientProvider",
    "ProviderCapabilities",
    "ProviderMetadata",
    "ProviderRegistry",
    "ProviderStatus",
    "TaskType",
    "_build_default_registry",
]
