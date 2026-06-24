"""Abstract base for all social publishing adapters used in GTM cycles."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class PostResult:
    """Normalised outcome returned by every adapter after a publish attempt."""

    success: bool
    channel: str
    message_id: str | None = None
    url: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "status": "posted" if self.success else "failed",
            "channel": self.channel,
        }
        if self.message_id:
            out["message_id"] = self.message_id
        if self.url:
            out["url"] = self.url
        if not self.success and self.error:
            out["error"] = self.error
        return out


class BaseSocialAdapter(ABC):
    """Contract every GTM social-publishing adapter must satisfy."""

    @property
    @abstractmethod
    def channel_name(self) -> str:
        """Human-readable channel identifier, e.g. 'Discord', 'X', 'LinkedIn'."""

    @abstractmethod
    async def post(self, content: str, **kwargs: Any) -> PostResult:
        """Publish a new top-level message to the channel."""

    @abstractmethod
    async def reply(self, reference_id: str, content: str, **kwargs: Any) -> PostResult:
        """Reply to an existing message identified by *reference_id*."""

    @abstractmethod
    async def get_metrics(self, reference_id: str) -> dict[str, Any]:
        """Return engagement metrics for a previously-published message."""

    def format_for_channel(
        self,
        content: str,
        playbook: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Return the channel-specific payload dict.

        Default passes plain text; adapters override to add rich formatting.
        """
        return {"content": content}
