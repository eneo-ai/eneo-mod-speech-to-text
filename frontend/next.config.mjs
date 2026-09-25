import { backendBase } from "./lib/backend-base.mjs";

const isDev = process.env.NODE_ENV === "development";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // `next dev` skriver annars ospårade AGENTS.md och CLAUDE.md i frontend/ vid varje start.
  agentRules: false,
  skipTrailingSlashRedirect: true,
  experimental: {
    // Next klonar request-bodyn för proxade rewrites (våra /api/*-anrop till
    // FastAPI) och kapar den vid 10 MB som standard — en ljuduppladdning
    // större än så trunkerades tyst och gick sönder hos Eneo. Filstorleken
    // begränsas av Eneos flow-kontrakt (max_file_size_bytes), inte här.
    // Obs: Next håller den klonade bodyn i minnet under uppladdningen, så
    // taket är också ett tak för processens minnesåtgång per upload.
    proxyClientMaxBodySize: "2gb",
    // Next:s rewrite-proxy släpper annars ett anrop som varit tyst i 30 s. Medan FastAPI
    // skickar en stor mötesfil vidare och Eneo sparar den får webbläsaren inget svar: då nådde
    // uppladdningen 100 % och föll, fast Eneo hade sparat filen. 11 minuter tystnad räcker.
    proxyTimeout: 660_000,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            // default-src locks every fetch directive to same-origin; the
            // exceptions below are only what the module actually uses:
            //   media/img blob: + data: — in-browser audio recording preview,
            //   style 'unsafe-inline' — Tailwind/Next inline style attributes.
            // script keeps 'unsafe-inline' because Next's hydration bootstrap
            // is inline and would be blocked without per-request nonces
            // (nonce middleware is a follow-up); everything else is denied.
            value: [
              "default-src 'self'",
              // 'unsafe-eval' bara i `next dev`: React dev-läge använder eval för
              // källkartor/callstacks. Produktionsbygget får aldrig med det.
              isDev
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
                : "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "media-src 'self' blob:",
              "font-src 'self'",
              "connect-src 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "object-src 'none'",
            ].join("; "),
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(self)",
          },
        ],
      },
      {
        // The result page previews a generated PDF in a same-origin frame; the
        // backend serves only PDFs inline here. Later rules win per header key.
        source: "/api/eneo/flows/:flowId/runs/:runId/artifacts/:fileId/content",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
  async rewrites() {
    const target = backendBase();
    return [
      {
        source: "/api/:path*",
        destination: `${target}/api/:path*`,
      },
      {
        source: "/health",
        destination: `${target}/api/healthz`,
      },
    ];
  },
};

export default nextConfig;
