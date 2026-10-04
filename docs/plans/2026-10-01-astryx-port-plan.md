# Astryx Port Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the copied shadcn/Radix/Tailwind UI of `frontend/` with Astryx components, layout and a built Eneo theme, one screen group at a time, without losing any behaviour the unit tests and the accessibility gate prove today.

**Architecture:** Astryx and the old system coexist through explicit CSS cascade layers until the last phase. Each phase ports one surface (its primitives and its layout together), is accepted by the gate states of that surface, and shrinks a list of files still on the old system. `frontend/kit/` holds the theme and providers and imports nothing from the module.

**Tech stack:** Next.js 16.3 (webpack build), React 19.2, TypeScript 5.6, `@astryxdesign/core` 0.6.3, `@astryxdesign/cli` 0.6.3, `@stylexjs/stylex` 0.19.1 (peer only, nothing is authored in StyleX), next-themes 0.4.6, node:test with jsdom, Playwright 1.63.

**Work order and status:** Beads, in this repository only (`.beads/`, prefix `stt`). Run `br ready --json` for the next bead, claim it, and close it with evidence. Each bead names the part of this plan it covers, the files it may touch and what is out of scope. The checkboxes below are a working aid inside a task; they are not the board.

**Spec:** `docs/plans/2026-10-01-module-platform-design.md`. Read sections 3, 4, 5 and 11 before starting. Plans B and C in that document are out of scope here.

## Global Constraints

- Versions are exact: `@astryxdesign/core` `0.6.3`, `@astryxdesign/cli` `0.6.3`, `@stylexjs/stylex` `0.19.1`. No `^`. Do not upgrade them inside a porting pull request.
- Node `>=22.13.0` (the Astryx CLI requires it).
- Run the Astryx CLI only as `npm run astryx -- <command>` from `frontend/`. Never `npx @astryxdesign/cli`, which can resolve another version.
- Do not change anything under `frontend/lib/` except test files and `lib/test-dom.ts`, and nothing under `backend/`. Domain logic is not part of this port.
- Do not lower a gate threshold, delete a gate state, or add an axe exclusion. 44 px targets under `pointer: coarse`, 24 px otherwise, focus change of 3:1 or more, WCAG 2.2 AA.
- Do not eject ("swizzle") or copy an Astryx component, and do not author StyleX (`stylex.create`, `xstyle`). If a component cannot meet the gate through props or the theme, stop and report (see Stop conditions).
- Fix a design-system shortfall once, in `kit/theme/eneo.theme.ts`, never per call site.
- A ported file has no string-literal `className` and no import from `@/components/ui/`, `@radix-ui/*`, `class-variance-authority`, `tailwind-merge` or `@/lib/utils`. It styles through Astryx props, or through a CSS Module (`className={styles.name}`) that uses only Astryx tokens (`var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`). No hex colours and no pixel spacing in CSS Modules, except structural widths.
- CSS Modules are allowed only on the bespoke surfaces named in the surface cards. Everything else is Astryx components.
- `AppShell` renders the skip link and the `role="main"` region. A ported page renders no `<main>` and no skip link of its own.
- The shell is rendered by each route and holds no state. Do not put a shell in `app/layout.tsx`.
- All user-facing text stays Swedish and unchanged unless a step says otherwise. `lang="sv"` stays. Astryx's own words come from `sv-SE.json`.
- No third-party network request: no font link, no CDN. The CSP in `next.config.mjs` is not changed.
- State that must survive a dialog closing lives above the dialog, never inside it.
- ARIA snapshots are updated only for the surface being ported, and only after reading the diff: `npm run test:a11y -- aria.spec.ts --update-snapshots -g "<state>"`.
- **Latest versions (added 2026-10-01, the owner's instruction).** Every dependency and runtime that stays is on its latest release, except what is pinned on purpose (Astryx and StyleX: exact; `@types/node`: the Node runtime's own major). When you add a dependency, check its latest first (`npm view <package> version`) and use it; when a latest version breaks something, fix the code that the new version makes wrong, or, if that is a large change, stop and say so on the bead. Dependencies the port removes (Radix, Tailwind, cva, tailwind-merge, the typography plugin, autoprefixer, postcss) are not upgraded. Beads `.28` (frontend) and `.29` (runtimes) carry the update; `.26` carries the backend.
- **Performance and resource guards (added 2026-10-01, measured on a production build).** The port must not make the module slower or heavier than today, except transitionally while both UI systems are in the tree.
  - Baseline of `main` (+ `next` 16.3.8), compressed transfer, Chromium: `/flows` 226 KB JS + 15.6 KB CSS; `/flows/flow-1` 359 KB JS + 15.6 KB CSS. On a throttled phone (4x CPU, 1.6 Mbit/s, 150 ms): LCP 2.4 s on `/flows` and 2.8 s on `/flows/flow-1`, total blocking time 100–134 ms, JS heap 4–6 MB.
  - `tests/prod/weight.spec.ts` fails when a page's compressed JS + CSS exceeds `tests/prod/weight-budget.json`. A phase that raises the budget says why in its pull request. **Phase 8 sets the budget back to at most the baseline above.**
  - The built theme must be used: no `<style data-astryx-theme*>` element may exist after load (that is runtime style generation on every page load).
  - Every overlay (menu, picker, dialog, alert dialog, bottom sheet) must leave no DOM nodes or event listeners behind: `tests/e2e/leaks.spec.ts` opens and closes each 40 times and compares Chromium's DOM counters. A new overlay surface is added to that spec in the phase that ports it.
  - Nothing is loaded that the page does not use: a locale catalog, icon set or component is imported where it is used, not in a shared barrel. Check `weight.spec.ts` after adding an import from `@astryxdesign/core`.
  - Measure before and after a phase with `node docs/plans/page-cost.cjs <frontend dir> <base url> <label>` (needs the production build served with the stub: see Task 0.6, Step 1) and put the table in the pull request.
- One phase is one pull request. The app is deployable after each. Commit after every task. Push or open a pull request only when the owner asks.
- Branches: Phase 0 goes to `main`. Phases 1–7 go to the integration branch `feat/astryx` so users never see half-ported screens; it is merged to `main` once, after Phase 7. Merge `main` into it at the start of every phase.

## Review Focus

Conditions the tests do not all exercise and that are most likely to hurt a user:

1. **A dialog of the page is open when the login ends.** Expected: nothing of it is visible, focusable or in the accessibility tree; after the same person signs in again it is back with its edit. Pinned by `tests/e2e/session-cover.spec.ts` (added in Phase 0); every phase that ports a dialog must keep it green.
2. **A stored colour mode that differs from the system's.** Expected: no frame in the other mode. Pinned by `tests/e2e/color-mode.spec.ts`.
3. **A phone at 320 px, or 200 % zoom, with long Swedish words and long flow names.** Expected: no horizontal scroll, nothing cut off, no clamped heading. The gate's reflow and text-spacing checks cover it per state; check every new layout at `phone-320-light` and `zoom-200` before the full gate.
4. **An ultrawide screen.** Expected: forms and prose keep a readable width. A `VStack` stretches its children to full width (a button became 3408 px wide in the trial). Every page caps its content with `Layout contentWidth` and aligns actions with `hAlign="start"` or a `HStack`.
5. **A browser without CSS anchor positioning (Safari 17–25, Firefox below 147).** Expected: menus and pickers open, work and close, even if not placed beside their trigger. Not covered by automation; checked by hand once per release on a real device.

---

## How to work

### The loop for every screen

1. `npm run astryx -- build "<what the screen is>"` — the closest template, blocks and components.
2. `npm run astryx -- template <name> --skeleton` — study the frame it proposes.
3. `npm run astryx -- component <Name>` — read props and examples for **every** component before using it. Do not guess a prop. Add `--dense` for a short form.
4. `npm run astryx -- docs layout` once per phase.
5. Write the failing test or adapt the coupled one, port, run the checks below.

