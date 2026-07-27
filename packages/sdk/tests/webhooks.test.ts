import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TalosWebhook, TalosWebhookError, ReplayStore } from '../src/webhooks.js';

describe('TalosWebhook', () => {
  const secret = 'my-test-secret';
  const payload = JSON.stringify({ id: 'evt_123', type: 'activity.created' });
  const eventId = 'evt_123';
  let timestamp: number;
  let signatureHeader: string;

  beforeEach(async () => {
    timestamp = Math.floor(Date.now() / 1000);
    signatureHeader = await generateSignatureHeader(payload, timestamp, secret);
  });

  async function generateSignatureHeader(payload: string, timestamp: number, secret: string) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const data = encoder.encode(`${timestamp}.${payload}`);
    const signature = await crypto.subtle.sign('HMAC', key, data);
    const hexSignature = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `t=${timestamp},v1=${hexSignature}`;
  }

  it('verifies a valid signature successfully', async () => {
    await expect(
      TalosWebhook.verify({ payload, signatureHeader, secret })
    ).resolves.toBeUndefined();
  });

  it('throws on missing signature header', async () => {
    await expect(
      TalosWebhook.verify({ payload, signatureHeader: '', secret })
    ).rejects.toThrow(TalosWebhookError);
  });

  it('throws on invalid signature format', async () => {
    await expect(
      TalosWebhook.verify({ payload, signatureHeader: 'invalid', secret })
    ).rejects.toThrow(TalosWebhookError);
  });

  it('throws when timestamp is outside tolerance (too old)', async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400s old
    const oldHeader = await generateSignatureHeader(payload, oldTimestamp, secret);
    await expect(
      TalosWebhook.verify({ payload, signatureHeader: oldHeader, secret, toleranceSeconds: 300 })
    ).rejects.toThrow('Timestamp outside tolerance zone (too old)');
  });

  it('throws when timestamp is outside tolerance (too new)', async () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 400; // 400s in future
    const futureHeader = await generateSignatureHeader(payload, futureTimestamp, secret);
    await expect(
      TalosWebhook.verify({ payload, signatureHeader: futureHeader, secret, toleranceSeconds: 300 })
    ).rejects.toThrow('Timestamp outside tolerance zone (too far in future)');
  });

  it('throws when signature is invalid', async () => {
    const badHeader = `t=${timestamp},v1=deadbeefdeadbeef`;
    await expect(
      TalosWebhook.verify({ payload, signatureHeader: badHeader, secret })
    ).rejects.toThrow('No valid signatures found');
  });

  it('supports key rotation (array of secrets)', async () => {
    const newSecret = 'new-secret';
    // Signed with new secret
    const newHeader = await generateSignatureHeader(payload, timestamp, newSecret);
    
    // Pass both old and new secret
    await expect(
      TalosWebhook.verify({ payload, signatureHeader: newHeader, secret: [secret, newSecret] })
    ).resolves.toBeUndefined();
  });

  describe('ReplayStore', () => {
    it('throws if eventId is missing when replayStore is provided', async () => {
      const replayStore = { has: vi.fn(), set: vi.fn() };
      await expect(
        TalosWebhook.verify({ payload, signatureHeader, secret, replayStore })
      ).rejects.toThrow('eventId is required when using replayStore');
    });

    it('throws if event is a replay', async () => {
      const replayStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(true),
        set: vi.fn().mockResolvedValue(undefined),
      };
      await expect(
        TalosWebhook.verify({ payload, signatureHeader, secret, replayStore, eventId })
      ).rejects.toThrow('Event has already been processed (replay detected)');
      expect(replayStore.has).toHaveBeenCalledWith(eventId);
    });

    it('sets the event in the replay store after successful verification', async () => {
      const replayStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };
      await expect(
        TalosWebhook.verify({ payload, signatureHeader, secret, replayStore, eventId, toleranceSeconds: 300 })
      ).resolves.toBeUndefined();
      expect(replayStore.has).toHaveBeenCalledWith(eventId);
      expect(replayStore.set).toHaveBeenCalledWith(eventId, 360); // 300 + 60
    });
  });

  describe('Logger', () => {
    it('logs failures and successes without exposing sensitive data', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      // Success
      await TalosWebhook.verify({ payload, signatureHeader, secret, logger, eventId });
      expect(logger.info).toHaveBeenCalledWith('Webhook verification successful', expect.any(Object));

      // Failure
      const badHeader = `t=${timestamp},v1=deadbeef`;
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: badHeader, secret, logger, eventId })
      ).rejects.toThrow();
      expect(logger.warn).toHaveBeenCalledWith('Webhook verification failed: Signature mismatch', expect.any(Object));
    });
  });
});
