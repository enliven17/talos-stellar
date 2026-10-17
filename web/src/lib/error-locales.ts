/**
 * Localization scaffolding for user-facing errors.
 *
 * Single source of truth for the English copy used by agent views and error
 * boundaries. Additional locales can be added by extending `SUPPORTED_LOCALES`
 * and `ERROR_STRINGS` — no call-site changes required.
 *
 * Design guarantees (fail closed):
 *   - `resolveLocale()` / `resolveLocaleFromAcceptLanguage()` never throw and
 *     never log their input (the input may be attacker-controlled). Missing,
 *     malformed, overlong, or unsupported values resolve to `DEFAULT_LOCALE`.
 *   - Pure functions only: no I/O, no network, safe to retry.
 *   - No secrets are ever interpolated into localized strings; sensitive
 *     material is still stripped by `toPrivacySafeAgentError()`.
 *
 * @module error-locales
 */

export const SUPPORTED_LOCALES = ["en"] as const;

/** Locales with a dictionary in {@link ERROR_STRINGS}. Extend to add more. */
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Fallback locale used for every ambiguous input. */
export const DEFAULT_LOCALE: SupportedLocale = "en";

/** Upper bound for raw locale input; longer values fail closed to default. */
export const MAX_LOCALE_INPUT_LENGTH = 32;

/** Maximum `Accept-Language` tags inspected before failing closed. */
export const MAX_ACCEPT_LANGUAGE_TAGS = 8;

export type AgentViewEmptyKind =
  | "catalog"
  | "filtered"
  | "service"
  | "activity"
  | "patrons"
  | "revenue"
  | "proposals"
  | "generic";

export interface EmptyCopy {
  title: string;
  description: string;
}

export interface ErrorBoundaryCopy {
  title: string;
  description: string;
  criticalDescription: string;
  retryLabel: string;
  homeLabel: string;
}

export interface ErrorLocaleStrings {
  /** Generic privacy-safe fallback for agent views. */
  fallback: string;
  /** Fallback used by the agent directory error boundary. */
  directoryFallback: string;
  /** Fallback used by the agent detail error boundary. */
  detailFallback: string;
  /** Heading rendered above the safe message. */
  errorTitle: string;
  /** Retry button label. */
  retryLabel: string;
  empty: Record<AgentViewEmptyKind, EmptyCopy>;
  boundary: ErrorBoundaryCopy;
}

/**
 * Localized dictionaries. `en` is the canonical copy — keep
 * `agent-view-errors.ts` delegating here so there is no parallel source of
 * truth.
 */
export const ERROR_STRINGS: Record<SupportedLocale, ErrorLocaleStrings> = {
  en: {
    fallback: "Something went wrong loading agent data. Please try again.",
    directoryFallback: "Something went wrong loading the agent directory.",
    detailFallback: "Something went wrong loading this agent.",
    errorTitle: "Unable to load agent view",
    retryLabel: "Try again",
    empty: {
      catalog: {
        title: "No agents yet",
        description:
          "The agent directory is empty. Check back after agents have been registered.",
      },
      filtered: {
        title: "No agents match your query",
        description:
          "Try a different search term, category, or online/offline filter.",
      },
      service: {
        title: "No commerce service",
        description: "This agent does not offer a commerce service yet.",
      },
      activity: {
        title: "No activity yet",
        description: "No activity has been recorded for this agent yet.",
      },
      patrons: {
        title: "No patrons yet",
        description: "Be the first patron to support this agent.",
      },
      revenue: {
        title: "No revenue data yet",
        description: "Revenue history will appear once jobs complete.",
      },
      proposals: {
        title: "No proposals yet",
        description: "Governance proposals will show up here when submitted.",
      },
      generic: {
        title: "Nothing here yet",
        description: "There is no data to display for this view.",
      },
    },
    boundary: {
      title: "Something went wrong",
      description:
        "A transient error occurred. Our team has been notified — please try again or return home.",
      criticalDescription:
        "A critical error occurred while loading the application. Please try again or return home.",
      retryLabel: "Try again",
      homeLabel: "Go home",
    },
  },
};

/** Type guard for supported locale tags. */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Normalize a raw locale tag to its primary subtag (`en-US` → `en`).
 * Returns `null` when the input cannot be normalized safely.
 */
function normalizeLocaleTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LOCALE_INPUT_LENGTH) return null;
  // Primary subtag only; region/variant subtags are ignored by scaffolding.
  const primary = trimmed.split(/[-_]/)[0]?.trim().toLowerCase() ?? "";
  if (!primary || !/^[a-z]{2,3}$/.test(primary)) return null;
  return primary;
}

/**
 * Resolve an unknown locale input to a supported locale.
 * Fail-closed: missing, malformed, overlong, or unsupported values return
 * {@link DEFAULT_LOCALE}. Never throws, never logs its input.
 */
export function resolveLocale(input: unknown): SupportedLocale {
  if (typeof input !== "string") return DEFAULT_LOCALE;
  const normalized = normalizeLocaleTag(input);
  if (normalized && isSupportedLocale(normalized)) return normalized;
  return DEFAULT_LOCALE;
}

/**
 * Resolve the best supported locale from an `Accept-Language` header value.
 * Parses `tag(;q=…)?(, …)*`, honors client priority order, and returns the
 * first supported tag. Fail-closed to {@link DEFAULT_LOCALE} when the header
 * is missing, malformed, or lists no supported locale. Bounded to
 * {@link MAX_ACCEPT_LANGUAGE_TAGS} tags; never throws, never logs input.
 */
export function resolveLocaleFromAcceptLanguage(
  header: unknown,
): SupportedLocale {
  if (typeof header !== "string") return DEFAULT_LOCALE;
  const trimmed = header.trim();
  if (!trimmed || trimmed.length > 1024) return DEFAULT_LOCALE;
  const tags = trimmed.split(",").slice(0, MAX_ACCEPT_LANGUAGE_TAGS);
  for (const tag of tags) {
    const lang = tag.split(";")[0]?.trim() ?? "";
    if (!lang) continue;
    const normalized = normalizeLocaleTag(lang);
    if (normalized && isSupportedLocale(normalized)) return normalized;
  }
  return DEFAULT_LOCALE;
}

/**
 * Fetch the dictionary for a locale input, fail-closed to English.
 * Accepts unknown input so callers can forward headers/query params directly.
 */
export function getErrorStrings(locale?: unknown): ErrorLocaleStrings {
  return ERROR_STRINGS[resolveLocale(locale ?? DEFAULT_LOCALE)];
}

/**
 * Localized copy for app error boundaries (`app/error.tsx`,
 * `app/global-error.tsx`). Fail-closed to English.
 */
export function getErrorBoundaryCopy(locale?: unknown): ErrorBoundaryCopy {
  return getErrorStrings(locale).boundary;
}
