# Eneo module platform: Astryx UI, one-process runtime, shared module kit

Design record, 2026-10-01. Status: proposed, not implemented. Nothing in the repository has been changed.

This document holds the decisions and their evidence. The work is split into three plans, each accepted on its own:

| Plan | What | Document |
|---|---|---|
| A | Port this module's UI from shadcn/Radix/Tailwind to Astryx, on the current Next.js app | `docs/plans/2026-10-01-astryx-port-plan.md` |
| B | Serve the UI as static files from the FastAPI BFF; remove the Next.js server and supervisord | section 7 here; its own plan when A is green |
| C | Build the starter in a new repository, `eneo-ai/eneo-module-kit`, and move this module onto it | section 8 here; planned and tracked in that repository, in parallel where section 8 allows |

A does not depend on B or C. Stop after A and the module is still better off.

---

## 1. Recommendation in short

1. **Port to Astryx.** A trial in a copy of the frontend passed this repository's own accessibility gate after three corrections made once, in the theme (section 3).
2. **One UI system at the end.** Astryx components and layout primitives, a built Eneo theme, and CSS Modules with Astryx tokens for the few bespoke surfaces. Tailwind, Radix, shadcn files, cva and tailwind-merge are deleted. next-themes stays: it owns the colour mode and is 2 kB.
3. **Migrate by surface, not by primitive.** One screen group per pull request, each accepted by the existing unit tests and the accessibility gate.
4. **Keep the BFF in FastAPI. Do not move to Hono.** The proxy hop and the second process come from Next.js, not from Python (section 7).
5. **Then remove the Next.js server.** A Vite single-page app served by the BFF is one process and one runtime, and it removes the upload and WebSocket proxy hop that `README.md` lists failures for. This is Plan B, a separate change.
6. **Build the starter in its own repository**, `eneo-ai/eneo-module-kit`: a UI package, a BFF package, and a template app in one repository. Modules import the packages and copy only the thin template.
7. **For AI agents: no custom MCP server and no skill yet.** A pinned local Astryx CLI, one `AGENTS.md`, and one module guide are the minimum that keeps agents coherent (section 9).

---

## 2. Where the module is today

- `frontend/`: Next.js 16.3 App Router, React 19.2, 26 local shadcn files in `components/ui/`, 16 `@radix-ui/*` packages, Tailwind 3.4, cva, tailwind-merge, next-themes, lucide-react. 719 `className=` uses outside `components/ui`.
- `backend/`: FastAPI BFF, 1,889 lines (`module_auth.py`, `main.py`, `config.py`) with 2,845 lines of tests. It owns the Eneo module contract: the `/module-login` handoff, the one-time ticket exchange, the server-side session, token refresh, and an allowlisted proxy that sends the service key and the module-user token on every call.
- One image, two processes under supervisord: the Next.js standalone server and uvicorn.
- Tests: 639 unit tests (`npm test`), 21 files of which render components in jsdom, and a Playwright accessibility gate (`npm run test:a11y`) of about 60 states in 19 projects: axe WCAG 2.2 AA, names from Chromium's accessibility tree, 24 px targets and 44 px under a coarse pointer, reflow at 320 px and 200 % zoom, text spacing, a rendered focus-indicator measurement, tab walks, ARIA snapshots. The gate is not in CI.

---

## 3. What was verified

All of this ran in scratch copies outside the repository.

