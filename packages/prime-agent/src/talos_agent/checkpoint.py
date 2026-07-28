"""Versioned checkpoint schema, canonical encoder, and validator.

A *checkpoint* is a signed snapshot of an agent's runtime state that
can be persisted to SQLite and later restored.  The encoding is
deterministic so that byte-identical output is produced across processes
and platforms given the same input values.

Canonical-encoding rules
------------------------
* JSON serialised with ``json.dumps(sort_keys=True, separators=(',', ':'))``
  and then encoded to ``UTF-8`` bytes.
* Each top-level section (``meta``, ``state``, ``config``) is hashed
  individually (SHA-256 of its canonical bytes) before the envelope is
  assembled.
* The envelope hash is the SHA-256 of the canonical representation of the
  full envelope dict (sections + section_hashes), *excluding* the
  ``envelope_hash`` key itself so the hash is not circular.

Schema version
--------------
Currently only ``schema_version == 1`` is supported.  A checkpoint with
a higher version raises :class:`CheckpointVersionError`.  A checkpoint with
a *lower* version (0 or negative) is also rejected.

Sensitive-data handling
-----------------------
``wallet_public_key`` must be a Stellar public key (starts with ``G``,
exactly 56 characters).  Secret keys must *never* appear in checkpoints;
the validator explicitly rejects strings that look like raw Stellar secret
keys (start with ``S``, 56 characters) in any field exposed to it.

Thread safety
-------------
All public helpers are pure functions; no shared mutable state.  Safe to
call concurrently from multiple threads or asyncio tasks.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

# ── Constants ──────────────────────────────────────────────────────────────────

SUPPORTED_SCHEMA_VERSION: int = 1

# Maximum allowed clock skew (seconds) between checkpoint created_at and *now*.
# Checkpoints stamped more than this far in the future are rejected.
MAX_FUTURE_SKEW_SECONDS: int = 60

# ── Exceptions ────────────────────────────────────────────────────────────────


class CheckpointError(ValueError):
    """Base class for all checkpoint errors."""


class CheckpointVersionError(CheckpointError):
    """Raised when schema_version is not supported."""


class CheckpointValidationError(CheckpointError):
    """Raised when a checkpoint fails semantic validation."""


class CheckpointHashError(CheckpointError):
    """Raised when a stored hash does not match the recomputed value."""


# ── Section models ─────────────────────────────────────────────────────────────


class CheckpointMeta(BaseModel):
    """Immutable identity and provenance fields."""

    model_config = {"frozen": True, "extra": "forbid"}

    agent_id: str = Field(..., description="Unique agent identifier (non-empty).")
    created_at: str = Field(
        ...,
        description="ISO-8601 UTC timestamp of checkpoint creation.",
    )
    schema_version: int = Field(
        default=SUPPORTED_SCHEMA_VERSION,
        description="Checkpoint schema version.",
    )

    @field_validator("agent_id")
    @classmethod
    def _agent_id_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("agent_id must not be empty")
        return v

    @field_validator("created_at")
    @classmethod
    def _created_at_valid_iso(cls, v: str) -> str:
        try:
            dt = datetime.fromisoformat(v)
        except ValueError as exc:
            raise ValueError(f"created_at is not a valid ISO-8601 string: {v!r}") from exc
        # Normalise to UTC
        if dt.tzinfo is None:
            raise ValueError("created_at must include timezone (UTC 'Z' or '+00:00')")
        return v

    @field_validator("schema_version")
    @classmethod
    def _version_supported(cls, v: int) -> int:
        if v < 1:
            raise CheckpointVersionError(f"schema_version must be >= 1, got {v}")
        if v > SUPPORTED_SCHEMA_VERSION:
            raise CheckpointVersionError(
                f"Unsupported schema_version {v}; this agent only supports up to "
                f"{SUPPORTED_SCHEMA_VERSION}.  Upgrade the agent to read this checkpoint."
            )
        return v


class CheckpointState(BaseModel):
    """Mutable runtime state of the agent at checkpoint time."""

    model_config = {"frozen": True, "extra": "forbid"}

    cycle_count: int = Field(..., ge=0, description="Number of completed agent cycles.")
    last_task: str = Field(default="", description="Name of the last task executed.")
    balance_usdc: float = Field(
        ...,
        description="Agent USDC balance at checkpoint time (non-negative).",
    )
    wallet_public_key: str = Field(
        ...,
        description="Stellar public key of the agent wallet (G…, 56 chars).",
    )

    @field_validator("balance_usdc")
    @classmethod
    def _balance_non_negative(cls, v: float) -> float:
        if v < 0:
            raise ValueError(f"balance_usdc must be >= 0, got {v}")
        return v

    @field_validator("wallet_public_key")
    @classmethod
    def _wallet_is_stellar_public_key(cls, v: str) -> str:
        _reject_if_secret_key(v, "wallet_public_key")
        if not (v.startswith("G") and len(v) == 56):
            raise ValueError(
                f"wallet_public_key must be a Stellar public key "
                f"(starts with 'G', exactly 56 chars); got {v!r}"
            )
        return v


class CheckpointConfig(BaseModel):
    """Agent configuration snapshot — identifies which Talos and API endpoint."""

    model_config = {"frozen": True, "extra": "forbid"}

    talos_id: str = Field(..., description="Unique Talos registry ID (non-empty).")
    api_url: str = Field(..., description="Base URL of the Talos web API.")

    @field_validator("talos_id")
    @classmethod
    def _talos_id_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("talos_id must not be empty")
        return v

    @field_validator("api_url")
    @classmethod
    def _api_url_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("api_url must not be empty")
        return v


# ── Envelope ──────────────────────────────────────────────────────────────────


class CheckpointEnvelope(BaseModel):
    """Complete checkpoint envelope with sections and integrity hashes.

    The ``section_hashes`` and ``envelope_hash`` are computed by
    :func:`encode_checkpoint` and verified by :func:`verify_checkpoint`.
    """

    model_config = {"frozen": True, "extra": "forbid"}

    meta: CheckpointMeta
    state: CheckpointState
    config: CheckpointConfig
    section_hashes: dict[str, str] = Field(
        default_factory=dict,
        description="SHA-256 hex digests keyed by section name.",
    )
    envelope_hash: str = Field(
        default="",
        description="SHA-256 hex digest of the canonical envelope (meta+state+config+section_hashes).",
    )

    @model_validator(mode="after")
    def _section_hashes_keys(self) -> CheckpointEnvelope:
        if self.section_hashes:
            expected = {"meta", "state", "config"}
            extra = set(self.section_hashes.keys()) - expected
            if extra:
                raise CheckpointValidationError(
                    f"section_hashes contains unexpected keys: {extra}"
                )
        return self


# ── Internal helpers ───────────────────────────────────────────────────────────


def _reject_if_secret_key(value: str, field_name: str) -> None:
    """Raise if *value* looks like a Stellar secret key (S…, 56 chars)."""
    if isinstance(value, str) and value.startswith("S") and len(value) == 56:
        raise CheckpointValidationError(
            f"Field '{field_name}' appears to contain a Stellar secret key.  "
            "Secret keys must never be stored in checkpoints."
        )


def _canonical_bytes(obj: Any) -> bytes:
    """Serialise *obj* to UTF-8 bytes using the canonical JSON encoding."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _section_dict(section: BaseModel) -> dict:
    """Return a plain dict representation of a pydantic model for hashing."""
    return section.model_dump(mode="json")


