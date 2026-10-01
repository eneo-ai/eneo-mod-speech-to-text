# Agent instructions: eneo-mod-speech-to-text

The frontend is being ported from shadcn/Radix/Tailwind to Astryx.
This file, `CLAUDE.md`, `.beads/` and `docs/plans/` exist only for the port. They are removed when it is done
(bead `stt-plan-a-astryx-port-57a.24`); do not build anything permanent on them.
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
- Overlays (dialog, alert dialog, menu, sheet): a dialog mounted once and opened by `isOpen`, as the component's docs show,
  and one mounted for each opening both leave nothing behind (`frontend/tests/e2e/leaks.spec.ts` proves each over 40
  openings; `frontend/app/dev/dialog-leak` is its fixture, with a dialog that really leaks to prove the spec can fail).
  A node count that follows a click on an overlay that was then removed is not the overlay's: Chromium keeps the element
  last under the pointer, and all that was removed with it (25 to 39 nodes for one dialog), until the pointer moves, so
  `leaks.spec` moves the pointer off after every close. Add each new overlay to `leaks.spec` as it is; a count that
  survives the pointer move is a real leak to find, and the slack is never raised.
- The hosted Astryx MCP documents the latest release. When it and `npm run astryx` disagree, the CLI is right.

## Product rules

- User-facing text is Swedish. Do not load fonts or scripts from other origins.
- 44 px touch targets, a visible focus indicator, WCAG 2.2 AA: `npm run test:a11y` in `frontend/` is the proof.
- `tests/legacy-ui-files.json` lists files still on the old UI system. Remove a file when it is ported. Never add one.

## Checks

From `frontend/`: `npm run lint`, `npm test`, `npm run test:a11y`, `npm run test:prod`, `npm run build`.
From `backend/`: `.venv/bin/python -m unittest discover -s tests`.
Several worktrees can run the gate at once on their own ports: `A11Y_APP_PORT` and `A11Y_STUB_PORT` (defaults 3401 and 8401). Never `pkill -f`; stop only what you started.
Work order and status live in Beads: `br ready --json`. The plan's checkboxes are a working aid, not the board.
