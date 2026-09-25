"""Capability sandbox primitives for third-party service adapters."""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import ipaddress
import json
import os
import posixpath
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import unquote, urlsplit

import httpx

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult
from talos_agent.adapters.diagnostics import safe_adapter_diagnostic_fields
from talos_agent.adapters.snapshots import AdapterHealthSnapshot
from talos_agent.circuit_breaker import (
    CircuitBreakerConfig,
    CircuitBreakerRegistry,
    execute_with_retry,
)
from talos_agent.observability import log

_IDENTIFIER_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,127}$")
_OPERATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_DNS_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_SAFE_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})
_ADAPTER_OPERATIONS = frozenset(
    {"post", "reply", "get_mentions", "search", "get_post_performance", "get_profile_stats"}
)
_BROWSER_ACTIONS = frozenset(
    {"goto", "act", "extract", "keyboard_press", "keyboard_type"}
)
_MAX_MANIFEST_JSON_BYTES = 65536


class AdapterSandboxError(Exception):
    """Base error with messages safe for tool responses."""


class ManifestValidationError(AdapterSandboxError):
    pass


class CapabilityDeniedError(AdapterSandboxError):
    pass


class AdapterResourceLimitError(AdapterSandboxError):
    pass


class AdapterTimeoutError(AdapterSandboxError):
    pass


class AdapterBusyError(AdapterSandboxError):
    pass


class DuplicateInvocationError(AdapterSandboxError):
    pass


class InvocationConflictError(AdapterSandboxError):
    pass


class IndeterminateInvocationError(AdapterSandboxError):
    pass


class AdapterExecutionError(AdapterSandboxError):
    pass


@dataclass(frozen=True)
class NetworkRule:
    host: str
    path_prefix: str = "/"
    methods: frozenset[str] = field(default_factory=lambda: frozenset({"GET", "POST"}))
    port: int | None = None

    def __post_init__(self) -> None:
        normalized_host = _normalize_host(self.host)
        object.__setattr__(self, "host", normalized_host)
        if not isinstance(self.path_prefix, str):
            raise ManifestValidationError("network path prefixes must be strings")
        decoded_prefix = _decode_path(self.path_prefix)
        if not self.path_prefix.startswith("/") or ".." in decoded_prefix.split("/"):
            raise ManifestValidationError("network path prefixes must be absolute and traversal-free")
        normalized_path = posixpath.normpath(decoded_prefix)
        if self.path_prefix.endswith("/") and not normalized_path.endswith("/"):
            normalized_path += "/"
        object.__setattr__(self, "path_prefix", normalized_path)
        normalized_methods = frozenset(str(method).upper() for method in self.methods)
        if not normalized_methods or not normalized_methods <= _SAFE_METHODS:
            raise ManifestValidationError("network methods contain unsupported values")
        object.__setattr__(self, "methods", normalized_methods)
        if self.port is not None and (
            isinstance(self.port, bool)
            or not isinstance(self.port, int)
            or not 1 <= self.port <= 65535
        ):
            raise ManifestValidationError("network rule port is out of range")


@dataclass(frozen=True)
class AdapterResourceLimits:
    timeout_seconds: float = 30.0
    max_concurrency: int = 2
    max_input_bytes: int = 16384
    max_output_bytes: int = 262144
    max_output_items: int = 100
    max_network_requests: int = 8
    max_browser_actions: int = 64
    invocation_lease_seconds: int = 120
    max_invocation_records: int = 100000
    max_cpu_seconds: float = 60.0
    max_network_bytes: int = 1048576

    def __post_init__(self) -> None:
        bounds = {
            "timeout_seconds": (self.timeout_seconds, 0.1, 120),
            "max_concurrency": (self.max_concurrency, 1, 16),
            "max_input_bytes": (self.max_input_bytes, 1, 1048576),
            "max_output_bytes": (self.max_output_bytes, 1, 2097152),
            "max_output_items": (self.max_output_items, 1, 1000),
            "max_network_requests": (self.max_network_requests, 1, 32),
            "max_browser_actions": (self.max_browser_actions, 1, 256),
            "invocation_lease_seconds": (self.invocation_lease_seconds, 5, 900),
            "max_invocation_records": (self.max_invocation_records, 100, 1000000),
            "max_cpu_seconds": (self.max_cpu_seconds, 1.0, 600.0),
            "max_network_bytes": (self.max_network_bytes, 1024, 10485760),
        }
        for name, (value, minimum, maximum) in bounds.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ManifestValidationError(f"{name} must be numeric")
            if name != "timeout_seconds" and name != "max_cpu_seconds" and not isinstance(value, int):
                raise ManifestValidationError(f"{name} must be an integer")
            if not minimum <= value <= maximum:
                raise ManifestValidationError(
                    f"{name} must be between {minimum} and {maximum}"
                )


