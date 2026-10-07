import type { ReactNode } from "react";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { LinkProvider } from "@astryxdesign/core/Link";
import sv from "@astryxdesign/core/locales/sv-SE.json";
import { Theme } from "@astryxdesign/core/theme";
import { ColorModeProvider, useColorMode } from "@/kit/ColorModeProvider";
import { RouterLink } from "@/kit/RouterLink";
import { eneoTheme } from "@/kit/theme/built/eneo";

const MESSAGES = { "sv-SE": sv };

/** The theme in the mode the person chose (or the system's): `<Theme>` paints it and tells `<html>` with `data-theme`. */
function Themed({ children }: { children: ReactNode }) {
  const { mode } = useColorMode();
  return (
    <Theme theme={eneoTheme} mode={mode}>
      {children}
    </Theme>
  );
}

/**
 * The design system's providers for every page: the colour mode, the built Eneo theme, the Swedish catalog for the
 * system's own words and the router's link (kit/RouterLink) for its links.
 *
 * The colour mode has one owner, ColorModeProvider. Its first render already has the stored choice, so the theme's first
 * render is right; the frames before React, while the page's scripts are on their way, are public/color-mode.js's.
 */
export function ModuleProviders({ children }: { children: ReactNode }) {
  return (
    <ColorModeProvider>
      <InternationalizationProvider locale="sv-SE" messages={MESSAGES}>
        <Themed>
          <LinkProvider component={RouterLink}>{children}</LinkProvider>
        </Themed>
      </InternationalizationProvider>
    </ColorModeProvider>
  );
}
