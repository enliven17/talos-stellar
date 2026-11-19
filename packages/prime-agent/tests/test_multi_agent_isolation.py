"""Agents that share a process must not share state (issue #1019).

``run_multi`` starts several agents in one process. Each builds its own tools
with ``build_all_tools`` from its own API client, database, browser and
settings, and each must only ever act with those. These tests start two agents
whose dependencies are visibly different, drive their tools concurrently with
forced interleaving, and assert that every call used its own agent's API
client, database and settings, that spending, loans and activity landed in the
right place, and that the registry-level state an agent configures (its policy
middleware and permission enforcer) and the helpers it keeps (claimed jobs,
signer, browser) belong to it alone.

Nothing here uses a network, a real LLM or a real browser: the API clients are
recording fakes and the databases are real SQLite files in a temp directory.
"""

from __future__ import annotations

import asyncio
import inspect
import re
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from talos_agent import scheduler
from talos_agent.config import Settings
from talos_agent.db import LocalDB
from talos_agent.tools import (
    a2a_composition,
    commerce,
    defi,
    internal,
    learning,
    planning,
    publishing,
    web_api,
)
from talos_agent.tools import browser as browser_tools
from talos_agent.tools import context as tool_context
from talos_agent.tools import stellar as stellar_tools
from talos_agent.tools.permissions import EnforcementMode
from talos_agent.tools.registry import ToolRegistry, build_all_tools
from talos_agent.tools.registry import registry as shared_registry


_TOOL_MODULES = (
    a2a_composition,
    browser_tools,
    commerce,
    defi,
    internal,
    learning,
    planning,
    publishing,
    stellar_tools,
    web_api,
)
_MODULE_GLOBALS = (
    "_api",
    "_db",
    "_browser",
    "_settings",
    "_adapter_registry",
    "_job_effect_store",
    "_job_effect_dispatcher",
    "_signer",
    "_stellar_kit",
    "_claimed_jobs",
    "_claimed_jobs_lock",
)


@pytest.fixture(autouse=True)
def _restore_tool_module_globals():
    """``build_all_tools`` still fills the tool modules' own globals (the
    defaults for direct callers). Put them back after each test so building
    agents here cannot leak into other test files."""
    saved = {
        (module, name): getattr(module, name)
        for module in _TOOL_MODULES
        for name in _MODULE_GLOBALS
        if hasattr(module, name)
    }
    yield
    for (module, name), value in saved.items():
        setattr(module, name, value)


class RecordingAPI:
    """A fake Talos API client that remembers who called it with what.

    Every method yields to the event loop first, so calls from different agents
    are guaranteed to interleave rather than running one after the other.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def create_approval(self, talos_id: str, **kwargs: Any) -> dict:
        await asyncio.sleep(0)
        self.calls.append(("create_approval", talos_id, kwargs))
        return {"id": f"{self.name}-approval-{len(self.calls)}"}

    async def report_activity(self, talos_id: str, **kwargs: Any) -> dict:
        await asyncio.sleep(0)
        self.calls.append(("report_activity", talos_id, kwargs))
        return {"status": "reported", "by": self.name}

    async def report_revenue(self, talos_id: str, **kwargs: Any) -> dict:
        await asyncio.sleep(0)
        self.calls.append(("report_revenue", talos_id, kwargs))
        return {"status": "reported", "by": self.name}


class FakeBrowser:
    """Stands in for a browser session; records whether it was closed."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.closed = False

    async def close(self) -> dict:
        await asyncio.sleep(0)
        self.closed = True
        return {"status": "closed", "by": self.name}


@dataclass
class Agent:
    name: str
    talos_id: str
    settings: Settings
    db: LocalDB
    api: RecordingAPI
    browser: FakeBrowser
    tools: ToolRegistry = field(default=None)  # type: ignore[assignment]

    def calls(self, method: str) -> list[tuple[str, str, dict[str, Any]]]:
        return [c for c in self.api.calls if c[0] == method]


def make_agent(
    tmp_path: Path,
    name: str,
    *,
    threshold: str,
    permission_mode: str = "audit",
    policy_middleware: Any = None,
) -> Agent:
    settings = Settings(
        talos_api_url=f"http://{name}.test.local",
        talos_api_key=f"cpk_{name}_key",
        talos_id=f"talos-{name}",
        openai_api_key="sk-test",
        approval_threshold=Decimal(threshold),
        tool_permission_mode=permission_mode,
    )
    agent = Agent(
        name=name,
        talos_id=f"talos-{name}",
        settings=settings,
        db=LocalDB(path=tmp_path / f"{name}.db"),
        api=RecordingAPI(name),
        browser=FakeBrowser(name),
    )
    agent.tools = build_all_tools(
        api=agent.api,
        db=agent.db,
        browser=agent.browser,
        settings=agent.settings,
        policy_middleware=policy_middleware,
    )
    return agent