@dataclass(frozen=True)
class AdapterCapabilityManifest:
    adapter_id: str
    operations: frozenset[str] = field(default_factory=frozenset)
    secrets: frozenset[str] = field(default_factory=frozenset)
    network: tuple[NetworkRule, ...] = ()
    browser_hosts: frozenset[str] = field(default_factory=frozenset)
    browser_actions: frozenset[str] = field(default_factory=frozenset)
    filesystem_read_roots: tuple[str, ...] = ()
    filesystem_write_roots: tuple[str, ...] = ()
    tools: frozenset[str] = field(default_factory=frozenset)
    limits: AdapterResourceLimits = field(default_factory=AdapterResourceLimits)

    def __post_init__(self) -> None:
        _validate_identifier(self.adapter_id, "adapter ID")
        if not self.operations <= _ADAPTER_OPERATIONS:
            raise ManifestValidationError("manifest contains unknown adapter operations")
        for secret in self.secrets:
            _validate_identifier(secret, "secret name")
        if not self.browser_actions <= _BROWSER_ACTIONS:
            raise ManifestValidationError("manifest contains unknown browser actions")
        object.__setattr__(
            self,
            "browser_hosts",
            frozenset(_normalize_host(host) for host in self.browser_hosts),
        )
        for tool in self.tools:
            _validate_identifier(tool, "tool name")
        object.__setattr__(
            self,
            "filesystem_read_roots",
            tuple(_validated_root(path) for path in self.filesystem_read_roots),
        )
        object.__setattr__(
            self,
            "filesystem_write_roots",
            tuple(_validated_root(path) for path in self.filesystem_write_roots),
        )


def _validate_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER_RE.fullmatch(value):
        raise ManifestValidationError(f"{label} is not a safe identifier")
    return value


def _normalize_host(host: str) -> str:
    if not isinstance(host, str) or not host or "*" in host or "/" in host or "@" in host:
        raise ManifestValidationError("network hosts must be exact hostnames")
    normalized = host.rstrip(".").lower()
    try:
        normalized = normalized.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ManifestValidationError("network host is invalid") from exc
    try:
        ipaddress.ip_address(normalized)
    except ValueError:
        labels = normalized.split(".")
        if len(labels) < 2 or any(
            not _DNS_LABEL_RE.fullmatch(label) for label in labels
        ):
            raise ManifestValidationError("network host must be a fully qualified hostname")
    else:
        raise ManifestValidationError("network hosts cannot be IP literals")
    return normalized


def _validated_root(path: str) -> str:
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ManifestValidationError("filesystem roots must be absolute paths")
    return str(Path(path).resolve())


def _decode_path(path: str) -> str:
    decoded = path
    for _ in range(3):
        next_value = unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    return decoded


def _safe_json_bytes(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            default=str,
        ).encode("utf-8")
    except Exception as exc:
        raise AdapterResourceLimitError("adapter input is not serializable") from exc


def _output_shape(value: object) -> tuple[int, int]:
    encoded = _safe_json_bytes(value)
    if isinstance(value, list):
        items = len(value)
    elif isinstance(value, dict):
        items = max(
            [len(child) for child in value.values() if isinstance(child, (list, dict))]
            or [len(value)]
        )
    else:
        items = 1
    return len(encoded), items


