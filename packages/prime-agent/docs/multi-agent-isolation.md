# Multi-agent isolation

`run_multi` runs several agents in one process. Each agent has its own API
client, local database, browser session, settings, adapters, policy engine and
permission enforcer, and none of them may ever act with another agent's. This
page describes how tools get their dependencies so that holds, and what to do
when you write a tool.

## How an agent's tools are built

`build_all_tools(api, db, browser, settings, ...)` returns a `ToolRegistry`
that belongs to that agent alone. It owns:

- a `ToolContext` (`talos_agent.tools.context`): the agent's API client,
  database, browser, settings, adapter registry, job-effect store and
  dispatcher, plus the helpers it creates on first use (the x402 signer, the
  Stellar kit) and the map of jobs it holds leases on;
- the agent's policy middleware (`policy_middleware=`);
- the agent's permission enforcer, built from the agent's own
  `tool_permission_mode` and `tool_permission_grants`.

The tool functions themselves are shared. They are the same code for every
agent, so the registry binds the agent's context for the length of every
`execute` call, and a tool reads its dependencies from whichever context is
bound when it runs.

The binding is a `contextvars.ContextVar`. It follows a call across `await`
points, into tasks the call starts and into the worker thread a synchronous tool
runs in, and it is undone when the call returns, including when it raises. Two
agents calling tools at the same moment each see their own.

## Writing a tool

Read dependencies through `_deps()`, never from a module global:

```python
from talos_agent.tools import context as _context
from talos_agent.tools.registry import tool

# Defaults for code that calls a tool directly with no context bound.
_api = None
_settings = None


def _deps():
    return _context.resolve(globals())


@tool("report_activity", "Report an activity to the Talos Web dashboard")
async def report_activity(type: str, content: str, channel: str) -> dict:
    deps = _deps()
    result = await deps.api.report_activity(
        deps.settings.talos_id, type_=type, content=content, channel=channel
    )
    return result or {"status": "reported"}
```

Do not capture `_deps().api` (or any other dependency) in a module-level
variable, a default argument or a long-lived object: it would be one agent's
object served to every agent. Read it inside the function that uses it.

State a tool keeps between calls belongs on the context (`deps.signer`,
`deps.stellar_kit`, `deps.claimed_jobs`), not in a module-level variable, for the
same reason.

## Code that runs outside a tool call

Tasks that reach into the tool modules without going through the registry (the
scheduler's heartbeat, polling and queue tasks, shutdown cleanup) rely on the
context being bound to their task. `scheduler.run()` binds its agent's context
right after building the tools, before it starts any task, and a task inherits
the binding of the task that created it.

## Rebuilding an agent's tools

When an agent rebuilds its tools, for example after its browser restarts, pass
the registry's existing context so it is updated in place:

```python
tools = build_all_tools(api=api, db=db, browser=new_browser, settings=settings,
                        context=tools.context)
```

Tasks the agent already started hold the same context object, so they pick up
the new browser and adapters. State the agent has accumulated, such as its
claimed jobs, is kept.

## When no context is bound

A tool called directly with no context bound (the unit tests do this) reads the
tool module's own globals, as it always did. `build_all_tools` still fills those
globals as defaults, but the last agent to build wins there, so an agent must go
through its own registry and never rely on them.

## What the tests check

`tests/test_multi_agent_isolation.py` builds two agents with different settings,
approval thresholds, databases, API clients and browsers, runs their tools
concurrently with forced interleaving, and asserts that every call used its own
agent's dependencies and that spending, loans, activity and claimed jobs ended up
in the right place. It also checks that one agent's policy middleware and
permission enforcer do not govern another, that rebuilding updates a context in
place, and that a context is always unbound after a call.
