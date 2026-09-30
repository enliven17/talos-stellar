"""Unit coverage for policy-engine condition operators and helpers (#638 floor).

Complements test_policy_decision_traces.py / test_policy_engine.py with
direct tests for the numeric/membership/regex/glob operators, glob
translation edge cases, and engine accessor properties.
"""

from __future__ import annotations

import pytest

from talos_agent.policy.engine import PolicyEngine, _evaluate_condition, _match_glob
from talos_agent.policy.schema import ActionSpec, MatchCondition


def _spec(params: dict | None = None) -> ActionSpec:
    return ActionSpec(action="purchase_service", params=params or {})


def _cond(operator: str, value=None, field: str = "amount") -> MatchCondition:
    return MatchCondition(field=field, operator=operator, value=value)


class TestNumericComparisons:
    def test_gt_matches_larger(self):
        assert _evaluate_condition(_cond("gt", 5), _spec({"amount": 10})) is True

    def test_gte_matches_equal(self):
        assert _evaluate_condition(_cond("gte", 10), _spec({"amount": 10})) is True

    def test_lt_matches_smaller(self):
        assert _evaluate_condition(_cond("lt", 10), _spec({"amount": 5})) is True

    def test_lte_matches_equal(self):
        assert _evaluate_condition(_cond("lte", 10), _spec({"amount": 10})) is True

    def test_comparison_without_expected_value_fails_closed(self):
        assert _evaluate_condition(_cond("gt", None), _spec({"amount": 10})) is False

    def test_non_numeric_operand_fails_closed(self):
        assert _evaluate_condition(_cond("gt", "abc"), _spec({"amount": "xyz"})) is False


class TestMembershipOperators:
    def test_in_matches_member(self):
        assert _evaluate_condition(_cond("in", ["x", "y"]), _spec({"amount": "x"})) is True

    def test_in_rejects_non_member(self):
        assert _evaluate_condition(_cond("in", ["x"]), _spec({"amount": "z"})) is False

    def test_in_with_non_container_fails_closed(self):
        assert _evaluate_condition(_cond("in", 3), _spec({"amount": "x"})) is False

    def test_not_in_accepts_non_member(self):
        assert _evaluate_condition(_cond("not_in", ["x"]), _spec({"amount": "z"})) is True

    def test_not_in_with_non_container_assumes_not_in(self):
        assert _evaluate_condition(_cond("not_in", 3), _spec({"amount": "x"})) is True


class TestRegexAndUnknownOperators:
    def test_regex_matches(self):
        assert _evaluate_condition(_cond("regex", r"^ab+c$"), _spec({"amount": "abbbc"})) is True

    def test_invalid_regex_fails_closed(self):
        assert _evaluate_condition(_cond("regex", "(["), _spec({"amount": "x"})) is False

    def test_neq(self):
        assert _evaluate_condition(_cond("neq", 5), _spec({"amount": 6})) is True
        assert _evaluate_condition(_cond("neq", 5), _spec({"amount": 5})) is False

    def test_unknown_operator_fails_closed(self):
        assert _evaluate_condition(_cond("startswith", "ab"), _spec({"amount": "abc"})) is False


class TestGlobMatching:
    def test_star_does_not_cross_path_separators(self):
        assert _match_glob("a/*", "a/b") is True
        assert _match_glob("a/*", "a/b/c") is False

    def test_question_mark_matches_single_char(self):
        assert _match_glob("a?c", "abc") is True
        assert _match_glob("a?c", "ac") is False

    def test_character_class_positive(self):
        assert _match_glob("a[bc]d", "abd") is True
        assert _match_glob("a[bc]d", "azd") is False

    def test_character_class_negated(self):
        assert _match_glob("a[!bc]d", "azd") is True
        assert _match_glob("a[!bc]d", "abd") is False

    def test_unclosed_bracket_is_literal(self):
        # An unclosed '[' falls back to matching a literal character class
        # fragment: the produced regex never matches the plain text, so the
        # glob fails closed for both the pattern text and other inputs.
        assert _match_glob("a[b", "a[b") is False

    def test_regex_specials_are_escaped(self):
        assert _match_glob("a+b", "a+b") is True
        assert _match_glob("a+b", "aab") is False

    def test_glob_via_condition_operator(self):
        assert _evaluate_condition(_cond("glob", "*.example.com"), _spec({"amount": "api.example.com"})) is True


class TestEngineAccessors:
    def test_disabled_engine_short_circuit_message(self):
        engine = PolicyEngine()
        engine.enabled = False
        result = engine.evaluate(ActionSpec(action="anything"))
        assert result.decision.value == "approve"
        assert "disabled" in result.evidence[0]

    def test_policies_and_count_reflect_loaded_rules(self):
        engine = PolicyEngine()
        assert isinstance(engine.policies, tuple)
        assert len(engine.policies) == 0

    def test_evaluate_sync_alias(self):
        engine = PolicyEngine()
        result = engine.evaluate_sync(ActionSpec(action="anything"))
        assert result.decision.value == "approve"


@pytest.mark.parametrize(
    ("pattern", "text", "expected"),
    [
        ("*", "anything", True),
        ("*.talos.dev", "api.talos.dev", True),
        ("?.talos.dev", "x.talos.dev", True),
    ],
)
def test_match_glob_parametrized(pattern: str, text: str, expected: bool):
    assert _match_glob(pattern, text) is expected
