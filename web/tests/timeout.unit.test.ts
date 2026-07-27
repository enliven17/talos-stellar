import { describe, expect, it } from 'vitest';
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
});