def default_manifests(limits: AdapterResourceLimits) -> dict[str, AdapterCapabilityManifest]:
    """Return reviewed built-in manifests. Unknown adapters receive nothing."""
    return {
        "discord": AdapterCapabilityManifest(
            adapter_id="discord",
            operations=_ADAPTER_OPERATIONS,
            secrets=frozenset({"discord_webhook_url", "discord_bot_token"}),
            network=(
                NetworkRule("discord.com", "/api/"),
                NetworkRule("discordapp.com", "/api/"),
            ),
            limits=limits,
        ),
        "telegram": AdapterCapabilityManifest(
            adapter_id="telegram",
            operations=frozenset({"post", "reply"}),
            secrets=frozenset({"telegram_bot_token"}),
            network=(NetworkRule("api.telegram.org", "/", frozenset({"POST"})),),
            limits=limits,
        ),
        "x": AdapterCapabilityManifest(
            adapter_id="x",
            operations=_ADAPTER_OPERATIONS,
            secrets=frozenset({"x_password"}),
            browser_hosts=frozenset({"x.com"}),
            browser_actions=_BROWSER_ACTIONS,
            limits=limits,
        ),
    }


def load_manifests(
    raw: str,
    *,
    defaults: Mapping[str, AdapterCapabilityManifest],
) -> dict[str, AdapterCapabilityManifest]:
    """Apply strict manifest replacements over reviewed built-in defaults."""
    result = dict(defaults)
    if not raw.strip():
        return result
    if len(raw.encode("utf-8")) > _MAX_MANIFEST_JSON_BYTES:
        raise ManifestValidationError("adapter manifest JSON exceeds 65536 bytes")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ManifestValidationError("adapter capability manifests must be valid JSON") from exc
    if not isinstance(parsed, dict) or len(parsed) > 32:
        raise ManifestValidationError("adapter capability manifests must be an object")
    for adapter_id, value in parsed.items():
        _validate_identifier(adapter_id, "adapter ID")
        if not isinstance(value, dict):
            raise ManifestValidationError("each adapter manifest must be an object")
        allowed_fields = {
            "operations",
            "secrets",
            "network",
            "browser_hosts",
            "browser_actions",
            "filesystem_read_roots",
            "filesystem_write_roots",
            "tools",
            "limits",
        }
        if set(value) - allowed_fields:
            raise ManifestValidationError("adapter manifest contains unknown fields")
        base = result.get(
            adapter_id,
            AdapterCapabilityManifest(adapter_id=adapter_id),
        )
        network_rules = tuple(
            _network_rule_from_json(rule)
            for rule in _string_list_or_objects(value.get("network", []), "network")
        )
        limits_value = value.get("limits", {})
        if not isinstance(limits_value, dict):
            raise ManifestValidationError("manifest limits must be an object")
        if set(limits_value) - set(AdapterResourceLimits.__dataclass_fields__):
            raise ManifestValidationError("manifest limits contain unknown fields")

        # Enforce CPU and Network Quotas
        if "max_cpu_seconds" in limits_value:
            cpu_val = limits_value["max_cpu_seconds"]
            if not isinstance(cpu_val, (int, float)) or isinstance(cpu_val, bool):
                raise ManifestValidationError("max_cpu_seconds must be numeric")
            if cpu_val < 1.0 or cpu_val > 600.0:
                raise ManifestValidationError("max_cpu_seconds must be between 1.0 and 600.0")

        if "max_network_bytes" in limits_value:
            net_val = limits_value["max_network_bytes"]
            if not isinstance(net_val, int) or isinstance(net_val, bool):
                raise ManifestValidationError("max_network_bytes must be an integer")
            if net_val < 1024 or net_val > 10485760:
                raise ManifestValidationError("max_network_bytes must be between 1024 and 10485760")

        # Construct updated limits
        base_limits = base.limits
        new_limits_kwargs = {
            "timeout_seconds": limits_value.get("timeout_seconds", base_limits.timeout_seconds),
            "max_concurrency": limits_value.get("max_concurrency", base_limits.max_concurrency),
            "max_input_bytes": limits_value.get("max_input_bytes", base_limits.max_input_bytes),
            "max_output_bytes": limits_value.get("max_output_bytes", base_limits.max_output_bytes),
            "max_output_items": limits_value.get("max_output_items", base_limits.max_output_items),
            "max_network_requests": limits_value.get("max_network_requests", base_limits.max_network_requests),
            "max_browser_actions": limits_value.get("max_browser_actions", base_limits.max_browser_actions),
            "invocation_lease_seconds": limits_value.get("invocation_lease_seconds", base_limits.invocation_lease_seconds),
            "max_invocation_records": limits_value.get("max_invocation_records", base_limits.max_invocation_records),
            "max_cpu_seconds": limits_value.get("max_cpu_seconds", base_limits.max_cpu_seconds),
            "max_network_bytes": limits_value.get("max_network_bytes", base_limits.max_network_bytes),
        }
        try:
            new_limits = AdapterResourceLimits(**new_limits_kwargs)
        except ManifestValidationError as exc:
            raise ManifestValidationError(f"Invalid limits configuration: {exc}") from exc

        # Reconstruct manifest with new limits and network rules
        updated_manifest = replace(
            base,
            operations=frozenset(value.get("operations", base.operations)),
            secrets=frozenset(value.get("secrets", base.secrets)),
            network=network_rules if network_rules else base.network,
            browser_hosts=frozenset(
                _normalize_host(h) for h in value.get("browser_hosts", base.browser_hosts)
            ),
            browser_actions=frozenset(value.get("browser_actions", base.browser_actions)),
            filesystem_read_roots=tuple(
                _validated_root(p) for p in value.get("filesystem_read_roots", base.filesystem_read_roots)
            ),
            filesystem_write_roots=tuple(
                _validated_root(p) for p in value.get("filesystem_write_roots", base.filesystem_write_roots)
            ),
            tools=frozenset(value.get("tools", base.tools)),
            limits=new_limits,
        )
        result[adapter_id] = updated_manifest

    return result