# ── Public API ────────────────────────────────────────────────────────────────


def encode_checkpoint(
    meta: CheckpointMeta,
    state: CheckpointState,
    config: CheckpointConfig,
) -> CheckpointEnvelope:
    """Build a fully-encoded :class:`CheckpointEnvelope` with all hashes filled.

    The encoding is deterministic: given the same input values the output
    bytes are identical regardless of process or platform.

    Parameters
    ----------
    meta:
        Identity and provenance section.
    state:
        Mutable agent runtime state section.
    config:
        Agent configuration section.

    Returns
    -------
    CheckpointEnvelope
        A frozen envelope with ``section_hashes`` and ``envelope_hash`` set.
    """
    # 1. Compute per-section SHA-256 hashes over canonical bytes.
    sections: dict[str, dict] = {
        "meta": _section_dict(meta),
        "state": _section_dict(state),
        "config": _section_dict(config),
    }
    section_hashes: dict[str, str] = {
        name: _sha256_hex(_canonical_bytes(data)) for name, data in sections.items()
    }

    # 2. Build the intermediate envelope dict (without envelope_hash) and hash it.
    envelope_core: dict = {
        "config": sections["config"],
        "meta": sections["meta"],
        "section_hashes": section_hashes,
        "state": sections["state"],
    }
    envelope_hash = _sha256_hex(_canonical_bytes(envelope_core))

    return CheckpointEnvelope(
        meta=meta,
        state=state,
        config=config,
        section_hashes=section_hashes,
        envelope_hash=envelope_hash,
    )


