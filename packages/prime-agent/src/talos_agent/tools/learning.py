"""Learning tools — performance review, strategy learnings, audience insights."""

from __future__ import annotations

import json
import math
from typing import TYPE_CHECKING

from rich.console import Console

from talos_agent.agent.loop import get_openai_client
from talos_agent.tools import context as _context
from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB

console = Console()

# Documented maximum plausible values for engagement metrics.
# Values exceeding these ceilings are clamped to avoid skewing downstream analytics
# and prevent overflow while still recording the interaction.
MAX_LIKES: int = 100_000_000
MAX_REPOSTS: int = 100_000_000
MAX_REPLIES: int = 100_000_000
MAX_IMPRESSIONS: int = 10_000_000_000
MAX_FOLLOWERS: int = 2_000_000_000
MAX_METRIC_DEFAULT: int = 1_000_000_000

MAX_METRIC_VALUES: dict[str, int] = {
    "likes": MAX_LIKES,
    "reposts": MAX_REPOSTS,
    "replies": MAX_REPLIES,
    "impressions": MAX_IMPRESSIONS,
    "followers_at": MAX_FOLLOWERS,
}

# Injected by registry.build_all_tools
_db: LocalDB = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]


def _deps():
    """This agent's dependencies: the bound ToolContext, else this module's globals."""
    return _context.resolve(globals())


@tool(
    "measure_recent_posts",
    "Measure engagement for recent posts that haven't been measured yet. "
    "Call check_post_performance for each, then store results. Returns list of unmeasured posts.",
)
async def measure_recent_posts() -> dict:
    unmeasured = _deps().db.get_unmeasured_content(10)
    if not unmeasured:
        return {"status": "all_measured", "count": 0}
    return {
        "status": "needs_measurement",
        "posts": [
            {
                "content_id": p["id"],
                "content": p["content"][:100],
                "channel": p["channel"],
                "posted_at": p["posted_at"],
            }
            for p in unmeasured
        ],
        "count": len(unmeasured),
        "instruction": (
            "For each post, call check_post_performance with the content snippet, "
            "then call record_performance with the results."
        ),
    }


@tool(
    "record_performance",
    "Record engagement metrics for a specific post after measuring it via check_post_performance.",
)
async def record_performance(
    content_id: int,
    channel: str = "X",
    likes: int = 0,
    reposts: int = 0,
    replies: int = 0,
    impressions: int = 0,
    followers_at: int = 0,
) -> dict:
    """Record engagement metrics for a post.

    Rejects non-existent content_id and negative metrics with a structured error.
    Clamps absurd values exceeding documented ceilings (MAX_METRIC_VALUES).
    """
    if isinstance(content_id, bool):
        return {"error": f"Invalid content_id: {content_id}"}
    if isinstance(content_id, float) and content_id.is_integer():
        content_id = int(content_id)
    if not isinstance(content_id, int) or content_id <= 0:
        return {"error": f"Invalid content_id: {content_id}"}

    db = _deps().db
    if db is None:
        return {"error": "Database not initialized"}

    exists = False
    if hasattr(db, "content_exists"):
        exists = db.content_exists(content_id)
    elif hasattr(db, "get_content"):
        exists = db.get_content(content_id) is not None
    elif hasattr(db, "_conn") and db._conn is not None:
        row = db._conn.execute(
            "SELECT 1 FROM content_history WHERE id = ?", (content_id,)
        ).fetchone()
        exists = row is not None

    if not exists:
        return {"error": f"Content ID {content_id} not found"}

    raw_metrics = {
        "likes": likes,
        "reposts": reposts,
        "replies": replies,
        "impressions": impressions,
        "followers_at": followers_at,
    }

    clamped_metrics: dict[str, int] = {}
    for name, val in raw_metrics.items():
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            return {"error": f"Metric '{name}' must be an integer, got {type(val).__name__}"}
        if isinstance(val, float):
            if not math.isfinite(val) or not val.is_integer():
                return {"error": f"Metric '{name}' must be an integer, got {val}"}
            val = int(val)
        if val < 0:
            return {"error": f"Metric '{name}' cannot be negative (got {val})"}
        max_limit = MAX_METRIC_VALUES.get(name, MAX_METRIC_DEFAULT)
        clamped_metrics[name] = min(val, max_limit)

    channel_clean = channel.strip() if isinstance(channel, str) and channel.strip() else "X"

    db.record_performance(
        content_id=content_id,
        channel=channel_clean,
        likes=clamped_metrics["likes"],
        reposts=clamped_metrics["reposts"],
        replies=clamped_metrics["replies"],
        impressions=clamped_metrics["impressions"],
        followers_at=clamped_metrics["followers_at"],
    )
    return {"status": "recorded", "content_id": content_id}


