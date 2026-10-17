# Discord Adapter Reconnect Policy

## Overview

This document describes the reconnect policy implementation for the Discord adapter, which adds configurable retry behavior with exponential backoff for Discord webhook and bot API operations.

## Changes Made

### 1. DiscordAdapterConfig Extension

The `DiscordAdapterConfig` dataclass has been extended with reconnect policy parameters:

```python
@dataclass(frozen=True)
class DiscordAdapterConfig:
    # Existing fields
    channel_id: str = ""
    guild_id: str = ""
    legacy_webhook_url: str = ""
    legacy_bot_token: str = ""
    
    # New reconnect policy fields
    reconnect_enabled: bool = False
    reconnect_max_attempts: int = 3
    reconnect_backoff_initial: float = 1.0
    reconnect_backoff_max: float = 30.0
```

### 2. Reconnect Logic Implementation

- **Webhook reconnection**: Added `_webhook_post_with_reconnect()` method that retries failed webhook posts with exponential backoff
- **Bot API reconnection**: Added `_api_post_with_reconnect()` method that retries failed bot API posts with exponential backoff
- **Consecutive failure tracking**: Added `_consecutive_failures` counter to track failure patterns
- **Success tracking**: Added `_last_success_time` to track successful operations

### 3. Health Snapshot Updates

The `DiscordHealthSnapshot` now includes reconnect state:

```python
@dataclass(frozen=True)
class DiscordHealthSnapshot:
    has_webhook: bool
    has_token: bool
    has_channel: bool
    reconnect_enabled: bool = False  # New
    consecutive_failures: int = 0   # New
```

## Configuration Parameters

### `reconnect_enabled`
- **Type**: `bool`
- **Default**: `False`
- **Description**: Enables or disables the reconnect policy. When `False`, the adapter behaves as before (no retry logic).

### `reconnect_max_attempts`
- **Type**: `int`
- **Default**: `3`
- **Description**: Maximum number of retry attempts for failed operations. Must be non-negative.
- **Validation**: Raises `ValueError` if negative

### `reconnect_backoff_initial`
- **Type**: `float`
- **Default**: `1.0`
- **Description**: Initial backoff delay in seconds. Must be positive.
- **Validation**: Raises `ValueError` if ≤ 0 or if it exceeds `reconnect_backoff_max`

### `reconnect_backoff_max`
- **Type**: `float`
- **Default**: `30.0`
- **Description**: Maximum backoff delay in seconds. Must be positive.
- **Validation**: Raises `ValueError` if ≤ 0 or if it's less than `reconnect_backoff_initial`

## Usage Examples

### Basic Usage (Reconnect Disabled)

```python
from talos_agent.adapters.discord import DiscordAdapter, DiscordAdapterConfig

config = DiscordAdapterConfig(
    channel_id="123456789",
    guild_id="987654321",
    legacy_webhook_url="https://discord.com/api/webhooks/...",
    legacy_bot_token="...",
    reconnect_enabled=False,  # Default behavior
)

adapter = DiscordAdapter(config)
result = await adapter.post("Hello, Discord!")
```

### Reconnect Enabled

```python
config = DiscordAdapterConfig(
    channel_id="123456789",
    guild_id="987654321",
    legacy_webhook_url="https://discord.com/api/webhooks/...",
    legacy_bot_token="...",
    reconnect_enabled=True,
    reconnect_max_attempts=5,
    reconnect_backoff_initial=2.0,
    reconnect_backoff_max=60.0,
)

adapter = DiscordAdapter(config)
result = await adapter.post("Hello, Discord!")
# Will retry up to 5 times with exponential backoff (2s, 4s, 8s, 16s, 32s)
```

### Using with Settings

When using the `Settings` class, reconnect policy is disabled by default for backward compatibility:

```python
from talos_agent.config import Settings
from talos_agent.adapters.discord import DiscordAdapter

settings = Settings()
settings.discord_webhook_url = "https://discord.com/api/webhooks/..."
settings.discord_bot_token = "..."
settings.discord_channel_id = "123456789"

adapter = DiscordAdapter(settings)
# Reconnect is disabled by default when using Settings
```

## Backward Compatibility

### Existing Callers

**No breaking changes**. The implementation is fully backward compatible:

1. **Default behavior**: When `reconnect_enabled=False` (default), the adapter behaves exactly as before with no retry logic
2. **Settings integration**: When using `Settings` instead of `DiscordAdapterConfig`, reconnect policy is disabled by default
3. **Existing tests**: All existing tests pass without modification
4. **API compatibility**: The public interface remains unchanged

