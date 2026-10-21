"""Snapshot-style tests for the system prompt builder — Issue #879.

Verifies that:
  - Default (production) prompt contains no aggressive purchasing instructions.
  - Demo mode reproduces the original aggressive purchasing text.
  - Passing ``settings=None`` is backward-compatible and production-safe.
"""

from __future__ import annotations

import types
import unittest

from talos_agent.agent.prompt import build_system_prompt
from talos_agent.agent.context import AgentContext


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_settings(demo_commerce_mode: bool = False) -> object:
    """Return a minimal settings stub with only the fields prompt.py reads."""
    return types.SimpleNamespace(demo_commerce_mode=demo_commerce_mode)


def _make_context() -> AgentContext:
    """Return a minimal AgentContext (no DB needed for prompt generation)."""
    ctx = AgentContext.__new__(AgentContext)
    ctx.to_context_block = lambda: "[context stub]"
    return ctx


_BASE_CONFIG: dict = {
    "name": "TestTalos",
    "persona": "a helpful test agent",
    "targetAudience": "developers",
    "toneVoice": "friendly",
    "channels": ["X"],
    "description": "A test product",
    "approvalThreshold": 10,
    "gtmBudget": 200,
}

# Phrases that must NOT appear in production mode
_AGGRESSIVE_PHRASES = [
    "buy it immediately",
    "BE AGGRESSIVE",
    "You MUST use other agents' services frequently",
    "this is a demo environment",
]


class TestDemoCommerceMode(unittest.TestCase):
    """Issue #879 — demo_commerce_mode opt-in snapshot tests."""

    def _build(self, demo: bool) -> str:
        return build_system_prompt(
            _BASE_CONFIG.copy(),
            _make_context(),
            settings=_make_settings(demo_commerce_mode=demo),
        )

    # --- Default (production-safe) mode ---

    def test_default_no_buy_immediately(self) -> None:
        """'buy it immediately' must not appear when demo_commerce_mode is off."""
        self.assertNotIn("buy it immediately", self._build(demo=False))

    def test_default_no_be_aggressive(self) -> None:
        """'BE AGGRESSIVE' must not appear when demo_commerce_mode is off."""
        self.assertNotIn("BE AGGRESSIVE", self._build(demo=False))

    def test_default_no_demo_environment_notice(self) -> None:
        """Demo-environment notice must not appear in production mode."""
        self.assertNotIn("this is a demo environment", self._build(demo=False))

    def test_default_no_must_use_services_frequently(self) -> None:
        """'You MUST use other agents' services frequently' must not appear in production mode."""
        self.assertNotIn(
            "You MUST use other agents' services frequently", self._build(demo=False)
        )

    def test_default_contains_budget_aware_guidance(self) -> None:
        """Production prompt should include budget-aware purchasing guidance."""
        prompt = self._build(demo=False)
        self.assertIn("Evaluate", prompt)
        self.assertIn("GTM budget", prompt)

    def test_default_contains_agent_name(self) -> None:
        """Agent name must appear in production mode."""
        self.assertIn("TestTalos", self._build(demo=False))

    def test_default_no_aggressive_phrases_exhaustive(self) -> None:
        """None of the known aggressive phrases must appear in production mode."""
        prompt = self._build(demo=False)
        for phrase in _AGGRESSIVE_PHRASES:
            with self.subTest(phrase=phrase):
                self.assertNotIn(phrase, prompt)

    # --- Demo mode (on) ---

    def test_demo_contains_buy_immediately(self) -> None:
        """'buy it immediately' must appear when demo_commerce_mode is on."""
        self.assertIn("buy it immediately", self._build(demo=True))

    def test_demo_contains_be_aggressive(self) -> None:
        """'BE AGGRESSIVE' must appear when demo_commerce_mode is on."""
        self.assertIn("BE AGGRESSIVE", self._build(demo=True))

    def test_demo_contains_demo_environment_notice(self) -> None:
        """Demo-environment notice must appear when demo_commerce_mode is on."""
        self.assertIn("this is a demo environment", self._build(demo=True))

    def test_demo_contains_must_use_services_frequently(self) -> None:
        """'You MUST use other agents' services frequently' must appear in demo mode."""
        self.assertIn(
            "You MUST use other agents' services frequently", self._build(demo=True)
        )

    def test_demo_contains_agent_name(self) -> None:
        """Agent name must appear in demo mode."""
        self.assertIn("TestTalos", self._build(demo=True))

    # --- settings=None backward-compatibility ---

    def test_none_settings_is_production_safe(self) -> None:
        """Passing settings=None must produce a production-safe prompt."""
        prompt = build_system_prompt(_BASE_CONFIG.copy(), _make_context(), settings=None)
        for phrase in _AGGRESSIVE_PHRASES:
            with self.subTest(phrase=phrase):
                self.assertNotIn(phrase, prompt)

    def test_none_settings_contains_agent_name(self) -> None:
        """settings=None prompt must still include the agent name."""
        prompt = build_system_prompt(_BASE_CONFIG.copy(), _make_context(), settings=None)
        self.assertIn("TestTalos", prompt)

    def test_none_settings_contains_budget_section(self) -> None:
        """settings=None prompt must still include the GTM Budget section."""
        prompt = build_system_prompt(_BASE_CONFIG.copy(), _make_context(), settings=None)
        self.assertIn("GTM Budget", prompt)


if __name__ == "__main__":
    unittest.main()
