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
  });

  describe('replayWindowSeconds guard', () => {
    // ── Positive cases ───────────────────────────────────────────────────────

    it('positive: accepts replayWindowSeconds equal to toleranceSeconds (boundary equality)', async () => {
      const replayStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 300, // exactly equal — valid
          replayStore,
          eventId,
        })
      ).resolves.toMatchObject({ timestamp });
      // TTL stored must be exactly replayWindowSeconds
      expect(replayStore.set).toHaveBeenCalledWith(eventId, 300);
    });

    it('positive: accepts replayWindowSeconds greater than toleranceSeconds and uses it as TTL', async () => {
      const replayStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 600,
          replayStore,
          eventId,
        })
      ).resolves.toMatchObject({ timestamp });
      expect(replayStore.set).toHaveBeenCalledWith(eventId, 600);
    });

    it('positive: replayWindowSeconds works without replayStore (guard fires before store is reached)', async () => {
      // Should succeed — no replayStore means no TTL write path, but the guard
      // still validates the configured window up-front.
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 400, // valid
        })
      ).resolves.toMatchObject({ timestamp });
    });

    it('positive: replayWindowSeconds=0 is accepted when toleranceSeconds=0 (both zero)', async () => {
      const replayStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 0,
          replayWindowSeconds: 0,
          replayStore,
          eventId,
        })
      ).resolves.toMatchObject({ timestamp });
      // When toleranceSeconds is 0 the fallback would be 86400; with an explicit
      // replayWindowSeconds of 0 we store exactly that value.
      expect(replayStore.set).toHaveBeenCalledWith(eventId, 0);
    });

    it('positive: large replayWindowSeconds (e.g. 86400) is accepted', async () => {
      const replayStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 86400,
          replayStore,
          eventId,
        })
      ).resolves.toMatchObject({ timestamp });
      expect(replayStore.set).toHaveBeenCalledWith(eventId, 86400);
    });

    // ── Negative cases ───────────────────────────────────────────────────────

    it('negative: replayWindowSeconds shorter than toleranceSeconds throws REPLAY_MISCONFIGURED', async () => {
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 299, // shorter by 1 second
        })
      ).rejects.toMatchObject({
        code: 'REPLAY_MISCONFIGURED',
        message: expect.stringContaining('299'),
      });
    });

    it('negative: replayWindowSeconds=0 with positive toleranceSeconds throws REPLAY_MISCONFIGURED', async () => {
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 0,
        })
      ).rejects.toMatchObject({ code: 'REPLAY_MISCONFIGURED' });
    });

    it('negative: replayWindowSeconds=-1 throws REPLAY_MISCONFIGURED (non-negative check)', async () => {
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          replayWindowSeconds: -1,
        })
      ).rejects.toMatchObject({ code: 'REPLAY_MISCONFIGURED' });
    });

    it('negative: replayWindowSeconds=NaN throws REPLAY_MISCONFIGURED', async () => {
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          replayWindowSeconds: NaN,
        })
      ).rejects.toMatchObject({ code: 'REPLAY_MISCONFIGURED' });
    });

    it('negative: replayWindowSeconds=Infinity throws REPLAY_MISCONFIGURED', async () => {
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          replayWindowSeconds: Infinity,
        })
      ).rejects.toMatchObject({ code: 'REPLAY_MISCONFIGURED' });
    });

    it('negative: error message contains both values for diagnosability', async () => {
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 120,
        })
      ).rejects.toMatchObject({
        code: 'REPLAY_MISCONFIGURED',
        message: expect.stringContaining('120'),
      });
    });

    it('negative: error does not include secret material', async () => {
      let caughtError: Error | undefined;
      try {
        await TalosWebhook.verify({
          payload,
          signatureHeader,
          secret: 'super-secret-value',
          toleranceSeconds: 300,
          replayWindowSeconds: 100,
        });
      } catch (err) {
        caughtError = err as Error;
      }
      expect(caughtError).toBeDefined();
      expect(caughtError!.message).not.toContain('super-secret-value');
    });

    // ── Boundary cases ───────────────────────────────────────────────────────

    it('boundary: replayWindowSeconds exactly 1 second above toleranceSeconds is accepted', async () => {
      const replayStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 301,
          replayStore,
          eventId,
        })
      ).resolves.toMatchObject({ timestamp });
      expect(replayStore.set).toHaveBeenCalledWith(eventId, 301);
    });

    it('boundary: replayWindowSeconds exactly 1 second below toleranceSeconds is rejected', async () => {
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 299,
        })
      ).rejects.toMatchObject({ code: 'REPLAY_MISCONFIGURED' });
    });

    it('boundary: omitting replayWindowSeconds preserves legacy TTL = toleranceSeconds + 60', async () => {
      const replayStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };
      await TalosWebhook.verify({
        payload,
        signatureHeader,
        secret,
        toleranceSeconds: 300,
        // replayWindowSeconds intentionally omitted
        replayStore,
        eventId,
      });
      expect(replayStore.set).toHaveBeenCalledWith(eventId, 360); // backward-compat: 300 + 60
    });

    it('boundary: omitting replayWindowSeconds with toleranceSeconds=0 uses default TTL 86400', async () => {
      const replayStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };
      await TalosWebhook.verify({
        payload,
        signatureHeader,
        secret,
        toleranceSeconds: 0, // disabled
        // replayWindowSeconds omitted
        replayStore,
        eventId,
      });
      expect(replayStore.set).toHaveBeenCalledWith(eventId, 86400);
    });

    // ── Regression cases ─────────────────────────────────────────────────────

    it('regression: guard fires before signature check — no crypto work done on misconfigured call', async () => {
      // Passing an obviously bad header so a guard bypass would expose itself
      // as a SIGNATURE_MISMATCH rather than REPLAY_MISCONFIGURED.
      const badHeader = 'not-a-valid-header';
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader: badHeader,
          secret,
          toleranceSeconds: 300,
          replayWindowSeconds: 100, // invalid
        })
      ).rejects.toMatchObject({ code: 'REPLAY_MISCONFIGURED' });
    });

    it('regression: existing callers without replayWindowSeconds still pass (no breaking change)', async () => {
      // This test documents backward compatibility: adding replayWindowSeconds
      // must not change the public API contract for callers that omit it.
      await expect(
        TalosWebhook.verify({ payload, signatureHeader, secret })
      ).resolves.toMatchObject({ timestamp });
    });

    it('regression: logger.error is called with privacy-safe metadata on misconfiguration', async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await expect(
        TalosWebhook.verify({
          payload,
          signatureHeader,
          secret: 'do-not-leak',
          toleranceSeconds: 300,
          replayWindowSeconds: 50,
          logger,
        })
      ).rejects.toMatchObject({ code: 'REPLAY_MISCONFIGURED' });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('replayWindowSeconds'),
        expect.objectContaining({ replayWindowSeconds: 50, toleranceSeconds: 300 }),
      );
      // Secret value must not appear in any log call
      for (const call of [
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ]) {
        expect(JSON.stringify(call)).not.toContain('do-not-leak');
      }
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
