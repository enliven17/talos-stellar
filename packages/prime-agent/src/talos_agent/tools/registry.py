"""Tool registry — @tool decorator → OpenAI function schemas + dispatcher."""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Callable, get_type_hints

from talos_agent.config import Settings
from talos_agent.tools.permissions import (
    EnforcementMode,
    PermissionEnforcer,
    PermissionGrants,
    ToolPermissions,
)


@dataclass
class Tool:
    name: str
    description: str
    fn: Callable
    parameters: dict[str, Any]
    #: Declared permission surface. `None` means the tool did not declare one
    #: and the enforcer resolved it from the legacy table (or denied it).
    permissions: ToolPermissions | None = None

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
    _middleware: Any = None  # PolicyMiddleware, injected by build_all_tools
    # Permission manifests are validated here at registration and enforced in
    # execute(). Defaults to AUDIT with no grants: every call is evaluated and
    # recorded, none are blocked, so enabling this module changes no behaviour
    # until an operator opts into ENFORCE.
    _enforcer: PermissionEnforcer = field(default_factory=PermissionEnforcer)

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
    ) -> None:
        # Raises ManifestValidationError for a declared-but-unenforceable
        # manifest, so the problem surfaces at import rather than first call.
        self._enforcer.register(name, permissions)
        self._tools[name] = Tool(
            name=name,
            description=description,
            fn=fn,
            parameters=parameters,
            permissions=permissions,
        )

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all_tools(self) -> list[Tool]:
        return list(self._tools.values())

    def openai_schemas(self) -> list[dict]:
        return [t.to_openai_schema() for t in self._tools.values()]

    async def execute(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        approved: bool = False,
    ) -> Any:
        tool = self._tools.get(name)
        if not tool:
            return {"error": f"Unknown tool: {name}"}

        # ── Permission manifest check ───────────────────────────────
        # Runs before the policy engine: a tool that is not permitted to touch
        # a resource should never reach the rules that reason about how it
        # touches it. Unlike the policy check below, a failure here is not
        # swallowed — an enforcer that cannot decide must not default to allow.
        decision = self._enforcer.check(name, arguments, approved=approved)
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
                    result = self._middleware.evaluate_action(name, arguments)
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

        try:
            result = tool.fn(**arguments)
            if inspect.isawaitable(result):
                result = await result
            return result
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}


# Global registry instance
registry = ToolRegistry()


def tool(name: str, description: str, permissions: ToolPermissions | None = None):
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
        registry.register(name, description, fn, params, permissions)
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


def _fn_to_json_schema(fn: Callable) -> dict:
    """Extract JSON Schema parameters from function signature + type hints."""
    hints = get_type_hints(fn)
    sig = inspect.signature(fn)
    properties: dict[str, Any] = {}
    required: list[str] = []

    for param_name, param in sig.parameters.items():
        if param_name in ("self", "cls"):
            continue
        hint = hints.get(param_name, str)
        # Unwrap Optional
        origin = getattr(hint, "__origin__", None)
        if origin is type(None):
            continue
        is_optional = False
        if origin is not None and hasattr(hint, "__args__"):
            args = hint.__args__
            if type(None) in args:
                is_optional = True
                hint = next(a for a in args if a is not type(None))

        json_type = _TYPE_MAP.get(hint, "string")
        prop: dict[str, Any] = {"type": json_type}

        # Use default as description hint
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
) -> ToolRegistry:
    """Import all tool modules to trigger @tool registrations, then return registry."""
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

    # Build the channel adapter registry with all configured adapters
    from talos_agent.adapters.registry import AdapterRegistry
    from talos_agent.adapters.x import XAdapter
    from talos_agent.adapters.discord import DiscordAdapter

    adapter_registry = AdapterRegistry()
    adapter_registry.register(XAdapter(browser, settings))
    if settings.discord_webhook_url or settings.discord_bot_token:
        adapter_registry.register(DiscordAdapter(settings))

    # Inject dependencies into tool modules
    _internal_mod._db = db
    _web_api_mod._api = api
    _web_api_mod._settings = settings
    _browser_mod._browser = browser
    _browser_mod._settings = settings
    _browser_mod._adapter_registry = adapter_registry
    _commerce_mod._api = api
    _commerce_mod._db = db
    _commerce_mod._settings = settings
    _stellar_mod._settings = settings
    _stellar_mod._api = api
    _learning_mod._db = db
    _learning_mod._settings = settings
    _publishing_mod._adapter_registry = adapter_registry
    _defi_mod._api = api
    _defi_mod._db = db
    _defi_mod._settings = settings
    _planning_mod._api = api
    _planning_mod._db = db
    _planning_mod._settings = settings

    # Inject policy middleware into the registry for pre-execution checks
    if policy_middleware is not None:
        registry.set_middleware(policy_middleware)

    # Resolve permission manifests against the operator's grants. Every tool
    # has already registered by this point, so this re-validates the full set.
    registry.set_permission_enforcer(build_enforcer(settings))

    return registry


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
