"""Unit tests for replay.redact — recursive redaction of sensitive data."""

from __future__ import annotations

import pytest

from talos_agent.replay.redact import REDACTED, redact

# ── Scalar passthrough ────────────────────────────────────────────────────────

def test_none_passthrough():
    assert redact(None) is None

def test_bool_passthrough():
    assert redact(True) is True
    assert redact(False) is False

def test_int_passthrough():
    assert redact(42) == 42

def test_float_passthrough():
    assert redact(3.14) == pytest.approx(3.14)

def test_plain_string_passthrough():
    assert redact("hello world") == "hello world"

def test_already_redacted_passthrough():
    assert redact(REDACTED) == REDACTED


# ── Value-level secret detection ──────────────────────────────────────────────

def test_stellar_secret_key_redacted():
    key = "S" + "A" * 55   # 56-char base32 Stellar secret key
    assert redact(key) == REDACTED

def test_enc_prefix_redacted():
    assert redact("ENC::somebase64==") == REDACTED

def test_jwt_redacted():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    assert redact(jwt) == REDACTED

def test_bearer_token_redacted():
    assert redact("Bearer mysecrettoken") == REDACTED

def test_basic_auth_redacted():
    assert redact("Basic dXNlcjpwYXNz") == REDACTED

def test_talos_api_key_redacted():
    assert redact("tak_aBcDeFgHiJkLmNoP") == REDACTED
    assert redact("cpk_testkey12345678") == REDACTED

def test_long_hex_redacted():
    # 40+ hex chars
    assert redact("a" * 40) == REDACTED

def test_short_string_not_redacted():
    # Short plain strings must not be redacted
    assert redact("GABC123") == "GABC123"
    assert redact("hello") == "hello"


# ── Key-based redaction in dicts ──────────────────────────────────────────────

def test_api_key_value_redacted():
    d = {"api_key": "my-secret-key"}
    result = redact(d)
    assert result["api_key"] == REDACTED

def test_password_value_redacted():
    d = {"password": "hunter2"}
    result = redact(d)
    assert result["password"] == REDACTED

def test_token_value_redacted():
    d = {"token": "abc123"}
    result = redact(d)
    assert result["token"] == REDACTED

def test_webhook_value_redacted():
    d = {"discord_webhook_url": "https://discord.com/api/webhooks/123/secret"}
    result = redact(d)
    assert result["discord_webhook_url"] == REDACTED

def test_non_sensitive_key_preserved():
    d = {"name": "Vega", "category": "GTM"}
    result = redact(d)
    assert result == d

def test_mixed_dict():
    d = {"name": "Vega", "api_key": "tak_secret123", "balance": 100}
    result = redact(d)
    assert result["name"] == "Vega"
    assert result["api_key"] == REDACTED
    assert result["balance"] == 100  # 'balance' is not a sensitive key; numeric preserved

def test_numeric_value_preserved_for_non_sensitive_key():
    d = {"count": 5, "posts_today": 3}
    result = redact(d)
    assert result["count"] == 5
    assert result["posts_today"] == 3


# ── Recursive / nested structures ─────────────────────────────────────────────

def test_nested_dict_redacted():
    d = {"config": {"auth": {"token": "secret-value"}}}
    result = redact(d)
    assert result["config"]["auth"]["token"] == REDACTED

def test_nested_list_in_dict():
    d = {"messages": [{"role": "user", "content": "hello"}, {"role": "assistant", "api_key": "tok"}]}
    result = redact(d)
    assert result["messages"][0]["content"] == "hello"
    assert result["messages"][1]["api_key"] == REDACTED

def test_list_of_strings():
    items = ["safe", "S" + "A" * 55]
    result = redact(items)
    assert result[0] == "safe"
    assert result[1] == REDACTED

def test_tuple_redacted():
    t = ("safe", "ENC::something")
    result = redact(t)
    assert isinstance(result, tuple)
    assert result[0] == "safe"
    assert result[1] == REDACTED

def test_set_redacted():
    s = {"safe_value", "ENC::wrapped"}
    result = redact(s)
    assert isinstance(result, set)
    assert "safe_value" in result
    assert REDACTED in result

def test_deeply_nested():
    d = {"level1": {"level2": {"level3": {"password": "deep-secret"}}}}
    result = redact(d)
    assert result["level1"]["level2"]["level3"]["password"] == REDACTED


# ── Edge cases ────────────────────────────────────────────────────────────────

def test_empty_dict():
    assert redact({}) == {}

def test_empty_list():
    assert redact([]) == []

def test_bytes_passthrough():
    b = b"some bytes"
    result = redact(b)
    assert result == b

def test_bytes_with_sensitive_key():
    d = {"secret": b"binary secret"}
    result = redact(d)
    assert result["secret"] == REDACTED

def test_depth_limit_raises():
    # Build a dict nested beyond max_depth
    deep: dict = {}
    node = deep
    for _ in range(70):
        child: dict = {}
        node["x"] = child
        node = child
    with pytest.raises(ValueError, match="max_depth"):
        redact(deep, max_depth=64)

def test_idempotent():
    d = {"api_key": "tak_abc123", "name": "safe"}
    once = redact(d)
    twice = redact(once)
    assert once == twice

def test_case_insensitive_key():
    d = {"API_KEY": "upper-secret", "Password": "mixed-secret"}
    result = redact(d)
    assert result["API_KEY"] == REDACTED
    assert result["Password"] == REDACTED
