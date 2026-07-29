/**
 * A2A Intent and Decision Test Fixtures
 * 
 * Deterministic and malformed fixtures for testing A2A purchase intents
 * and deterministic decisions.
 */

import type {
  A2APurchaseIntent,
  DeterministicDecision,
  Quote,
  PayloadDigest,
  DecisionDigest,
} from "../src/a2a-intent";

// ── Deterministic Valid Fixtures ───────────────────────────────────────

/**
 * Valid Stellar provider ID
 */
export const VALID_STELLAR_PROVIDER = "GABC1234567890ABCDEFGHIJ1234567890ABCDEFGHIJ1234567890ABCDEFGHIJ";

/**
 * Valid Ethereum provider ID
 */
export const VALID_ETHEREUM_PROVIDER = "0x1234567890123456789012345678901234567890";

/**
 * Valid Bitcoin provider ID
 */
export const VALID_BITCOIN_PROVIDER = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

/**
 * Valid quote fixture
 */
export const validQuote: Quote = {
  providerId: VALID_STELLAR_PROVIDER,
  assetCode: "USDC",
  network: "stellar",
  amount: "100.000000",
  expiresAt: "2026-12-31T23:59:59.000Z",
  signature: "a".repeat(64),
  quoteId: "quote-12345",
};

/**
 * Valid payload digest fixture
 */
export const validPayloadDigest: PayloadDigest = {
  hash: "a".repeat(64),
  algorithm: "sha-256",
  timestamp: "2026-01-01T00:00:00.000Z",
};

/**
 * Valid decision digest fixture
 */
export const validDecisionDigest: DecisionDigest = {
  hash: "b".repeat(64),
  algorithm: "sha-256",
  timestamp: "2026-01-01T00:00:00.000Z",
};

/**
 * Valid A2A purchase intent fixture
 */
export const validA2APurchaseIntent: A2APurchaseIntent = {
  intentId: "550e8400-e29b-41d4-a716-446655440000",
  requesterAgentId: "agent-requester-123",
  targetAgentId: "agent-target-456",
  goal: "purchase_service",
  capability: "instant_fulfillment",
  category: "analytics",
  payload: {
    serviceName: "data-analysis",
    dataset: "customer-behavior-2026",
    format: "json",
  },
  payloadDigest: validPayloadDigest,
  quote: validQuote,
  deadline: "2026-12-31T23:59:59.000Z",
  value: "95.000000",
  maximumCost: "100.000000",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-12-31T23:59:59.000Z",
  priority: "medium",
  idempotencyKey: "idempotency-key-123",
  tags: ["analytics", "customer-data"],
};

/**
 * Valid deterministic decision (allow)
 */
export const validAllowDecision: DeterministicDecision = {
  decisionId: "660e8400-e29b-41d4-a716-446655440001",
  intentId: validA2APurchaseIntent.intentId,
  decision: "allow",
  reasonCode: "WITHIN_BUDGET",
  reasonMessage: "Transaction is within approved budget limits",
  decisionDigest: validDecisionDigest,
  decidedBy: "system-budget-checker",
  decidedAt: "2026-01-01T00:01:00.000Z",
  signature: "c".repeat(64),
};

/**
 * Valid deterministic decision (deny)
 */
export const validDenyDecision: DeterministicDecision = {
  decisionId: "660e8400-e29b-41d4-a716-446655440002",
  intentId: validA2APurchaseIntent.intentId,
  decision: "deny",
  reasonCode: "EXCEEDS_BUDGET",
  reasonMessage: "Transaction exceeds approved budget limits",
  decisionDigest: validDecisionDigest,
  decidedBy: "system-budget-checker",
  decidedAt: "2026-01-01T00:01:00.000Z",
  signature: "d".repeat(64),
};

/**
 * Valid deterministic decision (require_approval)
 */
