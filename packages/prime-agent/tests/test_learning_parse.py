"""Tests for parse_performance_review in learning_parse.py."""

from __future__ import annotations

from talos_agent.tools.learning_parse import parse_performance_review


class TestParsePerformanceReview:
    def test_valid_payload(self):
        raw = {
            "learnings": [
                {
                    "category": "content_style",
                    "insight": "Short posts work better",
                    "evidence": "3 posts with 200+ likes",
                    "confidence": 0.9,
                }
            ],
            "audience_segments": [
                {
                    "segment": "indie devs",
                    "description": "Solo developers",
                    "engagement_score": 0.75,
                    "keywords": ["dev", "indie"],
                }
            ],
        }
        result = parse_performance_review(raw)
        assert result["dropped"] == 0
        assert len(result["learnings"]) == 1
        assert result["learnings"][0]["confidence"] == 0.9
        assert len(result["audience_segments"]) == 1
        assert result["audience_segments"][0]["engagement_score"] == 0.75

    def test_non_dict_input(self):
        for bad in [None, "string", 42, [1, 2, 3]]:
            result = parse_performance_review(bad)
            assert result == {
                "learnings": [],
                "audience_segments": [],
                "dropped": 0,
            }

    def test_drops_non_dict_learning_entries(self):
        raw = {"learnings": ["not a dict", 42, None, {"insight": "ok"}]}
        result = parse_performance_review(raw)
        assert result["dropped"] == 3
        assert len(result["learnings"]) == 1

    def test_drops_learning_with_empty_insight(self):
        raw = {"learnings": [{"insight": ""}, {"insight": "   "}, {"insight": "real"}]}
        result = parse_performance_review(raw)
        assert result["dropped"] == 2
        assert len(result["learnings"]) == 1

    def test_clamps_confidence_out_of_range(self):
        raw = {
            "learnings": [
                {"insight": "a", "confidence": 5.0},
                {"insight": "b", "confidence": -3.0},
                {"insight": "c", "confidence": "not-a-number"},
            ]
        }
        result = parse_performance_review(raw)
        assert result["learnings"][0]["confidence"] == 1.0
        assert result["learnings"][1]["confidence"] == 0.0
        assert result["learnings"][2]["confidence"] == 0.5

    def test_unknown_category_falls_back_to_general(self):
        raw = {"learnings": [{"insight": "x", "category": "made_up_category"}]}
        result = parse_performance_review(raw)
        assert result["learnings"][0]["category"] == "general"

    def test_truncates_long_text_fields(self):
        raw = {"learnings": [{"insight": "x" * 5000, "evidence": "y" * 5000}]}
        result = parse_performance_review(raw)
        assert len(result["learnings"][0]["insight"]) == 1000
        assert len(result["learnings"][0]["evidence"]) == 1000

    def test_caps_learning_list_size(self):
        raw = {"learnings": [{"insight": f"item-{i}"} for i in range(500)]}
        result = parse_performance_review(raw)
        assert len(result["learnings"]) <= 50

    def test_caps_audience_list_size(self):
        raw = {
            "audience_segments": [
                {"segment": f"seg-{i}", "engagement_score": 0.5} for i in range(200)
            ]
        }
        result = parse_performance_review(raw)
        assert len(result["audience_segments"]) <= 20

    def test_hostile_audience_segments_field(self):
        raw = {"audience_segments": "not a list"}
        result = parse_performance_review(raw)
        assert result["audience_segments"] == []
        assert result["dropped"] == 0

    def test_mixed_hostile_payload(self):
        raw = {
            "learnings": [
                "junk",
                {"insight": "valid", "confidence": 0.7, "category": "timing"},
                {"insight": "", "confidence": 0.5},
            ],
            "audience_segments": [
                {"segment": "", "engagement_score": 0.5},
                {"segment": "devs", "engagement_score": 99.0},
            ],
        }
        result = parse_performance_review(raw)
        assert result["dropped"] == 3
        assert len(result["learnings"]) == 1
        assert len(result["audience_segments"]) == 1
        assert result["audience_segments"][0]["engagement_score"] == 1.0