The hosted Astryx MCP server (`search`, `get`) may be used to discover components. It documents the latest release; when it disagrees with `npm run astryx`, the CLI is right.

### Checks, fastest first

| Command (from `frontend/`) | What it proves | When |
|---|---|---|
| `npm run lint` | Types | after every edit |
| `npm test` | 640 unit tests, including the list of files still on the old system | after every task |
| `npm run test:a11y -- a11y.spec.ts -g "<state>" --project=phone-320-light --project=laptop-1440-dark` | One state, narrowest and dark | while porting it |
| `npm run test:a11y -- -g "<state>"` | One state in all 19 projects, all specs | before finishing a task |
| `npm run test:a11y` | The whole gate | once after Phase 1 is merged, and once after the last phase is merged (not at every phase exit) |
| `npm run test:prod` | The production build in Chromium, WebKit and Firefox | before finishing a phase |
| `npm run build` | The production build | before finishing a phase |

Stop your own `npm run dev` before the gate: Next allows one dev server per checkout.

**Running phases in parallel (added 2026-10-01).** Each phase works in its own git worktree (`git worktree add -b feat/astryx-phase-N ../eneo-mod-stt-phase-N feat/astryx`) and runs the gate on its own pair of ports: `A11Y_APP_PORT=34N1 A11Y_STUB_PORT=84N1 npm run test:a11y -- ...` (phase 2 → 3421/8421, phase 3 → 3431/8431, and so on; `npm run test:prod` reads the same two variables (defaults 3411/8411), so give it the same pair). While porting, run only the phase's own states; the whole gate runs once at the phase exit. Never kill a process you did not start, and never use `pkill -f`: stop by the PID you saved or by your own port. The lead merges phase branches into `feat/astryx` one at a time; `tests/legacy-ui-files.json` and ARIA snapshots are the only files two phases can both touch, and the merge of those is mechanical.

### Looking at a screen

- `npm run dev:stub` starts the stub backend and the app on `http://127.0.0.1:3401` with no Eneo needed.
- `npm run state -- "<state>"` opens one state from `tests/e2e/screens.ts` in a headed browser. Some states need Playwright's request interception or clock, so a plain URL cannot reach them.
- `SHOTS=1 npm run test:a11y -- a11y.spec.ts -g "<state>" --project=phone-390-light --project=laptop-1440-dark` writes `test-results/shots/<project>/<state>.png`. Read the images. Attach before and after to the pull request.
- For interactive checks use the Playwright MCP tools (`browser_navigate`, `browser_resize`, `browser_snapshot`, `browser_take_screenshot`, `browser_console_messages`) against `npm run dev:stub`. Look at 320, 390, 768, 1280 and 1920 px, in light and dark.
- `npm run astryx -- template --cdn <file>.html` writes a single page that loads Astryx without a build, for trying a layout idea outside the app.

### Stop conditions

Stop, leave the branch as it is, and report to the owner if any of these happens:

- A supported browser fails sign-in, recording, sending or review.
- `tests/e2e/session-cover.spec.ts` cannot be kept green without copying Astryx internals.
- A control needs an ejected or forked Astryx component to meet the gate.
- A gate threshold would have to be lowered, or a gate state removed.
- An Astryx component's behaviour differs from the widget it replaces and an existing test for that widget fails for a reason that is a real behaviour change (see "Widget swaps" below).

A theme correction is not a stop condition. Record every theme correction in the pull request description with the gate finding that caused it.

### Widget swaps

Astryx has `Typeahead`, `Tokenizer`, `FileInput`, `Markdown`, `Stepper`, `Toast`. Replace a custom widget with one of them only when the widget's existing unit and gate tests pass against the Astryx component after adapting selectors only. If a test fails on behaviour (paste, blur, keyboard, announcements, parsing), keep the widget's logic and give it Astryx controls and tokens for its looks. Say which path was taken in the pull request.

---

## File structure

Created in Phase 0 (all under `frontend/` unless a path starts at the repository root):

| File | Responsibility |
|---|---|
| `app/layers.css` | The cascade-layer order. Imported first, in a file of its own, because webpack hoists imports. |
| `kit/theme/eneo.theme.ts` | The Eneo theme source: accent, type, touch sizes, field focus ring, error label. The only place design-system shortfalls are corrected. |
| `kit/theme/built/eneo.{css,js,d.ts}` | Generated by `npm run theme:build`. Committed. Never edited by hand. In its own folder, because beside the source the bundler would resolve the `.ts` and silently use runtime styles. |
| `kit/ModuleProviders.tsx` | Theme and Swedish catalog for every page. |
| `app/dev/foundation/` | One page with the design system's parts beside the old ones. The gate, the colour-mode test and the production smoke test use it. |
| `lib/design-system.test.ts` | Proves the unit-test document can host the design system. |
| `lib/legacy-ui.test.ts`, `tests/legacy-ui-files.json` | The list of files still on the old system. It only shrinks. |
| `tests/e2e/color-mode.spec.ts` | No frame in the wrong colour mode. |
| `tests/e2e/session-cover.spec.ts` | The signed-out cover, as a person meets it. |
| `tests/prod/smoke.spec.ts`, `playwright.prod.config.ts` | The production build in three engines. |
| `AGENTS.md`, `CLAUDE.md` (repository root), `frontend/AGENTS.md` | Agent instructions. |

Created later: `kit/ModuleShell.tsx` (Phase 1), CSS Modules beside the bespoke components (Phases 4 and 7).

Deleted in Phase 8: `components/ui/`, `components.json`, `tailwind.config.ts`, `postcss.config.mjs`, `lib/utils.ts`, the Tailwind and shadcn parts of `app/globals.css`.

---

## Phase 0 — Foundation

Result: Astryx is installed, themed and proven beside the old system. No screen a user sees changes.

Everything in Tasks 0.1–0.3 was built and run in a copy of the frontend on 2026-10-01. The result is saved as `docs/plans/astryx-phase0-reference.patch` (26 files, applies cleanly to `main` at `f81a7dd`).

### Task 0.1: Branch, patch, dependencies

**Files:** the 26 files in `docs/plans/astryx-phase0-reference.patch`; `frontend/package-lock.json`.

- [ ] **Step 1: Confirm the starting point**

```bash
git switch main && git pull && git switch -c feat/astryx-foundation
cd frontend && npm ci && npm run lint && npm test
```

Expected: `lint` exits 0; `npm test` ends with `# fail 0`.

If `npm audit --omit=dev --audit-level=high` reports `next` (GHSA-vcvr-r3jv-pc5j), that is a separate pull request (`npm audit fix`), not part of this plan. Tell the owner.

- [ ] **Step 2: Apply the reference patch**

```bash
cd .. && git apply --check docs/plans/astryx-phase0-reference.patch && git apply docs/plans/astryx-phase0-reference.patch
```

Expected: no output. If `--check` fails because `main` has moved, apply file by file and resolve by hand; the patch is plain unified diff.

- [ ] **Step 3: Install the pinned packages**

```bash
cd frontend
npm install --save-exact @astryxdesign/core@0.6.3 @stylexjs/stylex@0.19.1
npm install --save-dev --save-exact @astryxdesign/cli@0.6.3
npm run astryx -- doctor
```

Expected: `package.json` is unchanged by the install (the patch already lists the three packages); `package-lock.json` changes. `doctor` ends with `0 failures`.

- [ ] **Step 4: Rebuild the theme and confirm it is unchanged**

```bash
npm run theme:build && git status --short kit/theme/built
```

