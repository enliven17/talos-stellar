"""Tool registry — @tool decorator → OpenAI function schemas + dispatcher."""

from __future__ import annotations

import asyncio
import inspect
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, get_type_hints

from talos_agent import metrics
from talos_agent.config import Settings, resolve_setting_secret
from talos_agent.redact import redact_text
from talos_agent.tracing import traced_span
from talos_agent.tools import context as _context
from talos_agent.tools.context import ToolContext
from talos_agent.tools.permissions import (
    EnforcementMode,
    PermissionEnforcer,
    PermissionGrants,
    ToolPermissions,
)

logger = logging.getLogger(__name__)

DEFAULT_TOOL_TIMEOUT_SECONDS = 30.0
MAX_TOOL_TIMEOUT_SECONDS = 300.0

MAX_VALIDATION_ERRORS = 10
MAX_ERROR_MESSAGE_LEN = 1000
MAX_VALUE_REPR_LEN = 100

CODE_INVALID_ARGUMENTS = "INVALID_TOOL_ARGUMENTS"


class _ToolTimeoutError(Exception):
    """Raised when a tool itself raises TimeoutError, distinct from wait_for expiry."""


def _validate_tool_timeout(timeout: float | None) -> float:
    """Normalize a per-tool timeout, applying the safe default and bound."""
    if timeout is None:
        return DEFAULT_TOOL_TIMEOUT_SECONDS
    timeout = float(timeout)
    if not math.isfinite(timeout) or timeout <= 0 or timeout > MAX_TOOL_TIMEOUT_SECONDS:
        raise ValueError(
            "tool timeout must be finite, greater than 0, and at most "
            f"{MAX_TOOL_TIMEOUT_SECONDS}; got {timeout}"
        )
    return timeout


@dataclass(frozen=True)
class ValidationError:
    """A single schema validation failure for a tool argument."""

    parameter: str
    message: str
    expected: str | None = None
    actual: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "parameter": self.parameter,
            "message": redact_text(self.message),
        }
        if self.expected is not None:
            result["expected"] = self.expected
        if self.actual is not None:
            result["actual"] = self.actual
        return result


@dataclass
class ValidationResult:
    """Outcome of validating and safely coercing tool call arguments."""

    is_valid: bool
    coerced_arguments: dict[str, Any] = field(default_factory=dict)
    errors: list[ValidationError] = field(default_factory=list)

    def to_error_dict(self, tool_name: str) -> dict[str, Any]:
        """Produce a bounded, redacted error dict for the LLM tool-call response."""
        error_messages = [e.message for e in self.errors[:MAX_VALIDATION_ERRORS]]
        summary = "; ".join(error_messages)
        if len(self.errors) > MAX_VALIDATION_ERRORS:
            summary += f" (and {len(self.errors) - MAX_VALIDATION_ERRORS} more errors)"

        redacted_summary = redact_text(summary)
        if len(redacted_summary) > MAX_ERROR_MESSAGE_LEN:
            redacted_summary = redacted_summary[: MAX_ERROR_MESSAGE_LEN - 3] + "..."

        return {
            "error": f"Invalid arguments for tool '{tool_name}': {redacted_summary}",
            "code": CODE_INVALID_ARGUMENTS,
            "tool": tool_name,
            "validation_errors": [
                e.to_dict() for e in self.errors[:MAX_VALIDATION_ERRORS]
            ],
        }


