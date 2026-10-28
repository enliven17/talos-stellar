"""Tests for _fn_to_json_schema — covers PEP 604 unions, list/dict types.

Closes #914.
"""

from __future__ import annotations

from typing import Optional

import pytest

from talos_agent.tools.registry import _fn_to_json_schema


# ---------------------------------------------------------------------------
# Fixture functions — each exercises a specific type form
# ---------------------------------------------------------------------------


def fn_plain(name: str, count: int, score: float, active: bool) -> None:
    """Plain primitives."""


def fn_optional_typing(value: Optional[float] = None) -> None:
    """typing.Optional[T] — the classic Union[T, None] spelling."""


def fn_pep604_optional(amount: float | None = None) -> None:
    """PEP 604 union  float | None  (types.UnionType, Python ≥ 3.10)."""


def fn_list_str(tags: list[str]) -> None:
    """list[T] — should map to array with string items."""


def fn_list_int(ids: list[int]) -> None:
    """list[int] — should map to array with integer items."""


def fn_bare_list(values: list) -> None:  # type: ignore[type-arg]
    """Bare list without element type."""


def fn_dict_param(metadata: dict) -> None:  # type: ignore[type-arg]
    """dict parameter — should map to object."""


def fn_mixed(
    loan_id: int,
    amount: float | None = None,
    tags: list[str] | None = None,
    notes: str = "",
) -> None:
    """Mix of required, PEP 604 optional, and optional list."""


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestPlainPrimitives:
    def test_str_maps_to_string(self) -> None:
        schema = _fn_to_json_schema(fn_plain)
        assert schema["properties"]["name"]["type"] == "string"

    def test_int_maps_to_integer(self) -> None:
        schema = _fn_to_json_schema(fn_plain)
        assert schema["properties"]["count"]["type"] == "integer"

    def test_float_maps_to_number(self) -> None:
        schema = _fn_to_json_schema(fn_plain)
        assert schema["properties"]["score"]["type"] == "number"

    def test_bool_maps_to_boolean(self) -> None:
        schema = _fn_to_json_schema(fn_plain)
        assert schema["properties"]["active"]["type"] == "boolean"

    def test_all_plain_params_are_required(self) -> None:
        schema = _fn_to_json_schema(fn_plain)
        assert set(schema.get("required", [])) == {"name", "count", "score", "active"}


class TestTypingOptional:
    def test_optional_float_maps_to_number(self) -> None:
        schema = _fn_to_json_schema(fn_optional_typing)
        assert schema["properties"]["value"]["type"] == "number"

    def test_optional_param_is_not_required(self) -> None:
        schema = _fn_to_json_schema(fn_optional_typing)
        assert "value" not in schema.get("required", [])

    def test_default_preserved(self) -> None:
        # default is None, which we intentionally skip to avoid polluting schema
        schema = _fn_to_json_schema(fn_optional_typing)
        # default=None should NOT appear in the property (we skip None defaults)
        assert "default" not in schema["properties"]["value"]


class TestPep604Optional:
    """float | None  (PEP 604) must produce the same schema as Optional[float]."""

    def test_pep604_float_maps_to_number(self) -> None:
        schema = _fn_to_json_schema(fn_pep604_optional)
        prop = schema["properties"]["amount"]
        assert prop["type"] == "number", (
            f"Expected 'number', got '{prop['type']}'. "
            "PEP 604 unions must be unwrapped correctly."
        )

    def test_pep604_param_is_not_required(self) -> None:
        schema = _fn_to_json_schema(fn_pep604_optional)
        assert "amount" not in schema.get("required", [])


class TestListTypes:
    def test_list_str_type_is_array(self) -> None:
        schema = _fn_to_json_schema(fn_list_str)
        assert schema["properties"]["tags"]["type"] == "array"

    def test_list_str_has_string_items(self) -> None:
        schema = _fn_to_json_schema(fn_list_str)
        items = schema["properties"]["tags"].get("items")
        assert items is not None, "list[str] must include 'items'"
        assert items["type"] == "string"

    def test_list_int_has_integer_items(self) -> None:
        schema = _fn_to_json_schema(fn_list_int)
        items = schema["properties"]["ids"].get("items")
        assert items is not None, "list[int] must include 'items'"
        assert items["type"] == "integer"

    def test_bare_list_is_array_without_items(self) -> None:
        schema = _fn_to_json_schema(fn_bare_list)
        prop = schema["properties"]["values"]
        assert prop["type"] == "array"
        # Bare list has no element type annotation — items key should be absent
        assert "items" not in prop


class TestDictType:
    def test_dict_maps_to_object(self) -> None:
        schema = _fn_to_json_schema(fn_dict_param)
        assert schema["properties"]["metadata"]["type"] == "object"


class TestMixedFunction:
    """Mirrors repay_loan(loan_id: int, amount: float | None = None)."""

    def test_loan_id_is_integer(self) -> None:
        schema = _fn_to_json_schema(fn_mixed)
        assert schema["properties"]["loan_id"]["type"] == "integer"

    def test_amount_is_number(self) -> None:
        schema = _fn_to_json_schema(fn_mixed)
        prop = schema["properties"]["amount"]
        assert prop["type"] == "number", (
            f"repay_loan.amount must be 'number', got '{prop['type']}'"
        )

    def test_tags_is_array_of_strings(self) -> None:
        schema = _fn_to_json_schema(fn_mixed)
        prop = schema["properties"]["tags"]
        assert prop["type"] == "array"
        assert prop.get("items", {}).get("type") == "string"

    def test_only_required_params_in_required_list(self) -> None:
        schema = _fn_to_json_schema(fn_mixed)
        required = schema.get("required", [])
        assert "loan_id" in required
        assert "amount" not in required
        assert "tags" not in required
        assert "notes" not in required


class TestJsonSchemaDraft2020Compliance:
    """Each registered tool schema must be a valid JSON Schema object."""

    @pytest.fixture()
    def all_schemas(self) -> list[dict]:
        """Collect schemas for the fixture functions defined above."""
        functions = [
            fn_plain,
            fn_optional_typing,
            fn_pep604_optional,
            fn_list_str,
            fn_list_int,
            fn_bare_list,
            fn_dict_param,
            fn_mixed,
        ]
        return [_fn_to_json_schema(fn) for fn in functions]

    def test_all_schemas_have_type_object(self, all_schemas: list[dict]) -> None:
        for schema in all_schemas:
            assert schema.get("type") == "object", f"Schema root must be object: {schema}"

    def test_all_schemas_have_properties(self, all_schemas: list[dict]) -> None:
        for schema in all_schemas:
            assert "properties" in schema, f"Schema must have properties: {schema}"

    def test_property_types_are_valid_json_schema_types(
        self, all_schemas: list[dict]
    ) -> None:
        valid_types = {"string", "integer", "number", "boolean", "array", "object", "null"}
        for schema in all_schemas:
            for prop_name, prop in schema["properties"].items():
                assert prop.get("type") in valid_types, (
                    f"Property '{prop_name}' has invalid JSON Schema type: {prop.get('type')}"
                )

    def test_array_properties_have_valid_items_when_present(
        self, all_schemas: list[dict]
    ) -> None:
        for schema in all_schemas:
            for prop_name, prop in schema["properties"].items():
                if prop.get("type") == "array" and "items" in prop:
                    assert "type" in prop["items"], (
                        f"Property '{prop_name}' items must have a type: {prop['items']}"
                    )
