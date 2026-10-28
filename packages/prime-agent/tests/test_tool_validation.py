"""Unit tests for tool-call argument validation against tool JSON schemas (Issue #998)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from talos_agent.tools.registry import (
    CODE_INVALID_ARGUMENTS,
    ToolRegistry,
    validate_tool_arguments,
)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Pure validation unit tests (validate_tool_arguments)
# ══════════════════════════════════════════════════════════════════════════════


def test_validate_arguments_requires_mapping():
    """Non-mapping arguments (None, list, string, int) must be rejected immediately."""
    schema = {"type": "object", "properties": {"x": {"type": "integer"}}}
    for non_dict in (None, [1, 2], "raw_string", 42):
        result = validate_tool_arguments(schema, non_dict)
        assert not result.is_valid
        assert len(result.errors) == 1
        assert result.errors[0].parameter == "<arguments>"
        assert "dictionary/object" in result.errors[0].message


def test_validate_arguments_valid_types():
    """Valid arguments matching schema pass unchanged."""
    schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "count": {"type": "integer"},
            "ratio": {"type": "number"},
            "active": {"type": "boolean"},
            "tags": {"type": "array", "items": {"type": "string"}},
            "config": {"type": "object"},
        },
        "required": ["name", "count"],
    }
    args = {
        "name": "stellar-core",
        "count": 5,
        "ratio": 3.14,
        "active": True,
        "tags": ["crypto", "stellar"],
        "config": {"network": "testnet"},
    }
    result = validate_tool_arguments(schema, args)
    assert result.is_valid
    assert result.coerced_arguments == args
    assert len(result.errors) == 0


def test_validate_missing_required_arguments():
    """Omission of required parameters fails validation."""
    schema = {
        "type": "object",
        "properties": {
            "to_account": {"type": "string"},
            "amount": {"type": "number"},
        },
        "required": ["to_account", "amount"],
    }
    result = validate_tool_arguments(schema, {"amount": 10.5})
    assert not result.is_valid
    assert any(
        e.parameter == "to_account" and "Missing required parameter" in e.message
        for e in result.errors
    )


def test_validate_rejects_null_for_required_parameter():
    """Passing None for a non-nullable required parameter fails validation."""
    schema = {
        "type": "object",
        "properties": {
            "to_account": {"type": "string"},
        },
        "required": ["to_account"],
    }
    result = validate_tool_arguments(schema, {"to_account": None})
    assert not result.is_valid
    assert any(
        e.parameter == "to_account" and "cannot be null" in e.message
        for e in result.errors
    )


def test_validate_rejects_unknown_extra_parameters():
    """Extra unexpected parameters must be rejected when additionalProperties is not true."""
    schema = {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
        },
    }
    result = validate_tool_arguments(schema, {"query": "test", "extra_param": 123})
    assert not result.is_valid
    assert any(
        e.parameter == "extra_param" and "Unknown parameter" in e.message
        for e in result.errors
    )


def test_validate_wrong_types_rejected():
    """Wrong types like string for numbers, or boolean for integer, are rejected."""
    schema = {
        "type": "object",
        "properties": {
            "amount": {"type": "number"},
            "count": {"type": "integer"},
            "flag": {"type": "boolean"},
            "name": {"type": "string"},
        },
    }

    # String amount
    res = validate_tool_arguments(schema, {"amount": "100.50"})
    assert not res.is_valid
    assert any(e.parameter == "amount" for e in res.errors)

    # Boolean for integer
    res = validate_tool_arguments(schema, {"count": True})
    assert not res.is_valid
    assert any(e.parameter == "count" for e in res.errors)

    # Integer for boolean
    res = validate_tool_arguments(schema, {"flag": 1})
    assert not res.is_valid
    assert any(e.parameter == "flag" for e in res.errors)

    # Number for string
    res = validate_tool_arguments(schema, {"name": 42})
    assert not res.is_valid
    assert any(e.parameter == "name" for e in res.errors)


def test_explicitly_safe_coercion_integer_valued_float():
    """Integer-valued floats (e.g. 10.0) are safely coerced to int, while fractional floats are rejected."""
    schema = {
        "type": "object",
        "properties": {
            "initial_supply": {"type": "integer"},
        },
    }

    # Safe coercion: 1000000.0 -> 1000000
    res = validate_tool_arguments(schema, {"initial_supply": 1000000.0})
    assert res.is_valid
    assert res.coerced_arguments["initial_supply"] == 1000000
    assert isinstance(res.coerced_arguments["initial_supply"], int)

    # Fractional float: rejected
    res_frac = validate_tool_arguments(schema, {"initial_supply": 1000000.5})
    assert not res_frac.is_valid
    assert any(e.parameter == "initial_supply" for e in res_frac.errors)


def test_array_item_validation_and_tuple_coercion():
    """Array item schema is validated, and tuples are safely converted to lists."""
    schema = {
        "type": "object",
        "properties": {
            "channels": {"type": "array", "items": {"type": "string"}},
        },
    }

    # Valid tuple converted to list
    res = validate_tool_arguments(schema, {"channels": ("telegram", "discord")})
    assert res.is_valid
    assert res.coerced_arguments["channels"] == ["telegram", "discord"]

    # Invalid item inside array
    res_bad = validate_tool_arguments(schema, {"channels": ["telegram", 123]})
    assert not res_bad.is_valid
    assert any("channels[1]" in e.parameter for e in res_bad.errors)


# ══════════════════════════════════════════════════════════════════════════════
# 2. ToolRegistry.execute integration tests with fake tools
# ══════════════════════════════════════════════════════════════════════════════


class TestToolRegistryValidationExecution:
    """Verifies end-to-end execution behavior in ToolRegistry."""

    @pytest.mark.asyncio
    async def test_invalid_arguments_never_invoke_tool(self):
        """Invalid arguments must return structured error and never invoke tool function."""
        reg = ToolRegistry()
        mock_fn = MagicMock(return_value={"status": "ok"})

        def transfer_funds(to_account: str, amount: float) -> dict:
            return mock_fn(to_account, amount)

        schema = {
            "type": "object",
            "properties": {
                "to_account": {"type": "string"},
                "amount": {"type": "number"},
            },
            "required": ["to_account", "amount"],
        }
        reg.register("transfer_funds", "Transfer funds", transfer_funds, schema)

        # 1. Missing required parameter
        result = await reg.execute("transfer_funds", {"amount": 50.0})
        assert result["code"] == CODE_INVALID_ARGUMENTS
        assert result["tool"] == "transfer_funds"
        assert "Missing required parameter 'to_account'" in result["error"]
        assert mock_fn.call_count == 0

        # 2. Wrong type (string amount)
        result = await reg.execute(
            "transfer_funds", {"to_account": "GABC123", "amount": "50.0"}
        )
        assert result["code"] == CODE_INVALID_ARGUMENTS
        assert mock_fn.call_count == 0

        # 3. Unknown extra parameter
        result = await reg.execute(
            "transfer_funds",
            {"to_account": "GABC123", "amount": 50.0, "bogus_arg": True},
        )
        assert result["code"] == CODE_INVALID_ARGUMENTS
        assert "Unknown parameter 'bogus_arg'" in result["error"]
        assert mock_fn.call_count == 0

    @pytest.mark.asyncio
    async def test_valid_arguments_invoke_tool_with_safe_coercion(self):
        """Valid arguments invoke tool function and integer-valued float is coerced."""
        reg = ToolRegistry()
        invoked_with = {}

        def create_token(name: str, supply: int) -> dict:
            invoked_with["name"] = name
            invoked_with["supply"] = supply
            return {"status": "created", "supply": supply}

        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "supply": {"type": "integer"},
            },
            "required": ["name", "supply"],
        }
        reg.register("create_token", "Create token", create_token, schema)

        result = await reg.execute(
            "create_token", {"name": "Pulse", "supply": 500.0}
        )
        assert result == {"status": "created", "supply": 500}
        assert invoked_with["supply"] == 500
        assert isinstance(invoked_with["supply"], int)

    @pytest.mark.asyncio
    async def test_error_redaction_and_bounding(self):
        """Sensitive tokens in values are redacted and error messages are bounded."""
        reg = ToolRegistry()

        def login(api_key: int) -> dict:
            return {"status": "ok"}

        schema = {
            "type": "object",
            "properties": {
                "api_key": {"type": "integer"},
            },
            "required": ["api_key"],
        }
        reg.register("login", "Login tool", login, schema)

        # Stellar secret seed pattern: S + 55 alphanumeric
        fake_secret = "SB3D4ABCD" + "X" * 47
        result = await reg.execute("login", {"api_key": fake_secret})

        assert result["code"] == CODE_INVALID_ARGUMENTS
        # Secret must be masked as [REDACTED]
        assert fake_secret not in result["error"]
        assert "[REDACTED]" in result["error"]
        # Error must be bounded
        assert len(result["error"]) <= 1000

    @pytest.mark.asyncio
    async def test_telemetry_event_recorded_on_failure(self):
        """Rejected tool arguments emit a policy/telemetry event to the validation sink."""
        reg = ToolRegistry()
        events = []
        reg.set_validation_sink(events.append)

        def dummy_tool(x: int) -> dict:
            return {"ok": True}

        schema = {
            "type": "object",
            "properties": {"x": {"type": "integer"}},
            "required": ["x"],
        }
        reg.register("dummy_tool", "Dummy", dummy_tool, schema)

        await reg.execute("dummy_tool", {"x": "wrong_type"})

        assert len(events) == 1
        event = events[0]
        assert event["event"] == "tool_argument_validation_failed"
        assert event["tool"] == "dummy_tool"
        assert event["error_count"] >= 1
        assert "x" in event["rejected_parameters"]
