"""Tests for pluggable secret-store backends (sqlite + memory)."""

from __future__ import annotations

import base64
import json
import threading
import time

import pytest

from talos_agent.db import LocalDB
from talos_agent.secret_store import (
    SecretBusyError,
    SecretConflictError,
    SecretNotFoundError,
    SecretStore,
    SecretValidationError,
    build_secret_store,
    decode_keyring,
)
from talos_agent.secret_store_backends import (
    MemorySecretStoreBackend,
    create_secret_store_backend,
    normalize_backend_kind,
    supported_secret_store_backends,
)


def _key(byte: int) -> bytes:
    return bytes([byte]) * 32


def _store_from_backend(backend, **kwargs) -> SecretStore:
    return SecretStore(
        backend=backend,
        keyring=kwargs.pop("keyring", {"primary": _key(1)}),
        active_key_id=kwargs.pop("active_key_id", "primary"),
        scope=kwargs.pop("scope", "test"),
        dual_read=kwargs.pop("dual_read", True),
        legacy_fallback=kwargs.pop("legacy_fallback", True),
        max_value_bytes=kwargs.pop("max_value_bytes", 65536),
        **kwargs,
    )


def _stage_activate(store: SecretStore, name: str, value: str, request_id: str) -> int:
    expected = store.current_version(name)
    staged = store.stage(name, value, request_id=request_id)
    store.activate(name, staged.version, expected_active_version=expected)
    return staged.version


@pytest.mark.parametrize("kind", sorted(supported_secret_store_backends()))
def test_normalize_backend_kind_accepts_supported(kind: str):
    assert normalize_backend_kind(kind) == kind
    assert normalize_backend_kind(kind.upper()) == kind


def test_normalize_backend_kind_rejects_unknown():
    with pytest.raises(ValueError, match="unsupported secret-store backend"):
        normalize_backend_kind("vault")


def test_create_sqlite_backend_requires_db():
    with pytest.raises(ValueError, match="LocalDB"):
        create_secret_store_backend("sqlite", db=None)


def test_memory_backend_stage_activate_resolve_and_audit_redaction():
    backend = MemorySecretStoreBackend()
    store = _store_from_backend(backend)
    plaintext = "super-secret-provider-token"

    version = _stage_activate(store, "provider.api_key", plaintext, "request-1")
    resolved = store.resolve("provider.api_key")

    assert store.backend_kind == "memory"
    assert resolved.value == plaintext
    assert resolved.source == "active"
    assert resolved.version == version

    # Ciphertext lives in backend memory; plaintext must not appear in audit.
    record = backend.get_version("test", "provider.api_key", version)
    assert record is not None
    assert plaintext not in record.ciphertext
    assert record.ciphertext.startswith("TALOS-SECRET::1::")

    events = store.audit_events("provider.api_key")
    dumped = json.dumps(events)
    assert plaintext not in dumped
    assert record.ciphertext not in dumped


def test_memory_backend_duplicate_stage_is_idempotent():
    store = _store_from_backend(MemorySecretStoreBackend())
    first = store.stage("openai_api_key", "value-one", request_id="same-request")
    duplicate = store.stage("openai_api_key", "ignored-retry-value", request_id="same-request")

    assert duplicate.version == first.version
    assert len(store.list_versions("openai_api_key")) == 1
    store.activate("openai_api_key", first.version, expected_active_version=None)
    assert store.resolve("openai_api_key").value == "value-one"


def test_memory_backend_activation_cas_conflict():
    backend = MemorySecretStoreBackend()
    store_a = _store_from_backend(backend)
    store_b = _store_from_backend(backend)

    first = store_a.stage("talos_api_key", "one", request_id="first")
    second = store_b.stage("talos_api_key", "two", request_id="second")
    store_a.activate("talos_api_key", first.version, expected_active_version=None)

    with pytest.raises(SecretConflictError, match="expected None, found 1"):
        store_b.activate("talos_api_key", second.version, expected_active_version=None)

    assert store_b.resolve("talos_api_key").value == "one"


def test_memory_backend_dual_read_falls_back_to_previous():
    backend = MemorySecretStoreBackend()
    store = _store_from_backend(backend)
    old_version = _stage_activate(store, "groq_api_key", "old-key", "old")
    new_version = _stage_activate(store, "groq_api_key", "new-key", "new")

    # Corrupt active ciphertext without touching plaintext audit paths.
    raw = backend._versions[("test", "groq_api_key", new_version)]
    raw["ciphertext"] = "TALOS-SECRET::1::broken"

    resolved = store.resolve("groq_api_key")
    assert resolved.value == "old-key"
    assert resolved.source == "previous"
    assert resolved.version == old_version


def test_memory_backend_rejects_empty_and_oversize_values():
    store = _store_from_backend(MemorySecretStoreBackend(), max_value_bytes=8)
    with pytest.raises(SecretValidationError, match="cannot be empty"):
        store.stage("x", "", request_id="empty")
    with pytest.raises(SecretValidationError, match="exceeds configured"):
        store.stage("x", "too-large-value", request_id="big")


def test_memory_backend_missing_secret_raises():
    store = _store_from_backend(MemorySecretStoreBackend(), legacy_fallback=False)
    with pytest.raises(SecretNotFoundError):
        store.resolve("missing.secret")


def test_memory_backend_busy_when_lock_held():
    backend = MemorySecretStoreBackend(lock_timeout_seconds=0.02)
    store = _store_from_backend(backend)
    started = threading.Event()
    release = threading.Event()

    def hold_lock():
        backend.begin_immediate()
        started.set()
        release.wait(timeout=2)
        backend.commit()

    t = threading.Thread(target=hold_lock)
    t.start()
    assert started.wait(timeout=2)
    with pytest.raises(SecretBusyError, match="busy"):
        store.stage("held", "value", request_id="blocked")
    release.set()
    t.join(timeout=2)


def test_build_secret_store_selects_sqlite(mock_db: LocalDB):
    store = build_secret_store(
        backend="sqlite",
        db=mock_db,
        keyring={"primary": _key(1)},
        active_key_id="primary",
        scope="test",
    )
    assert store.backend_kind == "sqlite"
    _stage_activate(store, "provider.api_key", "sqlite-value", "req")
    assert store.resolve("provider.api_key").value == "sqlite-value"


def test_build_secret_store_selects_memory_without_db():
    store = build_secret_store(
        backend="memory",
        keyring={"primary": _key(1)},
        active_key_id="primary",
        scope="test",
    )
    assert store.backend_kind == "memory"
    _stage_activate(store, "provider.api_key", "memory-value", "req")
    assert store.resolve("provider.api_key").value == "memory-value"


def test_legacy_db_constructor_still_uses_sqlite(mock_db: LocalDB):
    store = SecretStore(
        mock_db,
        keyring={"primary": _key(1)},
        active_key_id="primary",
        scope="test",
    )
    assert store.backend_kind == "sqlite"


def test_keyring_roundtrip_unchanged():
    encoded = base64.urlsafe_b64encode(_key(9)).decode().rstrip("=")
    assert decode_keyring(f'{{"primary":"{encoded}"}}') == {"primary": _key(9)}
