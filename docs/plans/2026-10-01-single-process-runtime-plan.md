# Single-Process Runtime Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One process, one runtime. The FastAPI backend serves the built UI as static files on port 3001. The Next.js server, `next-themes`, supervisord, the Node binary in the image and the rewrite hop disappear, and nothing the Next server or supervisord does today is lost. The owner said GO on 2026-10-01: Next adds no security or real benefit here, only complexity, RAM and CPU.

**Architecture:** A Vite + React single-page app (`react-router` data router, React 19) built to `frontend/dist/`. `backend/app/web.py` serves it last in the route order: hashed assets immutable, `index.html` revalidated, security headers on every response, 404 (never HTML) for a missing file or an unknown `/api/*` path. `backend/app/serve.py` is the only way the backend is started and the one place the WebSocket limits and the single replica are set. The browser talks to uvicorn directly through Traefik.

**Tech stack:** Vite 8, `@vitejs/plugin-react`, `react-router` (the kit template pins 8.4.0; run `npm view react-router version` first), React 19.3, TypeScript 7 (`tsc --noEmit` stays the type gate: Vite does not type-check), `@astryxdesign/core` 0.6.3 (unchanged, exact), FastAPI + uvicorn (the versions on `fix/backend-boundary`), node:test with jsdom, Playwright 1.63.

**Work order and status:** Beads, in this repository only (`.beads/`, prefix `stt`, epic `stt-plan-b-one-process-runtime-bbs`). `br ready --json` gives the next bead; claim it, close it with evidence. Each bead names the part of this plan it covers, the files it may touch and what is out of scope. The checkboxes below are a working aid inside a task; they are not the board.

**Beads (epic `stt-plan-b-one-process-runtime-bbs`, ids are `stt-plan-b-one-process-runtime-bbs.<n>`):** B0.1 = .4; B1.1 to B1.4 = .5 to .8; B2.1 to B2.8 = .9 to .16; B3.1 to B3.3 = .17 to .19; B4.1, B4.2 = .20, .21; B5.1, B5.2 = .22, .23; B6.1 = .24. Order: B0.1, then B1 (backend) and B2 (UI) can run in separate worktrees, B2.5 and B3.3 wait for B1.4; B3 after B2, B4 after B3, B5 after B4, B6 last. The placeholder `.3` ("Carry out Plan B") is kept open and depends on B6.1, because Plan C's `stt-plan-c-module-kit-gwh.3` depends on it: closing it earlier would unblock Plan C before Plan B is done.

**Spec:** `docs/plans/2026-10-01-module-platform-design.md` section 7 (the transfer checklist is answered in full in "What Plan B carries over" below) and `docs/decisions/0002-fastapi-bff-kept.md`. Plan A is `docs/plans/2026-10-01-astryx-port-plan.md`; Plan C (the module kit) is out of scope and later.

**Assumed on entry.** Plan A is finished: Tailwind, shadcn, Radix, `components/ui/`, `tests/legacy-ui-files.json` and the `.dark`/legacy HSL parts of `app/globals.css` and `backend/app/accent.py` are gone. `fix/backend-boundary` (body limits, bounded upstream reads, live relay without redirects, lifespan) and `feat/branding-accent` are merged into the base this plan starts from. They are not merged today: `git diff feat/astryx fix/backend-boundary -- backend` shows `backend/app/accent.py` deleted there, because that branch predates it. Task B1.1 starts with that merge, and stops if `backend/tests` is not green after it.

## Global Constraints

