"""Base social adapter interface — all channel adapters implement this."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


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
