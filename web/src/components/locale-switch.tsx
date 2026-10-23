"use client";

import { useTranslation, type SupportedLocale } from "@/lib/i18n";

const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "EN",
  test: "TEST",
};

export function LocaleSwitch({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useTranslation();

  const nextLocale: SupportedLocale = locale === "en" ? "test" : "en";
  const label = `Language: ${LOCALE_LABELS[locale]}. Switch to ${LOCALE_LABELS[nextLocale]}.`;

  return (
    <button
      type="button"
      onClick={() => setLocale(nextLocale)}
      data-testid="locale-switch"
      data-locale={locale}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center h-8 px-2.5 shrink-0 border border-border text-xs font-mono text-muted hover:text-nav-foreground hover:bg-surface-hover transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
    >
      <span>{LOCALE_LABELS[locale]}</span>
    </button>
  );
}
