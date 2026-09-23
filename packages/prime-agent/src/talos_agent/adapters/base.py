"""Base social adapter interface — all channel adapters implement this."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class ChannelCapabilities:
    char_limit: int | None  # None = no enforced limit
    supports_media: bool = False
    supports_threads: bool = False
    supports_replies: bool = True
    supports_search: bool = False
    supports_mentions: bool = False
    supports_analytics: bool = False


@dataclass
class PublishResult:
    status: str  # "posted" | "failed" | "pending"
    channel: str
    content: str
    post_id: str | None = None
    url: str | None = None
    error: str | None = None
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v is not None}


class BaseSocialAdapter(ABC):
    """Abstract base class for all social channel publishing adapters.

    Subclasses must declare a ``channel_name`` class attribute and implement
    all abstract methods.  The adapter is responsible for authentication,
    content validation, and interacting with the channel.
    """

    channel_name: str  # e.g. "X", "LinkedIn", "Farcaster"

    # ── Content ─────────────────────────────────────────────

    @abstractmethod
    async def post(self, content: str, **kwargs) -> PublishResult:
        """Publish a new post to the channel."""

    @abstractmethod
    async def reply(self, target_url: str, content: str, **kwargs) -> PublishResult:
        """Reply to an existing post."""

    # ── Discovery ────────────────────────────────────────────

    @abstractmethod
    async def get_mentions(self, **kwargs) -> list[dict]:
        """Fetch recent mentions or notifications."""

    @abstractmethod
    async def search(self, query: str, **kwargs) -> list[dict]:
        """Search for posts matching a keyword query."""

    # ── Analytics ────────────────────────────────────────────

    @abstractmethod
    async def get_post_performance(self, content_snippet: str, **kwargs) -> dict:
        """Return engagement metrics for a post identified by a content snippet."""

    @abstractmethod
    async def get_profile_stats(self, **kwargs) -> dict:
        """Return channel profile statistics (followers, posts, etc.)."""

    # ── Capabilities ─────────────────────────────────────────

    @abstractmethod
    def get_capabilities(self) -> ChannelCapabilities:
        """Return the feature capabilities of this channel."""

    def validate_content(self, content: str) -> tuple[bool, str | None]:
        """Return (is_valid, error_message).  Enforces char_limit if set."""
        caps = self.get_capabilities()
        if caps.char_limit and len(content) > caps.char_limit:
            return (
                False,
                f"Content is {len(content)} chars — exceeds the {caps.char_limit} character limit for {self.channel_name}.",
            )
        return True, None

    # ── Quota Enforcement ────────────────────────────────────

    def _check_cpu_quota(self, estimated_cpu: float, max_cpu: float) -> None:
        """Check if the estimated CPU cost exceeds the quota.

        Raises ValueError if the quota is exceeded.
        """
        if estimated_cpu < 0:
            raise ValueError("Estimated CPU cost cannot be negative.")
        if max_cpu <= 0:
            raise ValueError("Max CPU quota must be positive.")
        if estimated_cpu > max_cpu:
            raise ValueError(
                f"CPU quota exceeded: requested {estimated_cpu:.2f}ms, "
                f"limit {max_cpu:.2f}ms."
            )

    def _check_network_quota(self, request_count: int, max_requests: int) -> None:
        """Check if the request count exceeds the network quota.

        Raises ValueError if the quota is exceeded.
        """
        if request_count < 0:
            raise ValueError("Request count cannot be negative.")
        if max_requests <= 0:
            raise ValueError("Max network requests quota must be positive.")
        if request_count > max_requests:
            raise ValueError(
                f"Network quota exceeded: {request_count} requests, "
                f"limit {max_requests}."
            )

    def _validate_input(self, content: str | None, target_url: str | None) -> None:
        """Validate input parameters for safety and correctness.

        Raises ValueError for malformed or missing required inputs.
        """
        if content is None:
            raise ValueError("Content cannot be None.")
        if not isinstance(content, str):
            raise ValueError("Content must be a string.")
        if len(content) == 0:
            raise ValueError("Content cannot be empty.")

        if target_url is not None:
            if not isinstance(target_url, str):
                raise ValueError("Target URL must be a string.")
            if len(target_url) == 0:
                raise ValueError("Target URL cannot be empty.")

    def _sanitize_error(self, error: Exception) -> str:
        """Sanitize error messages to prevent leaking sensitive information.

        Returns a generic error message if the original message contains
        sensitive data patterns.
        """
        sensitive_patterns = [
            "api_key", "secret", "password", "token", "private_key",
            "payment_proof", "seed", "mnemonic"
        ]
        error_str = str(error).lower()
        for pattern in sensitive_patterns:
            if pattern in error_str:
                logger.warning(
                    "Sanitized error message containing sensitive pattern: %s",
                    pattern
                )
                return "An internal error occurred. Please contact support."
        return str(error)

    def _handle_dependency_failure(self, operation: str, error: Exception) -> PublishResult:
        """Handle failures from external dependencies.

        Returns a PublishResult with status 'failed' and a sanitized error.
        """
        sanitized_error = self._sanitize_error(error)
        logger.error(
            "Dependency failure during %s: %s",
            operation, sanitized_error
        )
        return PublishResult(
            status="failed",
            channel=self.channel_name,
            content="",
            error=sanitized_error,
        )

    def _handle_retry(self, operation: str, attempt: int, max_retries: int, error: Exception) -> None:
        """Handle retry logic for transient failures.

        Raises RetryableError if retries are exhausted.
        """
        if attempt >= max_retries:
            raise RetryableError(
                f"Max retries ({max_retries}) exceeded for {operation}"
            )
        logger.debug(
            "Retry %d/%d for %s: %s",
            attempt + 1, max_retries, operation, error
        )


class RetryableError(Exception):
    """Exception raised when a retryable operation exceeds max retries."""
    pass