def verify_checkpoint(envelope: CheckpointEnvelope) -> None:
    """Verify structural integrity and semantic constraints of *envelope*.

    Checks performed (in order):
    1. schema_version is 1 (already enforced by the model, but re-checked here).
    2. agent_id is non-empty (model-enforced, re-checked for defence in depth).
    3. balance_usdc is non-negative.
    4. created_at is not more than MAX_FUTURE_SKEW_SECONDS in the future.
    5. wallet_public_key is a valid Stellar public key; secret key rejected.
    6. Per-section SHA-256 hashes match recomputed values.
    7. Envelope hash matches recomputed value.

    Raises
    ------
    CheckpointVersionError
        schema_version is unsupported.
    CheckpointValidationError
        Any semantic constraint is violated.
    CheckpointHashError
        Any hash does not match the stored value.
    """
    meta = envelope.meta
    state = envelope.state
    config = envelope.config

    # ── Schema version ────────────────────────────────────────────────────────
    if meta.schema_version != SUPPORTED_SCHEMA_VERSION:
        raise CheckpointVersionError(
            f"Unsupported schema_version {meta.schema_version}; expected {SUPPORTED_SCHEMA_VERSION}."
        )

    # ── Semantic constraints ──────────────────────────────────────────────────
    if not meta.agent_id.strip():
        raise CheckpointValidationError("agent_id must not be empty")

    if state.balance_usdc < 0:
        raise CheckpointValidationError(
            f"balance_usdc must be >= 0, got {state.balance_usdc}"
        )

    # Future-timestamp check
    created_at_dt = datetime.fromisoformat(meta.created_at)
    if created_at_dt.tzinfo is None:
        created_at_dt = created_at_dt.replace(tzinfo=timezone.utc)
    now_utc = datetime.now(timezone.utc)
    skew_seconds = (created_at_dt - now_utc).total_seconds()
    if skew_seconds > MAX_FUTURE_SKEW_SECONDS:
        raise CheckpointValidationError(
            f"created_at is {skew_seconds:.1f}s in the future "
            f"(max allowed: {MAX_FUTURE_SKEW_SECONDS}s)"
        )

    # Secret-key guard (defence in depth on top of model validator)
    _reject_if_secret_key(state.wallet_public_key, "wallet_public_key")
    _reject_if_secret_key(meta.agent_id, "agent_id")

    # ── Section hashes ────────────────────────────────────────────────────────
    sections: dict[str, dict] = {
        "meta": _section_dict(meta),
        "state": _section_dict(state),
        "config": _section_dict(config),
    }
    for name, data in sections.items():
        expected = _sha256_hex(_canonical_bytes(data))
        stored = envelope.section_hashes.get(name, "")
        if stored != expected:
            raise CheckpointHashError(
                f"Section '{name}' hash mismatch: stored={stored!r}, expected={expected!r}"
            )

    # ── Envelope hash ─────────────────────────────────────────────────────────
    envelope_core: dict = {
        "config": sections["config"],
        "meta": sections["meta"],
        "section_hashes": envelope.section_hashes,
        "state": sections["state"],
    }
    expected_envelope_hash = _sha256_hex(_canonical_bytes(envelope_core))
    if envelope.envelope_hash != expected_envelope_hash:
        raise CheckpointHashError(
            f"Envelope hash mismatch: stored={envelope.envelope_hash!r}, "
            f"expected={expected_envelope_hash!r}"
        )


