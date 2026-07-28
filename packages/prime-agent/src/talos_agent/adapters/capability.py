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
        if self.port is not None and not 1 <= self.port <= 65535:
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
        }
        for name, (value, minimum, maximum) in bounds.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ManifestValidationError(f"{name} must be numeric")
            if name != "timeout_seconds" and not isinstance(value, int):
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
        manifest_limits = replace(base.limits, **limits_value)
        result[adapter_id] = AdapterCapabilityManifest(
            adapter_id=adapter_id,
            operations=frozenset(_string_list(value.get("operations", []), "operations")),
            secrets=frozenset(_string_list(value.get("secrets", []), "secrets")),
            network=network_rules,
            browser_hosts=frozenset(
                _string_list(value.get("browser_hosts", []), "browser_hosts")
            ),
            browser_actions=frozenset(
                _string_list(value.get("browser_actions", []), "browser_actions")
            ),
            filesystem_read_roots=tuple(
                _string_list(value.get("filesystem_read_roots", []), "filesystem_read_roots")
            ),
            filesystem_write_roots=tuple(
                _string_list(value.get("filesystem_write_roots", []), "filesystem_write_roots")
            ),
            tools=frozenset(_string_list(value.get("tools", []), "tools")),
            limits=manifest_limits,
        )
    return result


def _string_list(value: object, label: str) -> list[str]:
    if not isinstance(value, list) or len(value) > 256 or not all(
        isinstance(item, str) for item in value
    ):
        raise ManifestValidationError(f"{label} must be a bounded string list")
    return value


def _string_list_or_objects(value: object, label: str) -> list[dict]:
    if not isinstance(value, list) or len(value) > 64 or not all(
        isinstance(item, dict) for item in value
    ):
        raise ManifestValidationError(f"{label} must be a bounded object list")
    return value


def _network_rule_from_json(value: dict) -> NetworkRule:
    if set(value) - {"host", "path_prefix", "methods", "port"} or "host" not in value:
        raise ManifestValidationError("network rule contains invalid fields")
    return NetworkRule(
        host=value["host"],
        path_prefix=value.get("path_prefix", "/"),
        methods=frozenset(_string_list(value.get("methods", ["GET", "POST"]), "methods")),
        port=value.get("port"),
    )


@dataclass
class _InvocationBudget:
    manifest: AdapterCapabilityManifest
    operation: str
    operation_id: str | None
    network_requests: int = 0
    browser_actions: int = 0
    external_effect_started: bool = False


_BUDGET: contextvars.ContextVar[_InvocationBudget | None] = contextvars.ContextVar(
    "adapter_capability_budget", default=None
)


def _current_budget(manifest: AdapterCapabilityManifest) -> _InvocationBudget:
    budget = _BUDGET.get()
    if budget is None or budget.manifest.adapter_id != manifest.adapter_id:
        raise CapabilityDeniedError("adapter I/O is denied outside a sandbox invocation")
    return budget


class SecretProvider(Protocol):
    def get(self, name: str) -> str: ...


class ScopedSecretProvider:
    """Expose only manifest-declared secret names via point-of-use resolution."""

    def __init__(
        self,
        manifest: AdapterCapabilityManifest,
        resolver: Callable[[str], str],
    ) -> None:
        self.__manifest = manifest
        self.__resolver = resolver

    def get(self, name: str) -> str:
        if name not in self.__manifest.secrets:
            _denied(self.__manifest.adapter_id, "secret", name)
            raise CapabilityDeniedError("adapter secret capability denied")
        return self.__resolver(name)


class AdapterHTTPClient(Protocol):
    async def get(self, url: str, **kwargs: Any) -> httpx.Response: ...
    async def post(self, url: str, **kwargs: Any) -> httpx.Response: ...


class DirectHTTPClient:
    """Legacy transport used only while sandbox enforcement is disabled."""

    def __init__(self, timeout: float = 30.0) -> None:
        self._timeout = timeout

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=False) as client:
            return await client.get(url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=False) as client:
            return await client.post(url, **kwargs)


