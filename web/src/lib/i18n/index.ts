/**
 * Universal internationalisation entrypoint for Talos web app.
 * Compatible with Next.js App Router (Client and Server Components).
 *
 * For Server Components needing request cookies:
 * import { getServerTranslations, getServerLocale } from "@/lib/i18n/server";
 *
 * @module i18n
 */

export {
  SUPPORTED_LOCALES,
  type SupportedLocale,
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  MAX_LOCALE_INPUT_LENGTH,
  isSupportedLocale,
  normalizeLocaleTag,
  resolveLocale,
  resolveLocaleFromCookie,
  resolveLocaleFromAcceptLanguage,
} from "./config";

export {
  createTranslator,
  flattenMessages,
  interpolate,
  MESSAGES,
  FLATTENED_EN,
  FLATTENED_TEST,
  type MessageKey,
  type KnownMessageKey,
  type TranslateFn,
  type TranslatorOptions,
} from "./translator";

export {
  I18nProvider,
  useTranslation,
  useI18n,
  t,
  getActiveClientLocale,
  setActiveClientLocale,
  type I18nContextValue,
} from "./context";

export { en } from "./messages/en";
export { testMessages } from "./messages/test";
