"""Tests for learning tools (record_performance, measure_recent_posts, etc.)."""

from __future__ import annotations

import pytest
from pathlib import Path

from talos_agent.db import LocalDB
from talos_agent.tools.context import ToolContext, use
from talos_agent.tools.learning import (
    MAX_FOLLOWERS,
    MAX_IMPRESSIONS,
    MAX_LIKES,
    MAX_REPLIES,
    MAX_REPOSTS,
    measure_recent_posts,
    record_performance,
)


@pytest.fixture
def test_db(tmp_path: Path) -> LocalDB:
    """Create a temporary database with a seeded content item."""
    db = LocalDB(path=tmp_path / "learning_test.db")
    return db


@pytest.fixture
def seeded_db(test_db: LocalDB) -> tuple[LocalDB, int]:
    """Database with one content item already posted."""
    content_id = test_db.add_content("Test announcement post", "X")
    return test_db, content_id


# ══════════════════════════════════════════════════════════════════════════════
# 1. Negative Metrics Rejection (Parametrised)
# ══════════════════════════════════════════════════════════════════════════════


class TestRecordPerformanceNegativeMetrics:
    """Negative engagement metrics must be rejected and must not write to DB."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "metric_name,negative_val",
        [
            ("likes", -1),
            ("likes", -50),
            ("reposts", -1),
            ("reposts", -100),
            ("replies", -1),
            ("replies", -25),
            ("impressions", -1),
            ("impressions", -1000),
            ("followers_at", -1),
            ("followers_at", -500),
        ],
    )
    async def test_rejects_negative_metric(
        self, seeded_db: tuple[LocalDB, int], metric_name: str, negative_val: int
    ):
        db, content_id = seeded_db
        kwargs = {
            "content_id": content_id,
            "channel": "X",
            "likes": 10,
            "reposts": 5,
            "replies": 2,
            "impressions": 100,
            "followers_at": 50,
        }
        kwargs[metric_name] = negative_val

        with use(ToolContext(db=db)):
            result = await record_performance(**kwargs)

        assert "error" in result
        assert "cannot be negative" in result["error"]
        assert metric_name in result["error"]

        # Verify nothing was written to content_performance
        row_count = db._conn.execute(
            "SELECT COUNT(*) as count FROM content_performance WHERE content_id = ?",
            (content_id,),
        ).fetchone()["count"]
        assert row_count == 0


# ══════════════════════════════════════════════════════════════════════════════
# 2. Content ID Validation (Parametrised)
# ══════════════════════════════════════════════════════════════════════════════


class TestRecordPerformanceContentIdValidation:
    """Non-existent or malformed content_ids must be rejected with structured error."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("missing_id", [9999, 42, 100])
    async def test_rejects_non_existent_content_id(
        self, test_db: LocalDB, missing_id: int
    ):
        with use(ToolContext(db=test_db)):
            result = await record_performance(
                content_id=missing_id,
                likes=10,
                reposts=2,
            )

        assert "error" in result
        assert f"Content ID {missing_id} not found" in result["error"]

        # Ensure no record was written
        row_count = test_db._conn.execute(
            "SELECT COUNT(*) as count FROM content_performance"
        ).fetchone()["count"]
        assert row_count == 0

    @pytest.mark.asyncio
    @pytest.mark.parametrize("invalid_id", [0, -1, -99, "bad_id", True, False, None])
    async def test_rejects_invalid_content_id_types_and_values(
        self, test_db: LocalDB, invalid_id
    ):
        with use(ToolContext(db=test_db)):
            result = await record_performance(
                content_id=invalid_id,
                likes=5,
            )

        assert "error" in result
        assert "Invalid content_id" in result["error"]

        # Ensure no record was written
        row_count = test_db._conn.execute(
            "SELECT COUNT(*) as count FROM content_performance"
        ).fetchone()["count"]
        assert row_count == 0


# ══════════════════════════════════════════════════════════════════════════════
# 3. Metric Type Validation (Parametrised)
# ══════════════════════════════════════════════════════════════════════════════


class TestRecordPerformanceTypeValidation:
    """Non-integer types (booleans, strings, non-integer floats, None) must be rejected."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "metric_name,bad_val",
        [
            ("likes", True),
            ("likes", "100"),
            ("likes", 1.5),
            ("likes", None),
            ("reposts", False),
            ("reposts", "none"),
            ("reposts", 3.14),
            ("replies", "invalid"),
            ("replies", 0.1),
            ("impressions", "thousand"),
            ("impressions", 99.9),
            ("followers_at", True),
            ("followers_at", "500"),
        ],
    )
    async def test_rejects_non_integer_metric_values(
        self, seeded_db: tuple[LocalDB, int], metric_name: str, bad_val
    ):
        db, content_id = seeded_db
        kwargs = {"content_id": content_id, metric_name: bad_val}

        with use(ToolContext(db=db)):
            result = await record_performance(**kwargs)

        assert "error" in result
        assert "must be an integer" in result["error"]

        row_count = db._conn.execute(
            "SELECT COUNT(*) as count FROM content_performance WHERE content_id = ?",
            (content_id,),
        ).fetchone()["count"]
        assert row_count == 0


# ══════════════════════════════════════════════════════════════════════════════
# 4. Absurd Values Clamping (Parametrised)
# ══════════════════════════════════════════════════════════════════════════════


class TestRecordPerformanceClamping:
    """Absurd engagement metrics above documented ceilings must be clamped."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "metric_name,absurd_val,expected_ceiling",
        [
            ("likes", 10**12, MAX_LIKES),
            ("likes", 500_000_000, MAX_LIKES),
            ("reposts", 10**12, MAX_REPOSTS),
            ("reposts", 250_000_000, MAX_REPOSTS),
            ("replies", 10**12, MAX_REPLIES),
            ("replies", 150_000_000, MAX_REPLIES),
            ("impressions", 10**15, MAX_IMPRESSIONS),
            ("impressions", 50_000_000_000, MAX_IMPRESSIONS),
            ("followers_at", 10**12, MAX_FOLLOWERS),
            ("followers_at", 5_000_000_000, MAX_FOLLOWERS),
        ],
    )
    async def test_clamps_absurd_metric_value(
        self,
        seeded_db: tuple[LocalDB, int],
        metric_name: str,
        absurd_val: int,
        expected_ceiling: int,
    ):
        db, content_id = seeded_db
        kwargs = {
            "content_id": content_id,
            "channel": "X",
            "likes": 0,
            "reposts": 0,
            "replies": 0,
            "impressions": 0,
            "followers_at": 0,
        }
        kwargs[metric_name] = absurd_val

        with use(ToolContext(db=db)):
            result = await record_performance(**kwargs)

        assert result["status"] == "recorded"
        assert result["content_id"] == content_id

        # Verify that the value in database was clamped to the documented maximum
        row = db._conn.execute(
            f"SELECT {metric_name} FROM content_performance WHERE content_id = ?",
            (content_id,),
        ).fetchone()
        assert row is not None
        assert row[metric_name] == expected_ceiling


