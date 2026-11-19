"""Test that all Settings fields and documentation requirements in README.md are satisfied."""

from pathlib import Path
import re
from talos_agent.config import Settings


def test_readme_documents_all_settings_fields():
    readme_path = Path(__file__).resolve().parent.parent / "README.md"
    assert readme_path.exists(), f"README.md not found at {readme_path}"

    content = readme_path.read_text(encoding="utf-8")

    # Verify Quickstart section and critical commands are present
    assert "## Quickstart" in content
    assert "pip install -e .[dev]" in content
    assert ".env.example" in content
    assert "TALOS_API_URL" in content
    assert "local-stack.sh" in content
    assert "talos-agent start" in content

    # Verify every setting in Settings model is documented in the README
    missing_fields = []
    for field_name in Settings.model_fields:
        # Check that field is in the README formatted as `field_name`
        pattern = rf"`{field_name}`"
        if not re.search(pattern, content):
            missing_fields.append(field_name)

    assert not missing_fields, f"The following Settings fields are missing from README.md: {missing_fields}"


def test_readme_links_all_prime_agent_docs():
    readme_path = Path(__file__).resolve().parent.parent / "README.md"
    content = readme_path.read_text(encoding="utf-8")

    # Verify links to docs
    expected_doc_links = [
        "a2a_composition.md",
        "adapter-diagnostics.md",
        "adapter-health-snapshots.md",
        "discord-reconnect-policy.md",
        "LOGGING_POLICY.md",
        "policy-engine.md",
        "telegram-rate-limit-queue.md",
        "tool-permissions.md",
        "prime-agent-adapter-capability-sandbox.md",
        "prime-agent-durable-job-effects.md",
        "prime-agent-secret-rotation.md",
        "prime-agent-stellar-retry-failures.md",
    ]

    missing_links = [doc for doc in expected_doc_links if doc not in content]
    assert not missing_links, f"The following doc links are missing from README.md: {missing_links}"