- **One process, one port.** The image runs `python -m app.serve` as PID 1 on port 3001. No supervisord, no Node at run time, no second listener, no `libstdc++6` unless an import fails without it (it is there today only for the copied Node binary, `Dockerfile:29-35`). Non-root `module` user stays. `/health` stays.
- **The BFF's HTTP surface and auth logic do not change.** `/api/auth/*`, `/api/eneo/*`, `/api/live/*`, `/api/branding*`, `/api/config`, the allowlist, the session store and the upload/stream code are not edited. Added: static serving, one security-header middleware, `/health` served directly, `STATIC_DIR`, the launcher. The trailing-slash tolerance in `_resolve_proxy_path` (`backend/app/main.py`, there because `next dev` strips the slash) stays; removing it is a later BFF change.
- **The policy is strict for script and for style.** `script-src 'self'; style-src 'self'`, no `'unsafe-inline'`, no `'unsafe-eval'`, anywhere in production. If a component cannot run under it, fix the component or stop and ask; never weaken the policy to make a test pass (stop condition).
- **No inline script and no inline style in `index.html`**, and no `<style>` element generated at run time (`tests/prod/weight.spec.ts` already fails on Astryx's runtime theme injection; it stays).
- **No lost coverage.** All 19 gate projects, every state of `tests/e2e/screens.ts`, the stub, `test:prod`'s production-build path, `weight.spec.ts`, `leaks.spec.ts`, `session-cover.spec.ts`, `color-mode.spec.ts`, the branding configuration. No threshold is lowered, no state removed, no axe exclusion added. A gate file may change only where it names Next (`nextjs-portal`, `__next-route-announcer__`, `next dev`).
- **No behaviour change a person can see**, except the ones listed under "Accepted behaviour changes". Same URLs (`/`, `/flows`, `/flows/<id>?run=…&recording=…`, `/inloggad?fel=…`), same Swedish text, same `localStorage` key `theme` with the values `light`, `dark`, `system`, same `BroadcastChannel`, `lang="sv"`.
- **The fallback never answers a missing file or an unknown `/api/*` path with HTML.** One test per rule, on the real app and again on the image.
- **Copy proven code, do not import it.** The kit is not released (design section 8: this module moves onto it only after Plan B and a released kit). What is copied, and what is deliberately not, is decided in "Reuse from the kit". Every copied file starts with a comment naming its source file and commit, and the Plan C task that deletes the copy.
- **Versions.** The Plan A rule applies: new dependencies are the latest release (`npm view <pkg> version`), exact pins for Astryx and StyleX stay. Do not upgrade Astryx here.
- **Do not touch** `frontend/lib/` except `lib/speaker-review.ts` (the flag), `lib/read-branding.ts`, `lib/leave-guard.ts`, the new test helper `lib/test-router.ts`, the deletion of `lib/backend-base.mjs` (B5.1) and test files, and nothing under `backend/` outside the files a task names.
- **Deletion comes last** (Phase B5), after the image passes its acceptance. Until then Next stays installable so the old image can be rebuilt for rollback.
- One phase is one pull request. Commit after every task. Push or open a pull request only when the owner asks. Several worktrees can run the gate at once on their own ports (`A11Y_APP_PORT`, `A11Y_STUB_PORT`; Plan A "Running phases in parallel"). Never `pkill -f`; stop only what you started.

## What Plan B carries over

Every item of design section 7 ("What Plan B must carry over, explicitly") and ADR 0002, plus the ones found while reading the code. "Today" is the owner now; "After" is the owner once Plan B is done; "Proof" is what fails if it is lost.

| # | Item | Today (owner) | After (owner) | Proof |
|---|---|---|---|---|
| 1 | Security headers and CSP | `frontend/next.config.mjs:28-68` (`headers()`), on every response | `backend/app/security_headers.json` (the one definition) applied by a pure-ASGI middleware in `backend/app/web.py` | `backend/tests/test_web.py` (every response: static, 404, API, health); `tests/prod/headers.spec.ts` on the real app and the image |
| 2 | Same-origin framing for the PDF preview | `next.config.mjs:69-77` and the route itself, `backend/app/main.py` (`eneo_run_artifact_content`: `X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`, only for an inline PDF) | The route alone; the middleware sets a header only when the route did not (`setdefault`) | `test_artifact_proxy.py` plus a header test through the middleware; gate state `result-pdf-dialog` on the built target; image check 11 |
| 3 | `/health` and port 3001 | `next.config.mjs:87-90` rewrites `/health` to `/api/healthz`; `Dockerfile:48,56-57` (`PORT=3001`, `HEALTHCHECK`) | `/health` and `/api/healthz` are two routes of the same handler in the app; `serve.py` defaults to port 3001; `HEALTHCHECK` unchanged | `test_web.py`; image checks 1 and 2 |
| 4 | WebSocket limits, 128 KiB per message and queue 16 | uvicorn flags in `deploy/supervisord.conf:9`, `backend/Dockerfile:19`, `README.md:28`, `docs/development.md:77`; parity test `backend/tests/test_live_relay.py` (`launch_commands`, `test_every_launch_path_sets_the_same_browser_limits`) | Constants `WS_MAX_MESSAGE_BYTES`, `WS_MAX_QUEUE` in `backend/app/limits.py`, passed by `backend/app/serve.py`; every launch path is `python -m app.serve`; the parity test asserts that | rewritten `test_live_relay.py`; a real uvicorn refuses an oversize frame with close code 1009 (exists: `test_production_limits_refuse_an_oversized_message_before_eneo`); image check 8 |
| 5 | One replica | `ModuleSessionStore` is process-local (`backend/app/module_auth.py`); one uvicorn in supervisord; no `replicas` in `docker-compose.yml` | `serve.py` fixes `workers=1` and refuses an override; docs say it | `backend/tests/test_serve.py` |
| 6 | Deep links | Next's file routes (`app/flows/[id]/page.tsx`) | The fallback in `web.py` plus the route table `frontend/routes.tsx` | `test_web.py` (every route of the app, with and without a query); `tests/prod/routes.spec.ts` |
| 7 | Route titles, focus and the route announcement | `export const metadata` in `app/layout.tsx`, `app/page.tsx`, `app/flows/page.tsx`, `app/inloggad/page.tsx` (`generateMetadata`); Next's own focus move and announcer (`aria.spec.ts:67` ignores `__next-route-announcer__`) | `handle.title` per route in `routes.tsx`, one `RouteEffects` component: title, announcement, focus, scroll | `tests/e2e/route-change.spec.ts` (new); `names.spec.ts` title assertions unchanged |
| 8 | State reset on route change | Next remounts a page per route; `key={id}` on `FlowDetail` (`app/flows/[id]/page.tsx`); each page wraps its own `AuthGate` | Same: each route component wraps its own `AuthGate` and keeps `key={id}`. No layout route holds the gate. | `route-change.spec.ts` (flow A to flow B resets); `signed-out.test.ts` |
| 9 | One navigation blocker and the leave guard | `lib/leave-guard.ts` (raw `history`), `components/flow/useLeaveQuestion.tsx` (`useRouter`) | Same two files on the data router; decision and proof in Task B2.7 | `tests/e2e/leave-guard.spec.ts` (new, real browser), `lib/recording-view.test.ts`, `lib/interactions.test.ts` |
| 10 | `/inloggad` and its refusal codes | `app/inloggad/page.tsx` (a server page reading `searchParams`) and `SignedInAgain.tsx`; the redirects are the BFF's (`module_auth.py`: `fel=utgangen`, `fel=annan-anvandare`, `/?auth_error=`) | A client route `/inloggad` reading `useSearchParams`; the BFF is not touched | `names.spec.ts:392`, `route-change.spec.ts`, `routes.spec.ts` (`/inloggad?fel=utgangen` as a direct hit) |
| 11 | The renewal popup | `components/SessionEndWarning.tsx`, `SESSION_CHANNEL`; no Next code | Unchanged | `session-cover.spec.ts`; `names.spec.ts` renewal tests, on the built target |
| 12 | `NEXT_PUBLIC_*` flags | One: `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED`, read in `lib/speaker-review.ts:5`; build args in `Dockerfile:9-10`, `frontend/Dockerfile:9-10`, `docker-compose.yml` | A build-time constant, `SPEAKER_REVIEW_ENABLED` (build arg, then Vite `define` as `__SPEAKER_REVIEW__`). Same meaning, same default `false`. | `lib/speaker-review.test.ts`; `docker build --build-arg SPEAKER_REVIEW_ENABLED=true` shows the marker string in `dist/` |
| 13 | Development proxy for API and WebSocket | `next.config.mjs:80-92` rewrites, `lib/backend-base.mjs` (`INTERNAL_API_BASE`) | `server.proxy` in `frontend/vite.config.ts` (`/api` with `ws: true`, `/health`), target `DEV_API_BASE`, default `http://127.0.0.1:8000`; `changeOrigin: false` so the browser's `Origin` still reaches the BFF's same-origin check | Task B2.8 (a live session through the dev server against the real backend) |
| 14 | The gate's web server | `frontend/playwright.config.ts:73-83` (`next dev`), `playwright.prod.config.ts` (`next build` + `tests/prod/serve.mjs`), `package.json` `dev:stub`, `playwright.branding.config.ts` | Phase B3 | the gate itself |
| 15 | Development pages out of production | `app/dev/*/page.tsx` gated by `NODE_ENV` and `FOUNDATION_CHECK` (`next.config.mjs:9`) | `import.meta.env.DEV` or `vite build --mode check` decides which routes exist; a default build contains none | a build test that the marker string `Grundkontroll` is absent from a default `dist/`; image check 13 (in the default image `/dev/foundation` loads the app, which has no such route and goes to `/`) |
| 16 | The organisation's mark with no wrong municipality before initialisation, no executable inline script | `app/layout.tsx:27` reads `/api/branding` on the server per request (`force-dynamic`), `<link href="/api/branding/theme.css">` in the head at line 34 | The backend writes the answer of `/api/branding` into `index.html` once at start (a `<meta name="eneo-branding">`, not a script); the page reads it before the first render; the accent link stays in the head | `tests/prod/branding.spec.ts` (no `/api/branding` request in production, mark in the first frame), `backend/tests/test_web.py`, `test:a11y:branding` |
| 17 | No HTML for a missing file or an unknown `/api/*` path | Next answers its own HTML 404 for an unknown `/_next/static/x.js` today | `web.py` rules in "Static serving rules" | `test_web.py`, `routes.spec.ts`, image check 4 |
| 18 | Compression | Next gzips what it serves (`compress` is on by default; whether it also gzips proxied API JSON is not known: Task B0.1 measures it) | Precompressed brotli and gzip files beside each asset, chosen by `Accept-Encoding`; the API is not compressed by the module unless B0.1 shows it is today | `test_web.py`, `weight.spec.ts` |
| 19 | The Next-only body and silence limits | `experimental.proxyClientMaxBodySize: "2gb"`, `proxyTimeout: 1_860_000` in `next.config.mjs:14-27` | Gone with the hop. The backend's own `MAX_UPLOAD_BYTES` and `UPLOAD_PROXY_TIMEOUT_SECONDS` are the limits | `test_body_limits.py` (exists on `fix/backend-boundary`); image check 9 |
| 20 | `X-Powered-By` off, server banner | `poweredByHeader: false` | `server_header=False` in `serve.py` | `test_serve.py` |
| 21 | Files in `public/` | `public/live-pcm-worklet.js` (loaded by `AudioWorklet.addModule` under `script-src 'self'`, `components/flow/live-audio.ts:10`), `public/brand/*.svg` | Vite copies `public/` to `dist/`; `web.py` serves a file with an extension from the root of `dist/` | `routes.spec.ts` (200, `text/javascript`), gate state `stromma` on the built target |
| 22 | Graceful stop | supervisord `stopasgroup`/`killasgroup` | `timeout_graceful_shutdown=8` in `serve.py` (Docker kills at 10 s; a streaming file never ends by itself) | `test_serve.py`; image check 10 |
| 23 | Colour mode, no flash | `next-themes` (class on `<html>`, pre-paint inline script, key `theme`), the CSS bridge `html.dark … { color-scheme }` in `app/globals.css`, ADR 0003 | `ColorModeProvider` copied from the kit (same key and values), a parser-blocking same-origin `color-mode.js` for the first paint, selectors on `data-theme` | `color-mode.spec.ts` (kept, plus slow and blocked JS), ADR 0008 supersedes 0003 |
| 24 | Scheme and client address behind Traefik | Next (127.0.0.1) proxies to uvicorn and forwards `X-Forwarded-Proto`; uvicorn trusts forwarded headers from loopback only | Traefik reaches uvicorn from a non-loopback address, so uvicorn ignores `X-Forwarded-*` (default, left unchanged). The module reads no scheme, host or client address (`rg "request\.url|base_url|client\.host" backend/app` finds only `_rebase_signed_url`, which is about Eneo's URL). The one scheme-dependent output is Starlette's trailing-slash 307, whose `Location` would say `http://` (verified in a scratch app: `Location` follows the scope's scheme); the UI never requests such a path (`lib/api.ts` calls `/api/auth/status` and its siblings without a slash; `/api/eneo/*` is a catch-all) | image check 3 asserts no route of the app redirects |

Not carried over, on purpose: HSTS, COOP/CORP and any new header (the edge or a later change; the set is the one Next sends today, minus the two `'unsafe-inline'`); a runtime feature flag (item 12 stays a build-time constant; see decision D6); `_resolve_proxy_path`'s slash tolerance (kept, not extended).

## Reuse from the kit

The proven reference is the kit's pair of repositories (read-only, `/Users/ccimen/eneo/eneo-module-kit`, `/Users/ccimen/eneo/eneo-module-kit-ui`). Plan C moves this module onto released packages; until then each piece is copied or not, with the reason.

| Piece | Source | Decision |
|---|---|---|
| Static serving, SPA fallback, 404 rules, path-escape tests | `packages/bff/src/eneo_module_bff/web.py`, `tests/test_web.py` | **Copy**, with four changes (below). The test file is the model for `backend/tests/test_web.py`. |
| `serve()`: one worker, no access log, bounded WebSocket, graceful stop | `packages/bff/src/eneo_module_bff/serve.py`, `tests/test_serve.py` | **Copy** as `backend/app/serve.py`; the constants move to `limits.py`; `server_header=False` added. |
| `ColorModeProvider` | `packages/ui/src/color-mode.tsx`, `tests/color-mode.test.ts` | **Copy** (about 100 lines, same key and values, no inline script). Plus a first-paint script the kit does not have (Task B2.4). |
| Router link adapter | `template/web/src/main.tsx` (`RouterLink`) | **Copy the shape** into `kit/RouterLink.tsx`. |
| Vite config, `index.html`, entry | `template/web/vite.config.ts`, `index.html`, `src/main.tsx` | **Copy the shape**; this repository keeps its folder layout and its `@/` alias. |
| Image shape | `template/Dockerfile` | **Copy the shape** (web stage, packages stage, runtime without Node, `STATIC_DIR`, `python` as PID 1, health check on `/health`), without the kit's packages. |
| `BrandingProvider` | `packages/ui/src/branding.tsx` | **Do not copy.** It fetches `/api/branding` after the first render and shows the product name alone until the answer arrives, so the mark pops in and the header shifts. This module reads the answer from the page itself (item 16). Say so on the kit's board when Plan C starts. |
| Security-header middleware | `web.py` `add_security_headers` (`@app.middleware("http")`) | **Copy the header set, not the mechanism.** `@app.middleware` is Starlette's `BaseHTTPMiddleware`, which wraps the response body iterator; this app streams audio and PDFs with `BackgroundTask(upstream.aclose)` and Range. Use a pure-ASGI middleware like `BodyLimitMiddleware` (`backend/app/limits.py`), and test a streamed response and a client that disconnects. |
| `ModuleShell`, theme, Astryx wiring | `packages/ui` | **Not copied.** This repository already has `frontend/kit/` (Plan A). |

Changes to the kit's `web.py` when copying: (1) headers by a pure-ASGI middleware; (2) `Cache-Control: public, max-age=31536000, immutable` for `/assets/*` (the kit sets none); (3) precompressed siblings and the branding marker; (4) a path containing a NUL byte is a 404, never a 500 (verified on the kit's code on 2026-10-01: `GET /a%00.js` answers 500, because `Path.resolve()` raises `ValueError` on `\x00`; a backslash is already a 404), and `HEAD` is answered like `GET` (verified: `HEAD /health` and `HEAD /` answer 405 on the kit's app, because FastAPI's `@app.get` does not add `HEAD`; use `api_route(methods=["GET","HEAD"])`). Write both tests first and see them fail.

## Static serving rules (the contract `web.py` implements)

```
Registered last, after every API route. Matching is on the decoded path, never on the query.

GET|HEAD /health, /api/healthz      {"ok": true}, 200
/api and /api/...                   404 {"detail":"Not Found"}   JSON, the unknown-API rule (never HTML)
/assets/<name>                      the file: 200, Cache-Control: public, max-age=31536000, immutable
                                    missing: 404 JSON
<root>/<name>.<ext>                 a file of dist/ (live-pcm-worklet.js, brand/…svg, favicon): 200,
                                    Cache-Control: no-cache (ETag, so a revalidation is a 304)
                                    missing: 404 JSON
any path whose last segment has no dot  index.html: 200, Cache-Control: no-cache, ETag
/index.html                         the same processed page (never the raw file with its empty marker)
/<anything>.br, /<anything>.gz      404: precompressed files are served only by negotiation
a path with NUL, a backslash, or that resolves outside dist/   404, never 500, never a file
Accept-Encoding with br or gzip, and <file>.br / <file>.gz beside the file   serve that file with
                                    Content-Encoding and Vary: Accept-Encoding, the original Content-Type,
                                    and ignore Range (a range of a compressed file is not a range of the file)
Every response, including each 404 and each 304, carries the security headers
```

`index.html` is read once at start. The backend replaces the one marker `<meta name="eneo-branding" content="">` with the escaped JSON of what `GET /api/branding` answers, and computes the ETag of the result. A missing or duplicated marker stops the start (a failed start is better than a page that shows no organisation).

Security headers, `backend/app/security_headers.json` (read by `web.py` and by the gate's preview server, so there is one definition):

```json
{
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)"
}
```

Against `next.config.mjs:36-66` the only differences are the two removed `'unsafe-inline'` and the removed dev-only `'unsafe-eval'`. `microphone=(self)` stays (the kit's default is `microphone=()`; this module records).

## Evidence for `style-src 'self'` and `script-src 'self'`

Read, not yet run (this worktree has no `node_modules`; B3.2 runs it):

- **Script.** The inline script in the HTML today is Next's hydration bootstrap and next-themes' pre-paint script. A client-only Vite build has neither: its entry is `<script type="module" src>`. The first-paint script becomes a same-origin file (Task B2.4). The kit's trial ran Vite 8 with Astryx 0.6.3 under `script-src 'self'; style-src 'self'` in Chromium and WebKit with no console or CSP error (design section 7).
- **Style, Astryx 0.6.3** (`node_modules/@astryxdesign/core/dist`, read in the main checkout): `theme/Theme.js:142-170` creates `<style>` elements only when the theme is not built (`theme.__built` false). `kit/theme/built/eneo.js` is built and `weight.spec.ts` fails on any `style[data-astryx-theme*]`. `CodeBlock/highlightStyles.js:87` creates one `<style>` when a `CodeBlock` renders; `rg CodeBlock` over `app components kit lib` finds none (re-check in B3.2). `hooks/useAnnounce.js:74` sets `el.style.cssText`, which is the CSSOM, not a `style` attribute in markup; the CSP specification does not apply `style-src` to CSSOM writes, and the sentinel of B3.2 confirms it in the browsers the gate uses.
- **Style, this module.** `rg "dangerouslySetInnerHTML|<style|setAttribute\(.style|innerHTML|insertAdjacentHTML|cssText"` over `app components lib kit` finds nothing outside tests. The one `style={…}` prop in the module is `components/flow/LevelMeter.tsx` (the level meter, recording only); React sets a style prop through the CSSOM when it renders in the browser, and the gate state `recording` under the sentinel proves it. What forces `style-src 'unsafe-inline'` today is Next's server-rendered HTML, which writes `style="…"` attributes into markup. A client-only app writes none.
- **Build.** Vite inlines assets under 4 KB as `data:` URIs by default; `build.assetsInlineLimit: 0` makes each a file, so `font-src 'self'` and `img-src` need nothing for them. `build.sourcemap: false`: a `.map` beside each asset would publish the source.
- **Proof, Task B3.2.** The whole gate (all states, all 19 projects) runs against the built app under this exact policy, with `securitypolicyviolation` events and console CSP errors collected by an init script and asserted empty after every state. Dev mode cannot do this: Vite's dev server injects `<style>` for CSS, so the gate has two targets (B3.1, B3.2).

## Review Focus

Conditions the tests do not all exercise and that are most likely to hurt a user:

1. **A hard reload or a link opened on `/flows/<id>?run=<id>` behind Traefik**, and the BFF's own redirect to `/inloggad?fel=utgangen`. Expected: the page, the same run, no 404.
2. **JavaScript slow or blocked on first load, with a stored colour mode that differs from the system's.** Expected: no frame in the wrong mode (the stored choice is applied before the first paint), a Swedish `<noscript>` text when scripts are off, and no flash of the wrong municipality. Pinned by `color-mode.spec.ts` (extended in B2.4) and `branding.spec.ts`.
3. **`AuthGate` and `LoginPage` re-running their effect on every navigation.** Both list the router in their effect dependencies (`components/AuthGate.tsx`, `app/LoginPage.tsx`). Next's router object never changes. With `BrowserRouter` (the kit template's choice) `useNavigate()` changes identity on every location change, which would re-read the session, restart the keep-alive and re-run the drafts clean-up on each page change. The data router's `useNavigate()` is stable. Use `createBrowserRouter`, and pin it with a test that counts `GET /api/auth/status` over a navigation.
4. **Back with a recording in progress**, on the first page of the visit (Back would leave the module) and in the middle of one, with `StrictMode` double effects and after the URL gained `?run=` (`app/flows/[id]/page.tsx`: `writeRunIdToUrl` calls `history.replaceState(window.history.state, "", url)`; the router does not see it; the page must keep reading `window.location.search`, never `useSearchParams`, for `run` and `recording`).
5. **A tab left open across a deploy.** The old `index.html` asks for a lazy chunk (`DateInput`) that no longer exists and gets a 404, not HTML (by design). Expected: a message, never an automatic reload (a reload loses the recording in progress).
6. **The live socket with no proxy.** A browser frame over 128 KiB closes the socket with 1009 before Eneo sees it; a stalled browser ends the session in 15 s (existing relay tests).
7. **An upload cancelled by the browser, and a 1 GiB upload on the image.** Memory stays bounded (FastAPI spools to disk; the Next body clone is gone).
8. **`/assets` of an old build.** A hashed file that is gone is a 404 with no HTML body, not the page; the old page that asked for it says so (item 5).

---

## How to work

### Checks, fastest first

| Command (from `frontend/` unless stated) | What it proves | When |
|---|---|---|
| `npm run lint` | Types | after every edit |
| `npm test` | Unit tests (the router and colour-mode harness change in B2.3) | after every task |
| `.venv/bin/python -m unittest discover -s tests` (from `backend/`) | Backend, including the new `test_web.py`, `test_serve.py` | after every backend task |
| `npm run test:a11y -- a11y.spec.ts -g "<state>" --project=phone-320-light --project=laptop-1440-dark` | One state, dev target | while porting |
| `npm run test:a11y` | The gate, dev target (Vite dev server, stub) | before finishing a phase |
| `npm run test:a11y:built` | The gate, built target (production bundle, production headers, stub) | Task B3.2, CI subset, phase exit |
| `npm run test:prod` | The built app served by the real backend, Chromium, WebKit, Firefox | before finishing a phase from B3 |
| `npm run test:image` (repository root script `deploy/acceptance.sh`) | The production image, from "Production image acceptance" | Phase B4 exit and the cut-over |
| `docker build -t eneo-mod-speech-to-text:test .` | The image builds | before finishing B4 |

### Commands that exist after Phase B2/B3

| Script | Does |
|---|---|
| `npm run dev` | `vite` on 0.0.0.0:3002, `/api` and `/health` proxied (HTTP and WebSocket) to `DEV_API_BASE` |
| `npm run dev:stub` | the stub backend and `vite` together (replaces the `next dev` one-liner in `package.json`) |
| `npm run build` | `tsc --noEmit && vite build && node scripts/finish-build.mjs` (hashes `color-mode.js`, writes `.br` and `.gz` beside each asset); output `dist/` |
| `npm run build:check` | the same with `--mode check`: also compiles `/dev/foundation` and `/dev/speaker-review`; output `dist-check/` |
| `npm run preview:built` | `tests/e2e/preview-server.mjs`: `dist-check/` with the production headers and the `/api` proxy to the stub |

### Stop conditions

Stop, leave the branch as it is, and report to the owner if any of these happens:

- A component cannot run under `style-src 'self'` and the only fix is `'unsafe-inline'` (or `style-src-attr`).
- Neither the kept `guardHistory` nor `useBlocker` keeps Back from losing a recording in the Task B2.7 scenarios.
- `react-router` cannot be loaded by the unit tests' CommonJS build and the ESM build of the tests is not a one-task change.
- A gate threshold would have to be lowered, a state removed, or an ARIA snapshot changes beyond the removal of Next's announcer and the new route announcer.
- A missing file or an unknown `/api/*` path answers HTML anywhere.
- The production image uses more resident memory at idle than today's two processes together (B0.1 measures today's), or its first-load transfer is more than 5 % above today's compressed JS and CSS on the same pages, with no reason that the owner accepts.
- The owner has not repointed the domain (Task B6.1): do not delete the old deployment's rollback path.

---

## File structure

Moves (all under `frontend/` unless a path starts at the repository root). `git mv` so history follows.

| From | To | Note |
|---|---|---|
| `app/layout.tsx` | `index.html`, `main.tsx`, `routes/Root.tsx` | head tags, entry, providers |
| `app/page.tsx`, `app/LoginPage.tsx` | `routes/LoginPage.tsx` | route `/`; title `Logga in · Tal till text` |
| `app/flows/page.tsx`, `app/flows/FlowsPage.tsx` | `routes/FlowsPage.tsx` | route `/flows`; title `Välj ett flöde · Tal till text` |
| `app/flows/[id]/page.tsx` | `routes/FlowPage.tsx` | route `/flows/:id`; `use(params)` becomes `useParams()`; the page sets its own titles (`useDocumentTitle`), the route's is the fallback `Tal till text` |
| `app/inloggad/SignedInAgain.tsx`, `app/inloggad/page.tsx` | `routes/SignedInAgain.tsx` | `refusalOf` and the three titles move in; `fel` from `useSearchParams` |
| `app/dev/foundation/*`, `app/dev/speaker-review/*`, `app/dev/dialog-leak/*` | `routes/dev/*` | only in `import.meta.env.DEV` or `--mode check`; `dialog-leak` in dev only |
| `app/globals.css`, `app/layers.css` | `styles/globals.css`, `styles/layers.css` | `main.tsx` imports `layers.css` first |
| `components/theme-provider.tsx` | deleted | next-themes' wrapper |
| `lib/backend-base.mjs`, `next.config.mjs`, `tests/prod/serve.mjs`, `tests/next-types.d.ts` | deleted (B5.1) | |

Created:

| File | Responsibility |
|---|---|
| `index.html` | head: title, description, `<meta name="eneo-branding">`, the first-paint script, the accent stylesheet; `<noscript>`; the entry |
| `main.tsx` | CSS order, `StrictMode`, `RouterProvider` |
| `routes.tsx` | the route table, `handle.title` per route, route-level `lazy` for `FlowPage`, `FlowsPage`, `LoginPage`, `SignedInAgain`, dev routes only when allowed |
| `routes/Root.tsx` | providers, `RouteEffects`, `Outlet` |
| `routes/RouteEffects.tsx` | title, announcement, focus, scroll on a route change |
| `kit/RouterLink.tsx` | `href` to react-router's `to` for an in-app path (for `LinkProvider` and for `as={RouterLink}`); a plain `<a>` for anything else |
| `kit/ColorModeProvider.tsx` | copied from the kit; `useColorMode()` replaces `useTheme()` of next-themes |
| `public/color-mode.js` | the first-paint script; the build renames it to `assets/color-mode.<hash>.js` |
| `scripts/finish-build.mjs` | hash the script and rewrite `index.html`; precompress |
| `vite.config.ts` | alias, `define`, dev proxy, build options |
| `tests/e2e/preview-server.mjs`, `tests/prod/*.spec.ts` (new specs), `tests/e2e/route-change.spec.ts`, `tests/e2e/leave-guard.spec.ts` | gate and production proof |
| `backend/app/web.py`, `backend/app/security_headers.json`, `backend/app/serve.py` | static serving, the one header definition, the launcher |
| `backend/tests/test_web.py`, `backend/tests/test_serve.py` | their tests |
| `deploy/acceptance.sh`, `deploy/acceptance/` | image acceptance (fake Eneo from the existing test fakes, the checks) |
| `docs/decisions/0008-static-ui-served-by-the-bff.md` | the decision |

Deleted in Phase B4 and B5: `deploy/supervisord.conf`, `backend/Dockerfile`, `frontend/Dockerfile`, `backend/requirements-runtime.txt`, `frontend/next.config.mjs`, `frontend/lib/backend-base.mjs`, `frontend/tests/prod/serve.mjs`, `frontend/tests/next-types.d.ts`, `frontend/components/theme-provider.tsx`, `next`, `next-themes` and the Next lint comments.

---

## Why phases, and why one cut-over branch for the UI

| Phase | Lands on | Deployable on its own | Why |
|---|---|---|---|
| B0 Baseline | `main` | yes (no code) | The claims "lighter, faster" and "no loss" need today's numbers |
| B1 The backend serves a built UI | `main` | **yes.** Nothing changes while `STATIC_DIR` is unset; the launcher and the headers are additive. Next still serves everything. | Proves the whole server side, on its own tests, before any UI moves |
| B2 The UI on Vite and react-router | integration branch `feat/one-process` | no, between its tasks | Next and Vite cannot both be the entry of one source tree: 10 files import `next/*`, 2 import `next-themes`, the test harness mounts `AppRouterContext`. A bridge layer over both would touch the same files twice and add an abstraction that is thrown away. |
| B3 Gate and production tests on the new runtime | `feat/one-process` | no | Moves the gate's web server; proves the strict policy over every state |
| B4 The image | `feat/one-process` | no | One process, no Node; compose; CI |
| B5 Remove Next, docs | `feat/one-process` | no | Deletion and records |
| B6 Cut-over | `feat/one-process` to `main`, then the deployment | yes, with a rollback | One merge, only when the image acceptance and the owner's try-out pass |

The cut-over is safer as one branch than as a Next/Vite hybrid because the branch is merged only after the whole gate, `test:prod` and the image acceptance pass on the finished result, and because rollback is cheap: the previous image tag still runs the old pair and listens on the same port 3001. B1 is not on the branch: it is independently useful, reviewable on its own and deployable today.

Merge `main` into `feat/one-process` at the start of every phase.

---

## Phase B0 — Baseline

Result: today's numbers, so "not heavier, not slower, nothing lost" can be judged against facts.

### Task B0.1: Measure the current image

**Files:** none changed. Output goes in a comment on the bead and in the pull request text of B4.2.

- [ ] **Step 1: Build and run today's image** from `main`: `docker build -t stt-before .`, run it with the stub as its Eneo or with a throw-away `.env` (it needs no Eneo to start). Record `docker image ls stt-before` (size), the time to `healthy`, and resident memory of both processes at idle and after `/flows` was loaded 20 times (`docker stats --no-stream`, and `docker top`).
- [ ] **Step 2: Response headers** (`curl -sI` and `curl -s -D- -o /dev/null`) for: `/`, `/flows`, `/flows/x`, `/inloggad?fel=utgangen`, `/_next/static/<one chunk>`, `/live-pcm-worklet.js`, `/health`, `/api/nope`, `/not-a-page`, `/_next/static/missing.js`, and `HEAD /`. Record status, `content-type`, `cache-control`, `content-encoding`, `etag`, and whether the body is HTML. These are the "today" column of the cache and 404 rows.
- [ ] **Step 3: Compression.** `curl -s -H 'Accept-Encoding: gzip' -D- -o /dev/null` on a proxied JSON answer (a large one: the stub's `transcript-words`, or any 50 KB+ JSON the stub serves) and on a JS chunk. Record whether Next compresses proxied API JSON. This decides item 18's API half.
- [ ] **Step 4: Page weight.** `node docs/plans/page-cost.cjs <frontend dir> <base url> before` on `/flows` and `/flows/flow-1` (Plan A Task 0.6; the production build served with the stub). Record compressed transfer, LCP and total blocking time on the throttled profile.
- [ ] **Step 5: What a first-time visitor's CPU and RAM cost.** Record the Node process's `ps -o rss,pcpu` while 10 browsers poll an open flow run (`?run=`) for a minute. It is the number Plan B should lower.
- [ ] **Step 6: Comment the table on the bead.** No file is changed, so no commit.

**Acceptance:** the table exists with the values above and its source commands. If Step 1 cannot run (no Docker), say so; later "not heavier than today" claims then rest on `page-cost.cjs` alone.

---

## Phase B1 — The backend serves a built UI

Result: `STATIC_DIR=<dist> python -m app.serve` serves the app, the headers, the rules and the limits, with tests. Unset, nothing changes for the running system, so this phase can go to `main` first.

Precondition: `fix/backend-boundary` and `feat/branding-accent` are in the base (see "Assumed on entry").

### Task B1.1: One launcher, and the WebSocket limits in one place

**Files:**
- Create: `backend/app/serve.py`, `backend/tests/test_serve.py`
- Modify: `backend/app/limits.py` (the two constants), `deploy/supervisord.conf`, `backend/Dockerfile`, `README.md`, `docs/development.md` (the dev command), `backend/tests/test_live_relay.py` (`launch_commands`, the parity test)

**Interfaces — Produces:** `app.limits.WS_MAX_MESSAGE_BYTES = 128 * 1024`, `app.limits.WS_MAX_QUEUE = 16`; `app.serve.serve(app, *, host, port, reload=False)`; `python -m app.serve [--host H] [--port P] [--reload]` runs `app.main:app` (defaults `0.0.0.0` and `3001`).

- [ ] **Step 1: Write the failing tests** (model: the kit's `packages/bff/tests/test_serve.py`): `serve()` calls `uvicorn.run` with `workers=1`, `access_log=False`, `server_header=False`, `ws_max_size=WS_MAX_MESSAGE_BYTES`, `ws_max_queue=WS_MAX_QUEUE`, `timeout_graceful_shutdown=8`; an override of `workers`, `access_log` or the two limits raises `ValueError` and does not start; the limits satisfy the existing bounds (`>= 64 KiB`, `max_size * queue <= 2 MiB`).
- [ ] **Step 2: Implement `serve.py`** (copy from the kit, add the two removed overrides and `server_header=False`; `reload=True` only for development and only with the app as an import string).
- [ ] **Step 3: Make every launch path the launcher.** `deploy/supervisord.conf` `command=/opt/venv/bin/python -m app.serve --host 127.0.0.1 --port 8000`; `backend/Dockerfile` `CMD ["python","-m","app.serve","--port","8000"]`; the README and `docs/development.md` dev command `python -m app.serve --host 0.0.0.0 --port 8000 --reload`. (Both files are deleted in B4; until then the parity test keeps guarding them.)
- [ ] **Step 4: Rewrite the parity test.** `launch_commands()` returns the three launch commands above and, from B4 on, the root `Dockerfile`'s `CMD`; the test asserts each runs `app.serve` and not `uvicorn`, and that `serve()` passes the constants. Keep `test_production_limits_refuse_an_oversized_message_before_eneo`, which now takes its limits from `limits.py`.
- [ ] **Step 5: Run** `.venv/bin/python -m unittest discover -s tests`. Expected: green, including the real-uvicorn 1009 test.
- [ ] **Step 6: Commit.** `feat(backend): one launcher sets the WebSocket limits, one worker and a graceful stop`

### Task B1.2: Security headers and `/health`

**Files:**
- Create: `backend/app/security_headers.json`, `backend/app/web.py` (headers part), `backend/tests/test_web.py` (headers part)
- Modify: `backend/app/main.py` (register the middleware, the `/health` alias)

- [ ] **Step 1: Write the failing tests.** For `/api/healthz`, `/health`, a 404 of `/api/nope`, an error response, a streamed audio response and a PDF response: each carries every header of `security_headers.json` with the file's value, except that the inline PDF keeps its route's own `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'`, and nothing else gets those. The policy contains `script-src 'self'`, `style-src 'self'`, no `unsafe-inline`, no `unsafe-eval`, `frame-ancestors 'none'`. A streamed response that the client abandons half-way still closes its upstream (the existing `test_audio_proxy.py` pattern, through the middleware).
- [ ] **Step 2: Implement.** A pure-ASGI middleware (model: `BodyLimitMiddleware`): on `http.response.start` add each header the response lacks. Register it outermost so the 413 of `BodyLimitMiddleware` and every 404 carry the headers. `/health` and `/api/healthz` are one `api_route(methods=["GET","HEAD"])`.
- [ ] **Step 3: Run** the backend tests. **Step 4: Commit.** `feat(backend): the security headers are the backend's, one definition, on every response`

### Task B1.3: Static serving and its rules

**Files:**
- Modify: `backend/app/web.py` (`serve_web`), `backend/app/config.py` (`static_dir: Path | None` from `STATIC_DIR`), `backend/app/main.py` (call `serve_web` last when set), `backend/tests/test_web.py`

- [ ] **Step 1: Write the failing tests first**, from the kit's `test_web.py` and the rules table: every route of the app (`/`, `/flows`, `/flows/abc`, `/flows/abc?run=r`, `/inloggad`, `/inloggad?fel=utgangen`, a trailing slash) is the page with `Cache-Control: no-cache` and an ETag; a second request with `If-None-Match` is a 304 with the headers; `/api`, `/api/`, `/api/nope`, `/api/auth/nope/deeper` are 404 JSON; `/assets/x.js` that exists is 200 with `immutable`; a missing `/assets/x.js`, `/logo.png`, `/a/b/style.css` is 404 with no `<title>`; `/live-pcm-worklet.js` is 200 `text/javascript`; `/index.html` is the processed page and `/assets/x.js.br`, `/assets/x.js.gz` are 404; every escape of the kit's list plus `/%00`, `/a%00.js`, `/a\\b.js`, `/..%5Csecret.txt` is 404 and never a 500 and never contains the secret; `HEAD` of the page and of `/health` is 200 with no body; the module's own routes win over the fallback; without `STATIC_DIR` the app serves no page and `GET /` is 404.
- [ ] **Step 2: Run, see them fail.** Expected: the `%00` cases (500) and `HEAD` (405) fail first; the backslash cases already pass.
- [ ] **Step 3: Implement** (kit's `serve_web` with the four changes in "Reuse from the kit"). Reuse `_etag_matches` from `main.py` (move it to `web.py`; `get_branding_theme` imports it).
- [ ] **Step 4: Run** the backend tests. **Step 5: Commit.** `feat(backend): serve the built UI, with 404 and not HTML for a missing file or an unknown API path`

### Task B1.4: Precompressed files and the branding marker

**Files:**
- Modify: `backend/app/web.py`, `backend/tests/test_web.py`

- [ ] **Step 1: Failing tests.** With `<file>.br` and `<file>.gz` beside `assets/app.js`: `Accept-Encoding: br, gzip` gets the `.br` with `Content-Encoding: br`, `Vary: Accept-Encoding`, `Content-Type: text/javascript`; `gzip` alone gets the `.gz`; none gets the plain file; a `Range` request for a precompressed file is answered 200 whole; the page itself is not precompressed. For the marker: `index.html` with `<meta name="eneo-branding" content="">` is served with the content set to the HTML-escaped JSON of `{"organization": …}` exactly as `GET /api/branding` answers (default organisation, a named one, none: `SHOW_ORGANIZATION=false`), including a name with `"`, `<`, `&` and `'`; a different ETag per different organisation; an `index.html` with no marker, or two, refuses to start with a message naming the file.
- [ ] **Step 2: Implement.** Read `index.html` once in `serve_web`; the replacement uses `html.escape(json, quote=True)`. Negotiate only for extensions `.js .css .svg .json .html .txt` that have a sibling.
- [ ] **Step 3: Run** the backend tests. **Step 4: Commit.** `feat(backend): precompressed assets by Accept-Encoding, and the organisation written into the page at start`

### Phase B1 exit

| Area | Required |
|---|---|
| Backend | `.venv/bin/python -m unittest discover -s tests` green; `test_web.py` and `test_serve.py` exist and pass |
| Surface | No route under `/api` changed (the diff of `main.py` is the middleware, the aliases and `serve_web` only) |
| Running system | With `STATIC_DIR` unset the running system behaves as before: `rg STATIC_DIR` finds only `config.py`, `main.py`, tests and docs |
| Limits | Every launch path is `app.serve`; the parity test asserts it |

---

## Phase B2 — The UI on Vite and react-router

Result: on the integration branch the app builds with Vite and runs in the dev server with Next removed from the source (not yet from `package.json`). Tasks B2.1 to B2.8 are commits on `feat/one-process`; the branch is not deployable between them.

### Task B2.1: Toolchain, entry and the route table

**Files:**
- Create: `frontend/vite.config.ts`, `frontend/index.html`, `frontend/main.tsx`, `frontend/routes.tsx`, `frontend/routes/Root.tsx`, `frontend/kit/RouterLink.tsx`, `frontend/public/color-mode.js` (empty placeholder until B2.4)
- Modify: `frontend/package.json` (add `vite`, `@vitejs/plugin-react`, `react-router`; scripts above; keep `next` for now under `dev:next`/`build:next`), `frontend/tsconfig.json` (remove the `next` plugin, the `files` entry for `next/types/global.d.ts`, `next-env.d.ts` and the `.next` includes; add `"types": ["vite/client"]`), `.dockerignore` (`**/dist`, `**/dist-check`), `.gitignore` already lists `dist/`

**Interfaces — Produces:** `routes.tsx` exports `router` (`createBrowserRouter`) with `handle: { title: string }` per route; `kit/RouterLink.tsx` exports `RouterLink({ href, ...rest })` rendering react-router's `Link to={href}` only for an in-app path (starts with `/`, not `//`, not under `/api/`, no `download`, and no `target` other than `_self`) and a plain `<a>` for everything else. Why: `LinkProvider` makes every Astryx `Link` and every link `Button` a router link, and the module has links that are not pages: `components/flow/ResultDocument.tsx:206` and `ResultFiles.tsx:146` open an API file in a new tab (`<Button href=… target="_blank">`), `ResultFiles.tsx:62` `DownloadLink` is a plain `<a download>`. A router link to `/api/…` would be a client navigation to a path the router has no route for (it would land on `/` through the `*` route). The AppShell skip link (`dist/AppShell/AppShell.js:500-505`) and `TranscriptPlayer`'s skip link are plain anchors and stay so.

- [ ] **Step 1: Versions.** `npm view vite version`, `npm view @vitejs/plugin-react version`, `npm view react-router version`; install the latest, exact. Read `frontend/AGENTS.md` and run `npm run astryx -- doctor`.
- [ ] **Step 2: `vite.config.ts`**

```ts
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const API = process.env.DEV_API_BASE ?? "http://127.0.0.1:8000";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } }, // mirrors tsconfig "paths"
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
```

- [ ] **Step 3: `index.html`** (tags only; the first-paint script and the marker are filled in B2.4 and B2.5):

```html
<!doctype html>
<html lang="sv">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tal till text</title>
    <meta name="description" content="Spela in samtal, få transkript och anteckningar" />
    <meta name="eneo-branding" content="" />
    <script src="/color-mode.js"></script>
    <link rel="stylesheet" href="/api/branding/theme.css" />
  </head>
  <body>
    <div id="root"></div>
    <noscript>Tal till text kräver JavaScript. Aktivera det i webbläsaren och ladda om sidan.</noscript>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: `main.tsx`.** Imports in this order: `./styles/layers.css`, `@astryxdesign/core/reset.css`, `@astryxdesign/core/astryx.css`, `@/kit/theme/built/eneo.css`, `./styles/globals.css` (the same order as `app/layout.tsx:7-11`); then `createRoot(...).render(<StrictMode><RouterProvider router={router} /></StrictMode>)` with `RouterProvider` imported from `react-router/dom` (the DOM entry; `react-router` has the non-DOM one that the unit tests use). Verified in the kit's checkout on 2026-10-01 against react-router 8.4.0: `react-router/dom` exports `RouterProvider`, and `react-router` exports `createBrowserRouter`, `useBlocker`, `ScrollRestoration`, `useNavigate`, `useMatches`, `useParams`, `useSearchParams`. `StrictMode` stays: Next's app router runs it in development and the gate was tuned with double effects.
- [ ] **Step 5: `routes.tsx`.** The five routes of "File structure", each page with route-level `lazy: () => import(...)` (Next split per route; `weight.spec.ts` has one budget per page and would otherwise measure the whole app twice). `*` redirects to `/`. Dev routes exist only when `import.meta.env.DEV || import.meta.env.MODE === "check"` and are written so the bundler drops the dynamic import in a default build.
- [ ] **Step 6: `Root.tsx`** renders `<Outlet />` inside `ModuleProviders` and the branding provider (Task B2.5); `RouteEffects` arrives in B2.6. The root route also sets `HydrateFallback` to the loading shell (the spinner under `ModuleShell` that `AuthGate` shows), so the first page's lazy chunk does not leave a blank frame and react-router logs no "No HydrateFallback" warning.
- [ ] **Step 7: Run** `npx vite build` once. Expected: it fails on `next/*` imports. That is the list for B2.2; do not commit a green build yet.
- [ ] **Step 8: Commit.** `build(frontend): Vite entry, route table and providers (pages follow)`

### Task B2.2: The pages, and every `next/*` import

**Files:** `git mv` per "File structure"; modify the 10 files that import `next/*` (`kit/ModuleProviders.tsx`, `components/Brand.tsx`, `components/AccountMenu.tsx`, `components/AuthGate.tsx`, `components/flow/FlowFrame.tsx`, `components/flow/BackToFlows.tsx`, `components/flow/useLeaveQuestion.tsx`, `components/flow/DetailsForm.tsx`, `app/LoginPage.tsx`, `app/flows/FlowsPage.tsx`), the 4 `Metadata` imports and 3 `notFound` imports (they disappear with the page files), `lib/speaker-review.ts`.

Replacements (the whole inventory; `rg "from \"next|next-themes"` must show only B2.4's items afterwards):

| Today | After |
|---|---|
| `Link` from `next/link` as `as={Link} href` (`Brand`, `FlowFrame`, `BackToFlows`) | `as={RouterLink}` from `@/kit/RouterLink` |
| `NextLink` in `ModuleProviders` `RouterLink` | `kit/RouterLink` |
| `useRouter()`, `router.replace(x)` / `router.push(x)` (`AccountMenu`, `AuthGate`, `LoginPage`, `FlowsPage`, `useLeaveQuestion`) | `const navigate = useNavigate()` from `react-router`; `navigate(x, { replace: true })` / `navigate(x)` |
| `dynamic(() => import("@astryxdesign/core/DateInput")…)` in `DetailsForm` | `lazy(...)` inside `<Suspense fallback={null}>` plus an error boundary around it (Review Focus 5): on a failed chunk it shows an Astryx `Banner` with `Sidan har uppdaterats. Ladda om sidan för att välja datum.` and does not reload by itself |
| `use(params)` in `app/flows/[id]/page.tsx` | `const { id } = useParams()`; `key={id}` and the wrapping `AuthGate` stay |
| `searchParams` in `app/inloggad/page.tsx` | `useSearchParams()`; `refusalOf` and the title table move into `SignedInAgain.tsx` |
| `process.env.NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED === "true"` | `typeof __SPEAKER_REVIEW__ !== "undefined" && __SPEAKER_REVIEW__` with `declare const __SPEAKER_REVIEW__: boolean` |

- [ ] **Step 1: Move the files.** One `git mv` commit with no content change, then the edits.
- [ ] **Step 1b: `LoginPage` and the address.** `app/LoginPage.tsx` removes `?auth_error` with `window.history.replaceState(null, "", "/")`, which drops the router's `idx` and `key` from the entry (the same pattern as the guard's release in B2.7). Use `navigate("/", { replace: true })` there; keep its unit test's expectation (`login-page.test.ts` reads the `replaced` list: it reads `router.state.location` after B2.3).
- [ ] **Step 2: `useNavigate` stability.** Keep `navigate` in each effect's dependency list only because the data router makes it stable. Add a unit test later in B2.3 that fails if it is not (Review Focus 3).
- [ ] **Step 3: `/inloggad`.** A route component, same texts. `useSearchParams` reads `fel`; unknown values are the plain "inloggad igen" page, as `refusalOf` returns null today.
- [ ] **Step 4: Dev routes** from `routes/dev/*` through `routes.tsx` only.
- [ ] **Step 5: Run** `npm run lint` and `npx vite build`. Expected: both pass (unit tests still fail until B2.3).
- [ ] **Step 6: Commit.** `refactor(frontend): the pages are route components on react-router; next/* is gone from the source`

### Task B2.3: The unit-test harness

**Files:** Create `frontend/lib/test-router.ts` and `frontend/tests/vite-types.d.ts`. Modify `frontend/tsconfig.test.json`, `frontend/tests/register.cjs` (only if needed), and the test files that mount `AppRouterContext.Provider` (`lib/login-page.test.ts`, `lib/signed-out.test.ts`, `lib/review-busy.test.ts`, and any `rg "AppRouterContext\|next-themes" lib` finds).

- [ ] **Step 1: Re-check that react-router loads in the CommonJS test build.** `tsconfig.test.json` is `module: commonjs`, which compiles `await import("react-router")` to a `require`. react-router 8.4.0 is an ES module (`"type": "module"`); in the kit's checkout `require('react-router')` works on Node 22.23 (Node loads an ES module through `require` from 22.12 on, and `engines` here is `>=22.13.0`). In a scratch test here: `const { createMemoryRouter } = await import("react-router")`. If it does not resolve, stop and report (stop condition); the kit's tests run react-router under ESM (`packages/ui/tests/readme.test.ts`).
- [ ] **Step 2: `lib/test-router.ts`** exports `withRouter(element, { path, entries })`: a `createMemoryRouter` with the element at `path`, returned with `router` so a test reads `router.state.location` and its navigations (replaces the `replaced: string[]` arrays that `login-page.test.ts` fills from the fake router's `replace`).
- [ ] **Step 3: Replace the providers.** `ThemeProvider` of next-themes in six test files becomes `ColorModeProvider` once B2.4 exists; until then those tests mount `ModuleProviders` alone. Do the replacement of `AppRouterContext` now, of the theme provider in B2.4.
- [ ] **Step 4: `tests/vite-types.d.ts`** is `/// <reference types="vite/client" />` (CSS Module typing, replacing `tests/next-types.d.ts`); `tsconfig.test.json` includes it and drops `node_modules/next/types/global.d.ts`.
- [ ] **Step 4b: The `RouterLink` test.** A link to `/flows` is a router link (a click does not reload the document and updates `router.state.location`); `href="#x"`, `mailto:`, `https://…`, `/api/eneo/…` (with and without `target="_blank"`), and a `download` link are plain anchors that the router never sees.
- [ ] **Step 5: The navigation-stability test.** In `signed-out.test.ts`: mount `AuthGate` in a memory router, navigate to another path that keeps it mounted, assert `GET /api/auth/status` was requested once (fails if `navigate` changes identity).
- [ ] **Step 6: Run** `npm test`. Expected: `# fail 0`. **Step 7: Commit.** `test(frontend): the unit tests mount react-router, not Next's app router`

### Task B2.4: Colour mode with no flash, no inline script

**Files:** Create `frontend/kit/ColorModeProvider.tsx` (copy of `eneo-module-kit-ui/packages/ui/src/color-mode.tsx`, with the header comment), `frontend/public/color-mode.js`, `frontend/scripts/finish-build.mjs` (hashing part), `frontend/tests/e2e/color-mode.spec.ts` (extend). Modify `frontend/kit/ModuleProviders.tsx`, `frontend/components/AccountMenu.tsx`, `frontend/styles/globals.css`, the six unit tests that wrap `ThemeProvider`.

- [ ] **Step 1: Write the failing browser tests first** in `color-mode.spec.ts`, on the production build target (B3 gives it; until then on the dev target): the existing four stored/system combinations pass unchanged (they measure every frame's card colour); add (a) the same four with JavaScript **blocked** (`route.abort` on every `*.js` except `color-mode*.js`): the page shows the `<noscript>`-equivalent empty shell, the canvas colour is the stored choice or the system's, never the other; (b) with the entry bundle **delayed 3 s**: zero frames in the wrong mode before and after it arrives; (c) with `color-mode.js` itself delayed: first paint waits for it (a parser-blocking script) and is right. Run them against the kit's `ColorModeProvider` alone, without the script, and expect (b) to fail: that is the evidence for the script (not verified until this runs).
- [ ] **Step 2: `public/color-mode.js`**

```js
(function () {
  try {
    var mode = localStorage.getItem("theme");
    if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
  } catch (e) {}
})();
```

It sets nothing for `system` or no choice: verified in `node_modules/@astryxdesign/core/dist/theme/Theme.js:196-222` that `Theme` sets `data-theme` for `light` and `dark` and removes it for `system`, and that `reset.css` then defaults to `color-scheme: light dark`, so the browser's own preference paints `system` correctly with no script at all. The script exists for the stored explicit choice that differs from the system's.
- [ ] **Step 3: `scripts/finish-build.mjs`** renames `dist/color-mode.js` to `dist/assets/color-mode.<8-hex content hash>.js`, rewrites the `<script src>` in `dist/index.html`, and removes the root copy. It also fails the build unless `dist/index.html` has exactly one `<meta name="eneo-branding" content="">` (Vite re-serialises the HTML; the backend refuses to start without the marker, so the build should fail first). The name is then under `/assets/` and immutable. A check in the script fails the build if `dist/index.html` still names `/color-mode.js`.
- [ ] **Step 4: Providers.** `ModuleProviders` uses the copied `ColorModeProvider` and passes `mode` to Astryx's `<Theme mode>` as the kit does; the `useSyncExternalStore` observer of the `<html>` class and its comment are removed. `AccountMenu` reads `useColorMode()`; the `themeReady` workaround for hydration goes (no server render).
- [ ] **Step 5: CSS.** In `styles/globals.css` delete the `html.dark … { color-scheme }` bridge and change the brand-logo selectors (`html.dark`, `html:not(.dark)`) to `:root[data-theme="dark"]` with a `@media (prefers-color-scheme: dark) { :root:not([data-theme]) … }` fallback, as the kit's `packages/ui/src/base.css` does at its end.
- [ ] **Step 6: Run** `npm test`, `npm run lint`, the colour-mode specs. **Step 7: Commit.** `feat(frontend): the colour mode is a provider and one same-origin script, no inline script and no flash`

### Task B2.5: The organisation's mark from the page itself

**Files:** Modify `frontend/lib/read-branding.ts`, `frontend/components/Brand.tsx`, `frontend/routes/Root.tsx`, `frontend/lib/read-branding.test.ts`, `frontend/lib/brand.test.ts`; Create a dev-only fallback inside `read-branding.ts`.

- [ ] **Step 1: Failing tests.** `readBranding()` returns the JSON of `<meta name="eneo-branding">` synchronously when the attribute is non-empty; invalid JSON or an unexpected shape is `{ organization: null }` with a `console.error`; an empty attribute (the dev server and the gate's preview do not fill it) falls back to `GET /api/branding` with the existing 2 s deadline (the current function body), so dev, the gate and `test:a11y:branding` keep working.
- [ ] **Step 2: Implement.** The provider's value is read once, before the first render. In production there is then no `/api/branding` request and the mark is in the first frame; in dev and the gate it appears after the answer, as the kit's does, and no frame shows another organisation's mark.
- [ ] **Step 3: Run** `npm test`. **Step 4: Commit.** `feat(frontend): the page reads the organisation from its own HTML`

### Task B2.6: Route titles, announcement, focus and scroll

**Files:** Create `frontend/routes/RouteEffects.tsx`, `frontend/tests/e2e/route-change.spec.ts`. Modify `frontend/routes.tsx`, `frontend/routes/Root.tsx`, `frontend/tests/e2e/aria.spec.ts` (the `__next-route-announcer__` ignore at line 67 becomes ours).

This replaces what Next did without being asked: it moved focus to the new page, scrolled to the top and announced the new title through `__next-route-announcer__` (WCAG 2.4.2, 2.4.3, 4.1.3).

- [ ] **Step 1: Write `route-change.spec.ts` first** (project `laptop-1440-light` and `phone-390-light`, stub): from `/flows` open a flow with its link; from the flow go Back with the browser button; sign out; each time assert (a) `document.title` is the route's (`Välj ett flöde · Tal till text`, `Tal till text` then the page's own), (b) the new title is in a polite live region within 1 s, once, (c) focus is inside the main region and not on `<body>` after the page's content has replaced `AuthGate`'s spinner, (d) the window is scrolled to the top on a link and restored on Back, (e) nothing steals focus from a control the page focused itself (`usePhaseHeading`), (f) a change of the query only (`?run=` written by `replaceState`) does none of it, (g) the first load announces nothing and moves nothing, (h) axe passes on both pages.
- [ ] **Step 2: Implement.** `RouteEffects` (inside the data router) on a change of pathname: set `document.title` from the deepest match's `handle.title`; announce it through a live region that stays mounted (check `npm run astryx -- search announce` first: `@astryxdesign/core` has `hooks/useAnnounce`; if it is public use it, else a 15-line component); focus `[role="main"]` (given `tabIndex={-1}` once) with `preventScroll`, unless focus already moved into it since the navigation; `window.scrollTo(0, 0)` on `PUSH` and `REPLACE`, and `<ScrollRestoration />` for `POP` (the page is the scroller: design decision D3). Focus goes to the main region and not to the `h1` because `AuthGate` first shows a spinner with its own `h1` and then swaps the page in; a focus on the spinner's heading would be lost with it. This is decision D7.
- [ ] **Step 3: Update `aria.spec.ts`** line 67 and run `npm run test:a11y -- aria.spec.ts --update-snapshots` only after reading each diff. The expected diffs: the announcer element and nothing else.
- [ ] **Step 4: Commit.** `feat(frontend): a route change sets the title, announces it, moves focus into the page and scrolls, as Next did`

### Task B2.7: The leave guard on the data router

**Files:** Modify `frontend/lib/leave-guard.ts`, `frontend/components/flow/useLeaveQuestion.tsx` as the result needs. Create `frontend/tests/e2e/leave-guard.spec.ts`. Test: `lib/recording-view.test.ts`, `lib/interactions.test.ts`.

What the guard is for: a recording must not be lost to the Back button. `lib/leave-guard.ts` pushes one extra history entry (state `{...history.state, talTillTextGuard: true}`, no URL) so that Back lands on it, puts it back at once and asks in the page's own dialog; its release calls `history.back()` and rewrites the address with `replaceState(null, …)` ("without the app router's own state" is Next-specific). The links in the bar and Logga ut are covered separately by `onLeave` and `leaveFirst`; `beforeunload` covers reload and close.

react-router's `useBlocker` covers in-app navigations and a Back inside the app (it undoes the pop with `history.go`), but not Back from the **first** entry of a visit (a deep link, a reload), which leaves the document with no in-app navigation to block. That case is what the extra entry is for. So the two do not replace each other; the decision is which of them owns Back inside the app.

**Decision rule (D8).** Default: keep `guardHistory` and `onLeave`/`leaveFirst` unchanged except for the one Next-specific line (the release must write back the router's own `idx` and `key`, not `null`), and add **no** `useBlocker`. Switch to `useBlocker` for in-app Back only if a scenario below fails with the default and passes with it.

- [ ] **Step 1: Write `leave-guard.spec.ts` first** (stub, real browser, `laptop-1440-light`, run with and without `StrictMode` double effects by loading the dev and the built target). Scenarios, each with the question dialog asserted open, focus on "Stanna kvar", the recording still running:
  1. Back in the middle of a visit (list, then flow): the question; Stanna kvar stays on the flow; Lämna sidan goes to the list.
  2. Back on the first page of a visit (open `/flows/flow-1` directly): the question; Lämna sidan leaves the module (navigates to the page before it, `about:blank` in the test).
  3. The URL gains `?run=` while guarded (a run starts), then the guard is released: the address on the entry below is the run's, the router's `idx`/`key` are intact (read `history.state`), Back then goes to the list once, not twice.
  4. Forward after Stanna kvar does nothing wrong.
  5. The bar's links and Logga ut ask first; programmatic `navigate("/", { replace: true })` from `AuthGate` after the session ends does **not** ask.
  6. Reload asks only through `beforeunload`.
  7. `AuthGate` is not remounted by the guard's popstate handling (the session status is requested once).
- [ ] **Step 2: Run against the unchanged guard.** Record which fail. Fix `leave-guard.ts`'s release (`replaceState` with `{ ...routerKeys(win.history.state) }`) and the `useLeaveQuestion` navigation call. If scenario 3 or 7 fails with the default, use `useBlocker(active)` for in-app navigations and leave the extra entry for scenario 2 only; record the decision in the bead.
- [ ] **Step 3: Unit tests.** `lib/recording-view.test.ts` simulates `history` for the guard; keep every case and add one for the router-state keys.
- [ ] **Step 4: Commit.** `fix(frontend): the leave guard keeps Back from losing a recording on the data router`

### Task B2.8: The dev server

**Files:** Modify `frontend/package.json` scripts, `.devcontainer/devcontainer.json` (label of 3002), `frontend/tests/e2e/stub-server.py` only if the dev proxy needs an alias.

- [ ] **Step 1:** `npm run dev` on 3002; `npm run dev:stub` starts `tests/e2e/stub-server.py` and `vite` with `DEV_API_BASE` set to the stub (the current script's shape, `trap` and ports included).
- [ ] **Step 2: Prove the proxy against the real backend**, in the devcontainer layout: `.venv/bin/python -m app.serve --port 8000 --reload` with `.env` for `AUTH_MODE=access_code`, `MODULE_PUBLIC_URL=http://localhost:3002`; sign in, open a flow, start a live session (a stub Eneo or the existing `FakeEneoSocket`), send a 70 KB PCM frame and an oversize frame. Expected: the session works through the dev server's WebSocket proxy and an oversize frame closes with 1009. If Vite's WebSocket proxy changes the `Origin` or splits frames, the dev proxy is not equivalent: report it (the gate is not affected).
- [ ] **Step 3: Docs.** `docs/development.md` ports and commands (3002 dev, `DEV_API_BASE`), `README.md`.
- [ ] **Step 4: Commit.** `feat(frontend): the Vite dev server proxies HTTP and WebSocket to the backend`

### Phase B2 exit

`npm run lint`, `npm test` (`# fail 0`), `npx vite build` pass; `rg "from \"next|next-themes|AppRouterContext" frontend --glob '!node_modules' --glob '!package*.json'` prints nothing; `route-change.spec.ts`, `leave-guard.spec.ts`, `color-mode.spec.ts` pass on the dev target; every file of "File structure" is where it says.

---

## Phase B3 — The gate and the production tests on the new runtime

Result: no coverage lost, and the strict policy proven over every state.

### Task B3.1: The gate's web server (dev target)

**Files:** Modify `frontend/playwright.config.ts`, `frontend/playwright.branding.config.ts` (only the shared server), `frontend/tests/e2e/screens.ts` (`open()`), `frontend/tests/e2e/checks.ts`, `frontend/tests/e2e/branding.spec.ts` (the `nextjs-portal` mentions).

- [ ] **Step 1:** Replace the second `webServer` with `{ command: "npx vite --host 127.0.0.1 --port <APP> --strictPort", url, env: { DEV_API_BASE: "http://127.0.0.1:<STUB>" }, timeout: 120_000, reuseExistingServer: !process.env.CI }`. The stub stays the first server. Update the header comment ("`next dev`" becomes "the Vite dev server", and "Next allows one dev server per checkout" goes: Vite does not).
- [ ] **Step 2:** Remove the `nextjs-portal` rules (`screens.ts:10`, `checks.ts:31,205,378`, `branding.spec.ts:46`): Vite has no dev overlay element of that name. Keep the axe `exclude` list otherwise identical.
- [ ] **Step 3: Run the whole gate** (`npm run test:a11y`, 19 projects, all specs). Expected: the same pass set as on the last Plan A commit. Compare the list of test names and the number of tests per project before and after (they must be equal); read every changed ARIA snapshot (expected: the announcer only). `npm run test:a11y:branding` too.
- [ ] **Step 4: Run `leaks.spec.ts`** and `session-cover.spec.ts` on their own and read the numbers: the DOM-counter slack of `leaks.spec.ts` is not changed.
- [ ] **Step 5: Commit.** `test(frontend): the accessibility gate runs on the Vite dev server`

### Task B3.2: The built target, and the policy over every state

**Files:** Create `frontend/tests/e2e/preview-server.mjs`, `frontend/tests/e2e/csp-sentinel.ts`. Modify `frontend/playwright.config.ts` (a `GATE_TARGET=built` switch), `frontend/package.json` (`test:a11y:built`, `build:check`).

- [ ] **Step 1: `preview-server.mjs`** uses Vite's `preview()` JS API on `dist-check/` with `preview.headers` read from `../backend/app/security_headers.json` (one definition) and `preview.proxy` for `/api` (WebSocket included) to the stub. `vite preview` answers the SPA fallback; the 404 rules are the backend's and are proven in B3.3, not here. Read the JSON lazily, only for this script, so the Docker build stage (which does not copy `backend/`) never needs it.
- [ ] **Step 2: The sentinel.** A Playwright fixture (`csp-sentinel.ts`, used by `a11y.spec.ts`, `keyboard.spec.ts`, `names.spec.ts`, `aria.spec.ts`, `session-cover.spec.ts`) registers `addInitScript` listening for `securitypolicyviolation` and `page.on("console")` for Content-Security-Policy errors, and fails the test at its end when any occurred, printing the directive and the blocked URI. It is only active on the built target.
- [ ] **Step 3: Run** `GATE_TARGET=built npm run test:a11y` (all 19 projects). Expected: no violation. **If one occurs** the evidence section was wrong: find the source of it (`rg` for the DOM API it names), fix it in the component, and add a unit test where it can be tested. Never relax the policy: the stop condition.
- [ ] **Step 4: Record the evidence** in the pull request: the number of states and projects run with the sentinel on, and the one-line answer to "does anything inject inline styles": what was found.
- [ ] **Step 5: CI.** In `.github/workflows/ci.yml` the browser job runs `npm run build:check` and the two-project subset on `GATE_TARGET=built` as well as on the dev target.
- [ ] **Step 6: Commit.** `test(frontend): the whole gate also runs on the production bundle under the production policy, with a CSP sentinel`

### Task B3.3: `test:prod` on the real backend

**Files:** Create `frontend/tests/prod/headers.spec.ts`, `frontend/tests/prod/routes.spec.ts`, `frontend/tests/prod/first-paint.spec.ts`, `frontend/tests/prod/start-backend.mjs`. Modify `frontend/playwright.prod.config.ts`, `frontend/tests/prod/smoke.spec.ts`, `weight.spec.ts`, `weight-budget.json`, `branding.spec.ts`; delete `frontend/tests/prod/serve.mjs` in B5.1.

- [ ] **Step 1: The server.** `start-backend.mjs` starts `python -m app.serve --host 127.0.0.1 --port <APP>` from `backend/` with `STATIC_DIR=../frontend/dist-check`, `ENEO_BACKEND_URL` and `ENEO_PUBLIC_URL` pointing at the stub, `AUTH_MODE=access_code`, `APP_ACCESS_CODE`, `COOKIE_SECURE=false`, `MODULE_PUBLIC_URL=http://127.0.0.1:<APP>`. The stub learns one alias, `/api/v1/` served as `/api/eneo/` in `do_GET`, `do_POST` and `do_PATCH` (it answers the BFF-level paths today). The config's `webServer` builds (`npm run build:check`) then starts it. The specs sign in once with `POST /api/auth/login` (with `Origin`), then use the session. (D10: if `access_code` mode is removed first, the stub learns the SSO ticket exchange, about 40 lines.)
- [ ] **Step 2: `headers.spec.ts`.** For `/`, `/flows`, `/assets/<a hashed file>`, `/live-pcm-worklet.js`, `/api/nope`, `/health`: every header of `security_headers.json`; the inline PDF response carries `frame-ancestors 'self'` and `SAMEORIGIN` and no other response does; `index.html` is `no-cache` with an ETag and `If-None-Match` gives 304; a hashed asset is `immutable`; no `X-Powered-By`, no `Server: uvicorn`; `Content-Encoding` is `br` or `gzip` for `.js` and `.css` when the browser sends it.
- [ ] **Step 3: `routes.spec.ts`.** Direct hits (`page.goto`) on `/flows`, `/flows/flow-1?run=run-done`, `/inloggad`, `/inloggad?fel=utgangen`, `/inloggad?fel=annan-anvandare` render the page, with the right title and `lang="sv"`; `/dev/foundation` and `/dev/speaker-review` render in this build (`--mode check`); in the image's default build they have no route (B4.2 check 13); `/assets/missing.js`, `/missing.png`, `/api/nope`, `/api` are 404 with a non-HTML content type; `HEAD /` is 200.
- [ ] **Step 4: `first-paint.spec.ts`.** In three engines: with JavaScript blocked a Swedish `<noscript>` text shows; production issues no request to `/api/branding`; the mark is in the first frame; stored `dark` with system `light` and the entry bundle delayed shows no light frame (the B2.4 tests, here on the real server).
- [ ] **Step 5: `smoke.spec.ts`, `branding.spec.ts`.** Keep both tests of `smoke.spec.ts` and the accent test of `branding.spec.ts`; remove the `route.fulfill` that rewrites the CSP, because the policy is now strict for style already, and assert the accent applies under it; the `/api` rewrite test becomes "the backend serves the stylesheet".
- [ ] **Step 6: Weight, re-measured.** `weight.spec.ts` measures `/flows` and `/flows/flow-1` as before (the `FOUNDATION_CHECK` note in its header becomes `--mode check`). Put the numbers next to B0.1's. Set `weight-budget.json` to the new numbers rounded up to the next 5 KB **only with the reason in the pull request** (the precompression and the removed Next runtime change them; ADR 0007 is updated in B5.2). Phase 8 of Plan A already set the target; a result above it is a finding. `leaks.spec.ts` is unchanged and runs on the dev target (it needs `Memory.getDOMCounters` on `/dev/foundation`, which both targets have).
- [ ] **Step 7: Run** `npm run test:prod` in the three engines. **Step 8: Commit.** `test(frontend): test:prod serves the built app with the real backend and proves headers, routes, first paint and weight`

### Phase B3 exit

| Area | Required |
|---|---|
| Gate | The whole gate passes on the dev target and on the built target, same test count per project as before B3, no threshold or state changed |
| Policy | The CSP sentinel found nothing across all states and projects, with `style-src 'self'` and `script-src 'self'` |
| Production tests | `test:prod` passes in Chromium, WebKit, Firefox; the weight numbers are in the pull request next to B0.1's |
| Accessibility | `route-change.spec.ts`, `leave-guard.spec.ts`, `color-mode.spec.ts`, `session-cover.spec.ts`, `leaks.spec.ts` pass |

---

## Phase B4 — The image

Result: one process, no Node, no supervisord, accepted on the image.

### Task B4.1: Dockerfile, compose, CI

**Files:**
- Modify: `Dockerfile`, `docker-compose.yml`, `docker-compose.override.yml`, `.dockerignore`, `.env.example`, `.github/workflows/ci.yml`, `backend/tests/test_deployment_compose.py`, `backend/tests/test_live_relay.py` (`launch_commands` adds the `Dockerfile` `CMD`, loses supervisord and `backend/Dockerfile`)
- Delete: `deploy/supervisord.conf`, `backend/Dockerfile`, `frontend/Dockerfile`, `backend/requirements-runtime.txt`

- [ ] **Step 1: The Dockerfile** (shape of the kit's `template/Dockerfile`):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS web
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG SPEAKER_REVIEW_ENABLED=false
ENV SPEAKER_REVIEW_ENABLED=$SPEAKER_REVIEW_ENABLED
RUN npm run build

FROM python:3.12-slim AS python-packages
RUN python -m venv /opt/venv
COPY backend/requirements.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
RUN groupadd --system module && useradd --system --gid module --home-dir /app module
COPY --from=python-packages /opt/venv /opt/venv
WORKDIR /app
COPY --chown=module:module backend/app ./backend/app
COPY --from=web --chown=module:module /build/frontend/dist ./web
ENV PATH=/opt/venv/bin:$PATH PYTHONPATH=/app/backend STATIC_DIR=/app/web \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER module
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3001/health', timeout=3)"
CMD ["python", "-m", "app.serve"]
```

There is no `apt-get` and no `libstdc++6`. After the build, `docker run --rm <image> python -c "import uvicorn, httptools, websockets, uvloop, pydantic_core"` must pass; if an import fails for a missing library, add that one package back and say why in the commit.
- [ ] **Step 2: `docker-compose.yml`**: one service, built from the root (`build: .`), `expose: ["3001"]`, the backend's environment unchanged, the `SPEAKER_REVIEW_ENABLED` build arg (default `false`), the health check on `http://127.0.0.1:3001/health`. The `frontend` service goes. The service keeps its name `speech-to-text-backend` only if decision D2 says so (default: it becomes `speech-to-text`). `docker-compose.override.yml` publishes `3001:3001`.
- [ ] **Step 3: `.env.example`** drops `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED` and names `SPEAKER_REVIEW_ENABLED` with the note that it is a build argument.
- [ ] **Step 4: `test_deployment_compose.py`.** The first test becomes: exactly one service; no `frontend`; port 3001 exposed; health check calls `/health` on 3001; the build context is the repository root and the build arg `SPEAKER_REVIEW_ENABLED` defaults to `false`. Keep the branding and body-limit tests.
- [ ] **Step 5: CI.** `frontend` job: `npm run build` is the Vite build; remove nothing else. `compose` job unchanged. `image` job builds the image and runs `deploy/acceptance.sh` (B4.2). `publish.yml` is unchanged (it builds the root `Dockerfile`).
- [ ] **Step 6: Run** `docker build -t eneo-mod-speech-to-text:test .`, `docker compose --env-file .env.example config -q`, the backend tests. **Step 7: Commit.** `build: one image, one process, no Node and no supervisord`

### Task B4.2: Production image acceptance

**Files:** Create `deploy/acceptance.sh`, `deploy/acceptance/fake_eneo.py` (built from `FakeEneoApi`, `FakeEneoSocket` of `backend/tests/test_live_relay.py` and the fakes of `test_artifact_proxy.py` and `test_audio_proxy.py`), `deploy/acceptance/checks.py`. Modify `frontend/playwright.prod.config.ts` (`PROD_EXTERNAL_URL`: test an already running URL instead of starting the backend, as the kit's `E2E_EXTERNAL_URL` does).

`deploy/acceptance.sh` builds the image, starts it with `docker run` beside the fake Eneo (access-code mode), waits for `healthy`, runs the checks, runs `npm run test:prod -- --project=chromium` against `PROD_EXTERNAL_URL`, and removes only the containers it started.

| # | Check on the running image | Fails when |
|---|---|---|
| 1 | `docker inspect` health is `healthy`; `GET /health` and `GET /api/healthz` answer `{"ok": true}` on 3001 | health moved or died |
| 2 | One process: `docker top` shows one `python` and no `node`, no `supervisord`; `command -v node supervisord` inside is empty; user is not root | a second process or root |
| 3 | Every route of the app as a direct GET is the page (200, `text/html`, `no-cache`), and none of them or of the API paths the UI calls answers a redirect | a deep link breaks, or a redirect would carry `http://` |
| 4 | `/api/nope`, `/assets/x.js`, `/x.png` are 404 with no HTML body | the fallback answers HTML |
| 5 | Headers of check 3 and 4 equal `security_headers.json`; script and style policy has no `unsafe-*` | a header lost |
| 6 | The browser run of `test:prod` (Chromium) passes: first paint, branding, route titles, the renewal popup (`names.spec.ts` renewal on the built page), no CSP violation | UI regressed in the image |
| 7 | A signed-in Range request for the audio route answers 206 with `Content-Range`; a second range after it; the connection closed half-way leaves no open upstream (fake Eneo counts them) | streaming broke |
| 8 | A live session through the real socket: a 64 KiB frame reaches Eneo, a 128 KiB + 1 frame closes with 1009 and Eneo sees nothing | limits lost |
| 9 | A 300 MB upload through `/api/eneo/flows/<id>/files` completes with the process's resident memory growth under 100 MB (it spools); one the client abandons half-way leaves the process healthy and no temp file behind | memory or cancel regressed |
| 10 | `docker stop` ends the container in under 10 s with a file still streaming | graceful stop lost |
| 11 | The inline PDF response has `frame-ancestors 'self'` and `SAMEORIGIN`; the result page's preview frame loads it (browser, `result-pdf-dialog`) | PDF preview broke |
| 12 | `docker run` with `SPEAKER_REVIEW_ENABLED=true` as a build arg yields a `dist/` that contains the speaker-review marker string and the default image does not | the flag is lost or leaks |
| 13 | The default image's `dist/` contains no `Grundkontroll` and no `/dev/` route | a dev page shipped |
| 14 | Image size, start to `healthy`, idle and loaded resident memory, CPU under the B0.1 polling load, and `docs/plans/page-cost.cjs` (transfer, LCP, total blocking time, layout shift on the throttled profile) for `/flows` and `/flows/flow-1`, against B0.1's numbers. The layout shift of the header is the evidence for decision D4 (the mark is in the first frame). | the module got heavier or slower |

- [ ] **Step 1: Write the checks first**, run them against today's image (`stt-before` from B0.1) where they apply (1, 2, 4, 7, 8, 9, 10, 14) and record which fail there: that is the proof that they can fail (4 should, on `/_next/static/missing.js`'s HTML).
- [ ] **Step 2: Run on the new image.** Expected: all pass. Put the table of check 14 in the pull request.
- [ ] **Step 3: Commit.** `test(deploy): acceptance of the production image`

### Phase B4 exit

`docker build` and `deploy/acceptance.sh` pass; check 14 shows no regression (stop condition otherwise); `docker compose --env-file .env.example config -q` passes.

---

## Phase B5 — Remove Next, update the records

### Task B5.1: Delete Next and next-themes

**Files:** Delete `frontend/next.config.mjs`, `frontend/lib/backend-base.mjs`, `frontend/tests/prod/serve.mjs`, `frontend/tests/next-types.d.ts`, `frontend/components/theme-provider.tsx`, `frontend/next-env.d.ts` if tracked. Modify `frontend/package.json`, `frontend/package-lock.json`, `frontend/AGENTS.md` (regenerated block: `npm run astryx -- upgrade --from 0.6.3 --apply`), `AGENTS.md` (the Plan B line), every `// eslint-disable-next-line @next/next/…` (`components/Brand.tsx`).

- [ ] **Step 1:** `npm uninstall next next-themes`; `npm run dev:next`, `build:next` scripts go.
- [ ] **Step 2:** `rg -i "next(\.config|/|-themes|js| dev)|nextjs|__next|INTERNAL_API_BASE|FOUNDATION_CHECK|NEXT_PUBLIC" -g '!node_modules' -g '!docs/plans' -g '!docs/decisions' -g '!package-lock.json' .` prints only text that is about history (the ADRs) and nothing in code, scripts, CI or compose.
- [ ] **Step 3: A test that it stays gone.** In `lib/design-system.test.ts` (Plan A's "nothing of the old UI system is left" test): `package.json` has no `next`, `next-themes`; `next.config.mjs` does not exist.
- [ ] **Step 4: Run** `npm run lint && npm test && npm run build && npm run test:a11y && npm run test:a11y:built && npm run test:prod`, and `deploy/acceptance.sh`. **Step 5: Commit.** `chore(frontend): remove Next.js and next-themes`

### Task B5.2: Docs and decisions

**Files:** Modify `README.md` (the Nuvarande and Planerat rows, ports 3000/3002, commands), `docs/architecture.md` (the diagrams at lines 41-46, 98-102, 138-148, the "Next.js" row at line 20, the headers row at line 198), `docs/operations.md` (rows 14-17, 38, 43-46, 74-84, 101, 117-127, 169), `docs/frontend.md` (lines 11, 34, 46), `docs/backend.md` (lines 34, 84, 104-110, 126-129, 210, 219), `docs/development.md` (ports 3000/3002, lines 77-93, 106-107), `docs/design-system.md` (lines 59, 73, 99), `docs/quality-gates.md` (lines 58, 146, 169, 184), `docs/glossary.md` (line 57), `docs/eneo-integration.md` (lines 122-125), `docs/decisions/0002-fastapi-bff-kept.md` (status: the checklist is carried out), `docs/decisions/0003-…` (superseded by 0008), `docs/decisions/0007-weight-budget.md` (new budget and why), `docs/decisions/README.md`. Create `docs/decisions/0008-static-ui-served-by-the-bff.md`.

- [ ] **Step 1: Write ADR 0008** (Swedish, like its neighbours): decision, the strict policy and its evidence, the first-paint script and why it is a file, the branding marker, the leave-guard decision of B2.7, what was measured (B0.1 and B4.2 check 14), what was copied from the kit and what Plan C deletes.
- [ ] **Step 2: Update the pages above** so that no page says Next serves, supervisord starts, or `frontend` is a service; `operations.md` documents the new variables (`STATIC_DIR` set by the image, `SPEAKER_REVIEW_ENABLED` build argument, `DEV_API_BASE`), the removed ones, and the cut-over and rollback of B6.1.
- [ ] **Step 3: Check the claims.** `rg "supervisord|next\.config|rewrite|Next.js" docs README.md` prints nothing except the ADRs and the history sentences. Run `rg "docs/plans" docs README.md AGENTS.md` and leave the plan references (the port cleanup bead `stt-plan-a-astryx-port-57a.24` removes them).
- [ ] **Step 4: Commit.** `docs: the module is one process serving a static UI`

---

## Phase B6 — Cut-over

### Task B6.1: Merge, deploy, repoint, roll back if needed

Owner and lead task. Nothing here is automatic.

- [ ] **Step 1:** Merge `main` into `feat/one-process`; the whole exit run again (`lint`, `test`, `build`, both gate targets, `test:prod`, `deploy/acceptance.sh`). Open the pull request to `main` when the owner asks.
- [ ] **Step 2: Try-out.** The owner signs in, opens a flow, records, uploads a file, opens a result with a PDF, and opens the module on a Safari 17/18 device, on a preview of the image.
- [ ] **Step 3: The deployment changes, which are not in this repository.** (a) The Dokploy domain today points at the `frontend` service on port 3000 (`docs/operations.md:101`). After Plan B that service no longer exists: point the domain at the single service on port 3001. (b) The published image (`ghcr.io/eneo-ai/eneo-mod-speech-to-text`, `publish.yml`) already listens on 3001, so a deployment that runs the image and not the Compose file needs only the new tag. (c) Traefik must pass the WebSocket upgrade to the service, which it does today for the same path; nothing changes there.
- [ ] **Step 4: Rollback.** Redeploy the previous image tag (still two processes on 3001) and point the domain back; or, with Compose, redeploy the previous commit. Sessions are process-local, so everyone signs in again either way. State this to the owner before the switch.
- [ ] **Step 5:** After a week with no incident, close the epic; the old tag stays in the registry.

---

## Accepted behaviour changes (confirm with the owner before B6)

1. With JavaScript disabled the page shows a Swedish notice instead of the loading shell Next rendered on the server.
2. The organisation's mark is in the first paint in production; in the dev server and in the gate's dev target it appears after `GET /api/branding` answers (the kit's behaviour). Production is the stricter of the two.
3. The new image has no `/_next/*`; a bookmarked `/_next/…` URL is a 404.
4. The Compose file has one service, so the `frontend` service name and port 3000 are gone from the deployment (B6.1 Step 3).
5. The build argument is `SPEAKER_REVIEW_ENABLED`; `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED` stops working.
6. A stale tab that asks for a removed lazy chunk shows a message and does not reload by itself (Next recovers from a failed chunk with a full reload, as far as its documentation says; not verified here), because a reload loses a recording in progress.

## Risks and stop conditions

| Risk | Guard |
|---|---|
| A component writes an inline style or script the evidence missed | The sentinel over every state (B3.2); stop condition; never `'unsafe-inline'` |
| Back loses a recording on the new router | B2.7's seven scenarios in a real browser; the fallback `useBlocker`; stop condition |
| `AuthGate` and `LoginPage` re-run on every navigation | Data router, and the count test of B2.3 |
| The first paint shows the wrong colour mode when JS is slow | The same-origin script and B2.4's slow and blocked JS tests |
| `react-router` does not load in the CommonJS unit tests | Loads in the kit's checkout under Node 22.23 (`require` of an ES module); B2.3 Step 1 re-checks it here before any edit depends on it |
| The gate changes silently with the server | Equal test counts per project, snapshots read, B3.1 |
| A stale tab after a deploy | `index.html` is `no-cache`, assets hashed, a message for a lost chunk, never an automatic reload |
| `fix/backend-boundary` and `main.py` conflict (it predates the accent code) | B1.1 starts with the merge and a green backend run |
| Chrome offers brotli only over HTTPS, so `test:prod` on plain HTTP measures gzip | The weight numbers are compared with B0.1's gzip; the image check under HTTPS is a hand check at B6.1 |
| `access_code` login is removed before B3.3 | D10: the stub learns the SSO ticket exchange |
| A redirect built behind Traefik says `http://` (item 24) | No UI path redirects; image check 3; do not turn on `forwarded_allow_ips="*"` without the owner |
| Keep-alive: uvicorn closes an idle connection after 5 s; Traefik reuses connections | Today's Node server has the same 5 s; parity, not a regression. A 502 rate after the cut-over is the signal to set `timeout_keep_alive` above Traefik's idle timeout |
| Deployment config outside the repository (domain, service name) | B6.1 Step 3, and the rollback |

**Stop and ask the owner if** a stop condition under "How to work" holds, or a step's expected result does not appear after one honest attempt to fix the cause.

## Decisions needed from the owner

Defaults are what the plan assumes if nothing is said.

| # | Question | Default |
|---|---|---|
| D1 | One integration branch `feat/one-process`, merged once after the image acceptance; B1 goes to `main` first | Yes |
| D2 | The Compose service's name: keep `speech-to-text-backend`, or `speech-to-text` (the domain has to be repointed either way) | `speech-to-text` |
| D3 | Port 3001 in the image and in Compose (today Compose uses 3000 for the UI) | 3001 |
| D4 | The organisation's mark written into `index.html` by the backend, or fetched after the first render as the kit does | Written into the page |
| D5 | Compression: precompressed brotli and gzip at build time; the API is compressed by the edge or not at all, unless B0.1 shows Next gzips it today, in which case a JSON-only compression of the non-streaming proxy route is added in B1.4 (never for Range, audio or PDF) | As stated |
| D6 | `SPEAKER_REVIEW_ENABLED` stays a build-time flag (a published image then always has it off). A run-time flag would ride in the same `<meta>` as the organisation. | Build time; ask later if a deployer needs it |
| D7 | After a route change focus goes to the main region (the page's heading appears later than the route) and the new title is announced | Yes |
| D8 | `guardHistory` is kept and `useBlocker` added only if B2.7 shows it is needed | Yes |
| D9 | The gate has two targets: the dev server for every day, the production bundle for the CI subset and the exit | Yes |
| D10 | The production tests sign in with `AUTH_MODE=access_code` | Yes, while that mode exists |
| D11 | `/health` and `/api/healthz` both stay | Yes |
| D12 | A short interruption at the cut-over (repoint the domain, sessions are lost) is acceptable | Yes |

## Not in Plan B

SSR or any server rendering; Hono; a nonce or a hash CSP (the policy has nothing inline); HSTS and other new headers; a service worker or an offline mode; moving this module onto the kit's packages (Plan C); changing the BFF's routes, auth, allowlist or session store; more than one replica; removing the trailing-slash tolerance; the access-code login's removal (README schedules it).

## Review record

Codex design review (`gpt-6-astra`, `xhigh`) of the approach was running in parallel when this plan was written. Findings are integrated and answered here when the lead forwards them. Until then the plan carries these open points from its own reading, none verified by running code (this worktree has no `node_modules`, and Docker and Playwright were not run):

- the CSP evidence is read from source (Astryx 0.6.3 `dist`, the module's sources, the kit's trial), and is proven only by Task B3.2;
- that the kit's `ColorModeProvider` alone flashes under delayed JavaScript is a prediction, which B2.4 Step 1 turns into a failing test or drops;
- whether Next gzips proxied API JSON, the keep-alive behaviour behind Traefik, and Chrome's brotli over HTTP are unmeasured;
- `react-router` 8.4.0 loads through `require` on Node 22.23 and exports every API the plan uses (checked in the kit's checkout); that it does so under this repository's `tsc` CommonJS test build, with jsdom, is checked in B2.3 Step 1;
- the Dokploy domain configuration is outside the repository and was not read.
