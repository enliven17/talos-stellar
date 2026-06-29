"""Structured logging + Sentry initialisation for the prime-agent."""
from __future__ import annotations

import logging
import os
import structlog


def configure_logging() -> None:
    """Set up structlog to emit JSON lines to stdout."""
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def init_sentry() -> None:
    dsn = os.getenv("SENTRY_DSN")
    if not dsn:
        return
    import sentry_sdk
    from sentry_sdk.integrations.asyncio import AsyncioIntegration
    sentry_sdk.init(
        dsn=dsn,
        traces_sample_rate=0.1,
        integrations=[AsyncioIntegration()],
    )


def setup() -> None:
    configure_logging()
    init_sentry()


log = structlog.get_logger()
