"""Tests for scripts/generate_tool_docs.py.

Covers the --check mode: the test fails when the on-disk docs/tools.md is
stale, and passes when it matches freshly generated output.

The test imports the generator directly rather than spawning a subprocess so
that it runs inside the same Python environment as the rest of the test suite.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# ── Ensure scripts/ is importable ───────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent  # workspace root
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import generate_tool_docs  # noqa: E402  (after sys.path mutation)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_fresh_content() -> str:
    """Build the registry and render the Markdown without touching disk."""
    reg = generate_tool_docs.build_registry()
    return generate_tool_docs.generate_markdown(reg)


# ── Tests ────────────────────────────────────────────────────────────────────


def test_check_mode_passes_when_file_is_current(tmp_path: Path) -> None:
    """--check exits 0 when the on-disk file matches freshly generated output."""
    content = _get_fresh_content()
    output = tmp_path / "tools.md"
    output.write_text(content, encoding="utf-8")

    exit_code = generate_tool_docs.main(["--output", str(output), "--check"])
    assert exit_code == 0, "Expected exit code 0 when file is up to date"


def test_check_mode_fails_when_file_is_stale(tmp_path: Path) -> None:
    """--check exits 1 when the on-disk file is stale (missing a tool)."""
    content = _get_fresh_content()
    # Corrupt the content to simulate a stale file (e.g. tool added after last regen)
    stale_content = content + "\n<!-- deliberately stale -->\n"
    output = tmp_path / "tools.md"
    output.write_text(stale_content, encoding="utf-8")

    exit_code = generate_tool_docs.main(["--output", str(output), "--check"])
    assert exit_code == 1, "Expected exit code 1 when file is stale"


def test_check_mode_fails_when_file_is_missing(tmp_path: Path) -> None:
    """--check exits 1 when docs/tools.md does not exist yet."""
    output = tmp_path / "tools.md"
    # Do not create the file

    exit_code = generate_tool_docs.main(["--output", str(output), "--check"])
    assert exit_code == 1, "Expected exit code 1 when file is absent"


def test_generate_lists_all_tools() -> None:
    """The generated content must reference every tool registered in the registry."""
    reg = generate_tool_docs.build_registry()
    content = generate_tool_docs.generate_markdown(reg)

    for tool_obj in reg.all_tools():
        assert f"`{tool_obj.name}`" in content, (
            f"Tool '{tool_obj.name}' is missing from the generated catalogue. "
            "Regenerate docs/tools.md with: python scripts/generate_tool_docs.py"
        )


def test_committed_tools_md_is_not_stale() -> None:
    """The committed packages/prime-agent/docs/tools.md must be current.

    This test is the CI gate: adding a new @tool without regenerating the
    catalogue causes this test to fail.
    """
    committed = REPO_ROOT / "packages" / "prime-agent" / "docs" / "tools.md"
    assert committed.exists(), (
        "packages/prime-agent/docs/tools.md is missing. "
        "Run: python scripts/generate_tool_docs.py"
    )

    fresh = _get_fresh_content()
    on_disk = committed.read_text(encoding="utf-8")

    assert on_disk == fresh, (
        "packages/prime-agent/docs/tools.md is stale. "
        "Run: python scripts/generate_tool_docs.py"
    )
