import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const css = readFileSync(join(SRC, "app/globals.css"), "utf8");

/** The text of the first `{ ... }` block that follows `opener`, without nesting. */
function blockAfter(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start === -1) throw new Error(`not found in stylesheet: ${opener}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

const lightBlock = declarations(blockAfter(css, ":root {"));
const explicitDark = declarations(blockAfter(css, ':root[data-theme="dark"]'));
const explicitLight = declarations(blockAfter(css, ':root[data-theme="light"]'));
const mediaDark = declarations(
  blockAfter(
    css.slice(css.indexOf("@media (prefers-color-scheme: dark)")),
    ':root:not([data-theme="light"])',
  ),
);

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const value = parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function dark(name: string): string {
  const value = explicitDark.get(name);
  if (!value || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new Error(`${name} is not a #RRGGBB value in the dark scheme`);
  }
  return value;
}

const AA_TEXT = 4.5;

describe("dark scheme definition", () => {
  it("is declared identically for an explicit choice and for the system preference", () => {
    expect(mediaDark.size).toBeGreaterThan(0);
    expect(Object.fromEntries(mediaDark)).toEqual(
      Object.fromEntries(explicitDark),
    );
  });

  it("opts into the dark colour-scheme so form controls and scrollbars follow", () => {
    expect(explicitDark.get("color-scheme")).toBe("dark");
    expect(mediaDark.get("color-scheme")).toBe("dark");
  });

  it("lets the browser pick for system, and forces light for an explicit light choice", () => {
    expect(lightBlock.get("color-scheme")).toBe("light dark");
    expect(explicitLight.get("color-scheme")).toBe("light");
  });

  it("only applies the system dark rule when the user has not chosen light", () => {
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it("defines a dark value for every token the light scheme defines", () => {
    const tokens = [...lightBlock.keys()].filter((key) => key.startsWith("--"));
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(explicitDark.has(token), token).toBe(true);
    }
  });
});

describe("light scheme is unchanged", () => {
  it("keeps its original token values", () => {
    expect(Object.fromEntries(lightBlock)).toEqual({
      "--background": "#FCF8F8",
      "--foreground": "#2D2D2D",
      "--accent": "#F5AFAF",
      "--accent-cta": "#F5AFAF",
      "--muted": "#8E8383",
      "--border": "#F9DFDF",
      "--surface": "#FBEFEF",
      "--surface-hover": "#F9DFDF",
      "--nav-foreground": "#2D2D2D",
      "--nav-accent": "#F5AFAF",
      "color-scheme": "light dark",
    });
  });
});

describe("dark scheme contrast (WCAG AA, 4.5:1 for text)", () => {
  const surfaces = ["--background", "--surface", "--surface-hover"];

  it("meets AA for the app's text tokens on every surface", () => {
    for (const text of [
      "--foreground",
      "--muted",
      "--accent",
      "--nav-foreground",
      "--nav-accent",
    ]) {
      for (const surface of surfaces) {
        expect(
          contrast(dark(text), dark(surface)),
          `${text} on ${surface}`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it("meets AA for page-coloured text on the accent fill (buttons)", () => {
    expect(
      contrast(dark("--background"), dark("--accent")),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  // The text colours used for status, error and info messages.
  const STATUS_TEXT = [
    "red-300",
    "red-400",
    "red-500",
    "red-600",
    "red-700",
    "green-400",
    "green-500",
    "yellow-300",
    "yellow-400",
    "yellow-500",
    "amber-400",
    "amber-600",
    "blue-400",
    "blue-500",
    "blue-600",
    "purple-500",
    "orange-500",
    "gray-500",
  ];

  it("meets AA for every status and error text colour on every surface", () => {
    for (const shade of STATUS_TEXT) {
      for (const surface of surfaces) {
        expect(
          contrast(dark(`--color-${shade}`), dark(surface)),
          `${shade} on ${surface}`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it("meets AA for error text on the dark error banner tint", () => {
    for (const shade of ["red-300", "red-400", "red-700"]) {
      expect(
        contrast(dark(`--color-${shade}`), dark("--color-red-100")),
        `${shade} on red-100`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("keeps borders and skeleton blocks distinguishable from the page without glaring", () => {
    for (const token of ["--border", "--color-gray-200", "--color-gray-300"]) {
      const ratio = contrast(dark(token), dark("--background"));
      expect(ratio, token).toBeGreaterThan(1.1);
      expect(ratio, token).toBeLessThan(3);
    }
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "generated"
        ? []
        : sourceFiles(path);
    }
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const tsxSources = sourceFiles(SRC).map((file) => ({
  file,
  text: readFileSync(file, "utf8"),
}));

describe("every light-only palette colour in the source has a dark counterpart", () => {
  const HUES = "red|green|yellow|amber|blue|purple|orange|gray|slate|zinc|neutral|stone|pink|rose|emerald|teal|cyan|sky|indigo|violet|fuchsia|lime";

  function used(pattern: RegExp): Set<string> {
    const found = new Set<string>();
    for (const { text } of tsxSources) {
      for (const match of text.matchAll(pattern)) {
        found.add(`--color-${match[1]}-${match[2]}`);
      }
    }
    return found;
  }

  it("covers every text-<hue>-<shade> class", () => {
    const textColours = used(new RegExp(`\\btext-(${HUES})-(\\d{2,3})\\b`, "g"));
    expect(textColours.size).toBeGreaterThan(0);
    for (const variable of textColours) {
      expect(
        explicitDark.has(variable),
        `${variable} is used as a text colour but has no dark value in globals.css`,
      ).toBe(true);
    }
  });

  it("covers every pale background or border step (50 to 300)", () => {
    const pale = used(
      new RegExp(`\\b(?:bg|border)-(${HUES})-(50|100|200|300)\\b`, "g"),
    );
    for (const variable of pale) {
      expect(
        explicitDark.has(variable),
        `${variable} is a pale step used for a background or border but has no dark value in globals.css`,
      ).toBe(true);
    }
  });
});

describe("no hard-coded light colours bypass the theme", () => {
  const read = (relative: string) =>
    readFileSync(join(SRC, relative), "utf8");

  it("the root layout sets no inline colour scheme or background", () => {
    const layout = read("app/layout.tsx");
    expect(layout).not.toMatch(/colorScheme/);
    expect(layout).not.toMatch(/backgroundColor/);
    expect(layout).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
    expect(layout).toContain("THEME_INIT_SCRIPT");
    expect(layout).toContain("suppressHydrationWarning");
  });

  it("the global error page reads its colours from the theme tokens", () => {
    const globalError = read("app/global-error.tsx");
    expect(globalError).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
    expect(globalError).not.toMatch(/style=\{\{[^}]*color/i);
    expect(globalError).toContain("THEME_INIT_SCRIPT");
  });

  it("the hero canvas paints with the active background instead of a fixed light fill", () => {
    const hero = read("app/hero-client.tsx");
    expect(hero).toContain("ctx!.fillStyle = background;");
    expect(hero).toContain('getPropertyValue("--background")');
  });
});
