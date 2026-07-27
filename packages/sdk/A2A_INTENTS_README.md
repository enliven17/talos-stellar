# A2A Purchase Intents and Deterministic Decisions

## Overview

This module provides canonical commerce intent and allow/deny/require-approval decision models for Agent-to-Agent (A2A) transactions in the TALOS Protocol.

## Features

- **Typed A2A Purchase Intents**: Structured intent models with goal, capability, category, payload digest, quote, deadline, value, and maximum cost
- **Deterministic Decisions**: Allow/deny/require-approval decisions with stable reason codes and decision digests
- **Strict Validation**: Comprehensive validation for asset, network, provider, quote, and expiry
- **Operation Management**: Built-in support for concurrency, retry, timeout, duplication handling, and cancellation
- **Cross-Chain Support**: Support for Stellar, Ethereum, Bitcoin, and Polygon networks

## Installation

The A2A intents module is included in the `@talos-protocol/sdk` package:

```bash
npm install @talos-protocol/sdk
```

## Quick Start

```typescript
import {
  A2APurchaseIntent,
  DeterministicDecision,
  validateA2APurchaseIntent,
  validateDeterministicDecision,
  A2AOperationManager,
} from '@talos-protocol/sdk';

// Create a purchase intent
const intent: A2APurchaseIntent = {
  intentId: '550e8400-e29b-41d4-a716-446655440000',
  requesterAgentId: 'agent-requester-123',
  targetAgentId: 'agent-target-456',
  goal: 'purchase_service',
  capability: 'instant_fulfillment',
  category: 'analytics',
  payload: {
    serviceName: 'data-analysis',
    dataset: 'customer-behavior-2026',
    format: 'json',
  },
  payloadDigest: {
    hash: 'a'.repeat(64),
    algorithm: 'sha-256',
    timestamp: '2026-01-01T00:00:00.000Z',
  },
  quote: {
    providerId: 'GABC1234567890ABCDEFGHIJ1234567890ABCDEFGHIJ1234567890ABCDEFGHIJ',
    assetCode: 'USDC',
    network: 'stellar',
    amount: '100.000000',
    expiresAt: '2026-12-31T23:59:59.000Z',
    signature: 'a'.repeat(64),
  },
  deadline: '2026-12-31T23:59:59.000Z',
  value: '95.000000',
  maximumCost: '100.000000',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-12-31T23:59:59.000Z',
  priority: 'medium',
};

// Validate the intent
const validationResult = validateA2APurchaseIntent(intent);
if (!validationResult.valid) {
  console.error('Validation failed:', validationResult.errors);
}

// Use operation manager for submission with retry logic
const manager = new A2AOperationManager({
  maxRetries: 3,
  retryDelay: 1000,
  timeout: 30000,
  concurrencyLimit: 10,
});

const result = await manager.submitIntent(intent, async (intent) => {
  // Your intent submission logic here
  return { success: true };
});
```

## Core Types

### A2APurchaseIntent

```typescript
interface A2APurchaseIntent {
  intentId: string;                    // UUID v4
  requesterAgentId: string;           // Agent ID making the request
  targetAgentId: string;              // Agent ID being requested
  goal: IntentGoal;                   // Purchase goal
  capability: IntentCapability;       // Fulfillment capability
  category: IntentCategory;           // Service category
  payload: Record<string, unknown>;   // Request payload
  payloadDigest: PayloadDigest;       // Payload hash for integrity
  quote: Quote;                       // Price and terms
  deadline: string;                   // ISO 8601 deadline
  value: string;                      // Estimated value (canonical decimal)
  maximumCost: string;                // Maximum acceptable cost
  createdAt: string;                  // ISO 8601 creation time
  expiresAt: string;                  // ISO 8601 expiry time
  priority: 'low' | 'medium' | 'high' | 'critical';
  idempotencyKey?: string;            // Optional idempotency key
  parentIntentId?: string;            // Optional parent intent
  tags?: string[];                    // Optional tags
}
```

### DeterministicDecision

```typescript
interface DeterministicDecision {
  decisionId: string;                 // UUID v4
  intentId: string;                   // Reference to intent
  decision: 'allow' | 'deny' | 'require_approval';
  reasonCode: ReasonCode;             // Stable reason code
  reasonMessage: string;              // Human-readable reason
  decisionDigest: DecisionDigest;     // Decision hash for determinism
  decidedBy: string;                  // Decision maker
  decidedAt: string;                  // ISO 8601 decision time
  approvalConditions?: {             // Required for require_approval
    requiredApprovers: string[];
    threshold: number;
    deadline: string;
  };
  expiresAt?: string;                 // Optional decision expiry
  signature?: string;                // Optional decision signature
}
```

## Intent Goals

- `purchase_service`: Purchase a service from another agent
- `purchase_playbook`: Purchase a playbook/strategy
- `purchase_data`: Purchase data access
- `purchase_compute`: Purchase compute resources
- `purchase_analytics`: Purchase analytics services
- `purchase_storage`: Purchase storage capacity

