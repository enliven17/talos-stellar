from talos_agent.scheduler.policy import build_consistency_report


def test_report_identifies_orphaned_durable_work_without_mutating_state():
    report = build_consistency_report(
        {"agent_cycle", "stale_execution"},
        {"agent_cycle", "polling"},
    )

    assert report.matched == ("agent_cycle",)
    assert report.orphaned_durable == ("stale_execution",)
    assert report.untracked_active == ("polling",)
    assert report.uncertain == ()
    assert any("Review 1" in step for step in report.recovery_plan)


def test_report_marks_missing_observations_uncertain_instead_of_orphaned():
    report = build_consistency_report(
        {"stale_execution"},
        set(),
        active_source_available=False,
    )

    assert report.orphaned_durable == ()
    assert report.uncertain == ("active asyncio task snapshot unavailable",)
    assert report.recovery_plan[0].startswith("Retry the observation")