@pytest.fixture(params=["a-then-b", "b-then-a"])
def agents(request: pytest.FixtureRequest, tmp_path: Path) -> tuple[Agent, Agent]:
    """Two agents with different settings, in either start-up order.

    Agent A asks for approval above 10 USD; agent B only above 1000, so the same
    50 USD loan is gated for A and goes straight through for B. Whichever agent
    builds its tools last must not be able to take over the other's calls.
    """
    if request.param == "a-then-b":
        a = make_agent(tmp_path, "a", threshold="10")
        b = make_agent(tmp_path, "b", threshold="1000")
    else:
        b = make_agent(tmp_path, "b", threshold="1000")
        a = make_agent(tmp_path, "a", threshold="10")
    return a, b


def loan_rows(agent: Agent) -> list[dict]:
    return agent.db.get_active_loans()


# ── API clients ─────────────────────────────────────────────────────


async def test_concurrent_tool_calls_use_their_own_api_client(agents):
    a, b = agents

    await asyncio.gather(
        a.tools.execute("report_activity", {"type": "post", "content": "from-a", "channel": "x"}),
        b.tools.execute("report_activity", {"type": "post", "content": "from-b", "channel": "x"}),
        a.tools.execute("report_revenue", {"amount": 1.0, "source": "a-source"}),
        b.tools.execute("report_revenue", {"amount": 2.0, "source": "b-source"}),
    )

    # Each client saw exactly its own agent's two calls, under its own talos id.
    assert [(m, t) for m, t, _ in a.api.calls] == [
        ("report_activity", "talos-a"),
        ("report_revenue", "talos-a"),
    ]
    assert [(m, t) for m, t, _ in b.api.calls] == [
        ("report_activity", "talos-b"),
        ("report_revenue", "talos-b"),
    ]
    assert a.calls("report_activity")[0][2]["content"] == "from-a"
    assert b.calls("report_activity")[0][2]["content"] == "from-b"


async def test_a_tool_result_comes_from_the_calling_agents_client(agents):
    a, b = agents

    result_a, result_b = await asyncio.gather(
        a.tools.execute("report_activity", {"type": "post", "content": "x", "channel": "x"}),
        b.tools.execute("report_activity", {"type": "post", "content": "x", "channel": "x"}),
    )

    assert result_a == {"status": "reported", "by": "a"}
    assert result_b == {"status": "reported", "by": "b"}


# ── Settings ────────────────────────────────────────────────────────


async def test_each_agent_applies_its_own_approval_threshold(agents):
    a, b = agents

    loan = {"platform": "aave", "amount": 50.0}
    result_a, result_b = await asyncio.gather(
        a.tools.execute("request_defi_loan", {**loan, "purpose": "a-loan"}),
        b.tools.execute("request_defi_loan", {**loan, "purpose": "b-loan"}),
    )

    # 50 USD is above A's threshold of 10, so A must ask for approval...
    assert result_a["status"] == "approval_requested"
    assert result_a["approval_id"].startswith("a-approval-")
    # ...and below B's threshold of 1000, so B records the loan.
    assert result_b["status"] == "requested"


async def test_approval_requests_carry_the_calling_agents_talos_id(agents):
    a, b = agents

    await asyncio.gather(
        a.tools.execute("request_defi_loan", {"platform": "aave", "amount": 50.0, "purpose": "a-loan"}),
        a.tools.execute("request_approval", {"type": "transaction", "title": "a-approval"}),
        b.tools.execute("request_approval", {"type": "transaction", "title": "b-approval"}),
    )

    assert {talos_id for _, talos_id, _ in a.calls("create_approval")} == {"talos-a"}
    assert {talos_id for _, talos_id, _ in b.calls("create_approval")} == {"talos-b"}
    assert [kw["title"] for _, _, kw in b.calls("create_approval")] == ["b-approval"]


# ── Database writes and spending ────────────────────────────────────


