// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  resolveLocale,
  resolveLocaleFromAcceptLanguage,
  resolveLocaleFromCookie,
} from "@/lib/i18n/config";
import {
  createTranslator,
  flattenMessages,
  interpolate,
  type MessageCatalogue,
} from "@/lib/i18n/translator";
import {
  I18nProvider,
  useTranslation,
  t,
  setActiveClientLocale,
  getActiveClientLocale,
} from "@/lib/i18n/context";
import { LocaleSwitch } from "@/components/locale-switch";

// React reads this flag to know state updates are wrapped in act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("i18n config & resolution", () => {
  describe("resolveLocale", () => {
    it("resolves exact supported locales", () => {
      expect(resolveLocale("en")).toBe("en");
      expect(resolveLocale("test")).toBe("test");
    });

    it("handles case-insensitivity", () => {
      expect(resolveLocale("EN")).toBe("en");
      expect(resolveLocale("Test")).toBe("test");
      expect(resolveLocale("tEsT")).toBe("test");
    });

    it("resolves language tags with subtags (e.g. en-US, en-GB, test-QA)", () => {
      expect(resolveLocale("en-US")).toBe("en");
      expect(resolveLocale("en-GB")).toBe("en");
      expect(resolveLocale("test-QA")).toBe("test");
    });

    it("falls back to DEFAULT_LOCALE ('en') on invalid or unsupported input", () => {
      expect(resolveLocale("fr")).toBe("en");
      expect(resolveLocale("es-ES")).toBe("en");
      expect(resolveLocale("")).toBe("en");
      expect(resolveLocale("   ")).toBe("en");
      expect(resolveLocale(null)).toBe("en");
      expect(resolveLocale(undefined)).toBe("en");
      expect(resolveLocale("../evil/path")).toBe("en");
      expect(resolveLocale("a".repeat(100))).toBe("en");
    });
  });

  describe("resolveLocaleFromCookie", () => {
    it("extracts the locale from a cookie header", () => {
      expect(resolveLocaleFromCookie("talos_locale=test")).toBe("test");
      expect(resolveLocaleFromCookie("session=xyz; talos_locale=test; theme=dark")).toBe("test");
      expect(resolveLocaleFromCookie("talos_locale=en")).toBe("en");
    });

    it("handles URL-encoded cookie values", () => {
      expect(resolveLocaleFromCookie("talos_locale=test%20")).toBe("test");
    });

    it("falls back to en when cookie is missing or invalid", () => {
      expect(resolveLocaleFromCookie("theme=dark; session=123")).toBe("en");
      expect(resolveLocaleFromCookie("talos_locale=unsupported_lang")).toBe("en");
      expect(resolveLocaleFromCookie("")).toBe("en");
      expect(resolveLocale(null)).toBe("en");
    });
  });

  describe("resolveLocaleFromAcceptLanguage", () => {
    it("resolves exact match from single header", () => {
      expect(resolveLocaleFromAcceptLanguage("test")).toBe("test");
      expect(resolveLocaleFromAcceptLanguage("en-US")).toBe("en");
    });

    it("respects quality weights in multi-locale Accept-Language headers", () => {
      // test has higher weight than en
      expect(resolveLocaleFromAcceptLanguage("fr-FR,fr;q=0.9,test;q=0.8,en;q=0.7")).toBe("test");
      // en has higher weight than test
      expect(resolveLocaleFromAcceptLanguage("test;q=0.3,en;q=0.9")).toBe("en");
    });

    it("falls back to en when Accept-Language matches no supported locale", () => {
      expect(resolveLocaleFromAcceptLanguage("fr-FR,de-DE;q=0.9,ja;q=0.8")).toBe("en");
      expect(resolveLocaleFromAcceptLanguage("")).toBe("en");
      expect(resolveLocaleFromAcceptLanguage(null)).toBe("en");
    });
  });
});

