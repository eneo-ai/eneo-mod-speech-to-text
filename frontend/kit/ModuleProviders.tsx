"use client";

import type { ReactNode } from "react";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import sv from "@astryxdesign/core/locales/sv-SE.json";
import { Theme } from "@astryxdesign/core/theme";
import { eneoTheme } from "@/kit/theme/built/eneo";

const MESSAGES = { "sv-SE": sv };

/**
 * The design system's providers for every page: the built Eneo theme and the Swedish catalog for the system's own
 * words. The colour mode is not set here: next-themes owns it (the class on <html>), and app/globals.css makes the
 * theme root follow that class from the first paint.
 */
export function ModuleProviders({ children }: { children: ReactNode }) {
  return (
    <InternationalizationProvider locale="sv-SE" messages={MESSAGES}>
      <Theme theme={eneoTheme} mode="system">
        {children}
      </Theme>
    </InternationalizationProvider>
  );
}
