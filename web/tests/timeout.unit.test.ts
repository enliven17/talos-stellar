import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout } from '../src/lib/timeout';

describe('withTimeout utility', () => {
  it('resolves when promise is fulfilled before timeout', async () => {
    const result = await withTimeout(Promise.resolve('success'), 1000);
    expect(result).toBe('success');
  });

  it('rejects with TimeoutError when promise times out', async () => {
    const timeoutPromise = withTimeout(
      new Promise((resolve) => setTimeout(() => resolve('should not resolve'), 500)),
      100,
      'Test timeout'
    );

    await expect(timeoutPromise).rejects.toThrow(TimeoutError);
  });

  it('rejects with TimeoutError and custom message', async () => {
    const timeoutPromise = withTimeout(
      new Promise(() => {}),
      10,
      'Custom timeout message'
    );

    await expect(timeoutPromise).rejects.toThrow('Custom timeout message');
  });

  describe('timer cleanup (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('clears pending timer when promise resolves before timeout (success path)', async () => {
      expect(vi.getTimerCount()).toBe(0);
      const result = await withTimeout(Promise.resolve('success'), 1000);
      expect(result).toBe('success');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears pending timer when delayed promise resolves before timeout', async () => {
      expect(vi.getTimerCount()).toBe(0);
      const delayedPromise = new Promise<string>((resolve) => {
        setTimeout(() => resolve('delayed-success'), 50);
      });
      const promise = withTimeout(delayedPromise, 500);
      expect(vi.getTimerCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(50);
      const result = await promise;
      expect(result).toBe('delayed-success');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears pending timer when promise rejects before timeout (failure path)', async () => {
      expect(vi.getTimerCount()).toBe(0);
      const failingPromise = Promise.reject(new Error('upstream failure'));
      await expect(withTimeout(failingPromise, 1000)).rejects.toThrow('upstream failure');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears pending timer when delayed promise rejects before timeout', async () => {
      expect(vi.getTimerCount()).toBe(0);
      const delayedRejection = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('delayed failure')), 50);
      });
      const promise = withTimeout(delayedRejection, 500);
      expect(vi.getTimerCount()).toBe(2);

      const assertion = expect(promise).rejects.toThrow('delayed failure');
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears timer and rejects with TimeoutError when operation times out (timeout path)', async () => {
      expect(vi.getTimerCount()).toBe(0);
      const hangingPromise = new Promise<never>(() => {});
      const timedOutPromise = withTimeout(hangingPromise, 100, 'Custom timeout');

      expect(vi.getTimerCount()).toBe(1);

      const assertion = expect(timedOutPromise).rejects.toThrow(TimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
