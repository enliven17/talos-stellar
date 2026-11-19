import { describe, expect, it } from "vitest";
import {
  THEME_ATTRIBUTE,
  THEME_INIT_SCRIPT,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  applyTheme,
  isThemePreference,
  nextTheme,
  readStoredTheme,
  writeStoredTheme,
  type ThemePreference,
} from "@/lib/theme";

/** A Storage stand-in that records what was written. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

/** A Storage stand-in whose every call throws, as in blocked-site-data modes. */
const throwingStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

function fakeRoot() {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name: string, value: string) =>
      void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
}

describe("isThemePreference", () => {
  it("accepts exactly the three preferences", () => {
    for (const value of ["system", "light", "dark"]) {
      expect(isThemePreference(value)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const value of ["", "Dark", "auto", "dark ", null, undefined, 1, {}]) {
      expect(isThemePreference(value)).toBe(false);
    }
  });
});

describe("readStoredTheme", () => {
  it("returns an explicit saved choice", () => {
    expect(
      readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "dark" })),
    ).toBe("dark");
    expect(
      readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "light" })),
    ).toBe("light");
  });

  it("returns system when nothing is saved", () => {
    expect(readStoredTheme(fakeStorage())).toBe("system");
  });

  it("returns system for a value it does not recognise", () => {
    expect(
      readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "sepia" })),
    ).toBe("system");
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "" }))).toBe(
      "system",
    );
  });

  it("returns undefined, without throwing, when storage is unavailable", () => {
    expect(readStoredTheme(null)).toBeUndefined();
    expect(readStoredTheme(throwingStorage)).toBeUndefined();
  });
});

describe("writeStoredTheme", () => {
  it("saves light and dark under the storage key", () => {
    const storage = fakeStorage();
    expect(writeStoredTheme("dark", storage)).toBe(true);
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(writeStoredTheme("light", storage)).toBe(true);
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("light");
  });

  it("removes the key for system so the operating system setting is followed again", () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: "dark" });
    expect(writeStoredTheme("system", storage)).toBe(true);
    expect(storage.data.has(THEME_STORAGE_KEY)).toBe(false);
    expect(readStoredTheme(storage)).toBe("system");
  });

  it("reports failure, without throwing, when storage is unavailable", () => {
    expect(writeStoredTheme("dark", null)).toBe(false);
    expect(writeStoredTheme("dark", throwingStorage)).toBe(false);
    expect(writeStoredTheme("system", throwingStorage)).toBe(false);
  });

  it("round-trips every preference", () => {
    const storage = fakeStorage();
    for (const theme of THEME_PREFERENCES) {
      writeStoredTheme(theme, storage);
      expect(readStoredTheme(storage)).toBe(theme);
    }
  });
});

describe("applyTheme", () => {
  it("sets the attribute for an explicit choice", () => {
    const root = fakeRoot();
    applyTheme("dark", root);
    expect(root.attributes.get(THEME_ATTRIBUTE)).toBe("dark");
    applyTheme("light", root);
    expect(root.attributes.get(THEME_ATTRIBUTE)).toBe("light");
  });

  it("removes the attribute for system", () => {
    const root = fakeRoot();
    applyTheme("dark", root);
    applyTheme("system", root);
    expect(root.attributes.has(THEME_ATTRIBUTE)).toBe(false);
  });

  it("uses the data-theme attribute the stylesheet selects on", () => {
    expect(THEME_ATTRIBUTE).toBe("data-theme");
  });
});

describe("nextTheme", () => {
  it("steps system, light, dark, then back to system", () => {
    const order: ThemePreference[] = [];
    let current: ThemePreference = "system";
    for (let i = 0; i < 4; i++) {
      current = nextTheme(current);
      order.push(current);
    }
    expect(order).toEqual(["light", "dark", "system", "light"]);
  });
});

describe("THEME_INIT_SCRIPT", () => {
  /** Runs the real script text against fake window and document objects. */
  function run(storage: unknown) {
    const root = fakeRoot();
    const win = {
      get localStorage() {
        if (storage instanceof Error) throw storage;
        return storage;
      },
    };
    const doc = { documentElement: root };
    new Function("window", "document", THEME_INIT_SCRIPT)(win, doc);
    return root;
  }

  it("applies a saved dark choice before first paint", () => {
    const root = run(fakeStorage({ [THEME_STORAGE_KEY]: "dark" }));
    expect(root.attributes.get(THEME_ATTRIBUTE)).toBe("dark");
  });

  it("applies a saved light choice", () => {
    const root = run(fakeStorage({ [THEME_STORAGE_KEY]: "light" }));
    expect(root.attributes.get(THEME_ATTRIBUTE)).toBe("light");
  });

  it("leaves the attribute off when nothing is saved, so the media query decides", () => {
    expect(run(fakeStorage()).attributes.size).toBe(0);
  });

  it("ignores a saved value that is not light or dark", () => {
    for (const value of ["system", "sepia", ""]) {
      expect(
        run(fakeStorage({ [THEME_STORAGE_KEY]: value })).attributes.size,
      ).toBe(0);
    }
  });

  it("does not throw when storage is blocked or access to it throws", () => {
    expect(() => run(throwingStorage)).not.toThrow();
    expect(() => run(new Error("SecurityError"))).not.toThrow();
    expect(run(throwingStorage).attributes.size).toBe(0);
    expect(run(null).attributes.size).toBe(0);
  });

  it("is a single self-contained statement with no external references", () => {
    expect(THEME_INIT_SCRIPT.startsWith("(function(){")).toBe(true);
    expect(THEME_INIT_SCRIPT.endsWith("})();")).toBe(true);
    expect(THEME_INIT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(THEME_INIT_SCRIPT).toContain(JSON.stringify(THEME_ATTRIBUTE));
  });
});
