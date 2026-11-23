// vitest unit tests for validateUrl user‑info rejection
import { expect, test } from 'vitest';
import { validateUrl } from '@/lib/security/ssrf';

test('accepts normal https URL', async () => {
  const url = await validateUrl('https://example.com/path');
  expect(url.hostname).toBe('example.com');
});

test('rejects URL with username and password', async () => {
  await expect(validateUrl('https://user:pass@example.com')).rejects.toThrow('User info not allowed');
});

test('rejects URL with only username', async () => {
  await expect(validateUrl('https://user@example.com')).rejects.toThrow('User info not allowed');
});

test('rejects URL with only password', async () => {
  await expect(validateUrl('https://:pass@example.com')).rejects.toThrow('User info not allowed');
});
