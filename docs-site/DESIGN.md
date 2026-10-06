---
name: Tal till text, documentation site
description: Starlight MD3's native templates, blue accent, comfortable controls and high contrast.
---

# Design System: Tal till text, documentation site

## Theme owner

Starlight MD3 0.2.2 owns the site's palette, typography, spacing, surfaces, navigation and focus treatment. `astro.config.mjs` selects its native `blue` accent, `comfortable` density, `high` contrast and disabled decorative motion. Use the theme's options before considering CSS. There are no remote fonts, scripts, styles or search services.

The start page uses Starlight's documentation template with its native hero and sidebar. The generated page takes its introduction from `docs/index.md`, so the website and GitHub share the same product facts. Documentation and API pages use the native reading layout, sidebar and table of contents. The site's Swedish labels, local Pagefind search and AGPL license footer remain.

`src/styles/custom.css` contains only integration and accessibility rules: the theme's existing control-height token supplies the project's 44 px target size; long API paths wrap; Mermaid diagrams retain their natural, scrollable size. It contains no palette, typography, hero, navigation layout or card design. Expressive Code retains its built-in high-contrast GitHub themes.

## Diagrams and tables

`src/diagrams.ts` draws Mermaid only where needed and redraws when `data-theme` changes. Diagrams scroll inside a named, keyboard-focusable region. Each source diagram supplies `accTitle` and `accDescr`. The architecture illustration is hidden at narrow widths where its embedded text is unreadable; the surrounding text and diagram remain.

Tables keep native HTML semantics and the theme's horizontal scrolling. Code in cells can wrap. `src/tables.ts` names tables from their preceding heading and makes only overflowing tables keyboard-focusable, including after a resize. The former custom mobile cards and duplicate column-label transformation are removed.

## API reference

The API introduction belongs to `docs/api-referens.md`; static operation pages come from `docs/api/openapi.json` through Starlight OpenAPI 0.26.3. They share the site's navigation, theme and local search. There is no request console or separate client framework.

The pinned OpenAPI plugin has no localization option. `scripts/localize-api.mjs` translates built UI labels before search indexing, preserving schema keys, code examples and authored Markdown. Development mode shows the upstream labels; preview the built site to check Swedish API labels. `src/content/i18n/sv.json` supplies missing Starlight and Pagefind labels. Remove the adapter when native API localization becomes available.

The package overrides keep `vitefu` on Astro's Vite 8 and replace HTTPSnippet's vulnerable `form-data` pin with 4.0.6. Recheck overrides when updating dependencies. Strict TypeScript uses exact optional properties to match the OpenAPI plugin's presence guards. Build before type checking so Astro has generated the content types.

## Verification

`npm test` proves content conversion and label preservation. `npm run build` validates internal links, assets and heading targets. `npm run typecheck` checks strict types. `npm run check` visits every built content and API page in light/dark at 390/1440 px, then tests real search results, keyboard navigation, menus at 320/390 px, touch targets, theme-menu focus and diagram redraws. Visual inspection uses captured viewport images. A passing axe run is not a complete WCAG conformance claim.
