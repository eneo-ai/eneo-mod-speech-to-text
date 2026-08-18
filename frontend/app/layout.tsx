import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "Flöden",
  description: "Spela in samtal, få transkript och anteckningar",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="sv">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* Raleway för rubriker; Inter för brödtext (bättre läsbarhet i små
            storlekar). Geist Mono för eyebrow-/mono-detaljer. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Raleway:wght@500;600;700;800&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <div className="app-shell">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
