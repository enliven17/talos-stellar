import { vi, describe, it, expect, beforeEach } from "vitest";
import { POST as signPOST } from "../src/app/api/talos/[id]/sign/route";
import { createTalosSchema } from "../src/lib/schemas";

// Real Stellar public keys with verified CRC16 checksums
const VALID_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const BAD_CHECKSUM_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA6";

// ── Sign Route mocks ───────────────────────────────────────────────
const signMocks = vi.hoisted(() => ({
  verifyAgentApiKey: vi.fn(),
  select: vi.fn(),
  signX402Payment: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: (...args: unknown[]) => signMocks.verifyAgentApiKey(...args),
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => signMocks.select(...args),
    insert: (...args: unknown[]) => signMocks.insert?.(...args) ?? { values: () => ({ returning: () => Promise.resolve([]) }) },
    transaction: (...args: unknown[]) => signMocks.transaction?.(...args) ?? Promise.resolve(),
  },
}));

vi.mock("@/lib/stellar-x402", () => ({
  signX402Payment: (...args: unknown[]) => signMocks.signX402Payment(...args),
}));

vi.mock("@/lib/stellar", () => ({
  createAgentKeypair: vi.fn().mockResolvedValue({ publicKey: "GMOCK", secretKey: "S0MOCK" }),
  fundTestnetAccount: vi.fn().mockResolvedValue(undefined),
  verifyStellarSignature: vi.fn().mockResolvedValue(true),
}));

// ── Helpers ────────────────────────────────────────────────────────
const SIGN_ID = "sign-route-test";
const API_KEY = "tak_sign_route_test_key";