def checkpoint_to_json(envelope: CheckpointEnvelope) -> str:
    """Serialise *envelope* to a canonical JSON string.

    The output is deterministic and can be round-tripped through
    :func:`checkpoint_from_json` without loss.
    """
    return json.dumps(
        envelope.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )


def checkpoint_from_json(raw: str) -> CheckpointEnvelope:
    """Deserialise a JSON string produced by :func:`checkpoint_to_json`.

    This function *only* parses and constructs the model; it does **not**
    verify hashes.  Call :func:`verify_checkpoint` separately when integrity
    checking is required.

    Raises
    ------
    CheckpointVersionError
        schema_version is unsupported.
    CheckpointValidationError
        Any field fails validation.
    json.JSONDecodeError
        The input is not valid JSON.
    """
    from pydantic import ValidationError as PydanticValidationError

    data = json.loads(raw)
    try:
        return CheckpointEnvelope.model_validate(data)
    except PydanticValidationError as exc:
        # Unwrap a CheckpointError that Pydantic has wrapped so callers can
        # match on the specific sub-type (CheckpointVersionError, etc.).
        for err in exc.errors():
            ctx = err.get("ctx", {})
            original = ctx.get("error")
            if isinstance(original, CheckpointError):
                raise original from exc
        raise


def build_checkpoint(
    *,
    agent_id: str,
    talos_id: str,
    api_url: str,
    cycle_count: int,
    last_task: str,
    balance_usdc: float,
    wallet_public_key: str,
    created_at: str | None = None,
) -> CheckpointEnvelope:
    """Convenience factory that creates and encodes a checkpoint in one call.

    Parameters
    ----------
    agent_id:
        Unique identifier for the agent instance.
    talos_id:
        Talos registry ID from the agent's :class:`~talos_agent.config.Settings`.
    api_url:
        Base URL of the Talos web API.
    cycle_count:
        Number of completed agent cycles at checkpoint time.
    last_task:
        Name of the last scheduled task executed.
    balance_usdc:
        Agent USDC wallet balance at checkpoint time.
    wallet_public_key:
        Stellar public key of the agent's wallet.
    created_at:
        ISO-8601 UTC timestamp.  Defaults to ``datetime.now(UTC).isoformat()``.

    Returns
    -------
    CheckpointEnvelope
        Fully encoded, hash-stamped envelope ready for persistence or transmission.
    """
    if created_at is None:
        created_at = datetime.now(timezone.utc).isoformat()

    meta = CheckpointMeta(
        agent_id=agent_id,
        created_at=created_at,
        schema_version=SUPPORTED_SCHEMA_VERSION,
    )
    state = CheckpointState(
        cycle_count=cycle_count,
        last_task=last_task,
        balance_usdc=balance_usdc,
        wallet_public_key=wallet_public_key,
    )
    cfg = CheckpointConfig(
        talos_id=talos_id,
        api_url=api_url,
    )
    return encode_checkpoint(meta, state, cfg)


__all__ = [
    # Exceptions
    "CheckpointError",
    "CheckpointVersionError",
    "CheckpointValidationError",
    "CheckpointHashError",
    # Models
    "CheckpointMeta",
    "CheckpointState",
    "CheckpointConfig",
    "CheckpointEnvelope",
    # Encoding / decoding
    "encode_checkpoint",
    "verify_checkpoint",
    "checkpoint_to_json",
    "checkpoint_from_json",
    "build_checkpoint",
    # Constants
    "SUPPORTED_SCHEMA_VERSION",
    "MAX_FUTURE_SKEW_SECONDS",
]
