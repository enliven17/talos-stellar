import { describe, it, expect } from "vitest";
import {
  evaluateCommercePolicy,
  computePayloadDigest,
  validatePolicyDecisionAgainstRequest,
  CommercePolicyContext,
} from "../src/lib/commerce-policy";

describe("A2A Commerce Policy Engine (Web / TypeScript)", () => {
  const validContext: CommercePolicyContext = {
    requester: "talos-req-123",
    provider: "talos-prov-456",
    asset: "USDC",
    network: "testnet",
    quotedAmount: 25.0,
    payloadDigest: computePayloadDigest({ service: "marketing_copy" }),
    expiration: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    operationType: "job_creation",
  };

  it("evaluates valid policy successfully", async () => {
    const decision = await evaluateCommercePolicy(validContext);
    expect(decision.decision).toBe("approve");
    expect(decision.requester).toBe("talos-req-123");
    expect(decision.provider).toBe("talos-prov-456");
    expect(decision.decisionId).toBeDefined();
    expect(decision.decisionDigest).toBeDefined();
  });

  it("fails closed on expired policy context", async () => {
    const expiredContext: CommercePolicyContext = {
      ...validContext,
      expiration: new Date(Date.now() - 60 * 1000).toISOString(),
    };
    const decision = await evaluateCommercePolicy(expiredContext);
    expect(decision.decision).toBe("deny");
    expect(decision.evidence[0]).toContain("expired");
  });

  it("fails closed on missing required parameters", async () => {
    const invalidContext: CommercePolicyContext = {
      ...validContext,
      requester: "",
    };
    const decision = await evaluateCommercePolicy(invalidContext);
    expect(decision.decision).toBe("deny");
    expect(decision.evidence[0]).toContain("Missing required parameters");
  });

  it("invalidates decision if provider changes", async () => {
    const decision = await evaluateCommercePolicy(validContext);
    const modifiedContext: CommercePolicyContext = {
      ...validContext,
      provider: "different-provider",
    };
    const check = validatePolicyDecisionAgainstRequest(decision, modifiedContext);
    expect(check.valid).toBe(false);
    expect(check.error).toContain("provider");
  });

  it("invalidates decision if quoted price changes", async () => {
    const decision = await evaluateCommercePolicy(validContext);
    const modifiedContext: CommercePolicyContext = {
      ...validContext,
      quotedAmount: 100.0,
    };
    const check = validatePolicyDecisionAgainstRequest(decision, modifiedContext);
    expect(check.valid).toBe(false);
    expect(check.error).toContain("quotedAmount");
  });

  it("invalidates decision if payload digest changes", async () => {
    const decision = await evaluateCommercePolicy(validContext);
    const modifiedContext: CommercePolicyContext = {
      ...validContext,
      payloadDigest: computePayloadDigest({ service: "tampered_service" }),
    };
    const check = validatePolicyDecisionAgainstRequest(decision, modifiedContext);
    expect(check.valid).toBe(false);
    expect(check.error).toContain("payloadDigest");
  });

  it("handles timeout gracefully by failing closed", async () => {
    const context: CommercePolicyContext = {
      ...validContext,
    };
    // Force tiny timeout to trigger fail closed timeout
    const decision = await evaluateCommercePolicy(context, { timeoutMs: 0 });
    expect(decision.decision).toBe("deny");
  });
});
