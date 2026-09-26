import crypto from 'crypto';

export function generateETag(content: string): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return `"${hash}"`;
}

export function isETagMatch(etag: string | null, content: string): boolean {
  if (!etag) return false;
  const generated = generateETag(content);
  // Handle weak/strong comparison as per RFC 7232
  return etag === generated || etag === `W/${generated}`;
}