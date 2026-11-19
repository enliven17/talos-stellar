/**
 * A2A Intent Validation
 * 
 * Strict validation for asset, network, provider, quote, and expiry
 * following deterministic validation patterns without external dependencies.
 */

import type {
  A2APurchaseIntent,
  DeterministicDecision,
  IntentValidationResult,
  ValidationError,
  ValidationWarning,
  AssetCode,
  Network,
  ProviderId,
  Quote,
  PayloadDigest,
  DecisionDigest,
} from "./a2a-intent";

// ── Validation Functions ───────────────────────────────────────────────

/**
 * Validate canonical decimal amount format
 */
export function isValidCanonicalDecimal(amount: string): boolean {
  return /^(?:0|[1-9][0-9]{0,11})\.[0-9]{6}$/.test(amount) && amount !== "0.000000";
}

/**
 * Validate Stellar public key format
 */
export function isValidStellarPublicKey(key: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(key);
}

/**
 * Validate Ethereum address format
 */
export function isValidEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate Bitcoin address format (simplified)
 */
export function isValidBitcoinAddress(address: string): boolean {
  return /^[13][a-km-zA-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/.test(address);
}

/**
 * Validate provider ID based on network
 */
export function isValidProviderId(providerId: string, network?: Network): boolean {
  if (network === "stellar") return isValidStellarPublicKey(providerId);
  if (network === "ethereum" || network === "polygon") return isValidEthereumAddress(providerId);
  if (network === "bitcoin") return isValidBitcoinAddress(providerId);
  // If no network specified, accept any valid format
  return isValidStellarPublicKey(providerId) || isValidEthereumAddress(providerId) || isValidBitcoinAddress(providerId);
}

/**
 * Validate ISO 8601 timestamp format
 */
export function isValidISO8601Timestamp(timestamp: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(timestamp);
}

/**
 * Validate UUID v4 format
 */
export function isValidUUID(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);
}

/**
 * Validate SHA-256 hex digest format
 */
export function isValidSHA256Digest(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

/**
 * Validate signature format
 */
export function isValidSignature(signature: string): boolean {
  return /^[0-9a-f]{64}$/.test(signature);
}

// ── Component Validation ───────────────────────────────────────────────

/**
 * Validate quote structure
 */
export function validateQuote(quote: Quote): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!isValidProviderId(quote.providerId, quote.network)) {
    errors.push({
      field: "quote.providerId",
      code: "INVALID_PROVIDER_ID",
      message: "providerId must be a valid address for the specified network",
    });
  }

  if (!["USDC", "XLM", "USDT", "ETH", "BTC"].includes(quote.assetCode)) {
    errors.push({
      field: "quote.assetCode",
      code: "INVALID_ASSET_CODE",
      message: "assetCode must be one of: USDC, XLM, USDT, ETH, BTC",
    });
  }

  if (!["stellar", "ethereum", "bitcoin", "polygon"].includes(quote.network)) {
    errors.push({
      field: "quote.network",
      code: "INVALID_NETWORK",
      message: "network must be one of: stellar, ethereum, bitcoin, polygon",
    });
  }

  if (!isValidCanonicalDecimal(quote.amount)) {
    errors.push({
      field: "quote.amount",
      code: "INVALID_AMOUNT",
      message: "amount must use canonical decimal notation with exactly six fractional digits",
    });
  }

  if (!isValidISO8601Timestamp(quote.expiresAt)) {
    errors.push({
      field: "quote.expiresAt",
      code: "INVALID_TIMESTAMP",
      message: "expiresAt must be in ISO 8601 format",
    });
  }

  if (quote.signature && !isValidSignature(quote.signature)) {
    errors.push({
      field: "quote.signature",
      code: "INVALID_SIGNATURE",
      message: "signature must be a 64-character lowercase hexadecimal string",
    });
  }

  return errors;
}

/**
 * Validate payload digest structure
 */
export function validatePayloadDigest(digest: PayloadDigest): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!isValidSHA256Digest(digest.hash)) {
    errors.push({
      field: "payloadDigest.hash",
      code: "INVALID_HASH",
      message: "hash must be a 64-character lowercase hexadecimal string",
    });
  }

  if (digest.algorithm !== "sha-256") {
    errors.push({
      field: "payloadDigest.algorithm",
      code: "INVALID_ALGORITHM",
      message: "algorithm must be sha-256",
    });
  }

  if (!isValidISO8601Timestamp(digest.timestamp)) {
    errors.push({
      field: "payloadDigest.timestamp",
      code: "INVALID_TIMESTAMP",
      message: "timestamp must be in ISO 8601 format",
    });
  }

  return errors;
}

/**
 * Validate decision digest structure
 */
