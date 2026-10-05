# Agent instructions: eneo-mod-speech-to-text

Tal till text: an Eneo module. Next.js 16 serves the frontend and a FastAPI backend-for-frontend (BFF) sits behind it,
both in one image. Serving a static frontend from the BFF instead ("Plan B") is planned and not started.
Documentation for people is Swedish and lives in `docs/` (published as a site, `docs/index.md` is its start page). This file, `CLAUDE.md` and code
comments are English. Everything above the last section is permanent. The last section is migration-only and is cut
out when the Astryx port ends (bead `stt-plan-a-astryx-port-57a.24`).

## How to work here

1. Read before you edit. Find the owner of the behaviour (see "Where things live") and change it there; reuse or
   deepen existing code before adding a new path.
2. Run the checks that match your change (see "Checks") and say what you ran.
3. If your change alters something a doc page states, change that page in the same commit (see "Docs").

## UI rules (these override the generated block in `frontend/AGENTS.md` where they differ)

- Build UI from Astryx components. Run `npm run astryx -- build "<idea>"`, then `npm run astryx -- component <Name>`
  for every component, from `frontend/`. Never guess a prop.
- Do not use Tailwind utilities in new code. The generated block mentions `tailwind-theme.css`; it is not installed here.
- Do not use the shadcn skill or the shadcn MCP server.
- Bespoke surfaces that have no counterpart in the design system (transcript text with per-word spans, the level meter,
  the docked player) may use a CSS Module with Astryx tokens and semantic HTML. This is the one exception to "no <div>"
  and "no imported CSS" in the generated block. Do not rewrite those surfaces into components to satisfy the block.
- Do not author StyleX (`stylex.create`, `xstyle`) and do not run `astryx swizzle`.
- A design-system shortfall is fixed once in `frontend/kit/theme/eneo.theme.ts`, then `npm run theme:build`.
- Astryx is pinned to an exact version. Do not upgrade it in a feature change.
- Each route renders its own frame with `ModuleShell` (`frontend/kit/ModuleShell.tsx`). A page renders no `<main>` and no
  skip link of its own, and the shell is never put in `app/layout.tsx`. The shell holds no state.
- State that must survive a dialog closing lives above the dialog, never inside it.
- Overlays (dialog, alert dialog, menu, sheet): a dialog mounted once and opened by `isOpen`, as the component's docs show,
  and one mounted for each opening both leave nothing behind (`frontend/tests/e2e/leaks.spec.ts` proves each over 40
  openings; `frontend/app/dev/dialog-leak` is its fixture, with a dialog that really leaks to prove the spec can fail).
  A node count that follows a click on an overlay that was then removed is not the overlay's: Chromium keeps the element
  last under the pointer, and all that was removed with it (25 to 39 nodes for one dialog), until the pointer moves, so
  `leaks.spec` moves the pointer off after every close. Add each new overlay to `leaks.spec` as it is; a count that
  survives the pointer move is a real leak to find, and the slack is never raised.
- The hosted Astryx MCP documents the latest release. When it and `npm run astryx` disagree, the CLI is right.

## Product rules

- User-facing text is Swedish. Do not load fonts or scripts from other origins (the CSP forbids them).
- 44 px touch targets, a visible focus indicator, WCAG 2.2 AA: `npm run test:a11y` in `frontend/` is the proof.
- Never lower a gate threshold, delete a gate state or add an axe exclusion to get a green gate.
- Credentials never reach the browser: the service key, the module-user token, the login ticket and Eneo's signed file
  URLs stay in the backend. Do not put them in a response, in a URL the browser sees, or in a log.
- A new Eneo route for the browser needs a row in `_PROXY_ROUTE_RULES` (`backend/app/main.py`) and a test in
  `backend/tests/test_eneo_proxy_auth.py`. The proxy denies everything that is not listed.
- A new backend setting is read and validated in `backend/app/config.py`, with a test in `backend/tests/test_config.py`
  and a row in the settings table of `docs/backend.md`.