Expected: three `✓` lines, and no modified file under `kit/theme/built` (the build is deterministic).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ui): add the Astryx foundation beside the current UI"
```

### Task 0.2: Understand what was added

Read each file once. Later phases depend on these facts.

| File | What to notice |
|---|---|
| `app/layers.css` | One line: `@layer reset, tw-preflight, astryx-base, astryx-theme;`. Unlayered CSS beats every layer; a later layer beats an earlier one, whatever the specificity. |
| `app/layout.tsx` | Import order: `layers.css`, Astryx `reset.css`, `astryx.css`, the built theme, then `globals.css`. `ModuleProviders` sits inside next-themes' provider. |
| `app/globals.css` | `@tailwind base` is wrapped in `@layer tw-preflight`, so Tailwind's reset cannot flatten Astryx. At the end, four unlayered lines make the Astryx theme root follow next-themes' class on `<html>`. |
| `kit/theme/eneo.theme.ts` | `color.accent` only seeds a tonal palette, so the exact blue is pinned in `tokens`. `components` gives fields a focus ring. `adaptations` raises controls, menu items and options to 44 px under a coarse pointer. `--color-on-error` fixes a 3.76:1 label in dark mode. |
| `kit/ModuleProviders.tsx` | `mode="system"` always. The colour mode is next-themes'. Do not add mode state here. |
| `lib/test-dom.ts` | jsdom has no `showModal` and no Popover API. The shim opens and closes as attributes and events. Modality and anchoring are not simulated; they are the browser's and are proved in `tests/e2e`. |
| `tests/register.cjs` | A CSS import in a test is a proxy of its class names. An `@/` import falls back from `.test-build` to the source tree for generated modules. |
| `tsconfig.test.json` | `paths` for `@astryxdesign/core/*`: the test compiler uses classic module resolution and cannot read the package's `exports`. A new Astryx subpath that is not under `dist/<Name>` needs a line here. |
| `tests/e2e/checks.ts` | Two changes. A field's box counts as the target of the control it activates, for Astryx's field classes only. A target inside an open modal dialog is measured even under an `inert` ancestor. Both have self-tests in `harness.spec.ts`. |
| `lib/legacy-ui.test.ts` | Fails when a file not in `tests/legacy-ui-files.json` uses the old system, and when a listed file no longer does. After porting a file, remove it from the JSON. Never add one. |

### Task 0.3: Verify the foundation

- [ ] **Step 1: Unit tests**

Run: `npm run lint && npm test`
Expected: `# tests 640`, `# fail 0`.

- [ ] **Step 2: The gate on the foundation page, its self-tests, colour mode and the cover**

Run:

```bash
npm run test:a11y -- harness.spec.ts color-mode.spec.ts session-cover.spec.ts
npm run test:a11y -- a11y.spec.ts -g "foundation"
```

Expected: no failures. The first command runs 9 self-tests, 4 colour-mode tests and 4 cover tests (others are skipped by project). The second runs 5 states in 19 projects: `95 passed`.

- [ ] **Step 3: The whole gate, to prove nothing else moved**

Run: `npm run test:a11y`
Expected: no failures, and no change under `tests/e2e/aria.spec.ts-snapshots/`.

- [ ] **Step 4: The production build in three engines**

```bash
npx playwright install firefox webkit
npm run test:prod
```

Expected: `6 passed` (two tests in Chromium, WebKit and Firefox). Chromium and WebKit passed in the trial; Firefox was not installed there. A Firefox failure is a finding to report, not something to skip.

### Task 0.4: Toolchain and agent instructions

**Files:**
- Modify: `.devcontainer/devcontainer.json`
- Create: `frontend/AGENTS.md` (generated), `AGENTS.md`, `CLAUDE.md`

- [ ] **Step 1: Node 22 in the devcontainer**

In `.devcontainer/devcontainer.json` change the Node feature's `"version": "20"` to `"version": "22"`.

- [ ] **Step 2: Generate the block Astryx manages**

```bash
cd frontend && npm run astryx -- init --features agents
```

Expected: `✓ AI agent docs installed → AGENTS.md`. The file `frontend/AGENTS.md` now has a block between `<!-- ASTRYX:START -->` and `<!-- ASTRYX:END -->`. Do not edit inside it. (The CLI refuses a path outside `frontend/`.)

- [ ] **Step 3: Write the project's own rules**

Create `AGENTS.md` in the repository root:

```markdown
# Agent instructions: eneo-mod-speech-to-text

The frontend is being ported from shadcn/Radix/Tailwind to Astryx.
Plan: `docs/plans/2026-10-01-astryx-port-plan.md`. Design: `docs/plans/2026-10-01-module-platform-design.md`.

## UI rules (these override the generated block in `frontend/AGENTS.md` where they differ)

- Build UI from Astryx components. Run `npm run astryx -- build "<idea>"`, then `npm run astryx -- component <Name>`
  for every component, from `frontend/`. Never guess a prop.
- Do not use Tailwind utilities in new or ported code. The generated block mentions `tailwind-theme.css`; it is not
  installed here and Tailwind is being removed.
- Do not use the shadcn skill, the shadcn MCP server or `components/ui/` for new work.
- Bespoke surfaces listed in the plan may use a CSS Module with Astryx tokens and semantic HTML. This is the one
  exception to "no <div>" and "no imported CSS" in the generated block. Do not rewrite those surfaces into
  components to satisfy the block.
- Do not author StyleX (`stylex.create`, `xstyle`) and do not run `astryx swizzle`.
- A design-system shortfall is fixed once in `frontend/kit/theme/eneo.theme.ts`, then `npm run theme:build`.
- Astryx is pinned to an exact version. Do not upgrade it in a feature change.
- The hosted Astryx MCP documents the latest release. When it and `npm run astryx` disagree, the CLI is right.

## Product rules

- User-facing text is Swedish. Do not load fonts or scripts from other origins.
- 44 px touch targets, a visible focus indicator, WCAG 2.2 AA: `npm run test:a11y` in `frontend/` is the proof.
- `tests/legacy-ui-files.json` lists files still on the old UI system. Remove a file when it is ported. Never add one.

## Checks

From `frontend/`: `npm run lint`, `npm test`, `npm run test:a11y`, `npm run test:prod`, `npm run build`.
From `backend/`: `.venv/bin/python -m unittest discover -s tests`.
```

Create `CLAUDE.md` in the repository root:

```markdown
@AGENTS.md
@frontend/AGENTS.md
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: Node 22 in the devcontainer and agent instructions for the Astryx port"
```

### Task 0.5: CI

**Files:** Modify `.github/workflows/ci.yml`.

- [ ] **Step 1: Add the checks to the `frontend` job**, after "Check frontend types":

```yaml
      - name: Check the design system setup
        run: npm run astryx -- doctor
      - name: Check the built theme is current
        run: npm run theme:build && git diff --exit-code -- kit/theme/built
```

- [ ] **Step 2: Add a job for the browser checks** (owner decision 3 in the design document; skip this step if the owner said no):

```yaml
  frontend-browser:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npx playwright install --with-deps chromium webkit firefox
      - name: Production build in three engines
        run: npm run test:prod
      - name: Accessibility gate, one phone and one laptop
        run: npx playwright test --project=phone-390-light --project=laptop-1440-light --workers=2
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: frontend-browser-results
          path: frontend/test-results
```

- [ ] **Step 3: Commit.** `git commit -am "ci: check the design system, the built theme and the browser gate"`

### Task 0.6: Performance and resource guards

**Files:**
- Create: `frontend/tests/prod/weight.spec.ts`, `frontend/tests/prod/weight-budget.json`, `frontend/tests/e2e/leaks.spec.ts`
- Modify: `frontend/playwright.prod.config.ts` (nothing if the new spec is picked up by its `testDir`), `frontend/app/dev/foundation/FoundationCheck.tsx` only if an overlay is missing from it.

**Interfaces — Produces:** `weight-budget.json` is `{ "/flows": { "jsKB": number, "cssKB": number }, "/flows/flow-1": { ... } }`, compressed transfer sizes in KB (1 KB = 1024 B).

- [ ] **Step 1: Measure first.** From `frontend/`, with the production build running against the stub (`npm run test:prod` starts it on 3411/8411; or build with `INTERNAL_API_BASE=http://127.0.0.1:8411` and `npx next start -p 3411` — the rewrite target is baked in at build time, a build without it shows "Kunde inte kontakta modulen" and is not a valid measurement), run a Playwright script that loads `/flows` and `/flows/flow-1` in Chromium and sums `await request.sizes()` → `responseBodySize + responseHeadersSize` for `script` and `stylesheet` requests. Write the numbers for the foundation branch next to the baseline in the Task's pull request text.
- [ ] **Step 2: `weight.spec.ts`** (Chromium project only): the same measurement as a test; it fails when a page is above `weight-budget.json`; the message names the page, the number, the budget and says "raise the budget only with a reason in the pull request; Phase 8 returns it to the 2026-10-01 baseline". Initial budget = the foundation numbers rounded up to the next 5 KB.
- [ ] **Step 3: The built theme is used.** In the same spec: after `/flows` has loaded, `page.locator("style[data-astryx-theme], style[data-astryx-theme-prose], style[data-astryx-theme-base]")` has count 0. Prove it can fail: temporarily import the unbuilt theme in `kit/ModuleProviders.tsx`, see the test fail, revert.
- [ ] **Step 4: `leaks.spec.ts`** (project `laptop-1440-light` only; Chromium): on `/dev/foundation`, record `Memory.getDOMCounters` (`nodes`, `jsEventListeners`) through a CDP session after one warm-up open/close of each overlay and a forced GC (`HeapProfiler.collectGarbage`); then open and close, 40 times each, the account menu, the speaker picker, the dialog and the alert dialog; collect garbage again; expect `nodes` and `jsEventListeners` each within +20 of the warm-up values and `performance.memory.usedJSHeapSize` within +1.5 MB (launch Chromium with `--enable-precise-memory-info`). If a number is off, find the leak (a listener added in an effect without cleanup, a portal not removed) and report it as a finding; never raise the slack to pass.
- [ ] **Step 5: Run** `npm run test:prod` and `npm run test:a11y -- leaks.spec.ts --project=laptop-1440-light`. Expected: all pass.
- [ ] **Step 6: Commit.** `test(perf): a page-weight budget, a built-theme check and an overlay leak test`

### Phase 0 exit

All of these hold, with no threshold changed:

| Area | Required |
|---|---|
| Build | `npm run build` and `npm run lint` pass. 0 hydration, console or CSP errors in `npm run test:prod`. |
| Browsers | `npm run test:prod` passes in Chromium, WebKit and Firefox. |
| Accessibility | The foundation states pass in all 19 projects. The whole gate passes with unchanged snapshots. |
| Theme | `color-mode.spec.ts` passes: 0 frames in the wrong mode. `test:prod` sees accent `rgb(0, 69, 149)`. |
| Cover | `session-cover.spec.ts` passes. |
| Maintenance | No ejected component, no StyleX, no changed threshold. |
| Cost | `weight.spec.ts`, `leaks.spec.ts` and the no-runtime-theme check pass; the Phase 0 numbers (Task 0.6) are in the pull request next to the baseline. |

Then open the pull request for Phase 0 to `main` when the owner asks. Ask the owner to try sign-in and one menu on a Safari 17 or 18 device against a preview of this branch's foundation page, and record the result in the pull request.

---

## Phase 1 — Frame, sign-in, account menu, session dialogs

Result: the sign-in page, the flow list's frame, the account menu, the session warning and the leave question are Astryx. Branch `feat/astryx` from `main` after Phase 0 is merged; work on `feat/astryx-phase-1` and merge into `feat/astryx`.

Gate states for this phase: `signin-sso`, `signin-access-code`, `signin-error`, `signin-loading`, `page-loading`, `signed-in-again`, `account-menu`, `session-warning`, `signed-out`, `signed-out-recording`, `signed-out-leave`, `leave-dialog`.

Verified in the trial and safe to copy: `AppShell` with `height="auto"`, `contentPadding`, `mobileNav={false}`, `topNav`; `TopNav` with `label`, `heading`, `endContent`; `DropdownMenu` with `button={{label}}` and `items`; `Dialog` with `isOpen`, `onOpenChange`, `purpose="required"`, `role="alertdialog"`, `aria-label`; `AlertDialog` with `title`, `description`, `actionLabel`, `cancelLabel`, `onAction`; `Button` with `label`, `variant`, `size`, `onClick`; `TextInput`, `Switch`, `Selector`, `Banner`, `Card`, `VStack`, `Heading`, `Text`. Everything else in this phase must be checked with `npm run astryx -- component <Name>` first.

### Task 1.1: The presentational shell

**Files:**
- Create: `frontend/kit/ModuleShell.tsx`
- Test: `frontend/lib/design-system.test.ts`

**Interfaces:**
- Produces: `ModuleShell({ label, heading, end, banner, children })` where `label: string` names the navigation landmark, `heading: ReactNode` is the brand or the page's top-bar content, `end?: ReactNode` is the account menu or what replaces it, `banner?: ReactNode` is a page-wide notice.

- [ ] **Step 1: Write the failing test** — append to `lib/design-system.test.ts`:

```ts
test("the shell gives a page its skip link, its navigation landmark and one main region", async () => {
  const { ModuleShell } = await import("@/kit/ModuleShell");
  const { ModuleProviders } = await import("@/kit/ModuleProviders");
  const { ThemeProvider } = await import("next-themes");
  const view = await mount(
    createElement(ThemeProvider, {
      attribute: "class",
      children: createElement(ModuleProviders, {
        children: createElement(ModuleShell, { label: "Tal till text", heading: "Tal till text", end: "Konto", children: "Sidan" }),
      }),
    }),
  );
  assert.equal(view.container.querySelectorAll('[role="main"], main').length, 1, "one main region");
  assert.ok(view.container.querySelector('nav[aria-label="Tal till text"]'), "a named navigation landmark");
  assert.match(view.container.textContent ?? "", /Hoppa till innehåll/);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test 2>&1 | grep -E "ModuleShell|# fail"`
Expected: a compile error, `Cannot find module '@/kit/ModuleShell'`.

- [ ] **Step 3: Implement**

```tsx
"use client";

import type { ReactNode } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav } from "@astryxdesign/core/TopNav";

/**
 * A page's frame: the top bar, the skip link and the main region. It holds no state and decides nothing: the route
 * that renders it says what the bar shows, so a page that must not be left (a recording, a sending) leaves the
 * account and the way back out.
 */
