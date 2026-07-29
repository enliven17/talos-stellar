"""Tests for agent lifecycle transitions."""

import pytest
from unittest.mock import AsyncMock, MagicMock
from talos_agent.agent.lifecycle import LifecycleManager, LifecycleState
from talos_agent.config import Settings

@pytest.fixture
def mock_db():
    db = MagicMock()
    db.get_pending_approvals.return_value = [{"id": "app_1"}, {"id": "app_2"}]
    return db

@pytest.fixture
def mock_api():
    api = AsyncMock()
    api.update_status = AsyncMock()
    return api

@pytest.fixture
def mock_stellar():
    stellar = AsyncMock()
    stellar.get_balance = AsyncMock(return_value={"balance_xlm": "100.0"})
    return stellar

@pytest.fixture
def settings():
    return Settings(
        talos_id="test_talos_123",
        llm_api_key="sk-test-key",
    )

@pytest.fixture
def lifecycle_manager(settings, mock_db, mock_api, mock_stellar):
    return LifecycleManager(settings, mock_db, mock_api, mock_stellar)

@pytest.mark.asyncio
async def test_transition_to_paused(lifecycle_manager, mock_api, mock_stellar, mock_db):
    result = await lifecycle_manager.transition_to_paused()
    
    assert result["status"] == "success"
    assert result["state"] == "paused"
    assert lifecycle_manager.state == LifecycleState.PAUSED
    assert lifecycle_manager.settings.llm_api_key == "***REVOKED***"
    
    assert result["reconciled"]["balances_checked"] is True
    assert result["reconciled"]["approvals_cancelled"] == 2
    assert result["reconciled"]["refunds_issued"] == 0
    
    mock_api.update_status.assert_called_once_with("test_talos_123", online=False)

@pytest.mark.asyncio
async def test_transition_to_retired_with_refunds(lifecycle_manager, mock_api, mock_stellar, mock_db):
    result = await lifecycle_manager.transition_to_retired()
    
    assert result["status"] == "success"
    assert result["state"] == "retired"
    assert lifecycle_manager.state == LifecycleState.RETIRED
    
    assert result["reconciled"]["balances_checked"] is True
    assert result["reconciled"]["approvals_cancelled"] == 2
    assert result["reconciled"]["refunds_issued"] == 2
    
    mock_api.update_status.assert_called_once_with("test_talos_123", online=False)

@pytest.mark.asyncio
async def test_transition_to_recovering(lifecycle_manager, mock_api):
    lifecycle_manager.state = LifecycleState.PAUSED
    
    result = await lifecycle_manager.transition_to_recovering()
    
    assert result["status"] == "success"
    assert result["state"] == "active"
    assert lifecycle_manager.state == LifecycleState.ACTIVE
    
    mock_api.update_status.assert_called_once_with("test_talos_123", online=True)

@pytest.mark.asyncio
async def test_reconcile_handles_unavailable_providers(lifecycle_manager, mock_stellar):
    # Mock stellar down
    mock_stellar.get_balance = AsyncMock(side_effect=Exception("Stellar horizon down"))
    
    result = await lifecycle_manager.transition_to_paused()
    assert result["reconciled"]["balances_checked"] is False
    # Still transitions to paused despite provider issue
    assert result["status"] == "success"
    assert lifecycle_manager.state == LifecycleState.PAUSED

@pytest.mark.asyncio
async def test_notify_handles_unavailable_providers(lifecycle_manager, mock_api):
    # Mock api down
    mock_api.update_status = AsyncMock(side_effect=Exception("API down"))
    
    result = await lifecycle_manager.transition_to_paused()
    assert result["status"] == "success"
    assert lifecycle_manager.state == LifecycleState.PAUSED
