"""Tests for LocalDB — SQLite schema, queries, lifecycles."""

from __future__ import annotations


from talos_agent.db import LocalDB


def test_all_tables_exist(mock_db: LocalDB):
    """All expected tables are created on init."""
    tables = {
        row[0]
        for row in mock_db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    expected = {
        "schedules", "activity_log", "content_history", "commerce_queue",
        "approval_cache", "spending_log", "talos_config", "playbooks",
        "content_performance", "strategy_learnings", "audience_insights",
        "loans", "loan_repayments", "dividends_log",
    }
    assert expected.issubset(tables), f"Missing tables: {expected - tables}"


def test_wal_mode(mock_db: LocalDB):
    mode = mock_db._conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode == "wal"


class TestCountToday:
    def test_empty_returns_zero(self, mock_db: LocalDB):
        assert mock_db.count_today("post") == 0

    def test_counts_correct_type(self, mock_db: LocalDB):
        mock_db.add_activity("post", "hello", "X")
        mock_db.add_activity("post", "world", "X")
        mock_db.add_activity("research", "notes", "web")
        assert mock_db.count_today("post") == 2
        assert mock_db.count_today("research") == 1


class TestSpendingPeriod:
    def test_empty_returns_zero(self, mock_db: LocalDB):
        assert mock_db.get_spending_period(30) == 0.0

    def test_sums_within_range(self, mock_db: LocalDB):
        mock_db.record_spending(10.0, "x402_purchase", "svc A")
        mock_db.record_spending(5.5, "x402_purchase", "svc B")
        assert mock_db.get_spending_period(30) == 15.5

    def test_excludes_old_records(self, mock_db: LocalDB):
        mock_db.record_spending(100.0, "old", "ancient purchase")
        # Backdate the record to 60 days ago
        mock_db._conn.execute(
            "UPDATE spending_log SET created_at = datetime('now', '-60 days')"
        )
        mock_db._conn.commit()
        assert mock_db.get_spending_period(30) == 0.0


class TestCommerceLifecycle:
    def test_add_and_update(self, mock_db: LocalDB):
        mock_db.add_commerce_job("job-1", "talos-a", "trend_research", {"q": "AI"})
        mock_db.update_commerce_status("job-1", "completed")
        row = mock_db._conn.execute(
            "SELECT status FROM commerce_queue WHERE job_id = 'job-1'"
        ).fetchone()
        assert row["status"] == "completed"

    def test_duplicate_ignored(self, mock_db: LocalDB):
        mock_db.add_commerce_job("job-dup", "c1", "svc")
        mock_db.add_commerce_job("job-dup", "c2", "svc2")  # Should be ignored
        rows = mock_db._conn.execute(
            "SELECT * FROM commerce_queue WHERE job_id = 'job-dup'"
        ).fetchall()
        assert len(rows) == 1
        assert rows[0]["talos_id"] == "c1"


class TestLearningsLifecycle:
    def test_save_returns_id(self, mock_db: LocalDB):
        lid = mock_db.save_learning("content", "short posts work better", "data", 0.8)
        assert isinstance(lid, int)
        assert lid > 0

    def test_get_active_learnings(self, mock_db: LocalDB):
        mock_db.save_learning("content", "insight A", confidence=0.9)
        learnings = mock_db.get_active_learnings(10)
        assert len(learnings) >= 1
        assert learnings[0]["insight"] == "insight A"

    def test_expired_excluded(self, mock_db: LocalDB):
        lid = mock_db.save_learning("old", "stale insight", confidence=0.5, expires_days=1)
        # Backdate expiry
        mock_db._conn.execute(
            "UPDATE strategy_learnings SET expires_at = datetime('now', '-2 days') WHERE id = ?",
            (lid,),
        )
        mock_db._conn.commit()
        learnings = mock_db.get_active_learnings(10)
        assert all(learning["insight"] != "stale insight" for learning in learnings)

    def test_ordered_by_confidence(self, mock_db: LocalDB):
        mock_db.save_learning("a", "low", confidence=0.3)
        mock_db.save_learning("b", "high", confidence=0.9)
        mock_db.save_learning("c", "mid", confidence=0.6)
        learnings = mock_db.get_active_learnings(10)
        confidences = [learning["confidence"] for learning in learnings]
        assert confidences == sorted(confidences, reverse=True)


class TestLoanLifecycle:
    def test_create_loan_returns_id(self, mock_db: LocalDB):
        loan_id = mock_db.create_loan(
            platform="aave",
            amount=100.0,
            collateral_asset="USDC",
            loan_asset="XLM",
            duration_days=30,
            purpose="Test loan",
        )
        assert isinstance(loan_id, int)
        assert loan_id > 0

    def test_get_active_loans(self, mock_db: LocalDB):
        mock_db.create_loan("aave", 100.0, "USDC", "XLM", 30, "Test 1")
        mock_db.create_loan("compound", 50.0, "USDC", "XLM", 15, "Test 2")
        loans = mock_db.get_active_loans()
        assert len(loans) == 2
        assert all(loan["status"] == "active" for loan in loans)

    def test_get_loan_by_id(self, mock_db: LocalDB):
        loan_id = mock_db.create_loan("aave", 100.0, "USDC", "XLM", 30, "Test")
        loan = mock_db.get_loan_by_id(loan_id)
        assert loan is not None
        assert loan["platform"] == "aave"
        assert loan["amount"] == 100.0
        assert loan["outstanding_amount"] == 100.0

    def test_partial_repayment_decreases_outstanding(self, mock_db: LocalDB):
        loan_id = mock_db.create_loan("aave", 100.0, "USDC", "XLM", 30, "Test")
        mock_db.record_repayment(loan_id, 25.0)
        loan = mock_db.get_loan_by_id(loan_id)
        assert loan["outstanding_amount"] == 75.0
        assert loan["status"] == "active"

    def test_full_repayment_sets_status_repaid(self, mock_db: LocalDB):
        loan_id = mock_db.create_loan("aave", 100.0, "USDC", "XLM", 30, "Test")
        mock_db.record_repayment(loan_id, 100.0)
        loan = mock_db.get_loan_by_id(loan_id)
        assert loan["outstanding_amount"] == 0.0
        assert loan["status"] == "repaid"

    def test_repayment_records_tx_hash(self, mock_db: LocalDB):
        loan_id = mock_db.create_loan("aave", 100.0, "USDC", "XLM", 30, "Test")
        mock_db.record_repayment(loan_id, 50.0, tx_hash="abc123")
        # Check repayment record
        rows = mock_db._conn.execute(
            "SELECT tx_hash FROM loan_repayments WHERE loan_id = ?",
            (loan_id,),
        ).fetchall()
        assert len(rows) == 1
        assert rows[0]["tx_hash"] == "abc123"

    def test_get_loans_due_soon(self, mock_db: LocalDB):
        # Create a loan due in 5 days
        loan_id_1 = mock_db.create_loan("aave", 100.0, "USDC", "XLM", 5, "Due soon")
        # Create a loan due in 30 days
        loan_id_2 = mock_db.create_loan("compound", 50.0, "USDC", "XLM", 30, "Due later")
        
        loans_due = mock_db.get_loans_due_soon(days=7)
        loan_ids = [loan["id"] for loan in loans_due]
        
        assert loan_id_1 in loan_ids
        assert loan_id_2 not in loan_ids

class TestDividendLifecycle:
    def test_record_dividend_returns_id(self, mock_db):
        div_id = mock_db.record_dividend(
            recipient_address="GABC123",
            token_symbol="VEGA",
            amount=10.0,
        )
        assert isinstance(div_id, int)
        assert div_id > 0

    def test_get_dividend_history_all(self, mock_db):
        mock_db.record_dividend("GABC123", "VEGA", 10.0)
        mock_db.record_dividend("GXYZ456", "ATLAS", 5.0)
        history = mock_db.get_dividend_history()
        assert len(history) == 2

    def test_get_dividend_history_filtered_by_recipient(self, mock_db):
        mock_db.record_dividend("GABC123", "VEGA", 10.0)
        mock_db.record_dividend("GXYZ456", "ATLAS", 5.0)
        history = mock_db.get_dividend_history(recipient_address="GABC123")
        assert len(history) == 1
        assert history[0]["recipient_address"] == "GABC123"

    def test_record_dividend_with_spending_log_link(self, mock_db):
        mock_db.record_spending(10.0, "dividend", "payout")
        row = mock_db._conn.execute(
            "SELECT id FROM spending_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
        spending_id = row["id"]
        mock_db.record_dividend(
            recipient_address="GABC123",
            token_symbol="VEGA",
            amount=10.0,
            spending_log_id=spending_id,
        )
        history = mock_db.get_dividend_history()
        assert history[0]["spending_log_id"] == spending_id

    def test_record_dividend_with_tx_hash(self, mock_db):
        mock_db.record_dividend("GABC123", "VEGA", 10.0, tx_hash="txabc123")
        history = mock_db.get_dividend_history()
        assert history[0]["tx_hash"] == "txabc123"