export function ModuleShell({
  label,
  heading,
  end,
  banner,
  children,
}: {
  /** The navigation landmark's name. */
  label: string;
  /** The brand, or on a flow's page the way back and the flow's name. */
  heading: ReactNode;
  /** The account menu, or what a page shows in its place. */
  end?: ReactNode;
  /** A notice for the whole page, above the bar. */
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppShell height="auto" mobileNav={false} contentPadding={4} banner={banner} topNav={<TopNav label={label} heading={heading} endContent={end} />}>
      {children}
    </AppShell>
  );
}
```

- [ ] **Step 4: Run it and see it pass.** `npm test 2>&1 | grep -E "^# (pass|fail)"` → `# fail 0`.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(ui): a presentational page shell on AppShell"`

### Task 1.2: Sign-in page

**Files:**
- Modify: `frontend/app/LoginPage.tsx`, `frontend/components/Brand.tsx`, `frontend/components/AppHeader.tsx`
- Modify: `frontend/tests/legacy-ui-files.json` (remove the three files)
- Snapshots: `signin-access-code-390.aria.yml`, `signin-access-code-1440.aria.yml`

**Interfaces:**
- Consumes: `ModuleShell` from Task 1.1.
- Produces: `AppHeader({ onLeave, account, linked })` keeps its props and renders nothing but the `heading` and `end` content for a `ModuleShell`. Export two pieces from `components/AppHeader.tsx`: `HeaderBrand({ onLeave, linked })` and the existing `AccountMenu` use. `FlowTopBar` keeps using the old `AppHeader` markup until Phase 3, so keep the old export under the name `LegacyAppHeader` for it.