async def test_loans_and_spending_are_recorded_in_the_calling_agents_database(agents):
    a, b = agents

    await asyncio.gather(
        b.tools.execute("request_defi_loan", {"platform": "aave", "amount": 50.0, "purpose": "b-loan"}),
        b.tools.execute("request_defi_loan", {"platform": "blend", "amount": 25.0, "purpose": "b-loan-2"}),
        a.tools.execute("request_defi_loan", {"platform": "aave", "amount": 5.0, "purpose": "a-loan"}),
    )

    # A's 5 USD loan is under its threshold of 10, so it is recorded in A's
    # database only; B's two loans are recorded in B's only.
    assert sorted(loan["purpose"] for loan in loan_rows(a)) == ["a-loan"]
    assert sorted(loan["purpose"] for loan in loan_rows(b)) == ["b-loan", "b-loan-2"]
    assert a.db.get_spending_today() == pytest.approx(5.0)
    assert b.db.get_spending_today() == pytest.approx(75.0)


async def test_reading_back_returns_only_the_calling_agents_rows(agents):
    a, b = agents
    await b.tools.execute("request_defi_loan", {"platform": "aave", "amount": 50.0, "purpose": "b-loan"})

    seen_by_a, seen_by_b = await asyncio.gather(
        a.tools.execute("get_active_loans", {}),
        b.tools.execute("get_active_loans", {}),
    )

    assert seen_by_a["count"] == 0
    assert seen_by_b["count"] == 1
    assert seen_by_b["loans"][0]["purpose"] == "b-loan"


# ── Sustained interleaving ──────────────────────────────────────────


async def test_many_interleaved_calls_never_cross_agents(agents):
    a, b = agents
    n = 25

    await asyncio.gather(
        *(
            call
            for i in range(n)
            for call in (
                a.tools.execute(
                    "report_activity", {"type": "post", "content": f"a-{i}", "channel": "x"}
                ),
                b.tools.execute(
                    "report_activity", {"type": "post", "content": f"b-{i}", "channel": "x"}
                ),
                b.tools.execute(
                    "request_defi_loan",
                    {"platform": "aave", "amount": 1.0, "purpose": f"b-{i}"},
                ),
                a.tools.execute(
                    "request_defi_loan",
                    {"platform": "aave", "amount": 1.0, "purpose": f"a-{i}"},
                ),
            )
        )
    )

    for agent in (a, b):
        contents = [kw["content"] for _, _, kw in agent.calls("report_activity")]
        assert sorted(contents) == sorted(f"{agent.name}-{i}" for i in range(n))
        assert {t for _, t, _ in agent.api.calls} == {agent.talos_id}
        purposes = [loan["purpose"] for loan in loan_rows(agent)]
        assert sorted(purposes) == sorted(f"{agent.name}-{i}" for i in range(n))
        assert agent.db.get_spending_today() == pytest.approx(float(n))


# ── Registry state: policy middleware and permission enforcer ───────


class DenyEverything:
    """A policy middleware that refuses every gated action it is asked about."""

    def __init__(self, label: str) -> None:
        self.label = label
        self.asked: list[str] = []

    def evaluate_action(self, action: str, params: dict | None = None, **_: Any) -> Any:
        self.asked.append(action)
        return SimpleNamespace(
            decision=SimpleNamespace(value="deny"),
            evidence=(f"denied-by-{self.label}",),
            result_digest=f"digest-{self.label}",
        )


async def test_each_agents_registry_is_its_own(agents):
    a, b = agents

    assert a.tools is not b.tools
    assert a.tools.context is not b.tools.context
    assert a.tools.context.settings is a.settings
    assert b.tools.context.settings is b.settings
    assert a.tools.context.api is a.api
    assert b.tools.context.db is b.db
    assert a.tools.context.browser is a.browser
    # Both start from the same tool definitions.
    assert {t.name for t in a.tools.all_tools()} == {t.name for t in b.tools.all_tools()}


async def test_one_agents_policy_middleware_does_not_govern_another(tmp_path):
    shared_middleware_before = shared_registry._middleware
    strict = DenyEverything("a")
    a = make_agent(tmp_path, "a", threshold="1000", policy_middleware=strict)
    b = make_agent(tmp_path, "b", threshold="1000")

    loan = {"platform": "aave", "amount": 1.0, "purpose": "x"}
    denied, allowed = await asyncio.gather(
        a.tools.execute("request_defi_loan", loan),
        b.tools.execute("request_defi_loan", loan),
    )

    assert denied["error"] == "Policy denied this action"
    assert denied["evidence"] == ["denied-by-a"]
    assert allowed["status"] == "requested"
    assert strict.asked == ["request_defi_loan"]
    # Nothing is left behind on the shared template either.
    assert shared_registry._middleware is shared_middleware_before
    assert loan_rows(a) == []
    assert len(loan_rows(b)) == 1