def _validate_and_coerce_value(
    param_name: str,
    val: Any,
    expected_type: str | list[str],
    prop_schema: dict[str, Any],
) -> tuple[Any, ValidationError | None]:
    """Validate a single value against expected JSON schema type, applying safe coercions.

    Safe Coercion Policy:
    ---------------------
    - Integer-valued floats (e.g. 10.0 -> 10) are safely coerced for integer parameters
      when within IEEE-754 exact integer range (-2^53 <= val <= 2^53).
    - Tuples are converted to lists for array parameters.
    - String amounts, non-integer floats, and cross-type values (e.g. bool for int/number)
      are NEVER coerced and are strictly rejected.
    """
    types = [expected_type] if isinstance(expected_type, str) else list(expected_type)

    for t in types:
        if t == "string":
            if isinstance(val, str):
                return val, None
        elif t == "integer":
            if isinstance(val, bool):
                # In Python bool is a subclass of int, but in JSON it is boolean
                continue
            if isinstance(val, int):
                return val, None
            # Explicitly safe coercion: integer-valued float (e.g. 10.0 -> 10)
            if isinstance(val, float) and math.isfinite(val) and val.is_integer():
                if -9007199254740992 <= val <= 9007199254740992:
                    return int(val), None
        elif t == "number":
            if isinstance(val, bool):
                continue
            if isinstance(val, (int, float)) and math.isfinite(val):
                return val, None
        elif t == "boolean":
            if isinstance(val, bool):
                return val, None
        elif t == "array":
            if isinstance(val, (list, tuple)):
                items_schema = prop_schema.get("items")
                coerced_list = list(val)
                if isinstance(items_schema, dict) and "type" in items_schema:
                    item_type = items_schema["type"]
                    new_list = []
                    item_err = None
                    for idx, item in enumerate(coerced_list):
                        c_item, err = _validate_and_coerce_value(
                            f"{param_name}[{idx}]", item, item_type, items_schema
                        )
                        if err is not None:
                            item_err = err
                            break
                        new_list.append(c_item)
                    if item_err is not None:
                        return None, item_err
                    return new_list, None
                return coerced_list, None
        elif t == "object":
            if isinstance(val, dict):
                return val, None
        elif t == "null":
            if val is None:
                return None, None

    # No type matched: build bounded & redacted error
    actual_type = type(val).__name__
    if isinstance(val, bool):
        actual_type = "boolean"
    elif isinstance(val, float) and not math.isfinite(val):
        actual_type = "non-finite float"

    type_str = ", ".join(types) if isinstance(expected_type, list) else str(expected_type)
    val_repr = redact_text(str(val))
    if len(val_repr) > MAX_VALUE_REPR_LEN:
        val_repr = val_repr[: MAX_VALUE_REPR_LEN - 3] + "..."

    return None, ValidationError(
        parameter=param_name,
        message=f"Parameter '{param_name}' must be of type {type_str}, got {actual_type} ({val_repr})",
        expected=type_str,
        actual=actual_type,
    )


