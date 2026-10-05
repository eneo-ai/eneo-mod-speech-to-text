# Product

<!-- impeccable:product-schema 1 -->

Inferred from the written brief for bead stt-tat and the repository. No interview took place; the owner's and lead's requirements are the confirmed facts, everything marked "assumed" is open to correction.

## Platform

web

## Stack

VitePress 1.6.4, default layout, in an isolated `docs-site/` package. Markdown and CSS variables; no Vue except one client-only wrapper for the API reference. Fixed by the brief.

## Users

- **A municipal employee** who records a meeting or uploads audio and wants text. They meet the module in their organisation's Eneo, not here. This site tells them, first, what the module is and what they get back. Assumed: they rarely read further.
- **An operator** who installs and configures the module with Dokploy or Portainer, and keeps it running.
- **A developer** who runs, changes or tests the module, or builds a module of their own on the same pattern.

## Product Purpose

The documentation of Tal till text, an Eneo module. The module records a conversation in the browser, or takes an uploaded audio file, and sends it to a published Eneo flow. The flow decides the result: a transcript, a summary or files. The site makes that clear before anything technical, then serves operators and developers.

## Positioning

This is the module's own documentation, not Eneo's. The module has no database and no login of its own: Eneo authenticates the user and stores everything.

## Operating Context

- Source of the pages is `docs/` (Swedish Markdown that must read the same on GitHub). The site adds navigation, search, rendered Mermaid diagrams and an API reference.
- Published to GitHub Pages under `/eneo-mod-speech-to-text/`. Built on pull requests, deployed from main.
- Everything is local: no CDN, no third-party font, script or search service.

## Capabilities and Constraints

- Swedish only (`sv-SE`).
- Required links: https://eneo.ai ("Läs mer om Eneo"), https://github.com/eneo-ai/eneo, https://github.com/eneo-ai, the module's repository, and a section "Är du också intresserad av att bygga moduler?" that links to https://github.com/eneo-ai/eneo-module-kit.
- The module kit repository's README says it is not built yet; the lead says the kit has code and the README is stale (a docs task for that repository). The start page says the kit is "under uppbyggnad" and that this module is the source it is taken from; keep that wording until the kit's README says otherwise.
- Speaker review of the transcript is a build-time option and a published image has it off; the start page must not promise it.
- Undecided: whether the site shows a mark besides the name (assumed: a small drawn mark, not the Sundsvall logo, because the logo is the default deployment's, not the module's).

## Brand Commitments

- The name is "Tal till text", as text.
- The module's own accent (`#004595` light, `#52B1FF` dark), system font stacks and focus ring, from `frontend/kit/theme/eneo.theme.ts`.
- Not the Sundsvall municipality logo.

## Evidence on Hand

- `docs/` pages, `docs/images/arkitektur-oversikt.webp` (illustration, provenance in its `.json`).
- No screenshots of the module, no user quotes, no usage numbers: none may be invented.

## Product Principles

- Say what the module is, for whom, and what comes back before any technical page.
- Say each fact once; the pages in `docs/` own the details, the start page links to them.
- Plain Swedish: concrete, short, no promotion.
- The site is documentation: reading comes first, restraint over expression.

## Accessibility & Inclusion

WCAG 2.2 AA, as for the module: visible focus, 44 px touch targets where controls are the site's own, contrast at 4.5:1, works with keyboard, at 390 px and with reduced motion.
