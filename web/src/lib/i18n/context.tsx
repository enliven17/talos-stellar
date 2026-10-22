"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  SUPPORTED_LOCALES,
  resolveLocale,
  type SupportedLocale,
} from "./config";
import {
  createTranslator,
  type MessageKey,
  type TranslateFn,
} from "./translator";

/** Module-level active client locale for direct t() calls. */
let activeClientLocale: SupportedLocale = DEFAULT_LOCALE;

export function getActiveClientLocale(): SupportedLocale {
  return activeClientLocale;
}

export function setActiveClientLocale(locale: SupportedLocale): void {
  activeClientLocale = resolveLocale(locale);
}

/**
 * Direct t() helper compatible with server and client components.
 * - On the client: uses the active client locale (synced with I18nProvider).
 * - On the server: falls back to DEFAULT_LOCALE ("en") unless called via getServerTranslations().
 */
export function t(
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const translator = createTranslator(activeClientLocale);
  return translator(key, params);
}

export interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: TranslateFn;
  supportedLocales: readonly SupportedLocale[];
}

const defaultTranslator = createTranslator(DEFAULT_LOCALE);

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: defaultTranslator,
  supportedLocales: SUPPORTED_LOCALES,
});

function useOptionalRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

export function I18nProvider({
  initialLocale = DEFAULT_LOCALE,
  children,
}: {
  initialLocale?: SupportedLocale;
  children: ReactNode;
}) {
  const router = useOptionalRouter();
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    const resolved = resolveLocale(initialLocale);
    setActiveClientLocale(resolved);
    return resolved;
  });

  // Sync module-level client locale
  useEffect(() => {
    setActiveClientLocale(locale);
  }, [locale]);

  const setLocale = useCallback(
    (newLocale: SupportedLocale) => {
      const resolved = resolveLocale(newLocale);
      setLocaleState(resolved);
      setActiveClientLocale(resolved);

      try {
        if (typeof document !== "undefined") {
          document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(
            resolved,
          )}; path=/; max-age=31536000; SameSite=Lax`;
        }
      } catch {
        // Safe failover if cookies are blocked in sandboxed context
      }

      // Refresh server components to re-render in the new locale
      try {
        router?.refresh();
      } catch {
        // Safe failover if called during testing / outside Next.js router
      }
    },
    [router],
  );

  const translator = useMemo(() => createTranslator(locale), [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: translator,
      supportedLocales: SUPPORTED_LOCALES,
    }),
    [locale, setLocale, translator],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18nContextValue {
  return useContext(I18nContext);
}

export const useI18n = useTranslation;