class SandboxedHTTPClient:
    """HTTP facade enforcing exact network rules and response size limits."""

    def __init__(
        self,
        manifest: AdapterCapabilityManifest,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._manifest = manifest
        self._transport = transport

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self._request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self._request("POST", url, **kwargs)

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        self._authorize(method, url)
        if set(kwargs) - {"headers", "json", "params", "timeout"}:
            raise CapabilityDeniedError("adapter HTTP option denied")
        try:
            request_bytes = json.dumps(
                kwargs,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise CapabilityDeniedError("adapter HTTP input must be JSON-compatible") from exc
        if len(request_bytes) > self._manifest.limits.max_input_bytes:
            _resource(self._manifest.adapter_id, "network", "request")
            raise AdapterResourceLimitError("adapter network request limit exceeded")
        requested_timeout = kwargs.pop(
            "timeout", self._manifest.limits.timeout_seconds
        )
        if (
            isinstance(requested_timeout, bool)
            or not isinstance(requested_timeout, (int, float))
            or requested_timeout <= 0
        ):
            raise CapabilityDeniedError("adapter HTTP timeout is invalid")
        budget = _current_budget(self._manifest)
        budget.network_requests += 1
        if budget.network_requests > self._manifest.limits.max_network_requests:
            _resource(self._manifest.adapter_id, budget.operation, "network_requests")
            raise AdapterResourceLimitError("adapter network request limit exceeded")
        budget.external_effect_started = True
        timeout = min(
            float(requested_timeout),
            self._manifest.limits.timeout_seconds,
        )
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=False,
            transport=self._transport,
        ) as client:
            async with client.stream(method, url, **kwargs) as response:
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > self._manifest.limits.max_output_bytes:
                        _resource(self._manifest.adapter_id, budget.operation, "network_response")
                        raise AdapterResourceLimitError(
                            "adapter network response limit exceeded"
                        )
                return httpx.Response(
                    response.status_code,
                    headers=response.headers,
                    content=bytes(content),
                    request=response.request,
                )

    def _authorize(self, method: str, url: str) -> None:
        if not isinstance(url, str) or len(url) > 2048:
            raise CapabilityDeniedError("adapter network URL is invalid")
        parsed = urlsplit(url)
        if (
            parsed.scheme.lower() != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
        ):
            _denied(self._manifest.adapter_id, "network", "url")
            raise CapabilityDeniedError("adapter network destination denied")
        try:
            host = _normalize_host(parsed.hostname)
            port = parsed.port
        except (ManifestValidationError, ValueError) as exc:
            raise CapabilityDeniedError("adapter network destination denied") from exc
        decoded_path = _decode_path(parsed.path or "/")
        if ".." in decoded_path.split("/"):
            raise CapabilityDeniedError("adapter network path denied")
        path = posixpath.normpath(decoded_path)
        if decoded_path.endswith("/") and not path.endswith("/"):
            path += "/"
        normalized_method = method.upper()
        for rule in self._manifest.network:
            effective_port = port or 443
            rule_port = rule.port or 443
            if (
                host == rule.host
                and effective_port == rule_port
                and normalized_method in rule.methods
                and path.startswith(rule.path_prefix)
            ):
                return
        _denied(self._manifest.adapter_id, "network", normalized_method.lower())
        raise CapabilityDeniedError("adapter network destination denied")


class SandboxedBrowser:
    """Narrow browser facade; no session, filesystem, or process handles."""

    def __init__(self, browser: object, manifest: AdapterCapabilityManifest) -> None:
        self.__browser = browser
        self.__manifest = manifest

    def _consume(self, action: str) -> _InvocationBudget:
        if action not in self.__manifest.browser_actions:
            _denied(self.__manifest.adapter_id, "browser", action)
            raise CapabilityDeniedError("adapter browser capability denied")
        budget = _current_budget(self.__manifest)
        budget.browser_actions += 1
        if budget.browser_actions > self.__manifest.limits.max_browser_actions:
            _resource(self.__manifest.adapter_id, budget.operation, "browser_actions")
            raise AdapterResourceLimitError("adapter browser action limit exceeded")
        budget.external_effect_started = True
        return budget

    async def goto(self, url: str) -> Any:
        parsed = urlsplit(url)
        if (
            parsed.scheme.lower() != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
        ):
            raise CapabilityDeniedError("adapter browser destination denied")
        try:
            host = _normalize_host(parsed.hostname)
            port = parsed.port
        except ManifestValidationError as exc:
            raise CapabilityDeniedError("adapter browser destination denied") from exc
        except ValueError as exc:
            raise CapabilityDeniedError("adapter browser destination denied") from exc
        if host not in self.__manifest.browser_hosts or (port is not None and port != 443):
            _denied(self.__manifest.adapter_id, "browser_host", "goto")
            raise CapabilityDeniedError("adapter browser destination denied")
        self._consume("goto")
        return self._bounded_output(await self.__browser.goto(url))

    async def act(self, instruction: str) -> Any:
        self._bounded_text(instruction)
        self._consume("act")
        return self._bounded_output(await self.__browser.act(instruction))

    async def extract(self, instruction: str, **kwargs: Any) -> Any:
        self._bounded_text(instruction)
        if len(_safe_json_bytes(kwargs)) > self.__manifest.limits.max_input_bytes:
            raise AdapterResourceLimitError("adapter browser input limit exceeded")
        self._consume("extract")
        return self._bounded_output(
            await self.__browser.extract(instruction, **kwargs)
        )

    async def keyboard_press(self, key: str) -> Any:
        self._bounded_text(key)
        self._consume("keyboard_press")
        return self._bounded_output(await self.__browser.keyboard_press(key))

    async def keyboard_type(self, text: str) -> Any:
        self._bounded_text(text)
        self._consume("keyboard_type")
        return self._bounded_output(await self.__browser.keyboard_type(text))

    def _bounded_text(self, value: str) -> None:
        if not isinstance(value, str) or len(value.encode("utf-8")) > self.__manifest.limits.max_input_bytes:
            raise AdapterResourceLimitError("adapter browser input limit exceeded")

    def _bounded_output(self, value: Any) -> Any:
        size, items = _output_shape(value)
        if (
            size > self.__manifest.limits.max_output_bytes
            or items > self.__manifest.limits.max_output_items
        ):
            _resource(self.__manifest.adapter_id, "browser", "output")
            raise AdapterResourceLimitError("adapter browser output limit exceeded")
        return value

    def is_live(self) -> bool:
        stagehand = getattr(self.__browser, "_stagehand", None)
        return bool(stagehand is not None and getattr(stagehand, "page", None) is not None)


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
    ) -> None:
        self._manifests = dict(manifests)
        self._store = AdapterInvocationStore(db)
        self._secret_resolver = secret_resolver
        self._semaphores = {
            name: asyncio.Semaphore(manifest.limits.max_concurrency)
            for name, manifest in self._manifests.items()
        }
        self._owner_id = str(uuid.uuid4())

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
    ) -> None:
        self.__adapter = adapter
        self.__manifest = manifest
        self.__store = store
        self.__semaphore = semaphore
        self.__owner_id = owner_id
        self.channel_name = adapter.channel_name

    def get_capabilities(self) -> ChannelCapabilities:
        return self.__adapter.get_capabilities()

    def health_snapshot(self) -> dict[str, bool]:
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
            result = await asyncio.wait_for(
                method(*args, **kwargs),
                timeout=max(0.001, deadline - time.monotonic()),
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
            adapter=adapter,
            capability=capability,
            target=target,
            outcome="denied",
        )
    except Exception:
        pass