async def test_building_a_second_agent_does_not_replace_the_first_agents_policy(tmp_path):
    strict = DenyEverything("a")
    a = make_agent(tmp_path, "a", threshold="1000", policy_middleware=strict)
    make_agent(tmp_path, "b", threshold="1000")  # built after A, with no middleware

    result = await a.tools.execute(
        "request_defi_loan", {"platform": "aave", "amount": 1.0, "purpose": "x"}
    )

    assert result["error"] == "Policy denied this action"


async def test_each_agent_has_its_own_permission_enforcer_and_mode(tmp_path):
    shared_enforcer_before = shared_registry.permissions
    a = make_agent(tmp_path, "a", threshold="10", permission_mode="enforce")
    b = make_agent(tmp_path, "b", threshold="10", permission_mode="audit")

    assert a.tools.permissions is not b.tools.permissions
    assert a.tools.permissions.mode is EnforcementMode.ENFORCE
    assert b.tools.permissions.mode is EnforcementMode.AUDIT
    assert shared_registry.permissions is shared_enforcer_before


async def test_the_second_agents_permission_mode_does_not_overwrite_the_first(tmp_path):
    a = make_agent(tmp_path, "a", threshold="10", permission_mode="enforce")
    make_agent(tmp_path, "b", threshold="10", permission_mode="off")

    assert a.tools.permissions.mode is EnforcementMode.ENFORCE


# ── Helpers an agent keeps: claimed jobs, signer, stellar kit, browser ──


async def test_claimed_jobs_are_kept_per_agent(agents):
    a, b = agents

    with tool_context.use(a.tools.context):
        await commerce.set_claimed_job("job-a", 7)
    with tool_context.use(b.tools.context):
        await commerce.set_claimed_job("job-b", 9)

    with tool_context.use(a.tools.context):
        assert commerce.get_claimed_jobs_copy() == {"job-a": 7}
    with tool_context.use(b.tools.context):
        assert commerce.get_claimed_jobs_copy() == {"job-b": 9}
    # They are persisted to the claiming agent's own database as well.
    assert [row["job_id"] for row in a.db.get_all_claimed_jobs()] == ["job-a"]
    assert [row["job_id"] for row in b.db.get_all_claimed_jobs()] == ["job-b"]


async def test_removing_a_claimed_job_only_affects_the_calling_agent(agents):
    a, b = agents
    for agent in (a, b):
        with tool_context.use(agent.tools.context):
            await commerce.set_claimed_job("shared-id", 1)

    with tool_context.use(a.tools.context):
        await commerce.remove_claimed_job("shared-id")

    with tool_context.use(a.tools.context):
        assert commerce.get_claimed_jobs_copy() == {}
    with tool_context.use(b.tools.context):
        assert commerce.get_claimed_jobs_copy() == {"shared-id": 1}
    assert a.db.get_all_claimed_jobs() == []
    assert len(b.db.get_all_claimed_jobs()) == 1


async def test_concurrent_agent_tasks_each_claim_into_their_own_state(agents):
    a, b = agents

    async def agent_task(agent: Agent) -> dict[str, int]:
        # What the scheduler does: bind the agent's context to its task, then
        # start the work. A claim made after a suspension must still be the
        # agent's own.
        tool_context.bind(agent.tools.context)
        for i in range(10):
            await asyncio.sleep(0)
            await commerce.set_claimed_job(f"{agent.name}-{i}", i)
        return commerce.get_claimed_jobs_copy()

    seen_a, seen_b = await asyncio.gather(agent_task(a), agent_task(b))

    assert seen_a == {f"a-{i}": i for i in range(10)}
    assert seen_b == {f"b-{i}": i for i in range(10)}


async def test_a_task_started_by_an_agent_inherits_its_context(agents):
    a, b = agents

    async def background(agent: Agent) -> str:
        await asyncio.sleep(0)
        return tool_context.current().settings.talos_id  # type: ignore[union-attr]

    async def agent_task(agent: Agent) -> str:
        tool_context.bind(agent.tools.context)
        # Like the heartbeat and polling tasks the scheduler starts.
        return await asyncio.create_task(background(agent))

    assert await asyncio.gather(agent_task(a), agent_task(b)) == ["talos-a", "talos-b"]