def validate_tool_arguments(
    parameters_schema: dict[str, Any] | None,
    arguments: Any,
) -> ValidationResult:
    """Validate decoded tool arguments against the tool parameters JSON schema.

    Enforces:
    - arguments is a Mapping (dict)
    - All required properties are present and non-null (unless schema allows null)
    - Unknown parameters (extra keys) are rejected unless additionalProperties is true
    - Types match schema with explicitly safe coercions (e.g. integer-valued floats)

    Time Complexity: O(N + R) where N is number of arguments and R is required fields.
    Space Complexity: O(N) bounded auxiliary space.
    """
    if not isinstance(arguments, Mapping):
        actual_type = type(arguments).__name__
        return ValidationResult(
            is_valid=False,
            errors=[
                ValidationError(
                    parameter="<arguments>",
                    message=f"Tool arguments must be a dictionary/object, got {actual_type}",
                    expected="object",
                    actual=actual_type,
                )
            ],
        )

    if not parameters_schema or not isinstance(parameters_schema, dict):
        return ValidationResult(is_valid=True, coerced_arguments=dict(arguments))

    properties = parameters_schema.get("properties")
    if properties is None or not isinstance(properties, dict):
        properties = {}

    required_fields = set(parameters_schema.get("required", []))
    allow_additional = bool(parameters_schema.get("additionalProperties", False))

    errors: list[ValidationError] = []
    coerced: dict[str, Any] = {}

    # 1. Missing required parameters
    for req_field in sorted(required_fields):
        if req_field not in arguments:
            errors.append(
                ValidationError(
                    parameter=req_field,
                    message=f"Missing required parameter '{req_field}'",
                    expected="present",
                    actual="missing",
                )
            )
        elif arguments[req_field] is None:
            prop_schema = properties.get(req_field, {})
            allowed_types = prop_schema.get("type")
            is_nullable = (
                allowed_types == "null"
                or (isinstance(allowed_types, (list, tuple)) and "null" in allowed_types)
            )
            if not is_nullable:
                errors.append(
                    ValidationError(
                        parameter=req_field,
                        message=f"Required parameter '{req_field}' cannot be null",
                        expected="non-null",
                        actual="null",
                    )
                )

    # 2. Reject unknown parameters (extra keys)
    if not allow_additional:
        for key in sorted(arguments.keys()):
            if key not in properties:
                allowed_desc = (
                    f"one of {sorted(properties.keys())}"
                    if properties
                    else "no parameters"
                )
                errors.append(
                    ValidationError(
                        parameter=key,
                        message=f"Unknown parameter '{key}'",
                        expected=allowed_desc,
                        actual="unexpected parameter",
                    )
                )

    # 3. Type checking & safe coercion
    for key, val in arguments.items():
        if key not in properties:
            continue

        prop_schema = properties[key]
        if not isinstance(prop_schema, dict):
            coerced[key] = val
            continue

        expected_type = prop_schema.get("type")
        if expected_type is None:
            coerced[key] = val
            continue

        if val is None:
            if key in required_fields:
                continue  # already flagged above if non-nullable
            coerced[key] = None
            continue

        coerced_val, type_err = _validate_and_coerce_value(
            key, val, expected_type, prop_schema
        )
        if type_err is not None:
            errors.append(type_err)
        else:
            coerced[key] = coerced_val

    if errors:
        return ValidationResult(is_valid=False, errors=errors)

    return ValidationResult(is_valid=True, coerced_arguments=coerced)


@dataclass
class Tool:
    name: str
    description: str
    fn: Callable
    parameters: dict[str, Any]
    #: Declared permission surface. `None` means the tool did not declare one
    #: and the enforcer resolved it from the legacy table (or denied it).
    permissions: ToolPermissions | None = None
    timeout: float = DEFAULT_TOOL_TIMEOUT_SECONDS

    def __post_init__(self) -> None:
        self.timeout = validate_tool_timeout(self.timeout)

    def to_openai_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass
