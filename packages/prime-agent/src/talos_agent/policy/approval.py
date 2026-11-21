"""Policy approval store — persistence for policy approvals bound to digests.

This module provides :class:`PolicyApprovalStore` which persists and retrieves
:class:`PolicyApproval` records, ensuring canonical action and policy identities
are stored across agent execution cycles.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from talos_agent.policy.schema import PolicyApproval

if TYPE_CHECKING:
    from talos_agent.db import LocalDB

logger = logging.getLogger(__name__)


class PolicyApprovalStore:
    """Store for PolicyApproval instances, supporting in-memory and LocalDB storage."""

    def __init__(self, db: LocalDB | None = None) -> None:
        self._db = db
        self._memory_store: dict[str, PolicyApproval] = {}

    def save(self, approval: PolicyApproval) -> None:
        """Persist a PolicyApproval."""
        self._memory_store[approval.approval_id] = approval
        if self._db is not None:
            try:
                self._db.save_policy_approval(approval)
            except Exception as exc:
                logger.warning(
                    "Failed to persist policy approval %s to DB: %s",
                    approval.approval_id,
                    exc,
                )

    def get(self, approval_id: str) -> PolicyApproval | None:
        """Retrieve a PolicyApproval by its approval_id."""
        if self._db is not None:
            try:
                db_approval = self._db.get_policy_approval(approval_id)
                if db_approval is not None:
                    self._memory_store[approval_id] = db_approval
                    return db_approval
            except Exception as exc:
                logger.debug(
                    "DB lookup failed for policy approval %s: %s",
                    approval_id,
                    exc,
                )
        return self._memory_store.get(approval_id)

    def update_status(
        self,
        approval_id: str,
        status: str,
        *,
        decided_by: str | None = None,
        reason: str = "",
    ) -> PolicyApproval | None:
        """Update approval status (e.g. 'approved', 'rejected', 'executed')."""
        approval = self.get(approval_id)
        if approval is None:
            return None
        if status == "approved":
            approval.approve(decided_by=decided_by, reason=reason)
        elif status == "rejected":
            approval.reject(decided_by=decided_by, reason=reason)
        elif status == "executed":
            approval.mark_executed()
        else:
            approval.status = status
            if decided_by is not None:
                approval.decided_by = decided_by
            if reason:
                approval.reason = reason
        self.save(approval)
        return approval

    def list_pending(self) -> list[PolicyApproval]:
        """Return all pending approvals."""
        return [app for app in self._memory_store.values() if app.status == "pending"]

    def list_all(self) -> list[PolicyApproval]:
        """Return all approvals."""
        return list(self._memory_store.values())

    def clear(self) -> None:
        """Clear the in-memory store."""
        self._memory_store.clear()