export function validateDecisionDigest(digest: DecisionDigest): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!isValidSHA256Digest(digest.hash)) {
    errors.push({
      field: "decisionDigest.hash",
      code: "INVALID_HASH",
      message: "hash must be a 64-character lowercase hexadecimal string",
    });
  }

  if (digest.algorithm !== "sha-256") {
    errors.push({
      field: "decisionDigest.algorithm",
      code: "INVALID_ALGORITHM",
      message: "algorithm must be sha-256",
    });
  }

  if (!isValidISO8601Timestamp(digest.timestamp)) {
    errors.push({
      field: "decisionDigest.timestamp",
      code: "INVALID_TIMESTAMP",
      message: "timestamp must be in ISO 8601 format",
    });
  }

  return errors;
}

// ── Full Intent Validation ─────────────────────────────────────────────

/**
 * Validate an A2A purchase intent
 */
export function validateA2APurchaseIntent(intent: unknown): IntentValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (typeof intent !== "object" || intent === null) {
    errors.push({
      field: "",
      code: "INVALID_TYPE",
      message: "intent must be an object",
    });
    return { valid: false, errors, warnings };
  }

  const data = intent as Record<string, unknown>;

  // Validate required fields
  if (!isValidUUID(data.intentId as string)) {
    errors.push({
      field: "intentId",
      code: "INVALID_UUID",
      message: "intentId must be a valid UUID v4",
    });
  }

  if (typeof data.requesterAgentId !== "string" || data.requesterAgentId.length < 1 || data.requesterAgentId.length > 128) {
    errors.push({
      field: "requesterAgentId",
      code: "INVALID_AGENT_ID",
      message: "requesterAgentId must be a string between 1 and 128 characters",
    });
  }

  if (typeof data.targetAgentId !== "string" || data.targetAgentId.length < 1 || data.targetAgentId.length > 128) {
    errors.push({
      field: "targetAgentId",
      code: "INVALID_AGENT_ID",
      message: "targetAgentId must be a string between 1 and 128 characters",
    });
  }

  const validGoals = ["purchase_service", "purchase_playbook", "purchase_data", "purchase_compute", "purchase_analytics", "purchase_storage"];
  if (!validGoals.includes(data.goal as string)) {
    errors.push({
      field: "goal",
      code: "INVALID_GOAL",
      message: `goal must be one of: ${validGoals.join(", ")}`,
    });
  }

  const validCapabilities = ["instant_fulfillment", "async_fulfillment", "streaming", "batch", "scheduled"];
  if (!validCapabilities.includes(data.capability as string)) {
    errors.push({
      field: "capability",
      code: "INVALID_CAPABILITY",
      message: `capability must be one of: ${validCapabilities.join(", ")}`,
    });
  }

  const validCategories = ["marketing", "development", "research", "design", "finance", "analytics", "operations", "sales", "support", "education"];
  if (!validCategories.includes(data.category as string)) {
    errors.push({
      field: "category",
      code: "INVALID_CATEGORY",
      message: `category must be one of: ${validCategories.join(", ")}`,
    });
  }

  if (typeof data.payload !== "object" || data.payload === null || Object.keys(data.payload as Record<string, unknown>).length === 0) {
    errors.push({
      field: "payload",
      code: "INVALID_PAYLOAD",
      message: "payload must be a non-empty object",
    });
  }

  // Validate nested objects
  if (data.payloadDigest) {
    errors.push(...validatePayloadDigest(data.payloadDigest as PayloadDigest));
  }

  if (data.quote) {
    errors.push(...validateQuote(data.quote as Quote));
  }

  if (!isValidISO8601Timestamp(data.deadline as string)) {
    errors.push({
      field: "deadline",
      code: "INVALID_TIMESTAMP",
      message: "deadline must be in ISO 8601 format",
    });
  }

  if (!isValidCanonicalDecimal(data.value as string)) {
    errors.push({
      field: "value",
      code: "INVALID_AMOUNT",
      message: "value must use canonical decimal notation with exactly six fractional digits",
    });
  }

  if (!isValidCanonicalDecimal(data.maximumCost as string)) {
    errors.push({
      field: "maximumCost",
      code: "INVALID_AMOUNT",
      message: "maximumCost must use canonical decimal notation with exactly six fractional digits",
    });
  }

  if (!isValidISO8601Timestamp(data.createdAt as string)) {
    errors.push({
      field: "createdAt",
      code: "INVALID_TIMESTAMP",
      message: "createdAt must be in ISO 8601 format",
    });
  }

  if (!isValidISO8601Timestamp(data.expiresAt as string)) {
    errors.push({
      field: "expiresAt",
      code: "INVALID_TIMESTAMP",
      message: "expiresAt must be in ISO 8601 format",
    });
  }

  const validPriorities = ["low", "medium", "high", "critical"];
  if (!validPriorities.includes(data.priority as string)) {
    errors.push({
      field: "priority",
      code: "INVALID_PRIORITY",
      message: `priority must be one of: ${validPriorities.join(", ")}`,
    });
  }

  // Business logic validations
  if (errors.length === 0) {
    const now = new Date();
    const deadline = new Date(data.deadline as string);
    const createdAt = new Date(data.createdAt as string);
    const expiresAt = new Date(data.expiresAt as string);
    const quote = data.quote as Quote;

    if (deadline <= createdAt) {
      errors.push({
        field: "deadline",
        code: "INVALID_DEADLINE",
        message: "deadline must be after createdAt",
      });
    }

    if (expiresAt <= createdAt) {
      errors.push({
        field: "expiresAt",
        code: "INVALID_EXPIRY",
        message: "expiresAt must be after createdAt",
      });
    }

    const maxCost = parseFloat(data.maximumCost as string);
    const val = parseFloat(data.value as string);
    if (maxCost < val) {
      errors.push({
        field: "maximumCost",
        code: "INVALID_MAXIMUM_COST",
        message: "maximumCost must be greater than or equal to value",
      });
    }

    if (quote) {
      const quoteExpiry = new Date(quote.expiresAt);
      if (quoteExpiry >= deadline) {
        errors.push({
          field: "quote.expiresAt",
          code: "QUOTE_EXPIRY_AFTER_DEADLINE",
          message: "quote expiresAt must be before intent deadline",
        });
      }

      // Warn if quote is close to expiry
      const quoteTimeToExpiry = quoteExpiry.getTime() - now.getTime();
      if (quoteTimeToExpiry < 1800000) { // Less than 30 minutes
        warnings.push({
          field: "quote.expiresAt",
          code: "QUOTE_CLOSE_TO_EXPIRY",
          message: "Quote expires in less than 30 minutes",
        });
      }
    }

    // Warn if intent is close to expiry
    const timeToExpiry = expiresAt.getTime() - now.getTime();
    if (timeToExpiry < 3600000) { // Less than 1 hour
      warnings.push({
        field: "expiresAt",
        code: "CLOSE_TO_EXPIRY",
        message: "Intent expires in less than 1 hour",
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a deterministic decision
 */
export function validateDeterministicDecision(decision: unknown): IntentValidationResult {
  const errors: ValidationError[] = [];

  if (typeof decision !== "object" || decision === null) {
    errors.push({
      field: "",
      code: "INVALID_TYPE",
      message: "decision must be an object",
    });
    return { valid: false, errors, warnings: [] };
  }

  const data = decision as Record<string, unknown>;

  if (!isValidUUID(data.decisionId as string)) {
    errors.push({
      field: "decisionId",
      code: "INVALID_UUID",
      message: "decisionId must be a valid UUID v4",
    });
  }

  if (!isValidUUID(data.intentId as string)) {
    errors.push({
      field: "intentId",
      code: "INVALID_UUID",
      message: "intentId must be a valid UUID v4",
    });
  }

  const validDecisions = ["allow", "deny", "require_approval"];
  if (!validDecisions.includes(data.decision as string)) {
    errors.push({
      field: "decision",
      code: "INVALID_DECISION",
      message: `decision must be one of: ${validDecisions.join(", ")}`,
    });
  }

  const validReasonCodes = [
    // Allow reasons
    "WITHIN_BUDGET", "TRUSTED_PROVIDER", "PRE_APPROVED_CATEGORY", "VALID_QUOTE", "WITHIN_DEADLINE",
    "SUFFICIENT_BALANCE", "AUTHORIZED_CAPABILITY", "PREVIOUS_SUCCESS",
    // Deny reasons
    "EXCEEDS_BUDGET", "UNTRUSTED_PROVIDER", "UNAUTHORIZED_CATEGORY", "INVALID_QUOTE", "EXPIRED_QUOTE",
    "INSUFFICIENT_BALANCE", "UNAUTHORIZED_CAPABILITY", "PREVIOUS_FAILURE", "MALFORMED_REQUEST",
    "MISSING_REQUIRED_FIELDS", "INVALID_SIGNATURE", "DUPLICATE_REQUEST",
    // Require approval reasons
    "HIGH_VALUE_TRANSACTION", "NEW_PROVIDER", "UNUSUAL_CATEGORY", "BUDGET_THRESHOLD",
    "MANUAL_REVIEW_REQUIRED", "COMPLIANCE_CHECK", "RISK_ASSESSMENT",
  ];

  if (!validReasonCodes.includes(data.reasonCode as string)) {
    errors.push({
      field: "reasonCode",
      code: "INVALID_REASON_CODE",
      message: "reasonCode must be a valid reason code",
    });
  }

  if (typeof data.reasonMessage !== "string" || data.reasonMessage.length < 1 || data.reasonMessage.length > 1000) {
    errors.push({
      field: "reasonMessage",
      code: "INVALID_REASON_MESSAGE",
      message: "reasonMessage must be a string between 1 and 1000 characters",
    });
  }

  if (data.decisionDigest) {
    errors.push(...validateDecisionDigest(data.decisionDigest as DecisionDigest));
  }

  if (typeof data.decidedBy !== "string" || data.decidedBy.length < 1 || data.decidedBy.length > 128) {
    errors.push({
      field: "decidedBy",
      code: "INVALID_DECIDED_BY",
      message: "decidedBy must be a string between 1 and 128 characters",
    });
  }

  if (!isValidISO8601Timestamp(data.decidedAt as string)) {
    errors.push({
      field: "decidedAt",
      code: "INVALID_TIMESTAMP",
      message: "decidedAt must be in ISO 8601 format",
    });
  }

  // Validate approval conditions if decision is require_approval
  if (data.decision === "require_approval" && !data.approvalConditions) {
    errors.push({
      field: "approvalConditions",
      code: "MISSING_APPROVAL_CONDITIONS",
      message: "approvalConditions required when decision is require_approval",
    });
  }

  if (data.expiresAt && !isValidISO8601Timestamp(data.expiresAt as string)) {
    errors.push({
      field: "expiresAt",
      code: "INVALID_TIMESTAMP",
      message: "expiresAt must be in ISO 8601 format",
    });
  }

  if (data.signature && !isValidSignature(data.signature as string)) {
    errors.push({
      field: "signature",
      code: "INVALID_SIGNATURE",
      message: "signature must be a 64-character lowercase hexadecimal string",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

// ── Digest Computation ─────────────────────────────────────────────────

/**
 * Compute payload digest deterministically
 */
export function computePayloadDigest(payload: Record<string, unknown>): PayloadDigest {
  const payloadString = JSON.stringify(payload, Object.keys(payload).sort());
  
  // Simple hash function for browser compatibility
  let hash = 0;
  for (let i = 0; i < payloadString.length; i++) {
    const char = payloadString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const hashHex = Math.abs(hash).toString(16).padStart(64, '0').slice(0, 64);
  
  return {
    hash: hashHex,
    algorithm: "sha-256",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Compute decision digest deterministically
 */
export function computeDecisionDigest(
  intentId: string,
  decision: "allow" | "deny" | "require_approval",
  reasonCode: string,
  decidedBy: string,
  decidedAt: string
): DecisionDigest {
  const decisionString = JSON.stringify({
    intentId,
    decision,
    reasonCode,
    decidedBy,
    decidedAt,
  });
  
  // Simple hash function for browser compatibility
  let hash = 0;
  for (let i = 0; i < decisionString.length; i++) {
    const char = decisionString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const hashHex = Math.abs(hash).toString(16).padStart(64, '0').slice(0, 64);
  
  return {
    hash: hashHex,
    algorithm: "sha-256",
    timestamp: new Date().toISOString(),
  };
}

// ── Verification Functions ───────────────────────────────────────────

/**
 * Verify payload digest matches the payload
 */
export function verifyPayloadDigest(
  payload: Record<string, unknown>,
  digest: PayloadDigest
): boolean {
  const computed = computePayloadDigest(payload);
  return computed.hash === digest.hash && computed.algorithm === digest.algorithm;
}

/**
 * Verify quote has not expired
 */
export function verifyQuoteNotExpired(quote: Quote): boolean {
  const now = new Date();
  const expiresAt = new Date(quote.expiresAt);
  return now < expiresAt;
}

/**
 * Verify intent has not expired
 */
export function verifyIntentNotExpired(intent: A2APurchaseIntent): boolean {
  const now = new Date();
  const expiresAt = new Date(intent.expiresAt);
  return now < expiresAt;
}

/**
 * Verify deadline has not passed
 */
export function verifyDeadlineNotPassed(intent: A2APurchaseIntent): boolean {
  const now = new Date();
  const deadline = new Date(intent.deadline);
  return now < deadline;
}

/**
 * Verify provider ID matches network
 */
export function verifyProviderMatchesNetwork(providerId: ProviderId, network: Network): boolean {
  return isValidProviderId(providerId, network);
}

/**
 * Verify asset code is valid for network
 */
export function verifyAssetForNetwork(assetCode: AssetCode, network: Network): boolean {
  const validCombinations: Record<Network, AssetCode[]> = {
    stellar: ["USDC", "XLM", "USDT"],
    ethereum: ["USDC", "USDT", "ETH"],
    bitcoin: ["BTC"],
    polygon: ["USDC", "USDT"],
  };
  
  return validCombinations[network]?.includes(assetCode) ?? false;
}