class ToolRegistry:
    _tools: dict[str, Tool] = field(default_factory=dict)
    #: The agent this registry belongs to. When set, every ``execute`` binds it,
    #: so tools read this agent's API client, database and settings no matter
    #: what other agents in the process are doing. ``None`` is the shared
    #: template that ``@tool`` registers into, which runs tools against the
    #: tool modules' own globals.
    context: ToolContext | None = None
    _middleware: Any = None  # PolicyMiddleware, injected by build_all_tools
    # Permission manifests are validated here at registration and enforced in
    # execute(). Defaults to AUDIT with no grants: every call is evaluated and
    # recorded, none are blocked, so enabling this module changes no behaviour
    # until an operator opts into ENFORCE.
    _enforcer: PermissionEnforcer = field(default_factory=PermissionEnforcer)
    # Callback for telemetry/policy validation events.
    _validation_sink: Callable[[dict[str, Any]], None] | None = None

    def __len__(self) -> int:
        return len(self._tools)

    def set_middleware(self, middleware: Any) -> None:
        """Inject the policy middleware for pre-execution policy checks."""
        self._middleware = middleware

    def set_permission_enforcer(self, enforcer: PermissionEnforcer) -> None:
        """Replace the enforcer, re-validating every already-registered tool.

        Re-registration is what makes ordering irrelevant: tools import (and
        register) at module import time, before settings are known, so the
        manifests are re-resolved once the real grants arrive.
        """
        for tool in self._tools.values():
            enforcer.register(tool.name, tool.permissions)
        self._enforcer = enforcer

    def set_validation_sink(
        self, sink: Callable[[dict[str, Any]], None] | None
    ) -> None:
        """Register a callback to capture tool argument validation events."""
        self._validation_sink = sink

    @property
    def permissions(self) -> PermissionEnforcer:
        return self._enforcer

    def register(
        self,
        name: str,
        description: str,
        fn: Callable,
        parameters: dict[str, Any],
        permissions: ToolPermissions | None = None,
        timeout: float | None = None,
    ) -> None:
        # Raises ManifestValidationError for a declared-but-unenforceable
        # manifest, so the problem surfaces at import rather than first call.
        timeout = validate_tool_timeout(timeout)
        self._enforcer.register(name, permissions)

        # Fallback to function signature schema if empty parameters provided
        # for a function that expects arguments.
        if (
            (
                not parameters
                or (
                    isinstance(parameters, dict)
                    and not parameters.get("properties")
                    and not parameters.get("required")
                )
            )
            and callable(fn)
        ):
            derived = _fn_to_json_schema(fn)
            if derived.get("properties"):
                parameters = derived

        self._tools[name] = Tool(
            name=name,
            description=description,
            fn=fn,
            parameters=parameters,
            permissions=permissions,
            timeout=timeout,
        )

    def for_agent(self, context: ToolContext) -> "ToolRegistry":
        """A registry with this registry's tools and its own state.

        The tools themselves are shared, because they read their dependencies
        from whichever context is bound when they run. What is not shared is
        everything an agent configures: the context, the policy middleware and
        the permission enforcer.
        """
        return ToolRegistry(_tools=dict(self._tools), context=context)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all_tools(self) -> list[Tool]:
        return list(self._tools.values())

    def openai_schemas(self) -> list[dict]:
        return [t.to_openai_schema() for t in self._tools.values()]

    def validate_arguments(self, tool: Tool, arguments: Any) -> ValidationResult:
        """Validate decoded arguments against tool parameters JSON schema."""
        return validate_tool_arguments(tool.parameters, arguments)

    def _record_validation_event(
        self,
        name: str,
        errors: list[ValidationError],
        raw_arguments: Any,
    ) -> None:
        """Emit a structured policy/telemetry event for rejected arguments."""
        event = {
            "event": "tool_argument_validation_failed",
            "tool": name,
            "timestamp": time.time(),
            "error_count": len(errors),
            "errors": [e.to_dict() for e in errors[:MAX_VALIDATION_ERRORS]],
            "rejected_parameters": [e.parameter for e in errors],
        }

        if self._validation_sink is not None:
            try:
                self._validation_sink(event)
            except Exception:
                logger.exception("Validation event sink failed for tool %s", name)

        logger.warning(
            "tool_validation_failed tool=%s errors=%d rejected_params=%s",
            name,
            len(errors),
            event["rejected_parameters"],
        )

        try:
            metrics.record_tool_call(name, "error", 0.0)
        except Exception:
            pass

    async def execute(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        approved: bool = False,
    ) -> Any:
        if self.context is None:
            return await self._execute(name, arguments, approved=approved)
        # Bind this agent's dependencies for the whole call. The binding follows
        # the call across awaits, into tasks and worker threads it starts, and
        # is undone afterwards, so concurrent calls from other agents never see
        # it and this one never sees theirs.
        token = _context.bind(self.context)
        try:
            return await self._execute(name, arguments, approved=approved)
        finally:
            _context.reset(token)

    async def _execute(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        approved: bool = False,
    ) -> Any:
        tool = self._tools.get(name)
        if not tool:
            return {"error": f"Unknown tool: {name}"}

        # ── Parameter schema validation ─────────────────────────────
        # Validates decoded arguments against tool parameters JSON schema
        # before permissions, policy engine, or tool code run.
        validation_result = self.validate_arguments(tool, arguments)
        if not validation_result.is_valid:
            self._record_validation_event(
                name, validation_result.errors, arguments
            )
            return validation_result.to_error_dict(name)

        validated_arguments = validation_result.coerced_arguments

        # ── Permission manifest check ───────────────────────────────
        # Runs before the policy engine: a tool that is not permitted to touch
        # a resource should never reach the rules that reason about how it
        # touches it. Unlike the policy check below, a failure here is not
        # swallowed — an enforcer that cannot decide must not default to allow.
        decision = self._enforcer.check(name, validated_arguments, approved=approved)
        if not decision.allowed:
            return {
                "error": decision.reason,
                "code": decision.code,
                "tool": name,
                "capability": decision.capability,
                "requires_approval": decision.requires_approval,
            }

        # ── Policy engine pre-check (when enabled) ──────────────────
        if self._middleware is not None:
            try:
                from talos_agent.policy.middleware import (
                    _GATED_ACTIONS,
                )
                if name in _GATED_ACTIONS:
                    result = self._middleware.evaluate_action(
                        name, validated_arguments
                    )
                    if result.decision.value == "deny":
                        return {
                            "error": "Policy denied this action",
                            "policy_decision": "deny",
                            "evidence": list(result.evidence),
                            "result_digest": result.result_digest,
                        }
                    if result.decision.value == "escalate":
                        return {
                            "status": "policy_escalation_required",
                            "policy_decision": "escalate",
                            "evidence": list(result.evidence),
                            "result_digest": result.result_digest,
                            "message": (
                                "This action requires approval. "
                                "Use request_approval to escalate to a human operator."
                            ),
                        }
            except Exception:
                pass  # policy check failure must not block tool execution
        # ─────────────────────────────────────────────────────────────

        start = time.monotonic()
        outcome = "success"
        try:
            with traced_span(
                f"tool.{name}",
                {
                    "tool.name": name,
                    "tool.arg_keys": list(validated_arguments.keys()),
                },
            ):
                async def _invoke_tool() -> Any:
                    try:
                        if inspect.iscoroutinefunction(tool.fn):
                            result = await tool.fn(**validated_arguments)
                        else:
                            result = await asyncio.to_thread(
                                tool.fn, **validated_arguments
                            )
                        if inspect.isawaitable(result):
                            result = await result
                        return result
                    except asyncio.TimeoutError as exc:
                        raise _ToolTimeoutError(str(exc)) from exc

                result = await asyncio.wait_for(
                    _invoke_tool(), timeout=tool.timeout
                )
                return result
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        except ToolTimeoutError:
            outcome = "timeout"
            raise
        except Exception as e:
            outcome = "error"
            return {"error": f"{type(e).__name__}: {e}"}
        finally:
            metrics.record_tool_call(name, outcome, time.monotonic() - start)


