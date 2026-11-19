"""Tests for descriptions exposed by Stellar tools."""

from talos_agent.tools import stellar
from talos_agent.tools.registry import registry


def test_stellar_tool_descriptions_use_stellar_terminology():
    stellar_tools = [
        tool for tool in registry.all_tools()
        if tool.fn.__module__ == stellar.__name__
    ]

    assert stellar_tools
    assert all(
        "Mirror Node" not in tool.description and "0.0." not in tool.description
        for tool in stellar_tools
    )
