import pytest
from talos_agent.adapters.x import sanitize_outbound_x_content


def test_sanitize_outbound_accepts_normal_text():
    assert sanitize_outbound_x_content("hello world") == "hello world"


def test_sanitize_outbound_rejects_secrets():
    with pytest.raises(ValueError):
        sanitize_outbound_x_content("leak ghp_abcdefghijklmnopqrstuvwx1234567890")


def test_sanitize_outbound_bounds_length():
    out = sanitize_outbound_x_content("x" * 500, max_len=280)
    assert len(out) <= 280


def test_sanitize_outbound_rejects_empty():
    with pytest.raises(ValueError):
        sanitize_outbound_x_content("   ")