# Global registry instance
registry = ToolRegistry()


def tool(name: str, description: str, permissions: ToolPermissions | None = None, timeout: float | None = None):
    """Decorator to register a function as an agent tool.

    Usage:
        @tool(
            "search_web",
            "Search Google and return top results",
            permissions=ToolPermissions(
                network=(NetworkScope.BROWSER,),
                hosts=("*.google.com",),
            ),
        )
        async def search_web(query: str) -> dict:
            ...

    Omitting ``permissions`` falls back to the legacy manifest table keyed by
    tool name. New tools must declare theirs — an undeclared tool with no
    legacy entry is denied once enforcement is switched on.
    """
    def decorator(fn: Callable) -> Callable:
        params = _fn_to_json_schema(fn)
        registry.register(name, description, fn, params, permissions, timeout)
        return fn
    return decorator


# Type mapping for JSON schema
_TYPE_MAP = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


def _resolve_json_type(hint: Any) -> dict[str, Any]:
    """Return a JSON Schema fragment for a single (non-Optional) type hint.

    Handles:
    - Primitives mapped through ``_TYPE_MAP``
    - ``list[T]`` / ``tuple[T, ...]`` → ``{"type": "array", "items": ...}``
    - ``dict[K, V]`` → ``{"type": "object"}``
    - Anything unrecognised → ``{"type": "string"}``
    """
    import types as _types
    import typing as _typing

    origin = _typing.get_origin(hint)

    # list[T] or tuple[T, ...]
    if origin in (list, tuple):
        args = _typing.get_args(hint)
        prop: dict[str, Any] = {"type": "array"}
        if args:
            item_hint = args[0]
            if item_hint is not Ellipsis:
                prop["items"] = _resolve_json_type(item_hint)
        return prop

    # dict[K, V]
    if origin is dict:
        return {"type": "object"}

    # Bare primitive or other concrete type; try origin first for generics
    lookup = origin if origin in _TYPE_MAP else hint
    json_type = _TYPE_MAP.get(lookup, "string")
    return {"type": json_type}


