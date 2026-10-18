"""Property-based tests for secret redaction in talos-agent.

Uses Hypothesis to generate arbitrary text, JSON structures, and embedding
patterns that mix generated secrets with random surrounds.  Each property
asserts that:

1. Secrets never appear verbatim in the redacted output.
2. Non-secret content is preserved where the redaction contract permits.

Covered redaction surfaces
--------------------------
* ``redact_text``   – the HTTP/fallback text sanitiser (Bearer tokens,
                       Stellar seeds, JSON-field redaction, kv patterns).
* ``redact_dict``   – the replay shallow dict redactor.
* ``redact_attributes`` – the tracing span-attribute filter.

Secret categories under test
-----------------------------
* Bearer / Token HTTP auth header values
* Stellar secret seeds  (S + 55 base32 uppercase chars)
* Generic API keys / passwords embedded in ``key=value`` text
* JSON payloads with secret-named field keys
* Deeply / multiply nested JSON structures
"""

from __future__ import annotations

import json
import re
import string

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from talos_agent.redact import redact_attributes, redact_dict, redact_text

# ── Secret generators ─────────────────────────────────────────────────────────

# Characters allowed in typical opaque token values (no whitespace).
_TOKEN_CHARS = string.ascii_letters + string.digits + "-._~+/"

# Valid Stellar secret seed alphabet: uppercase A-Z plus digits 2-7 (base32).
_STELLAR_SEED_CHARS = string.ascii_uppercase + "234567"


@st.composite
def bearer_tokens(draw: st.DrawFn) -> str:
    """Generate a plausible Bearer token value (10–60 opaque chars)."""
    return draw(st.text(alphabet=_TOKEN_CHARS, min_size=10, max_size=60).filter(lambda s: len(s.strip()) > 0))


@st.composite
def stellar_seeds(draw: st.DrawFn) -> str:
    """Generate a syntactically valid Stellar secret seed (S + 55 base32 chars)."""
    body = draw(st.text(alphabet=_STELLAR_SEED_CHARS, min_size=55, max_size=55))
    return f"S{body}"


@st.composite
def api_key_values(draw: st.DrawFn) -> str:
    """Generate a plausible API-key value (8–40 alphanum/dash chars)."""
    return draw(st.text(alphabet=string.ascii_letters + string.digits + "-_", min_size=8, max_size=40))


# ── Text-surrounding strategies ───────────────────────────────────────────────

# Safe printable chars for surrounding noise (no null bytes or surrogates).
_NOISE_CHARS = "".join(
    c
    for c in string.printable
    if c not in "\x00\x0b\x0c"  # exclude rare control chars that may be stripped
)


@st.composite
def noise_text(draw: st.DrawFn) -> str:
    """A short string of non-secret safe printable chars."""
    return draw(st.text(alphabet=_NOISE_CHARS, min_size=0, max_size=80))


# ── Helpers ───────────────────────────────────────────────────────────────────

# Keys that are expected to be redacted by redact_dict / redact_attributes.
_SENSITIVE_KEY_FRAGMENTS = (
    "api_key",
    "token",
    "secret",
    "password",
    "private_key",
)

_REDACTED = "[REDACTED]"


def _assert_not_in(secret: str, output: str, *, label: str) -> None:
    """Fail clearly if *secret* appears verbatim in *output*."""
    assert secret not in output, (
        f"Secret leaked in {label}.\n"
        f"  secret:  {secret!r}\n"
        f"  output:  {output!r}"
    )


# ── redact_text: Bearer / Token headers ───────────────────────────────────────


@given(prefix=noise_text(), token=bearer_tokens(), suffix=noise_text())
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_bearer_token_never_leaks_in_text(prefix: str, token: str, suffix: str) -> None:
    """Any Bearer <token> embedded in arbitrary text must be redacted."""
    text = f"{prefix}Authorization: Bearer {token}{suffix}"
    result = redact_text(text)
    _assert_not_in(token, result, label="redact_text(Bearer)")


@given(prefix=noise_text(), token=bearer_tokens(), suffix=noise_text())
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_token_header_never_leaks_in_text(prefix: str, token: str, suffix: str) -> None:
    """Any Token <value> pattern embedded in text must be redacted."""
    text = f"{prefix}Authorization: Token {token}{suffix}"
    result = redact_text(text)
    _assert_not_in(token, result, label="redact_text(Token)")


