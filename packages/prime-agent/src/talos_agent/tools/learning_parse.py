"""Pure parser for LLM performance-review output."""

from __future__ import annotations

from typing import Any

VALID_CATEGORIES = {
    "content_style",
    "timing",
    "topic",
    "tone",
    "format",
    "audience",
    "general",
}


def parse_performance_review(raw: object) -> dict:
    """
    Validate and normalise an LLM performance-review payload.

    - Keeps only documented learning categories.
    - Clamps confidence / engagement_score to [0.0, 1.0].
    - Truncates text fields and caps list sizes.
    - Drops malformed entries; returns a `dropped` count.
    """
    if not isinstance(raw, dict):
        return {"learnings": [], "audience_segments": [], "dropped": 0}

    dropped = 0

    # ── Learnings ────────────────────────────────────────────────────────
    learnings: list[dict[str, Any]] = []
    raw_learnings = raw.get("learnings", [])
    if isinstance(raw_learnings, list):
        for item in raw_learnings[:50]:
            if not isinstance(item, dict):
                dropped += 1
                continue

            category = str(item.get("category", "general")).strip().lower()
            if category not in VALID_CATEGORIES:
                category = "general"

            insight = str(item.get("insight", "")).strip()[:1000]
            evidence = str(item.get("evidence", "")).strip()[:1000]

            try:
                confidence = float(item.get("confidence", 0.5))
            except (ValueError, TypeError):
                confidence = 0.5
            confidence = max(0.0, min(1.0, confidence))

            if not insight:
                dropped += 1
                continue

            learnings.append(
                {
                    "category": category,
                    "insight": insight,
                    "evidence": evidence,
                    "confidence": confidence,
                }
            )

    # ── Audience segments ────────────────────────────────────────────────
    audience: list[dict[str, Any]] = []
    raw_segments = raw.get("audience_segments", [])
    if isinstance(raw_segments, list):
        for item in raw_segments[:20]:
            if not isinstance(item, dict):
                dropped += 1
                continue

            segment = str(item.get("segment", "")).strip()[:200]
            description = str(item.get("description", "")).strip()[:1000]

            try:
                engagement = float(item.get("engagement_score", 0.0))
            except (ValueError, TypeError):
                engagement = 0.0
            engagement = max(0.0, min(1.0, engagement))

            keywords = item.get("keywords")
            if isinstance(keywords, list):
                keywords = [str(k)[:50] for k in keywords[:20]]
            elif keywords is not None:
                keywords = None

            if not segment:
                dropped += 1
                continue

            audience.append(
                {
                    "segment": segment,
                    "description": description,
                    "engagement_score": engagement,
                    "keywords": keywords,
                }
            )

    return {
        "learnings": learnings,
        "audience_segments": audience,
        "dropped": dropped,
    }