def _unwrap_optional(hint: Any) -> tuple[Any, bool]:
    """Return ``(inner_hint, is_optional)``.

    Handles both ``typing.Optional[T]`` (``__origin__ is Union``) and the
    PEP 604 ``T | None`` syntax (``types.UnionType``, Python ≥ 3.10).
    """
    import types as _types
    import typing as _typing

    # PEP 604: float | None  →  types.UnionType
    if isinstance(hint, _types.UnionType):
        args = _typing.get_args(hint)
        non_none = [a for a in args if a is not type(None)]
        is_optional = type(None) in args
        if len(non_none) == 1:
            return non_none[0], is_optional
        # Multi-type non-None union: fall back to string
        return str, is_optional

    # typing.Optional[T]  →  typing.Union[T, None]
    origin = _typing.get_origin(hint)
    if origin is _typing.Union:
        args = _typing.get_args(hint)
        non_none = [a for a in args if a is not type(None)]
        is_optional = type(None) in args
        if len(non_none) == 1:
            return non_none[0], is_optional
        return str, is_optional

    return hint, False


def _fn_to_json_schema(fn: Callable) -> dict:
    """Extract JSON Schema parameters from function signature + type hints.

    Correctly handles:
    - ``typing.Optional[T]`` (``Union[T, None]``)
    - PEP 604 ``T | None`` unions (``types.UnionType``, Python ≥ 3.10)
    - ``list[T]`` / ``tuple[T, ...]`` → ``{"type": "array", "items": ...}``
    - ``dict`` → ``{"type": "object"}``
    - Bare primitives via ``_TYPE_MAP``
    """
    try:
        hints = get_type_hints(fn)
    except Exception:
        hints = getattr(fn, "__annotations__", {})
    sig = inspect.signature(fn)
    properties: dict[str, Any] = {}
    required: list[str] = []

    for param_name, param in sig.parameters.items():
        if param_name in ("self", "cls"):
            continue
        hint = hints.get(param_name, str)

        # Unwrap Optional / PEP 604 union, detect is_optional
        hint, is_optional = _unwrap_optional(hint)

        prop = _resolve_json_type(hint)

        # Preserve explicit non-None defaults in the schema
        if param.default is not inspect.Parameter.empty and param.default is not None:
            prop["default"] = param.default

        properties[param_name] = prop
        if not is_optional and param.default is inspect.Parameter.empty:
            required.append(param_name)

    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


