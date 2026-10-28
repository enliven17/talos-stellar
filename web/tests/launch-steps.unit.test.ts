/**
 * Unit tests for the launch wizard shared logic.
 *
 * Covers:
 *   - launchFormSchema: parse valid/invalid form states
 *   - buildCreateTalosPayload: snapshot of the POST /api/talos body
 *   - canNextForStep: per-step advancement guards
 *
 * No DOM / React rendering — pure function tests only.
 */
import { describe, it, expect } from "vitest";
import {
  launchFormSchema,
  LAUNCH_FORM_DEFAULTS,
  buildCreateTalosPayload,
  canNextForStep,
  type LaunchFormState,
} from "@/lib/schemas";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_FORM: LaunchFormState = {
  productName: "TestAgent",
  productDesc: "A test agent description that is long enough.",
  category: "finance",
  tokenName: "Test Mitos",
  tokenSymbol: "TEST",
  totalSupply: "1000000",
  initialPrice: "0.50",
  approvalThreshold: "100",
  gtmBudget: "500",
  persona: "Sharp and direct analyst.",
  targetAudience: "Developers and traders.",
  tone: "professional",
  creatorWallet: "",
  channels: ["X (Twitter)", "LinkedIn"],
  agentName: "testagent",
  serviceName: "Data Analysis",
  serviceDescription: "Analyzes on-chain data.",
  servicePrice: "2.50",
  serviceCurrency: "USDC",
};

const WALLET_ADDRESS = "GABC" + "A".repeat(52); // 56-char G-address stub

// ── launchFormSchema ──────────────────────────────────────────────────────────

