/**
 * Tests for x402 buyer proof diagnostics (issue #586).
 *
 * Covers:
 *   - diagnoseBuyerProof() — all stages, privacy guarantees, boundary inputs
 *   - purchaseServiceWithPayment() — onProofDiagnostic callback integration
 *   - No sensitive values (paymentHeader, raw header text) ever appear in output
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  diagnoseBuyerProof,
  parseX402Challenge,
  TalosPaymentError,
} from "../src/errors.js";
import type {
  BuyerProofDiagnostics,
  X402ProofStage,
} from "../src/types.js";
import { TalosClient } from "../src/client.js";

// ── diagnoseBuyerProof() unit tests ─────────────────────────────────────────

describe("diagnoseBuyerProof", () => {
  const PATH = "/api/talos/abc/service";

  const CHALLENGE: Record<string, string> = {
    payee: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
    price: "1.50",
    token: "USDC",
    network: "stellar:testnet",
  };

  // ── no_challenge stage ──────────────────────────────────────────

  it("returns no_challenge when challenge is undefined", () => {
    const diag = diagnoseBuyerProof(PATH, undefined, "no_challenge");
    expect(diag.stage).toBe("no_challenge");
    expect(diag.challenge).toBeUndefined();
    expect(diag.succeeded).toBe(false);
    expect(diag.summary).toContain(PATH);
  });

  // ── challenge_parsed stage ──────────────────────────────────────

  it("includes parsed challenge fields in challenge_parsed stage", () => {
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "challenge_parsed");
    expect(diag.stage).toBe("challenge_parsed");
    expect(diag.challenge).toBeDefined();
    expect(diag.challenge!.payee).toBe(CHALLENGE.payee);
    expect(diag.challenge!.price).toBe("1.50");
    expect(diag.challenge!.token).toBe("USDC");
    expect(diag.challenge!.network).toBe("stellar:testnet");
    expect(diag.parsedAmount).toBeCloseTo(1.5);
    expect(diag.succeeded).toBe(false);
  });

  it("sets parsedAmount to NaN when challenge price is not a number", () => {
    const badChallenge = { payee: "G123", price: "not-a-number", token: "USDC" };
    const diag = diagnoseBuyerProof(PATH, badChallenge, "challenge_parsed");
    expect(Number.isNaN(diag.parsedAmount)).toBe(true);
  });

  it("sets parsedAmount to NaN when challenge price is empty string", () => {
    const badChallenge = { payee: "G123", price: "", token: "USDC" };
    const diag = diagnoseBuyerProof(PATH, badChallenge, "challenge_parsed");
    expect(Number.isNaN(diag.parsedAmount)).toBe(true);
  });

  // ── signing_requested stage ─────────────────────────────────────

  it("challenge_parsed stage does not yet include signing outcome", () => {
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "signing_requested");
    expect(diag.stage).toBe("signing_requested");
    expect(diag.signingSucceeded).toBeUndefined();
    expect(diag.signingFailureReason).toBeUndefined();
  });

  // ── proof_submitted stage ───────────────────────────────────────

  it("records signing success in proof_submitted", () => {
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "proof_submitted", {
      signingSucceeded: true,
      proofResponseStatus: 200,
    });
    expect(diag.signingSucceeded).toBe(true);
    expect(diag.proofResponseStatus).toBe(200);
    expect(diag.succeeded).toBe(true);
  });

  it("records signing failure with reason in proof_submitted", () => {
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "proof_submitted", {
      signingSucceeded: false,
      signingFailureReason: "Wallet not initialised",
    });
    expect(diag.signingSucceeded).toBe(false);
    expect(diag.signingFailureReason).toBe("Wallet not initialised");
    expect(diag.succeeded).toBe(false);
  });

  // ── proof_accepted stage ────────────────────────────────────────

  it("marks succeeded=true for proof_accepted", () => {
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "proof_accepted");
    expect(diag.succeeded).toBe(true);
    expect(diag.stage).toBe("proof_accepted");
    expect(diag.summary).toContain("accepted");
  });

  // ── proof_rejected stage ────────────────────────────────────────

  it("marks succeeded=false for proof_rejected", () => {
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "proof_rejected", {
      proofResponseStatus: 403,
    });
    expect(diag.succeeded).toBe(false);
    expect(diag.stage).toBe("proof_rejected");
    expect(diag.proofResponseStatus).toBe(403);
    expect(diag.summary).toContain("rejected");
    expect(diag.summary).toContain("403");
  });

  // ── Privacy guarantees ──────────────────────────────────────────

  it("never includes paymentHeader in any diagnostic", () => {
    const stages: X402ProofStage[] = [
      "no_challenge",
      "challenge_parsed",
      "signing_requested",
      "proof_submitted",
      "proof_accepted",
      "proof_rejected",
    ];
    for (const stage of stages) {
      const diag = diagnoseBuyerProof(PATH, CHALLENGE, stage, {
        signingSucceeded: true,
        proofResponseStatus: 200,
      });
      // Serialize to catch any stray field
      const json = JSON.stringify(diag);
      expect(json).not.toContain("paymentHeader");
      expect(json).not.toContain("X-PAYMENT");
    }
  });

  it("never includes raw WWW-Authenticate header value in diagnostics", () => {
    const rawHeader =
      'x402 price="1.50", payee="G123ABC", token="USDC"';
    // The raw header itself must never appear verbatim in any diagnostic
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "challenge_parsed");
    const json = JSON.stringify(diag);
    expect(json).not.toContain(rawHeader);
  });

  it("truncates signingFailureReason to 200 chars", () => {
    const longReason = "x".repeat(500);
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "proof_submitted", {
      signingSucceeded: false,
      signingFailureReason: longReason,
    });
    expect(diag.signingFailureReason!.length).toBe(200);
  });

  // ── Metadata fields ─────────────────────────────────────────────

  it("includes capturedAt as a valid ISO 8601 string", () => {
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "challenge_parsed");
    expect(() => new Date(diag.capturedAt)).not.toThrow();
    expect(new Date(diag.capturedAt).toISOString()).toBe(diag.capturedAt);
  });

  it("includes path in diagnostics", () => {
    const diag = diagnoseBuyerProof(PATH, CHALLENGE, "challenge_parsed");
    expect(diag.path).toBe(PATH);
  });

  it("omits optional fields when not provided", () => {
    const diag = diagnoseBuyerProof(PATH, undefined, "no_challenge");
    expect(diag.challenge).toBeUndefined();
    expect(diag.parsedAmount).toBeUndefined();
    expect(diag.signingSucceeded).toBeUndefined();
    expect(diag.signingFailureReason).toBeUndefined();
    expect(diag.proofResponseStatus).toBeUndefined();
  });

  // ── Boundary: zero price ────────────────────────────────────────

  it("handles zero price correctly", () => {
    const diag = diagnoseBuyerProof(PATH, { payee: "G123", price: "0" }, "challenge_parsed");
    expect(diag.parsedAmount).toBe(0);
  });

  // ── Boundary: very large price ──────────────────────────────────

  it("handles large price correctly", () => {
    const diag = diagnoseBuyerProof(PATH, { payee: "G123", price: "999999.99" }, "challenge_parsed");
    expect(diag.parsedAmount).toBeCloseTo(999999.99);
  });
});

// ── purchaseServiceWithPayment integration (mock fetch) ─────────────────────

describe("purchaseServiceWithPayment — onProofDiagnostic callback", () => {
  const SELLER_ID = "seller-talos-1";
  const BUYER_ID = "buyer-talos-1";

  function makeMockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
    let callIdx = 0;
    return vi.fn(async (_url: string, _init?: RequestInit) => {
      const resp = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      const headersMap = new Map(Object.entries(resp.headers ?? {}));
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        headers: {
          get: (k: string) => headersMap.get(k.toLowerCase()) ?? null,
        },
        json: async () => resp.body,
        text: async () => JSON.stringify(resp.body),
      } as unknown as Response;
    });
  }

  it("calls onProofDiagnostic with challenge_parsed when 402 received", async () => {
    const diagnostics: BuyerProofDiagnostics[] = [];

    // Fetch 1: 402 with challenge; Fetch 2: sign call → signed; Fetch 3: success
    const mockFetch = makeMockFetch([
      {
        status: 402,
        body: { error: "payment required" },
        headers: {
          "www-authenticate":
            'x402 price="1.50", payee="GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37", token="USDC"',
        },
      },
      {
        status: 200,
        body: {
          paymentHeader: "X-PAYMENT-VALUE",
          from: "GBUYER",
          to: "GSELLER",
          amount: "1.50",
        },
      },
      {
        status: 200,
        body: { id: "job-1", status: "pending" },
      },
    ]);

    const client = new TalosClient({
      apiKey: "test-key",
      fetch: mockFetch as unknown as typeof fetch,
    });

    await client.purchaseServiceWithPayment(SELLER_ID, BUYER_ID, {}, {
      onProofDiagnostic: (diag) => diagnostics.push(diag),
    });

    // Should have received at least one diagnostic for challenge_parsed
    const parsed = diagnostics.find((d) => d.stage === "challenge_parsed");
    expect(parsed).toBeDefined();
    expect(parsed!.challenge?.payee).toBe(
      "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
    );
    expect(parsed!.challenge?.price).toBe("1.50");
    expect(parsed!.challenge?.token).toBe("USDC");
  });

  it("calls onProofDiagnostic with proof_accepted on successful purchase", async () => {
    const diagnostics: BuyerProofDiagnostics[] = [];

    const mockFetch = makeMockFetch([
      {
        status: 402,
        body: {},
        headers: {
          "www-authenticate":
            'x402 price="0.50", payee="GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37", token="USDC"',
        },
      },
      {
        status: 200,
        body: { paymentHeader: "ph", from: "F", to: "T", amount: "0.50" },
      },
      { status: 200, body: { id: "job-2", status: "pending" } },
    ]);

    const client = new TalosClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await client.purchaseServiceWithPayment(SELLER_ID, BUYER_ID, undefined, {
      onProofDiagnostic: (d) => diagnostics.push(d),
    });

    const accepted = diagnostics.find((d) => d.stage === "proof_accepted");
    expect(accepted).toBeDefined();
    expect(accepted!.succeeded).toBe(true);
  });

  it("calls onProofDiagnostic with no_challenge when WWW-Authenticate is missing", async () => {
    const diagnostics: BuyerProofDiagnostics[] = [];

    const mockFetch = makeMockFetch([
      {
        status: 402,
        body: { error: "payment required" },
        headers: {}, // no www-authenticate
      },
    ]);

    const client = new TalosClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.purchaseServiceWithPayment(SELLER_ID, BUYER_ID, undefined, {
        onProofDiagnostic: (d) => diagnostics.push(d),
      }),
    ).rejects.toBeInstanceOf(TalosPaymentError);

    const noChal = diagnostics.find((d) => d.stage === "no_challenge");
    expect(noChal).toBeDefined();
    expect(noChal!.succeeded).toBe(false);
  });

  it("never includes paymentHeader value in diagnostic output", async () => {
    const diagnostics: BuyerProofDiagnostics[] = [];
    const PAYMENT_HEADER_VALUE = "super-secret-payment-header-value";

    const mockFetch = makeMockFetch([
      {
        status: 402,
        body: {},
        headers: {
          "www-authenticate":
            'x402 price="1.00", payee="GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37"',
        },
      },
      {
        status: 200,
        body: {
          paymentHeader: PAYMENT_HEADER_VALUE,
          from: "F",
          to: "T",
          amount: "1.00",
        },
      },
      { status: 200, body: { id: "job-3", status: "pending" } },
    ]);

    const client = new TalosClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await client.purchaseServiceWithPayment(SELLER_ID, BUYER_ID, undefined, {
      onProofDiagnostic: (d) => diagnostics.push(d),
    });

    for (const diag of diagnostics) {
      const json = JSON.stringify(diag);
      expect(json).not.toContain(PAYMENT_HEADER_VALUE);
    }
  });

  it("does not throw if onProofDiagnostic callback throws", async () => {
    const mockFetch = makeMockFetch([
      {
        status: 402,
        body: {},
        headers: {
          "www-authenticate":
            'x402 price="1.00", payee="GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37"',
        },
      },
      { status: 200, body: { paymentHeader: "ph", from: "F", to: "T", amount: "1.00" } },
      { status: 200, body: { id: "job-4", status: "pending" } },
    ]);

    const client = new TalosClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    // The callback throws — the payment must still succeed
    await expect(
      client.purchaseServiceWithPayment(SELLER_ID, BUYER_ID, undefined, {
        onProofDiagnostic: () => {
          throw new Error("Callback blew up!");
        },
      }),
    ).resolves.toBeDefined();
  });

  it("works without onProofDiagnostic (backward compat — no regression)", async () => {
    const mockFetch = makeMockFetch([
      {
        status: 402,
        body: {},
        headers: {
          "www-authenticate":
            'x402 price="1.00", payee="GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37"',
        },
      },
      { status: 200, body: { paymentHeader: "ph", from: "F", to: "T", amount: "1.00" } },
      { status: 200, body: { id: "job-5", status: "pending" } },
    ]);

    const client = new TalosClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    // No onProofDiagnostic — should work exactly as before
    const job = await client.purchaseServiceWithPayment(SELLER_ID, BUYER_ID);
    expect(job).toBeDefined();
  });

  it("calls onProofDiagnostic with proof_rejected when proof submission fails", async () => {
    const diagnostics: BuyerProofDiagnostics[] = [];

    const mockFetch = makeMockFetch([
      {
        status: 402,
        body: {},
        headers: {
          "www-authenticate":
            'x402 price="1.00", payee="GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37"',
        },
      },
      { status: 200, body: { paymentHeader: "ph", from: "F", to: "T", amount: "1.00" } },
      // Service rejects the proof
      { status: 403, body: { error: "proof rejected" } },
    ]);

    const client = new TalosClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(
      client.purchaseServiceWithPayment(SELLER_ID, BUYER_ID, undefined, {
        onProofDiagnostic: (d) => diagnostics.push(d),
      }),
    ).rejects.toBeDefined();

    const rejected = diagnostics.find((d) => d.stage === "proof_rejected");
    expect(rejected).toBeDefined();
    expect(rejected!.succeeded).toBe(false);
    expect(rejected!.proofResponseStatus).toBe(403);
  });

  // ── Boundary: direct success (no 402) ──────────────────────────

  it("emits no diagnostics when the service returns 200 directly (no 402)", async () => {
    const diagnostics: BuyerProofDiagnostics[] = [];

    const mockFetch = makeMockFetch([
      { status: 200, body: { id: "job-direct", status: "pending" } },
    ]);

    const client = new TalosClient({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await client.purchaseServiceWithPayment(SELLER_ID, BUYER_ID, undefined, {
      onProofDiagnostic: (d) => diagnostics.push(d),
    });

    expect(diagnostics).toHaveLength(0);
  });
});

// ── Wire-level fixture: parseX402Challenge integration ──────────────────────

describe("parseX402Challenge — boundary inputs for proof diagnostics", () => {
  it("returns undefined for null input", () => {
    expect(parseX402Challenge(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseX402Challenge("")).toBeUndefined();
  });

  it("returns undefined for non-x402 scheme", () => {
    expect(parseX402Challenge('Bearer realm="example"')).toBeUndefined();
  });

  it("returns undefined when payee is missing", () => {
    expect(parseX402Challenge('x402 price="1.00"')).toBeUndefined();
  });

  it("returns undefined when price is missing", () => {
    expect(parseX402Challenge('x402 payee="G123"')).toBeUndefined();
  });

  it("parses a minimal valid challenge", () => {
    const result = parseX402Challenge('x402 price="0.50", payee="GTEST123"');
    expect(result).toEqual({ price: "0.50", payee: "GTEST123" });
  });

  it("parses a full challenge with token and network", () => {
    const result = parseX402Challenge(
      'x402 price="1.50", payee="GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37", token="USDC", network="stellar:testnet"',
    );
    expect(result?.token).toBe("USDC");
    expect(result?.network).toBe("stellar:testnet");
    expect(result?.payee).toBe("GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37");
  });

  it("handles leading/trailing whitespace in the header value", () => {
    const result = parseX402Challenge(
      '  x402 price="1.00", payee="GTEST"  ',
    );
    expect(result).toBeDefined();
    expect(result?.price).toBe("1.00");
  });
});