Mapping:

| Today | Astryx |
|---|---|
| `<AppHeader account={false} />` + `<main className={FRAME…}>` | `<ModuleShell label="Tal till text" heading={<HeaderBrand linked={false} />}>` |
| `READING` width | `Layout` with `contentWidth={640}` and `LayoutContent` (read `npm run astryx -- component Layout`) |
| `<h1 className="…">` | `<Heading level={1}>` |
| `<p className="text-ink-soft">` | `<Text color="secondary">` |
| `<p role="alert" className="text-destructive">` | `<Banner status="error" title={authError} collapsible={false} />` only if it renders `role="alert"` and the `signin-error` state still finds it; otherwise keep a `<Text>` in an element with `role="alert"` |
| `<Button>` with a spinner child | `<Button label="Logga in med Eneo" variant="primary" isLoading={submitting} />`. The label while loading was "Öppnar Eneo…"; pass that as `label` while `submitting`. |
| `<Label>` + `<Input type="password">` | `<TextInput type="password" label="Åtkomstkod" autoComplete="current-password" isRequired hasAutoFocus value={accessCode} onChange={setAccessCode} status={authError ? { type: "error", message: authError } : undefined} />` |
| checking state: `<main>` + `<Spinner>` | `<ModuleShell …>` with `<Spinner label="Tal till text" />` centred, and a visually hidden `<Heading level={1}>` (see `VisuallyHidden`) |
| `Brand`'s `dark:invert`, `dark:hidden` | A CSS Module is not needed: use two rules in `app/globals.css` keyed on `html.dark`, or `light-dark()`. Keep the `<img>` elements and their `alt`. |

Things to verify with the CLI before coding, and what to do if absent:

- `TextInput` and `maxLength={256}`: check "Rest Props" in `npm run astryx -- docs styling`. If the attribute is not forwarded, validate length in `submitAccessCode` and keep the backend's limit as the authority.
- `TextInput` and giving focus back after a refused code (today a `ref`): if no ref is exposed, focus the field by its label after the failure: `document.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')?.focus()`.
- `isRequired` shows a "required" mark; if `sv-SE.json`'s wording reads badly, override that one key through `InternationalizationProvider`'s `overrides` in `kit/ModuleProviders.tsx`.

- [ ] **Step 1:** Run the coupled tests first and note they pass: `npm run test:a11y -- -g "signin" --project=phone-390-light --project=laptop-1440-light`.
- [ ] **Step 2:** Port `Brand.tsx`, then `AppHeader.tsx`, then `LoginPage.tsx` following the mapping. Remove the three files from `tests/legacy-ui-files.json`.
- [ ] **Step 3:** `npm run lint && npm test`. Expected: `# fail 0`. If `legacy-ui.test.ts` says a file is still on the old system, a `className="…"` or an old import is left in it.
- [ ] **Step 4:** `npm run test:a11y -- -g "signin"`. Fix findings in the page or, for a design-system default, in the theme. Coupled tests that will need new selectors, not new behaviour: `keyboard.spec.ts` "a wrong access code is said, and focus stays in the field to type it again"; `names.spec.ts` "the access code can be filled in by a password manager".
- [ ] **Step 5:** Read the ARIA snapshot diff for `signin-access-code` at both widths, then update those two snapshots only.
- [ ] **Step 6:** Screenshots: `SHOTS=1 npm run test:a11y -- a11y.spec.ts -g "signin" --project=phone-320-light --project=phone-390-dark --project=laptop-1440-light --project=ultrawide-3440-light`. Read all of them. The form must not stretch across the ultrawide screen.
- [ ] **Step 7: Commit.** `git commit -am "feat(ui): the sign-in page on Astryx"`

### Task 1.3: Account menu

**Files:** Modify `frontend/components/AccountMenu.tsx`, `frontend/tests/legacy-ui-files.json`.

Behaviour to keep, each proved by an existing test:

- The trigger is named `Öppna konto för <namn>` (state `account-menu`, and `keyboard.spec.ts` "the account menu holds focus and gives it back").
- The menu is not modal: the page behind it is not hidden from assistive technology.
- Theme choice: Ljust, Mörkt, System as one radio group, disabled until the stored choice is known. It calls next-themes' `setTheme`. Do not move the choice anywhere else.
- "Logga ut" goes through `leaveFirst` from `LeaveContext`, shows "Loggar ut…" while it runs, and is not closed-and-forgotten if the leave question is asked.
- The name, and the e-mail when it differs, are shown at the top and are not menu items.

Read `npm run astryx -- component DropdownMenu` (the full form, not `--dense`), `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuItem`, `Avatar`. Use the compound form (`children`) with `DropdownMenuRadioGroup label="Tema"`. For the trigger use `button={{ label: \`Öppna konto för ${displayName}\`, isIconOnly: true, variant: "ghost", icon: <Avatar name={displayName} size="md" tooltip={false} /> }}` and `hasChevron={false}`, `alignment="end"`. If the compound form has no place for a non-interactive name block, put the name in the group's section title using the `items` form with a section; if neither can show it, stop and ask the owner whether the name may move into the trigger's tooltip.

- [ ] **Step 1:** Port the file. Remove it from `tests/legacy-ui-files.json`.
- [ ] **Step 2:** `npm run lint && npm test`.
- [ ] **Step 3:** `npm run test:a11y -- -g "account"` and `npm run test:a11y -- keyboard.spec.ts -g "account menu"`.
- [ ] **Step 4:** Check by hand with `npm run state -- "account-menu"`: choose Mörkt, reload, the page is dark from its first paint.
- [ ] **Step 5: Commit.** `git commit -am "feat(ui): the account menu on Astryx"`

### Task 1.4: The session warning and the sign-in dialog

**Files:**
- Modify: `frontend/components/SessionEndWarning.tsx`, `frontend/tests/legacy-ui-files.json`
- Create: `frontend/components/SessionEndWarning.module.css`
- Test: `frontend/lib/signed-out.test.ts`, `frontend/tests/e2e/keyboard.spec.ts`, snapshot `signed-out-recording-{390,1440}.aria.yml`

This is one dialog with two faces. Keep every sentence in it as it is.

| Today (Radix `AlertDialog`) | Astryx |
|---|---|
| `open={open \|\| signedOut}` | `<Dialog isOpen={open \|\| signedOut} onOpenChange={setOpen} role="alertdialog" purpose={signedOut ? "required" : "info"}>` |
| Title, focused when signed out | `DialogHeader` with `title`; it takes focus on open and names the dialog. Pass `onOpenChange` to it only while `!ended`, so the close button exists only on the warning. |
| Description | `Text` inside the dialog body. Link it with `aria-describedby` on `Dialog` so the dialog keeps its description. |
| `{signedOut && <div ref={controlsRef} />}` | The same `div`, inside the dialog. The recording's controls are portalled into it as today. |
| Access-code form | `TextInput type="password"` as in Task 1.2, in a `<form>` with the same `id` |
| Footer buttons with `className="h-11"` | `Button` with `size="lg"`; no height class. The footer is a `Layout` footer or an `HStack` at the end. |
| `onCloseAutoFocus` → `returnFocus` / `onFocusBack` | Astryx gives focus back to what had it. Keep `onFocusBack` for the signed-out case: call it when the dialog has closed after a new login. Check with the keyboard tests below; do not assume. |

The backdrop while signed out must hide the page completely. Create `SessionEndWarning.module.css`:

