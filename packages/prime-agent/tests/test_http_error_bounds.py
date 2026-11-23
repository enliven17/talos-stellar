from __future__ import annotations

import httpx

from talos_agent.http import _extract_safe_response_summary


def test_remote_error_body_is_bounded_before_decoding_and_redaction():
    response = httpx.Response(
        502,
        content=b"Bearer " + b"x" * 10000,
        request=httpx.Request("GET", "https://provider.test"),
    )

    summary = _extract_safe_response_summary(response)

    assert summary is not None
    assert len(summary.encode("utf-8")) <= 1024
    assert "x" * 200 not in summary
    assert "[REDACTED]" in summary


def test_malformed_remote_body_is_decoded_with_replacement():
    response = httpx.Response(
        503,
        content=b"prefix\xffsuffix",
        request=httpx.Request("GET", "https://provider.test"),
    )

    assert _extract_safe_response_summary(response) == "prefix\ufffdsuffix"
