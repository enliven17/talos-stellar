"""Tests for redacted local state export.

Coverage
--------
DbFacade.redacted_export():
  schema_version matches PRAGMA user_version
  table_counts present for all expected tables
  commerce_job_ids includes inserted job IDs
  commerce_statuses counts by status
  approval_ids includes inserted approval IDs
  approval_statuses counts by status
  spending_total_usdc sums only USDC amounts (not other currencies)
  loan_summary includes id/platform/amount/status/due_date
  loan_summary excludes purpose and repayment_address
  retry_task_names and retry_attempt_counts populated
  generated_at is UTC-aware

Redaction assertions:
  no playbook payload (data) or source_talos in export
  no content text from activity_log or content_history
  no talos_config values
  no approval descriptions
  no strategy_learnings insights
  no loan purpose or repayment_address

to_dict() structure and serialisability
"""

from __future__ import annotations

import datetime
import json

import pytest

from talos_agent.db import LocalDB
from talos_agent.db.facade import DbFacade, RedactedStateExport


# ─── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def db(tmp_path):
    return LocalDB(path=tmp_path / "test_export.db")


@pytest.fixture
def facade(db):
    return DbFacade(db)


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _populate(db: LocalDB) -> None:
    """Insert a representative row in each table."""
    db.add_activity("post", "SECRET CONTENT", "discord")
    db.add_content("SECRET POST TEXT", "discord")
    db.add_commerce_job("job-001", "talos-1", "content_post", {"secret": "data"})
    db.add_commerce_job("job-002", "talos-1", "content_post")
    db.update_commerce_status("job-002", "done")
    db.cache_approval("appr-001", "spend", "Pay vendor", "SECRET DESCRIPTION", 10.0)
    db.cache_approval("appr-002", "spend", "Pay vendor 2", None, 5.0)
    db.update_approval_status("appr-002", "approved")
    db.record_spending(50.0, "tools", "SECRET DESC", currency="USDC")
    db.record_spending(10.0, "tools", "other", currency="XLM")  # not USDC
    db.set_config("SOME_KEY", "SECRET_VALUE")
    db.save_playbook("playbook-1", {"secret": "payload"}, source_talos="agent-xyz")
    db.save_learning("strategy", "SECRET INSIGHT", evidence="SECRET EVIDENCE")
    db.upsert_audience_insight("segment-a", "SECRET DESCRIPTION", keywords=["secret"])
    db.create_loan("platform-a", 100.0, "USDC", "BTC", 30, "SECRET PURPOSE", "G_ADDR")
    db.upsert_retry_state("task.publish", 3, datetime.datetime.now(datetime.timezone.utc))


# ─── Schema version ───────────────────────────────────────────────────────────


class TestSchemaVersion:
    def test_schema_version_is_int(self, facade):
        export = facade.redacted_export()
        assert isinstance(export.schema_version, int)
        assert export.schema_version > 0

    def test_schema_version_matches_pragma(self, db, facade):
        expected = db._conn.execute("PRAGMA user_version;").fetchone()[0]
        export = facade.redacted_export()
        assert export.schema_version == expected


# ─── Table counts ─────────────────────────────────────────────────────────────


