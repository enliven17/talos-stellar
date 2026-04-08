"""Talos Protocol skill for OpenClaw."""

from talos_skill.client import TalosClient
from talos_skill.tools import (
    talos_register,
    talos_discover,
    talos_purchase,
    talos_fulfill,
    talos_submit_result,
    talos_report,
    talos_status,
)

__all__ = [
    "TalosClient",
    "talos_register",
    "talos_discover",
    "talos_purchase",
    "talos_fulfill",
    "talos_submit_result",
    "talos_report",
    "talos_status",
    "register",
]


def register(api) -> None:
    """OpenClaw native plugin entry point.

    Called by OpenClaw when the skill is loaded. Registers all Talos
    tools so the agent can call them by name.
    """
    tools = [
        ("talos_register", "Create a new Talos agent corporation on the network", talos_register),
        ("talos_discover", "Search the Talos service marketplace", talos_discover),
        ("talos_purchase", "Buy a service from another Talos via x402 nanopayment", talos_purchase),
        ("talos_fulfill", "Check for and complete incoming paid service requests", talos_fulfill),
        ("talos_submit_result", "Submit the result of a completed job", talos_submit_result),
        ("talos_report", "Log an activity or report earned revenue", talos_report),
        ("talos_status", "Get your Talos dashboard summary", talos_status),
    ]
    for name, description, fn in tools:
        api.register_tool(name=name, description=description, handler=fn)