# ══════════════════════════════════════════════════════════════════════════════
# 5. Valid Calls (Parametrised)
# ══════════════════════════════════════════════════════════════════════════════


class TestRecordPerformanceValidCalls:
    """Valid inputs must succeed, write to DB, and return status: recorded."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "likes,reposts,replies,impressions,followers_at,channel",
        [
            (0, 0, 0, 0, 0, "X"),
            (1, 0, 0, 10, 5, "X"),
            (42, 12, 8, 1500, 250, "X"),
            (1000, 250, 100, 50000, 5000, "telegram"),
            (5000, 1200, 450, 250000, 15000, "discord"),
            (MAX_LIKES, MAX_REPOSTS, MAX_REPLIES, MAX_IMPRESSIONS, MAX_FOLLOWERS, "X"),
        ],
    )
    async def test_valid_metrics_recorded_accurately(
        self,
        test_db: LocalDB,
        likes: int,
        reposts: int,
        replies: int,
        impressions: int,
        followers_at: int,
        channel: str,
    ):
        cid = test_db.add_content(f"Post for {channel}", channel)

        with use(ToolContext(db=test_db)):
            result = await record_performance(
                content_id=cid,
                channel=channel,
                likes=likes,
                reposts=reposts,
                replies=replies,
                impressions=impressions,
                followers_at=followers_at,
            )

        assert result == {"status": "recorded", "content_id": cid}

        # Verify database record
        row = test_db._conn.execute(
            "SELECT * FROM content_performance WHERE content_id = ?",
            (cid,),
        ).fetchone()
        assert row is not None
        assert row["channel"] == channel
        assert row["likes"] == likes
        assert row["reposts"] == reposts
        assert row["replies"] == replies
        assert row["impressions"] == impressions
        assert row["followers_at"] == followers_at

    @pytest.mark.asyncio
    async def test_integer_valued_floats_coerced(self, seeded_db: tuple[LocalDB, int]):
        """Integer-valued floats (e.g. 10.0) should be safely accepted as integers."""
        db, content_id = seeded_db

        with use(ToolContext(db=db)):
            result = await record_performance(
                content_id=float(content_id),
                likes=25.0,
                impressions=100.0,
            )

        assert result == {"status": "recorded", "content_id": content_id}

        row = db._conn.execute(
            "SELECT likes, impressions FROM content_performance WHERE content_id = ?",
            (content_id,),
        ).fetchone()
        assert row["likes"] == 25
        assert row["impressions"] == 100


# ══════════════════════════════════════════════════════════════════════════════
# 6. Integration with Measure Recent Posts
# ══════════════════════════════════════════════════════════════════════════════


class TestLearningWorkflowIntegration:
    """Verify measurement workflow from unmeasured content to recorded performance."""

    @pytest.mark.asyncio
    async def test_measure_and_record_flow(self, test_db: LocalDB):
        # 1. Add two posts
        cid1 = test_db.add_content("Post 1 content", "X")
        cid2 = test_db.add_content("Post 2 content", "X")

        with use(ToolContext(db=test_db)):
            # 2. Check unmeasured
            unmeasured = await measure_recent_posts()
            assert unmeasured["status"] == "needs_measurement"
            assert unmeasured["count"] == 2

            # 3. Record performance for first post
            res1 = await record_performance(
                content_id=cid1,
                likes=50,
                reposts=10,
                replies=5,
                impressions=1000,
            )
            assert res1["status"] == "recorded"

            # 4. Check unmeasured now has only 1 post
            unmeasured_after = await measure_recent_posts()
            assert unmeasured_after["status"] == "needs_measurement"
            assert unmeasured_after["count"] == 1
            assert unmeasured_after["posts"][0]["content_id"] == cid2

            # 5. Record performance for second post
            res2 = await record_performance(
                content_id=cid2,
                likes=120,
                reposts=30,
                replies=15,
                impressions=2500,
            )
            assert res2["status"] == "recorded"

            # 6. Check unmeasured is now all measured
            all_done = await measure_recent_posts()
            assert all_done["status"] == "all_measured"
            assert all_done["count"] == 0

        # 7. Check top performing content calculation
        top = test_db.get_top_performing_content(5)
        assert len(top) == 2
        # Post 2 has higher engagement score (120 + 30*2 + 15*1.5 = 202.5 vs 50 + 10*2 + 5*1.5 = 77.5)
        assert top[0]["likes"] == 120
        assert top[1]["likes"] == 50
