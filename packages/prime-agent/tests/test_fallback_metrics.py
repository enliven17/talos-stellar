import pytest
from talos_agent.routing.fallback import (
    FallbackChain,
    fallback_metrics,
)
from talos_agent.circuit_breaker import cb_registry


@pytest.fixture(autouse=True)
def reset_metrics():
    fallback_metrics.reset()
    cb_registry.reset_all()
    yield


@pytest.mark.asyncio
async def test_metrics_success_path():
    chain = FallbackChain(["groq", "openai"])
    
    async def op(provider, *args):
        if provider == "groq":
            raise Exception("fail")
        return "ok"

    result = await chain.execute(op)
    assert result.success is True
    assert result.provider_name == "openai"

    snap = fallback_metrics.snapshot()
    assert snap.attempts.get("groq") == 1
    assert snap.attempts.get("openai") == 1
    
    assert snap.successes.get("openai") == 1
    assert "groq" not in snap.successes
    
    assert not snap.exhaustions
    assert not snap.skips


@pytest.mark.asyncio
async def test_metrics_exhaustion_path():
    chain = FallbackChain(["groq", "openai"])
    
    async def op(provider, *args):
        raise Exception("fail")

    result = await chain.execute(op)
    assert result.success is False

    snap = fallback_metrics.snapshot()
    assert snap.attempts.get("groq") == 1
    assert snap.attempts.get("openai") == 1
    
    assert not snap.successes
    
    assert snap.exhaustions.get("groq") == 1
    assert snap.exhaustions.get("openai") == 1
    assert not snap.skips


@pytest.mark.asyncio
async def test_metrics_circuit_open_skip():
    # Force 'groq' breaker to be OPEN
    breaker = cb_registry.get("groq")
    for _ in range(10):
        await breaker.record_failure()
    assert not await breaker.allow_request()

    chain = FallbackChain(["groq", "openai"])
    
    async def op(provider, *args):
        return "ok"

    result = await chain.execute(op)
    assert result.success is True
    assert result.provider_name == "openai"

    snap = fallback_metrics.snapshot()
    
    # "groq" is skipped, so no attempt is recorded
    assert "groq" not in snap.attempts
    assert snap.skips.get("groq") == 1
    
    assert snap.attempts.get("openai") == 1
    assert snap.successes.get("openai") == 1
    assert not snap.exhaustions


@pytest.mark.asyncio
async def test_metrics_sensitive_label_redaction():
    # Attempt to use a provider name containing sensitive substrings like "api_key"
    chain = FallbackChain(["my_api_key_provider", "secret_groq", "openai"])
    
    async def op(provider, *args):
        if provider == "my_api_key_provider":
            raise Exception("fail")
        return "ok"

    result = await chain.execute(op)
    assert result.success is True
    assert result.provider_name == "secret_groq"

    snap = fallback_metrics.snapshot()
    
    # "my_api_key_provider" and "secret_groq" should be redacted as "[REDACTED]"
    assert snap.attempts.get("[REDACTED]") == 2
    assert "my_api_key_provider" not in snap.attempts
    assert "secret_groq" not in snap.attempts
    
    assert snap.successes.get("[REDACTED]") == 1
    assert "openai" not in snap.attempts


@pytest.mark.asyncio
async def test_metrics_cardinality_bound():
    # We bounded cardinality to 100 max unique keys
    async def op(provider, *args):
        return "ok"
    
    for i in range(105):
        provider_name = f"provider_{i}"
        chain = FallbackChain([provider_name])
        await chain.execute(op)
        
    snap = fallback_metrics.snapshot()
    
    # 100 unique items + 1 OTHER_OVERFLOW
    assert len(snap.attempts) == 101
    assert "OTHER_OVERFLOW" in snap.attempts
    assert snap.attempts["OTHER_OVERFLOW"] == 5
