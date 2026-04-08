"""Tests for commerce tools — price conversion, categories, budget enforcement."""

from __future__ import annotations

import pytest
from talos_agent.tools.commerce import price_to_usdc_units, ALL_CATEGORIES


class TestPriceToUsdcUnits:
    def test_standard_decimal(self):
        assert price_to_usdc_units("1.05") == 1_050_000

    def test_half_dollar(self):
        assert price_to_usdc_units("0.50") == 500_000

    def test_whole_number(self):
        assert price_to_usdc_units("10") == 10_000_000

    def test_six_decimals(self):
        assert price_to_usdc_units("1.999999") == 1_999_999

    def test_truncates_beyond_six(self):
        assert price_to_usdc_units("1.1234567") == 1_123_456

    def test_zero(self):
        assert price_to_usdc_units("0") == 0

    def test_smallest_unit(self):
        assert price_to_usdc_units("0.000001") == 1


def test_all_categories_has_ten_entries():
    assert len(ALL_CATEGORIES) == 10
    assert "Sales" in ALL_CATEGORIES
    assert "Education" in ALL_CATEGORIES
    assert "Development" in ALL_CATEGORIES
