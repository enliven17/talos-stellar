"""Durable publication intent records (#1458).

Before a communication adapter attempts a publish, the caller records a
*publication intent*: a small, append-and-update record keyed by a stable
action id. If the process dies between writing the intent and recording the
outcome, the next start can read the intent back and reconcile it against the
transport, yielding one of:

* ``confirmed`` — the transport reports the publish succeeded.
* ``rejected``  — the transport reports the publish was rejected.
* ``unknown``   — no definitive answer; the intent is held, never auto-resent.

The store is a directory of JSON files, one per action id, chosen because it
requires no dependencies and is trivial to fake with ``tmp_path`` in tests.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any


class PublicationIntentStatus(str, Enum):
    """Lifecycle of a publication intent.

    ``pending``   — written before the transport call; outcome not yet known.
    ``confirmed`` — transport reported success.
    ``rejected``  — transport reported a definitive rejection.
    ``unknown``   — reconciliation found no definitive answer; held forever.
    """

    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    UNKNOWN = "unknown"


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def payload_hash(payload: Any) -> str:
    """Stable SHA-256 of a JSON-serialisable payload, for identity comparison."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(slots=True)
class PublicationIntent:
    """One durable record of a publish attempt."""

    action_id: str
    adapter: str
    payload_hash: str
    status: PublicationIntentStatus = PublicationIntentStatus.PENDING
    created_at: str = field(default_factory=_utcnow_iso)
    resolved_at: str | None = None
    last_error: str | None = None
    transport_ref: str | None = None

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = self.status.value
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "PublicationIntent":
        data = dict(data)
        data["status"] = PublicationIntentStatus(data["status"])
        return cls(**data)


class PublicationIntentStore:
    """A directory of per-action JSON files. Safe to fake with ``tmp_path``."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, action_id: str) -> Path:
        if not action_id or "/" in action_id or "\\" in action_id or action_id.startswith("."):
            raise ValueError(f"invalid action_id {action_id!r}")
        return self.root / f"{action_id}.json"

    def write(self, intent: PublicationIntent) -> None:
        target = self._path(intent.action_id)
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(json.dumps(intent.to_json(), indent=2, sort_keys=True))
        # Atomic replace: a crash leaves either the old file or the new one,
        # never a half-written record.
        tmp.replace(target)

    def read(self, action_id: str) -> PublicationIntent | None:
        path = self._path(action_id)
        if not path.exists():
            return None
        return PublicationIntent.from_json(json.loads(path.read_text()))

    def list_all(self) -> list[PublicationIntent]:
        result: list[PublicationIntent] = []
        for path in sorted(self.root.glob("*.json")):
            try:
                result.append(PublicationIntent.from_json(json.loads(path.read_text())))
            except (ValueError, KeyError, json.JSONDecodeError):
                # Corrupt row is skipped, not raised: a single bad file must
                # not brick the whole reconcile pass.
                continue
        return result

    def list_by_status(self, status: PublicationIntentStatus) -> list[PublicationIntent]:
        return [i for i in self.list_all() if i.status is status]