## Checks

Node `>=22.22.2` (`frontend/package.json` `engines`: react-router 8.4 needs 22.22, the unit tests' jsdom 30 needs 22.22.2).
From `frontend/`: `npm run lint`, `npm test`, `npm run test:a11y`, `npm run test:prod`, `npm run build`,
`npm run astryx -- doctor`; after a theme change `npm run theme:build` (CI fails if `kit/theme/built` differs); after a
branding or accent-colour change `npm run test:a11y:branding`.
From `backend/`: `.venv/bin/python -m unittest discover -s tests`.
From `docs-site/`, after a change to `docs/` or the site: `npm run build` and `npm run check`.
From the repository root: `docker compose --env-file .env.example config -q`.
What each proves and how to read a failure: `docs/quality-gates.md`.

Ports: the gate and `npm run dev:stub` use 3401 (app) and 8401 (stub); `npm run test:prod` uses 3411 to 3413 (its three backends) and 8411. Several
worktrees can run them at once on their own ports: `A11Y_APP_PORT` and `A11Y_STUB_PORT`. Next allows one dev server per
checkout, so stop your own `npm run dev` before the gate. Never `pkill -f`; stop only what you started, by PID or port.

## Where things live

| Path | What |
|---|---|
| `backend/app/` | The BFF: `main.py` (routes, proxy allowlist, uploads, file streaming, live relay), `module_auth.py` (login, sessions, refresh), `config.py` (settings), `accent.py` (the deployment's accent colour). |
| `backend/tests/` | `unittest`, one file per concern. |
| `frontend/app/` | Next.js routes. The root layout holds providers only. `app/dev/` are development-only pages. |
| `frontend/components/` | Screens and surfaces; `components/flow/` is the flow page. |
| `frontend/kit/` | Theme, providers and shell. Imports nothing from `app/`, `components/` or `lib/`. |
| `frontend/lib/` | Logic without UI, one owner per concern, with its tests beside it (unit and component tests both live here). Imports no UI code. |
| `frontend/tests/e2e/` | The accessibility gate. `screens.ts` lists every state it visits; `stub-server.py` stands in for the backend. |
| `frontend/tests/prod/` | The production tests (headers, routes, first paint, stale chunks, a recording while chunks are gone, upstream, branding), the smoke test and the weight budget. |
| `deploy/`, `Dockerfile`, `docker-compose*.yml` | The production image (supervisord) and Compose. |
| `.github/workflows/` | CI and publishing. |
| `docs/` | The documentation (Swedish). `docs/decisions/` holds the decisions. |
| `docs-site/` | The documentation site (VitePress) built from `docs/`; its own package, never part of the image. |

## How to find things

- Which Eneo routes may the browser reach: `_PROXY_ROUTE_RULES` in `backend/app/main.py`.
- Which settings exist: `backend/app/config.py`; all of them with values per environment: `docs/operations.md`.
- Who owns a piece of state or a rule: the first comment in the file in `frontend/lib/` ("The one owner of ..."), and
  "Var tillståndet bor" in `docs/frontend.md`.
- What states a screen has: `frontend/tests/e2e/screens.ts`, and `run.kind` in `frontend/app/flows/[id]/page.tsx`.
- What a test covers: `frontend/lib/<name>.test.ts` beside `<name>.ts`; backend `backend/tests/test_<area>.py`.
- The Swedish sentence a user reads for a failed request: `frontend/lib/errors.ts`.
- Colours, sizes, focus ring: `frontend/kit/theme/eneo.theme.ts`. The module's domain colours: `frontend/app/globals.css`.
  A deployment's own name, logo and accent: `docs/branding.md` (the one operator guide); the accent must reach 4,5:1.
- Why something is as it is: `docs/decisions/`. Words with a fixed meaning: "Begrepp" in `docs/architecture.md`.
- Use `rg` for exact strings and paths.

## What not to touch

- `frontend/AGENTS.md`: generated by the Astryx CLI; `npm run astryx -- upgrade` refreshes it.
- `frontend/kit/theme/built/`: generated by `npm run theme:build`. Never edit by hand.
- `frontend/tests/e2e/aria.spec.ts-snapshots/`: update only for the surface you changed, after reading the diff
  (`npm run test:a11y -- aria.spec.ts --update-snapshots -g "<state>"`).
- The line in `docs/development.md` that starts with `.venv/bin/python -m app.serve`: `backend/tests/test_live_relay.py`
  reads it and requires that every way of starting the backend goes through `app.serve`, which sets the WebSocket
  limits. Change both together.
- Lockfiles by hand, and the exact Astryx and StyleX pins.

## Docs

- Everything a person reads in `docs/` and `README.md` is Swedish; this file, `CLAUDE.md` and code comments are English.
- One fact in one place; link instead of repeating. Every claim about code carries a path, never a line number.
  Describe directories and conventions, not every file.
- Diagrams are Mermaid (`flowchart` and `sequenceDiagram` only, short quoted labels), each with one sentence above it.
- Write for the reader's next action. Lead each section with the fact, action or condition they need; say who does what;
  keep prerequisites, limits, uncertainty and how to recover.
- Cut filler: no praise without evidence, no sentence that restates its heading, no "in this section we go through". Make a
  generic claim concrete or delete it. "Sätt miljövariablerna på tjänsten och starta om den" beats "I detta avsnitt går vi
  igenom hur du konfigurerar modulen".
- Paragraphs explain, lists hold steps or parallel facts, tables compare. Keep the glossary's words ("Begrepp" in
  `docs/architecture.md`) and technical identifiers as they are. No emoji.
- A person reviews changed prose in the pull request. The build checks links, the browser check checks the rendered
  site; nothing checks authorship, so do not add a word blacklist or a length limit.
- Pages describe the module as it is: no history, no plans, no status tables, no `docs/plans/` or `.beads/` links.
- When the code and a page disagree, the code wins: fix the page.

## Migration (temporary, removed by bead .24)

The frontend is being ported from shadcn/Radix/Tailwind to Astryx. This section, the migration sections of `docs/`,
`.beads/` and `docs/plans/` exist only for the port. They are removed when it is done (bead
`stt-plan-a-astryx-port-57a.24`); do not build anything permanent on them.
Plan: `docs/plans/2026-10-01-astryx-port-plan.md`. Design: `docs/plans/2026-10-01-module-platform-design.md`.

- The old system (`frontend/components/ui/`, `components.json`, `tailwind.config.ts`, `postcss.config.mjs`, `lib/utils.ts`,
  Radix, Tailwind) is deleted. `frontend/lib/legacy-ui.test.ts` fails if an import of it or a class string comes back; it
  stays after the port.
- The surfaces allowed a CSS Module during the port are named in the plan's surface cards.
- A porting change does not touch `frontend/lib/` (except tests and `lib/test-dom.ts`), `backend/` or the CSP in
  `frontend/next.config.mjs`; domain logic is not part of the port.
- Work order and status live in Beads: `br ready --json`. The plan's checkboxes are a working aid, not the board.
- Branches: phases merge into the integration branch `feat/astryx`; it goes to `main` once, after the last phase.
- Cleanup checklist for bead `.24`: delete this section, `docs/plans/` and `.beads/`; cut every section headed
  `## Migration (temporary, removed by bead .24)` (find them with `rg -l "Migration \(temporary" docs`) and the
  "Migration" table in `docs/README.md`; then look for links that pointed into what was removed:
  `rg -n "docs/plans|\.beads" README.md docs`. Also update the places that name the port as in progress: the
  "Under arbete" row in the Status tables of `README.md` and `docs/architecture.md`, the Status line of
  `docs/decisions/0001-astryx-over-shadcn.md`, and the status column of `docs/README.md`.
