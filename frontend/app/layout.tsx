import type { Metadata } from "next";
import { BrandingProvider } from "@/components/Brand";
import { ThemeProvider } from "@/components/theme-provider";
import type { Branding } from "@/lib/api";
import { backendBase } from "@/lib/backend-base.mjs";
import "./globals.css";

// The organisation's mark is a runtime setting of each deployment, rendered into the first HTML so no
// page shows one municipality's mark before another's; every page is therefore rendered per request.
export const dynamic = "force-dynamic";

/** The deployment's branding from the module's backend; without an answer, the product name alone. */
async function readBranding(): Promise<Branding> {
  try {
    const response = await fetch(`${backendBase()}/api/branding`, { cache: "no-store" });
    if (response.ok) return (await response.json()) as Branding;
    console.error(`GET /api/branding answered ${response.status}; the header shows "Tal till text" alone.`);
  } catch (error) {
    console.error(`GET /api/branding failed (${String(error)}); the header shows "Tal till text" alone.`);
  }
  return { organization: null };
}

export const metadata: Metadata = {
  title: "Tal till text",
  description: "Spela in samtal, få transkript och anteckningar",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const branding = await readBranding();
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
