import type { Metadata } from "next";
import { BrandingProvider } from "@/components/Brand";
import { ThemeProvider } from "@/components/theme-provider";
import { backendBase } from "@/lib/backend-base.mjs";
import { readBranding } from "@/lib/read-branding";
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
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <BrandingProvider value={branding}>
            <div className="app-shell">{children}</div>
          </BrandingProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