async def test_each_agent_gets_its_own_signer_and_stellar_kit(agents):
    a, b = agents

    with tool_context.use(a.tools.context):
        signer_a = commerce._get_signer()
        kit_a = stellar_tools._get_kit()
    with tool_context.use(b.tools.context):
        signer_b = commerce._get_signer()
        kit_b = stellar_tools._get_kit()

    assert signer_a is not signer_b
    assert signer_a._api is a.api
    assert signer_b._api is b.api
    assert kit_a is not kit_b
    # And asking again returns the same helper for the same agent.
    with tool_context.use(a.tools.context):
        assert commerce._get_signer() is signer_a
        assert stellar_tools._get_kit() is kit_a


async def test_browser_cleanup_only_closes_the_calling_agents_browser(agents):
    a, b = agents

    with tool_context.use(a.tools.context):
        result = await browser_tools.cleanup_browser_sessions_on_cancellation()

    assert result["status"] == "cleaned"
    assert a.browser.closed is True
    assert b.browser.closed is False
    assert a.tools.context.browser is None
    assert b.tools.context.browser is b.browser


async def test_each_agent_has_its_own_adapter_registry(agents):
    a, b = agents

    assert a.tools.context.adapter_registry is not b.tools.context.adapter_registry
    assert a.tools.context.adapter_registry is not None


# ── Rebuilding an agent's tools ─────────────────────────────────────


async def test_rebuilding_updates_the_agents_context_in_place(agents, tmp_path):
    a, b = agents
    await asyncio.gather(
        a.tools.execute("report_activity", {"type": "post", "content": "before", "channel": "x"}),
        b.tools.execute("report_activity", {"type": "post", "content": "before", "channel": "x"}),
    )
    with tool_context.use(a.tools.context):
        await commerce.set_claimed_job("kept", 4)
    context_before = a.tools.context
    new_browser = FakeBrowser("a-new")

    rebuilt = build_all_tools(
        api=a.api,
        db=a.db,
        browser=new_browser,
        settings=a.settings,
        context=a.tools.context,
    )

    # Same context object, so a task already holding it sees the new browser...
    assert rebuilt.context is context_before
    assert context_before.browser is new_browser
    # ...and the agent's own accumulated state survives the rebuild.
    with tool_context.use(context_before):
        assert commerce.get_claimed_jobs_copy() == {"kept": 4}
    # The other agent was not touched.
    assert b.tools.context.browser is b.browser
    assert b.tools.context.settings is b.settings


async def test_a_task_bound_before_a_rebuild_sees_the_rebuilt_browser(agents):
    a, b = agents
    new_browser = FakeBrowser("a-new")
    observed: list[object] = []

    async def agent_task() -> None:
        tool_context.bind(a.tools.context)
        await asyncio.sleep(0)  # the rebuild happens while this task is suspended
        await asyncio.sleep(0)
        observed.append(tool_context.current().browser)  # type: ignore[union-attr]

    async def rebuild() -> None:
        await asyncio.sleep(0)
        build_all_tools(
            api=a.api,
            db=a.db,
            browser=new_browser,
            settings=a.settings,
            context=a.tools.context,
        )

    await asyncio.gather(agent_task(), rebuild())

    assert observed == [new_browser]


async def test_building_again_without_a_context_makes_a_new_independent_context(agents):
    a, _ = agents

    second = build_all_tools(
        api=a.api, db=a.db, browser=a.browser, settings=a.settings
    )

    assert second.context is not a.tools.context
    assert second is not a.tools


# ── The context binding itself ──────────────────────────────────────


async def test_executing_a_tool_does_not_leave_a_context_bound(agents):
    a, _ = agents
    assert tool_context.current() is None

    await a.tools.execute("report_activity", {"type": "post", "content": "x", "channel": "x"})

    assert tool_context.current() is None


async def test_the_context_is_unbound_even_when_a_tool_fails():
    registry = ToolRegistry().for_agent(tool_context.ToolContext())

    def boom() -> None:
        raise RuntimeError("tool failed")

    registry.register("boom", "always fails", boom, {"type": "object", "properties": {}})

    result = await registry.execute("boom", {})

    assert result["error"] == "RuntimeError: tool failed"
    assert tool_context.current() is None