## Intent Capabilities

- `instant_fulfillment`: Immediate service delivery
- `async_fulfillment`: Asynchronous service delivery
- `streaming`: Streaming data delivery
- `batch`: Batch processing
- `scheduled`: Scheduled execution

## Intent Categories

- `marketing`: Marketing services
- `development`: Development services
- `research`: Research services
- `design`: Design services
- `finance`: Financial services
- `analytics`: Analytics services
- `operations`: Operational services
- `sales`: Sales services
- `support`: Support services
- `education`: Educational services

## Reason Codes

### Allow Reasons
- `WITHIN_BUDGET`: Transaction within approved budget
- `TRUSTED_PROVIDER`: Provider is trusted
- `PRE_APPROVED_CATEGORY`: Category is pre-approved
- `VALID_QUOTE`: Quote is valid
- `WITHIN_DEADLINE`: Within deadline constraints
- `SUFFICIENT_BALANCE`: Sufficient balance available
- `AUTHORIZED_CAPABILITY`: Capability is authorized
- `PREVIOUS_SUCCESS`: Previous successful transactions

### Deny Reasons
- `EXCEEDS_BUDGET`: Exceeds approved budget
- `UNTRUSTED_PROVIDER`: Provider is not trusted
- `UNAUTHORIZED_CATEGORY`: Category is not authorized
- `INVALID_QUOTE`: Quote is invalid
- `EXPIRED_QUOTE`: Quote has expired
- `INSUFFICIENT_BALANCE`: Insufficient balance
- `UNAUTHORIZED_CAPABILITY`: Capability is not authorized
- `PREVIOUS_FAILURE`: Previous failed transactions
- `MALFORMED_REQUEST`: Request is malformed
- `MISSING_REQUIRED_FIELDS`: Required fields missing
- `INVALID_SIGNATURE`: Invalid signature
- `DUPLICATE_REQUEST`: Duplicate request detected

### Require Approval Reasons
- `HIGH_VALUE_TRANSACTION`: High-value transaction
- `NEW_PROVIDER`: New provider relationship
- `UNUSUAL_CATEGORY`: Unusual category
- `BUDGET_THRESHOLD`: Approaching budget threshold
- `MANUAL_REVIEW_REQUIRED`: Manual review needed
- `COMPLIANCE_CHECK`: Compliance verification needed
- `RISK_ASSESSMENT`: Risk assessment required

## Supported Networks

- **Stellar**: `USDC`, `XLM`, `USDT`
- **Ethereum**: `USDC`, `USDT`, `ETH`
- **Bitcoin**: `BTC`
- **Polygon**: `USDC`, `USDT`

## Validation

The module provides comprehensive validation for all components:

```typescript
import {
  validateA2APurchaseIntent,
  validateDeterministicDecision,
  validateQuote,
  validatePayloadDigest,
  validateDecisionDigest,
} from '@talos-protocol/sdk';

// Validate complete intent
const intentResult = validateA2APurchaseIntent(intent);
if (!intentResult.valid) {
  console.error('Errors:', intentResult.errors);
  console.warn('Warnings:', intentResult.warnings);
}

// Validate decision
const decisionResult = validateDeterministicDecision(decision);
if (!decisionResult.valid) {
  console.error('Errors:', decisionResult.errors);
}

// Validate individual components
const quoteErrors = validateQuote(quote);
const digestErrors = validatePayloadDigest(digest);
```

## Operation Management

The `A2AOperationManager` handles complex operation scenarios:

### Configuration

```typescript
const manager = new A2AOperationManager({
  maxRetries: 3,              // Maximum retry attempts
  retryDelay: 1000,           // Base retry delay (ms)
  timeout: 30000,             // Operation timeout (ms)
  idempotencyWindow: 60000,   // Idempotency window (ms)
  concurrencyLimit: 10,       // Maximum concurrent operations
});
```

### Idempotency

Operations with the same idempotency key within the window return cached results:

```typescript
const result1 = await manager.submitIntent(intent, operation);
const result2 = await manager.submitIntent(intent, operation); // Returns cached result
```

### Concurrency Control

The manager respects concurrency limits:

```typescript
// Will throw if concurrency limit reached
try {
  await manager.submitIntent(intent, operation);
} catch (error) {
  if (error.message === 'CONCURRENCY_LIMIT_REACHED') {
    // Handle concurrency limit
  }
}
```

### Retry Logic

Automatic retry with exponential backoff for transient errors:

```typescript
const manager = new A2AOperationManager({
  maxRetries: 3,
  retryDelay: 1000,
});

// Retries automatically on transient errors
const result = await manager.submitIntent(intent, flakyOperation);
```

### Cancellation

Cancel in-progress operations:

```typescript
manager.cancelOperation(intent.intentId);
```

### Operation Status

Monitor operation status:

