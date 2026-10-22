import { cookies } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  resolveLocale,
  type SupportedLocale,
} from "./config";
import { createTranslator, type TranslateFn } from "./translator";

/**
 * Resolves the active locale on the server from the request cookies.
 * Fail-closed: returns DEFAULT_LOCALE ("en") if cookies are missing or cannot be read.
 */
export async function getServerLocale(): Promise<SupportedLocale> {
  try {
    const cookieStore = await cookies();
    const raw = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
    return resolveLocale(raw);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * Synchronous translator factory for Server Components where locale is already known.
 */
export function getTranslator(
  locale: SupportedLocale = DEFAULT_LOCALE,
): TranslateFn {
  return createTranslator(locale);
}

/**
 * Resolves the server-side translator and locale from the request cookies.
 */
export async function getServerTranslations(): Promise<{
  t: TranslateFn;
  locale: SupportedLocale;
}> {
  const locale = await getServerLocale();
  return {
    t: createTranslator(locale),
    locale,
  };
}