async def test_the_context_is_visible_inside_a_worker_thread():
    context = tool_context.ToolContext()
    registry = ToolRegistry().for_agent(context)

    def sync_tool() -> bool:
        # A synchronous tool runs in a worker thread.
        return tool_context.current() is context

    registry.register("sync_tool", "runs in a thread", sync_tool, {"type": "object", "properties": {}})

    assert await registry.execute("sync_tool", {}) is True


async def test_nested_binding_restores_the_outer_context():
    outer, inner = tool_context.ToolContext(), tool_context.ToolContext()

    with tool_context.use(outer):
        with tool_context.use(inner):
            assert tool_context.current() is inner
        assert tool_context.current() is outer
    assert tool_context.current() is None


# ── No context: the behaviour tool modules had before ───────────────


async def test_with_no_context_a_tool_uses_its_modules_own_globals():
    api = RecordingAPI("direct")
    settings = SimpleNamespace(talos_id="talos-direct")
    assert tool_context.current() is None

    with patch.object(web_api, "_api", api), patch.object(web_api, "_settings", settings):
        result = await web_api.report_activity("post", "hello", "x")

    assert result == {"status": "reported", "by": "direct"}
    assert api.calls[0][1] == "talos-direct"


async def test_the_shared_template_registry_still_runs_tools_against_module_globals():
    api = RecordingAPI("template")
    settings = SimpleNamespace(talos_id="talos-template")
    assert shared_registry.context is None

    with patch.object(web_api, "_api", api), patch.object(web_api, "_settings", settings):
        result = await shared_registry.execute(
            "report_activity", {"type": "post", "content": "hi", "channel": "x"}
        )

    assert result == {"status": "reported", "by": "template"}


async def test_a_bound_context_takes_precedence_over_the_module_globals(agents):
    a, _ = agents
    intruder = RecordingAPI("intruder")
    settings = SimpleNamespace(talos_id="talos-intruder")

    with patch.object(web_api, "_api", intruder), patch.object(web_api, "_settings", settings):
        result = await a.tools.execute(
            "report_activity", {"type": "post", "content": "x", "channel": "x"}
        )

    assert result == {"status": "reported", "by": "a"}
    assert intruder.calls == []
    assert a.calls("report_activity")[0][1] == "talos-a"


def test_module_deps_view_reads_and_writes_the_module_globals():
    namespace: dict[str, Any] = {"_api": "api", "_db": None}
    view = tool_context.resolve(namespace)

    assert view.api == "api"
    assert view.db is None
    view.db = "db"
    assert namespace["_db"] == "db"
    with pytest.raises(AttributeError):
        view.not_a_dependency
    with pytest.raises(AttributeError):
        view.not_a_dependency = 1
    with pytest.raises(AttributeError):
        view.settings  # a field the module does not define


# ── The scheduler ───────────────────────────────────────────────────
#
# `scheduler.run()` has no test harness (it talks to the API, starts a browser
# and loops until shut down), so these guard the three things it must keep doing
# for agents to stay isolated, by looking at its source. A behavioural test of
# the same invariants is in the tests above: they bind a context to a task, start
# sub-tasks and rebuild in place, which is exactly what `run()` does.


def test_the_scheduler_binds_the_agents_context_right_after_building_its_tools():
    source = inspect.getsource(scheduler)

    build = source.index("tools = build_all_tools(api=api, db=db, browser=browser, settings=settings,")
    bind = source.index("tool_context_module.bind(tool_context)")
    first_task = source.index('asyncio.create_task(agent_cycle_task(), name="agent_cycle")')

    assert "tool_context = tools.context" in source
    # Bound after the tools exist and before any task the agent starts, so every
    # one of those tasks (and the shutdown cleanup) inherits it.
    assert build < bind < first_task


def test_every_rebuild_in_the_scheduler_reuses_the_agents_context():
    source = inspect.getsource(scheduler)

    calls = [m.start() for m in re.finditer(r"build_all_tools\(", source)]
    assert len(calls) == 3  # the first build, and the two browser-recovery rebuilds
    for start in calls[1:]:
        call = source[start : source.index(")", start + 200) + 1]
        assert "context=tool_context" in call, call


def test_the_scheduler_no_longer_reads_a_tool_modules_adapter_registry_global():
    source = inspect.getsource(scheduler)

    assert "from talos_agent.tools.publishing import _adapter_registry" not in source
    assert "_publishing_tools" not in source
    assert "registry=tool_context.adapter_registry" in source
    assert "lambda: tool_context.adapter_registry" in source
