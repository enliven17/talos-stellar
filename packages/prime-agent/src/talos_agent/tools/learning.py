"""Learning tools — performance review, strategy learnings, audience insights."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from rich.console import Console

from talos_agent.agent.loop import get_openai_client
from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB

console = Console()

# Injected by registry.build_all_tools
_db: LocalDB = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]


@tool(
    "measure_recent_posts",
    "Measure engagement for recent posts that haven't been measured yet. "
    "Call check_post_performance for each, then store results. Returns list of unmeasured posts.",
)
async def measure_recent_posts() -> dict:
    unmeasured = _db.get_unmeasured_content(10)
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
    _db.record_performance(
        content_id=content_id,
        channel=channel,
        likes=likes,
        reposts=reposts,
        replies=replies,
        impressions=impressions,
        followers_at=followers_at,
    )
    return {"status": "recorded", "content_id": content_id}


@tool(
    "run_performance_review",
    "Analyze content performance data and generate strategy learnings. "
    "Reviews top/bottom performing content, identifies patterns, and saves insights. "
    "Call this after measuring posts to learn from the data.",
)
async def run_performance_review() -> dict:
    top = _db.get_top_performing_content(5)
    summary = _db.get_performance_summary(7)
    recent = _db.get_content_with_performance(20)

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

    client = get_openai_client(_settings.openai_api_key)
    response = await client.chat.completions.create(
        model=_settings.openai_model,
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
        lid = _db.save_learning(
            category=learning.get("category", "general"),
            insight=learning.get("insight", ""),
            evidence=learning.get("evidence", ""),
            confidence=learning.get("confidence", 0.5),
            expires_days=30,
        )
        saved_learnings.append({"id": lid, **learning})

    # Save audience insights
    for seg in analysis.get("audience_segments", []):
        _db.upsert_audience_insight(
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
    learnings = _db.get_active_learnings(limit)
    return {"learnings": learnings, "count": len(learnings)}


@tool("get_audience_insights", "Get audience segment insights to inform targeting")
async def get_audience_insights() -> dict:
    insights = _db.get_audience_insights(5)
    return {"segments": insights, "count": len(insights)}


@tool(
    "get_performance_dashboard",
    "Get a full performance dashboard: weekly summary, top posts, learnings, and audience segments.",
)
async def get_performance_dashboard() -> dict:
    summary = _db.get_performance_summary(7)
    top = _db.get_top_performing_content(3)
    learnings = _db.get_active_learnings(5)
    audience = _db.get_audience_insights(3)

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
    learnings = _db.get_active_learnings(15)
    top = _db.get_top_performing_content(10)
    audience = _db.get_audience_insights(5)
    summary = _db.get_performance_summary(14)

    if not learnings:
        return {"status": "no_learnings", "message": "Run performance reviews first to accumulate learnings."}

    client = get_openai_client(_settings.openai_api_key)
    response = await client.chat.completions.create(
        model=_settings.openai_model,
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
                        "learnings": [{"category": l["category"], "insight": l["insight"], "confidence": l["confidence"]} for l in learnings],
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
    _db.save_playbook(name, playbook_data, source_talos="self")

    # Auto-apply the new playbook
    row = _db._conn.execute(
        "SELECT id FROM playbooks WHERE name = ? ORDER BY purchased_at DESC LIMIT 1",
        (name,),
    ).fetchone()
    if row:
        _db.apply_playbook(row["id"])

    # Mark learnings as applied
    for l in learnings:
        _db.mark_learning_applied(l["id"])

    return {
        "status": "evolved",
        "playbook_name": name,
        "playbook": playbook_data,
        "learnings_applied": len(learnings),
    }
