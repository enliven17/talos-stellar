import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TalosWebhook,
  TalosWebhookError,
  ReplayStore,
  verifyWebhook,
  parseWebhookEvent,
} from '../src/webhooks.js';

describe('TalosWebhook', () => {
  const secret = 'my-test-secret';
  const payload = JSON.stringify({ id: 'evt_123', type: 'activity.created', talosId: 'tal_1', data: { channel: 'x' } });
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

  async function generatePlatformSignatureHeader(payload: string, timestamp: number, secret: string, version = 1) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const data = encoder.encode(`${version}.${timestamp}.${payload}`);
    const signature = await crypto.subtle.sign('HMAC', key, data);
    const hexSignature = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `v${version}=${hexSignature},t=${timestamp}`;
  }

  it('verifies a valid signature successfully', async () => {
    await expect(
      TalosWebhook.verify({ payload, signatureHeader, secret })
    ).resolves.toMatchObject({ timestamp });
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

  describe('strict timestamp validation (#923)', () => {
    async function headerWithTimestamp(ts: string, sig: string) {
      return `t=${ts},v1=${sig}`;
    }

    // Helper to get a valid v1 sig hex so the test isolates timestamp parsing.
    async function validSigHex(ts: number): Promise<string> {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const data = encoder.encode(`${ts}.${payload}`);
      const sig = await crypto.subtle.sign('HMAC', key, data);
      return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    it('rejects scientific notation (1e10) with MALFORMED_TIMESTAMP', async () => {
      const header = await headerWithTimestamp('1e10', 'deadbeef');
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: header, secret })
      ).rejects.toMatchObject({ code: 'MALFORMED_TIMESTAMP' });
    });

    it('rejects decimal timestamps (12.5) with MALFORMED_TIMESTAMP', async () => {
      const header = await headerWithTimestamp('12.5', 'deadbeef');
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: header, secret })
      ).rejects.toMatchObject({ code: 'MALFORMED_TIMESTAMP' });
    });

    it('rejects 14+ digit timestamps with MALFORMED_TIMESTAMP', async () => {
      // 14 digits — exceeds the 13-digit cap (> year 2286 in Unix seconds).
      const header = await headerWithTimestamp('99999999999999', 'deadbeef');
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: header, secret })
      ).rejects.toMatchObject({ code: 'MALFORMED_TIMESTAMP' });
    });

    it('rejects timestamps with leading sign (+123) with MALFORMED_TIMESTAMP', async () => {
      const header = await headerWithTimestamp('+1620000000', 'deadbeef');
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: header, secret })
      ).rejects.toMatchObject({ code: 'MALFORMED_TIMESTAMP' });
    });

    it('rejects negative timestamps (-123) with MALFORMED_TIMESTAMP', async () => {
      const header = await headerWithTimestamp('-1620000000', 'deadbeef');
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: header, secret })
      ).rejects.toMatchObject({ code: 'MALFORMED_TIMESTAMP' });
    });

    it('rejects empty timestamp value with MALFORMED_TIMESTAMP', async () => {
      // Force the header format so the "t" key is present but value is blank.
      // parseSignatureHeader skips parts where value is empty, which means
      // timestamp stays -1, resulting in INVALID_HEADER — both codes indicate
      // a malformed header, and INVALID_HEADER is the correct fallback here.
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: 't=,v1=deadbeef', secret })
      ).rejects.toBeInstanceOf(TalosWebhookError);
    });

    it('accepts a valid 10-digit Unix timestamp integer', async () => {
      const ts = Math.floor(Date.now() / 1000);
      const hex = await validSigHex(ts);
      const header = `t=${ts},v1=${hex}`;
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: header, secret })
      ).resolves.toMatchObject({ timestamp: ts });
    });

    it('TalosWebhookError for malformed timestamp has name TalosWebhookError', async () => {
      const header = await headerWithTimestamp('1e10', 'deadbeef');
      const err = await TalosWebhook.verify({ payload, signatureHeader: header, secret })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TalosWebhookError);
      expect((err as TalosWebhookError).name).toBe('TalosWebhookError');
      expect((err as TalosWebhookError).code).toBe('MALFORMED_TIMESTAMP');
    });
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
    const newHeader = await generateSignatureHeader(payload, timestamp, newSecret);

    await expect(
      TalosWebhook.verify({ payload, signatureHeader: newHeader, secret: [secret, newSecret] })
    ).resolves.toMatchObject({ timestamp });
  });

  it('verifies platform X-Webhook-Signature scheme (v.t.payload)', async () => {
    const platformHeader = await generatePlatformSignatureHeader(payload, timestamp, secret);
    await expect(
      TalosWebhook.verify({ payload, signatureHeader: platformHeader, secret })
    ).resolves.toMatchObject({ timestamp });
  });

  describe('typed verifyWebhook helper', () => {
    it('returns a typed event after successful verification', async () => {
      const event = await verifyWebhook<{ channel: string }>({
        payload,
        signatureHeader,
        secret,
      });
      expect(event.id).toBe('evt_123');
      expect(event.type).toBe('activity.created');
      expect(event.talosId).toBe('tal_1');
      expect(event.data).toEqual({ channel: 'x' });
      expect(event.timestamp).toBe(timestamp);
    });

    it('constructEvent mirrors verifyWebhook', async () => {
      const event = await TalosWebhook.constructEvent({
        payload,
        signatureHeader,
        secret,
      });
      expect(event.type).toBe('activity.created');
      expect(event.id).toBe('evt_123');
    });

    it('rejects malformed JSON without leaking the body', async () => {
      const badPayload = '{not-json';
      const header = await generateSignatureHeader(badPayload, timestamp, secret);
      await expect(
        verifyWebhook({ payload: badPayload, signatureHeader: header, secret })
      ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    });

    it('parseWebhookEvent handles top-level eventType shape', () => {
      const parsed = parseWebhookEvent(
        { eventType: 'revenue.recorded', amount: '10', id: 'evt_9' },
        123,
      );
      expect(parsed.type).toBe('revenue.recorded');
      expect(parsed.id).toBe('evt_9');
      expect(parsed.timestamp).toBe(123);
      expect(parsed.data).toMatchObject({ amount: '10' });
    });
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
      ).resolves.toMatchObject({ timestamp });
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

      await TalosWebhook.verify({ payload, signatureHeader, secret, logger, eventId });
      expect(logger.info).toHaveBeenCalledWith('Webhook verification successful', expect.any(Object));

      const badHeader = `t=${timestamp},v1=deadbeef`;
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: badHeader, secret, logger, eventId })
      ).rejects.toThrow();
      expect(logger.warn).toHaveBeenCalledWith('Webhook verification failed: Signature mismatch', expect.any(Object));
    });
  });
});