### Migration Path

To enable reconnect behavior:

1. **Direct configuration**: Switch from using `Settings` to `DiscordAdapterConfig` with `reconnect_enabled=True`
2. **Health monitoring**: The health snapshot now includes reconnect state for monitoring
3. **Error messages**: Error messages now include attempt count when reconnect is enabled

## Operational Impact

### Positive Impacts

1. **Improved reliability**: Transient network failures are automatically retried
2. **Configurable behavior**: Operators can tune retry parameters for their environment
3. **Visibility**: Health snapshots track consecutive failures for monitoring
4. **Graceful degradation**: Failed attempts are logged with clear error messages

### Considerations

1. **Latency**: Failed operations may take longer to fail (due to retry delays)
2. **Resource usage**: More HTTP requests may be made during failure scenarios
3. **Monitoring**: New health snapshot fields should be included in monitoring dashboards

## Error Handling

### Error Messages

When reconnect is enabled, error messages include the attempt count:

```
"Webhook POST failed after 4 attempts: HTTP 503 — Service Unavailable"
```

### Consecutive Failure Tracking

The adapter tracks consecutive failures and resets the counter on success:

```python
# After a successful post
assert adapter._consecutive_failures == 0

# After a failed post with reconnect enabled
assert adapter._consecutive_failures == 1
```

## Testing

### Test Coverage

The implementation includes comprehensive test coverage:

- **Positive tests**: Successful retry scenarios
- **Negative tests**: Failure after max attempts
- **Boundary tests**: Configuration validation
- **Regression tests**: Backward compatibility
- **Integration tests**: Health snapshot updates

### Running Tests

```bash
# Run Discord adapter tests
pytest tests/test_discord_adapter.py -v

# Run health snapshot tests
pytest tests/test_adapter_health_snapshots.py -v

# Run all adapter health tests
pytest tests/test_adapter_health.py -v
```

## Security and Privacy

### Secrets Handling

The reconnect policy does not expose or log sensitive information:

- Secrets (webhook URLs, bot tokens) are never logged
- Error messages are truncated to 200 characters
- No sensitive data is included in health snapshots

### Privacy

The implementation follows the existing privacy patterns in the codebase:
- No user data is logged
- No credentials are exposed in error messages
- Health snapshots contain only operational state

## Monitoring and Observability

### Health Snapshot

The `DiscordHealthSnapshot` now includes:

```python
{
    "has_webhook": True,
    "has_token": True,
    "has_channel": True,
    "reconnect_enabled": True,
    "consecutive_failures": 0
}
```

### Metadata

Successful operations include retry metadata:

```python
{
    "status": "posted",
    "post_id": "123",
    "url": "https://discord.com/channels/...",
    "metadata": {
        "method": "webhook",
        "reconnect_attempts": 2  # Number of retries needed
    }
}
```

## Rollout Recommendations

### Phase 1: Testing (Recommended)

1. Test in development environment with `reconnect_enabled=True`
2. Monitor health snapshots for consecutive failures
3. Tune backoff parameters based on observed failure patterns

### Phase 2: Gradual Rollout

1. Enable reconnect for low-traffic channels first
2. Monitor error rates and latency
3. Gradually enable for all channels

### Phase 3: Monitoring

1. Set up alerts for high consecutive failure counts
2. Monitor retry attempt distributions
3. Track success rates before and after enabling reconnect

## Troubleshooting

### High Consecutive Failures

If `consecutive_failures` is consistently high:

1. Check Discord API status
2. Verify webhook/bot token validity
3. Review rate limits and quotas
4. Consider increasing `reconnect_backoff_max`

### Slow Response Times

If operations are slow during failures:

1. Reduce `reconnect_max_attempts`
2. Decrease `reconnect_backoff_initial`
3. Consider setting `reconnect_enabled=False` for non-critical operations

## Future Enhancements

Potential future improvements:

1. **Circuit breaker integration**: Integrate with existing circuit breaker infrastructure
2. **Adaptive backoff**: Use jitter and adaptive backoff algorithms
3. **Per-operation configuration**: Different retry policies for different operations
4. **Metrics integration**: Export retry metrics to telemetry systems

## References

- **Circuit breaker implementation**: `src/talos_agent/circuit_breaker.py`
- **Browser reconnect pattern**: `src/talos_agent/browser/session.py`
- **Adapter base class**: `src/talos_agent/adapters/base.py`
- **Health snapshots**: `src/talos_agent/adapters/snapshots.py`
