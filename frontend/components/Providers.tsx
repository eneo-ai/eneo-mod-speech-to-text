"use client";

import { ColorSchemeMode, GuiProvider } from "@sk-web-gui/react";

// Sundsvalls kommun-designsystem. GuiProvider injicerar SK:s tema-CSS-variabler
// (färger, typografi, spacing) som Tailwind-preseten konsumerar. Vi kör ljust
// färgschema (vit/neutral profil).
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <GuiProvider colorScheme={ColorSchemeMode.Light}>{children}</GuiProvider>
  );
}
