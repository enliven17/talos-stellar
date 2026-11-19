/**
 * Core internationalisation configuration and locale resolution.
 *
 * Guarantees (fail closed):
 * - Ambiguous, malformed, unsupported, or overlong input resolves to DEFAULT_LOCALE ("en").
 * - Pure functions: no thrown errors, no secrets leaked.
 *
 * @module i18n/config
 */

export const SUPPORTED_LOCALES = ["en", "test"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";

export const LOCALE_COOKIE_NAME = "talos_locale";

/** Upper bound for raw locale input length to prevent denial-of-service / memory abuse. */
export const MAX_LOCALE_INPUT_LENGTH = 32;

/** Maximum Accept-Language tags inspected before failing closed. */
export const MAX_ACCEPT_LANGUAGE_TAGS = 8;

/** Type guard for supported locale tags. */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Normalise a raw locale string (e.g. "en-US", "TEST", " en ").
 * Returns null if the value cannot be safely normalised.
 */
export function normalizeLocaleTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LOCALE_INPUT_LENGTH) return null;
  const primary = trimmed.split(/[-_]/)[0]?.trim().toLowerCase() ?? "";
  if (!primary || !/^[a-z]{2,8}$/.test(primary)) return null;
  return primary;
}

/**
 * Resolves an unknown locale input (cookie value, query parameter, client state)
 * to a SupportedLocale. Fails closed to DEFAULT_LOCALE ("en").
 */
export function resolveLocale(input: unknown): SupportedLocale {
  if (typeof input !== "string") return DEFAULT_LOCALE;
  const normalized = normalizeLocaleTag(input);
  if (normalized && isSupportedLocale(normalized)) {
    return normalized;
  }
  return DEFAULT_LOCALE;
}

/**
 * Parse a raw Cookie header string and extract the locale cookie.
 */
export function resolveLocaleFromCookie(cookieHeader: unknown): SupportedLocale {
  if (typeof cookieHeader !== "string") return DEFAULT_LOCALE;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [name, ...valParts] = part.trim().split("=");
    if (name === LOCALE_COOKIE_NAME) {
      const val = decodeURIComponent(valParts.join("="));
      return resolveLocale(val);
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * Resolve the best supported locale from an Accept-Language header value.
 * Parses language tags and quality weights (q=), sorting by preference.
 */
export function resolveLocaleFromAcceptLanguage(header: unknown): SupportedLocale {
  if (typeof header !== "string") return DEFAULT_LOCALE;
  const trimmed = header.trim();
  if (!trimmed || trimmed.length > 1024) return DEFAULT_LOCALE;

  const entries: { locale: SupportedLocale; quality: number; order: number }[] = [];
  const tags = trimmed.split(",").slice(0, MAX_ACCEPT_LANGUAGE_TAGS);

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!;
    const parts = tag.split(";");
    const lang = parts[0]?.trim() ?? "";
    if (!lang) continue;

    let quality = 1.0;
    for (let p = 1; p < parts.length; p++) {
      const param = parts[p]!.trim();
      if (param.startsWith("q=")) {
        const parsedQ = parseFloat(param.slice(2));
        if (!isNaN(parsedQ)) quality = parsedQ;
      }
    }

    const normalized = normalizeLocaleTag(lang);
    if (normalized && isSupportedLocale(normalized)) {
      entries.push({ locale: normalized, quality, order: i });
    }
  }

  if (entries.length === 0) return DEFAULT_LOCALE;

  // Higher quality first; preserve original header order on tie
  entries.sort((a, b) => b.quality - a.quality || a.order - b.order);
  return entries[0]!.locale;
}

