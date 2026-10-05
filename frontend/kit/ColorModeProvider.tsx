// Copied from eneo-module-kit-ui, packages/ui/src/color-mode.tsx, commit 9eb66af (and its tests, lib/color-mode.test.ts, from
// packages/ui/tests/color-mode.test.ts). Plan C task stt-plan-c-module-kit-gwh.3 deletes this copy for the kit's own.
// Changed from the kit's: one comment is reworded (the kit's names the library its key came from, which this module no
// longer has), and a switch of the mode marks `<html>` so the page's colour transitions are off for it (markSwitching).
// The kit's own apps want the same: say so on the kit's board when Plan C starts.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ColorMode = "light" | "dark" | "system";

/** The key and values this module's first colour mode stored (and the kit's apps before it), so a person's choice carries over (design K9). */
const COLOR_MODE_KEY = "theme";

const MODES: readonly string[] = ["light", "dark", "system"];
const DARK = "(prefers-color-scheme: dark)";

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Reading the property itself can throw (blocked site data).
    return null;
  }
}

/**
 * The stored choice, read at once, before anything renders: light, dark or system. Anything else, or storage that is
 * missing or throws, is no choice, and no choice is system.
 */
export function readStoredColorMode(storage: Pick<Storage, "getItem"> | null = browserStorage()): ColorMode {
  try {
    const stored = storage?.getItem(COLOR_MODE_KEY);
    return stored && MODES.includes(stored) ? (stored as ColorMode) : "system";
  } catch {
    return "system";
  }
}

/**
 * A switch of the mode paints the surfaces and the text at once, so the design system's colour transitions (175 ms)
 * would show as controls that lag behind the page. For the frames that apply the new mode `<html>` says so, and one
 * static rule in styles/globals.css (`[data-theme-switching]`) turns every transition off. A rule and an attribute, not an
 * inline style: it stands under `style-src 'self'`. Called from the event, before React has rendered, so it is there for
 * the first frame that has the new colours.
 */
function markSwitching() {
  const root = document.documentElement;
  root.setAttribute("data-theme-switching", "");
  requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute("data-theme-switching")));
}

function prefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK).matches;
}

interface ColorModeValue {
  /** What the person chose. */
  mode: ColorMode;
  /** What is shown: the choice, or for system the operating system's. */
  resolved: "light" | "dark";
  setMode: (mode: ColorMode) => void;
}

const ColorModeContext = createContext<ColorModeValue | null>(null);

/**
 * The colour mode of a static app: no server render has to agree with it, so the stored choice is the state's first
 * value and the first render is already in the right mode. The design system's `<Theme mode>` applies it (and tells
 * the document, for the browser's own controls); this holds the choice, follows the operating system for system,
 * and writes the choice back. No inline script, no cookie.
 */
export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>(() => readStoredColorMode());
  // The mode last set, for the handlers below to tell a change from the same again.
  const modeRef = useRef(mode);
  const [dark, setDark] = useState(prefersDark);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(DARK);
    let shown = query.matches;
    setDark(shown);
    const follow = () => {
      if (query.matches === shown) return;
      shown = query.matches;
      markSwitching();
      setDark(shown);
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  // Another tab's choice reaches this one.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== COLOR_MODE_KEY && event.key !== null) return;
      const next = readStoredColorMode();
      if (next === modeRef.current) return;
      markSwitching();
      modeRef.current = next;
      setModeState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setMode = useCallback((next: ColorMode) => {
    if (next !== modeRef.current) markSwitching();
    modeRef.current = next;
    setModeState(next);
    try {
      browserStorage()?.setItem(COLOR_MODE_KEY, next);
    } catch {
      // Not stored (a quota, a private window): it still applies for the visit.
    }
  }, []);

  const value = useMemo<ColorModeValue>(
    () => ({ mode, resolved: mode === "system" ? (dark ? "dark" : "light") : mode, setMode }),
    [mode, dark, setMode],
  );
  return <ColorModeContext.Provider value={value}>{children}</ColorModeContext.Provider>;
}

/** The colour mode and a way to change it; inside ModuleProviders. */
export function useColorMode(): ColorModeValue {
  const value = useContext(ColorModeContext);
  if (!value) throw new Error("useColorMode must be used inside ColorModeProvider (ModuleProviders has one).");
  return value;
}
