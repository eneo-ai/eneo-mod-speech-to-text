"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { LinkProvider } from "@astryxdesign/core/Link";
import sv from "@astryxdesign/core/locales/sv-SE.json";
import { Theme } from "@astryxdesign/core/theme";
import { RouterLink } from "@/kit/RouterLink";
import { eneoTheme } from "@/kit/theme/built/eneo";

const MESSAGES = { "sv-SE": sv };

type ColorMode = "light" | "dark" | "system";

/** The class next-themes keeps on <html>: "dark" or "light", also while it follows the system's choice. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function readMode(): ColorMode {
  const classes = document.documentElement.classList;
  return classes.contains("dark") ? "dark" : classes.contains("light") ? "light" : "system";
}

/**
 * The design system's providers for every page: the built Eneo theme, the Swedish catalog for the system's own
 * words and the router's link (kit/RouterLink) for its links.
 *
 * The colour mode is next-themes', which keeps it as a class on <html>. Until the page has hydrated Astryx is told
 * "system" and styles/globals.css makes the theme root follow that class, so the first paint is right; from then on
 * Astryx is told the same mode, so what reads its JavaScript theme (`useTheme()`: chart colours, canvas) agrees with
 * what is painted. The mode is read, never stored here: there is one owner.
 */
export function ModuleProviders({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(subscribe, readMode, () => "system" as ColorMode);
  return (
    <InternationalizationProvider locale="sv-SE" messages={MESSAGES}>
      <Theme theme={eneoTheme} mode={mode}>
        <LinkProvider component={RouterLink}>{children}</LinkProvider>
      </Theme>
    </InternationalizationProvider>
  );
}