export const validRequireApprovalDecision: DeterministicDecision = {
  decisionId: "660e8400-e29b-41d4-a716-446655440003",
  intentId: validA2APurchaseIntent.intentId,
  decision: "require_approval",
  reasonCode: "HIGH_VALUE_TRANSACTION",
  reasonMessage: "High-value transaction requires manual approval",
  decisionDigest: validDecisionDigest,
  decidedBy: "system-risk-assessor",
  decidedAt: "2026-01-01T00:01:00.000Z",
  approvalConditions: {
    requiredApprovers: ["admin-1", "admin-2"],
    threshold: 2,
    deadline: "2026-01-02T00:00:00.000Z",
  },
  signature: "e".repeat(64),
};

// ── Malformed Fixtures ────────────────────────────────────────────────

/**
 * Invalid UUID format
 */
export const invalidUUID = "not-a-uuid";

/**
 * Invalid Stellar provider ID (wrong format)
 */
export const invalidStellarProvider = "INVALID_STELLAR_ADDRESS";

/**
 * Invalid Ethereum address (wrong format)
 */
export const invalidEthereumProvider = "not-an-eth-address";

/**
 * Invalid amount (not canonical format)
 */
export const invalidAmount = "100.00";

/**
 * Invalid timestamp (not ISO 8601)
 */
export const invalidTimestamp = "not-a-timestamp";

/**
 * Invalid signature (wrong format)
 */
export const invalidSignature = "not-a-signature";

/**
 * Invalid hash (wrong format)
 */
export const invalidHash = "not-a-hash";

/**
 * Malformed intent: missing required fields
 */
export const malformedIntentMissingFields = {
  intentId: invalidUUID,
  // Missing requesterAgentId
  targetAgentId: "agent-target-456",
  goal: "purchase_service",
  // Missing capability
  category: "analytics",
  // Missing payload
  // Missing payloadDigest
  // Missing quote
  // Missing deadline
  // Missing value
  // Missing maximumCost
  // Missing createdAt
  // Missing expiresAt
  // Missing priority
};

/**
 * Malformed intent: invalid field values
 */
export const malformedIntentInvalidValues = {
  intentId: invalidUUID,
  requesterAgentId: "",
  targetAgentId: "agent-target-456",
  goal: "invalid_goal",
  capability: "invalid_capability",
  category: "invalid_category",
  payload: {},
  payloadDigest: {
    hash: invalidHash,
    algorithm: "invalid-algorithm",
    timestamp: invalidTimestamp,
  },
  quote: {
    providerId: invalidStellarProvider,
    assetCode: "INVALID",
    network: "invalid-network",
    amount: invalidAmount,
    expiresAt: invalidTimestamp,
    signature: invalidSignature,
  },
  deadline: invalidTimestamp,
  value: invalidAmount,
  maximumCost: invalidAmount,
  createdAt: invalidTimestamp,
  expiresAt: invalidTimestamp,
  priority: "invalid-priority",
};

/**
 * Malformed intent: business logic violations
 */
export const malformedIntentBusinessLogic = {
  ...validA2APurchaseIntent,
  // Deadlinebefore creation time
  deadline: "2025-12-31T23:59:59.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  // ExpiresAt before creation time
  expiresAt: "2025-12-31T23:59:59.000Z",
  // MaximumCost less than value
  maximumCost: "50.000000",
  value: "100.000000",
  // Quote expires after deadline
  quote: {
    ...validQuote,
    expiresAt: "2027-01-01T00:00:00.000Z",
  },
};

/**
 * Malformed decision: missing required fields
 */
export const malformedDecisionMissingFields = {
  decisionId: invalidUUID,
  // Missing intentId
  decision: "allow",
  // Missing reasonCode
  reasonMessage: "",
  // Missing decisionDigest
  // Missing decidedBy
  // Missing decidedAt
};

/**
 * Malformed decision: invalid field values
 */
