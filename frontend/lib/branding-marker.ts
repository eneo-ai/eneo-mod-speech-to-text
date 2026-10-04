/**
 * The dev server's half of the organisation's mark. In production the backend writes the answer of `GET /api/branding`
 * into the page's `<meta name="eneo-branding">` once, at start (backend/app/web.py); this plugin does the same for each
 * page the dev server serves, from the backend (or the gate's stub) it proxies to. The app reads the marker and
 * never asks, so the dev profile shows the mark in the first frame as the built one does (lib/read-branding.ts).
 */
import type { Plugin } from "vite";

/** How long the dev server waits for the answer before it leaves the page with no organisation. */
export const BRANDING_DEADLINE_MS = 2_000;

const MARKER = /<meta name="eneo-branding" content=""\s*\/?>/g;
const NOBODY = '{"organization":null}';

/** An attribute value, escaped as the backend does it (Python's html.escape with quotes). */
const escapeAttribute = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function answer(api: string, fetchImpl: typeof fetch, deadlineMs: number): Promise<string> {
  try {
    const response = await fetchImpl(`${api}/api/branding`, { cache: "no-store", signal: AbortSignal.timeout(deadlineMs) });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    const text = await response.text();
    JSON.parse(text);
    return text;
  } catch (error) {
    console.error(`GET ${api}/api/branding failed (${String(error)}); the dev page shows "Tal till text" alone.`);
    return NOBODY;
  }
}

export function brandingMarker(api: string, fetchImpl: typeof fetch = fetch, deadlineMs: number = BRANDING_DEADLINE_MS): Plugin {
  return {
    name: "eneo-branding-marker",
    apply: "serve",
    async transformIndexHtml(html) {
      if (html.match(MARKER)?.length !== 1 || html.split('name="eneo-branding"').length !== 2) {
        throw new Error('index.html must hold exactly one empty <meta name="eneo-branding" content="">: the organisation is written into it.');
      }
      const tag = `<meta name="eneo-branding" content="${escapeAttribute(await answer(api, fetchImpl, deadlineMs))}" />`;
      return html.replace(MARKER, () => tag);
    },
  };
}
