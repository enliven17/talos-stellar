/**
 * Colour theme preference for the web app.
 *
 * The preference has three values. "system" follows the browser's
 * `prefers-color-scheme` through CSS alone and stores nothing. "light" and
 * "dark" are explicit choices: they are saved in localStorage and applied as a
 * `data-theme` attribute on the root element, which the rules in
 * `app/globals.css` key off.
 *
 * Reading and writing storage can throw (private browsing, blocked site data,
 * a sandboxed iframe), so every access is wrapped. When storage is unusable the
 * app still works: the choice simply does not survive a reload.
 */

export const THEME_STORAGE_KEY = "talos-theme";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The attribute the stylesheet reads for an explicit light or dark choice. */
export const THEME_ATTRIBUTE = "data-theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === "string" &&
    (THEME_PREFERENCES as readonly string[]).includes(value)
  );
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem" | "removeItem">;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Merely reading `window.localStorage` throws when site data is blocked.
    return null;
  }
}

/**
 * The saved preference, "system" when nothing (or something unrecognised) is
 * saved, or `undefined` when storage cannot be read at all. Callers use the
 * difference to fall back to an in-memory value for the current page.
 */
export function readStoredTheme(
  storage: ReadableStorage | null = browserStorage(),
): ThemePreference | undefined {
  if (!storage) return undefined;
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return undefined;
  }
}

/**
 * Saves the preference. "system" removes the key so a later change to the
 * operating system setting is followed again. Returns whether storage accepted
 * the write.
 */
export function writeStoredTheme(
  theme: ThemePreference,
  storage: WritableStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    if (theme === "system") {
      storage.removeItem(THEME_STORAGE_KEY);
    } else {
      storage.setItem(THEME_STORAGE_KEY, theme);
    }
    return true;
  } catch {
    return false;
  }
}

/** Puts an explicit choice on the root element, or removes it for "system". */
export function applyTheme(
  theme: ThemePreference,
  root: Pick<Element, "setAttribute" | "removeAttribute">,
): void {
  if (theme === "system") {
    root.removeAttribute(THEME_ATTRIBUTE);
  } else {
    root.setAttribute(THEME_ATTRIBUTE, theme);
  }
}

/** The order the toggle steps through: system, light, dark, system. */
export function nextTheme(theme: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(theme);
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length];
}

/**
 * Runs in the document head before the first paint, so a saved explicit choice
 * is on the root element before anything is drawn and the page never flashes
 * the wrong scheme. With nothing saved it does nothing, and the stylesheet's
 * `prefers-color-scheme` rule decides from the very first frame.
 *
 * Built from the same constants as the rest of this module so the key and the
 * attribute cannot drift apart.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=window.localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark"){document.documentElement.setAttribute(${JSON.stringify(
  THEME_ATTRIBUTE,
)},t)}}catch(e){}})();`;
