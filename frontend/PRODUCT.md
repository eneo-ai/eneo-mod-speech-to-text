# Product

## Platform

web (responsive: phone, tablet, laptop, wide desktop)

## Stack

React 19, Vite, react-router, Astryx 0.6.3 (pinned) with the module's theme `kit/theme/eneo.theme.ts`. CSS Modules with
Astryx tokens only for the bespoke surfaces (transcript text, level meter, docked player, the flow page's frame). No
Tailwind, no StyleX authoring. Served by the module's FastAPI backend under a strict CSP: no fonts or scripts from other
origins.

## Users

Municipal employees (Sundsvalls kommun and other Eneo deployments): secretaries, case officers and managers who record
meetings and interviews, or upload a recording, and need a transcript or a finished document (minutes, a report). Most
are not technical. They work on a laptop at a desk, on a phone in a meeting room, and sometimes on a tablet.

## Product Purpose

Tal till text is an Eneo module: the person records in the browser (Strömma, with live text, or Spela in) or uploads an
audio file (Ladda upp), and a flow published in Eneo turns it into text or a document. The person may review the
transcript and name the speakers before the flow continues, then reads, plays, copies and downloads the result.

## Operating Context

- A meeting is under way while the page records: the controls must be calm, obvious and hard to hit by mistake.
- A recording is the person's work: it is kept on the device until it is sent, and the page says so.
- Eneo owns users, flows, runs and files; the module has no accounts and no database.

## Capabilities and Constraints

- User-facing text is Swedish. The recorded text is called “Transkribering” in headings, tabs and help text.
- Every route renders its own frame with `ModuleShell`; overlays leave nothing behind.
- Weight budgets are tight (the flow page's JS and the flow list's CSS are near their limits).

## Brand Commitments

The deployment's own name, logo and accent colour (`docs/branding.md`); the accent must reach 4.5:1. The default is
Sundsvalls kommun with the Eneo blue.

## Product Principles

- One primary action per state, large and in reach (docked at the bottom on a phone).
- Say what happens to the person's audio and data, in plain Swedish, where they decide.
- Calm public-sector density: clear hierarchy and progressive disclosure, no decoration.

## Accessibility & Inclusion

WCAG 2.2 AA, 44 px touch targets on a coarse pointer, 24 px with a mouse, a visible focus ring, reflow at 320 px and
200 % zoom, text spacing, forced colours and reduced motion. `npm run test:a11y` in `frontend/` is the proof.