def build_all_tools(
    api: Any,
    db: Any,
    browser: Any,
    settings: Settings,
    policy_middleware: Any = None,
    job_effect_store: Any = None,
    job_effect_dispatcher: Any = None,
    context: ToolContext | None = None,
) -> ToolRegistry:
    """Build one agent's tools from its own dependencies.

    Imports the tool modules (which registers every ``@tool``) and returns a
    registry that belongs to this agent alone: its own :class:`ToolContext`,
    policy middleware and permission enforcer. Several agents can therefore
    build and run tools in one process without sharing any of them.

    ``context`` is for rebuilding an agent's tools, for example after its
    browser restarts: pass the registry's existing ``context`` and it is
    updated in place, so tasks the agent already started pick up the new
    dependencies instead of keeping stale ones.

    The tool modules' own globals are still filled in, as before. They are the
    defaults for code that calls a tool directly with no context bound.
    """
    # Import modules so decorators execute
    from talos_agent.tools import browser as _browser_mod  # noqa: F401
    from talos_agent.tools import commerce as _commerce_mod  # noqa: F401
    from talos_agent.tools import stellar as _stellar_mod  # noqa: F401
    from talos_agent.tools import internal as _internal_mod  # noqa: F401
    from talos_agent.tools import learning as _learning_mod  # noqa: F401
    from talos_agent.tools import web_api as _web_api_mod  # noqa: F401
    from talos_agent.tools import publishing as _publishing_mod  # noqa: F401
    from talos_agent.tools import defi as _defi_mod  # noqa: F401
    from talos_agent.tools import planning as _planning_mod  # noqa: F401
    from talos_agent.tools import a2a_composition as _a2a_composition_mod  # noqa: F401
    from talos_agent.tools import budget as _budget_mod  # noqa: F401

    # Build the channel adapter registry with all configured adapters
    from talos_agent.adapters.capability import (
        AdapterResourceLimits,
        AdapterSandbox,
        default_manifests,
        load_manifests,
    )
    from talos_agent.adapters.discord import DiscordAdapter, DiscordAdapterConfig
    from talos_agent.adapters.mastodon import MastodonAdapter, MastodonAdapterConfig
    from talos_agent.adapters.registry import AdapterRegistry
    from talos_agent.adapters.telegram import TelegramAdapter, TelegramAdapterConfig
    from talos_agent.adapters.telegram_queue import TelegramQueueConfig, TelegramSendQueue
    from talos_agent.adapters.x import XAdapter, XAdapterConfig

    if settings.adapter_sandbox_enabled:
        limits = AdapterResourceLimits(
            timeout_seconds=settings.adapter_timeout_seconds,
            max_concurrency=settings.adapter_max_concurrency,
            max_input_bytes=settings.adapter_max_input_bytes,
            max_output_bytes=settings.adapter_max_output_bytes,
            max_network_requests=settings.adapter_max_network_requests,
            invocation_lease_seconds=settings.adapter_invocation_lease_seconds,
            max_invocation_records=settings.adapter_max_invocation_records,
        )
        manifests = load_manifests(
            settings.adapter_capability_manifests,
            defaults=default_manifests(limits),
        )
        sandbox = AdapterSandbox(
            manifests=manifests,
            db=db,
            secret_resolver=settings.secret_value,
            retry_configs=settings.adapter_retry_configs,
        )
        adapter_registry = AdapterRegistry(sandbox)
        adapter_registry.register(
            XAdapter(
                sandbox.browser("x", browser),
                XAdapterConfig(username=settings.x_username, email=settings.x_email),
                secrets=sandbox.secrets("x"),
            )
        )
        if (
            resolve_setting_secret(settings, "discord_webhook_url")
            or resolve_setting_secret(settings, "discord_bot_token")
        ):
            adapter_registry.register(
                DiscordAdapter(
                    DiscordAdapterConfig(
                        channel_id=settings.discord_channel_id,
                        guild_id=settings.discord_guild_id,
                    ),
                    secrets=sandbox.secrets("discord"),
                    http=sandbox.http("discord"),
                )
            )
        if (
            resolve_setting_secret(settings, "telegram_bot_token")
            and settings.telegram_chat_id
        ):
            adapter_registry.register(
                TelegramAdapter(
                    TelegramAdapterConfig(chat_id=settings.telegram_chat_id),
                    secrets=sandbox.secrets("telegram"),
                    http=sandbox.http("telegram"),
                    queue=(
                        TelegramSendQueue(db, TelegramQueueConfig.from_settings(settings))
                        if settings.telegram_rate_limit_enabled
                        else None
                    ),
                )
            )
        mastodon_config = (getattr(settings, "channel_configs", {}) or {}).get("mastodon", {})
        if (
            resolve_setting_secret(settings, "mastodon_access_token")
            and mastodon_config.get("instance_url", "")
        ):
            adapter_registry.register(
                MastodonAdapter(
                    MastodonAdapterConfig(
                        instance_url=mastodon_config["instance_url"],
                    ),
                    secrets=sandbox.secrets("mastodon"),
                    http=sandbox.http("mastodon"),
                )
            )
    else:
        adapter_registry = AdapterRegistry()
        adapter_registry.register(XAdapter(browser, settings))
        if (
            resolve_setting_secret(settings, "discord_webhook_url")
            or resolve_setting_secret(settings, "discord_bot_token")
        ):
            adapter_registry.register(DiscordAdapter(settings))
        mastodon_config = (getattr(settings, "channel_configs", {}) or {}).get("mastodon", {})
        if (
            resolve_setting_secret(settings, "mastodon_access_token")
            and mastodon_config.get("instance_url", "")
        ):
            adapter_registry.register(MastodonAdapter(settings))

    # This agent's dependencies. Tools run through the registry returned below
    # read these, never the module globals, so another agent building its tools
    # cannot redirect this agent's calls.
    if context is None:
        context = ToolContext()
    context.update(
        api=api,
        db=db,
        browser=browser,
        settings=settings,
        adapter_registry=adapter_registry,
        job_effect_store=job_effect_store,
        job_effect_dispatcher=job_effect_dispatcher,
    )

    # Defaults for direct callers (and for a single agent set up the old way):
    # the module globals. The last agent to build wins here, which is why agents
    # must go through their own registry rather than rely on these.
    _internal_mod._db = db
    _internal_mod._settings = settings
    _web_api_mod._api = api
    _web_api_mod._settings = settings
    _browser_mod._browser = browser
    _browser_mod._settings = settings
    _browser_mod._adapter_registry = adapter_registry
    _commerce_mod._api = api
    _commerce_mod._db = db
    _commerce_mod._settings = settings
    _commerce_mod._job_effect_store = job_effect_store
    _commerce_mod._job_effect_dispatcher = job_effect_dispatcher
    _stellar_mod._settings = settings
    _stellar_mod._api = api
    _learning_mod._db = db
    _learning_mod._settings = settings
    _publishing_mod._adapter_registry = adapter_registry
    _publishing_mod.set_publish_timeout(settings.publish_timeout_seconds)
    _defi_mod._api = api
    _defi_mod._db = db
    _defi_mod._settings = settings
    _planning_mod._api = api
    _planning_mod._db = db
    _planning_mod._settings = settings
    _a2a_composition_mod._api = api
    _a2a_composition_mod._db = db
    _a2a_composition_mod._settings = settings
    _budget_mod._db = db
    _budget_mod._settings = settings

    # The registry this agent runs its tools through. The shared module-level
    # `registry` only collects the @tool registrations; policy and permissions
    # are configured per agent so one agent's settings never govern another's.
    agent_registry = registry.for_agent(context)

    # Inject policy middleware into the registry for pre-execution checks
    if policy_middleware is not None:
        agent_registry.set_middleware(policy_middleware)

    # Resolve permission manifests against the operator's grants. Every tool
    # has already registered by this point, so this re-validates the full set.
    agent_registry.set_permission_enforcer(build_enforcer(settings))

    return agent_registry


def build_enforcer(settings: Settings) -> PermissionEnforcer:
    """Construct the permission enforcer from settings.

    Backward compatible by default: an unconfigured deployment runs in AUDIT
    mode with the legacy grant set, which allows exactly what it allowed before
    manifests existed while recording every decision.
    """
    try:
        mode = EnforcementMode(settings.tool_permission_mode)
    except ValueError:
        mode = EnforcementMode.AUDIT

    grants = (
        PermissionGrants.from_mapping(settings.tool_permission_grants)
        if settings.tool_permission_grants
        else _legacy_grants()
    )

    return PermissionEnforcer(grants=grants, mode=mode)


def _legacy_grants() -> PermissionGrants:
    from talos_agent.tools.permissions import LEGACY_GRANTS

    return LEGACY_GRANTS
