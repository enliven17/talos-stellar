"""Tests for the portable runtime state classification framework.

Covers
------
- StateCategory enum values
- FieldClassification dataclass construction
- register_field / registered_classification round-trip
- @classified decorator registration
- require_classification pass/fail
- validate_checkpoint_payload pass/fail (including FORBIDDEN rejection)
- classification_report is non-empty
- All _CHECKPOINT_TABLES are registered
- Reregistration doesn't raise
"""

from __future__ import annotations

import pytest

from talos_agent.state_classify import (
    ClassificationError,
    FieldClassification,
    StateCategory,
    classified,
    classification_report,
    register_field,
    registered_classification,
    registered_classifications,
    require_classification,
    validate_checkpoint_payload,
)


class TestStateCategory:
    def test_values(self) -> None:
        assert StateCategory.PORTABLE.value == "portable"
        assert StateCategory.DERIVED.value == "derived"
        assert StateCategory.LOCAL_ONLY.value == "local_only"
        assert StateCategory.FORBIDDEN.value == "forbidden"

    def test_is_enum(self) -> None:
        assert isinstance(StateCategory.PORTABLE, StateCategory)


class TestFieldClassification:
    def test_minimal_construction(self) -> None:
        fc = FieldClassification(category=StateCategory.PORTABLE)
        assert fc.category is StateCategory.PORTABLE
        assert fc.sensitivity == "none"
        assert fc.retention is None
        assert fc.bounds is None
        assert fc.restore_semantics is None
        assert fc.reason is None

    def test_full_construction(self) -> None:
        fc = FieldClassification(
            category=StateCategory.PORTABLE,
            sensitivity="high",
            retention="7d",
            bounds="non-negative int",
            restore_semantics="capped",
            reason="test field",
        )
        assert fc.category is StateCategory.PORTABLE
        assert fc.sensitivity == "high"
        assert fc.retention == "7d"
        assert fc.bounds == "non-negative int"
        assert fc.restore_semantics == "capped"
        assert fc.reason == "test field"

    def test_is_frozen(self) -> None:
        fc = FieldClassification(category=StateCategory.PORTABLE)
        with pytest.raises(AttributeError):
            fc.category = StateCategory.DERIVED  # type: ignore[misc]


class TestRegistration:
    def test_round_trip(self) -> None:
        fc = FieldClassification(category=StateCategory.PORTABLE, sensitivity="low")
        register_field("test.foo", fc)
        retrieved = registered_classification("test.foo")
        assert retrieved is not None
        assert retrieved.category is StateCategory.PORTABLE
        assert retrieved.sensitivity == "low"

    def test_reregister_updates(self) -> None:
        fc1 = FieldClassification(category=StateCategory.PORTABLE)
        fc2 = FieldClassification(category=StateCategory.DERIVED)
        register_field("test.rereg", fc1)
        register_field("test.rereg", fc2)
        retrieved = registered_classification("test.rereg")
        assert retrieved is not None
        assert retrieved.category is StateCategory.DERIVED

    def test_missing_returns_none(self) -> None:
        assert registered_classification("test.nonexistent") is None

    def test_registered_classifications_returns_copy(self) -> None:
        regs = registered_classifications()
        assert isinstance(regs, dict)
        assert "test.foo" in regs


class TestClassifiedDecorator:
    def test_decorator_registers(self) -> None:
        @classified(
            category=StateCategory.LOCAL_ONLY,
            sensitivity="high",
            reason="test decorator",
        )
        def my_special_field() -> int:
            return 42

        # The function itself still works
        assert my_special_field() == 42

        # The qualified name includes the test module
        path = f"{__name__}.{my_special_field.__qualname__}"
        fc = registered_classification(path)
        assert fc is not None
        assert fc.category is StateCategory.LOCAL_ONLY
        assert fc.sensitivity == "high"
        assert fc.reason == "test decorator"


class TestRequireClassification:
    def test_registered_field_passes(self) -> None:
        register_field("test.require_ok", FieldClassification(category=StateCategory.PORTABLE))
        require_classification("test.require_ok")  # no error

    def test_unregistered_field_raises(self) -> None:
        with pytest.raises(ClassificationError, match="not classified"):
            require_classification("test.require_fail")


class TestValidateCheckpointPayload:
    def test_all_classified_passes(self) -> None:
        payload = {"test.foo": "value", "test.rereg": "value"}
        validate_checkpoint_payload(payload)  # no error

    def test_unclassified_key_raises(self) -> None:
        payload = {"test.unknown_field": "value"}
        with pytest.raises(ClassificationError, match="not classified"):
            validate_checkpoint_payload(payload)

    def test_forbidden_field_raises(self) -> None:
        register_field(
            "test.forbidden_field",
            FieldClassification(category=StateCategory.FORBIDDEN, sensitivity="critical"),
        )
        payload = {"test.forbidden_field": "secret"}
        with pytest.raises(ClassificationError, match="FORBIDDEN"):
            validate_checkpoint_payload(payload)

    def test_empty_payload_passes(self) -> None:
        validate_checkpoint_payload({})  # no error


class TestClassificationReport:
    def test_report_is_non_empty_string(self) -> None:
        report = classification_report()
        assert isinstance(report, str)
        assert len(report) > 50
        assert "PORTABLE" in report
        assert "DERIVED" in report
        assert "LOCAL_ONLY" in report
        assert "FORBIDDEN" in report


class TestCheckpointTablesAreRegistered:
    """Ensure every table in _CHECKPOINT_TABLES has a registered classification."""

    CHECKPOINT_TABLES = (
        "schedules",
        "activity_log",
        "content_history",
        "commerce_queue",
        "approval_cache",
        "spending_log",
        "talos_config",
        "playbooks",
        "content_performance",
        "strategy_learnings",
        "audience_insights",
        "loans",
        "loan_repayments",
        "dividends_log",
        "retry_state",
    )

    def test_all_checkpoint_tables_registered(self) -> None:
        missing = []
        for tbl in self.CHECKPOINT_TABLES:
            fc = registered_classification(tbl)
            if fc is None:
                missing.append(tbl)
        assert not missing, f"Tables missing classification: {missing}"

    def test_no_checkpoint_tables_are_forbidden(self) -> None:
        forbidden = []
        for tbl in self.CHECKPOINT_TABLES:
            fc = registered_classification(tbl)
            if fc is not None and fc.category is StateCategory.FORBIDDEN:
                forbidden.append(tbl)
        assert not forbidden, f"Checkpoint tables classified as FORBIDDEN: {forbidden}"

    def test_no_checkpoint_tables_are_derived(self) -> None:
        derived = []
        for tbl in self.CHECKPOINT_TABLES:
            fc = registered_classification(tbl)
            if fc is not None and fc.category is StateCategory.DERIVED:
                derived.append(tbl)
        assert not derived, (
            f"Checkpoint tables classified as DERIVED (should not be in "
            f"checkpoint): {derived}"
        )