export const malformedDecisionInvalidValues = {
  decisionId: invalidUUID,
  intentId: invalidUUID,
  decision: "invalid-decision",
  reasonCode: "INVALID_REASON_CODE",
  reasonMessage: "",
  decisionDigest: {
    hash: invalidHash,
    algorithm: "invalid-algorithm",
    timestamp: invalidTimestamp,
  },
  decidedBy: "",
  decidedAt: invalidTimestamp,
  approvalConditions: {
    requiredApprovers: [],
    threshold: 0,
    deadline: invalidTimestamp,
  },
  signature: invalidSignature,
};

/**
 * Malformed decision: require_approval without conditions
 */
export const malformedDecisionMissingApprovalConditions = {
  ...validRequireApprovalDecision,
  decision: "require_approval",
  approvalConditions: undefined,
};

// ── Edge Case Fixtures ────────────────────────────────────────────────

/**
 * Intent with maximum allowed values
 */
export const edgeCaseMaxValuesIntent: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  requesterAgentId: "a".repeat(128),
  targetAgentId: "b".repeat(128),
  value: "922337203685.477580",
  maximumCost: "922337203685.477580",
  tags: Array(20).fill("tag"),
};

/**
 * Intent with minimum allowed values
 */
export const edgeCaseMinValuesIntent: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  value: "0.000001",
  maximumCost: "0.000001",
  requesterAgentId: "a",
  targetAgentId: "b",
};

/**
 * Intent with expired quote
 */
export const edgeCaseExpiredQuoteIntent: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  quote: {
    ...validQuote,
    expiresAt: "2025-01-01T00:00:00.000Z",
  },
};

/**
 * Intent with expired deadline
 */
export const edgeCaseExpiredDeadlineIntent: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  deadline: "2025-01-01T00:00:00.000Z",
};

/**
 * Decision with expired validity
 */
export const edgeCaseExpiredDecision: DeterministicDecision = {
  ...validAllowDecision,
  expiresAt: "2025-01-01T00:00:00.000Z",
};

/**
 * Intent with different networks
 */
export const ethereumIntent: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  quote: {
    ...validQuote,
    providerId: VALID_ETHEREUM_PROVIDER,
    network: "ethereum",
    assetCode: "ETH",
  },
};

export const bitcoinIntent: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  quote: {
    ...validQuote,
    providerId: VALID_BITCOIN_PROVIDER,
    network: "bitcoin",
    assetCode: "BTC",
  },
};

export const polygonIntent: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  quote: {
    ...validQuote,
    providerId: VALID_ETHEREUM_PROVIDER,
    network: "polygon",
    assetCode: "USDC",
  },
};

// ── Concurrency Test Fixtures ───────────────────────────────────────────

/**
 * Duplicate intents with same idempotency key
 */
export const duplicateIntent1: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  idempotencyKey: "duplicate-key-123",
};

export const duplicateIntent2: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  intentId: "770e8400-e29b-41d4-a716-446655440000",
  idempotencyKey: "duplicate-key-123",
};

/**
 * Parent-child intent relationship
 */
export const parentIntent: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  intentId: "880e8400-e29b-41d4-a716-446655440000",
};

export const childIntent: A2APurchaseIntent = {
  ...validA2APurchaseIntent,
  intentId: "990e8400-e29b-41d4-a716-446655440000",
  parentIntentId: parentIntent.intentId,
};

// ── Reason Code Coverage Fixtures ──────────────────────────────────────

/**
 * Decision fixtures for each reason code category
 */
