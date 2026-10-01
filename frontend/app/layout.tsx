import type { Metadata } from "next";
import { BrandingProvider } from "@/components/Brand";
import { ThemeProvider } from "@/components/theme-provider";
import { ModuleProviders } from "@/kit/ModuleProviders";
import { backendBase } from "@/lib/backend-base.mjs";
import { readBranding } from "@/lib/read-branding";
import "./layers.css";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@/kit/theme/built/eneo.css";
import "./globals.css";

// The organisation's mark is a runtime setting of each deployment, rendered into the first HTML so no
// page shows one municipality's mark before another's; every page is therefore rendered per request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Tal till text",
  description: "Spela in samtal, få transkript och anteckningar",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const branding = await readBranding(backendBase());
  return (
    <html lang="sv" suppressHydrationWarning>
      <head>
        {/* The deployment's accent colour (ORGANIZATION_ACCENT), served by the backend as an override of the built theme;
            an empty comment when none is set. A plain stylesheet link in the head: it holds the first paint until it is
            there, so no frame shows the old colour, it is cached, and a strict style-src 'self' allows it. */}
        <link rel="stylesheet" href="/api/branding/theme.css" />
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ModuleProviders>
            <BrandingProvider value={branding}>
              <div className="app-shell">{children}</div>
            </BrandingProvider>
          </ModuleProviders>
        </ThemeProvider>
      </body>
    </html>
  );
}
