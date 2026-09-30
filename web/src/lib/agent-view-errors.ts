/**
 * Privacy-safe error messaging for agent views.
 * Shared by server pages and client UI — keep free of React / "use client".
 *
 * Localization scaffolding lives in `./error-locales`; this module delegates
 * to that dictionary so English copy has a single source of truth. All
 * `locale` parameters accept unknown input and fail closed to English.
 */

import {
  getErrorStrings,
  resolveLocale,
  type AgentViewEmptyKind as LocaleEmptyKind,
} from "./error-locales";

export type { SupportedLocale } from "./error-locales";
export { resolveLocale, resolveLocaleFromAcceptLanguage } from "./error-locales";

const SECRETISH =
  /\b(secret|seed|mnemonic|private[_\s-]?key|api[_\s-]?key|bearer|authorization|password|passwd|token|payment[_\s-]?proof|signed[_\s-]?xdr|x-api-key)\b/i;

const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
const JWTISH = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const STELLAR_SECRET = /\bS[A-Z2-7]{55}\b/g;

export type AgentViewEmptyKind = LocaleEmptyKind;

/** Strip sensitive material and collapse noisy exception text.
 *
 * Backward compatible: existing `toPrivacySafeAgentError(input)` and
 * `toPrivacySafeAgentError(input, fallback)` calls behave exactly as before
 * (English fallback). New callers may pass an optional `locale` which
 * resolves fail-closed to English and selects the localized fallback when
 * `fallback` is omitted.
 */
export function toPrivacySafeAgentError(
  input: unknown,
  fallback?: string,
  locale?: unknown,
): string {
  const resolved = resolveLocale(locale ?? "en");
  const effectiveFallback = fallback ?? getErrorStrings(resolved).fallback;
  if (input == null) return effectiveFallback;

  let raw: string;
  if (typeof input === "string") {
    raw = input;
  } else if (input instanceof Error) {
    raw = input.message || effectiveFallback;
  } else if (typeof input === "object" && "message" in (input as object)) {
    const msg = (input as { message?: unknown }).message;
    raw = typeof msg === "string" ? msg : effectiveFallback;
  } else {
    return effectiveFallback;
  }

  const trimmed = raw.trim();
  if (!trimmed) return effectiveFallback;

  if (SECRETISH.test(trimmed)) return effectiveFallback;

  let safe = trimmed
    .replace(STELLAR_SECRET, "[redacted]")
    .replace(JWTISH, "[redacted]")
    .replace(LONG_HEX, "[redacted]");

  safe = safe.split("\n")[0]?.trim() ?? effectiveFallback;
  if (safe.length > 180) {
    safe = `${safe.slice(0, 177)}...`;
  }

  if (!safe || safe === "[redacted]") return effectiveFallback;
  return safe;
}

/**
 * Localized empty-state copy. Backward compatible: `emptyCopyFor(kind)`
 * returns English exactly as before. Pass an optional `locale` (unknown
 * input fail-closed to English). Unknown `kind` values fall back to
 * `generic` so callers never receive `undefined`.
 */
export function emptyCopyFor(kind: AgentViewEmptyKind, locale?: unknown) {
  const strings = getErrorStrings(locale ?? "en");
  return strings.empty[kind] ?? strings.empty.generic;
}
