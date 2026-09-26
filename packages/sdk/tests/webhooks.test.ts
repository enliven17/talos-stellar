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

    describe('replayWindowSeconds', () => {
      it('uses replayWindowSeconds as TTL when provided', async () => {
        const replayStore: ReplayStore = {
          has: vi.fn().mockResolvedValue(false),
          set: vi.fn().mockResolvedValue(undefined),
        };
        await TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          replayStore,
          eventId,
          toleranceSeconds: 300,
          replayWindowSeconds: 600,
        });
        expect(replayStore.set).toHaveBeenCalledWith(eventId, 600);
      });

      it('falls back to toleranceSeconds+60 when replayWindowSeconds is absent', async () => {
        const replayStore: ReplayStore = {
          has: vi.fn().mockResolvedValue(false),
          set: vi.fn().mockResolvedValue(undefined),
        };
        await TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          replayStore,
          eventId,
          toleranceSeconds: 300,
          // no replayWindowSeconds
        });
        expect(replayStore.set).toHaveBeenCalledWith(eventId, 360); // 300 + 60
      });

      it('falls back to 86400 when toleranceSeconds is 0 and replayWindowSeconds is absent', async () => {
        // Need a fresh signature with toleranceSeconds: 0 (no tolerance check)
        const ts = Math.floor(Date.now() / 1000);
        const header = await (async () => {
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            'raw', encoder.encode(secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
          );
          const data = encoder.encode(`${ts}.${payload}`);
          const sig = await crypto.subtle.sign('HMAC', key, data);
          const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
          return `t=${ts},v1=${hex}`;
        })();

        const replayStore: ReplayStore = {
          has: vi.fn().mockResolvedValue(false),
          set: vi.fn().mockResolvedValue(undefined),
        };
        await TalosWebhook.verify({
          payload,
          signatureHeader: header,
          secret,
          replayStore,
          eventId,
          toleranceSeconds: 0,
          // no replayWindowSeconds
        });
        expect(replayStore.set).toHaveBeenCalledWith(eventId, 86400);
      });

      it('throws REPLAY_MISCONFIGURED for non-positive replayWindowSeconds', async () => {
        const replayStore: ReplayStore = {
          has: vi.fn().mockResolvedValue(false),
          set: vi.fn().mockResolvedValue(undefined),
        };
        const err = await TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          replayStore,
          eventId,
          replayWindowSeconds: 0,
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(TalosWebhookError);
        expect((err as TalosWebhookError).code).toBe('REPLAY_MISCONFIGURED');
        expect((err as TalosWebhookError).message).toMatch(/must be a positive integer/);
      });

      it('throws REPLAY_MISCONFIGURED for negative replayWindowSeconds', async () => {
        const replayStore: ReplayStore = {
          has: vi.fn().mockResolvedValue(false),
          set: vi.fn().mockResolvedValue(undefined),
        };
        await expect(
          TalosWebhook.verify({
            payload,
            signatureHeader,
            secret,
            replayStore,
            eventId,
            replayWindowSeconds: -60,
          }),
        ).rejects.toMatchObject({ code: 'REPLAY_MISCONFIGURED' });
      });
    });
  });

  describe('hexToBuf strictness (ambiguous encoding rejection)', () => {
    it('decodes a well-formed hex string', () => {
      expect(TalosWebhook.hexToBuf('deadbeef')).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      );
    });

    it('accepts uppercase and mixed-case hex as equivalent to lowercase', () => {
      expect(TalosWebhook.hexToBuf('DEADBEEF')).toEqual(TalosWebhook.hexToBuf('deadbeef'));
      expect(TalosWebhook.hexToBuf('DeAdBeEf')).toEqual(TalosWebhook.hexToBuf('deadbeef'));
    });

    it('rejects an empty string', () => {
      expect(TalosWebhook.hexToBuf('')).toBeNull();
    });

    it('rejects odd-length input', () => {
      expect(TalosWebhook.hexToBuf('abc')).toBeNull();
    });

    it('rejects non-hex characters instead of partially parsing them', () => {
      // Previously parseInt('1g', 16) === 1, so this silently decoded to a
      // single 0x01 byte instead of being rejected as malformed.
      expect(TalosWebhook.hexToBuf('1g')).toBeNull();
      expect(TalosWebhook.hexToBuf('zz')).toBeNull();
    });

    it('rejects embedded whitespace instead of coercing it away', () => {
      // parseInt(' 1', 16) === 1 and parseInt('1 ', 16) === 1, which used to
      // let whitespace-padded values decode ambiguously to the same byte as
      // their trimmed form.
      expect(TalosWebhook.hexToBuf(' 1')).toBeNull();
      expect(TalosWebhook.hexToBuf('1 ')).toBeNull();
      expect(TalosWebhook.hexToBuf('de ad be ef')).toBeNull();
    });

    it('rejects a leading 0x prefix instead of interpreting it as radix notation', () => {
      // parseInt('0x', 16) is NaN, but a longer string like '0x1a' would be
      // silently reinterpreted by parseInt's own prefix handling.
      expect(TalosWebhook.hexToBuf('0x1a')).toBeNull();
      expect(TalosWebhook.hexToBuf('0X1a')).toBeNull();
    });

    it('rejects a signed (+/-) value instead of coercing off the sign', () => {
      expect(TalosWebhook.hexToBuf('+1234')).toBeNull();
      expect(TalosWebhook.hexToBuf('-1234')).toBeNull();
    });

    it('rejects malformed v1 signatures end-to-end instead of misverifying them', async () => {
      const badHeader = `t=${timestamp},v1=1g${'a'.repeat(62)}`;
      await expect(
        TalosWebhook.verify({ payload, signatureHeader: badHeader, secret }),
      ).rejects.toThrow('No valid signatures found');
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