# ── redact_text: Stellar secret seeds ─────────────────────────────────────────


@given(prefix=noise_text(), seed=stellar_seeds(), suffix=noise_text())
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_stellar_seed_never_leaks_in_text(prefix: str, seed: str, suffix: str) -> None:
    """A Stellar secret seed (S + 55 base32 chars) must be redacted from text."""
    text = f"{prefix}{seed}{suffix}"
    result = redact_text(text)
    _assert_not_in(seed, result, label="redact_text(stellar_seed)")


@given(prefix=noise_text(), seed=stellar_seeds(), suffix=noise_text())
@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
def test_stellar_seed_in_json_string_never_leaks(prefix: str, seed: str, suffix: str) -> None:
    """A Stellar seed embedded inside a JSON value must be redacted."""
    payload = json.dumps({"message": f"{prefix}{seed}{suffix}", "status": "ok"})
    result = redact_text(payload)
    _assert_not_in(seed, result, label="redact_text(stellar_seed in JSON value)")


# ── redact_text: key=value credential patterns ────────────────────────────────


@given(value=api_key_values(), noise=noise_text())
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_api_key_kv_never_leaks(value: str, noise: str) -> None:
    """api_key=<value> pattern in freeform text must be redacted."""
    text = f"{noise} api_key={value} {noise}"
    result = redact_text(text)
    _assert_not_in(value, result, label="redact_text(api_key=)")


@given(value=api_key_values(), noise=noise_text())
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_password_kv_never_leaks(value: str, noise: str) -> None:
    """password=<value> pattern in freeform text must be redacted."""
    text = f"{noise} password={value} {noise}"
    result = redact_text(text)
    _assert_not_in(value, result, label="redact_text(password=)")


@given(value=api_key_values(), noise=noise_text())
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_secret_kv_never_leaks(value: str, noise: str) -> None:
    """secret=<value> pattern in freeform text must be redacted."""
    text = f"{noise} secret={value} {noise}"
    result = redact_text(text)
    _assert_not_in(value, result, label="redact_text(secret=)")


# ── redact_text: JSON payloads with secret field names ────────────────────────


@given(secret_value=api_key_values(), safe_value=st.text(min_size=1, max_size=30))
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_json_secret_field_never_leaks(secret_value: str, safe_value: str) -> None:
    """A JSON object with a 'token' key must have its value redacted."""
    payload = {"token": secret_value, "model": safe_value, "status": "ok"}
    result = redact_text(json.dumps(payload))
    _assert_not_in(secret_value, result, label="redact_text(JSON token field)")


@given(secret_value=api_key_values(), safe_value=st.text(min_size=1, max_size=30))
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_json_api_key_field_never_leaks(secret_value: str, safe_value: str) -> None:
    """A JSON object with an 'api_key' key must have its value redacted."""
    payload = {"api_key": secret_value, "endpoint": safe_value}
    result = redact_text(json.dumps(payload))
    _assert_not_in(secret_value, result, label="redact_text(JSON api_key field)")


@given(secret_value=api_key_values(), safe_value=st.text(min_size=1, max_size=30))
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_json_password_field_never_leaks(secret_value: str, safe_value: str) -> None:
    """A JSON object with a 'password' key must have its value redacted."""
    payload = {"password": secret_value, "username": safe_value}
    result = redact_text(json.dumps(payload))
    _assert_not_in(secret_value, result, label="redact_text(JSON password field)")


# ── redact_text: nested JSON structures ───────────────────────────────────────


@given(secret_value=api_key_values(), outer_noise=noise_text())
@settings(max_examples=150, suppress_health_check=[HealthCheck.too_slow])
def test_nested_json_secret_never_leaks(secret_value: str, outer_noise: str) -> None:
    """A secret in a nested JSON object must be redacted."""
    payload = {
        "outer": outer_noise,
        "request": {
            "headers": {"authorization": secret_value},
            "body": {"api_key": secret_value},
        },
    }
    result = redact_text(json.dumps(payload))
    _assert_not_in(secret_value, result, label="redact_text(nested JSON secret)")


@given(
    token=bearer_tokens(),
    seed=stellar_seeds(),
    noise=noise_text(),
)
@settings(max_examples=150, suppress_health_check=[HealthCheck.too_slow])
def test_multiple_secrets_none_leak(token: str, seed: str, noise: str) -> None:
    """Text containing both a Bearer token and a Stellar seed must redact both."""
    text = f"{noise} Bearer {token} wallet_secret={seed} {noise}"
    result = redact_text(text)
    _assert_not_in(token, result, label="redact_text(multi: bearer)")
    _assert_not_in(seed, result, label="redact_text(multi: stellar_seed)")