function signRequest(body: unknown): Request {
  return new Request(`http://localhost/api/talos/${SIGN_ID}/sign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

function selectChain(result: unknown) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((resolve?: Function) => {
      if (resolve) return Promise.resolve(resolve(result));
      return Promise.resolve(result);
    }),
  };
  return chain;
}

// ── Sign Route Tests ───────────────────────────────────────────────
describe("POST /api/talos/:id/sign — asset field pair tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[`TALOS_AGENT_SECRET_${SIGN_ID}`] = "test-secret-key";

    signMocks.verifyAgentApiKey.mockResolvedValue({
      ok: true,
      talos: { id: SIGN_ID, apiKey: API_KEY },
    });
    signMocks.select.mockReturnValue(
      selectChain([
        {
          agentWalletId: "wallet-1",
          agentWalletAddress: "GAGENTWALLET",
          approvalThreshold: "100.00",
        },
      ]),
    );
    signMocks.signX402Payment.mockResolvedValue({ paymentToken: "mock-payment-token" });
  });

  it("accepts legacy assetCode: 'USDC' and passes it to x402", async () => {
    const response = await signPOST(
      signRequest({ payee: "GPAYEE", amount: "5.00", assetCode: "USDC" }) as never,
      { params: Promise.resolve({ id: SIGN_ID }) },
    );

    expect(response.status).toBe(200);
    expect(signMocks.signX402Payment).toHaveBeenCalledWith(
      "test-secret-key",
      expect.objectContaining({ assetCode: "USDC" }),
    );
    const body = await response.json();
    expect(body.assetCode).toBe("USDC");
  });

  it("accepts new typed native asset and defaults assetCode to USDC", async () => {
    const response = await signPOST(
      signRequest({ payee: "GPAYEE", amount: "5.00", asset: { native: true } }) as never,
      { params: Promise.resolve({ id: SIGN_ID }) },
    );

    expect(response.status).toBe(200);
    // native asset has no code → route defaults to "USDC"
    expect(signMocks.signX402Payment).toHaveBeenCalledWith(
      "test-secret-key",
      expect.objectContaining({ assetCode: "USDC" }),
    );
  });

  it("accepts new typed issued asset and extracts code", async () => {
    const response = await signPOST(
      signRequest({
        payee: "GPAYEE",
        amount: "5.00",
        asset: { code: "USDC", issuer: VALID_ISSUER },
      }) as never,
      { params: Promise.resolve({ id: SIGN_ID }) },
    );

    expect(response.status).toBe(200);
    expect(signMocks.signX402Payment).toHaveBeenCalledWith(
      "test-secret-key",
      expect.objectContaining({ assetCode: "USDC" }),
    );
    const body = await response.json();
    expect(body.assetCode).toBe("USDC");
  });

  it("rejects issued asset with invalid issuer checksum", async () => {
    const response = await signPOST(
      signRequest({
        payee: "GPAYEE",
        amount: "5.00",
        asset: { code: "USDC", issuer: BAD_CHECKSUM_ISSUER },
      }) as never,
      { params: Promise.resolve({ id: SIGN_ID }) },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(signMocks.signX402Payment).not.toHaveBeenCalled();
  });

  it("rejects issued asset with lowercase code", async () => {
    const response = await signPOST(
      signRequest({
        payee: "GPAYEE",
        amount: "5.00",
        asset: { code: "usdc", issuer: VALID_ISSUER },
      }) as never,
      { params: Promise.resolve({ id: SIGN_ID }) },
    );

    expect(response.status).toBe(400);
    expect(signMocks.signX402Payment).not.toHaveBeenCalled();
  });

  it("rejects issued asset with code exceeding 12 chars", async () => {
    const response = await signPOST(
      signRequest({
        payee: "GPAYEE",
        amount: "5.00",
        asset: { code: "ABCDEFGHIJKLM", issuer: VALID_ISSUER },
      }) as never,
      { params: Promise.resolve({ id: SIGN_ID }) },
    );

    expect(response.status).toBe(400);
    expect(signMocks.signX402Payment).not.toHaveBeenCalled();
  });

  it("prefers asset.code over legacy assetCode when both provided", async () => {
    const response = await signPOST(
      signRequest({
        payee: "GPAYEE",
        amount: "5.00",
        asset: { code: "USDC", issuer: VALID_ISSUER },
        assetCode: "XLM",
      }) as never,
      { params: Promise.resolve({ id: SIGN_ID }) },
    );

    expect(response.status).toBe(200);
    // asset.code ("USDC") should take precedence over legacy assetCode ("XLM")
    expect(signMocks.signX402Payment).toHaveBeenCalledWith(
      "test-secret-key",
      expect.objectContaining({ assetCode: "USDC" }),
    );
  });

  it("falls back to legacy assetCode when asset is omitted", async () => {
    const response = await signPOST(
      signRequest({ payee: "GPAYEE", amount: "5.00", assetCode: "USDC" }) as never,
      { params: Promise.resolve({ id: SIGN_ID }) },
    );

    expect(response.status).toBe(200);
    expect(signMocks.signX402Payment).toHaveBeenCalledWith(
      "test-secret-key",
      expect.objectContaining({ assetCode: "USDC" }),
    );
  });

  it("defaults to USDC when both asset and assetCode are omitted", async () => {
    const response = await signPOST(
      signRequest({ payee: "GPAYEE", amount: "5.00" }) as never,
      { params: Promise.resolve({ id: SIGN_ID }) },
    );

    expect(response.status).toBe(200);
    expect(signMocks.signX402Payment).toHaveBeenCalledWith(
      "test-secret-key",
      expect.objectContaining({ assetCode: "USDC" }),
    );
  });
});

// ── Create Talos route tests for stellarAssetCode ──────────────────
describe("POST /api/talos — stellarAssetCode pair tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const base = {
    name: "Test Agent",
    category: "Development",
    description: "A test agent",
    creatorPublicKey: "GCREATOR",
    signature: "sig",
    message: "msg",
  };

  it("accepts valid CODE:ISSUER format", () => {
    const result = createTalosSchema.safeParse({
      ...base,
      stellarAssetCode: `MITOS:${VALID_ISSUER}`,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stellarAssetCode).toBe(`MITOS:${VALID_ISSUER}`);
    }
  });

  it("rejects CODE: with invalid checksum issuer", () => {
    const result = createTalosSchema.safeParse({
      ...base,
      stellarAssetCode: `MITOS:${BAD_CHECKSUM_ISSUER}`,
    });
    expect(result.success).toBe(false);
  });

  it("accepts null stellarAssetCode", () => {
    const result = createTalosSchema.safeParse({
      ...base,
      stellarAssetCode: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects code-only without issuer", () => {
    const result = createTalosSchema.safeParse({
      ...base,
      stellarAssetCode: "MITOS",
    });
    expect(result.success).toBe(false);
  });
});