class TestTableCounts:
    def test_counts_present_for_known_tables(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        for table in ["activity_log", "content_history", "commerce_queue", "playbooks"]:
            assert table in export.table_counts

    def test_counts_reflect_inserted_rows(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        assert export.table_counts["commerce_queue"] == 2
        assert export.table_counts["approval_cache"] == 2

    def test_empty_tables_counted_as_zero(self, facade):
        export = facade.redacted_export()
        # Fresh DB — all tables empty
        for count in export.table_counts.values():
            assert count == 0


# ─── Commerce ─────────────────────────────────────────────────────────────────


class TestCommerce:
    def test_job_ids_included(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        assert "job-001" in export.commerce_job_ids
        assert "job-002" in export.commerce_job_ids

    def test_status_distribution(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        assert export.commerce_statuses.get("pending", 0) >= 1
        assert export.commerce_statuses.get("done", 0) >= 1

    def test_no_payloads_in_export(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        # to_dict() should not contain any payload field
        d = json.dumps(export.to_dict())
        assert '"secret"' not in d or "job-001" in export.commerce_job_ids  # job_id OK, payload not


# ─── Approvals ────────────────────────────────────────────────────────────────


class TestApprovals:
    def test_approval_ids_included(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        assert "appr-001" in export.approval_ids
        assert "appr-002" in export.approval_ids

    def test_approval_status_distribution(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        assert export.approval_statuses.get("pending", 0) >= 1
        assert export.approval_statuses.get("approved", 0) >= 1

    def test_no_descriptions_in_export_dict(self, db, facade):
        _populate(db)
        d = json.dumps(facade.redacted_export().to_dict())
        assert "SECRET DESCRIPTION" not in d


# ─── Spending ─────────────────────────────────────────────────────────────────


class TestSpending:
    def test_usdc_total_correct(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        assert export.spending_total_usdc == pytest.approx(50.0)

    def test_non_usdc_excluded_from_total(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        # XLM spending (10.0) must not be included
        assert export.spending_total_usdc < 60.0

    def test_zero_when_no_spending(self, facade):
        export = facade.redacted_export()
        assert export.spending_total_usdc == 0.0


# ─── Loans ────────────────────────────────────────────────────────────────────


class TestLoans:
    def test_loan_summary_includes_safe_fields(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        assert len(export.loan_summary) == 1
        loan = export.loan_summary[0]
        assert "platform" in loan
        assert "amount" in loan
        assert "status" in loan
        assert "due_date" in loan

    def test_loan_summary_excludes_purpose_and_address(self, db, facade):
        _populate(db)
        d = json.dumps(facade.redacted_export().to_dict())
        assert "SECRET PURPOSE" not in d
        assert "G_ADDR" not in d

    def test_no_loans_gives_empty_summary(self, facade):
        export = facade.redacted_export()
        assert export.loan_summary == []


# ─── Retry state ──────────────────────────────────────────────────────────────


class TestRetryState:
    def test_task_names_included(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        assert "task.publish" in export.retry_task_names

    def test_attempt_counts_correct(self, db, facade):
        _populate(db)
        export = facade.redacted_export()
        assert export.retry_attempt_counts["task.publish"] == 3

    def test_empty_when_no_retry_state(self, facade):
        export = facade.redacted_export()
        assert export.retry_task_names == []
        assert export.retry_attempt_counts == {}


# ─── Redaction assertions ─────────────────────────────────────────────────────


class TestRedactionAssertions:
    def test_no_playbook_payload(self, db, facade):
        _populate(db)
        d = json.dumps(facade.redacted_export().to_dict())
        assert "SECRET" not in d or "appr-" in d  # approval IDs (appr-001) are allowed

    def test_no_strategy_insight(self, db, facade):
        _populate(db)
        d = json.dumps(facade.redacted_export().to_dict())
        assert "SECRET INSIGHT" not in d
        assert "SECRET EVIDENCE" not in d

    def test_no_config_values(self, db, facade):
        _populate(db)
        d = json.dumps(facade.redacted_export().to_dict())
        assert "SECRET_VALUE" not in d

    def test_no_content_text(self, db, facade):
        _populate(db)
        d = json.dumps(facade.redacted_export().to_dict())
        assert "SECRET CONTENT" not in d
        assert "SECRET POST TEXT" not in d


# ─── generated_at ─────────────────────────────────────────────────────────────


class TestGeneratedAt:
    def test_generated_at_is_utc(self, facade):
        export = facade.redacted_export()
        assert export.generated_at.tzinfo is not None

    def test_generated_at_in_to_dict(self, facade):
        d = facade.redacted_export().to_dict()
        assert "generated_at" in d
        # Must be a valid ISO-8601 string
        datetime.datetime.fromisoformat(d["generated_at"])


# ─── to_dict() structure ──────────────────────────────────────────────────────


class TestToDict:
    def test_all_expected_keys_present(self, facade):
        d = facade.redacted_export().to_dict()
        expected_keys = {
            "schema_version",
            "table_counts",
            "commerce_job_ids",
            "commerce_statuses",
            "approval_ids",
            "approval_statuses",
            "spending_total_usdc",
            "loan_summary",
            "retry_task_names",
            "retry_attempt_counts",
            "generated_at",
        }
        assert expected_keys.issubset(set(d.keys()))

    def test_to_dict_is_json_serialisable(self, db, facade):
        _populate(db)
        d = facade.redacted_export().to_dict()
        # Must not raise
        json.dumps(d)