```css
/* Signed out, nothing of the page shows through, also a dialog the page had open (it sits in the top layer too). */
.signedOut::backdrop {
  background: var(--color-background-body);
}
```

Apply it with `className={signedOut ? styles.signedOut : undefined}` on `Dialog`. If `Dialog` does not pass `className` to the `<dialog>` element, check `npm run astryx -- docs styling` ("className and style Props"); if it cannot be reached, put the rule in `app/globals.css` keyed on a `data-signed-out` attribute the component sets on the dialog through its rest props.

- [ ] **Step 1:** Confirm the starting point: `npm run test:a11y -- session-cover.spec.ts keyboard.spec.ts -g "sign-in dialog|warning|covered|already open"`. Expected: all pass.
- [ ] **Step 2:** Adapt `lib/signed-out.test.ts`. Around line 179 it finds the sign-in dialog by `[role="dialog"]` and proves exclusion by an inert ancestor. Change the selector to `[role="alertdialog"]`, and keep the inert-ancestor assertion as a structural check of the page cover only. The proof of exclusion is `tests/e2e/session-cover.spec.ts`.
- [ ] **Step 3:** Port the component following the table. Remove it from `tests/legacy-ui-files.json`.
- [ ] **Step 4:** `npm run lint && npm test`.
- [ ] **Step 5:** `npm run test:a11y -- session-cover.spec.ts`. Expected: 4 passed. This is the gate for this task.
- [ ] **Step 6:** `npm run test:a11y -- -g "session-warning|signed-out"` and `npm run test:a11y -- keyboard.spec.ts names.spec.ts -g "sign-in dialog|warning before the login ends|login's end|renewal|access code, the warning"`. One accepted change: the warning used to put focus on "Stäng"; Astryx puts it on the title. Change that expectation in `keyboard.spec.ts` "the warning before the login ends takes focus, holds it, and gives it back on Escape" and say so in the pull request.
- [ ] **Step 7:** Read and update the `signed-out-recording` snapshots.
- [ ] **Step 8: Commit.** `git commit -am "feat(ui): the session warning and sign-in dialog on Astryx"`

### Task 1.5: The leave question

**Files:** Modify `frontend/components/flow/useLeaveQuestion.tsx`, `frontend/lib/interactions.test.ts`, `frontend/tests/legacy-ui-files.json`.

It must be ported in the same pull request as Task 1.4: opened after the sign-in dialog (Back after the login ended), it must sit above it, and a Radix portal cannot rise above a native modal dialog.

```tsx
<AlertDialog
  isOpen={leave !== null}
  onOpenChange={(open) => !open && setLeave(null)}
  title="Lämna sidan?"
  description={warning}
  cancelLabel="Stanna kvar"
  actionLabel="Lämna sidan"
  onAction={() => leave?.()}
/>
```

- Delete the `PortalContainer.Provider value={null}` wrapper around it: a native dialog needs no portal.
- Astryx's convention replaces the old one (owner decision 4): "Stanna kvar" takes focus when the dialog opens, and "Lämna sidan" is the emphasised action. In `lib/interactions.test.ts` around line 454, replace the two `bg-primary` class assertions with: the dialog has `role="alertdialog"`, "Stanna kvar" is the focused element, and both buttons exist.
- Focus goes back to where it was when the question closes. `keyboard.spec.ts` "the leave question holds focus and gives it back" proves it; if Astryx does not restore it because the question has no trigger, keep the `returnFocus` ref and focus it when `isOpen` turns false.

- [ ] **Step 1:** Change the two assertions in `lib/interactions.test.ts` and run `npm test`. Expected: that test fails (the old dialog has the old classes).
- [ ] **Step 2:** Port. Remove the file from `tests/legacy-ui-files.json`.
- [ ] **Step 3:** `npm run lint && npm test`. Expected: `# fail 0`.
- [ ] **Step 4:** `npm run test:a11y -- -g "leave-dialog|signed-out-leave"` and `npm run test:a11y -- keyboard.spec.ts -g "leave question"` and `npm run test:a11y -- session-cover.spec.ts`.
- [ ] **Step 5:** Read and update the `leave-dialog` snapshots.
- [ ] **Step 6: Commit.** `git commit -am "feat(ui): the leave question on Astryx"`

### Task 1.6: Loading states and the signed-in-again page

**Files:** Modify `frontend/components/AuthGate.tsx` (the loading return only), `frontend/app/inloggad/SignedInAgain.tsx`, `frontend/tests/legacy-ui-files.json`.

- `AuthGate`'s loading return: `ModuleShell` with a centred `Spinner` and a visually hidden level-1 heading "Tal till text". `names.spec.ts` "a page that is still loading says so, under the page's heading" and the states `page-loading` and `signin-loading` prove it. `screens.ts` `loading()` waits for `main svg`; if the spinner is not an `svg` inside the main region, change that helper to wait for `getByRole("status")` or the spinner's accessible name, and say so in the pull request.
- Leave `SignedOutCover`, `PortalContainer` and all effects in `AuthGate.tsx` untouched. `PortalContainer` is still needed by the Radix dialogs of later phases.
- `SignedInAgain`: `ModuleShell`-free, a `Layout` with `contentWidth={640}`, `Heading level={1}`, `Text`. It is a popup window and has no account menu.

- [ ] **Step 1:** Port both. Update `tests/legacy-ui-files.json`.
- [ ] **Step 2:** `npm run lint && npm test && npm run test:a11y -- -g "loading|signed-in-again"` and `npm run test:a11y -- names.spec.ts -g "still loading|renewal"`.
- [ ] **Step 3: Commit.** `git commit -am "feat(ui): loading states and the signed-in-again page on Astryx"`

### Phase 1 exit

- [ ] `npm run lint && npm test && npm run build`
- [ ] The Phase 1 gate states in all 19 projects (the list in the Phase 1 header), then the whole gate once on the merged Phase 1 branch.
- [ ] `npm run test:prod`
- [ ] Screenshots of every Phase 1 state at `phone-320-light`, `phone-390-dark`, `laptop-1440-light`, `ultrawide-3440-light`, read and attached.
- [ ] The pull request description lists: theme corrections made, tests whose expectation changed and why, accepted behaviour changes.
- [ ] Review the stop conditions. If one holds, stop here.

---

## Phases 2–7 — Surface cards

Each phase starts with a **kickoff** and ends with the same exit as Phase 1.

**Kickoff (do this before any code in a phase):**

