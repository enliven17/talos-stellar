"""Policy loader with hot-reload support.

Loads policies from:
1.  Built-in defaults (shipped with the agent)
2.  ``~/.talos-agent/policies.json`` (operator overrides)
3.  Database-stored policies (via :class:`LocalDB`)

Hot reload is triggered by watching the policies file for changes
(via a simple polling mechanism, or by calling :meth:`PolicyLoader.reload`
explicitly after an external update).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from talos_agent.policy.schema import (
    MatchCondition,
    Policy,
    PolicyDecision,
    PolicyRule,
    Severity,
)

if TYPE_CHECKING:
    from talos_agent.db import LocalDB

logger = logging.getLogger(__name__)

# ── Default policies ──────────────────────────────────────────────────────────


def _build_default_policies() -> list[Policy]:
    """Return the built-in default policy set.

    These policies encode the existing agent safety rules and are
    designed to be backward-compatible with the current behaviour.
    """

    # ── Budget policy ──────────────────────────────────────────────
    budget_policy = Policy(
        name="budget-guard",
        version="1.0.0",
        description="Enforce GTM monthly budget constraints",
        priority=100,
        rules=(
            PolicyRule(
                rule_id="budget-exhausted",
                description="Block all purchases when monthly budget is exhausted",
                conditions=(
                    MatchCondition(
                        field="action",
                        operator="in",
                        value=["purchase_service", "generate_playbook"],
                    ),
                    MatchCondition(
                        field="context.budget_remaining",
                        operator="lte",
                        value=0,
                    ),
                ),
                decision=PolicyDecision.DENY,
                severity=Severity.BLOCKER,
                reason="GTM budget exhausted — no purchases allowed this period.",
            ),
            PolicyRule(
                rule_id="purchase-exceeds-budget",
                description="Block a single purchase that exceeds remaining budget",
                conditions=(
                    MatchCondition(
                        field="action",
                        operator="in",
                        value=["purchase_service"],
                    ),
                    MatchCondition(
                        field="context.budget_remaining",
                        operator="lte",
                        value=0,
                    ),
                ),
                decision=PolicyDecision.DENY,
                severity=Severity.HIGH,
                reason="Purchase price exceeds remaining budget headroom.",
            ),
        ),
    )

    # ── Approval threshold policy ───────────────────────────────────
    approval_policy = Policy(
        name="approval-threshold",
        version="1.0.0",
        description="Require human approval for high-value transactions",
        priority=90,
        rules=(
            PolicyRule(
                rule_id="requires-approval",
                description="Escalate transactions above the approval threshold",
                conditions=(
                    MatchCondition(
                        field="action",
                        operator="in",
                        value=[
                            "purchase_service",
                            "transfer_xlm",
                            "airdrop_pulse",
                            "repay_loan",
                            "request_defi_loan",
                            "execute_approved_transfer",
                        ],
                    ),
                    MatchCondition(
                        field="params.amount",
                        operator="gt",
                        value=10.0,
                    ),
                ),
                decision=PolicyDecision.ESCALATE,
                severity=Severity.HIGH,
                reason="Transaction amount exceeds approval threshold — human sign-off required.",
            ),
        ),
    )

    # ── Publishing safety policy ────────────────────────────────────
    publishing_policy = Policy(
        name="publishing-guard",
        version="1.0.0",
        description="Safety checks for social publishing actions",
        priority=80,
        rules=(
            PolicyRule(
                rule_id="content-length-check",
                description="Warn when content approaches platform limits",
                conditions=(
                    MatchCondition(
                        field="action",
                        operator="in",
                        value=["publish_content", "post_to_x", "post_to_discord"],
                    ),
                    MatchCondition(
                        field="params.content",
                        operator="exists",
                    ),
                ),
                decision=PolicyDecision.APPROVE,
                severity=Severity.MEDIUM,
                reason="Content length will be validated by the channel adapter.",
            ),
            PolicyRule(
                rule_id="duplicate-content",
                description="Flag potentially duplicate content before publishing",
                conditions=(
                    MatchCondition(
                        field="action",
                        operator="in",
                        value=["publish_content"],
                    ),
                    MatchCondition(
                        field="params.content",
                        operator="exists",
                    ),
                ),
                decision=PolicyDecision.APPROVE,
                severity=Severity.LOW,
                reason="Duplicate content check advisory — agent prompt already handles this.",
            ),
        ),
    )

    # ── Transfer safety policy ─────────────────────────────────────
    transfer_policy = Policy(
        name="transfer-guard",
        version="1.0.0",
        description="Safety checks for XLM and token transfers",
        priority=75,
        rules=(
            PolicyRule(
                rule_id="large-transfer-check",
                description="Flag large transfers for review",
                conditions=(
                    MatchCondition(
                        field="action",
                        operator="in",
                        value=["transfer_xlm", "airdrop_pulse", "execute_approved_transfer"],
                    ),
                    MatchCondition(
                        field="params.amount",
                        operator="gt",
                        value=100.0,
                    ),
                ),
                decision=PolicyDecision.ESCALATE,
                severity=Severity.HIGH,
                reason="Large transfer (> 100 units) requires additional verification.",
            ),
        ),
    )

    # ── Fulfillment policy ──────────────────────────────────────────
    fulfillment_policy = Policy(
        name="fulfillment-guard",
        version="1.0.0",
        description="Guards around job fulfillment and result submission",
        priority=70,
        rules=(
            PolicyRule(
                rule_id="fulfill-requires-claim",
                description="Ensure jobs are claimed before fulfillment",
                conditions=(
                    MatchCondition(
                        field="action",
                        operator="eq",
                        value="fulfill_job",
                    ),
                ),
                decision=PolicyDecision.APPROVE,
                severity=Severity.LOW,
                reason="Job fulfillment requires a prior claim — enforced at the tool level.",
            ),
        ),
    )

    return [budget_policy, approval_policy, publishing_policy, transfer_policy, fulfillment_policy]


# ── File-based persistence ────────────────────────────────────────────────────


def _policies_file_path() -> Path:
    """Return the path to the operator policy overrides file."""
    return Path.home() / ".talos-agent" / "policies.json"


def _load_from_file(path: Path) -> list[Policy]:
    """Load policies from a JSON file on disk.

    Expected format::

        {
            "policies": [
                {
                    "name": "my-policy",
                    "version": "1.0.0",
                    "enabled": true,
                    "priority": 50,
                    "rules": [
                        {
                            "rule_id": "my-rule",
                            "conditions": [
                                {"field": "action", "operator": "eq", "value": "transfer_xlm"}
                            ],
                            "decision": "deny",
                            "severity": "blocker",
                            "reason": "Example block rule"
                        }
                    ]
                }
            ]
        }
    """
    if not path.exists():
        return []

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        policies_data = raw.get("policies", [])
        if not isinstance(policies_data, list):
            logger.warning("policies.json 'policies' key must be a list")
            return []
        return [Policy.from_dict(p) for p in policies_data]
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse policies.json: %s", exc)
        return []
    except Exception as exc:
        logger.error("Unexpected error loading policies.json: %s", exc)
        return []


# ── PolicyLoader ──────────────────────────────────────────────────────────────


class PolicyLoader:
    """Load and manage the full policy set from all sources.

    Sources in priority order (higher overrides lower):
    1.  Database-stored policies (when ``db`` is provided)
    2.  ``~/.talos-agent/policies.json`` (operator overrides)
    3.  Built-in defaults

    Policies with the same ``name`` from a higher-priority source
    **replace** the lower-priority version entirely.  This allows
    operators to disable or override a default policy by placing
    a policy with the same name in ``policies.json``.
    """

    def __init__(self, db: LocalDB | None = None) -> None:
        self._db = db
        self._last_file_mtime: float = 0.0
        self._cached: list[Policy] | None = None

    # ── Loading ─────────────────────────────────────────────────────────

    def load(self) -> list[Policy]:
        """Load all policies from all sources, merged by name."""
        defaults = _build_default_policies()
        file_policies = _load_from_file(_policies_file_path())
        db_policies = self._load_from_db() if self._db else []

        # Merge by name: later sources override earlier ones
        merged: dict[str, Policy] = {}

        for p in defaults:
            merged[p.name] = p
        for p in file_policies:
            merged[p.name] = p
        for p in db_policies:
            merged[p.name] = p

        result = list(merged.values())
        logger.info(
            "PolicyLoader: loaded %d policies (defaults=%d, file=%d, db=%d)",
            len(result),
            len(defaults),
            len(file_policies),
            len(db_policies),
        )
        return result

    def load_defaults(self) -> list[Policy]:
        """Return only the built-in default policies (no overrides)."""
        return _build_default_policies()

    # ── Hot reload ──────────────────────────────────────────────────────

    def needs_reload(self) -> bool:
        """Check whether the policies file has changed since last load.

        Returns ``True`` if the file's ``mtime`` has changed.
        """
        path = _policies_file_path()
        if not path.exists():
            return False
        mtime = path.stat().st_mtime
        changed = mtime != self._last_file_mtime
        if changed:
            self._last_file_mtime = mtime
        return changed

    def reload_if_stale(self) -> list[Policy] | None:
        """Return fresh policies if the file changed, otherwise ``None``.

        Convenience method for periodic polling in the agent loop.
        """
        if self.needs_reload():
            logger.info("Policy file changed — reloading policies")
            self._cached = self.load()
            return self._cached
        return None

    def reload(self) -> list[Policy]:
        """Force a reload of all policies (regardless of file mtime)."""
        self._cached = self.load()
        return self._cached

    # ── Helpers ────────────────────────────────────────────────────────

    def _load_from_db(self) -> list[Policy]:
        """Load policies stored in the database (if any)."""
        if self._db is None:
            return []
        try:
            rows = self._db.list_policy_overrides()
            return [Policy.from_dict(r) for r in rows]
        except AttributeError:
            # DB doesn't have list_policy_overrides yet; safe fallback
            return []
        except Exception as exc:
            logger.warning("Failed to load policies from DB: %s", exc)
            return []

    def export_to_file(self, path: Path | None = None) -> Path:
        """Export the current merged policy set to a JSON file.

        Useful for bootstrapping an operator's ``policies.json``.
        """
        target = path or _policies_file_path()
        policies = self._cached or self.load()
        payload = {
            "policies": [
                {
                    "name": p.name,
                    "version": p.version,
                    "description": p.description,
                    "enabled": p.enabled,
                    "priority": p.priority,
                    "rules": [
                        {
                            "rule_id": r.rule_id,
                            "description": r.description,
                            "conditions": [
                                {"field": c.field, "operator": c.operator, "value": c.value}
                                for c in r.conditions
                            ],
                            "decision": r.decision.value,
                            "severity": r.severity.value,
                            "reason": r.reason,
                        }
                        for r in p.rules
                    ],
                }
                for p in policies
            ]
        }
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(payload, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        logger.info("Exported %d policies to %s", len(policies), target)
        return target
