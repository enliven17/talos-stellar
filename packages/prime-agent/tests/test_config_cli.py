"""Tests for the talos-agent config CLI command.

Verifies:
1. Secret inputs (Talos API key, OpenAI API key) are hidden at prompt time and
   never echoed in terminal/CLI output.
2. The generated config.json is saved with restricted file permissions (0o600) on POSIX.
3. Pre-existing config files with broader permissions (e.g. 0o644) are tightened to 0o600.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest
from click.testing import CliRunner

from talos_agent.cli import main


def test_config_prompt_hides_input_and_saves_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Prompts for API keys must use hide_input=True and never echo secrets to output."""
    monkeypatch.setattr("talos_agent.cli.APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.config.APP_DIR", tmp_path)

    runner = CliRunner()
    talos_key = "tak_live_secret_alpha_99"
    openai_key = "sk_live_secret_openai_42"

    result = runner.invoke(
        main,
        ["config"],
        input=f"{talos_key}\n{openai_key}\n",
    )

    assert result.exit_code == 0, result.output
    # Secrets must NOT be echoed in the command output
    assert talos_key not in result.output
    assert openai_key not in result.output

    # Config file must be written with the expected secrets
    cfg_file = tmp_path / "config.json"
    assert cfg_file.exists()
    saved = json.loads(cfg_file.read_text(encoding="utf-8"))
    assert saved.get("talos_api_key") == talos_key
    assert saved.get("openai_api_key") == openai_key


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes not supported on Windows")
def test_config_file_mode_restricted_on_posix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Config file must be created with 0o600 (owner read/write only) on POSIX."""
    monkeypatch.setattr("talos_agent.cli.APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.config.APP_DIR", tmp_path)

    runner = CliRunner()
    result = runner.invoke(
        main,
        ["config"],
        input="tak_posix_key\nsk_posix_key\n",
    )

    assert result.exit_code == 0, result.output
    cfg_file = tmp_path / "config.json"
    assert cfg_file.exists()
    mode = stat.S_IMODE(cfg_file.stat().st_mode)
    assert mode == 0o600, f"Expected file mode 0o600, got {oct(mode)}"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes not supported on Windows")
def test_config_tightens_existing_file_mode_on_posix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Existing config files with more permissive modes (e.g. 0o644) must be tightened to 0o600."""
    monkeypatch.setattr("talos_agent.cli.APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.config.APP_DIR", tmp_path)

    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({"existing_pref": "enabled"}), encoding="utf-8")
    os.chmod(cfg_file, 0o644)
    assert stat.S_IMODE(cfg_file.stat().st_mode) == 0o644

    runner = CliRunner()
    result = runner.invoke(
        main,
        ["config"],
        input="tak_update\nsk_update\n",
    )

    assert result.exit_code == 0, result.output
    mode = stat.S_IMODE(cfg_file.stat().st_mode)
    assert mode == 0o600, f"Expected file mode 0o600, got {oct(mode)}"
    saved = json.loads(cfg_file.read_text(encoding="utf-8"))
    assert saved.get("existing_pref") == "enabled"
    assert saved.get("talos_api_key") == "tak_update"
    assert saved.get("openai_api_key") == "sk_update"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes not supported on Windows")
def test_config_with_cli_flags_restricts_file_mode_on_posix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Non-interactive invocation via flags must also ensure 0o600 permissions."""
    monkeypatch.setattr("talos_agent.cli.APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.config.APP_DIR", tmp_path)

    runner = CliRunner()
    result = runner.invoke(
        main,
        ["config", "--api-key", "tak_flags", "--openai-key", "sk_flags"],
    )

    assert result.exit_code == 0, result.output
    cfg_file = tmp_path / "config.json"
    assert cfg_file.exists()
    mode = stat.S_IMODE(cfg_file.stat().st_mode)
    assert mode == 0o600, f"Expected file mode 0o600, got {oct(mode)}"
