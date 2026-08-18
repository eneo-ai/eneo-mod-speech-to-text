import type { Metadata } from "next";
import "./globals.css";

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
      <body>
        <div className="app-shell">{children}</div>
      </body>
    </html>
  );
}