class CapabilityGuard:
    """Explicit checks for filesystem and tool capabilities."""

    def __init__(self, manifest: AdapterCapabilityManifest) -> None:
        self._manifest = manifest

    def authorize_path(self, path: str | Path, *, write: bool = False) -> Path:
        candidate = Path(path).resolve()
        roots = (
            self._manifest.filesystem_write_roots
            if write
            else self._manifest.filesystem_read_roots
        )
        if any(_is_within(candidate, Path(root)) for root in roots):
            return candidate
        _denied(self._manifest.adapter_id, "filesystem_write" if write else "filesystem_read", "path")
        raise CapabilityDeniedError("adapter filesystem capability denied")

    def authorize_tool(self, name: str) -> str:
        if name in self._manifest.tools:
            return name
        _denied(self._manifest.adapter_id, "tool", name)
        raise CapabilityDeniedError("adapter tool capability denied")


def _is_within(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


class AdapterInvocationStore:
    """Durable admission for externally visible adapter writes."""

    def __init__(self, db: object) -> None:
        self._conn: sqlite3.Connection = db._conn

    def admit(
        self,
        *,
        operation_id: str,
        adapter_name: str,
        operation: str,
        input_digest: str,
        owner_id: str,
        lease_seconds: int,
        max_records: int,
    ) -> None:
        if not _OPERATION_ID_RE.fullmatch(operation_id):
            raise InvocationConflictError("operation ID is invalid")
        now = datetime.now(timezone.utc)
        lease = now + timedelta(seconds=lease_seconds)
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            row = self._conn.execute(
                "SELECT * FROM adapter_invocations WHERE operation_id = ?",
                (operation_id,),
            ).fetchone()
            if row is None:
                record_count = self._conn.execute(
                    "SELECT COUNT(*) FROM adapter_invocations"
                ).fetchone()[0]
                if record_count >= max_records:
                    raise AdapterResourceLimitError(
                        "adapter invocation record limit exceeded"
                    )
                self._conn.execute(
                    """
                    INSERT INTO adapter_invocations (
                        operation_id, adapter_name, operation, input_digest, state,
                        owner_id, lease_expires_at
                    ) VALUES (?, ?, ?, ?, 'running', ?, ?)
                    """,
                    (
                        operation_id,
                        adapter_name,
                        operation,
                        input_digest,
                        owner_id,
                        lease.isoformat(),
                    ),
                )
                self._conn.commit()
                return
            if (
                row["adapter_name"] != adapter_name
                or row["operation"] != operation
                or row["input_digest"] != input_digest
            ):
                raise InvocationConflictError("operation ID was already used for different input")
            if row["state"] == "succeeded":
                raise DuplicateInvocationError("adapter operation already succeeded")
            if row["state"] == "indeterminate":
                raise IndeterminateInvocationError(
                    "adapter operation outcome is indeterminate; reconcile before retry"
                )
            if row["state"] == "running":
                expiry = datetime.fromisoformat(row["lease_expires_at"])
                if expiry > now:
                    raise AdapterBusyError("adapter operation is already running")
                self._conn.execute(
                    """
                    UPDATE adapter_invocations
                    SET state = 'indeterminate', updated_at = datetime('now')
                    WHERE operation_id = ?
                    """,
                    (operation_id,),
                )
                self._conn.commit()
                raise IndeterminateInvocationError(
                    "adapter operation lease expired; reconcile before retry"
                )
            self._conn.execute(
                """
                UPDATE adapter_invocations
                SET state = 'running', owner_id = ?, lease_expires_at = ?,
                    attempt_count = attempt_count + 1, updated_at = datetime('now')
                WHERE operation_id = ? AND state = 'failed'
                """,
                (owner_id, lease.isoformat(), operation_id),
            )
            self._conn.commit()
        except sqlite3.OperationalError as exc:
            if self._conn.in_transaction:
                self._conn.rollback()
            raise AdapterBusyError("adapter invocation state is busy") from exc
        except Exception:
            if self._conn.in_transaction:
                self._conn.rollback()
            raise

    def finish(self, operation_id: str, owner_id: str, state: str) -> None:
        if state not in {"succeeded", "failed", "indeterminate"}:
            raise ValueError("invalid invocation terminal state")
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            cursor = self._conn.execute(
                """
                UPDATE adapter_invocations
                SET state = ?, updated_at = datetime('now')
                WHERE operation_id = ? AND owner_id = ? AND state = 'running'
                """,
                (state, operation_id, owner_id),
            )
            if cursor.rowcount != 1:
                raise InvocationConflictError("adapter invocation ownership changed")
            self._conn.commit()
        except sqlite3.OperationalError as exc:
            if self._conn.in_transaction:
                self._conn.rollback()
            raise AdapterBusyError("adapter invocation state is busy") from exc
        except Exception:
            if self._conn.in_transaction:
                self._conn.rollback()
            raise

    def is_running(self, operation_id: str | None, owner_id: str) -> bool:
        if operation_id is None:
            return False
        row = self._conn.execute(
            "SELECT state, owner_id FROM adapter_invocations WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
        return bool(row and row["state"] == "running" and row["owner_id"] == owner_id)


class AdapterSandbox:
    """Construct scoped dependencies and wrap adapters with policy enforcement."""

    def __init__(
        self,
        *,
        manifests: Mapping[str, AdapterCapabilityManifest],
        db: object,
        secret_resolver: Callable[[str], str],
        retry_configs: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> None:
        self._manifests = dict(manifests)
        self._store = AdapterInvocationStore(db)
        self._secret_resolver = secret_resolver
        self._semaphores = {
            name: asyncio.Semaphore(manifest.limits.max_concurrency)
            for name, manifest in self._manifests.items()
        }
        self._owner_id = str(uuid.uuid4())
        self._retry_configs = dict(retry_configs or {})
        self._breakers = CircuitBreakerRegistry()

    def manifest(self, adapter_id: str) -> AdapterCapabilityManifest:
        normalized = adapter_id.lower()
        manifest = self._manifests.get(normalized)
        if manifest is None:
            _denied(normalized, "manifest", "register")
            raise CapabilityDeniedError("adapter has no capability manifest")
        return manifest

    def secrets(self, adapter_id: str) -> ScopedSecretProvider:
        return ScopedSecretProvider(self.manifest(adapter_id), self._secret_resolver)

    def http(self, adapter_id: str) -> SandboxedHTTPClient:
        return SandboxedHTTPClient(self.manifest(adapter_id))

    def browser(self, adapter_id: str, browser: object) -> SandboxedBrowser:
        return SandboxedBrowser(browser, self.manifest(adapter_id))

    def guard(self, adapter_id: str) -> CapabilityGuard:
        return CapabilityGuard(self.manifest(adapter_id))

    def wrap(self, adapter: BaseSocialAdapter) -> SandboxedAdapter:
        adapter_id = adapter.channel_name.lower()
        manifest = self.manifest(adapter_id)
        return SandboxedAdapter(
            adapter,
            manifest=manifest,
            store=self._store,
            semaphore=self._semaphores[adapter_id],
            owner_id=self._owner_id,
            breaker=self._breakers.get_or_create(
                adapter_id,
                CircuitBreakerConfig.from_mapping(self._retry_configs.get(adapter_id)),
            ),
        )


class SandboxedAdapter(BaseSocialAdapter):
    """BaseSocialAdapter proxy enforcing a single immutable manifest."""

    def __init__(
        self,
        adapter: BaseSocialAdapter,
        *,
        manifest: AdapterCapabilityManifest,
        store: AdapterInvocationStore,
        semaphore: asyncio.Semaphore,
        owner_id: str,
        breaker: Any,
    ) -> None:
        self.__adapter = adapter
        self.__manifest = manifest
        self.__store = store
        self.__semaphore = semaphore
        self.__owner_id = owner_id
        self.__breaker = breaker
        self.channel_name = adapter.channel_name

    def get_capabilities(self) -> ChannelCapabilities:
        return self.__adapter.get_capabilities()

    def health_snapshot(self) -> AdapterHealthSnapshot | dict[str, bool]:
        """Forward the wrapped adapter's own snapshot, typed or legacy, unchanged."""
        snapshot = getattr(self.__adapter, "health_snapshot", None)
        return snapshot() if callable(snapshot) else {}

    async def post(self, content: str, **kwargs: Any) -> PublishResult:
        return await self._invoke("post", content, kwargs=kwargs, write=True)

    async def reply(self, target_url: str, content: str, **kwargs: Any) -> PublishResult:
        return await self._invoke(
            "reply", target_url, content, kwargs=kwargs, write=True
        )

    async def get_mentions(self, **kwargs: Any) -> list[dict]:
        return await self._invoke("get_mentions", kwargs=kwargs)

    async def search(self, query: str, **kwargs: Any) -> list[dict]:
        return await self._invoke("search", query, kwargs=kwargs)

    async def get_post_performance(self, content_snippet: str, **kwargs: Any) -> dict:
        return await self._invoke(
            "get_post_performance", content_snippet, kwargs=kwargs
        )

    async def get_profile_stats(self, **kwargs: Any) -> dict:
        return await self._invoke("get_profile_stats", kwargs=kwargs)

    async def _invoke(
        self,
        operation: str,
        *args: Any,
        kwargs: dict[str, Any],
        write: bool = False,
    ) -> Any:
        started = time.monotonic()
        if operation not in self.__manifest.operations:
            _denied(self.__manifest.adapter_id, "operation", operation)
            raise CapabilityDeniedError("adapter operation capability denied")
        operation_id = kwargs.pop("operation_id", None)
        if operation_id is not None and not isinstance(operation_id, str):
            raise InvocationConflictError("operation ID must be a string")
        if write and operation_id is None:
            operation_id = str(uuid.uuid4())
        payload = _safe_json_bytes(
            {"operation": operation, "args": args, "kwargs": kwargs}
        )
        if len(payload) > self.__manifest.limits.max_input_bytes:
            _resource(self.__manifest.adapter_id, operation, "input")
            raise AdapterResourceLimitError("adapter input limit exceeded")
        digest = hashlib.sha256(payload).hexdigest()
        if write:
            try:
                self.__store.admit(
                    operation_id=operation_id,
                    adapter_name=self.__manifest.adapter_id,
                    operation=operation,
                    input_digest=digest,
                    owner_id=self.__owner_id,
                    lease_seconds=self.__manifest.limits.invocation_lease_seconds,
                    max_records=self.__manifest.limits.max_invocation_records,
                )
            except AdapterSandboxError as exc:
                _invocation_log(
                    self.__manifest.adapter_id,
                    operation,
                    operation_id,
                    "rejected",
                    started,
                    type(exc),
                )
                raise
            _invocation_log(
                self.__manifest.adapter_id,
                operation,
                operation_id,
                "admitted",
                started,
            )
        budget = _InvocationBudget(self.__manifest, operation, operation_id)
        token = _BUDGET.set(budget)
        acquired = False
        deadline = started + self.__manifest.limits.timeout_seconds
        try:
            await asyncio.wait_for(
                self.__semaphore.acquire(),
                timeout=max(0.001, deadline - time.monotonic()),
            )
            acquired = True
            method = getattr(self.__adapter, operation)

            async def invoke() -> Any:
                return await asyncio.wait_for(
                    method(*args, **kwargs),
                    timeout=max(0.001, deadline - time.monotonic()),
                )

            result = await execute_with_retry(
                invoke,
                self.__breaker,
                is_failure=lambda value: (
                    isinstance(value, PublishResult) and value.status == "failed"
                ),
            )
            output_bytes, output_items = _output_shape(
                result.to_dict() if isinstance(result, PublishResult) else result
            )
            if (
                output_bytes > self.__manifest.limits.max_output_bytes
                or output_items > self.__manifest.limits.max_output_items
            ):
                _resource(self.__manifest.adapter_id, operation, "output")
                if write:
                    state = (
                        "indeterminate" if budget.external_effect_started else "failed"
                    )
                    self.__store.finish(operation_id, self.__owner_id, state)
                raise AdapterResourceLimitError("adapter output limit exceeded")
            if isinstance(result, PublishResult) and result.status == "failed":
                if write:
                    state = (
                        "indeterminate" if budget.external_effect_started else "failed"
                    )
                    self.__store.finish(operation_id, self.__owner_id, state)
                    result.metadata = dict(result.metadata)
                    result.metadata["operation_id"] = operation_id
                result.error = "adapter operation failed"
                _invocation_log(
                    self.__manifest.adapter_id,
                    operation,
                    operation_id,
                    "failed",
                    started,
                )
                return result
            if write:
                self.__store.finish(operation_id, self.__owner_id, "succeeded")
                if isinstance(result, PublishResult):
                    result.metadata = dict(result.metadata)
                    result.metadata["operation_id"] = operation_id
            _invocation_log(
                self.__manifest.adapter_id,
                operation,
                operation_id,
                "succeeded",
                started,
            )
            return result
        except asyncio.TimeoutError as exc:
            if write:
                state = "indeterminate" if budget.external_effect_started else "failed"
                self.__store.finish(operation_id, self.__owner_id, state)
            _invocation_log(
                self.__manifest.adapter_id,
                operation,
                operation_id,
                "timed_out",
                started,
                AdapterTimeoutError,
            )
            raise AdapterTimeoutError("adapter invocation timed out") from exc
        except AdapterSandboxError:
            if write and self._is_running(operation_id):
                state = "indeterminate" if budget.external_effect_started else "failed"
                self.__store.finish(operation_id, self.__owner_id, state)
            raise
        except Exception as exc:
            if write and self._is_running(operation_id):
                state = "indeterminate" if budget.external_effect_started else "failed"
                self.__store.finish(operation_id, self.__owner_id, state)
            _invocation_log(
                self.__manifest.adapter_id,
                operation,
                operation_id,
                "failed",
                started,
                type(exc),
            )
            raise AdapterExecutionError("adapter execution failed") from exc
        finally:
            if acquired:
                self.__semaphore.release()
            _BUDGET.reset(token)

    def _is_running(self, operation_id: str | None) -> bool:
        return self.__store.is_running(operation_id, self.__owner_id)


def _denied(adapter: str, capability: str, target: str) -> None:
    try:
        log.warning(
            "adapter_capability_denied",
            **safe_adapter_diagnostic_fields(
                adapter=adapter, capability=capability, target=target, outcome="denied"
            ),
        )
    except Exception:
        pass


def _network_rule_from_json(rule: Any) -> NetworkRule:
    if isinstance(rule, str):
        return NetworkRule(host=rule)
    if isinstance(rule, dict):
        host = rule.get("host")
        path = rule.get("path_prefix", "/")
        methods = rule.get("methods", ["GET", "POST"])
        port = rule.get("port", None)
        if not isinstance(host, str):
            raise ManifestValidationError("network rule host must be a string")
        if not isinstance(path, str):
            raise ManifestValidationError("network rule path_prefix must be a string")
        if not isinstance(methods, (list, tuple)):
            raise ManifestValidationError("network rule methods must be a list")
        if port is not None and not isinstance(port, int):
            raise ManifestValidationError("network rule port must be an integer")
        return NetworkRule(
            host=host,
            path_prefix=path,
            methods=frozenset(methods),
            port=port,
        )
    raise ManifestValidationError("network rule must be a string or object")


def _string_list_or_objects(value: Any, label: str) -> list:
    if not isinstance(value, list):
        raise ManifestValidationError(f"{label} must be a list")
    return value