| Question | Result |
|---|---|
| Does Astryx 0.6.3 build in this app beside Tailwind 3? | Yes. `next build --webpack` and `tsc` pass with `@layer reset, tw-preflight, astryx-base, astryx-theme;` imported first. Existing Tailwind and shadcn components keep working. |
| Does it run under the current CSP in production? | Yes. No console or CSP errors in Chromium 153 and WebKit 26.6. The built theme applies in the production build. |
| Does it pass the house accessibility gate? | A foundation page (AppShell, TopNav, DropdownMenu, Button, TextInput, Switch, Selector, Banner, Dialog, AlertDialog) passed in all 19 gate projects (320 px to 3440 px, light and dark, touch, 200 % zoom, forced colours, reduced motion) after the corrections below. |
| What did Astryx's defaults fail? | Three things. Touch: menu items and selector options are 36 px. Focus: inputs and selectors show focus only as a border-colour change, which the gate's 3:1 measurement rejects. Contrast: the white label on the dark-mode error fill is 3.76:1. All three are fixed in a 45-line theme. |
| Does the gate itself need to change? | One rule. It measured the 24 px inner `<input>` instead of the 44 px field box, which does forward a click to the input (checked with real mouse clicks in Chromium and WebKit). |
| Do the unit tests survive? | Yes, all of them (640 with the new ones), after three harness changes: a jsdom shim for `showModal` and the Popover API (jsdom 30 has neither, and Astryx `Dialog` throws without it), a path mapping so the CommonJS test compiler resolves Astryx subpaths, and a CSS require hook. |
| Is Swedish covered? | Yes. `@astryxdesign/core/locales/sv-SE.json` ships 370 strings; the skip link rendered as "Hoppa till innehåll". |
| Is the colour mode flash-free during coexistence? | Yes, with four lines of CSS. Astryx's theme root sets its own `color-scheme`, so with a stored choice that differs from the OS it painted the wrong mode for 3–5 frames. Making the root follow next-themes' class on `<html>` gave 0 wrong frames in all five stored/OS combinations. |
| Do native dialogs respect the signed-out cover? | **No.** A `<dialog>` opened with `showModal()` inside an `inert`, `visibility: hidden` ancestor is open, focusable and visible in both browsers. The cover needs a new contract (section 5, D6). |
| Can a shared kit teach the Astryx CLI about Eneo? | Yes. A trial integration package contributed a theme, a page template, a doc topic and an agent line; a consumer's `astryx build`, `astryx docs` and regenerated agent block all picked them up, and `astryx upgrade` flagged the agent block as stale after install. |

The foundation that produced these results is saved as `docs/plans/astryx-phase0-reference.patch` (26 files, applies cleanly to `main` at `f81a7dd`). Plan A starts by applying it.

