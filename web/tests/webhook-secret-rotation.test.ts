import { createHmac, randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const WEBHOOK_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("hex");

describe("Webhook secret rotation (zero-downtime)", () => {
  beforeEach(() => {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = WEBHOOK_SECRET_ENCRYPTION_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  describe("dual-sign / multi-secret verify", () => {
    it("dual-signs so either current or previous secret verifies", async () => {
      const { signPayload, verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "approval.approved", id: "evt_1" });
      const previous = "whsec_previous_secret_aaaaaaaa";
      const current = "whsec_current_secret_bbbbbbbbb";

      const header = signPayload(payload, [current, previous]);
      expect(header).toMatch(/^v1=[a-f0-9]+,v1=[a-f0-9]+,t=\d+$/);

      expect(verifySignature(payload, header, current)).toBe(true);
      expect(verifySignature(payload, header, previous)).toBe(true);
      expect(verifySignature(payload, header, "whsec_unrelated_secret_xxxx")).toBe(false);
    });

    it("single-secret signature remains backward compatible", async () => {
      const { signPayload, verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "test", data: { foo: "bar" } });
      const secret = "whsec_test_secret_key_12345678";
      const header = signPayload(payload, secret);
      expect(header).toMatch(/^v1=[a-f0-9]+,t=\d+$/);
      expect(verifySignature(payload, header, secret)).toBe(true);
    });

    it("accepts consumer-side secret arrays against a single signature", async () => {
      const { signPayload, verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "revenue.recorded" });
      const oldSecret = "whsec_old_secret_key_12345678";
      const newSecret = "whsec_new_secret_key_87654321";

      const header = signPayload(payload, newSecret);
      expect(verifySignature(payload, header, [oldSecret, newSecret])).toBe(true);
      expect(verifySignature(payload, header, [oldSecret])).toBe(false);
    });

    it("rejects empty secret lists", async () => {
      const { signPayload, verifySignature } = await import("@/lib/webhooks/signing");
      const payload = "{}";
      expect(() => signPayload(payload, [])).toThrow(/At least one signing secret/);
      expect(verifySignature(payload, "v1=abc,t=1", [])).toBe(false);
    });

    it("still rejects expired dual-signed headers", async () => {
      const { verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "test" });
      const secret = "whsec_test_secret_key_12345678";
      const oldTs = Math.floor(Date.now() / 1000) - 600;
      const dataToSign = `1.${oldTs}.${payload}`;
      const hmac = createHmac("sha256", secret).update(dataToSign).digest("hex");
      const header = `v1=${hmac},v1=${hmac},t=${oldTs}`;
      expect(verifySignature(payload, header, secret)).toBe(false);
    });

    it("rejects malformed dual-sign headers", async () => {
      const { verifySignature } = await import("@/lib/webhooks/signing");
      const secret = "whsec_test_secret_key_12345678";
      expect(verifySignature("{}", null, secret)).toBe(false);
      expect(verifySignature("{}", "v1=deadbeef", secret)).toBe(false);
      expect(verifySignature("{}", "t=12345", secret)).toBe(false);
    });
  });

  describe("resolveSigningSecrets", () => {
    it("returns only current when no previous secret", async () => {
      const { encryptSecret } = await import("@/lib/webhooks/signing");
      const { resolveSigningSecrets } = await import("@/lib/webhooks/rotation");
      const current = "whsec_only_current_secret_xx";
      const bundle = resolveSigningSecrets({
        secretCiphertext: encryptSecret(current),
        previousSecretCiphertext: null,
        previousSecretExpiresAt: null,
        signatureVersion: 1,
      });
      expect(bundle.secrets).toEqual([current]);
      expect(bundle.rotationActive).toBe(false);
    });

    it("includes previous while grace window is active", async () => {
      const { encryptSecret } = await import("@/lib/webhooks/signing");
      const { resolveSigningSecrets } = await import("@/lib/webhooks/rotation");
      const current = "whsec_current_secret_yyyyyyyy";
      const previous = "whsec_previous_secret_zzzzzzz";
      const expires = new Date(Date.now() + 60_000);
      const bundle = resolveSigningSecrets({
        secretCiphertext: encryptSecret(current),
        previousSecretCiphertext: encryptSecret(previous),
        previousSecretExpiresAt: expires,
        signatureVersion: 1,
      });
      expect(bundle.secrets).toEqual([current, previous]);
      expect(bundle.rotationActive).toBe(true);
    });

    it("omits expired previous secret (lazy expiry)", async () => {
      const { encryptSecret } = await import("@/lib/webhooks/signing");
      const { resolveSigningSecrets } = await import("@/lib/webhooks/rotation");
      const current = "whsec_current_secret_yyyyyyyy";
      const previous = "whsec_previous_secret_zzzzzzz";
      const expires = new Date(Date.now() - 1_000);
      const bundle = resolveSigningSecrets({
        secretCiphertext: encryptSecret(current),
        previousSecretCiphertext: encryptSecret(previous),
        previousSecretExpiresAt: expires,
        signatureVersion: 1,
      });
      expect(bundle.secrets).toEqual([current]);
      expect(bundle.rotationActive).toBe(false);
    });

    it("dual-sign header from resolved secrets verifies with either key", async () => {
      const { encryptSecret, signPayload, verifySignature } = await import(
        "@/lib/webhooks/signing"
      );
      const { resolveSigningSecrets } = await import("@/lib/webhooks/rotation");
      const current = "whsec_current_secret_yyyyyyyy";
      const previous = "whsec_previous_secret_zzzzzzz";
      const bundle = resolveSigningSecrets({
        secretCiphertext: encryptSecret(current),
        previousSecretCiphertext: encryptSecret(previous),
        previousSecretExpiresAt: new Date(Date.now() + 3_600_000),
        signatureVersion: 1,
      });
      const payload = JSON.stringify({ event: "dividend.distributed" });
      const header = signPayload(payload, bundle.secrets, bundle.signatureVersion);
      expect(verifySignature(payload, header, current)).toBe(true);
      expect(verifySignature(payload, header, previous)).toBe(true);
    });
  });

  describe("generateWebhookSecret", () => {
    it("produces whsec_ prefixed secrets within allowed length", async () => {
      const { generateWebhookSecret } = await import("@/lib/webhooks/rotation");
      const s = generateWebhookSecret();
      expect(s.startsWith("whsec_")).toBe(true);
      expect(s.length).toBeGreaterThanOrEqual(16);
      expect(s.length).toBeLessThanOrEqual(256);
      expect(generateWebhookSecret()).not.toBe(s);
    });
  });
});