# ── redact_text: non-secret content preservation ─────────────────────────────


@given(
    safe_word=st.from_regex(r"[a-z]{4,20}", fullmatch=True),
    prefix=noise_text(),
    suffix=noise_text(),
)
@settings(max_examples=150, suppress_health_check=[HealthCheck.too_slow])
def test_non_secret_text_preserved(safe_word: str, prefix: str, suffix: str) -> None:
    """Plain text that contains no secrets must survive redaction intact.

    We verify that a safe alphabetic word (no secret-like keywords) is not
    dropped by ``redact_text``.
    """
    # Exclude known trigger words from the safe_word corpus.
    _TRIGGER = re.compile(
        r"(bearer|token|secret|api.?key|password|private|authorization|x.payment|seed|mnemonic|signature)",
        re.I,
    )
    if _TRIGGER.search(safe_word):
        return  # skip words that happen to match; not a failure

    text = f"{prefix} {safe_word} {suffix}"
    result = redact_text(text)
    # The safe word must remain in the output (possibly truncated if very long
    # texts exceed LOG_RESPONSE_SUMMARY_MAX_CHARS, which is 1024).
    combined_len = len(text)
    if combined_len <= 1024:
        assert safe_word in result, (
            f"Safe word {safe_word!r} was incorrectly removed from redact_text output.\n"
            f"  input:  {text!r}\n"
            f"  output: {result!r}"
        )


# ── redact_dict: sensitive keys are always redacted ───────────────────────────


@given(
    secret_value=api_key_values(),
    safe_key=st.from_regex(r"[a-z]{3,10}", fullmatch=True),
    safe_value=st.text(min_size=1, max_size=40),
)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_redact_dict_token_key_always_redacted(
    secret_value: str,
    safe_key: str,
    safe_value: str,
) -> None:
    """redact_dict must redact any value stored under a 'token'-containing key."""
    sensitive_key = f"{safe_key}_token"
    payload = {sensitive_key: secret_value, safe_key: safe_value}
    result = redact_dict(payload)
    assert result[sensitive_key] == _REDACTED, (
        f"Value for key {sensitive_key!r} was not redacted."
    )
    _assert_not_in(secret_value, str(result), label="redact_dict(token key)")


@given(
    secret_value=api_key_values(),
    safe_key=st.from_regex(r"[a-z]{3,10}", fullmatch=True),
    safe_value=st.text(min_size=1, max_size=40),
)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_redact_dict_secret_key_always_redacted(
    secret_value: str,
    safe_key: str,
    safe_value: str,
) -> None:
    """redact_dict must redact any value stored under a 'secret'-containing key."""
    sensitive_key = f"{safe_key}_secret"
    payload = {sensitive_key: secret_value, safe_key: safe_value}
    result = redact_dict(payload)
    assert result[sensitive_key] == _REDACTED, (
        f"Value for key {sensitive_key!r} was not redacted."
    )


@given(
    safe_key=st.from_regex(r"[a-z]{4,12}", fullmatch=True),
    safe_value=st.text(min_size=0, max_size=50),
)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_redact_dict_preserves_safe_keys(safe_key: str, safe_value: str) -> None:
    """redact_dict must preserve values stored under safe (non-sensitive) keys."""
    _TRIGGER = re.compile(r"key|secret|token|password|private", re.I)
    if _TRIGGER.search(safe_key):
        return  # skip; would legitimately be redacted

    payload = {safe_key: safe_value}
    result = redact_dict(payload)
    assert result[safe_key] == safe_value, (
        f"Safe key {safe_key!r} value was unexpectedly altered.\n"
        f"  expected: {safe_value!r}\n"
        f"  got:      {result[safe_key]!r}"
    )


# ── redact_attributes: secret-named keys are dropped ─────────────────────────


