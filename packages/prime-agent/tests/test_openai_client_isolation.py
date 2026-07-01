"""Regression tests for OpenAI client isolation across in-process agents."""

from __future__ import annotations

import pytest

from talos_agent.agent import loop


class FakeAsyncOpenAI:
    instances: list["FakeAsyncOpenAI"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.instances.append(self)


@pytest.fixture(autouse=True)
def fake_openai_client(monkeypatch):
    FakeAsyncOpenAI.instances = []
    loop._openai_clients.clear()
    monkeypatch.setattr(loop, "AsyncOpenAI", FakeAsyncOpenAI)
    yield
    loop._openai_clients.clear()


def test_openai_client_cache_reuses_matching_credentials():
    first = loop.get_openai_client("sk-agent-a", "https://llm.example/v1")
    second = loop.get_openai_client("sk-agent-a", "https://llm.example/v1")

    assert first is second
    assert len(FakeAsyncOpenAI.instances) == 1
    assert first.kwargs == {
        "api_key": "sk-agent-a",
        "base_url": "https://llm.example/v1",
    }


def test_openai_client_cache_isolates_agents_by_api_key():
    first_agent = loop.get_openai_client("sk-agent-a")
    second_agent = loop.get_openai_client("sk-agent-b")

    assert first_agent is not second_agent
    assert [client.kwargs["api_key"] for client in FakeAsyncOpenAI.instances] == [
        "sk-agent-a",
        "sk-agent-b",
    ]


def test_openai_client_cache_isolates_agents_by_base_url():
    openai_client = loop.get_openai_client("sk-agent-a")
    groq_client = loop.get_openai_client("sk-agent-a", "https://api.groq.com/openai/v1")

    assert openai_client is not groq_client
    assert openai_client.kwargs == {"api_key": "sk-agent-a"}
    assert groq_client.kwargs == {
        "api_key": "sk-agent-a",
        "base_url": "https://api.groq.com/openai/v1",
    }


def test_openai_client_cache_normalizes_empty_base_url():
    no_base_url = loop.get_openai_client("sk-agent-a", None)
    empty_base_url = loop.get_openai_client("sk-agent-a", "")

    assert no_base_url is empty_base_url
    assert len(FakeAsyncOpenAI.instances) == 1
