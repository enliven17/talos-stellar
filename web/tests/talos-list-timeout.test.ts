import { describe, expect, it } from "vitest";
import { db } from '@/db';
import { TimeoutError, withTimeout } from '@/lib/timeout';

describe('Talos list endpoint timeout', () => {
  it('resolves when promise is fulfilled before timeout', async () => {
    const result = await withTimeout(
      db.select({ id: db.ddl.id }).from(db.ddl),
      5000
    );
    expect(result).toBeDefined();
  });

  it('rejects with TimeoutError when promise times out', async () => {
    const timeoutPromise = withTimeout(
      new Promise((resolve) => setTimeout(() => resolve('should not resolve'), 500)),
      100
    );

    await expect(timeoutPromise).rejects.toThrowError(TimeoutError);
  });
});