def _resource(adapter: str, operation: str, resource: str) -> None:
    try:
        log.warning(
            "adapter_resource_limit",
            adapter=adapter,
            operation=operation,
            resource=resource,
            outcome="denied",
        )
    except Exception:
        pass


def _invocation_log(
    adapter: str,
    operation: str,
    operation_id: str | None,
    outcome: str,
    started: float,
    error_type: type[BaseException] | None = None,
) -> None:
    fields: dict[str, Any] = {
        "adapter": adapter,
        "operation": operation,
        "operation_id": operation_id,
        "outcome": outcome,
        "duration_ms": round((time.monotonic() - started) * 1000, 2),
    }
    if error_type is not None:
        fields["error_type"] = error_type.__name__
    try:
        log.info("adapter_sandbox_invocation", **fields)
    except Exception:
        pass


__all__ = [
    "AdapterBusyError",
    "AdapterCapabilityManifest",
    "AdapterExecutionError",
    "AdapterHTTPClient",
    "AdapterInvocationStore",
    "AdapterResourceLimitError",
    "AdapterResourceLimits",
    "AdapterSandbox",
    "AdapterSandboxError",
    "AdapterTimeoutError",
    "CapabilityDeniedError",
    "CapabilityGuard",
    "DirectHTTPClient",
    "DuplicateInvocationError",
    "IndeterminateInvocationError",
    "InvocationConflictError",
    "ManifestValidationError",
    "NetworkRule",
    "SandboxedAdapter",
    "SandboxedBrowser",
    "SandboxedHTTPClient",
    "ScopedSecretProvider",
    "SecretProvider",
    "default_manifests",
    "load_manifests",
]
