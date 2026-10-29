/**
 * Translation helper and message resolution with fail-safe fallback.
 *
 * Design guarantees:
 * - Pure resolution: never throws, even on invalid keys or malformed parameters.
 * - Missing keys fall back to English dictionary and report warnings in dev.
 * - Keys missing in both locales fall back to the key name itself.
 * - String interpolation supports {variable} syntax safely.
 *
 * @module i18n/translator
 */

import { DEFAULT_LOCALE, type SupportedLocale } from "./config";
import { en } from "./messages/en";
import { testMessages } from "./messages/test";

export type MessageCatalogue = Record<string, string>;

export function flattenMessages(
  obj: Record<string, unknown>,
  prefix = "",
): MessageCatalogue {
  const result: MessageCatalogue = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[fullKey] = String(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenMessages(value as Record<string, unknown>, fullKey),
      );
    }
  }
  return result;
}

export const FLATTENED_EN = flattenMessages(en);
export const FLATTENED_TEST = flattenMessages(testMessages);

export const MESSAGES: Record<SupportedLocale, MessageCatalogue> = {
  en: FLATTENED_EN,
  test: FLATTENED_TEST,
};

export type KnownMessageKey = keyof typeof FLATTENED_EN;
export type MessageKey = KnownMessageKey | (string & {});

export interface TranslatorOptions {
  reportMissing?: boolean;
  onMissingKey?: (key: string, locale: string, fallbackLocale: string) => void;
  messages?: Record<SupportedLocale, MessageCatalogue> | MessageCatalogue;
}

export type TranslateFn = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string;

/**
 * Replace placeholders like `{count}` or `{name}` with provided values.
 */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, paramKey) => {
    if (paramKey in params) {
      const val = params[paramKey];
      return val !== undefined && val !== null ? String(val) : "";
    }
    return match;
  });
}

/**
 * Creates a translator function `t(key, params)` for the given locale.
 * Accepts either an options configuration object or a custom message catalogue directly.
 */
export function createTranslator(
  locale: SupportedLocale,
  optionsOrCatalogue: TranslatorOptions | MessageCatalogue = {},
): TranslateFn {
  const isDev =
    typeof process !== "undefined" &&
    process.env &&
    process.env.NODE_ENV !== "production";

  const isOptions =
    "reportMissing" in optionsOrCatalogue ||
    "onMissingKey" in optionsOrCatalogue ||
    "messages" in optionsOrCatalogue;

  const options: TranslatorOptions = isOptions
    ? (optionsOrCatalogue as TranslatorOptions)
    : {};

  const customCatalogue = !isOptions && Object.keys(optionsOrCatalogue).length > 0
    ? (optionsOrCatalogue as MessageCatalogue)
    : undefined;

  const shouldReport = options.reportMissing ?? isDev;

  let targetDict: MessageCatalogue;
  let defaultDict: MessageCatalogue = FLATTENED_EN;

  if (customCatalogue) {
    targetDict = customCatalogue;
  } else if (options.messages) {
    if (locale in options.messages) {
      targetDict = (options.messages as Record<SupportedLocale, MessageCatalogue>)[locale] ?? {};
    } else {
      targetDict = options.messages as MessageCatalogue;
    }
    if (DEFAULT_LOCALE in (options.messages as Record<string, unknown>)) {
      defaultDict = (options.messages as Record<SupportedLocale, MessageCatalogue>)[DEFAULT_LOCALE] ?? FLATTENED_EN;
    }
  } else {
    targetDict = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE] ?? {};
  }

  return (key: MessageKey, params?: Record<string, string | number>): string => {
    if (typeof key !== "string") return "";

    // 1. Direct hit in target locale dictionary
    if (Object.prototype.hasOwnProperty.call(targetDict, key)) {
      return interpolate(targetDict[key]!, params);
    }

    // 2. Missing in target locale — report in dev & attempt fallback to default (en)
    if (shouldReport && locale !== DEFAULT_LOCALE) {
      if (options.onMissingKey) {
        options.onMissingKey(key, locale, DEFAULT_LOCALE);
      } else {
        console.warn(
          `[i18n] Missing translation for key "${key}" in locale "${locale}". Falling back to "${DEFAULT_LOCALE}".`,
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(defaultDict, key)) {
      return interpolate(defaultDict[key]!, params);
    }

    // 3. Missing in default locale too
    if (shouldReport) {
      if (options.onMissingKey) {
        options.onMissingKey(key, locale, "none");
      } else {
        console.warn(`[i18n] Missing translation for key "${key}".`);
      }
    }

    return interpolate(key, params);
  };
}