describe("i18n translator & interpolation", () => {
  it("interpolates parameters into message templates", () => {
    expect(interpolate("Hello, {name}!", { name: "Alice" })).toBe("Hello, Alice!");
    expect(interpolate("{count} items remaining in {category}", { count: 4, category: "DeFi" })).toBe("4 items remaining in DeFi");
    // Leaves missing placeholders untouched
    expect(interpolate("Missing {param}", {})).toBe("Missing {param}");
  });

  it("flattens nested message catalogues into dot-notation keys", () => {
    const raw = {
      nav: {
        home: "Home",
        nested: {
          deep: "Deep Value",
        },
      },
      count: 42,
    };
    const flattened = flattenMessages(raw);
    expect(flattened["nav.home"]).toBe("Home");
    expect(flattened["nav.nested.deep"]).toBe("Deep Value");
    expect(flattened["count"]).toBe("42");
  });

  it("translates canonical keys in English (en)", () => {
    const translate = createTranslator("en");
    expect(translate("header.nav.marketplace")).toBe("Marketplace");
    expect(translate("header.nav.proposals")).toBe("Proposals");
    expect(translate("header.connectWallet")).toBe("Connect Wallet");
    expect(translate("launch.title")).toBe("Launch your TALOS");
    expect(translate("proposals.title")).toBe("Governance Proposals");
  });

  it("translates swappable keys in test locale with [TEST] prefix", () => {
    const translate = createTranslator("test");
    expect(translate("header.nav.marketplace")).toBe("[TEST] Marketplace");
    expect(translate("header.nav.proposals")).toBe("[TEST] Proposals");
    expect(translate("header.connectWallet")).toBe("[TEST] Connect Wallet");
    expect(translate("launch.title")).toBe("[TEST] Launch your TALOS");
    expect(translate("proposals.title")).toBe("[TEST] Governance Proposals");
  });

  it("preserves interpolation placeholders in both en and test locales", () => {
    const translateEn = createTranslator("en");
    const translateTest = createTranslator("test");

    expect(translateEn("proposals.time.minutesAgo", { count: 12 })).toBe("12m ago");
    expect(translateTest("proposals.time.minutesAgo", { count: 12 })).toBe("[TEST] 12m ago");

    expect(translateEn("marketplace.pills.category", { category: "DeFi" })).toBe("Category: DeFi");
    expect(translateTest("marketplace.pills.category", { category: "DeFi" })).toBe("[TEST] Category: DeFi");

    expect(translateEn("marketplace.pills.minPrice", { price: "10" })).toBe("Min: $10");
    expect(translateTest("marketplace.pills.minPrice", { price: "10" })).toBe("[TEST] Min: $10");
  });

  describe("fallback and dev reporting", () => {
    it("falls back to English when a key is missing in target locale and reports warning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Custom catalogue where a key is intentionally missing
      const customCatalogue: MessageCatalogue = {
        "header.nav.marketplace": "[CUSTOM] Marketplace",
      };

      const translate = createTranslator("test", customCatalogue);

      // Present in custom catalogue
      expect(translate("header.nav.marketplace")).toBe("[CUSTOM] Marketplace");
      expect(warnSpy).not.toHaveBeenCalled();

      // Missing in custom catalogue -> should fall back to English canonical
      const fallbackResult = translate("header.nav.proposals");
      expect(fallbackResult).toBe("Proposals");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing translation for key "header.nav.proposals"'),
      );

      warnSpy.mockRestore();
    });

    it("returns key itself and reports warning when missing in BOTH locale and default English", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const translate = createTranslator("en");
      // @ts-expect-error Testing non-existent key runtime behavior
      const missingResult = translate("nonexistent.key.test");

      expect(missingResult).toBe("nonexistent.key.test");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing translation for key "nonexistent.key.test"'),
      );

      warnSpy.mockRestore();
    });
  });
});

describe("Client context & LocaleSwitch integration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    document.cookie = `${LOCALE_COOKIE_NAME}=; max-age=0; path=/`;
    setActiveClientLocale(DEFAULT_LOCALE);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("global t() reflects activeClientLocale updates", () => {
    setActiveClientLocale("en");
    expect(getActiveClientLocale()).toBe("en");
    expect(t("header.nav.marketplace")).toBe("Marketplace");

    setActiveClientLocale("test");
    expect(getActiveClientLocale()).toBe("test");
    expect(t("header.nav.marketplace")).toBe("[TEST] Marketplace");

    setActiveClientLocale("en");
  });

  it("renders LocaleSwitch and toggles locale on click", async () => {
    function TestApp() {
      const { locale, t } = useTranslation();
      return (
        <div>
          <span data-testid="current-locale">{locale}</span>
          <span data-testid="translated-title">{t("header.nav.marketplace")}</span>
          <LocaleSwitch />
        </div>
      );
    }

    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(I18nProvider, { initialLocale: "en" }, createElement(TestApp)),
      );
    });

    const switchBtn = container.querySelector<HTMLButtonElement>('[data-testid="locale-switch"]');
    const localeDisplay = container.querySelector('[data-testid="current-locale"]');
    const titleDisplay = container.querySelector('[data-testid="translated-title"]');

    expect(switchBtn).toBeTruthy();
    expect(localeDisplay?.textContent).toBe("en");
    expect(titleDisplay?.textContent).toBe("Marketplace");
    expect(switchBtn?.textContent).toContain("EN");

    // Click to cycle to test
    await act(async () => {
      switchBtn?.click();
    });

    expect(localeDisplay?.textContent).toBe("test");
    expect(titleDisplay?.textContent).toBe("[TEST] Marketplace");
    expect(switchBtn?.textContent).toContain("TEST");
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=test`);

    // Click again to cycle back to en
    await act(async () => {
      switchBtn?.click();
    });

    expect(localeDisplay?.textContent).toBe("en");
    expect(titleDisplay?.textContent).toBe("Marketplace");
    expect(switchBtn?.textContent).toContain("EN");
    expect(document.cookie).toContain(`${LOCALE_COOKIE_NAME}=en`);
  });
});
