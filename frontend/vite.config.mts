import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { brandingMarker } from "./lib/branding-marker";

const API = process.env.DEV_API_BASE ?? "http://127.0.0.1:8000";

export default defineConfig(({ mode }) => ({
  // The dev server fills the organisation's marker as the backend does in production (lib/branding-marker.ts).
  plugins: [react(), brandingMarker(API)],
  // `@/x` is `<frontend>/x`, as tsconfig "paths" says; the regex consumes the slash, so no `//` is left in the path.
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }] },
  // Build-time flags. Undefined in the unit tests, which is false there as process.env was.
  define: { __SPEAKER_REVIEW__: JSON.stringify(process.env.SPEAKER_REVIEW_ENABLED === "true") },
  server: {
    host: "0.0.0.0",
    port: 3002,
    // changeOrigin stays false: the browser's Origin must reach the backend's same-origin check unchanged.
    proxy: { "/api": { target: API, ws: true, changeOrigin: false }, "/health": { target: API, changeOrigin: false } },
  },
  build: {
    outDir: mode === "check" ? "dist-check" : "dist",
    assetsInlineLimit: 0, // no data: URIs: font-src and img-src stay as small as they are
    sourcemap: false,
  },
}));