@tool(
    "run_performance_review",
    "Analyze content performance data and generate strategy learnings. "
    "Reviews top/bottom performing content, identifies patterns, and saves insights. "
    "Call this after measuring posts to learn from the data.",
)
async def run_performance_review() -> dict:
    top = _deps().db.get_top_performing_content(5)
    summary = _deps().db.get_performance_summary(7)
    recent = _deps().db.get_content_with_performance(20)

    if not recent or summary.get("total_posts", 0) == 0:
        return {"status": "insufficient_data", "message": "Not enough performance data yet. Measure more posts first."}

    # Build analysis prompt for LLM
    analysis_data = {
        "weekly_summary": summary,
        "top_performing": top,
        "all_recent": [
            {
                "content": r["content"][:120],
                "likes": r.get("likes", 0),
                "reposts": r.get("reposts", 0),
                "replies": r.get("replies", 0),
                "impressions": r.get("impressions", 0),
            }
            for r in recent
            if r.get("measured_at")
        ],
    }

    client = get_openai_client(_deps().settings.llm_api_key, _deps().settings.llm_base_url)
    response = await client.chat.completions.create(
        model=_deps().settings.llm_model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a GTM performance analyst. Analyze the content performance data and produce "
                    "actionable learnings. Return a JSON object with:\n"
                    "- learnings: array of {category, insight, evidence, confidence}\n"
                    "  categories: 'content_style', 'timing', 'topic', 'tone', 'format', 'audience'\n"
                    "  confidence: 0.0-1.0 based on data support\n"
                    "- audience_segments: array of {segment, description, engagement_score, keywords}\n"
                    "- recommended_actions: array of strings\n"
                    "Be specific and data-driven. No generic advice."
                ),
            },
            {
                "role": "user",
                "content": f"Analyze this performance data:\n{json.dumps(analysis_data, default=str)}",
            },
        ],
        response_format={"type": "json_object"},
    )

    try:
        analysis = json.loads(response.choices[0].message.content or "{}")
    except (json.JSONDecodeError, IndexError):
        return {"status": "analysis_failed", "error": "LLM response was not valid JSON"}

    # Save learnings to DB
    saved_learnings = []
    for learning in analysis.get("learnings", []):
        lid = _deps().db.save_learning(
            category=learning.get("category", "general"),
            insight=learning.get("insight", ""),
            evidence=learning.get("evidence", ""),
            confidence=learning.get("confidence", 0.5),
            expires_days=30,
        )
        saved_learnings.append({"id": lid, **learning})

    # Save audience insights
    for seg in analysis.get("audience_segments", []):
        _deps().db.upsert_audience_insight(
            segment=seg.get("segment", "unknown"),
            description=seg.get("description", ""),
            engagement_score=seg.get("engagement_score", 0.0),
            keywords=seg.get("keywords"),
        )

    return {
        "status": "review_complete",
        "learnings_saved": len(saved_learnings),
        "learnings": saved_learnings,
        "audience_segments": analysis.get("audience_segments", []),
        "recommended_actions": analysis.get("recommended_actions", []),
        "weekly_summary": summary,
    }


@tool("get_learnings", "Get active strategy learnings to inform content creation")
async def get_learnings(limit: int = 10) -> dict:
    learnings = _deps().db.get_active_learnings(limit)
    return {"learnings": learnings, "count": len(learnings)}


