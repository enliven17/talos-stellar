import crypto from "crypto";

export type CommerceOperationType =
  | "quote_acceptance"
  | "payment_signing"
  | "reservation_creation"
  | "job_creation";

export interface CommercePolicyContext {
  requester: string;
  provider: string;
  asset: string;
  network: string;
  quotedAmount: number;
  payloadDigest: string;
  expiration: string;
  authorizationContext?: Record<string, unknown>;
  operationType: CommerceOperationType;
}

export interface CommercePolicyDecision {
  decisionId: string;
  decisionDigest: string;
  expiry: string;
  evaluatedAt: string;
  decision: "approve" | "escalate" | "deny";
  requester: string;
  provider: string;
  asset: string;
  network: string;
  quotedAmount: number;
  payloadDigest: string;
  operationType: CommerceOperationType;
  violatedRules: string[];
  evidence: string[];
}

export function computePayloadDigest(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return crypto.createHash("sha256").update("").digest("hex");
  }
  let str: string;
  if (typeof payload === "string") {
    str = payload;
  } else if (typeof payload === "object") {
    str = JSON.stringify(payload, Object.keys(payload as Record<string, unknown>).sort());
  } else {
    str = String(payload);
  }
  return crypto.createHash("sha256").update(str).digest("hex");
}

export async function evaluateCommercePolicy(
  context: CommercePolicyContext,
  options: { timeoutMs?: number } = {}
): Promise<CommercePolicyDecision> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const now = new Date();
  const evaluatedAt = now.toISOString();

  if (timeoutMs <= 0) {
    return buildFailClosedDecision(context, evaluatedAt, `Policy evaluation timed out (${timeoutMs}ms)`);
  }

  // Create timeout promise to enforce fail-closed behavior
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Policy evaluation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });

  try {
    return await Promise.race([
      doEvaluateCommercePolicy(context, evaluatedAt),
      timeoutPromise,
    ]);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return buildFailClosedDecision(context, evaluatedAt, errorMsg);
  }
}


async function doEvaluateCommercePolicy(
  context: CommercePolicyContext,
  evaluatedAt: string
): Promise<CommercePolicyDecision> {
  const now = new Date();

  // Validate expiration
  if (context.expiration) {
    const expDate = new Date(context.expiration);
    if (isNaN(expDate.getTime()) || now >= expDate) {
      return buildFailClosedDecision(context, evaluatedAt, "Policy context expired or invalid expiration timestamp");
    }
  }

  // Validate minimum required fields
  if (!context.requester || !context.provider || !context.asset || !context.network) {
    return buildFailClosedDecision(context, evaluatedAt, "Missing required parameters (requester, provider, asset, network)");
  }

  // Basic verification rules
  const violatedRules: string[] = [];
  const evidence: string[] = [];

  if (context.quotedAmount < 0) {
    violatedRules.push("RULE_NEGATIVE_AMOUNT");
    evidence.push("Quoted amount cannot be negative");
  }

  const decisionOutcome: "approve" | "deny" = violatedRules.length > 0 ? "deny" : "approve";
  const decisionId = crypto.randomUUID();
  const expiry = context.expiration || new Date(now.getTime() + 5 * 60 * 1000).toISOString();

  const canonicalInput = JSON.stringify({
    decisionId,
    requester: context.requester,
    provider: context.provider,
    asset: context.asset,
    network: context.network,
    quotedAmount: context.quotedAmount,
    payloadDigest: context.payloadDigest,
    operationType: context.operationType,
    expiry,
    decision: decisionOutcome,
  });

  const decisionDigest = crypto.createHash("sha256").update(canonicalInput).digest("hex");

  return {
    decisionId,
    decisionDigest,
    expiry,
    evaluatedAt,
    decision: decisionOutcome,
    requester: context.requester,
    provider: context.provider,
    asset: context.asset,
    network: context.network,
    quotedAmount: context.quotedAmount,
    payloadDigest: context.payloadDigest,
    operationType: context.operationType,
    violatedRules,
    evidence,
  };
}

function buildFailClosedDecision(
  context: CommercePolicyContext,
  evaluatedAt: string,
  reason: string
): CommercePolicyDecision {
  const decisionId = crypto.randomUUID();
  const expiry = context.expiration || evaluatedAt;

  const canonicalInput = JSON.stringify({
    decisionId,
    requester: context.requester || "unknown",
    provider: context.provider || "unknown",
    asset: context.asset || "unknown",
    network: context.network || "unknown",
    quotedAmount: context.quotedAmount || 0,
    payloadDigest: context.payloadDigest || "empty",
    operationType: context.operationType || "job_creation",
    expiry,
    decision: "deny",
    reason,
  });

  const decisionDigest = crypto.createHash("sha256").update(canonicalInput).digest("hex");

  return {
    decisionId,
    decisionDigest,
    expiry,
    evaluatedAt,
    decision: "deny",
    requester: context.requester || "unknown",
    provider: context.provider || "unknown",
    asset: context.asset || "unknown",
    network: context.network || "unknown",
    quotedAmount: context.quotedAmount || 0,
    payloadDigest: context.payloadDigest || "empty",
    operationType: context.operationType || "job_creation",
    violatedRules: ["FAIL_CLOSED"],
    evidence: [reason],
  };
}

export function validatePolicyDecisionAgainstRequest(
  decision: CommercePolicyDecision,
  context: CommercePolicyContext
): { valid: boolean; error?: string } {
  if (decision.decision !== "approve") {
    return { valid: false, error: `Policy decision is ${decision.decision}` };
  }

  const now = new Date();
  const expDate = new Date(decision.expiry);
  if (isNaN(expDate.getTime()) || now >= expDate) {
    return { valid: false, error: "Policy decision has expired" };
  }

  const mismatches: string[] = [];
  if (decision.provider !== context.provider) mismatches.push("provider");
  if (Math.abs(decision.quotedAmount - context.quotedAmount) > 1e-6) mismatches.push("quotedAmount");

  if (decision.payloadDigest !== context.payloadDigest) mismatches.push("payloadDigest");
  if (decision.asset !== context.asset) mismatches.push("asset");
  if (decision.network !== context.network) mismatches.push("network");
  if (decision.operationType !== context.operationType) mismatches.push("operationType");

  if (mismatches.length > 0) {
    return {
      valid: false,
      error: `Policy decision invalidated due to modified values: ${mismatches.join(", ")}`,
    };
  }

  return { valid: true };
}
