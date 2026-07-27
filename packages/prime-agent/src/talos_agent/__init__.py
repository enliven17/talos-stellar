"""Talos Protocol Prime Agent — autonomous GTM agent CLI."""

from talos_agent import state_classifications  # noqa: F401 — registers state classifications at import

from talos_agent.circuit_breaker import (
    CircuitBreakerConfig,
    CircuitBreakerError,
    CircuitBreakerMetrics,
    CircuitBreakerOpen,
    CircuitBreakerRegistry,
    CircuitState,
    ProviderCircuitBreaker,
    cb_registry,
)

__version__ = "0.1.0"

__all__ = [
    "CircuitBreakerConfig",
    "CircuitBreakerError",
    "CircuitBreakerMetrics",
    "CircuitBreakerOpen",
    "CircuitBreakerRegistry",
    "CircuitState",
    "ProviderCircuitBreaker",
    "cb_registry",
]
