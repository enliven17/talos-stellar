/**
 * Test locale message catalogue to prove string swappability.
 *
 * Prepends "[TEST] " to messages to ensure swappable strings are visually
 * and programmatically distinct from English originals while retaining
 * interpolation placeholders (e.g. {count}, {name}).
 *
 * @module i18n/messages/test
 */

import { en } from "./en";

function prefixValues(obj: unknown): unknown {
  if (typeof obj === "string") {
    return `[TEST] ${obj}`;
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      res[k] = prefixValues(v);
    }
    return res;
  }
  return obj;
}

export const testMessages = prefixValues(en) as typeof en;
