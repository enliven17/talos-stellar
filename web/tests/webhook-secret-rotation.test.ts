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

  describe("key identifiers and bounded overlap interval", () => {
    it("derives deterministic, non-reversible whkid_ identifiers", async () => {
      const { deriveSigningKeyId, WEBHOOK_KEY_ID_PREFIX } = await import(
        "@/lib/webhooks/signing"
      );
      const secretA = "whsec_rotation_key_alpha_123456";
      const secretB = "whsec_rotation_key_beta_6543210";

      const idA1 = deriveSigningKeyId(secretA);
      const idA2 = deriveSigningKeyId(secretA);
      const idB = deriveSigningKeyId(secretB);

      expect(idA1).toBe(idA2);
      expect(idA1).not.toBe(idB);
      expect(idA1.startsWith(WEBHOOK_KEY_ID_PREFIX)).toBe(true);
      expect(idA1).toMatch(/^whkid_[a-f0-9]{16}$/);
      expect(idA1).not.toContain("alpha");
    });

    it("enforces bounded overlap interval limits", async () => {
      const { validateOverlapSeconds } = await import("@/lib/webhooks/rotation");
      const {
        DEFAULT_SECRET_ROTATION_GRACE_SECONDS,
        MIN_SECRET_ROTATION_GRACE_SECONDS,
        MAX_SECRET_ROTATION_GRACE_SECONDS,
      } = await import("@/lib/webhooks/config");

      expect(validateOverlapSeconds(undefined)).toEqual({
        ok: true,
        seconds: DEFAULT_SECRET_ROTATION_GRACE_SECONDS,
      });
      expect(validateOverlapSeconds(MIN_SECRET_ROTATION_GRACE_SECONDS)).toEqual({
        ok: true,
        seconds: MIN_SECRET_ROTATION_GRACE_SECONDS,
      });
      expect(validateOverlapSeconds(MAX_SECRET_ROTATION_GRACE_SECONDS)).toEqual({
        ok: true,
        seconds: MAX_SECRET_ROTATION_GRACE_SECONDS,
      });

      for (const invalid of [
        0,
        -60,
        MIN_SECRET_ROTATION_GRACE_SECONDS - 1,
        MAX_SECRET_ROTATION_GRACE_SECONDS + 1,
        300.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        const res = validateOverlapSeconds(invalid);
        expect(res.ok).toBe(false);
      }
    });

    it("verifies in-flight and overlapping deliveries across a controlled rotation", async () => {
      const {
        deriveSigningKeyId,
        encryptSecret,
        signPayloadWithKeyIds,
        verifySignatureWithDetails,
      } = await import("@/lib/webhooks/signing");
      const { resolveSigningSecrets } = await import("@/lib/webhooks/rotation");

      const oldSecret = "whsec_inflight_old_key_11111111";
      const newSecret = "whsec_inflight_new_key_22222222";
      const oldKid = deriveSigningKeyId(oldSecret);
      const newKid = deriveSigningKeyId(newSecret);
      const payload = JSON.stringify({ event: "approval.approved", id: "evt_rot_1" });

      const t0 = new Date("2026-11-19T12:00:00.000Z");
      const overlapExpires = new Date(t0.getTime() + 600_000); // 10 min overlap
      const nowSec = Math.floor(t0.getTime() / 1000);

      // 1. In-flight delivery signed before rotation (old key only)
      const preRotationSigned = signPayloadWithKeyIds(
        payload,
        [{ id: oldKid, secret: oldSecret }],
        1,
        nowSec,
      );
      expect(preRotationSigned.keyIds).toEqual([oldKid]);
      expect(preRotationSigned.keyIdHeader).toBe(oldKid);

      // Consumer holding both keys during rollout verifies the in-flight delivery
      const inflightCheck = verifySignatureWithDetails(
        payload,
        preRotationSigned.signature,
        { [oldKid]: oldSecret, [newKid]: newSecret },
        { keyIdHeader: preRotationSigned.keyIdHeader, nowSec },
      );
      expect(inflightCheck).toMatchObject({
        valid: true,
        matchedKeyId: oldKid,
        version: 1,
      });

      // 2. Delivery during active overlap window (dual-signed with new + old)
      const duringOverlapBundle = resolveSigningSecrets(
        {
          secretCiphertext: encryptSecret(newSecret),
          previousSecretCiphertext: encryptSecret(oldSecret),
          previousSecretExpiresAt: overlapExpires,
          signatureVersion: 1,
        },
        new Date(t0.getTime() + 300_000),
      );
      expect(duringOverlapBundle.rotationActive).toBe(true);
      expect(duringOverlapBundle.activeKeyId).toBe(newKid);
      expect(duringOverlapBundle.previousKeyId).toBe(oldKid);
      expect(duringOverlapBundle.keys.map((k) => k.id)).toEqual([newKid, oldKid]);

      const overlapSigned = signPayloadWithKeyIds(
        payload,
        duringOverlapBundle.keys,
        duringOverlapBundle.signatureVersion,
        nowSec,
      );
      expect(overlapSigned.keyIdHeader).toBe(`${newKid},${oldKid}`);

      // Consumer still on old key only succeeds
      const oldOnlyCheck = verifySignatureWithDetails(
        payload,
        overlapSigned.signature,
        { [oldKid]: oldSecret },
        { keyIdHeader: overlapSigned.keyIdHeader, nowSec },
      );
      expect(oldOnlyCheck).toMatchObject({ valid: true, matchedKeyId: oldKid });

      // Consumer already on new key only succeeds
      const newOnlyCheck = verifySignatureWithDetails(
        payload,
        overlapSigned.signature,
        { [newKid]: newSecret },
        { keyIdHeader: overlapSigned.keyIdHeader, nowSec },
      );
      expect(newOnlyCheck).toMatchObject({ valid: true, matchedKeyId: newKid });

      // 3. Exact expiry boundary (now === overlapExpires): previous key is omitted
      const atExpiryBundle = resolveSigningSecrets(
        {
          secretCiphertext: encryptSecret(newSecret),
          previousSecretCiphertext: encryptSecret(oldSecret),
          previousSecretExpiresAt: overlapExpires,
          signatureVersion: 1,
        },
        overlapExpires,
      );
      expect(atExpiryBundle.rotationActive).toBe(false);
      expect(atExpiryBundle.activeKeyId).toBe(newKid);
      expect(atExpiryBundle.previousKeyId).toBeNull();
      expect(atExpiryBundle.keys.map((k) => k.id)).toEqual([newKid]);

      const postOverlapSigned = signPayloadWithKeyIds(
        payload,
        atExpiryBundle.keys,
        atExpiryBundle.signatureVersion,
        nowSec,
      );
      expect(postOverlapSigned.keyIdHeader).toBe(newKid);

      // Consumer still on old key only now fails with key_id_mismatch
      const expiredOldCheck = verifySignatureWithDetails(
        payload,
        postOverlapSigned.signature,
        { [oldKid]: oldSecret },
        { keyIdHeader: postOverlapSigned.keyIdHeader, nowSec },
      );
      expect(expiredOldCheck).toMatchObject({
        valid: false,
        reason: "key_id_mismatch",
      });
    });

    it("rejects tampered payloads and unknown key IDs", async () => {
      const {
        deriveSigningKeyId,
        signPayloadWithKeyIds,
        verifySignatureWithDetails,
      } = await import("@/lib/webhooks/signing");

      const secret = "whsec_tamper_check_secret_12345";
      const kid = deriveSigningKeyId(secret);
      const payload = JSON.stringify({ event: "revenue.recorded", amount: 100 });
      const nowSec = 1_763_550_000;

      const signed = signPayloadWithKeyIds(payload, [{ id: kid, secret }], 1, nowSec);

      const tampered = verifySignatureWithDetails(
        JSON.stringify({ event: "revenue.recorded", amount: 999 }),
        signed.signature,
        { [kid]: secret },
        { keyIdHeader: signed.keyIdHeader, nowSec },
      );
      expect(tampered).toMatchObject({ valid: false, reason: "invalid_signature" });

      const unknownKid = verifySignatureWithDetails(
        payload,
        signed.signature,
        { [kid]: secret },
        { keyIdHeader: "whkid_0000000000000000", nowSec },
      );
      expect(unknownKid).toMatchObject({ valid: false, reason: "key_id_mismatch" });
    });
  });
});