export const allowReasonCodeFixtures: DeterministicDecision[] = [
  {
    ...validAllowDecision,
    decisionId: "allow-1",
    reasonCode: "WITHIN_BUDGET",
    reasonMessage: "Within budget",
  },
  {
    ...validAllowDecision,
    decisionId: "allow-2",
    reasonCode: "TRUSTED_PROVIDER",
    reasonMessage: "Trusted provider",
  },
  {
    ...validAllowDecision,
    decisionId: "allow-3",
    reasonCode: "PRE_APPROVED_CATEGORY",
    reasonMessage: "Pre-approved category",
  },
  {
    ...validAllowDecision,
    decisionId: "allow-4",
    reasonCode: "VALID_QUOTE",
    reasonMessage: "Valid quote",
  },
  {
    ...validAllowDecision,
    decisionId: "allow-5",
    reasonCode: "WITHIN_DEADLINE",
    reasonMessage: "Within deadline",
  },
  {
    ...validAllowDecision,
    decisionId: "allow-6",
    reasonCode: "SUFFICIENT_BALANCE",
    reasonMessage: "Sufficient balance",
  },
  {
    ...validAllowDecision,
    decisionId: "allow-7",
    reasonCode: "AUTHORIZED_CAPABILITY",
    reasonMessage: "Authorized capability",
  },
  {
    ...validAllowDecision,
    decisionId: "allow-8",
    reasonCode: "PREVIOUS_SUCCESS",
    reasonMessage: "Previous success",
  },
];

export const denyReasonCodeFixtures: DeterministicDecision[] = [
  {
    ...validDenyDecision,
    decisionId: "deny-1",
    reasonCode: "EXCEEDS_BUDGET",
    reasonMessage: "Exceeds budget",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-2",
    reasonCode: "UNTRUSTED_PROVIDER",
    reasonMessage: "Untrusted provider",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-3",
    reasonCode: "UNAUTHORIZED_CATEGORY",
    reasonMessage: "Unauthorized category",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-4",
    reasonCode: "INVALID_QUOTE",
    reasonMessage: "Invalid quote",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-5",
    reasonCode: "EXPIRED_QUOTE",
    reasonMessage: "Expired quote",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-6",
    reasonCode: "INSUFFICIENT_BALANCE",
    reasonMessage: "Insufficient balance",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-7",
    reasonCode: "UNAUTHORIZED_CAPABILITY",
    reasonMessage: "Unauthorized capability",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-8",
    reasonCode: "PREVIOUS_FAILURE",
    reasonMessage: "Previous failure",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-9",
    reasonCode: "MALFORMED_REQUEST",
    reasonMessage: "Malformed request",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-10",
    reasonCode: "MISSING_REQUIRED_FIELDS",
    reasonMessage: "Missing required fields",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-11",
    reasonCode: "INVALID_SIGNATURE",
    reasonMessage: "Invalid signature",
  },
  {
    ...validDenyDecision,
    decisionId: "deny-12",
    reasonCode: "DUPLICATE_REQUEST",
    reasonMessage: "Duplicate request",
  },
];

export const requireApprovalReasonCodeFixtures: DeterministicDecision[] = [
  {
    ...validRequireApprovalDecision,
    decisionId: "approval-1",
    reasonCode: "HIGH_VALUE_TRANSACTION",
    reasonMessage: "High value transaction",
  },
  {
    ...validRequireApprovalDecision,
    decisionId: "approval-2",
    reasonCode: "NEW_PROVIDER",
    reasonMessage: "New provider",
  },
  {
    ...validRequireApprovalDecision,
    decisionId: "approval-3",
    reasonCode: "UNUSUAL_CATEGORY",
    reasonMessage: "Unusual category",
  },
  {
    ...validRequireApprovalDecision,
    decisionId: "approval-4",
    reasonCode: "BUDGET_THRESHOLD",
    reasonMessage: "Budget threshold",
  },
  {
    ...validRequireApprovalDecision,
    decisionId: "approval-5",
    reasonCode: "MANUAL_REVIEW_REQUIRED",
    reasonMessage: "Manual review required",
  },
  {
    ...validRequireApprovalDecision,
    decisionId: "approval-6",
    reasonCode: "COMPLIANCE_CHECK",
    reasonMessage: "Compliance check",
  },
  {
    ...validRequireApprovalDecision,
    decisionId: "approval-7",
    reasonCode: "RISK_ASSESSMENT",
    reasonMessage: "Risk assessment",
  },
];
