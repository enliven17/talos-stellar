"""Tool registry — @tool decorator → OpenAI function schemas + dispatcher."""

from __future__ import annotations

import inspect
import json
from dataclasses import dataclass, field
from typing import Any, Callable, get_type_hints

from talos_agent.config import Settings


@dataclass
class Tool:
    name: str
    description: str
    fn: Callable
    parameters: dict[str, Any]

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

    def __len__(self) -> int:
        return len(self._tools)

    def register(self, name: str, description: str, fn: Callable, parameters: dict[str, Any]) -> None:
        self._tools[name] = Tool(name=name, description=description, fn=fn, parameters=parameters)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all_tools(self) -> list[Tool]:
        return list(self._tools.values())

    def openai_schemas(self) -> list[dict]:
        return [t.to_openai_schema() for t in self._tools.values()]

    async def execute(self, name: str, arguments: dict[str, Any]) -> Any:
        tool = self._tools.get(name)
        if not tool:
            return {"error": f"Unknown tool: {name}"}
        try:
            result = tool.fn(**arguments)
            if inspect.isawaitable(result):
                result = await result
            return result
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}


# Global registry instance
registry = ToolRegistry()


def tool(name: str, description: str):
    """Decorator to register a function as an agent tool.

    Usage:
        @tool("search_web", "Search Google and return top results")
        async def search_web(query: str) -> dict:
            ...
    """
    def decorator(fn: Callable) -> Callable:
        params = _fn_to_json_schema(fn)
        registry.register(name, description, fn, params)
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
) -> ToolRegistry:
    """Import all tool modules to trigger @tool registrations, then return registry."""
    # Import modules so decorators execute
    from talos_agent.tools import browser as _browser_mod  # noqa: F401
    from talos_agent.tools import commerce as _commerce_mod  # noqa: F401
    from talos_agent.tools import stellar as _stellar_mod  # noqa: F401
    from talos_agent.tools import internal as _internal_mod  # noqa: F401
    from talos_agent.tools import learning as _learning_mod  # noqa: F401
    from talos_agent.tools import web_api as _web_api_mod  # noqa: F401

    # Inject dependencies into tool modules
    _internal_mod._db = db
    _web_api_mod._api = api
    _web_api_mod._settings = settings
    _browser_mod._browser = browser
    _browser_mod._settings = settings
    _commerce_mod._api = api
    _commerce_mod._db = db
    _commerce_mod._settings = settings
    _stellar_mod._settings = settings
    _stellar_mod._api = api
    _learning_mod._db = db
    _learning_mod._settings = settings

    return registry
