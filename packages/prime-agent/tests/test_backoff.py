
import pytest
import logging
from talos_agent.scheduler import Backoff

def test_backoff_base_delay():
    b = Backoff(base_delay=10.0)
    assert b.next_delay() == 10.0
    b.success()
    assert b.next_delay() == 10.0

def test_backoff_exponential():
    # Disable jitter for deterministic testing
    b = Backoff(base_delay=10.0, initial_backoff=2.0, jitter=0)

    b.failure()
    assert b.next_delay() == 2.0

    b.failure()
    assert b.next_delay() == 4.0

    b.failure()
    assert b.next_delay() == 8.0

def test_backoff_max():
    b = Backoff(base_delay=10.0, initial_backoff=2.0, max_backoff=10.0, jitter=0)
    for _ in range(5):
        b.failure()
    assert b.next_delay() == 10.0

def test_backoff_reset():
    b = Backoff(base_delay=10.0, initial_backoff=2.0, jitter=0)
    b.failure()
    b.failure()
    assert b.next_delay() == 4.0

    b.success()
    assert b.next_delay() == 10.0

def test_backoff_jitter():
    # With 20% jitter, 100.0 should be between 80.0 and 120.0
    b = Backoff(base_delay=10.0, initial_backoff=100.0, jitter=0.2)
    b.failure()

    delays = [b.next_delay() for _ in range(100)]
    for d in delays:
        assert 80.0 <= d <= 120.0

    # Ensure they are not all the same
    assert len(set(delays)) > 1

def test_backoff_logging(caplog):
    caplog.set_level(logging.DEBUG)
    b = Backoff(base_delay=10.0, initial_backoff=2.0, jitter=0)
    b.failure()
    _ = b.next_delay()
    assert "Backoff state: fail_count=1, next_delay=2.00s" in caplog.text

    b.success()
    assert "Backoff reset on success" in caplog.text
