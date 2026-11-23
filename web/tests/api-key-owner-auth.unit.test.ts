import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { db } from "@/db";
import {
  createApiKeyOwnerMessage,
  verifyApiKeyOwnerProof,
} from "@/lib/api-key-owner-auth";

vi.mock("@/db", () => ({
  db: { select: vi.fn() },
}));

function mockAgent(ownerAddress: string) {
  const result = {
    creatorPublicKey: ownerAddress,
    walletPublicKey: null,
  };
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve([result]).then(resolve);
  vi.mocked(db.select).mockReturnValue(chain as never);
}

function signedRequest(
  talosId: string,
  method: string,
  keypair: Keypair,
  message = createApiKeyOwnerMessage(talosId, method),
): NextRequest {
  return new NextRequest(`http://localhost/api/talos/${talosId}/api-keys`, {
    method,
    headers: {
      "x-talos-owner-address": keypair.publicKey(),
      "x-talos-owner-message": message,
      "x-talos-owner-signature": keypair.sign(Buffer.from(message, "utf8")).toString("base64"),
    },
  });
}

describe("Scoped API key owner authorization", () => {
  const talosId = "agent-test";
  const owner = Keypair.random();

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgent(owner.publicKey());
  });

  it("accepts a fresh signature from the agent owner for the matching method", async () => {
    const request = signedRequest(talosId, "GET", owner);
    await expect(verifyApiKeyOwnerProof(request, talosId)).resolves.toBe(true);
  });

  it("rejects signatures from another wallet or for a different method", async () => {
    const otherWalletRequest = signedRequest(talosId, "POST", Keypair.random());
    const wrongMethodMessage = createApiKeyOwnerMessage(talosId, "POST");
    const wrongMethodRequest = signedRequest(talosId, "GET", owner, wrongMethodMessage);

    await expect(verifyApiKeyOwnerProof(otherWalletRequest, talosId)).resolves.toBe(false);
    await expect(verifyApiKeyOwnerProof(wrongMethodRequest, talosId)).resolves.toBe(false);
  });

  it("rejects expired ownership signatures", async () => {
    const expiredMessage = createApiKeyOwnerMessage(talosId, "DELETE", Date.now() - 6 * 60 * 1000);
    const request = signedRequest(talosId, "DELETE", owner, expiredMessage);

    await expect(verifyApiKeyOwnerProof(request, talosId)).resolves.toBe(false);
  });
});
