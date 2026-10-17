# Mock Stellar Service Fault Injection

## Overview

The mock Stellar service supports fault injection for testing error handling, retry logic, and resilience in a safe, predictable manner. This feature is disabled by default and must be explicitly enabled via environment variables.

## Configuration

### Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `FAULT_INJECTION_ENABLED` | boolean | `false` | Enable/disable fault injection |
| `FAULT_LATENCY_MS` | number | `0` | Add latency to responses in milliseconds |
| `FAULT_ERROR_RATE` | number | `0.0` | Rate of 5xx errors (0.0-1.0) |
| `FAULT_TIMEOUT_RATE` | number | `0.0` | Rate of timeouts/no response (0.0-1.0) |
| `FAULT_MALFORMED_RATE` | number | `0.0` | Rate of malformed JSON responses (0.0-1.0) |

### Fault Types

1. **Latency Injection**: Adds artificial delay to all responses
2. **Error Injection**: Returns 500 Internal Server Error responses
3. **Timeout Injection**: Simulates network timeouts (no response)
4. **Malformed Response**: Returns invalid JSON to test parsing error handling

## Usage

### Local Development

```bash
# Enable fault injection with 500ms latency
export FAULT_INJECTION_ENABLED=true
export FAULT_LATENCY_MS=500
pnpm stack:up

# Enable 50% error rate for testing retry logic
export FAULT_INJECTION_ENABLED=true
export FAULT_ERROR_RATE=0.5
pnpm stack:up

# Test with multiple fault types
export FAULT_INJECTION_ENABLED=true
export FAULT_LATENCY_MS=200
export FAULT_ERROR_RATE=0.1
export FAULT_TIMEOUT_RATE=0.05
export FAULT_MALFORMED_RATE=0.05
pnpm stack:up
```

### Docker Compose Configuration

Add to `docker-compose.yml` under the `mock-stellar` service environment section:

```yaml
mock-stellar:
  environment:
    FAULT_INJECTION_ENABLED: "true"
    FAULT_LATENCY_MS: "500"
    FAULT_ERROR_RATE: "0.1"
```

Then restart the service:

```bash
docker compose restart mock-stellar
```

### Testing Scenarios

#### Test Retry Logic

```bash
# Enable 30% error rate to test retry behavior
export FAULT_INJECTION_ENABLED=true
export FAULT_ERROR_RATE=0.3
pnpm stack:up
```

#### Test Timeout Handling

```bash
# Enable 20% timeout rate to test timeout handling
export FAULT_INJECTION_ENABLED=true
export FAULT_TIMEOUT_RATE=0.2
pnpm stack:up
```

#### Test Error Parsing

```bash
# Enable malformed responses to test error parsing
export FAULT_INJECTION_ENABLED=true
export FAULT_MALFORMED_RATE=0.5
pnpm stack:up
```

## Testing

Run the comprehensive test suite:

```bash
pnpm test:mock-stellar-faults
```

The test suite covers:
- **Positive cases**: Fault injection when enabled
- **Negative cases**: No faults when disabled
- **Boundary cases**: Zero rates, maximum rates (1.0)
- **Regression cases**: Existing endpoints still work correctly
- **Privacy safety**: No sensitive data logged

## Implementation Details

### Fault Injection Logic

The fault injection system applies faults based on probability:

1. For each request, generate a random value
2. Compare against configured fault rates
3. Apply corresponding fault if conditions are met
4. Log fault injection (privacy-safe, no sensitive data)

### Privacy & Safety

- **Logging**: Only fault types and rates are logged (no request bodies, secrets, or sensitive data)
- **Default State**: Disabled by default (`FAULT_INJECTION_ENABLED=false`)
- **Explicit Activation**: Must be explicitly enabled via environment variables
- **Development Only**: Designed for local development and testing environments
- **Fail-Closed**: Invalid rates or configurations are rejected

### Example Log Output

```
[FAULT_INJECTION] LATENCY: {"endpoint":"health","delayMs":500}
[FAULT_INJECTION] ERROR: {"endpoint":"accounts","rate":0.5}
[FAULT_INJECTION] TIMEOUT: {"endpoint":"transactions","rate":0.1}
```

## Acceptance Criteria

✅ **Requested behavior available through current interface**
- Environment variables provide clean interface
- No breaking changes to existing callers
- Backward compatible (disabled by default)

✅ **Errors are explicit and privacy-safe**
- Clear error messages in logs
- No secrets, seeds, payment proofs, or sensitive media logged
- No sensitive data returned in error responses

✅ **Types, migrations, fixtures updated**
- Docker compose configuration updated
- CI test added to workflow
- Test script added to package.json scripts
- Documentation updated

## CI Integration

The fault injection test runs in CI automatically:

```yaml
# .github/workflows/ci.yml
- name: Test mock Stellar fault injection
  run: node scripts/mock-stellar-fault-injection.test.mjs
```

This ensures the fault injection feature remains functional and doesn't break existing functionality.

## Troubleshooting

### Faults Not Injecting

1. Verify `FAULT_INJECTION_ENABLED=true`
2. Check environment variables are set correctly
3. Restart the mock-stellar service after changing configuration
4. Check logs for fault injection messages

### Service Not Starting

1. Verify all environment variables are valid
2. Check that rates are between 0.0 and 1.0
3. Ensure latency is a valid number
4. Check Docker container logs: `docker compose logs mock-stellar`

### Tests Failing

1. Ensure no other processes are using port 4011 (test port)
2. Verify Node.js version >= 20
3. Run test directly: `node scripts/mock-stellar-fault-injection.test.mjs`
4. Check for port conflicts with running local stack

## Related Files

- Implementation: `scripts/mock-stellar-server.mjs`
- Tests: `scripts/mock-stellar-fault-injection.test.mjs`
- Docker config: `docker-compose.yml`
- CI workflow: `.github/workflows/ci.yml`
- Main documentation: `README.md`