Not verified: Firefox (not installed for this Playwright version), Safari 17/18 (Astryx's degraded tier), the full ~60-state gate on real screens, Docker builds with Astryx.

Two findings outside the port:

- `npm audit --omit=dev --audit-level=high` currently fails on `main`: `next` 16.3.4 has a critical advisory (GHSA-vcvr-r3jv-pc5j, `next/og`). The module does not use `next/og`, but the CI audit step will fail until `next` is bumped.
- The devcontainer pins Node 20; the Astryx CLI needs Node 22.13 or newer. CI and the Dockerfiles already use Node 22.

---

## 4. Astryx facts that shape the design

- `@astryxdesign/core` 0.6.3, MIT, **pre-1.0** and described as beta. Peer dependencies: React 19 and `@stylexjs/stylex` ^0.19. Components ship precompiled with one static `astryx.css` (30 kB gzipped) in cascade layers. No StyleX compiler is needed unless component source is ejected ("swizzled") or StyleX is authored.
- `@astryxdesign/cli` needs Node >= 22.13. Useful commands: `build "<idea>"` (returns the closest page template, blocks and components), `template`, `component`, `docs`, `search`, `theme build`, `theme targets`, `doctor` (CI-safe exit code), `upgrade` (codemods, and refreshes the agent block), `integration add|pack`.
- `astryx init --features agents` writes a managed block into `AGENTS.md`. It adapts to the project: with Tailwind present it tells agents to use Tailwind utilities through a bridge this project does not install, and it forbids `<div>` and imported CSS, which conflicts with CSS Modules on bespoke surfaces. A project-owned section must correct both.
- The hosted MCP server (`https://astryx.atmeta.com/mcp`, tools `search` and `get`) serves the latest published docs for core only. It does not know the installed version or local integration packages. The local CLI does.
- Only the `neutral` theme is marked maintained. A custom theme is a `defineTheme` file compiled by `astryx theme build` to static CSS and JS. `color.accent` generates a tonal palette from a seed, not the seed itself: `#004595` produced `#325BAF`, so the exact brand colour is set as explicit tokens.
- Themes name fonts but never load them, so no third-party font request is introduced.
- Browser tiers: full fidelity on Chrome/Edge 125+, Safari 26+, Firefox 147+. On Chrome 114+, Safari 17+, Firefox 125+ the layered surfaces (menus, selectors, tooltips, typeahead) open and dismiss but are not anchored to their trigger.
- `Dialog` renders a native `<dialog>` in place, with no portal. `purpose="required"` disables Escape and backdrop dismissal. It passes `role` and `aria-label` through. `AlertDialog` has a fixed shape: title, description, cancel, one action.
- `AppShell` renders the skip link and a `role="main"` region. Pages must not render their own `<main>`.

---

## 5. Decisions

Each decision names the option taken, the strongest alternative, and why.

**D1. End state: Astryx plus CSS Modules, no Tailwind.**
Alternative: upgrade to Tailwind 4 and keep it through Astryx's token bridge.
Why: Tailwind 4 would be a second migration and a second styling system in every future module. The bespoke surfaces (transcript text with per-word spans, level meter, docked player) are few and module-local. Tailwind 3 coexists during the port and is removed in its last phase.

**D2. Migrate by surface.**
Alternative: replace primitive by primitive and redo layout later.
Why: Astryx's value is the layout system as much as the controls, and its own migration guide says to move the frame first. Each surface pull request replaces primitives and layout together and is checked by the gate states for that surface. A ratchet test lists the files still on the old system; the list only shrinks.

**D3. Frame: `AppShell` with `TopNav`, page scroll, no side navigation.**
Why: two routes. `height="auto"` keeps the page as the scroller, which the reflow, zoom and docked-bar checks depend on.
Constraint from review: **the shell is presentational and rendered by each route**, as `AppHeader` and `FlowTopBar` are today. It holds no state and does not sit in the root layout. The flow page decides whether the account menu and the way back are shown, and its leave question guards them (`LeaveContext`). A persistent shell would bypass that.

**D4. Theme: one `eneo` theme, built to static files.**
Sundsvall blue `#004595` as the accent with explicit `on-accent`, neutral greys, the system font stack at 16 px, a coarse-pointer adaptation to 44 px, a focus ring on fields, and a readable dark-mode error label. Domain colours (recording red, six speaker colours) stay in the module as CSS variables until a second module needs them.

**D5. Colour mode: next-themes stays the single owner.**
It keeps its storage key and its pre-paint script. Four lines of CSS make the Astryx theme root follow its class. Nothing about the saved preference changes for users.
Alternative considered and dropped: a cookie read by the server layout. It also gave 0 wrong frames but needs a server read, a cookie writer and a migration of existing preferences.

**D6. Signed-out cover: a new contract for native dialogs.**
Today the page is made `inert` and invisible, and Radix overlays are portalled into that subtree so they are covered with it. A native modal dialog escapes both.
New contract:
1. The page stays mounted, `inert` and invisible, as today.
2. The sign-in dialog and the leave question become Astryx dialogs in the same pull request, so both are native and stack in opening order.
3. Any other dialog or menu the page owns is closed while signed out and reopened on renewal with its state kept. The state lives above the dialog, never inside it.
4. The sign-in dialog's backdrop is opaque.
5. Proof is behavioural, in a real browser: with the naming dialog open and an edit typed, end the login; nothing of the dialog is visible, focusable or in the accessibility tree; renew as the same user; the dialog and the edit are back. Also: expiry while the five-minute warning is open, Back after expiry, and Pausa/Stoppa reachable. The jsdom assertion on an inert ancestor stops being the proof.

**D7. Tests are the acceptance contract, adapted where they inspect implementation.**
Behaviour is kept; assertions on Radix attributes and Tailwind class names are rewritten to the semantic contract (section 6 of Plan A lists them). ARIA snapshots change only for a reviewed surface. Thresholds are not lowered.

**D8. No package boundary during the port.**
A plain folder `frontend/kit/` holds the theme and the providers. No `package.json`, no `file:` dependency. Review showed a local package would need Dockerfile changes and would freeze an API from one consumer.

**D9. Keep Next.js for the port.** The production trial found no Next-specific obstacle. Changing runtime and UI library at once would make failures hard to attribute.

**D10. Widget swaps are earned, not assumed.**
Astryx has `Typeahead`, `Tokenizer`, `FileInput`, `Markdown`, `Stepper`, `Toast`. A custom widget is replaced only when the existing tests for it pass against the Astryx component, because the names do not prove equal keyboard, paste, focus and announcement behaviour. Otherwise the widget keeps its logic and takes Astryx controls and tokens for its looks.

---

## 6. Target architecture

Three layers, each importing only downward:

```
module features     recording, live text, transcript editor, speaker review        (this repository)
module kit          theme, providers, shell, session screens · BFF auth and proxy   (eneo-module-kit, after Plan C)
Astryx · FastAPI    components, layout, tokens, CLI · HTTP server                   (vendors)
```

During Plan A the middle layer is the folder `frontend/kit/` and holds only the theme and providers. Nothing in `kit/` imports from `app/`, `components/` or `lib/`.

What "free" means with Astryx, and what it does not:

- Free: control behaviour and semantics, keyboard handling, focus management in overlays, dark mode, the responsive shell, Swedish strings for the system's own words, token-driven theming.
- Not free: the house bar above WCAG (44 px touch targets, measured focus indicators). These are met once, in the theme, and proven by the gate.
- Never free: bespoke surfaces. They keep their logic and their tests.

---

## 7. Runtime: Next.js, Vite and Hono

### The question

Should modules be forced onto Next.js, and would Hono make the module lighter and faster?

### Answer

**Use one paved road, not a framework-agnostic kit: a Vite + React static app served by the FastAPI BFF. Keep FastAPI. Do not adopt Hono now.**

### Why remove the Next.js server (Plan B)

- Every page is a client component behind `AuthGate`, except `/inloggad`, a small server page that parses a refusal code and sets metadata. The root layout is `force-dynamic` only to read branding per request. Server rendering buys this module almost nothing.
- Next's rewrite proxy sits in front of every API call, upload and WebSocket. `next.config.mjs` raises `proxyClientMaxBodySize` to 2 GB and `proxyTimeout` to 31 minutes and notes that Next holds the cloned upload body in memory. `README.md` lists three failures caused by this hop. FastAPI's own upload path spools to disk.
- The image runs two processes under supervisord and copies a Node binary into the Python image.
- The CSP keeps `script-src 'unsafe-inline'` because of Next's inline hydration bootstrap.

A static app served by the BFF is one process and one runtime in the image, has no proxy hop, and can drop inline script from the CSP.

Verified in a trial on 2026-10-01 for the kit's template: a Vite 8 build with Astryx 0.6.3 and the built Eneo theme, served by FastAPI, ran in Chromium and WebKit with no console or CSP errors under `script-src 'self'; style-src 'self'`, with no `unsafe-inline` at all. A deep link returned the page; a missing asset and an unknown `/api/*` path returned 404, not HTML.

### What Plan B must carry over, explicitly

Review found these are owned by Next or supervisord today and would be lost by a naive "serve the files with uvicorn":

- Security headers, the CSP, and the same-origin framing exception for PDF previews (`next.config.mjs`).
- `/health` routing, and port 3001.
- The WebSocket limits of 128 KiB per message and a queue of 16, which live in supervisord's uvicorn command line, with a test that all start-up paths agree.
- One backend replica: the session store is process-local.
- Routing: deep links to `/flows/<id>`, route titles and focus after navigation, state reset on route change, one navigation blocker reconciled with `lib/leave-guard.ts`.
- `/inloggad` with its refusal codes, and the renewal popup.
- `NEXT_PUBLIC_*` flags, the development proxy for API and WebSocket, the gate's web server, and the exclusion of development pages from production.
- Branding with no wrong municipality shown before initialisation, without an executable inline script.
- The single-page fallback must never answer a missing asset or an unknown `/api/*` path with HTML.

Plan B is accepted on the production image: health, deep links, 404s for missing assets and API paths, the renewal popup, PDF preview, upload cancellation, Range requests, WebSocket limits.

### Why not Hono

Hono can do everything the BFF does; it runs on Node and has a WebSocket helper. Its real advantage is a single language and a single package for UI and BFF, which matters for module authors.

Against it, here: the BFF is the security boundary and it is written and tested. A rewrite re-implements and re-verifies the state cookie and ticket exchange, single-flight token refresh, the path-traversal-safe allowlist, Range streaming and the WebSocket relay limits. Eneo's `eneo-js` client does not replace any of that. The saving in memory or image size has not been measured, and the cost that is visible today comes from Next, which Plan B removes without touching the BFF.

Revisit Hono only if module authors turn out to write substantial BFF logic per module and are TypeScript-only, or if image size, start-up or memory become a measured deployment constraint.

### Not forced, without being agnostic

The UI package imports nothing from Next or from a router. Links go through Astryx's `LinkProvider`; navigation is a callback. The BFF's HTTP surface (`/api/auth/*`, `/api/eneo/*`, `/api/branding`, `/api/config`, `/health`) is documented. Another frontend framework or another BFF implementation can be used later without changing the other half. The starter itself ships one stack.

---

## 8. The module starter: `eneo-ai/eneo-module-kit`

### Where it lives

A new repository in the `eneo-ai` organisation, one repository with three parts kept in step by one CI:

```
eneo-module-kit/
  packages/ui/     npm  @eneo-ai/module-kit   React + Astryx
  packages/bff/    PyPI eneo-module-bff       FastAPI
  template/        the smallest working module, built against the two packages on every commit
  docs/            the module contract with Eneo, and decisions
```

A new module starts by copying `template/` (`npx degit eneo-ai/eneo-module-kit/template eneo-mod-<name>`) and imports both packages. It does not copy package code. That is the same trade as shadcn versus Astryx, applied to the starter: auth fixes and UI fixes arrive as a version bump.

Alternative: two repositories, so the template can be a GitHub template repository. Better only if one-click "Use this template" matters more than keeping the template provably working against the packages.

### What is built in

**`packages/bff`** — the Eneo module contract, so a new module is connected from the first run:

- Configuration and start-up validation (`MODULE_KEY`, `ENEO_BACKEND_URL`, `ENEO_PUBLIC_URL`, `MODULE_PUBLIC_URL`, `ENEO_API_KEY`, header name, `SESSION_SECRET`, cookie settings).
- Login: state cookie, redirect to Eneo `/module-login`, callback, one-time ticket exchange with the bound service key, validation of the returned identity, renewal bound to the same user and tenant.
- Session: opaque cookie, server-side store, single-flight token refresh up to Eneo's ceiling, logout, `/api/auth/status`.
- Same-origin check for mutations and WebSocket handshakes.
- Transport primitives: a deny-by-default proxy that adds both credentials, multipart upload forwarding, signed-URL streaming with Range.
- Health, branding, security headers, static app serving.
- An application factory with lifespan-owned resources, in place of today's import-time globals in `main.py`.

**`packages/ui`**:

- The built Eneo theme and `ModuleProviders`.
- The presentational shell and brand lockup.
- The session client: the auth gate, the session-end warning, the signed-out cover, the sign-in and signed-in-again screens.
- Generic states: loading, problem, offline.
- An Astryx integration manifest that contributes the page templates, one doc topic (`astryx docs eneo-module`) and at most eight agent lines, so `astryx build` proposes Eneo's shell first.

**`template/`**: a `main.py` that creates the app and declares the module's own route allowlist, a Vite app with a sign-in page and one example page, Dockerfile, compose file, CI, devcontainer on Node 22 and Python 3.12, `AGENTS.md`, the accessibility gate wired to an example state list, and a stub Eneo for development.

### What stays out, deliberately

- **Each module's proxy allowlist.** Deny by default; the module names the Eneo routes it exposes.
- Speech-to-text's live transcription relay, recording identifiers and transcript routes. They implement one protocol, not a general WebSocket service.
- Draft retention, recovery copy, flow configuration, speaker colours.
- The access-code login mode. `README.md` already schedules it for removal; the starter is SSO-only.
- Upgrade codemods, and public `testing` and `a11y` exports, until a second module needs them.

### Seams the session client needs before it can leave this repository

- One session-state instance shared by the auth gate, request handling and uploads. `lib/api.ts` decides today which requests may be replayed after a new login (reads, and writes with an idempotency key); that rule moves with the session client or stays the single owner, never both.
- A hook the application implements for accepting an identity and cleaning drafts **before** children are revealed (`AuthGate.tsx` does this inline today).
- A generic slot for controls that stay reachable while signed out (today: the recording's Pausa and Stoppa), and a navigation callback. No imports of recording, drafts or a router.
- Renewal notification across tabs, wrong-user handling and ordered status answers kept as explicit contracts with their tests.

### Building the kit in parallel

The repository can be created now, and part of the kit can be built while this module is being ported:

| Part | Can start | Why |
|---|---|---|
| BFF package | Now | It is extracted from `backend/` with its tests and does not depend on the UI port. |
| Module contract docs, template skeleton (Vite app, `main.py`, Dockerfile, compose, CI, devcontainer, stub Eneo) | Now | Greenfield. It is also where the one-process shape of Plan B is proven without touching this module. |
| UI package: theme and providers | When Plan A's Phase 0 is on `main` | They are taken from `frontend/kit/`. |
| UI package: shell and session client | When Plan A's Phase 1 is merged | They need the seams below, and Phase 1 is where the native-dialog contract is proven. |
| Speech-to-text on the kit | After the Astryx port and static-runtime technical exits, and a released kit version; before first deployment | The kit's UI package assumes a static app (its colour mode reads the stored choice before React renders, with no server render), and the kit is SSO-only, so this module's temporary access-code login must be gone first. This adoption is what shows whether the kit's API fits. |

The kit has its own plan and its own Beads workspace in its repository (`docs/design.md`, `docs/plans/2026-10-01-module-kit-plan.md`, prefix `kit`). Nothing is moved out of this repository before the adoption step; until then the kit copies from here and this module stays the reference. Treat the kit's version as 0.x until that adoption is done.

The technical exits are the completed Astryx removal (`stt-plan-a-astryx-port-57a.23`) and static-runtime implementation/docs (`stt-plan-b-one-process-runtime-bbs.23`). Adoption precedes capacity admission, resumable uploads and the final security audit, which must finish before the first deployment. Owner preview checks, physical Safari verification, deployment approval and the incident-free week remain separate rollout requirements. Final scaffolding cleanup follows adoption and the audit.

### Distribution

Needs one owner decision: public or private. For public packages, npm for the UI and PyPI for the BFF, with no GitHub Packages (it needs a token even for public installs). Until the first PyPI release, a pip dependency pinned to a full commit with its subdirectory works.

### Honest limit

The template is carved from the same module, so it is a working fixture, not proof that the abstraction fits a different module. The kit's API should be treated as provisional until a second real module has used it.

---

## 9. AI tooling

The goal is that an agent in any module produces the same kind of UI without being corrected.

| Piece | Decision |
|---|---|
| Astryx CLI, pinned, with an `astryx` npm script | Yes. It is version-matched and knows installed integrations. It is the source of truth. |
| `AGENTS.md` | Yes. `frontend/AGENTS.md` holds the block Astryx manages; the root `AGENTS.md` holds the project's rules and the exceptions to that block. `CLAUDE.md` imports both. |
| Hosted Astryx MCP | Optional, for discovery. On any conflict the installed CLI wins, because the server documents the latest release. |
| A custom MCP server for modules | No. The kit's doc topic, templates and agent lines reach every agent through the CLI with no server to run. |
| A skill | Not now. A skill that only forwards to the guide adds a second place to maintain. Add one if agents are seen skipping the guide. |
| Browser checks | The Playwright gate is the deterministic proof. For interactive looks, one browser tool is enough: Playwright MCP, or Chrome DevTools MCP for performance traces. |
| Astryx in the browser without a build | `astryx template --cdn` writes a single HTML page pinned to the installed version. It replaces `design/prototyp.html` for quick visual trials. |

Two things an agent must be told in this repository, because the generated block says otherwise: do not use Tailwind utilities in migrated code, and CSS Modules with Astryx tokens are allowed on the named bespoke surfaces. Also: the `shadcn` skill and MCP do not apply here once `components.json` is gone.

---

## 10. Developer experience and end-user polish

In Plan A:

- `npm run dev:stub`: the stub backend and the app together, so screens are reachable without Eneo.
- `npm run state -- <name>`: open one named state from `tests/e2e/screens.ts` in a headed browser. The stub alone cannot reach every state; several need Playwright's request interception or clock.
- `SHOTS=1 npm run test:a11y -- a11y.spec.ts`: a screenshot per state and project, for review and pull requests. Screenshots are kept on failure.
- A production smoke test in Chromium, WebKit and Firefox against the built app.
- `astryx doctor`, a built-theme freshness check, and a small gate subset in CI.
- Exact version pins and a written upgrade and rollback routine for Astryx.
- The devcontainer on Node 22.

For users, where a surface is ported anyway:

- Field focus rings, 44 px touch rows in menus and pickers, and Swedish system strings, everywhere at once from the theme.
- Selectors and menus as bottom sheets on phones (`presentation="adaptive"`), if the gate passes them.
- Content width caps from `Layout`, so pages read well on ultrawide screens.
- Drag-and-drop upload through `FileInput`'s dropzone, if it passes the existing upload tests.

Deferred until asked for: command palette, toasts, resizable panes, a settings popover. They change behaviour, not just looks.

---

## 11. Risks and stop conditions

| Risk | Guard |
|---|---|
| Astryx is pre-1.0 | Exact pins for core and CLI. Upgrades are their own pull request: `astryx upgrade --from <old>`, rebuild the theme, full gate. Rollback is reverting that pull request. |
| Older browsers get unanchored menus | The supported floor is an owner decision (section 12). One check on a real Safari 17/18 device before Plan A's first release. |
| Native dialogs and the signed-out cover | Decision D6 and its browser test, in Phase 1. |
| Bespoke surfaces regress | They are ported last, keep their logic, and are covered by the existing tests. |
| A smaller model implements the plan | Phase 0 and Phase 1 are written step by step with verified code. Later surfaces start from a card and a kickoff step that writes the task list for review before code. |

**Stop adopting Astryx and keep the current system if any of these holds after Phase 1:**

- A supported browser fails sign-in, recording, sending or review.
- A session-protection check fails and cannot be fixed without copying Astryx internals.
- A foundation control needs a fork or an ejected copy of an Astryx component to meet the gate.
- A gate threshold would have to be lowered.

Ordinary theme corrections are not a stop condition.

---

## 12. Decisions needed from the owner

Defaults are what the plans assume if nothing is said.

| # | Question | Default |
|---|---|---|
| 1 | Supported browsers: is Astryx's full-fidelity tier (Chrome/Edge 125+, Safari 26+, Firefox 147+) the floor, with older Safari and Firefox working but with unanchored menus? | Yes. |
| 2 | Exact Sundsvall blue `#004595` as the accent, or Astryx's generated tone from it? | Exact. |
| 3 | Run a subset of the accessibility gate in CI (about 6–10 more minutes per run)? | Yes: two projects, all specs. |
| 4 | Accept Astryx's confirmation-dialog convention: Cancel takes focus, and the action button carries the emphasis? Today "Stanna kvar" is the filled button. | Yes. |
| 5 | Is the starter public (npm and PyPI) or private? | Public, like the module repositories. |
| 6 | Proceed to Plan B (remove the Next.js server) after Plan A? | Decide when A is green. |
| 7 | Ship ported screens one phase at a time, or all at once? Mixed releases would show old and new screens side by side. | All at once: phases merge into an integration branch `feat/astryx`, which goes to `main` after the last surface. Phase 0 is invisible and goes to `main` directly. |

---

## 13. Peer review record

Codex, GPT-6 Astra at `xhigh`, session `astryx-port-design`, two passes (design budget: one pass and one follow-up).

- Pass 1: `changes_required`, MIN_SCORE 6. Pass 2: `changes_required`, MIN_SCORE 7.
- Accepted and built into the plans: a compatibility phase before the broad port; the native-dialog contract; the presentational, route-owned shell; one colour-mode owner with a proven first-paint mechanism; no package boundary during the port; the list of tests coupled to Radix and Tailwind; the project-owned exception to the generated agent block; Node 22.13; the Plan B transfer checklist; a narrower kit; the session-client seams; keeping FastAPI; deferring bulk widget swaps; numeric acceptance criteria.
- Changed after review: the cookie-based colour mode was replaced by the four-line CSS bridge, which Codex suggested and the trial then proved.
- Kept despite review: a rule in the ratchet test against string-literal `className` in ported files. Codex asked to drop Tailwind-class detection as brittle; this rule does not detect Tailwind, it requires ported files to use component props or a CSS Module, which is what stops dead classes surviving Tailwind's removal.
- Open after review: Firefox and older Safari are unproven; the full ~60-state gate has not run on ported screens. Both are Phase 0 and Phase 1 exit checks.

Artifacts: `.codex/artifacts/codex-peer-loop-astryx-port-and-module-starter-design-*.md` (local, not committed).
