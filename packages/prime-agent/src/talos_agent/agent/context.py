"""AgentContext — collects current state from DB for system prompt."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from talos_agent.db import LocalDB


@dataclass
class AgentContext:
    current_time: str
    posts_today: int
    research_today: int
    replies_today: int
    pending_approvals: int
    pending_jobs: int
    last_agent_cycle: str
    recent_content: list[dict]
    active_playbook: dict | None
    talos_config: dict
    spending_today: float
    spending_month: float
    gtm_budget: float
    performance_summary: dict
    active_learnings: list[dict]
    audience_insights: list[dict]
    unmeasured_count: int

    @classmethod
    def from_db(cls, db: LocalDB, talos_config: dict) -> AgentContext:
        last_run = db.get_last_run("agent_cycle")
        playbook = db.get_active_playbook()

        # Count pending commerce jobs (as service provider)
        pending_jobs_count = 0
        try:
            rows = db._conn.execute(
                "SELECT COUNT(*) as cnt FROM commerce_queue WHERE status = 'pending'"
            ).fetchone()
            pending_jobs_count = rows["cnt"] if rows else 0
        except Exception:
            pass

        gtm_budget = float(talos_config.get("gtmBudget", 200))

        return cls(
            current_time=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            posts_today=db.count_today("post"),
            research_today=db.count_today("research"),
            replies_today=db.count_today("reply"),
            pending_approvals=len(db.get_pending_approvals()),
            pending_jobs=pending_jobs_count,
            last_agent_cycle=last_run.isoformat() if last_run else "never",
            recent_content=db.get_recent_content(5),
            active_playbook=playbook,
            talos_config=talos_config,
            spending_today=db.get_spending_today(),
            spending_month=db.get_spending_period(30),
            gtm_budget=gtm_budget,
            performance_summary=db.get_performance_summary(7),
            active_learnings=db.get_active_learnings(5),
            audience_insights=db.get_audience_insights(3),
            unmeasured_count=len(db.get_unmeasured_content(10)),
        )

    def to_context_block(self) -> str:
        budget_remaining = self.gtm_budget - self.spending_month
        lines = [
            f"Current time: {self.current_time}",
            f"Posts today: {self.posts_today}",
            f"Research sessions today: {self.research_today}",
            f"Replies today: {self.replies_today}",
            f"Pending approvals: {self.pending_approvals}",
            f"Pending incoming jobs (to fulfill): {self.pending_jobs}",
            f"Last agent cycle: {self.last_agent_cycle}",
            f"GTM Budget: ${self.gtm_budget:.2f}/month | Spent today: ${self.spending_today:.2f} | Spent this month: ${self.spending_month:.2f} | Remaining: ${budget_remaining:.2f}",
        ]
        if self.recent_content:
            lines.append("Recent posts (avoid duplicates):")
            for c in self.recent_content:
                lines.append(f"  - [{c.get('channel', '?')}] {c.get('content', '')[:80]}")
        if self.active_playbook:
            lines.append(f"Active playbook: {self.active_playbook['name']}")
            data = self.active_playbook.get("data", {})
            if isinstance(data, dict):
                if "schedule" in data:
                    lines.append(f"  Schedule: {data['schedule']}")
                if "tactics" in data:
                    lines.append(f"  Tactics: {data['tactics']}")
                if "content_guidelines" in data:
                    lines.append(f"  Content guidelines: {data['content_guidelines']}")
                if "tone_adjustments" in data:
                    lines.append(f"  Tone adjustments: {data['tone_adjustments']}")

        # Performance summary
        ps = self.performance_summary
        if ps and ps.get("total_posts", 0) > 0:
            lines.append(
                f"Performance (7d): {ps.get('total_posts', 0)} posts | "
                f"{ps.get('total_likes', 0)} likes | {ps.get('total_reposts', 0)} reposts | "
                f"{ps.get('total_impressions', 0)} impressions | "
                f"avg engagement: {ps.get('avg_engagement', 0):.1f}"
            )

        if self.unmeasured_count > 0:
            lines.append(f"Unmeasured posts: {self.unmeasured_count} (run measure_recent_posts)")

        # Active learnings
        if self.active_learnings:
            lines.append("Strategy learnings (apply these to content):")
            for l in self.active_learnings:
                lines.append(f"  - [{l['category']}] {l['insight'][:100]} (confidence: {l['confidence']:.0%})")

        # Audience insights
        if self.audience_insights:
            lines.append("Audience segments:")
            for a in self.audience_insights:
                lines.append(f"  - {a['segment']}: {a['description'][:80]} (score: {a['engagement_score']:.1f})")

        return "\n".join(lines)
