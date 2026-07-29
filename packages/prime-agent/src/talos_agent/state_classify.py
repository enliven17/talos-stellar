"""Portable runtime state classification framework.

Every persistent or checkpointed field in the agent runtime carries an explicit
classification that defines its portability, sensitivity, retention, bounds, and
restore semantics.

Categories
----------
PORTABLE:
    Safe to include in checkpoints and fully transferable between nodes.
DERIVED:
    Recomputed from other state; never persisted — exists only in-memory.
LOCAL_ONLY:
    Machine-local runtime state that must never leave the node.
FORBIDDEN:
    Must never be stored in checkpoints or logs under any circumstances.

Usage
-----
All new persistent fields **must** be registered via ``register_field`` or
decorated with ``@classified``.  A runtime guard raises ``ClassificationError``
if any unclassified field is about to be checkpointed.

    @classified(category=StateCategory.PORTABLE, sensitivity="low")
    def my_field() -> int: ...
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Any, Callable, Literal

Sensitivity = Literal["none", "low", "medium", "high", "critical"]


class StateCategory(str, enum.Enum):
    PORTABLE = "portable"
    DERIVED = "derived"
    LOCAL_ONLY = "local_only"
    FORBIDDEN = "forbidden"


@dataclass(frozen=True)
class FieldClassification:
    """Classification metadata for a single state field or table.

    Attributes
    ----------
    category:
        One of PORTABLE, DERIVED, LOCAL_ONLY, FORBIDDEN.
    sensitivity:
        Data sensitivity level.
    retention:
        Retention policy, e.g. ``"7d"``, ``"permanent"``, ``"until_consumed"``.
    bounds:
        Value bounds or constraints, e.g. ``"0-100"``, ``"max 3600s future"``.
    restore_semantics:
        How the field behaves on checkpoint restore, e.g. ``"capped"``,
        ``"full"``, ``"reverified"``, ``"rebuilt"``, ``"pruned"``.
    reason:
        Human-readable justification for the classification.
    """

    category: StateCategory
    sensitivity: Sensitivity = "none"
    retention: str | None = None
    bounds: str | None = None
    restore_semantics: str | None = None
    reason: str | None = None


# ── Global classification registry ──────────────────────────────────────────

_CLASSIFICATION_REGISTRY: dict[str, FieldClassification] = {}


def register_field(
    field_path: str,
    classification: FieldClassification,
) -> None:
    """Register a field or table in the global classification registry.

    ``field_path`` uses dotted-path notation scoped by source module:
      - ``talos_config.agent_id``
      - ``schedules.last_run_at``
      - ``retry_state.attempt_count``
      - ``commerce._claimed_jobs``
    """
    if field_path in _CLASSIFICATION_REGISTRY:
        _CLASSIFICATION_REGISTRY[field_path] = classification
        return
    _CLASSIFICATION_REGISTRY[field_path] = classification


def registered_classification(field_path: str) -> FieldClassification | None:
    """Return the classification for *field_path*, or ``None``."""
    return _CLASSIFICATION_REGISTRY.get(field_path)


def registered_classifications() -> dict[str, FieldClassification]:
    """Return a copy of the full classification registry."""
    return dict(_CLASSIFICATION_REGISTRY)


# ── Decorator ────────────────────────────────────────────────────────────────

F = Callable[..., Any]


def classified(
    category: StateCategory,
    sensitivity: Sensitivity = "none",
    retention: str | None = None,
    bounds: str | None = None,
    restore_semantics: str | None = None,
    reason: str | None = None,
) -> Callable[[F], F]:
    """Decorator that registers the classification for a field or table.

    The decorated callable's qualified name is used as the registry key.

    Example
    -------
    >>> @classified(StateCategory.PORTABLE, sensitivity="low", retention="permanent")
    ... def schedules_last_run_at(): ...
    """

    def decorator(func: F) -> F:
        module = getattr(func, "__module__", "unknown")
        qualname = getattr(func, "__qualname__", func.__name__)
        field_path = f"{module}.{qualname}" if module != "unknown" else qualname
        fc = FieldClassification(
            category=category,
            sensitivity=sensitivity,
            retention=retention,
            bounds=bounds,
            restore_semantics=restore_semantics,
            reason=reason,
        )
        _CLASSIFICATION_REGISTRY[field_path] = fc
        return func

    return decorator


# ── Guard ────────────────────────────────────────────────────────────────────

class ClassificationError(Exception):
    """Raised when an unclassified field is about to be persisted or included
    in a checkpoint payload."""


_UNCLASSIFIED_ALLOWLIST: set[str] = set()


def allowlist_field(field_path: str) -> None:
    """Temporarily add a field path to the unclassified allowlist.

    This is intended for transitional use during migration.  All new fields
    should use ``@classified`` or ``register_field`` instead.
    """
    _UNCLASSIFIED_ALLOWLIST.add(field_path)


def require_classification(field_path: str) -> None:
    """Require that *field_path* has a registered classification.

    Raises ``ClassificationError`` if the field is not registered and not on
    the allowlist.
    """
    if field_path in _CLASSIFICATION_REGISTRY:
        return
    if field_path in _UNCLASSIFIED_ALLOWLIST:
        return
    raise ClassificationError(
        f"Field {field_path!r} is not classified. "
        f"Add a @classified decorator or register_field() call."
    )


def validate_checkpoint_payload(payload: dict[str, Any]) -> None:
    """Validate that every key in *payload* has a registered classification
    and that no FORBIDDEN fields are present.

    Raises ``ClassificationError`` on the first violation.
    """
    for key in payload:
        require_classification(key)
        cls_ = _CLASSIFICATION_REGISTRY.get(key)
        if cls_ is not None and cls_.category is StateCategory.FORBIDDEN:
            raise ClassificationError(
                f"Field {key!r} is classified as FORBIDDEN and must not appear "
                f"in checkpoint payloads."
            )


# ── Documentation helper ────────────────────────────────────────────────────

def classification_report() -> str:
    """Return a human-readable report of all registered classifications."""
    lines = ["# Agent Runtime State Classification Report\n"]
    by_category: dict[str, list[tuple[str, FieldClassification]]] = {}
    for field_path, fc in sorted(_CLASSIFICATION_REGISTRY.items()):
        by_category.setdefault(fc.category.value, []).append((field_path, fc))

    for cat_name in ("portable", "derived", "local_only", "forbidden"):
        entries = by_category.get(cat_name, [])
        lines.append(f"\n## {cat_name.upper()} ({len(entries)} fields)\n")
        for field_path, fc in entries:
            parts = [f"  - `{field_path}`"]
            parts.append(f"sensitivity={fc.sensitivity}")
            if fc.retention:
                parts.append(f"retention={fc.retention}")
            if fc.bounds:
                parts.append(f"bounds={fc.bounds}")
            if fc.restore_semantics:
                parts.append(f"restore={fc.restore_semantics}")
            if fc.reason:
                parts.append(f"reason={fc.reason!r}")
            lines.append("  (" + ", ".join(parts[1:]) + ")")

    return "\n".join(lines)


__all__ = [
    "ClassificationError",
    "FieldClassification",
    "Sensitivity",
    "StateCategory",
    "allowlist_field",
    "classified",
    "classification_report",
    "register_field",
    "registered_classification",
    "registered_classifications",
    "require_classification",
    "validate_checkpoint_payload",
]
