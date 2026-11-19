/**
 * A2A (Agent-to-Agent) Purchase Intent and Decision Models
 * 
 * This module defines canonical types for agent-to-agent commerce intents
 * and deterministic decision-making with stable reason codes.
 */

// ── Intent Goal Types ────────────────────────────────────────────────

export type IntentGoal = 
  | "purchase_service"
  | "purchase_playbook"
  | "purchase_data"
  | "purchase_compute"
  | "purchase_analytics"
  | "purchase_storage";

// ── Intent Capability Types ────────────────────────────────────────────

export type IntentCapability =
  | "instant_fulfillment"
  | "async_fulfillment"
  | "streaming"
  | "batch"
  | "scheduled";

// ── Intent Category Types ─────────────────────────────────────────────

export type IntentCategory =
  | "marketing"
  | "development"
  | "research"
  | "design"
  | "finance"
  | "analytics"
  | "operations"
  | "sales"
  | "support"
  | "education";

// ── Decision Types ────────────────────────────────────────────────────

export type DecisionType = "allow" | "deny" | "require_approval";

// ── Stable Reason Codes ───────────────────────────────────────────────

export type ReasonCode =
  // Allow reasons
  | "WITHIN_BUDGET"
  | "TRUSTED_PROVIDER"
  | "PRE_APPROVED_CATEGORY"
  | "VALID_QUOTE"
  | "WITHIN_DEADLINE"
  | "SUFFICIENT_BALANCE"
  | "AUTHORIZED_CAPABILITY"
  | "PREVIOUS_SUCCESS"
  // Deny reasons
  | "EXCEEDS_BUDGET"
  | "UNTRUSTED_PROVIDER"
  | "UNAUTHORIZED_CATEGORY"
  | "INVALID_QUOTE"
  | "EXPIRED_QUOTE"
  | "INSUFFICIENT_BALANCE"
  | "UNAUTHORIZED_CAPABILITY"
  | "PREVIOUS_FAILURE"
  | "MALFORMED_REQUEST"
  | "MISSING_REQUIRED_FIELDS"
  | "INVALID_SIGNATURE"
  | "DUPLICATE_REQUEST"
  // Require approval reasons
  | "HIGH_VALUE_TRANSACTION"
  | "NEW_PROVIDER"
  | "UNUSUAL_CATEGORY"
  | "BUDGET_THRESHOLD"
  | "MANUAL_REVIEW_REQUIRED"
  | "COMPLIANCE_CHECK"
  | "RISK_ASSESSMENT";

// ── Asset Validation ──────────────────────────────────────────────────

export type AssetCode = "USDC" | "XLM" | "USDT" | "ETH" | "BTC";

export type Network = "stellar" | "ethereum" | "bitcoin" | "polygon";

export type ProviderId = string; // Stellar public key or equivalent identifier

// ── Quote Structure ───────────────────────────────────────────────────

export interface Quote {
  providerId: ProviderId;
  assetCode: AssetCode;
  network: Network;
  amount: string; // Canonical decimal string
  expiresAt: string; // ISO 8601 timestamp
  signature?: string; // Provider signature for authenticity
  quoteId?: string; // Unique quote identifier
}

// ── Payload Digest ───────────────────────────────────────────────────

export interface PayloadDigest {
  hash: string; // SHA-256 hex digest
  algorithm: "sha-256";
  timestamp: string; // ISO 8601 timestamp
}

// ── A2A Purchase Intent ───────────────────────────────────────────────

export interface A2APurchaseIntent {
  // Core identification
  intentId: string; // UUID v4
  requesterAgentId: string; // Agent ID making the request
  targetAgentId: string; // Agent ID being requested
  
  // Intent specification
  goal: IntentGoal;
  capability: IntentCapability;
  category: IntentCategory;
  
  // Payload and quote
  payload: Record<string, unknown>;
  payloadDigest: PayloadDigest;
  quote: Quote;
  
  // Timing and value
  deadline: string; // ISO 8601 timestamp
  value: string; // Estimated value in canonical decimal
  maximumCost: string; // Maximum acceptable cost in canonical decimal
  
  // Metadata
  createdAt: string; // ISO 8601 timestamp
  expiresAt: string; // ISO 8601 timestamp
  priority: "low" | "medium" | "high" | "critical";
  
  // Optional fields for advanced scenarios
  idempotencyKey?: string;
  parentIntentId?: string;
  tags?: string[];
}

// ── Decision Digest ───────────────────────────────────────────────────

export interface DecisionDigest {
  hash: string; // SHA-256 hex digest of decision fields
  algorithm: "sha-256";
  timestamp: string; // ISO 8601 timestamp
}

// ── Deterministic Decision ────────────────────────────────────────────

export interface DeterministicDecision {
  // Core identification
  decisionId: string; // UUID v4
  intentId: string; // Reference to the intent
  
  // Decision outcome
  decision: DecisionType;
  reasonCode: ReasonCode;
  reasonMessage: string;
  
  // Decision digest for determinism
  decisionDigest: DecisionDigest;
  
  // Authorization
  decidedBy: string; // Agent ID or system component
  decidedAt: string; // ISO 8601 timestamp
  
  // Conditions (for require_approval)
  approvalConditions?: {
    requiredApprovers: string[];
    threshold: number;
    deadline: string;
  };
  
  // Metadata
  expiresAt?: string; // Decision validity period
  signature?: string; // Decision signature for authenticity
}

// ── Intent Validation Result ──────────────────────────────────────────

export interface IntentValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

export interface ValidationWarning {
  field: string;
  code: string;
  message: string;
}

// ── Decision Context ─────────────────────────────────────────────────

export interface DecisionContext {
  intent: A2APurchaseIntent;
  requesterAgent: {
    id: string;
    balance: string;
    budget: string;
    trustLevel: number;
    categories: IntentCategory[];
  };
  targetAgent: {
    id: string;
    reputation: number;
    categories: IntentCategory[];
    capabilities: IntentCapability[];
  };
  historicalData: {
    previousTransactions: number;
    successRate: number;
    averageValue: string;
  };
}

// ── Decision Request ──────────────────────────────────────────────────

export interface DecisionRequest {
  intent: A2APurchaseIntent;
  context: DecisionContext;
  timestamp: string; // ISO 8601 timestamp
  requestId: string; // UUID v4
}
