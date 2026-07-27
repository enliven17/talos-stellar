import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/talos/[id]/transfer/route";
import { transferSchema } from "../src/lib/schemas";
import {
  canonicalizeTransferPayload,
  signTransferPayload,
  verifyTransferSignature,
  type TransferSignedPayload,
} from "../src/lib/transfer-signature";

const mocks = vi.hoisted(() => ({
  verifyAgentApiKey: vi.fn(),
  select: vi.fn(),
  sendUSDC: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: (...args: unknown[]) => mocks.verifyAgentApiKey(...args),
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mocks.select(...args),
  },
}));

vi.mock("@/lib/stellar", () => ({
  sendUSDC: (...args: unknown[]) => mocks.sendUSDC(...args),
}));

const AGENT_ID = "agent-transfer-test";
const API_KEY = "tak_transfer_signature_test_secret";
const AGENT_SECRET_ENV = `TALOS_AGENT_SECRET_${AGENT_ID}`;
const DESTINATION = Keypair.random().publicKey();
const OTHER_DESTINATION = Keypair.random().publicKey();

let nonceSequence = 0;

function nextNonce(): string {
  nonceSequence += 1;
  return nonceSequence.toString(16).padStart(64, "0");
}

function payload(
  overrides: Partial<TransferSignedPayload> = {},
): TransferSignedPayload {
  return {
    agent: AGENT_ID,
    destination: DESTINATION,
    asset: "USDC",
    amount: "10.00",
    nonce: nextNonce(),
    expiry: String(Math.floor(Date.now() / 1000) + 60),
    ...overrides,
  };
}

function signedBody(
  signedPayload = payload(),
): TransferSignedPayload & { signature: string } {
  return {
    ...signedPayload,
    signature: signTransferPayload(signedPayload, API_KEY),
  };
}

function request(body: unknown): Request {
  return new Request(`http://localhost/api/talos/${AGENT_ID}/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown) {
  return POST(request(body) as never, {
    params: Promise.resolve({ id: AGENT_ID }),
  });
}

describe("canonical transfer signatures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[AGENT_SECRET_ENV] = "server-held-stellar-secret";

    mocks.verifyAgentApiKey.mockResolvedValue({
      ok: true,
      talos: { id: AGENT_ID, apiKey: API_KEY },
    });
    mocks.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ approvalThreshold: "100.00" }]),
        }),
      }),
    });
    mocks.sendUSDC.mockResolvedValue({ txHash: "stellar-tx-hash" });
  });

  it("defines a stable canonical payload containing every transfer field", () => {
    const signedPayload: TransferSignedPayload = {
      agent: "agent-1",
      destination: DESTINATION,
      asset: "USDC",
      amount: "10.00",
      nonce: "ab".repeat(32),
      expiry: "1784880300",
    };

    expect(canonicalizeTransferPayload(signedPayload)).toBe(
      `talos.transfer.v1:{"agent":"agent-1","destination":"${DESTINATION}","asset":"USDC","amount":"10.00","nonce":"${"ab".repeat(32)}","expiry":"1784880300"}`,
    );
  });

  it("creates a transfer only after verifying the exact signed payload", async () => {
    const body = signedBody();
    const response = await post(body);

    expect(response.status).toBe(200);
    expect(mocks.sendUSDC).toHaveBeenCalledTimes(1);
    expect(mocks.sendUSDC).toHaveBeenCalledWith(
      "server-held-stellar-secret",
      DESTINATION,
      "10.00",
    );
    await expect(response.json()).resolves.toMatchObject({
      status: "completed",
      currency: "USDC",
      to: DESTINATION,
      amount: "10.00",
      txHash: "stellar-tx-hash",
    });
  });

  it.each([
    ["destination", (body: ReturnType<typeof signedBody>) => {
      body.destination = OTHER_DESTINATION;
    }],
    ["amount", (body: ReturnType<typeof signedBody>) => {
      body.amount = "11.00";
    }],
    ["nonce", (body: ReturnType<typeof signedBody>) => {
      body.nonce = "cd".repeat(32);
    }],
    ["expiry", (body: ReturnType<typeof signedBody>) => {
      body.expiry = String(Number(body.expiry) + 1);
    }],
  ])("rejects a signed request with a tampered %s", async (_field, tamper) => {
    const body = signedBody();
    tamper(body);

    const response = await post(body);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid transfer signature",
    });
    expect(mocks.sendUSDC).not.toHaveBeenCalled();
  });

  it("cryptographically binds the signature to the asset", () => {
    const signedPayload = payload();
    const signature = signTransferPayload(signedPayload, API_KEY);

    expect(
      verifyTransferSignature(
        { ...signedPayload, asset: "XLM" },
        API_KEY,
        signature,
      ),
    ).toBe(false);
  });

  it("rejects an altered asset before transfer creation", async () => {
    const body = signedBody();
    body.asset = "XLM";

    const response = await post(body);

    expect(response.status).toBe(400);
    expect(mocks.sendUSDC).not.toHaveBeenCalled();
  });

  it("rejects a signature from another agent", async () => {
    const body = signedBody(payload({ agent: "another-agent" }));

    const response = await post(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Signed transfer agent does not match the target TALOS",
    });
    expect(mocks.sendUSDC).not.toHaveBeenCalled();
  });

  it("rejects an exact signed request when its nonce is replayed", async () => {
    const body = signedBody();

    const first = await post(body);
    const replay = await post(body);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({
      error: "Transfer authorization already used (replay detected)",
    });
    expect(mocks.sendUSDC).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired signed request", async () => {
    const body = signedBody(
      payload({ expiry: String(Math.floor(Date.now() / 1000) - 1) }),
    );

    const response = await post(body);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Transfer authorization has expired",
    });
    expect(mocks.sendUSDC).not.toHaveBeenCalled();
  });

  it("rejects an authorization outside the five-minute expiry window", async () => {
    const body = signedBody(
      payload({ expiry: String(Math.floor(Date.now() / 1000) + 3_600) }),
    );

    const response = await post(body);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Transfer authorization expiry exceeds the five-minute limit",
    });
    expect(mocks.sendUSDC).not.toHaveBeenCalled();
  });

  it("rejects non-canonical and ambiguous request encodings", () => {
    const valid = signedBody();
    const cases = [
      { ...valid, amount: 10 },
      { ...valid, amount: "10" },
      { ...valid, amount: "10.0" },
      { ...valid, amount: "010.00" },
      { ...valid, amount: "1e1" },
      { ...valid, asset: "usdc" },
      { ...valid, nonce: "AB".repeat(32) },
      { ...valid, expiry: Number(valid.expiry) },
      { ...valid, expiry: `0${valid.expiry}` },
      { ...valid, signature: valid.signature.toUpperCase() },
      { ...valid, to: valid.destination },
    ];

    for (const candidate of cases) {
      expect(transferSchema.safeParse(candidate).success).toBe(false);
    }
  });
});
