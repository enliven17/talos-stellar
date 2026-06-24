"""Tests for commerce tools — price conversion, categories, budget enforcement."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch
import pytest
from talos_agent.tools.commerce import price_to_usdc_units, ALL_CATEGORIES, discover_services


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


class MockAPIClient:
    def __init__(self):
        self.discover_services = AsyncMock(return_value=[])


@pytest.fixture
def mock_api_client():
    return MockAPIClient()


@pytest.mark.asyncio
@pytest.mark.parametrize("category", ALL_CATEGORIES)
async def test_discover_services_handles_category(category, mock_api_client):
    with patch("talos_agent.tools.commerce._api", mock_api_client), \
         patch("random.choice", return_value=category):
        res = await discover_services()
        assert res["category_searched"] == category
        mock_api_client.discover_services.assert_called_once_with(
            category=category,
            target=None
        )
