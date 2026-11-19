"""Scheduler package — composable task modules for the agent run loop.

Public surface re-exported here so existing imports from
``talos_agent.scheduler`` continue to work unchanged.
"""

from __future__ import annotations

# Core backoff primitives
from talos_agent.scheduler.backoff import Backoff, DurableBackoff, _validate_jitter

# Run-policy helper (tested in test_scheduler.py / test_scheduler_clock.py)
from talos_agent.scheduler.policy import check_should_run

# Extracted task helpers (tested in test_scheduler.py)
from talos_agent.scheduler.helpers import (
    _is_stellar_public_key,
    run_dividend_distribution,
    run_loan_repayment,
)

# Entry points
from talos_agent.scheduler.runner import (
    SHUTDOWN_GRACE_PERIOD,
    _DEFAULT_CLOCK,
    run,
    run_multi,
)

__all__ = [
    # backoff
    "Backoff",
    "DurableBackoff",
    "_validate_jitter",
    # policy
    "check_should_run",
    # helpers
    "_is_stellar_public_key",
    "run_dividend_distribution",
    "run_loan_repayment",
    # runner
    "SHUTDOWN_GRACE_PERIOD",
    "_DEFAULT_CLOCK",
    "run",
    "run_multi",
]