@tool("get_audience_insights", "Get audience segment insights to inform targeting")
async def get_audience_insights() -> dict:
    insights = _deps().db.get_audience_insights(5)
    return {"segments": insights, "count": len(insights)}


@tool(
    "get_performance_dashboard",
    "Get a full performance dashboard: weekly summary, top posts, learnings, and audience segments.",
)
async def get_performance_dashboard() -> dict:
    summary = _deps().db.get_performance_summary(7)
    top = _deps().db.get_top_performing_content(3)
    learnings = _deps().db.get_active_learnings(5)
    audience = _deps().db.get_audience_insights(3)

    return {
        "weekly_summary": summary,
        "top_posts": top,
        "active_learnings": learnings,
        "audience_segments": audience,
    }


@tool(
    "evolve_strategy",
    "Generate an evolved GTM playbook based on accumulated learnings and performance data. "
    "Creates a new playbook from data-driven insights rather than buying one externally.",
)
async def evolve_strategy() -> dict:
    learnings = _deps().db.get_active_learnings(15)
    top = _deps().db.get_top_performing_content(10)
    audience = _deps().db.get_audience_insights(5)
    summary = _deps().db.get_performance_summary(14)

    if not learnings:
        return {"status": "no_learnings", "message": "Run performance reviews first to accumulate learnings."}

    client = get_openai_client(_deps().settings.llm_api_key, _deps().settings.llm_base_url)
    response = await client.chat.completions.create(
        model=_deps().settings.llm_model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a GTM strategist. Based on performance data and learnings, "
                    "generate an evolved GTM playbook. Return JSON:\n"
                    "- name: string (playbook name)\n"
                    "- schedule: string (posting schedule recommendation)\n"
                    "- tactics: array of strings (specific actionable tactics)\n"
                    "- content_guidelines: array of strings (what to do/avoid in content)\n"
                    "- target_segments: array of strings (audience segments to focus on)\n"
                    "- hashtags: array of strings (recommended hashtags)\n"
                    "- tone_adjustments: string (how to adjust tone based on what works)\n"
                    "Base everything on the actual data — not generic advice."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "learnings": [
                            {
                                "category": learning["category"],
                                "insight": learning["insight"],
                                "confidence": learning["confidence"],
                            }
                            for learning in learnings
                        ],
                        "top_performing_content": [{"content": t["content"][:120], "likes": t["likes"], "reposts": t["reposts"]} for t in top],
                        "audience_segments": audience,
                        "performance_summary_14d": summary,
                    },
                    default=str,
                ),
            },
        ],
        response_format={"type": "json_object"},
    )

    try:
        playbook_data = json.loads(response.choices[0].message.content or "{}")
    except (json.JSONDecodeError, IndexError):
        return {"status": "failed", "error": "Could not generate playbook"}

    name = playbook_data.get("name", "Auto-Evolved Strategy")
    _deps().db.save_playbook(name, playbook_data, source_talos="self")

    # Auto-apply the new playbook
    row = _deps().db._conn.execute(
        "SELECT id FROM playbooks WHERE name = ? ORDER BY purchased_at DESC LIMIT 1",
        (name,),
    ).fetchone()
    if row:
        _deps().db.apply_playbook(row["id"])

    # Mark learnings as applied
    for learning in learnings:
        _deps().db.mark_learning_applied(learning["id"])

    return {
        "status": "evolved",
        "playbook_name": name,
        "playbook": playbook_data,
        "learnings_applied": len(learnings),
    }


@tool(
    "evict_expired_learnings",
    "Delete strategy learnings whose TTL (expires_at) has passed. "
    "Safe to run repeatedly; learnings without expires_at are kept. "
    "Returns eviction counts only — never insight text.",
)
async def evict_expired_learnings() -> dict:
    result = _deps().db.evict_expired_learnings()
    return {
        "status": "ok",
        "evicted": result["evicted"],
        "ids": result["ids"],
    }