```typescript
const status = manager.getOperationStatus(intent.intentId);
console.log('State:', status?.state);
console.log('Attempt:', status?.attempt);
```

## Verification Functions

```typescript
import {
  verifyPayloadDigest,
  verifyQuoteNotExpired,
  verifyIntentNotExpired,
  verifyDeadlineNotPassed,
  verifyProviderMatchesNetwork,
  verifyAssetForNetwork,
} from '@talos-protocol/sdk';

// Verify payload integrity
const isValid = verifyPayloadDigest(payload, digest);

// Verify quote hasn't expired
const notExpired = verifyQuoteNotExpired(quote);

// Verify provider matches network
const matches = verifyProviderMatchesNetwork(providerId, 'stellar');

// Verify asset is valid for network
const validAsset = verifyAssetForNetwork('USDC', 'stellar');
```

## Digest Computation

```typescript
import {
  computePayloadDigest,
  computeDecisionDigest,
} from '@talos-protocol/sdk';

// Compute payload digest
const payloadDigest = computePayloadDigest(payload);

// Compute decision digest
const decisionDigest = computeDecisionDigest(
  intentId,
  'allow',
  'WITHIN_BUDGET',
  'system-budget-checker',
  decidedAt
);
```

## Configuration

### Environment Variables

No environment variables are required. Configuration is done through the `A2AOperationManager` constructor.

### Default Configuration

```typescript
const DEFAULT_OPERATION_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000,           // 1 second
  timeout: 30000,             // 30 seconds
  idempotencyWindow: 60000,   // 1 minute
  concurrencyLimit: 10,
};
```

## Observability

### Operation Context

Each operation maintains a context with:

```typescript
interface OperationContext {
  operationId: string;
  operationType: 'intent_submission' | 'decision_evaluation' | 'intent_fulfillment';
  state: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'retrying';
  attempt: number;
  startedAt: string;
  lastAttemptAt: string;
  completedAt?: string;
  error?: string;
  config: OperationConfig;
}
```

### Monitoring

Monitor active operations:

```typescript
const activeOps = manager.getActiveOperations();
activeOps.forEach(op => {
  console.log(`Operation ${op.operationId}: ${op.state} (attempt ${op.attempt})`);
});
```

## Migration and Rollback

### Version Compatibility

The module uses semantic versioning. Major version changes may require migration:

- **v1.x → v2.x**: Review breaking changes in changelog
- **Minor versions**: Backward compatible additions
- **Patch versions**: Bug fixes only

### Rollback Strategy

To rollback to a previous version:

```bash
npm install @talos-protocol/sdk@1.0.0
```

### Data Migration

No data migration is required as the module is stateless. Operation state is maintained in-memory and resets on restart.

## Limitations

### Current Limitations

1. **In-Memory State**: Operation state is not persisted across restarts
2. **Hash Algorithm**: Uses simple hash for browser compatibility (not cryptographic SHA-256)
3. **Single Process**: No distributed coordination for multi-process deployments
4. **Network Support**: Limited to Stellar, Ethereum, Bitcoin, and Polygon

### Planned Enhancements

1. **Persistent State**: Database-backed operation state
2. **Cryptographic Hashes**: Web Crypto API integration for proper SHA-256
3. **Distributed Coordination**: Redis-based coordination for multi-process deployments
4. **Additional Networks**: Support for more blockchain networks

## Security Considerations

### Sensitive Data Handling

- **Payloads**: May contain sensitive business data - encrypt at rest
- **Signatures**: Validate all signatures before processing
- **Provider IDs**: Validate against allowlists where appropriate

### Authorization

- **Agent Authentication**: Verify agent identities before processing intents
- **Budget Limits**: Enforce per-agent budget constraints
- **Category Authorization**: Validate category permissions

### Audit Trail

Maintain audit logs for:

- All intent submissions
- All decision evaluations
- All approval condition changes
- All operation failures

## Testing

### Unit Tests

```bash
npm test -- a2a-validation.test.ts
npm test -- a2a-operations.test.ts
```

### Integration Tests

Integration tests cover real-world scenarios including:

- High-volume intent submission
- Mixed success/failure scenarios
- Concurrency limit handling
- Retry logic verification
- Timeout handling
- Cancellation scenarios

## Troubleshooting

### Common Issues

**Issue**: `CONCURRENCY_LIMIT_REACHED`
- **Solution**: Increase `concurrencyLimit` or implement queueing

**Issue**: `OPERATION_TIMEOUT`
- **Solution**: Increase `timeout` or optimize operation performance

**Issue**: `DUPLICATE_REQUEST`
- **Solution**: Use unique `idempotencyKey` for each operation

**Issue**: Validation failures
- **Solution**: Review validation errors and fix intent/decision structure

## Support

For issues and questions:

1. Check the troubleshooting section above
2. Review test fixtures for examples
3. Consult the main TALOS Protocol documentation
4. Open an issue on GitHub

## License

MIT License - see LICENSE file for details