describe("launchFormSchema", () => {
  it("parses a fully valid form state (positive)", () => {
    const result = launchFormSchema.safeParse(VALID_FORM);
    expect(result.success).toBe(true);
  });

  it("parses LAUNCH_FORM_DEFAULTS without error (positive)", () => {
    const result = launchFormSchema.safeParse(LAUNCH_FORM_DEFAULTS);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid category value (negative)", () => {
    const result = launchFormSchema.safeParse({
      ...VALID_FORM,
      category: "blockchain", // not in enum
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("category");
    }
  });

  it("rejects an invalid tone value (negative)", () => {
    const result = launchFormSchema.safeParse({
      ...VALID_FORM,
      tone: "aggressive", // not in enum
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("tone");
    }
  });

  it("rejects a tokenSymbol longer than 8 chars (boundary)", () => {
    const result = launchFormSchema.safeParse({
      ...VALID_FORM,
      tokenSymbol: "TOOLONGSYM", // 10 chars
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty agentName (defaults state has empty string)", () => {
    const result = launchFormSchema.safeParse({
      ...VALID_FORM,
      agentName: "",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty serviceName and servicePrice (service is optional)", () => {
    const result = launchFormSchema.safeParse({
      ...VALID_FORM,
      serviceName: "",
      servicePrice: "",
    });
    expect(result.success).toBe(true);
  });
});

// ── buildCreateTalosPayload ───────────────────────────────────────────────────

describe("buildCreateTalosPayload", () => {
  it("builds the expected POST /api/talos payload (snapshot)", () => {
    const payload = buildCreateTalosPayload(VALID_FORM, WALLET_ADDRESS, null);

    // Core fields
    expect(payload.name).toBe("TestAgent");
    expect(payload.category).toBe("Finance"); // capitalised
    expect(payload.description).toBe(VALID_FORM.productDesc);
    expect(payload.totalSupply).toBe(1_000_000);
    expect(payload.persona).toBe(VALID_FORM.persona);
    expect(payload.targetAudience).toBe(VALID_FORM.targetAudience);
    expect(payload.channels).toEqual(["X (Twitter)", "LinkedIn"]);
    expect(payload.toneVoice).toBe("professional");
    expect(payload.approvalThreshold).toBe(100);
    expect(payload.gtmBudget).toBe(500);
    expect(payload.initialPrice).toBe(0.5);
    expect(payload.minPatronPulse).toBe(1_000); // floor(1_000_000 / 1000)
    expect(payload.creatorPublicKey).toBe(WALLET_ADDRESS); // creatorWallet is empty
    expect(payload.walletPublicKey).toBe(WALLET_ADDRESS);
    expect(payload.onChainId).toBeUndefined();
    expect(payload.agentName).toBe("testagent");
    expect(payload.stellarAssetCode).toBe("TEST");
    expect(payload.tokenSymbol).toBe("TEST");

    // Service fields included when present
    expect(payload.serviceName).toBe("Data Analysis");
    expect(payload.serviceDescription).toBe("Analyzes on-chain data.");
    expect(payload.servicePrice).toBe(2.5);
  });

  it("omits service fields when serviceName or servicePrice is empty (negative)", () => {
    const payload = buildCreateTalosPayload(
      { ...VALID_FORM, serviceName: "", servicePrice: "" },
      WALLET_ADDRESS,
      null,
    );
    expect(payload.serviceName).toBeUndefined();
    expect(payload.serviceDescription).toBeUndefined();
    expect(payload.servicePrice).toBeUndefined();
  });

  it("uses creatorWallet when provided instead of address (boundary)", () => {
    const custom = "GCUS" + "T".repeat(52);
    const payload = buildCreateTalosPayload(
      { ...VALID_FORM, creatorWallet: custom },
      WALLET_ADDRESS,
      42,
    );
    expect(payload.creatorPublicKey).toBe(custom);
    expect(payload.walletPublicKey).toBe(WALLET_ADDRESS);
    expect(payload.onChainId).toBe(42);
  });

  it("capitalises category correctly for all enum values (regression)", () => {
    const categories: LaunchFormState["category"][] = [
      "marketing",
      "development",
      "research",
      "design",
      "finance",
      "analytics",
      "operations",
      "sales",
      "support",
      "education",
    ];
    for (const cat of categories) {
      const p = buildCreateTalosPayload(
        { ...VALID_FORM, category: cat },
        WALLET_ADDRESS,
        null,
      );
      const expected = cat.charAt(0).toUpperCase() + cat.slice(1);
      expect(p.category).toBe(expected);
    }
  });

  it("keeps stellarAssetCode undefined when tokenSymbol is empty (boundary)", () => {
    const payload = buildCreateTalosPayload(
      { ...VALID_FORM, tokenSymbol: "" },
      WALLET_ADDRESS,
      null,
    );
    expect(payload.stellarAssetCode).toBeUndefined();
  });
});

// ── canNextForStep ─────────────────────────────────────────────────────────────

describe("canNextForStep", () => {
  it("step 0: false when productName is empty (negative)", () => {
    expect(
      canNextForStep(0, { ...VALID_FORM, productName: "" }, null),
    ).toBe(false);
  });

  it("step 0: false when productDesc is empty (negative)", () => {
    expect(
      canNextForStep(0, { ...VALID_FORM, productDesc: "" }, null),
    ).toBe(false);
  });

  it("step 0: true when both productName and productDesc filled (positive)", () => {
    expect(canNextForStep(0, VALID_FORM, null)).toBe(true);
  });

  it("step 1: always true (patron step has no required fields)", () => {
    expect(canNextForStep(1, VALID_FORM, null)).toBe(true);
    expect(
      canNextForStep(1, { ...VALID_FORM, tokenName: "" }, null),
    ).toBe(true);
  });

  it("step 2: false when tokenName is empty (negative)", () => {
    expect(
      canNextForStep(2, { ...VALID_FORM, tokenName: "" }, null),
    ).toBe(false);
  });

  it("step 2: false when tokenSymbol is too short (negative)", () => {
    expect(
      canNextForStep(2, { ...VALID_FORM, tokenSymbol: "T" }, null),
    ).toBe(false);
  });

  it("step 2: false when tokenSymbol starts with a digit (negative)", () => {
    expect(
      canNextForStep(2, { ...VALID_FORM, tokenSymbol: "1TST" }, null),
    ).toBe(false);
  });

  it("step 2: false when totalSupply exceeds max (negative)", () => {
    expect(
      canNextForStep(
        2,
        { ...VALID_FORM, totalSupply: "200000000" },
        null,
      ),
    ).toBe(false);
  });

  it("step 2: true for a valid token config (positive)", () => {
    expect(canNextForStep(2, VALID_FORM, null)).toBe(true);
  });

  it("step 3: false when approvalThreshold is empty (negative)", () => {
    expect(
      canNextForStep(3, { ...VALID_FORM, approvalThreshold: "" }, null),
    ).toBe(false);
  });

  it("step 3: true when both threshold and budget are set (positive)", () => {
    expect(canNextForStep(3, VALID_FORM, null)).toBe(true);
  });

  it("step 4: false when agentName is too short (negative)", () => {
    expect(
      canNextForStep(
        4,
        { ...VALID_FORM, agentName: "ab" },
        true,
      ),
    ).toBe(false);
  });

  it("step 4: false when nameAvailable is false (negative)", () => {
    expect(canNextForStep(4, VALID_FORM, false)).toBe(false);
  });

  it("step 4: false when nameAvailable is null (not yet checked)", () => {
    expect(canNextForStep(4, VALID_FORM, null)).toBe(false);
  });

  it("step 4: false when channels is empty (negative)", () => {
    expect(
      canNextForStep(4, { ...VALID_FORM, channels: [] }, true),
    ).toBe(false);
  });

  it("step 4: true when all agent fields valid and name available (positive)", () => {
    expect(canNextForStep(4, VALID_FORM, true)).toBe(true);
  });

  it("step 5 (review): always true (positive)", () => {
    expect(canNextForStep(5, VALID_FORM, null)).toBe(true);
  });
});
