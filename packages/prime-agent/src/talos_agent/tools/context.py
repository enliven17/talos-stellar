"""Per-agent dependencies for tools.

Tools reach the world through a few dependencies: the Talos API client, the
local database, the browser session, the settings, the adapter registry and a
handful of lazily created helpers. ``build_all_tools`` used to publish them as
module-level globals in each tool module, so two agents sharing a process (as
``run_multi`` does) overwrote each other's: whichever agent built its tools
last supplied the API client, database and settings for every agent's calls.

A :class:`ToolContext` holds one agent's dependencies instead. The registry
that ``build_all_tools`` returns owns its context and binds it for the length
of every tool call, so a tool always reads the dependencies of the agent that
called it. The binding is a :mod:`contextvars` variable, so it follows the
call across ``await`` points, into tasks it creates, and into worker threads,
and concurrent calls from different agents each see their own.

Tool modules read their dependencies through :func:`resolve`. When no context
is bound (a tool called directly, as the unit tests do, or a single agent set
up the old way) it returns a view over the module's own globals, so those
callers behave exactly as before.
"""

from __future__ import annotations

import asyncio
import contextvars
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator, MutableMapping


@dataclass(eq=False)
class ToolContext:
    """The dependencies one agent's tools run with.

    ``eq=False`` keeps identity semantics: a context is one agent's, never
    equal to another's because their fields happen to match.
    """

    api: Any = None
    db: Any = None
    browser: Any = None
    settings: Any = None
    adapter_registry: Any = None
    job_effect_store: Any = None
    job_effect_dispatcher: Any = None

    # Helpers created on first use, per agent. ``signer`` and ``stellar_kit``
    # are built from this agent's API client; the claimed-job map and its lock
    # are this agent's view of the jobs it holds leases on.
    signer: Any = None
    stellar_kit: Any = None
    claimed_jobs: dict[str, int] = field(default_factory=dict)
    claimed_jobs_lock: asyncio.Lock | None = None

    def update(
        self,
        *,
        api: Any,
        db: Any,
        browser: Any,
        settings: Any,
        adapter_registry: Any,
        job_effect_store: Any = None,
        job_effect_dispatcher: Any = None,
    ) -> None:
        """Replace the injected dependencies in place.

        Used when an agent rebuilds its tools (for example after the browser
        is restarted). Tasks the agent already started hold this same object,
        so updating it in place means they pick up the new browser and
        adapters, as they did when these were module globals. State the agent
        accumulates, such as its claimed jobs, is kept.
        """
        self.api = api
        self.db = db
        self.browser = browser
        self.settings = settings
        self.adapter_registry = adapter_registry
        self.job_effect_store = job_effect_store
        self.job_effect_dispatcher = job_effect_dispatcher


_current: contextvars.ContextVar[ToolContext | None] = contextvars.ContextVar(
    "talos_tool_context", default=None
)


def current() -> ToolContext | None:
    """The context bound to the running task, if any."""
    return _current.get()


def bind(context: ToolContext | None) -> contextvars.Token:
    """Bind ``context`` to the running task. Undo with :func:`reset`."""
    return _current.set(context)


def reset(token: contextvars.Token) -> None:
    """Undo a :func:`bind`."""
    _current.reset(token)


@contextmanager
def use(context: ToolContext | None) -> Iterator[None]:
    """Bind ``context`` for the length of a ``with`` block."""
    token = _current.set(context)
    try:
        yield
    finally:
        _current.reset(token)


# The module global each field was published under before contexts existed.
_LEGACY_GLOBAL = {
    "api": "_api",
    "db": "_db",
    "browser": "_browser",
    "settings": "_settings",
    "adapter_registry": "_adapter_registry",
    "job_effect_store": "_job_effect_store",
    "job_effect_dispatcher": "_job_effect_dispatcher",
    "signer": "_signer",
    "stellar_kit": "_stellar_kit",
    "claimed_jobs": "_claimed_jobs",
    "claimed_jobs_lock": "_claimed_jobs_lock",
}


class _ModuleDeps:
    """A tool module's own globals, presented like a :class:`ToolContext`.

    This is what :func:`resolve` returns when no context is bound, so code that
    sets ``talos_agent.tools.commerce._api`` directly (the unit tests) or that
    relies on ``build_all_tools`` filling the module globals keeps working.
    """

    __slots__ = ("_module_globals",)

    def __init__(self, module_globals: MutableMapping[str, Any]) -> None:
        object.__setattr__(self, "_module_globals", module_globals)

    def __getattr__(self, name: str) -> Any:
        try:
            return self._module_globals[_LEGACY_GLOBAL[name]]
        except KeyError:
            raise AttributeError(name) from None

    def __setattr__(self, name: str, value: Any) -> None:
        try:
            key = _LEGACY_GLOBAL[name]
        except KeyError:
            raise AttributeError(name) from None
        self._module_globals[key] = value


def resolve(module_globals: MutableMapping[str, Any]) -> ToolContext | _ModuleDeps:
    """The dependencies for the code running now.

    ``module_globals`` is the calling tool module's ``globals()``. If a context
    is bound the call belongs to an agent and gets that agent's dependencies;
    otherwise the module's own globals are used.
    """
    context = _current.get()
    return context if context is not None else _ModuleDeps(module_globals)