@given(
    secret_value=api_key_values(),
    safe_key=st.from_regex(r"[a-z][a-z0-9_]{2,10}", fullmatch=True),
    safe_value=st.text(min_size=1, max_size=40),
)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_redact_attributes_drops_secret_key(
    secret_value: str,
    safe_key: str,
    safe_value: str,
) -> None:
    """redact_attributes must drop keys matching the secret pattern."""
    attrs: dict = {
        "api_key": secret_value,
        "token": secret_value,
        "secret": secret_value,
        safe_key: safe_value,
    }
    result = redact_attributes(attrs)
    _assert_not_in(secret_value, json.dumps(result), label="redact_attributes(secret keys)")
    assert "api_key" not in result
    assert "token" not in result
    assert "secret" not in result


@given(
    safe_key=st.from_regex(r"[a-z][a-z0-9_]{2,10}", fullmatch=True),
    safe_value=st.text(min_size=1, max_size=40),
)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_redact_attributes_keeps_safe_key(safe_key: str, safe_value: str) -> None:
    """redact_attributes must retain safe (non-sensitive) attribute keys."""
    _TRIGGER = re.compile(
        r"(api.?key|apikey|authorization|secret|password|token|private.?key|"
        r"seed|mnemonic|signature|x.payment)",
        re.I,
    )
    if _TRIGGER.search(safe_key):
        return  # skip keys that the pattern legitimately drops

    attrs = {safe_key: safe_value}
    result = redact_attributes(attrs)
    assert safe_key in result, (
        f"Safe attribute key {safe_key!r} was unexpectedly dropped."
    )


# ── Cross-surface: same secret embedded multiple ways ─────────────────────────


@given(token=bearer_tokens(), seed=stellar_seeds())
@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
def test_cross_surface_no_secret_escapes(token: str, seed: str) -> None:
    """No secret must escape regardless of how it is embedded.

    Covers all three public redaction surfaces in one go.
    """
    # 1. redact_text with a Bearer header
    text_result = redact_text(f"Authorization: Bearer {token}")
    _assert_not_in(token, text_result, label="cross/redact_text(bearer)")

    # 2. redact_text with a Stellar seed
    seed_text_result = redact_text(f"Wallet seed: {seed}")
    _assert_not_in(seed, seed_text_result, label="cross/redact_text(stellar)")

    # 3. redact_dict with a token key
    dict_result = redact_dict({"token": token, "status": "ok"})
    _assert_not_in(token, str(dict_result), label="cross/redact_dict(token)")

    # 4. redact_attributes drops api_key
    attrs_result = redact_attributes({"api_key": token, "provider": "groq"})
    _assert_not_in(token, json.dumps(attrs_result), label="cross/redact_attributes(api_key)")


# ── Regression examples ───────────────────────────────────────────────────────
# Any discovered leaks from Hypothesis shrinking must be captured here as
# named examples so they always run in CI regardless of the seed.


def test_regression_bearer_with_equals_padding() -> None:
    """Bearer tokens with base64 padding chars must be fully redacted."""
    token = "eyJhbGciOiJSUzI1NiJ9.payload.sig=="
    result = redact_text(f"Authorization: Bearer {token}")
    _assert_not_in(token, result, label="regression/bearer_padding")


def test_regression_stellar_seed_at_start_of_string() -> None:
    """A Stellar seed at the very start of a string must still be redacted."""
    seed = "S" + "A" * 55
    result = redact_text(seed)
    _assert_not_in(seed, result, label="regression/stellar_seed_start")


def test_regression_nested_json_multiple_secret_fields() -> None:
    """Multiple secret fields at different nesting levels must all be redacted."""
    api_key = "ak-super-secret-9999"
    bearer = "sk-live-deadbeef0000"
    payload = json.dumps(
        {
            "outer_key": api_key,
            "nested": {
                "authorization": f"Bearer {bearer}",
                "data": {"token": api_key},
            },
        }
    )
    result = redact_text(payload)
    _assert_not_in(api_key, result, label="regression/nested_json_api_key")
    _assert_not_in(bearer, result, label="regression/nested_json_bearer")


def test_regression_secret_straddling_truncation_boundary() -> None:
    """Redaction must occur before truncation to catch secrets near the limit.

    If truncation ran first, the pattern would only see a prefix of the
    secret and fail to match it.
    """
    from talos_agent.http import LOG_RESPONSE_SUMMARY_MAX_CHARS

    filler = "x" * (LOG_RESPONSE_SUMMARY_MAX_CHARS - 20)
    token = "sk-live-bordertoken1"
    text = f"{filler} Bearer {token} end"
    result = redact_text(text)
    _assert_not_in(token, result, label="regression/truncation_boundary")
