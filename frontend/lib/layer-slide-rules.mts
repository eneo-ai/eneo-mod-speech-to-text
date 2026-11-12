/**
 * Astryx's layers (menus, popovers, tooltips) take their fallback positions from `@position-try` rules, which it writes
 * into a `<style>` of its own the first time a layer opens. The page's strict `style-src 'self'`
 * (backend/app/security_headers.json) blocks that `<style>`, and the policy is never relaxed. So the same rules, from the
 * installed Astryx, are a part of the app's own stylesheet (main.tsx imports this module's CSS), and the page carries the
 * element Astryx looks for before it writes them, so it writes nothing. tests/prod/smoke.spec.ts holds both.
 */
import type { Plugin } from "vite";

const CSS = "virtual:astryx-layer-slide-rules.css";

type SlideRules = { slideRulesCss(): string; SLIDE_RULES_ID: string };

export function layerSlideRules(): Plugin {
  // Not among the package's exports: read from where the installed release keeps it, so the rules are always its own.
  const rules = import(new URL("../node_modules/@astryxdesign/core/dist/Layer/layerSlideRules.js", import.meta.url).href) as Promise<SlideRules>;
  return {
    name: "astryx-layer-slide-rules",
    resolveId: (id) => (id === CSS ? CSS : undefined),
    load: async (id) => (id === CSS ? (await rules).slideRulesCss() : undefined),
    transformIndexHtml: async () => [{ tag: "template", attrs: { id: (await rules).SLIDE_RULES_ID }, injectTo: "head" }],
  };
}