1. Merge `main` into `feat/astryx`; branch `feat/astryx-phase-N`.
2. Run the phase's gate states and unit tests; they must pass before you start.
3. For each screen in the card run the loop in "How to work" and read every component you will use.
4. Write the phase's task list into the pull request description in the form of Phase 1's tasks: files, mapping table, behaviour to keep with the test that proves it, coupled tests to adapt, snapshots to update. Ask for review of that list before porting. (With `superpowers:subagent-driven-development`, this list is the first task and its reviewer's gate.)

### Phase 2 — Flow list

| | |
|---|---|
| Files | `app/flows/FlowsPage.tsx`, `components/FlowList.tsx`, `components/UnsentRecordings.tsx`, `components/flow/ProblemAlert.tsx`, `components/RetryNotice.tsx`, `components/OfflineBanner.tsx` |
| Old parts | `item`, `skeleton`, `alert`, `button` |
| Gate states | `flow-list`, `flow-list-error`, `unsent-recordings`, `page-loading` |
| Unit tests | `flow-list.test.ts`, `unsent-recordings.test.ts` (line 114 counts `bg-primary`: assert `data-variant="primary"` on exactly one button instead), `errors.test.ts` |
| Frame | `ModuleShell` + `Layout` (`contentWidth={960}`); heading "Välj ett flöde" as `Heading level={1}` |
| Mapping | Flow rows: `List` with link items, one `Section` per space with a level-2 heading; rows, not a card per flow. Loading: `Skeleton`. Problem: `Banner status="error"` with the retry `Button` as `endContent`. Empty: `EmptyState` with the existing sentence. Offline notice: `ModuleShell`'s `banner` slot. |
| Keep | The flow last used comes first. Long names wrap and are never clamped. The whole row is one link named by the flow. `role="status"` "Laddar flödena…". |
| Bespoke | none |

### Phase 3 — The flow page's frame and setup

| | |
|---|---|
| Files | `components/flow/FlowTopBar.tsx`, `FlowRunPage.tsx`, `FlowAside.tsx`, `FlowPageStates.tsx`, `StateCard.tsx`, `BackToFlows.tsx`, `FlowInput.tsx`, `ModeCards.tsx`, `DetailsForm.tsx`, `ParticipantsInput.tsx`, `MicrophoneCheck.tsx`, `UploadPanel.tsx`, `ClassificationNote.tsx`, `EarlierRuns.tsx`, `components/frame.tsx`; delete `LegacyAppHeader` |
| Old parts | `field`, `input`, `label`, `textarea`, `select`, `switch`, `radio-group`, `input-group`, `badge`, `collapsible`, `item`, `skeleton`, `alert`, `button` |
| Gate states | `setup`, `setup-participants`, `setup-microphone-check`, `setup-count-from-names`, `setup-count-invalid`, `upload-chosen-file`, `setup-required-detail`, `setup-own-count-invalid`, `setup-republished`, `unsent-on-setup`, `flow-gone`, `flow-republish-required` |
| Unit tests | `setup-view.test.ts` (lines 190–193 require a combobox **button** and reject a visible native select: keep "labelled, one choice, keyboard operable", accept Astryx's `Selector`), `interactions.test.ts`, `participants.test.ts`, `upload.test.ts`, `earlier-runs.test.ts` |
| Frame | `ModuleShell` whose `heading` is, below the `lg` breakpoint, the way back plus the flow's name, and from `lg` the brand. `end` is the account menu unless the view passes `trailing` or is `locked`. The two-column page (details 320 px, working card the rest) is a `Layout` with a `start` panel or a `Grid`, whichever the docs support without a JavaScript breakpoint: `useMediaQuery` is false on the first render and would shift the layout. If neither can, a small CSS Module for this two-column frame is allowed. |
| Keep | `FlowTopBar`'s rules: `locked` shows no way off the page; `trailing` replaces the account menu; links ask the leave question. The input modes are one tab stop moved by arrow keys (`keyboard.spec.ts`, two tests). The docked primary action on phones stays inside the main region and never covers the focused control (`names.spec.ts` "docked primary action", and `scroll-padding-bottom` in `globals.css`). Participant paste and blur rules. "Antal talare" keeps what was typed and reports a letter as an error. |
| Widget swaps to try | `ModeCards` → `RadioList` or `SelectableCard` in a radio group; `ParticipantsInput` → `Tokenizer`; `UploadPanel` → `FileInput mode="dropzone"`; "Antal talare" → `NumberInput`; microphone picker → `Selector presentation="adaptive"`. Each only under the "Widget swaps" rule. |
| Bespoke | none |

### Phase 4 — Recording, live text, ready

| | |
|---|---|
| Files | `components/flow/Recorder.tsx`, `LevelMeter.tsx`, `LiveSheet.tsx`, `ReadyPanel.tsx`, `AudioPlayer.tsx` |
| Old parts | `button`, `slider`, `alert-dialog`, `spinner` |
| Gate states | `recording`, `recording-paused`, `recording-details-open`, `stromma`, `ready`, `ready-delete-dialog`, `time-left-15`, `time-left-5`, `too-long-for-one-file`, `silent-microphone`, `disk-full`, `microphone-muted`, `signed-out-recording` |
| Unit tests | `recording-view.test.ts`, `ready-view.test.ts` (line 84 reads `bg-primary`), `live-audio.test.ts`, `playback.test.ts`, `interactions.test.ts` |
| Keep | Pausa and Stoppa ignore a second tap for 700 ms. The live region says each status once and never the ticking timer (`aria.spec.ts`). The controls move into the sign-in dialog when the login ends. The pulse and blink stop under reduced motion. The delete question holds focus and gives it back. |
| Gate change | `checks.ts` line 92 finds a slider's track through Radix's `data-orientation`. When `AudioPlayer` moves to Astryx `Slider`, find the track through `.astryx-slider-track` instead and add a `harness.spec.ts` case for it. |
| Bespoke (CSS Modules allowed) | `LevelMeter` (the meter's bars), the recording pulse and blink (move `lyssna-pulse-ring`, `lyssna-blink` from `globals.css` into `Recorder.module.css`), the docked recording bar. Colour for "recording": define `--module-color-record` once in `app/globals.css` for light and dark with `light-dark()`, values from today's `--record`. |

### Phase 5 — Sending, progress, failure

| | |
|---|---|
| Files | `components/flow/SubmittingView.tsx`, `RunProgress.tsx`, `StepList.tsx`, `StepDetails.tsx`, `RunFailure.tsx` |
| Old parts | `button`, `alert`, `alert-dialog`, `collapsible`, `skeleton`, `spinner` |
| Gate states | `sending`, `run-progress`, `run-started`, `failure` |
| Unit tests | `run-views.test.ts` (lines 199, 200, 316, 317 read `bg-primary` and `text-ink-soft`: assert one `data-variant="primary"` action and that the description exists), `run-progress.test.ts`, `submit-run.test.ts` |
| Keep | The sending view is a page with a heading that takes focus, a named progress bar and a spoken stage (`names.spec.ts`). The cancel question holds focus and gives it back. Eneo's English words on the failure view keep `lang="en"`. |
| Widget swaps to try | Upload progress → `ProgressBar`; step list → `Stepper` only if it can say "waiting for you" for a review step as today. |
| Bespoke | none |

### Phase 6 — Result

| | |
|---|---|
| Files | `components/flow/RunResult.tsx`, `ResultDocument.tsx`, `ResultFiles.tsx`, `RunTranscript.tsx`, `CopyButton.tsx`, `RegenerateNotice.tsx` |
| Old parts | `button`, `tabs`, `dialog`, `dropdown-menu`, `item`, `skeleton`, `alert` |
| Gate states | `result`, `result-steps-open`, `result-pdf-dialog`, `result-transcript-tab`, `result-docked-player`, `result-regenerate`, `result-pdf-preview-whole`, `result-without-transcript` |
| Unit tests | `result-document.test.ts` (lines 34, 126, 235), `regenerate.test.ts`, `run-files.test.ts`, `run-result.test.ts` |
| Keep | The PDF preview holds focus, never traps it in the browser's viewer, and Escape closes it from the dialog's own controls (`keyboard.spec.ts`). Below a laptop's width the PDF opens in a new tab and says so. The tabs are real tabs with `aria-selected`. Result headings are normalised so the page outline stays valid. |
| Markdown | Today: react-markdown + remark-gfm + Tailwind's typography plugin. Try Astryx `Markdown` with `headingLevelStart` under the "Widget swaps" rule; `result-document.test.ts` decides. If it does not pass, keep react-markdown and style it with a CSS Module using Astryx tokens. Either way the typography plugin goes in Phase 8. |
| Cover | The PDF dialog is a page dialog: it must be closed while signed out and reopened after (design decision D6). Add a case to `session-cover.spec.ts` for it. |
| Bespoke | none |

### Phase 7 — Review, speaker naming, transcript player and editor

| | |
|---|---|
| Files | `components/flow/ReviewView.tsx`, `components/SpeakerNamingDialog.tsx`, `components/NameCombobox.tsx`, `components/TranscriptPlayer.tsx`, `components/TranscriptEditor.tsx`, `app/dev/speaker-review/ReviewFixtures.tsx` |
| Old parts | `button`, `dialog`, `popover`, `collapsible`, `input-group`, `radio-group`, `select`, `separator`, `skeleton`, `toggle-group`, `toggle`, `alert` |
| Gate states | `review`, `naming-dialog`, `review-reject`, `review-text-edit`, `review-din-version` |
| Unit tests | `speaker-naming.test.ts` (dialog selectors; line 277 requires the name list outside the field's box: keep "not clipped, associated with its field", a top-layer surface needs no portal), `transcript-interactions.test.ts` (lines 41, 87, 132, 141 read button radios, `data-state`, `data-orientation`: assert the selected state through `aria-checked`/`aria-pressed`), `speaker-review.test.ts`, `speaker-review-v3.test.ts`, `transcript-player.test.ts`, `transcript-selection.test.ts`, `review-busy.test.ts`, `accessibility.test.ts` |
| Keep | Everything `README.md` "Granska transkriptet" describes: selection by mouse and by Shift with arrows, Bekräfta, Lyssna, click a word to move playback, Rätta text, Ångra, Återställ talare, Nästa. Corrections save per change and say so from their first word (`names.spec.ts`). The naming dialog holds focus, gives it back, and saving then continuing is one action. |
| Cover | `SpeakerNamingDialog` becomes a native dialog. It must close while signed out and reopen with its typed names. Its field state already has to live above the dialog for that; if it lives inside, lift it first, in its own commit. `session-cover.spec.ts` (first test) is the gate. |
| Bespoke (CSS Modules allowed) | `TranscriptPlayer` and `TranscriptEditor`: the text, per-word spans, selection marks, the sticky toolbar's position, the docked player. Move the `.transcript-*` rules from `app/globals.css` into `TranscriptPlayer.module.css` and `TranscriptEditor.module.css`. Keep the semantic HTML and all `data-*` attributes the tests and scroll logic use. Controls inside them (buttons, pickers, toggles, the slider) are Astryx. Speaker colours: `--module-speaker-0` … `-5` in `app/globals.css` with `light-dark()`, values from today's `--speaker-*`. |
| Theme test | `lib/accessibility.test.ts` parses `globals.css` for HSL tokens and shadcn's button classes. Rewrite it to read resolved values from the built theme: `resolveThemeTokens(eneoTheme, {mode})` from `@astryxdesign/core/theme/tokens` for text, accent, border and error pairs, and the `--module-*` variables for the recording and speaker colours. Keep every contrast ratio it asserts today, and "the first speaker is not the brand's blue". Replace the button-size test with one that reads `--size-element-*` from the built theme's coarse-pointer rule and expects 44 px. |
| Order inside the phase | `ReviewView` and the naming dialog first, then `NameCombobox`, then the player, then the editor. One commit each. |

After Phase 7: merge `main` into `feat/astryx`, run the full exit, and open the pull request from `feat/astryx` to `main` when the owner asks.

---

## Phase 8 — Remove the old system

Precondition: `tests/legacy-ui-files.json` is `[]` except `app/dev/foundation/FoundationCheck.tsx`.

- [ ] **Step 1:** In `FoundationCheck.tsx` remove the legacy button and the Tailwind paragraph; replace the cover trigger with an Astryx `Button`. Set `tests/legacy-ui-files.json` to `[]`.
- [ ] **Step 2:** Delete `components/ui/`, `components.json`, `tailwind.config.ts`, `postcss.config.mjs`, `lib/utils.ts`, `components/frame.tsx` if unused.
- [ ] **Step 3:** Uninstall:

```bash
npm uninstall @radix-ui/react-alert-dialog @radix-ui/react-avatar @radix-ui/react-collapsible @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-label @radix-ui/react-popover @radix-ui/react-radio-group @radix-ui/react-select @radix-ui/react-separator @radix-ui/react-slider @radix-ui/react-slot @radix-ui/react-switch @radix-ui/react-tabs @radix-ui/react-toggle @radix-ui/react-toggle-group class-variance-authority clsx tailwind-merge tailwindcss @tailwindcss/typography autoprefixer postcss
```

Keep `next-themes` and `lucide-react`. Remove `react-markdown` and `remark-gfm` only if Phase 6 moved to Astryx `Markdown`. Then `rg "clsx|tailwind-merge|class-variance-authority|@radix-ui" app components lib kit` must print nothing.

- [ ] **Step 4:** `app/globals.css`: remove the three `@tailwind` lines, the `@layer base` and `@layer components` blocks and the shadcn token block. Keep: the colour-mode bridge, the `--module-*` variables, `scroll-padding` rules, reduced-motion and forced-colours rules that still have a target. `app/layers.css` becomes `@layer reset, astryx-base, astryx-theme;`.
- [ ] **Step 5:** `app/layout.tsx`: remove the `app-shell` wrapper `div`. In `tests/e2e/aria.spec.ts` change the four regions that use `page.locator(".app-shell")` to `page.locator("body")`, then read and update those snapshots.
- [ ] **Step 6:** Remove `PortalContainer` (`components/ui/portal-container.ts` is gone) from `AuthGate.tsx`; `SignedOutCover` keeps `inert` and the invisible class as a CSS Module rule.
- [ ] **Step 7:** Refresh the agent block, which changes now that Tailwind is gone: `npm run astryx -- upgrade --from 0.6.3 --apply`. In the root `AGENTS.md` delete the two lines about Tailwind and shadcn. Delete `lib/legacy-ui.test.ts` and `tests/legacy-ui-files.json`; add to `lib/design-system.test.ts`:

```ts
// at the top of the file: import { existsSync, readFileSync } from "node:fs";
test("nothing of the old UI system is left", () => {
  for (const gone of ["components/ui", "components.json", "tailwind.config.ts", "postcss.config.mjs"]) assert.ok(!existsSync(gone), `${gone} is removed`);
  const dependencies = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies);
  assert.deepEqual(dependencies.filter((name) => /^@radix-ui\/|tailwind|class-variance-authority/.test(name)), []);
});
```

- [ ] **Step 8:** Update `design/DESIGN.md` (stack, tokens, components) and the paragraph in `README.md` that says the design system is owned locally in `frontend/components/ui`. Delete `design/prototyp.html` or replace it with `npm run astryx -- template --cdn design/prototyp.html`.
- [ ] **Step 9:** Full exit: `npm run lint && npm test && npm run build && npm run test:a11y && npm run test:prod`, plus `docker build -t eneo-mod-speech-to-text:test .` from the repository root.
- [ ] **Step 10: Commit.** `git commit -am "refactor(ui): remove shadcn, Radix and Tailwind"`

---

## Upgrading Astryx later

Its own pull request, never mixed with feature work:

```bash
cd frontend
npm install --save-exact @astryxdesign/core@<new> && npm install --save-dev --save-exact @astryxdesign/cli@<new>
npm run astryx -- upgrade --from 0.6.3          # dry run: read what it would change
npm run astryx -- upgrade --from 0.6.3 --apply
npm run theme:build
npm run lint && npm test && npm run build && npm run test:a11y && npm run test:prod
```

Read the changelog in `node_modules/@astryxdesign/core/CHANGELOG.md` first. Rollback is reverting that pull request.

## Rollback of the port

Each phase is one pull request into `feat/astryx`; reverting it restores the previous screens, because the old components stay in the tree until Phase 8. After Phase 8 the rollback point is the commit before it.

## Accepted behaviour changes (confirm with the owner before Phase 1 ships)

1. Confirmation dialogs follow Astryx: Cancel takes focus; the action carries the emphasis. Today "Stanna kvar" is the filled button.
2. The session warning puts focus on its title, not on "Stäng".
3. The accent in dark mode is `#52B1FF`; component shapes, spacing and type follow the Astryx theme at a 16 px base.
4. Astryx's own words (skip link, close, required, no options) come from its Swedish catalog. Read them in the snapshots; correct a bad one with an override in `kit/ModuleProviders.tsx`.
