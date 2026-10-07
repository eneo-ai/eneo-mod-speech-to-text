# Single-Process Runtime Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One process, one runtime. The FastAPI backend serves the built UI as static files on port 3001. The Next.js server, `next-themes`, supervisord, the Node binary in the image and the rewrite hop disappear, and nothing the Next server or supervisord does is lost. The owner said GO on 2026-10-01: Next adds no security or real benefit here, only complexity, RAM and CPU. Security gain, concretely: a `script-src` with no `'unsafe-inline'` becomes possible, so injected inline script and event-handler attributes are blocked. That narrows the ways an XSS could reach the recording's audio in IndexedDB (sec-media's P3). It is defence in depth, not a guarantee: output encoding and the BFF's server-side checks stay the primary controls; every response, API and signed-file streams included, gets the security headers (Next's `headers()` do not reach the `/api/*` answers it proxies).

**No compatibility layer.** The module is not in production and nobody runs it. Plan B replaces the Next runtime outright: no transition, no old name or old port kept alive, no shim for something that used to work. Where the clean solution and a compatible one differ, this plan takes the clean one.

**Architecture:** A Vite + React single-page app (`react-router` data router, React 19) built to `frontend/dist/`. `backend/app/web.py` serves it last in the route order: hashed assets immutable, `index.html` revalidated, security headers on every response, 404 (never HTML) for a missing file or an unknown `/api/*` path. `backend/app/serve.py` is the only way the backend is started and the one place the WebSocket limits and the single replica are set. The browser talks to uvicorn directly through Traefik. One fake Eneo (`frontend/tests/e2e/stub-server.py`, extended) is the upstream of every production-shaped test: the real-backend gate, `test:prod` and the image acceptance.

**Tech stack:** Vite 8, `@vitejs/plugin-react`, `react-router` (the kit template pins 8.4.0, which declares Node `>=22.22.0`; run `npm view react-router version engines` first), React 19.3, TypeScript 7 (`tsc --noEmit` stays the type gate: Vite does not type-check), `@astryxdesign/core` 0.6.3 (unchanged, exact), FastAPI + uvicorn (the versions on `feat/astryx`), node:test with jsdom, Playwright 1.63.

**Work order and status:** Beads, in this repository only (`.beads/`, prefix `stt`, epic `stt-plan-b-one-process-runtime-bbs`). `br ready --json` gives the next bead; claim it, close it with evidence. Each bead names the part of this plan it covers, the files it may touch and what is out of scope. The checkboxes below are a working aid inside a task; they are not the board.

**Beads (epic `stt-plan-b-one-process-runtime-bbs`, ids are `stt-plan-b-one-process-runtime-bbs.<n>`):** B0.1 = .4; B1.1 to B1.4 = .5 to .8; B2.1 = .9, B2.2 = .10, B2.3 = .11, B2.4 = .17, B2.5 = .26, B2.6 = .12, B2.7 = .13, B2.8 = .14, B2.9 = .15, B2.10 = .16; B3.1 = .18, B3.2 = .25, B3.3 = .19; B4.1 = .20, B4.2 = .21; B5.1 = .22, B5.2 = .23; B6.1 = .24. Every task can run its checks with only its declared predecessors (the dependencies on the board are exactly those below). B1 (backend) and B2 (UI) can run in separate worktrees; B2.7 waits for B1.4, B2.10 for B1.1; B3.1 waits for B2.10, B1.4 and B2.5; B3.2 for B3.1; B3.3 for B3.2; B4 after B3, B5 after B4, B6 last. The placeholder `.3` ("Carry out Plan B") is kept open and depends on B6.1, because Plan C's `stt-plan-c-module-kit-gwh.3` depends on it: closing it earlier would unblock Plan C before Plan B is done.

**Spec:** `docs/plans/2026-10-01-module-platform-design.md` section 7 (the transfer checklist is answered in full in "What Plan B carries over" below) and `docs/decisions/0002-fastapi-bff-kept.md`. Plan A is `docs/plans/2026-10-01-astryx-port-plan.md`; Plan C (the module kit) is out of scope and later.

**Prerequisite, named.** Plan B starts from `feat/astryx` at `c8eab7c` or later. In it: Plan A is finished (Phase 8: Tailwind, shadcn, Radix, `components/ui/`, `lib/utils.ts` and the shadcn config are gone), and the backend hardening is merged: `fix/backend-boundary` (merged at `8e861ec`: the body caps `BodyLimitMiddleware` in `backend/app/limits.py`, bounded upstream reads in `backend/app/upstream.py`, the lifespan hook), the signed-file rule that makes only audio, video, PDF and four image types inline and every file `nosniff` (`1203d64`), an open live socket that ends with its session (`0e39e4b`), and the page's user, which is now required for every request that changes something under `/api/eneo` and for the live socket in an `eneo_sso` session (`48f014b`, `2eb0fc6`, `501d9cc`; the frontend sends `X-Expected-User` and `?expected_user=`, `frontend/lib/api.ts`, `frontend/lib/live-transcriber.ts`). The Codex design pass 1 looked at `d114f27`, which has none of it. Task B1.1 starts by listing the commits that touched `backend/app` since `8e861ec`, reading their diffs of `main.py`, `module_auth.py`, `limits.py` and `config.py` (the owners this plan builds on), and running `backend/tests`; it stops if anything is red.

## Global Constraints

- **One process, one port.** The image runs `python -m app.serve` as PID 1 on port 3001. No supervisord, no Node at run time, no second listener, no `libstdc++6` unless an import fails without it (it is in the image only for the copied Node binary, `Dockerfile:29-35`). Non-root `module` user stays. `/health` stays.
- **The BFF's auth logic and the shape of its API do not change.** `/api/auth/*`, `/api/eneo/*`, `/api/live/*`, `/api/branding*`, `/api/config`, the allowlist, the session store and the upload/stream code are not edited. Added: static serving, one security-header middleware, `/health` served directly, `STATIC_DIR`, the launcher. Three deliberate narrowings of what the app answers: FastAPI's docs routes are removed; a slash twin of a route is a 404 and no longer a redirect; and the trailing-slash tolerance of `_resolve_proxy_path` (`backend/app/main.py`), which exists only because `next dev` strips the slash, is deleted (rows 25 and 27).
- **The policy is strict for script and for style.** `script-src 'self'; style-src 'self'`, no `'unsafe-inline'`, no `'unsafe-eval'`, anywhere in production. If a component cannot run under it, fix the component or stop and ask; never weaken the policy to make a test pass (stop condition).
- **Header precedence.** One app-wide default set, applied with `setdefault`: a header an endpoint sets itself wins. The owners that keep theirs are the PDF framing exception (`eneo_run_artifact_content`), the sandbox CSP of `GET /api/branding/logo/*` (`default-src 'none'; style-src 'unsafe-inline'; sandbox`) and the signed-file rule in `_stream_signed` (`1203d64`). The kit's `Permissions-Policy: microphone=()` is never copied; this module records.
- **One history owner.** `createBrowserRouter` only (a client-side data router: no loaders, no actions, no SSR; `useBlocker` needs a data router and the kit's `BrowserRouter` has none). `lib/leave-guard.ts`'s extra history entry and `go(-2)` are deleted when `useBlocker` replaces them; the flow page's `?run=` and `?recording=` writes go through the router with `replace` and do not count as leaving.
- **One owner for what happens after a navigation.** `RouteEffects` does title, announcement, focus and scroll, once per navigation and only when the page says it has its content (`useRouteReady`). `react-router`'s `<ScrollRestoration>` is not used (it runs before content fetched outside loaders exists), and no code polls the DOM for a heading.
- **No lazy chunk can take work with it.** Every lazily loaded chunk fails locally and recoverably (the text or field stays, a status line and a retry press), never by a reload and never through a boundary that unmounts the recording or the editing page. Old assets are not retained across deploys.
- **No inline script and no inline style in `index.html`**, and no `<style>` element generated at run time (`tests/prod/weight.spec.ts` already fails on Astryx's runtime theme injection; it stays).
- **No lost coverage.** Every project, spec and state of the gate that exists when Plan B starts, the stub, `weight.spec.ts`, `leaks.spec.ts`, `session-cover.spec.ts`, `color-mode.spec.ts`, the branding and review configurations. No threshold is lowered, no state removed, no axe exclusion added. The proof is the list of test names (project, file, title) before and after, not their number: no name disappears, and every added name is listed in the pull request. A gate file may change only where it names Next (`nextjs-portal`, `__next-route-announcer__`, `next dev`, `NEXT_PUBLIC_`) or where a task of this plan says so.
- **What a person sees does not change**, except what "What differs from the Next version" lists. Same URLs (`/`, `/flows`, `/flows/<id>?run=…&recording=…`, `/inloggad?fel=…`), same Swedish text, same `localStorage` key `theme` with the values `light`, `dark`, `system`, same `BroadcastChannel`, `lang="sv"`.
- **The fallback never answers a missing file or an unknown `/api/*` path with HTML.** One test per rule, on the real app and again on the image.
- **A test that acts as the page names its user**: `X-Expected-User` on a request that changes something, `?expected_user=` on the live socket, as `lib/api.ts` and `lib/live-transcriber.ts` do. A read may name nobody (an `<audio src>` cannot).
- **Copy proven code, do not import it.** The kit is not released (design section 8: this module moves onto it only after Plan B and a released kit). What is copied, and what is deliberately not, is decided in "Reuse from the kit". Every copied file starts with a comment naming its source file and commit, and the Plan C task that deletes the copy.
- **Versions.** The Plan A rule applies: new dependencies are the latest release (`npm view <pkg> version`), exact pins for Astryx and StyleX stay. A dependency's declared `engines` is read with its version, and the repository's own floor follows the highest (B2.1). Do not upgrade Astryx here.
- **Do not touch** `frontend/lib/` except `lib/speaker-review.ts` (the flag), `lib/read-branding.ts`, the new test helper `lib/test-router.ts`, the new shared loader `lib/lazy-component.ts`, the deletion of `lib/leave-guard.ts` (B2.9) and `lib/backend-base.mjs` (B5.1) and test files, and nothing under `backend/` outside the files a task names.
- **Deletion comes last** (Phase B5), after the image passes its acceptance: the comparisons in B0.1 and B4.2 are against the image built before anything changed.
- One phase is one pull request. Commit after every task. Push or open a pull request only when the owner asks. Several worktrees can run the gate at once on their own ports (`A11Y_APP_PORT`, `A11Y_STUB_PORT`; Plan A "Running phases in parallel"). Never `pkill -f`; stop only what you started.

## What Plan B carries over

Every item of design section 7 ("What Plan B must carry over, explicitly") and ADR 0002, plus the ones found while reading the code. "Today" is the owner now; "After" is the owner once Plan B is done; "Proof" is what fails if it is lost.

| # | Item | Today (owner) | After (owner) | Proof |
|---|---|---|---|---|
| 1 | Security headers and CSP | `frontend/next.config.mjs:28-68` (`headers()`), on the pages Next serves only: Next's `headers()` do not reach the `/api/*` answers it proxies (sec-media measured it), so an API JSON answer, a signed-file stream and an error carry no CSP, `nosniff` or `Permissions-Policy` | `backend/app/security_headers.json` (the one definition) applied with `setdefault` by a pure-ASGI middleware in `backend/app/web.py` to every response, API included | `backend/tests/test_web.py` (an API JSON answer, a 4xx, a stream, a 303 redirect, the page, a 404, `/health`); `tests/prod/headers.spec.ts` on the real app and the image |
| 2 | Endpoint headers that must keep winning | PDF framing: `next.config.mjs:69-77` and the route `eneo_run_artifact_content` (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`, only for an inline PDF); the SVG logo's sandbox CSP in `get_branding_logo`; the signed-file rule in `_stream_signed` (`nosniff`; only audio, video, PDF and four image types inline: `1203d64`) | The same three owners, unchanged. The middleware sets a header only when the response lacks it | `test_web.py` through the middleware: HTML, a redirect, an error, an SVG logo (its sandbox CSP, not the default), an inline PDF (framing), an attachment, an inline audio; gate state `result-pdf-dialog` on the real target; image check 11 |
| 3 | `/health` and port 3001 | `next.config.mjs:87-90` rewrites `/health` to `/api/healthz`; `Dockerfile:48,56-57` (`PORT=3001`, `HEALTHCHECK`) | `/health` and `/api/healthz` are two routes of the same handler in the app; `serve.py` defaults to port 3001; `HEALTHCHECK` unchanged | `test_web.py`; image checks 1 and 2 |
| 4 | WebSocket limits, 128 KiB per message (uvicorn's default implementation reads one message at a time, so no queue limit is needed) | uvicorn flags in `deploy/supervisord.conf`, `backend/Dockerfile`, `README.md`, `docs/development.md`; parity test `backend/tests/test_live_relay.py` (`launch_commands`, `test_every_launch_path_sets_the_same_browser_limits`) | Constant `WS_MAX_MESSAGE_BYTES` in `backend/app/limits.py`, passed by `backend/app/serve.py`; every launch path is `python -m app.serve`; the parity test asserts that | rewritten `test_live_relay.py`; a real uvicorn refuses an oversize frame with close code 1009 (exists: `test_production_limits_refuse_an_oversized_message_before_eneo`); image check 8 |
| 5 | One replica | `ModuleSessionStore` is process-local (`backend/app/module_auth.py`); one uvicorn in supervisord; no `replicas` in `docker-compose.yml` | `serve.py` fixes `workers=1` and refuses an override; docs say it | `backend/tests/test_serve.py` |
| 6 | Deep links | Next's file routes (`app/flows/[id]/page.tsx`) | The fallback in `web.py` plus the route table `frontend/routes.tsx` | `test_web.py` (every route of the app, with and without a query); `tests/prod/routes.spec.ts` |
| 7 | Route titles, focus, scroll and the route announcement | `export const metadata` in `app/layout.tsx`, `app/page.tsx`, `app/flows/page.tsx`, `app/inloggad/page.tsx` (`generateMetadata`); Next's own focus move, scroll and announcer (`aria.spec.ts:67` ignores `__next-route-announcer__`) | `handle.title` per route in `routes.tsx`; one `RouteEffects` component and one hook, `useRouteReady`, that each page calls when it has its first real content | `tests/e2e/route-change.spec.ts` (new); `names.spec.ts` title assertions unchanged |
| 8 | State reset on route change | Next remounts a page per route; `key={id}` on `FlowDetail` (`app/flows/[id]/page.tsx`); each page wraps its own `AuthGate` | Same: each route component wraps its own `AuthGate` and keeps `key={id}`. No layout route holds the gate | `route-change.spec.ts` (flow A to flow B resets); `signed-out.test.ts` |
| 9 | Leaving a page that holds work | `lib/leave-guard.ts` (an extra history entry and `go(-2)`), `components/flow/useLeaveQuestion.tsx` (`useRouter`; `onLeave` for links; `leaveFirst` for logout), `beforeunload` in `app/flows/[id]/page.tsx` | `useBlocker` (data router) in `useLeaveQuestion`, which asks in the same dialog with the same warning (`leaveWarning`); `lib/leave-guard.ts` deleted. `leaveFirst` stays for logout (a request, not a navigation: the question comes before the session is invalidated). `beforeunload` stays: it alone covers reload and Back from the first entry of a visit | `tests/e2e/leave-guard.spec.ts` (new, real browser), `lib/interactions.test.ts`, `lib/recording-view.test.ts` rewritten |
| 10 | `/inloggad` and its refusal codes | `app/inloggad/page.tsx` (a server page reading `searchParams`) and `SignedInAgain.tsx`; the redirects are the BFF's (`module_auth.py`: `fel=utgangen`, `fel=annan-anvandare`, `/?auth_error=`) | A client route `/inloggad` outside every gate, reading `useSearchParams`; the BFF is not touched | `names.spec.ts` (`Inloggningen har gått ut`), `route-change.spec.ts`, `routes.spec.ts` (`/inloggad?fel=utgangen` as a direct hit) |
| 11 | The renewal popup | `components/SessionEndWarning.tsx`, `SESSION_CHANNEL`; no Next code | Unchanged | `session-cover.spec.ts` and `names.spec.ts` on the real target, where the sessions are the backend's |
| 12 | `NEXT_PUBLIC_*` flags and build constants | One flag: `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED`, read in `lib/speaker-review.ts`, set by `playwright.review.config.ts` (`test:a11y:review`), read by `tests/e2e/review-flag.spec.ts`, build args in `Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml`. One compile-time switch: `FOUNDATION_CHECK` (`next.config.mjs:9`) | Two explicit constants and nothing else: `SPEAKER_REVIEW_ENABLED` (build argument, and the variable the Vite dev server and the review config read; then Vite `define` as `__SPEAKER_REVIEW__`; same meaning, same default `false`) and `vite build --mode check` for the fixtures. No `VITE_*` variable is used and the process environment is not exposed | `lib/speaker-review.test.ts`; `test:a11y:review` on the Vite dev server; a build with `--build-arg SPEAKER_REVIEW_ENABLED=true` shows the marker string in `dist/` and the default build does not (image check 12) |
| 13 | Development proxy for API and WebSocket | `next.config.mjs:80-92` rewrites, `lib/backend-base.mjs` (`INTERNAL_API_BASE`) | `server.proxy` in `frontend/vite.config.ts` (`/api` with `ws: true`, `/health`), target `DEV_API_BASE`, default `http://127.0.0.1:8000`; `changeOrigin: false` so the browser's `Origin` still reaches the BFF's same-origin check | Task B2.10 (a live session through the dev server against the real backend) |
| 14 | The gate's web servers | `frontend/playwright.config.ts:73-83` (`next dev`), `playwright.review.config.ts`, `playwright.branding.config.ts`, `playwright.prod.config.ts` (`next build` + `tests/prod/serve.mjs`), `package.json` `dev:stub` | The dev profile on Vite (B2.4); the real profile and `test:prod` on the real backend (B3.2, B3.3); the image profile (B4.2). See "Test profiles" | the gate itself |
| 15 | Development pages out of production | `app/dev/*/page.tsx` gated by `NODE_ENV` and `FOUNDATION_CHECK` (`next.config.mjs:9`) | `import.meta.env.DEV` or `--mode check` decides which routes exist; a default build contains none, and a test says so | a build test that a default `dist/` has none of the fixtures' marker strings (`Grundkontroll`, the review fixtures'); image check 13 (in the default image `/dev/foundation` loads the app, which has no such route and goes to `/`) |
| 16 | The organisation's mark with no wrong municipality before initialisation, no executable inline script | `app/layout.tsx:27` reads `/api/branding` on the server per request (`force-dynamic`), `<link href="/api/branding/theme.css">` in the head at line 34 | The backend writes the answer of `/api/branding` into `index.html` once at start (a `<meta name="eneo-branding">`, not a script); the page reads it before the first render; the accent link stays in the head | `tests/prod/branding.spec.ts` and `first-paint.spec.ts` (no `/api/branding` request in production, mark in the first frame), `backend/tests/test_web.py`, `test:a11y:branding` |
| 17 | No HTML for a missing file or an unknown `/api/*` path | Next answers its own HTML 404 for an unknown `/_next/static/x.js` | `web.py` rules in "Static serving rules" | `test_web.py`, `routes.spec.ts`, image check 4 |
| 18 | Compression | Next gzips what it serves (`compress` is on by default; whether it also gzips proxied API JSON is not known: Task B0.1 measures it) | Precompressed brotli and gzip files beside each asset, chosen by `Accept-Encoding`; the API is not compressed by the module unless B0.1 shows Next does | `test_web.py`, `weight.spec.ts` |
| 19 | The Next-only body and silence limits | `experimental.proxyClientMaxBodySize: "2gb"`, `proxyTimeout: 1_860_000` in `next.config.mjs:14-27` | Gone with the hop. The backend's own `MAX_UPLOAD_BYTES` (a cap on the whole request body, multipart overhead included) and its total upload deadline are the limits. Traefik's entrypoint read and idle timeouts and any `maxRequestBodyBytes` are then the only layer in front of them: they are the deployment's, are written down in `docs/operations.md` and read at B6.1 | `test_body_limits.py`; image checks 9 and 16 |
| 20 | `X-Powered-By` off, server banner | `poweredByHeader: false` | `server_header=False` in `serve.py` | `test_serve.py` |
| 21 | Files in `public/` | `public/live-pcm-worklet.js` (loaded by `AudioWorklet.addModule` under `script-src 'self'`, `components/flow/live-audio.ts:10`), `public/brand/*.svg` | Vite copies `public/` to `dist/`; `web.py` serves a file with an extension from the root of `dist/` | `routes.spec.ts` (200, `text/javascript`), gate state `stromma` on the real target |
| 22 | Graceful stop | supervisord `stopasgroup`/`killasgroup` | `timeout_graceful_shutdown=5` in `serve.py` (reserves time for cancelled streams and lifespan cleanup before Docker kills at 10 s) | `test_serve.py`; image checks 10 and 16 |
| 23 | Colour mode, no flash | `next-themes` (class on `<html>`, pre-paint inline script, key `theme`), the CSS bridge `html.dark … { color-scheme }` in `app/globals.css`, ADR 0003 | `ColorModeProvider` copied from the kit (same key and values), a parser-blocking same-origin `color-mode.js` for the first paint, selectors on `data-theme` | `color-mode.spec.ts` (kept), `first-paint.spec.ts` (slow and blocked JS, on a production build), ADR 0008 supersedes 0003 |
| 24 | Scheme and client address behind Traefik | Next (127.0.0.1) proxies to uvicorn and forwards `X-Forwarded-Proto`; uvicorn trusts forwarded headers from loopback only | Traefik reaches uvicorn from a non-loopback address, so uvicorn ignores `X-Forwarded-*` (default, left unchanged). The module reads no scheme, host or client address (`rg "request\.url\|base_url\|client\.host" backend/app` finds only `_rebase_signed_url`, which is about Eneo's URL). The one scheme-dependent output is Starlette's trailing-slash 307, whose `Location` would say `http://` (verified in a scratch app: `Location` follows the scope's scheme); row 25 removes it | image check 3 asserts no route of the app redirects |
| 25 | Trailing slash and redirects | Next strips a trailing slash when it forwards (measured on the image: `/runtime-files/?x` arrives as `/runtime-files?x`), so the backend never sees the slash the frontend sends. `lib/api.ts` calls `/api/eneo/flows/…/` with a slash and `/api/config`, `/api/auth/*`, `/audio`, `/content` without; `_resolve_proxy_path` accepts the slashless form because of this | The backend sees the exact path, and the compensation is deleted: `_resolve_proxy_path` goes, an allowlisted path is matched as spelled, its slashless form is refused like any other path. `redirect_slashes=False`: a slash variant that is not a route is a 404, never a 307 whose `Location` says `http://` behind Traefik (mixed content for a `fetch` on an HTTPS page). A twin the frontend does use gets its own route, as the upload routes already have | `test_slashes.py` (every route and its slash twin: never 307 or 308; the slashless form of an allowlisted path is a 403); the sentinel of B3.2 (no request of any state of the real gate is redirected) |
| 26 | Upload memory and limits | Next's rewrite buffers the whole upload in its process (measured on the image: +61 MB for 58 MB, +308 MB for 300 MiB, +576 to +1077 MB for 1 GiB, +612 MB for two 300 MiB at once, released late); it keeps `Content-Length` (no chunked, no `Expect`); above its 2 GiB limit it forwards the declared length, stops at about 2 GiB and the client hangs, with no 413 | FastAPI spools to disk (`UploadFile`) and answers 413 itself (`MAX_UPLOAD_BYTES`, `BodyLimitMiddleware`) | image checks 9 and 16, measured with the method and scripts of the baseline (B0.1) |
| 27 | FastAPI's own documentation routes | Not reachable: Next forwards only `/api/*` and `/health` | `FastAPI(docs_url=None, redoc_url=None, openapi_url=None)`; `/openapi.json` is a 404, and `/docs` and `/redoc` are ordinary unknown pages | `test_web.py` |
| 28 | Restart and two containers at once | supervisord restarts either process (`autorestart=unexpected`, `startsecs=3`) | The container's restart policy (`restart: unless-stopped` in Compose, the platform's for the image). Two containers up at once misroute sessions, because the store is process-local (`ModuleSessionStore`): deploy by stop then start | `docs/operations.md`; B6.1 |
| 29 | Every consumer of the colour mode | `next-themes` writes a class on `<html>`; `app/globals.css:80-83` (the `html.dark … color-scheme` bridge) and `:130-132` (the `html.dark` and `html:not(.dark)` logo selectors) read it; `lib/brand.test.ts:73` asserts that selector text; `components/AccountMenu.tsx` uses `useTheme()`; `lib/accessibility.test.ts:55` has a `.dark` fallback for `--record` | One owner (`ColorModeProvider` and Astryx's `data-theme`). Every use that `rg -n '\.dark' frontend` finds moves to `data-theme` with a `prefers-color-scheme` fallback in the same task, before the bridge is deleted | `color-mode.spec.ts`, `lib/brand.test.ts`, gate states in both modes |
| 30 | Lazy chunks and old tabs | `next/dynamic` for `DateInput` (no recovery); `Markdown` in `components/flow/Markdown.tsx` (recovers: `200bcac`); `LazyTranscriptEditor` in `components/TranscriptPlayer.tsx` (no failure handling: a lost chunk leaves its skeleton for good) | The Markdown pattern for all three, as one shared hook: the content stays, a status line and a retry press, never a reload. A route chunk that cannot load goes to the root route's `errorElement`, which offers a reload as a person's choice | one unit test per loader (the chunk rejects, then a retry succeeds), `tests/prod/stale-chunk.spec.ts` (B3.3) |

Not carried over, on purpose: HSTS, COOP/CORP and any new header (the edge or a later change; the set is the one Next sends, minus the two `'unsafe-inline'`, plus the narrower `Permissions-Policy`); a runtime feature flag (item 12 stays a build-time constant; see decision D6).

## Reuse from the kit

The proven reference is the kit's pair of repositories (read-only, `/Users/ccimen/eneo/eneo-module-kit`, `/Users/ccimen/eneo/eneo-module-kit-ui`). Plan C moves this module onto released packages; until then each piece is copied or not, with the reason.

| Piece | Source | Decision |
|---|---|---|
| Static serving, SPA fallback, 404 rules, path-escape tests | `packages/bff/src/eneo_module_bff/web.py`, `tests/test_web.py` | **Copy**, with four changes (below). The test file is the model for `backend/tests/test_web.py`. |
| `serve()`: one worker, no access log, bounded WebSocket, graceful stop | `packages/bff/src/eneo_module_bff/serve.py`, `tests/test_serve.py` | **Copy** as `backend/app/serve.py`; the constants move to `limits.py`; `server_header=False` added. |
| The fake Eneo's module-login handshake (ticket, token, session, refresh, end-session control) | `eneo-module-kit-ui/template/stub-eneo/server.py` | **Copy** into `frontend/tests/e2e/stub-server.py` (B3.1), so the tests sign in the way production does. |
| `ColorModeProvider` | `packages/ui/src/color-mode.tsx`, `tests/color-mode.test.ts` | **Copy** (about 100 lines, same key and values, no inline script). Plus a first-paint script the kit does not have (Task B2.6). |
| Router link adapter | `template/web/src/main.tsx` (`RouterLink`) | **Copy the shape** into `kit/RouterLink.tsx`. |
| Vite config, `index.html`, entry | `template/web/vite.config.ts`, `index.html`, `src/main.tsx` | **Copy the shape**; this repository keeps its folder layout and its `@/` alias. |
| Image shape | `template/Dockerfile` | **Copy the shape** (web stage, packages stage, runtime without Node, `STATIC_DIR`, `python` as PID 1, health check on `/health`), without the kit's packages. |
| `BrandingProvider` | `packages/ui/src/branding.tsx` | **Do not copy.** It fetches `/api/branding` after the first render and shows the product name alone until the answer arrives, so the mark pops in and the header shifts. This module reads the answer from the page itself (item 16). The Codex review lists the kit's fetch as acceptable; the injection is kept because it removes a visible pop-in on every load, and B4.2 check 14 measures the header's layout shift: if the fetch version shows none, the marker half of B1.4 is deleted and this row changes. Say so on the kit's board when Plan C starts. |
| Security-header middleware | `web.py` `add_security_headers` (`@app.middleware("http")`) | **Copy the `setdefault` precedence and the shape of the header set, not the mechanism and not every value.** `@app.middleware` is Starlette's `BaseHTTPMiddleware`, which wraps the response body iterator; this app streams audio and PDFs with `BackgroundTask(upstream.aclose)` and Range. Use a pure-ASGI middleware like `BodyLimitMiddleware` (`backend/app/limits.py`) and test a streamed response and a client that disconnects. `Permissions-Policy` is this module's (`microphone=(self)`), never the kit's `microphone=()`, which would stop the recording. |
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

Range for audio and for generated files is the API's, not this table's: `/api/eneo/.../audio` and `.../artifacts/.../content` are streamed by `_stream_signed` with the browser's `Range`, `If-Range` and `Accept` passed to Eneo, and `Cache-Control: private, no-store`; nothing here changes them, and image check 7 proves them. Static files do not need Range.

`index.html` is read once at start. The backend replaces the one marker `<meta name="eneo-branding" content="">` with the escaped JSON of what `GET /api/branding` answers, and computes the ETag of the result. A missing or duplicated marker stops the start (a failed start is better than a page that shows no organisation).

Security headers, `backend/app/security_headers.json` (read by `web.py`; the one definition):

```json
{
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), midi=(), microphone=(self)"
}
```

Against `next.config.mjs:36-66` the differences are: the two removed `'unsafe-inline'`, the removed dev-only `'unsafe-eval'`, and a `Permissions-Policy` that also switches off `display-capture`, `usb`, `serial`, `hid`, `bluetooth`, `payment` and `midi` (sec-media's finding). `microphone=(self)` stays: the kit's default is `microphone=()`, and this module records.

**Precedence.** The defaults are applied with `setdefault` to every response, `/api/*`, signed-file streams, redirects and errors included. A header an endpoint sets wins: the inline PDF's `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'`, the SVG logo's sandbox CSP, and whatever `_stream_signed` sets (`nosniff`, the disposition rule of `1203d64`). The list of tests in B1.2 names each of them.

**Contract details.** `FastAPI(docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)`: `/openapi.json` is a 404 (it has a dot), `/docs` and `/redoc` are ordinary unknown pages; a slash twin of a route is a 404 and never a redirect (item 25). `/health` and `/api/healthz` are real routes registered before the fallback, so a broken build cannot answer the image's health probe with HTML. The launcher refuses to start unless `STATIC_DIR` holds the built `index.html` (`python -m app.serve --api-only` is for development against the Vite dev server and for tests).

## Evidence for `style-src 'self'` and `script-src 'self'`

Read, not yet run (this worktree has no `node_modules`; B3.2 runs it):

- **Script.** The inline script in the HTML today is Next's hydration bootstrap and next-themes' pre-paint script. A client-only Vite build has neither: its entry is `<script type="module" src>`. The first-paint script becomes a same-origin file (Task B2.6). The kit's trial ran Vite 8 with Astryx 0.6.3 under `script-src 'self'; style-src 'self'` in Chromium and WebKit with no console or CSP error (design section 7).
- **Style, Astryx 0.6.3** (`node_modules/@astryxdesign/core/dist`, read in the main checkout): `theme/Theme.js:142-170` creates `<style>` elements only when the theme is not built (`theme.__built` false). `kit/theme/built/eneo.js` is built and `weight.spec.ts` fails on any `style[data-astryx-theme*]`. `CodeBlock/highlightStyles.js:87` creates one `<style>` when a `CodeBlock` renders; `rg CodeBlock` over `app components kit lib` finds none (re-check in B3.2). `hooks/useAnnounce.js:74` sets `el.style.cssText`, which is the CSSOM, not a `style` attribute in markup; the CSP specification does not apply `style-src` to CSSOM writes, and the sentinel of B3.2 confirms it in the browsers the gate uses.
- **Style, this module.** `rg "dangerouslySetInnerHTML|<style|setAttribute\(.style|innerHTML|insertAdjacentHTML|cssText"` over `app components lib kit` finds nothing outside tests. The one `style={…}` prop in the module is `components/flow/LevelMeter.tsx` (the level meter, recording only); React sets a style prop through the CSSOM when it renders in the browser, and the gate state `recording` under the sentinel proves it. What forces `style-src 'unsafe-inline'` today is Next's server-rendered HTML, which writes `style="…"` attributes into markup. A client-only app writes none.
- **Build.** Vite inlines assets under 4 KB as `data:` URIs by default; `build.assetsInlineLimit: 0` makes each a file, so `font-src 'self'` and `img-src` need nothing for them. `build.sourcemap: false`: a `.map` beside each asset would publish the source.
- **The evidence so far is narrower than the claim.** The existing strict-style test (`tests/prod/branding.spec.ts`) filters its failures to branding messages, and `tests/prod/smoke.spec.ts` covers the foundation page and the flow list. Nothing yet runs the recording, playback, the PDF preview, Markdown tables (react-markdown, remark-gfm), the date control (a popover), menus and dialogs under the policy. Direct style-property assignment is allowed by `style-src`; only markup `style` attributes, `setAttribute("style")` and `<style>` are not, so a `style` prop in the source proves nothing either way.
- **Proof, Task B3.2.** The real target runs the gate's states through the real backend's static serving and headers, with the stub as Eneo, with `securitypolicyviolation` events collected by an init script and asserted empty after every state; two CI projects on every change and all 19 at the phase exit. Dev mode cannot do this: Vite's dev server injects `<style>` for CSS. Two states that no gate state covers today, a date control (`setup-date`) and a Markdown table (`result-table`), are added in B2.5 for this reason.

## Review Focus

Conditions the tests do not all exercise and that are most likely to hurt a user:

1. **A hard reload or a link opened on `/flows/<id>?run=<id>` behind Traefik**, and the BFF's own redirect to `/inloggad?fel=utgangen`. Expected: the page, the same run, no 404.
2. **JavaScript slow or blocked on first load, with a stored colour mode that differs from the system's.** Expected: no frame in the wrong mode (the stored choice is applied before the first paint), a Swedish `<noscript>` text when scripts are off, and no flash of the wrong municipality. Pinned by `first-paint.spec.ts` on a production build.
3. **`AuthGate` and `LoginPage` re-running their effect on every navigation.** Both list the router in their effect dependencies (`components/AuthGate.tsx`, `app/LoginPage.tsx`). Next's router object never changes. With `BrowserRouter` (the kit template's choice) `useNavigate()` changes identity on every location change, which would re-read the session, restart the keep-alive and re-run the drafts clean-up on each page change. The data router's `useNavigate()` is stable. Use `createBrowserRouter`, and pin it with a test that counts `GET /api/auth/status` over a navigation.
4. **Leaving a page that holds work.** Back in the middle of a visit, Back on the first page of a visit, a link in the bar, Logga ut, reload, a `?run=` or `?recording=` written into the address by the page itself, Forward after "Stanna kvar", repeated Back while the question is open, with `StrictMode` double effects. Expected: the recording keeps running, the question comes once, and an address the page writes is never a departure. The first-entry case is covered by `beforeunload` alone (the browser's own question): there is no entry to put the question on once the sentinel is gone (see D8).
5. **A tab left open across a deploy.** Its `index.html` asks for chunks that no longer exist and gets a 404, not HTML (by design). Three lazy loaders (`Markdown`, `LazyTranscriptEditor`, `DateInput`) and the route chunks can fail. Expected: the content or field stays, a status line says what happened, and its one action, "Ladda om sidan", reloads only on the person's press; nothing reloads by itself and nothing that holds a recording or an edit unmounts. Native ESM keeps a failed import per URL (Chromium makes no second request for it, measured in `review-flag.spec.ts`), so a retry of the same `import()` cannot recover and the recovery is a reload the person starts, which is honest where the work is in a draft that survives it (the review and the details; a result's text has none to lose).
6. **The live socket with no proxy.** A browser frame over 128 KiB closes the socket with 1009 before Eneo sees it; a stalled browser ends the session in 15 s (existing relay tests). Through Traefik the upgrade, and the browser's `Origin` that the BFF's check reads, must arrive intact (image check 16). The live route takes UUIDs: the fixtures must be UUIDs (B2.5), or the real-backend live state is a lie.
7. **Uploads.** Next buffers the whole upload (about one file's size of RAM per upload, released late) and Plan B removes that; the 1 GiB upload and the aborted one must cost the backend's spooling only, and an upload over `MAX_UPLOAD_BYTES` answers 413 (Next hangs at 2 GiB). `MAX_UPLOAD_BYTES` caps the whole request body, so a benchmark that must complete sets it above the file's encoded size, and rejection is measured separately (check 9).
8. **Addresses the backend now sees exactly as the browser sent them**, with and without a trailing slash (Next stripped it). A redirect behind Traefik says `http://`.
9. **A shared event loop.** Static files, uploads and the live relay share one process (item 28 and check 15). A burst of first-time visitors must not delay live captions.
10. **Two containers up at once** misroute people whose sessions are in the other one: deploy by stop then start.
11. **Old assets are not kept.** A hashed file that is gone is a 404 with no HTML body, not the page.
12. **Focus and scroll after a navigation to a page that loads its content later** (every page behind `AuthGate`). Expected: the title is set at once; the announcement, the focus on the page's heading and the scroll happen when the page has its content, once; a control the page focused itself keeps focus; Back to a scrolled list lands where it was.
13. **Sessions that end during a test.** A logout test deletes its session on the server. Every test of a real target has its own session.

---

## How to work

### Test profiles

Seven ways to run tests; each says what runs where, so no spec asks a build for what it does not contain.

| Profile | Command (from `frontend/`) | Server and build | What runs | Fixtures it has |
|---|---|---|---|---|
| dev | `npm run test:a11y` | Vite dev server on `A11Y_APP_PORT`, the stub as the BFF | every gate spec, 19 projects | `/dev/foundation`, `/dev/speaker-review`, `/dev/dialog-leak` (dev routes) |
| dev, review | `npm run test:a11y:review` | the same, started with `SPEAKER_REVIEW_ENABLED=true` | `review-flag.spec.ts` | as dev |
| dev, branding | `npm run test:a11y:branding` | the same, the stub started as a branded deployment | the `branding-*` states | as dev |
| real | `npm run test:a11y:real` | `dist-check/` served by the real backend (`python -m app.serve`), the stub as Eneo, the strict policy | the gate's specs except those tagged `@dev-only` (`leaks`, `live-sheet`, `recording-short`, `review-flag`, `branding`: they need a dev fixture, or replace the live socket in the browser); two projects in CI, all 19 at the phase exit | `/dev/foundation`, `/dev/speaker-review` (a check build); not `/dev/dialog-leak` |
| prod | `npm run test:prod` | the real backend on `dist/` (project `shipped`, three engines), on `dist-check/` (project `fixture`, Chromium), and on `dist/` as a green deployment (project `branded`, Chromium); the stub as Eneo | `tests/prod/*` by project: `shipped` runs everything not tagged `@fixture` or `@branded`; `fixture` runs the `@fixture` tests (the foundation smoke test); `branded` the `@branded` ones (the accent) | by project |
| image | `npm run test:image` (runs `../deploy/acceptance.sh`) | the default image behind Traefik, the stub as Eneo | the `shipped` project against it (Chromium), the real target's claim states for `phone-390-light` against it, and the image checks of B4.2 | none shipped |
| unit | `npm test`, `backend/` unittest | jsdom, TestClient and in-process fakes | | |

A spec belongs to a profile by its tag (`@dev-only`, `@fixture`, `@branded` in the test title, matched by `grep` and `grepInvert` in each config), never by a runtime skip.

### Checks, fastest first

| Command (from `frontend/` unless stated) | What it proves | When |
|---|---|---|
| `npm run lint` | Types | after every edit |
| `npm test` | Unit tests | after every task |
| `.venv/bin/python -m unittest discover -s tests` (from `backend/`) | Backend, including `test_web.py`, `test_serve.py`, `test_slashes.py` | after every backend task |
| `npm run test:a11y -- a11y.spec.ts -g "<state>" --project=phone-320-light --project=laptop-1440-dark` | One state, dev profile | while porting |
| `npm run test:a11y` | The gate, dev profile | before finishing a phase |
| `npm run test:a11y:real` | The gate through the real backend under the strict policy | Task B3.2 on, CI, phase exit |
| `npm run test:prod` | The built app served by the real backend | before finishing a phase from B3 |
| `npm run test:image` | The production image | Phase B4 exit |
| `docker build -t eneo-mod-speech-to-text:test .` | The image builds | before finishing B4 |

### Commands that exist after Phase B2

| Script | Does |
|---|---|
| `npm run dev` | `vite` on 0.0.0.0:3002, `/api` and `/health` proxied (HTTP and WebSocket) to `DEV_API_BASE` |
| `npm run dev:stub` | the stub backend and `vite` together (replaces the `next dev` one-liner in `package.json`) |
| `npm run build` | `tsc --noEmit && vite build && node scripts/finish-build.mjs dist` (hashes `color-mode.js`, checks the branding marker, writes `.br` and `.gz` beside each asset); output `dist/` |
| `npm run build:check` | `tsc --noEmit && vite build --mode check && node scripts/finish-build.mjs dist-check`: also compiles `/dev/foundation` and `/dev/speaker-review`; output `dist-check/` |

### Stop conditions

Stop, leave the branch as it is, and report to the owner if any of these happens:

- A component cannot run under `style-src 'self'` and the only fix is `'unsafe-inline'` (or `style-src-attr`).
- `useBlocker` cannot hold the leave question in the scenarios of Task B2.9 without bringing back an extra history entry (the owner ruled the entry out; report it, do not restore it).
- `react-router` cannot be loaded and driven by the unit tests' CommonJS build under the Node floor the repository declares, and the ESM build of the tests is not a one-task change (B2.1 Step 3).
- A gate threshold would have to be lowered, a test name would disappear, or an ARIA snapshot changes beyond the removal of Next's announcer and the new route announcer.
- A missing file or an unknown `/api/*` path answers HTML anywhere.
- The production image uses more resident memory at idle than the two processes of the image built in B0.1 together, or its first-load transfer is more than 5 % above that image's compressed JS and CSS on the same pages, or the live relay's p95 under static load is more than twice its idle p95 (B4.2 check 15), with no reason that the owner accepts. The owner accepted the stress result of check 15 on 2026-10-04; the reason and the measured numbers are recorded in `deploy/acceptance/waivers.json`, and the check keeps failing and prints `FAIL (waived: ...)`.

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
| `main.tsx` | CSS order, `StrictMode`, `RouterProvider`, `history.scrollRestoration = "manual"` |
| `routes.tsx` | the route table, `handle.title` per route, route-level `lazy` for `FlowPage`, `FlowsPage`, `LoginPage`, `SignedInAgain`, dev routes only when allowed |
| `routes/Root.tsx` | providers, `RouteEffects`, `Outlet`, root `errorElement` and `HydrateFallback` |
| `routes/RouteEffects.tsx` | title, announcement, focus and scroll once per navigation; exports `useRouteReady` |
| `kit/RouterLink.tsx` | `href` to react-router's `to` for an in-app path (for `LinkProvider` and for `as={RouterLink}`); a plain `<a>` for anything else |
| `kit/ColorModeProvider.tsx` | copied from the kit; `useColorMode()` replaces `useTheme()` of next-themes |
| `public/color-mode.js` | the first-paint script; the build renames it to `assets/color-mode.<hash>.js` |
| `scripts/finish-build.mjs` | takes the output directory as its argument: hash the script and rewrite `index.html`, check the marker, precompress |
| `vite.config.ts` | alias, `define`, dev proxy, build options |
| `lib/lazy-component.ts` | the one recoverable loader of the three lazy imports (`Markdown`, `LazyTranscriptEditor`, `DateInput`) |
| `lib/test-router.ts` | `withRouter` for the unit tests |
| `tests/fixtures/ids.json` | the UUIDs of the stub's flows, read by the stub and by the gate (B2.5) |
| `tests/e2e/route-change.spec.ts`, `tests/e2e/leave-guard.spec.ts` | route effects and the leave blocker, in a real browser |
| `tests/e2e/sentinel.ts`, `tests/e2e/auth.ts` | the policy, error and redirect sentinel; the test-scoped sign-in of the real profile |
| `tests/prod/*.spec.ts` (`headers`, `routes`, `first-paint`, `stale-chunk`, `upstream`), `tests/prod/start-backend.mjs` | production proof |
| `backend/app/web.py`, `backend/app/security_headers.json`, `backend/app/serve.py` | static serving, the one header definition, the launcher |
| `backend/tests/test_web.py`, `backend/tests/test_serve.py`, `backend/tests/test_slashes.py` | their tests |
| `deploy/acceptance.sh`, `deploy/acceptance/` (`compose.yml`, `traefik.yml`, `checks.py`, `upload/`) | image acceptance, with the stub of `frontend/tests/e2e/` as Eneo |
| `docs/decisions/0008-static-ui-served-by-the-bff.md` | the decision |

Deleted in Phase B2, B4 and B5: `frontend/lib/leave-guard.ts` (B2.9), `deploy/supervisord.conf`, `backend/Dockerfile`, `frontend/Dockerfile`, `backend/requirements-runtime.txt`, `frontend/next.config.mjs`, `frontend/lib/backend-base.mjs`, `frontend/tests/prod/serve.mjs`, `frontend/tests/next-types.d.ts`, `frontend/components/theme-provider.tsx`, `next`, `next-themes` and the Next lint comments.

---

## Why phases, and why one branch for the UI

| Phase | Lands on | Why |
|---|---|---|
| B0 Baseline | `main` | The claims "lighter, faster" and "nothing lost" need the numbers of the image as it is |
| B1 The backend serves a built UI | `main` | Additive: nothing changes while `STATIC_DIR` is unset. Proves the whole server side on its own tests before any UI moves |
| B2 The UI on Vite and react-router | integration branch `feat/one-process` | Next and Vite cannot both be the entry of one source tree: 10 files import `next/*`, 2 import `next-themes`, the test harness mounts `AppRouterContext`. A bridge layer over both would touch the same files twice and add an abstraction that is thrown away. The branch is not runnable by `test:prod` or the real profile between B2 and B3; those are rebuilt there |
| B3 Production-shaped proof | `feat/one-process` | One fake Eneo, the real backend, the strict policy: the gate and `test:prod` on it |
| B4 The image | `feat/one-process` | One process, no Node; compose; the acceptance on the image |
| B5 Remove Next, docs | `feat/one-process` | Deletion and records |
| B6 First deployment | `feat/one-process` to `main` | One merge, only when the image acceptance and the owner's try-out pass |

One branch is safer than a Next/Vite hybrid because the branch is merged only after the whole gate, `test:prod` and the image acceptance pass on the finished result. Merge `main` into `feat/one-process` at the start of every phase.

---

## Phase B0 — Baseline

Result: the numbers of the image as it is, so "not heavier, not slower, nothing lost" can be judged against facts.

### Task B0.1: Measure the current image

**Files:** Create `deploy/acceptance/upload/` (a copy of the upload-measurement scripts, so the acceptance repeats the baseline's method). Output goes in a comment on the bead and in the pull request text of B4.2.

- [ ] **Step 1: Build and run the image** from the commit this plan starts from: `docker build -t stt-before .`, run it with the stub as its Eneo or with a throw-away `.env` (it needs no Eneo to start). Record `docker image ls stt-before` (size), the time to `healthy`, and resident memory of both processes at idle and after `/flows` was loaded 20 times (`docker stats --no-stream`, and `docker top`).
- [ ] **Step 2: Response headers** (`curl -sI` and `curl -s -D- -o /dev/null`) for: `/`, `/flows`, `/flows/x`, `/inloggad?fel=utgangen`, `/_next/static/<one chunk>`, `/live-pcm-worklet.js`, `/health`, `/api/nope`, `/not-a-page`, `/_next/static/missing.js`, and `HEAD /`. Record status, `content-type`, `cache-control`, `content-encoding`, `etag`, and whether the body is HTML. These are the "today" column of the cache and 404 rows.
- [ ] **Step 3: Compression.** `curl -s -H 'Accept-Encoding: gzip' -D- -o /dev/null` on a proxied JSON answer (a large one: the stub's `transcript-words`, or any 50 KB+ JSON the stub serves) and on a JS chunk. Record whether Next compresses proxied API JSON. This decides item 18's API half.
- [ ] **Step 4: Page weight.** `node docs/plans/page-cost.cjs <frontend dir> <base url> before` on `/flows` and `/flows/<a flow id>` (Plan A Task 0.6; the production build served with the stub). Record compressed transfer, LCP, total blocking time and layout shift on the throttled profile.
- [ ] **Step 5: What a first-time visitor's CPU and RAM cost.** Record the Node and the uvicorn processes' `ps -o rss,pcpu` while 10 browsers poll an open flow run (`?run=`) for a minute. It is the number Plan B should lower.
- [ ] **Step 5b: The upload baseline, with the method the acceptance repeats.** Run the lead's upload scripts (in the lead's scratchpad, `scratchpad/upload/`; copy them into `deploy/acceptance/upload/` in this step) against the image: 58 MB, 300 MiB, 1 GiB, and two 300 MiB at once; record Next's and the backend's resident memory before, at peak and after. Measured on the same image already, to be confirmed here: Next buffers the whole upload (+61 MB for 58 MB, +308 MB for 300 MiB, +576 to +1077 MB for 1 GiB, +612 MB for two 300 MiB, released late); it keeps `Content-Length` (no chunked, no `Expect`); above its 2 GiB limit it forwards the declared length, stops at about 2 GiB and the client hangs with no 413; and it drops a trailing slash when it forwards (`/runtime-files/?x` arrives as `/runtime-files?x`).
- [ ] **Step 6: Comment the table on the bead.** The only commit is the copied scripts: `test(deploy): the upload measurement of the baseline`.

**Acceptance:** the table exists with the values above and its source commands. If Step 1 cannot run (no Docker), say so; later "not heavier" claims then rest on `page-cost.cjs` alone.

---

## Phase B1 — The backend serves a built UI

Result: `STATIC_DIR=<dist> python -m app.serve` serves the app, the headers, the rules and the limits, with tests. Unset, nothing changes for the running system, so this phase can go to `main` first.

### Task B1.1: One launcher, and the WebSocket limits in one place

**Files:**
- Create: `backend/app/serve.py`, `backend/tests/test_serve.py`
- Modify: `backend/app/limits.py` (the two constants), `deploy/supervisord.conf`, `backend/Dockerfile`, `README.md`, `docs/development.md` (the dev command), `backend/tests/test_live_relay.py` (`launch_commands`, the parity test)

**Interfaces — Produces:** `app.limits.WS_MAX_MESSAGE_BYTES = 128 * 1024`; `app.serve.serve(app, *, host, port, reload=False, api_only=False)`; `python -m app.serve [--host H] [--port P] [--reload] [--api-only]` runs `app.main:app` (defaults `0.0.0.0` and `3001`). Without `--api-only` it refuses to start unless `STATIC_DIR` holds the built `index.html` (non-zero exit and a message that names the folder); `--api-only` is for development against the Vite dev server, for tests, and for the two launch paths that still sit behind Next until B4.

- [ ] **Step 0: Check the prerequisite.** List `git log --oneline 8e861ec..HEAD -- backend/app`, read each commit's diff of `main.py`, `module_auth.py`, `limits.py` and `config.py`, and run `cd backend && .venv/bin/python -m unittest discover -s tests`. The page's user is required for writes and the live socket (`501d9cc`); the signed-file rule is in (`1203d64`). If a commit named under "Prerequisite, named" is missing or a test is red, stop.
- [ ] **Step 1: Write the failing tests** (model: the kit's `packages/bff/tests/test_serve.py`): `serve()` calls `uvicorn.run` with `workers=1`, `access_log=False`, `server_header=False`, `ws_max_size=WS_MAX_MESSAGE_BYTES`, `timeout_graceful_shutdown=8`; an override of `workers`, `access_log` or the size limit raises `ValueError` and does not start; without `api_only` and without a built UI it exits with the message and does not start; the size limit is at least 64 KiB, and a real uvicorn holds a flooding sender back (the queue holds a message or two, `test_live_relay.py`).
- [ ] **Step 2: Implement `serve.py`** (copy from the kit; add `server_header=False`, the removed overrides, `reload` and `api_only`; `reload=True` runs the app as the import string `app.main:app`).
- [ ] **Step 3: Make every launch path the launcher.** `deploy/supervisord.conf` `command=/opt/venv/bin/python -m app.serve --api-only --host 127.0.0.1 --port 8000`; `backend/Dockerfile` `CMD ["python","-m","app.serve","--api-only","--port","8000"]`; the README and `docs/development.md` dev command `python -m app.serve --api-only --host 0.0.0.0 --port 8000 --reload`. (Both files are deleted in B4; until then the parity test keeps guarding them.)
- [ ] **Step 4: Rewrite the parity test.** `launch_commands()` returns the three launch commands above and, from B4 on, the root `Dockerfile`'s `CMD`; the test asserts each runs `app.serve` and not `uvicorn`, and that `serve()` passes the constants. Keep `test_production_limits_refuse_an_oversized_message_before_eneo`, which now takes its limits from `limits.py`.
- [ ] **Step 5: Run** `.venv/bin/python -m unittest discover -s tests`. Expected: green, including the real-uvicorn 1009 test.
- [ ] **Step 6: Commit.** `feat(backend): one launcher sets the WebSocket limits, one worker and a graceful stop`

### Task B1.2: Security headers on every response, and `/health`

**Files:**
- Create: `backend/app/security_headers.json`, `backend/app/web.py` (headers part), `backend/tests/test_web.py` (headers part)
- Modify: `backend/app/main.py` (register the middleware outermost; `/health` and `/api/healthz` as one `api_route(methods=["GET","HEAD"])`; `FastAPI(docs_url=None, redoc_url=None, openapi_url=None)`)

- [ ] **Step 1: Write the failing tests.** Each of these carries every header of `security_headers.json` with the file's value, except where the endpoint's own header must win:
  - an `/api/*` JSON answer (`/api/config`), a 4xx (`/api/eneo/x` refused, a 404), a 413, a 303 redirect (`/api/auth/login`), a 409 `user_changed`, `/health`, `/api/healthz`, the HTML page (B1.3), a missing file;
  - a streamed signed-file answer (inline audio, an attachment) abandoned half-way by the client still closes its upstream through the middleware (the `test_audio_proxy.py` pattern), and keeps `_stream_signed`'s own `nosniff` and disposition;
  - the inline PDF keeps its route's `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'`, and no other response has those two;
  - an SVG logo (`/api/branding/logo/light`) keeps its sandbox CSP and does not get the default one;
  - the policy contains `script-src 'self'`, `style-src 'self'`, no `unsafe-inline`, no `unsafe-eval`, `frame-ancestors 'none'`; `Permissions-Policy` contains `microphone=(self)` and not `microphone=()`, and switches off `camera`, `geolocation`, `display-capture`, `usb`, `serial`, `hid`, `bluetooth`, `payment`, `midi`;
  - `/docs`, `/redoc` are not FastAPI's pages and `/openapi.json` is a 404 JSON.
- [ ] **Step 2: Implement.** A pure-ASGI middleware (model: `BodyLimitMiddleware`): on `http.response.start` add each header the response lacks (`setdefault`). Register it outermost so the 413 of `BodyLimitMiddleware` and every 404 carry the headers.
- [ ] **Step 3: Run** the backend tests. **Step 4: Commit.** `feat(backend): the security headers are the backend's, one definition, on every response`

### Task B1.3: Static serving, no slash tolerance, and its rules

**Files:**
- Modify: `backend/app/web.py` (`serve_web`), `backend/app/config.py` (`static_dir: Path | None` from `STATIC_DIR`), `backend/app/main.py` (call `serve_web` last when set; `redirect_slashes=False`; delete `_resolve_proxy_path` and call `_proxy_route_is_allowed` directly; add a route for any slash twin the frontend uses), `backend/tests/test_web.py`, `backend/tests/test_eneo_proxy_auth.py` (the tests of the tolerance), `backend/tests/test_slashes.py`

- [ ] **Step 1: Write the failing tests first**, from the kit's `test_web.py` and the rules table: every route of the app (`/`, `/flows`, `/flows/abc`, `/flows/abc?run=r`, `/inloggad`, `/inloggad?fel=utgangen`, a trailing slash) is the page with `Cache-Control: no-cache` and an ETag; a second request with `If-None-Match` is a 304 with the headers; `/api`, `/api/`, `/api/nope`, `/api/auth/nope/deeper` are 404 JSON; `/assets/x.js` that exists is 200 with `immutable`; a missing `/assets/x.js`, `/logo.png`, `/a/b/style.css` is 404 with no `<title>`; `/live-pcm-worklet.js` is 200 `text/javascript`; `/index.html` is the processed page and `/assets/x.js.br`, `/assets/x.js.gz` are 404; every escape of the kit's list plus `/%00`, `/a%00.js`, `/a\\b.js`, `/..%5Csecret.txt` is 404 and never a 500 and never contains the secret; `HEAD` of the page and of `/health` is 200 with no body; the module's own routes win over the fallback; `/health` answers JSON even when `index.html` is missing from a folder that was never checked (the launcher, not the route, refuses to start, B1.1); without `STATIC_DIR` the app serves no page and `GET /` is 404.
- [ ] **Step 1b: `test_slashes.py`.** For every route of `main.app.routes` (HTTP and WebSocket) and for every entry of `_PROXY_ROUTE_RULES`, the path the frontend sends and its slash twin: the answer is never a 301, 302, 307 or 308. Collect the paths the frontend builds from `frontend/lib/api.ts` (`/api/eneo/flows/…/` with a slash; `/api/config`, `/api/auth/*`, `…/audio` and `…/content` without) and assert each reaches its handler exactly as written (a session-less call is the 401 of `require_session`, not a 404 or a redirect). The slashless form of an allowlisted proxy path is a 403 (`Eneo resource is not exposed`), as any other path that is not spelled on the list. A twin that is not a route is a 404 with a JSON body. If the frontend uses a twin that has no route, add the route, as the upload routes already have both forms.
- [ ] **Step 2: Run, see them fail.** Expected: the `%00` cases (500) and `HEAD` (405) fail first; the backslash cases already pass; a slash twin answers 307 until `redirect_slashes=False`; the slashless allowlisted path is still forwarded until `_resolve_proxy_path` goes.
- [ ] **Step 3: Implement** (kit's `serve_web` with the four changes in "Reuse from the kit"). Reuse `_etag_matches` (move it to `web.py`; `get_branding_theme` imports it). Register `serve_web` last. Delete `_resolve_proxy_path` and the tests that pinned the tolerance.
- [ ] **Step 4: Run** the backend tests. **Step 5: Commit.** `feat(backend): serve the built UI, with 404 and not HTML for a missing file or an unknown API path, and no slash redirects or slash tolerance`

### Task B1.4: Precompressed files and the branding marker

**Files:**
- Modify: `backend/app/web.py`, `backend/tests/test_web.py`

- [ ] **Step 1: Failing tests.** With `<file>.br` and `<file>.gz` beside `assets/app.js`: `Accept-Encoding: br, gzip` gets the `.br` with `Content-Encoding: br`, `Vary: Accept-Encoding`, `Content-Type: text/javascript`; `gzip` alone gets the `.gz`; none gets the plain file; a `Range` request for a precompressed file is answered 200 whole; the page itself is not precompressed. For the marker: `index.html` with `<meta name="eneo-branding" content="">` is served with the content set to the HTML-escaped JSON of `{"organization": …}` exactly as `GET /api/branding` answers (default organisation, a named one, none: `SHOW_ORGANIZATION=false`), including a name with `"`, `<`, `&` and `'`; a different ETag per different organisation; an `index.html` with no marker, or two, refuses to start with a message naming the file.
- [ ] **Step 2: Implement.** Read `index.html` once in `serve_web`; the replacement uses `html.escape(json, quote=True)`. Negotiate only for extensions `.js .css .svg .json .html .txt` that have a sibling. If B0.1 showed Next gzips proxied API JSON, add JSON-only compression of the non-streaming proxy route here (never Range, audio or PDF) and say so on the bead.
- [ ] **Step 3: Run** the backend tests. **Step 4: Commit.** `feat(backend): precompressed assets by Accept-Encoding, and the organisation written into the page at start`

### Phase B1 exit

| Area | Required |
|---|---|
| Backend | `.venv/bin/python -m unittest discover -s tests` green; `test_web.py`, `test_serve.py` and `test_slashes.py` exist and pass |
| Surface | No route under `/api` changed, apart from the deleted slash tolerance and the removed docs routes (the diff of `main.py` is the middleware, the aliases, `serve_web` and those two deletions) |
| Limits | Every launch path is `app.serve`; the parity test asserts it |

---

## Phase B2 — The UI on Vite and react-router

Result: on the integration branch the app builds with Vite and runs in the dev server and in the dev profile of the gate, with Next removed from the source (not yet from `package.json`). Tasks B2.1 to B2.10 are commits on `feat/one-process`. Each task's checks use only the tasks before it: the dev profile arrives in B2.4, before any browser test of B2.6 to B2.9.

### Task B2.1: Toolchain, entry, the Node floor and the route table

**Files:**
- Create: `frontend/vite.config.ts`, `frontend/index.html`, `frontend/main.tsx`, `frontend/routes.tsx`, `frontend/routes/Root.tsx`, `frontend/kit/RouterLink.tsx`, `frontend/public/color-mode.js` (empty placeholder until B2.6), `frontend/scripts/finish-build.mjs`, `frontend/lib/test-router.ts` (the probe of Step 3 starts it)
- Modify: `frontend/package.json` (add `vite`, `@vitejs/plugin-react`, `react-router`; `engines.node`; scripts above; keep `next` for now under `dev:next`/`build:next`), `frontend/tsconfig.json` (remove the `next` plugin, the `files` entry for `next/types/global.d.ts`, `next-env.d.ts` and the `.next` includes; add `"types": ["vite/client"]`), `AGENTS.md` and `docs/development.md` (the Node floor), `.dockerignore` (`**/dist`, `**/dist-check`); `.gitignore` already lists `dist/`

**Interfaces — Produces:** `routes.tsx` exports `router` (`createBrowserRouter`) with `handle: { title: string }` per route; `kit/RouterLink.tsx` exports `RouterLink({ href, ...rest })` rendering react-router's `Link to={href}` only for an in-app path (starts with `/`, not `//`, not under `/api/`, no `download`, and no `target` other than `_self`) and a plain `<a>` for everything else. Why: `LinkProvider` makes every Astryx `Link` and every link `Button` a router link, and the module has links that are not pages: `components/flow/ResultDocument.tsx:206` and `ResultFiles.tsx:146` open an API file in a new tab (`<Button href=… target="_blank">`), `ResultFiles.tsx:62` `DownloadLink` is a plain `<a download>`. A router link to `/api/…` would be a client navigation to a path the router has no route for (it would land on `/` through the `*` route). The AppShell skip link (`dist/AppShell/AppShell.js:500-505`) and `TranscriptPlayer`'s skip link are plain anchors and stay so. `scripts/finish-build.mjs <outDir>` finishes the build in the directory it is given, and nowhere else.

- [ ] **Step 1: Versions and engines.** `npm view vite version engines`, `npm view @vitejs/plugin-react version engines`, `npm view react-router version engines`; install the latest, exact. react-router 8.4.0 declares Node `>=22.22.0`, and `frontend/package.json` declares `>=22.13.0`: set `engines.node` to the highest floor among the new dependencies and Astryx's CLI, and say so in `AGENTS.md` (which names the Plan A floor) and `docs/development.md`. The CI, devcontainer and Dockerfile ask for Node 22 and get the current 22.x; check that it is at or above the floor. Read `frontend/AGENTS.md` and run `npm run astryx -- doctor`.
- [ ] **Step 2: `vite.config.ts`**

```ts
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const API = process.env.DEV_API_BASE ?? "http://127.0.0.1:8000";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // `@/x` is `<frontend>/x`, as tsconfig "paths" says; the regex consumes the slash, so no `//` is left in the path.
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }] },
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

- [ ] **Step 3: The probe, before any edit depends on react-router.** `tsconfig.test.json` is `module: commonjs`, which compiles `await import("react-router")` to a `require`; react-router 8.x is an ES module (`"type": "module"`). In `lib/test-router.ts` and a first test, `lib/test-router.test.ts`, compiled by `tsc -p tsconfig.test.json` and run by `npm test` with jsdom and the existing `lib/test-dom.ts`: `createMemoryRouter` plus `RouterProvider`, a link click, a `navigate(-1)`, a `useBlocker` that blocks and proceeds. In the kit's checkout `require('react-router')` works on Node 22.23 (an ES module through `require`, available from 22.12); that is not proof for the whole declared range, so run this on the floor from Step 1 as well (`node --version` in the commit message). If it cannot be made to pass, stop and report: the kit's tests run react-router under ESM (`packages/ui/tests/readme.test.ts`).
- [ ] **Step 4: `index.html`** (tags only; the first-paint script and the marker are filled in B2.6 and B2.7):

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

- [ ] **Step 5: `main.tsx`.** Imports in this order: `./styles/layers.css`, `@astryxdesign/core/reset.css`, `@astryxdesign/core/astryx.css`, `@/kit/theme/built/eneo.css`, `./styles/globals.css` (the same order as `app/layout.tsx:7-11`); `history.scrollRestoration = "manual"` (RouteEffects owns scroll, B2.8); then `createRoot(...).render(<StrictMode><RouterProvider router={router} /></StrictMode>)` with `RouterProvider` imported from `react-router/dom` (the DOM entry; `react-router` has the non-DOM one that the unit tests use). Verified in the kit's checkout on 2026-10-01 against react-router 8.4.0: `react-router/dom` exports `RouterProvider`, and `react-router` exports `createBrowserRouter`, `useBlocker`, `useNavigate`, `useMatches`, `useParams`, `useSearchParams`. `StrictMode` stays: Next's app router runs it in development and the gate was tuned with double effects.
- [ ] **Step 6: `routes.tsx`.** The five routes of "File structure", each page with route-level `lazy: () => import(...)` (Next split per route; `weight.spec.ts` has one budget per page and would otherwise measure the whole app twice). `*` redirects to `/`. Dev routes exist only when `import.meta.env.DEV || import.meta.env.MODE === "check"` and are written so the bundler drops the dynamic import in a default build.
- [ ] **Step 7: `Root.tsx`** renders `<Outlet />` inside `ModuleProviders` and the branding provider (Task B2.7); `RouteEffects` arrives in B2.8. The root route also sets an `errorElement` for a route chunk that cannot load or a route that throws: inside the providers, a Swedish message (`Sidan kunde inte visas. Ladda om sidan.`) with a button that reloads when the person presses it and a link to `/`; it replaces only the route that failed, never the page a person is working on (a lazy route fails on a navigation they asked for, after the leave question was answered). The root route also sets `HydrateFallback` to the loading shell (the spinner under `ModuleShell` that `AuthGate` shows), so the first page's lazy chunk does not leave a blank frame and react-router logs no "No HydrateFallback" warning.
- [ ] **Step 8: `scripts/finish-build.mjs <outDir>`.** Takes the output directory as its one argument and works only there; refuses an argument that is not an existing directory with an `index.html`. `npm run build` is `tsc --noEmit && vite build && node scripts/finish-build.mjs dist`; `npm run build:check` is `tsc --noEmit && vite build --mode check && node scripts/finish-build.mjs dist-check`. The script's work (hash `color-mode.js`, check the marker, precompress) is added in B2.6; here it only validates its argument and precompresses `assets/` (`.br` and `.gz` beside each `.js`, `.css`, `.svg`, `.json`, with `node:zlib`).
- [ ] **Step 9: Both builds from clean outputs.** `rm -rf dist dist-check; npm run build; ls dist-check` fails to exist; `npm run build:check` then creates `dist-check/` and leaves `dist/` byte-identical. Expected on the first `vite build`: it fails on `next/*` imports. That is the list for B2.2; do not commit a green build yet.
- [ ] **Step 10: Commit.** `build(frontend): Vite entry, route table, the Node floor and a router probe (pages follow)`

### Task B2.2: The pages, and every `next/*` import

**Files:** `git mv` per "File structure"; modify the 10 files that import `next/*` (`kit/ModuleProviders.tsx`, `components/Brand.tsx`, `components/AccountMenu.tsx`, `components/AuthGate.tsx`, `components/flow/FlowFrame.tsx`, `components/flow/BackToFlows.tsx`, `components/flow/useLeaveQuestion.tsx`, `components/flow/DetailsForm.tsx`, `app/LoginPage.tsx`, `app/flows/FlowsPage.tsx`), the 4 `Metadata` imports and 3 `notFound` imports (they disappear with the page files), `lib/speaker-review.ts`, `components/flow/Markdown.tsx`, `components/TranscriptPlayer.tsx` (the loader). Create `lib/lazy-component.ts`.

Replacements (the whole inventory; `rg "from \"next|next-themes"` must show only B2.6's items afterwards):

| Today | After |
|---|---|
| `Link` from `next/link` as `as={Link} href` (`Brand`, `FlowFrame`, `BackToFlows`) | `as={RouterLink}` from `@/kit/RouterLink` |
| `NextLink` in `ModuleProviders` `RouterLink` | `kit/RouterLink` |
| `useRouter()`, `router.replace(x)` / `router.push(x)` (`AccountMenu`, `AuthGate`, `LoginPage`, `FlowsPage`, `useLeaveQuestion`) | `const navigate = useNavigate()` from `react-router`; `navigate(x, { replace: true })` / `navigate(x)` |
| `dynamic(() => import("@astryxdesign/core/DateInput")…)` in `DetailsForm` (no recovery) | The shared loader of Step 1c: until the code has arrived, and if it never does, a plain text field with the same label and value stays; a status line says `Kalendern kunde inte läsas in.` and a press retries only that import. No `React.lazy`, no `Suspense`, no boundary: nothing can unmount the form |
| `window.history.replaceState(window.history.state, "", url)` for `?run=` and `?recording=` (`app/flows/[id]/page.tsx`, `writeRunIdToUrl` and the recording write) | `navigate({ search }, { replace: true })` from `useNavigate()`, in the same places. The router then knows the address, and the leave blocker (B2.9) ignores a change that keeps the pathname. Reads keep `window.location.search` at the same call sites: the router writes it synchronously |
| `use(params)` in `app/flows/[id]/page.tsx` | `const { id } = useParams()`; `key={id}` and the wrapping `AuthGate` stay |
| `searchParams` in `app/inloggad/page.tsx` | `useSearchParams()`; `refusalOf` and the title table move into `SignedInAgain.tsx` |
| `process.env.NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED === "true"` | `typeof __SPEAKER_REVIEW__ !== "undefined" && __SPEAKER_REVIEW__` with `declare const __SPEAKER_REVIEW__: boolean` |

- [ ] **Step 1: Move the files.** One `git mv` commit with no content change, then the edits.
- [ ] **Step 1b: `LoginPage` and the address.** `app/LoginPage.tsx` removes `?auth_error` with `window.history.replaceState(null, "", "/")`, which drops the router's `idx` and `key` from the entry (the same pattern as the guard's release in B2.9). Use `navigate("/", { replace: true })` there; keep its unit test's expectation (`login-page.test.ts` reads the `replaced` list: it reads `router.state.location` after B2.3).
- [ ] **Step 1c: One recoverable loader for the three lazy imports.** `components/flow/Markdown.tsx:33-58` (recovers, `200bcac`), `components/TranscriptPlayer.tsx` `LazyTranscriptEditor` (no failure handling) and the new `DateInput` all do the same: a module-level `loaded`, a `useEffect` that loads, a `failed` and an `attempt`. Extract it once as `lib/lazy-component.ts` (`useLoaded(loader)` returning `{ value, failed, retry }`), and move the Markdown component and `LazyTranscriptEditor` onto it with their existing tests passing unchanged. The editor, today, leaves its skeleton for good when its chunk is gone; give it the same status line and retry (`Granskningsverktygen kunde inte läsas in.`).
- [ ] **Step 2: `useNavigate` stability.** Keep `navigate` in each effect's dependency list only because the data router makes it stable. A unit test in B2.3 fails if it is not (Review Focus 3).
- [ ] **Step 3: `/inloggad`.** A route component outside every gate (no `AuthGate`, no redirect when signed out), same texts. `useSearchParams` reads `fel`; unknown values are the plain "inloggad igen" page, as `refusalOf` returns null today.
- [ ] **Step 4: Dev routes** from `routes/dev/*` through `routes.tsx` only.
- [ ] **Step 5: Run** `npm run lint` and `npx vite build`. Expected: both pass (unit tests still fail until B2.3).
- [ ] **Step 6: Commit.** `refactor(frontend): the pages are route components on react-router; next/* is gone from the source`

### Task B2.3: The unit-test harness

**Files:** Modify `frontend/lib/test-router.ts` (the probe of B2.1 becomes the helper), `frontend/tsconfig.test.json`, `frontend/tests/register.cjs` (only if needed), and the test files that mount `AppRouterContext.Provider` (`lib/login-page.test.ts`, `lib/signed-out.test.ts`, `lib/review-busy.test.ts`, and any `rg "AppRouterContext\|next-themes" lib` finds). Create `frontend/tests/vite-types.d.ts`.

- [ ] **Step 1: `lib/test-router.ts`** exports `withRouter(element, { path, entries })`: a `createMemoryRouter` with the element at `path`, returned with `router` so a test reads `router.state.location` and its navigations (replaces the `replaced: string[]` arrays that `login-page.test.ts` fills from the fake router's `replace`).
- [ ] **Step 2: Replace the router.** Every `AppRouterContext.Provider` in the tests becomes `withRouter`. The theme provider of next-themes in six test files is replaced in B2.6.
- [ ] **Step 3: `tests/vite-types.d.ts`** is `/// <reference types="vite/client" />` (CSS Module typing, replacing `tests/next-types.d.ts`); `tsconfig.test.json` includes it and drops `node_modules/next/types/global.d.ts`.
- [ ] **Step 4: The `RouterLink` test.** A link to `/flows` is a router link (a click does not reload the document and updates `router.state.location`); `href="#x"`, `mailto:`, `https://…`, `/api/eneo/…` (with and without `target="_blank"`), and a `download` link are plain anchors that the router never sees.
- [ ] **Step 5: The navigation-stability test.** In `signed-out.test.ts`: mount `AuthGate` in a memory router, navigate to another path that keeps it mounted, assert `GET /api/auth/status` was requested once (fails if `navigate` changes identity; prove it once with `BrowserRouter`, then revert).
- [ ] **Step 6: Run** `npm test`. Expected: `# fail 0`. **Step 7: Commit.** `test(frontend): the unit tests mount react-router, not Next's app router`

### Task B2.4: The gate on the Vite dev server

**Files:** Modify `frontend/playwright.config.ts`, `frontend/playwright.review.config.ts`, `frontend/playwright.branding.config.ts` (the shared server only), `frontend/package.json` (`dev:stub`, `test:a11y:review`), `frontend/tests/e2e/screens.ts` (`open()`), `frontend/tests/e2e/checks.ts`, `frontend/tests/e2e/branding.spec.ts`, `frontend/tests/e2e/review-flag.spec.ts` (the `nextjs-portal` and `NEXT_PUBLIC_` mentions).

- [ ] **Step 0: Record the test set before the switch**, from the last commit that still runs on Next: `npx playwright test --list` (every project, file and title) into a file kept for the pull request, and the same for `playwright.review.config.ts` and `playwright.branding.config.ts`.
- [ ] **Step 1:** Replace the second `webServer` with `{ command: "npx vite --host 127.0.0.1 --port <APP> --strictPort", url, env: { DEV_API_BASE: "http://127.0.0.1:<STUB>" }, timeout: 120_000, reuseExistingServer: !process.env.CI }`. The stub stays the first server. Update the header comment ("`next dev`" becomes "the Vite dev server", and "Next allows one dev server per checkout" goes: Vite does not). `playwright.review.config.ts` starts the same server with `SPEAKER_REVIEW_ENABLED=true` and `review-flag.spec.ts` reads that variable; `test:a11y:review` sets it. The `dev:stub` script is the stub and `vite` together with the current script's `trap` and ports.
- [ ] **Step 2:** Remove the `nextjs-portal` rules (`screens.ts:10`, `checks.ts:31,205,378`, `branding.spec.ts:46`): Vite has no dev overlay element of that name. Keep the axe `exclude` list otherwise identical.
- [ ] **Step 3: Run the whole dev profile** (`npm run test:a11y`, 19 projects, all specs), `npm run test:a11y:review` and `npm run test:a11y:branding`. Expected: the same pass set. Compare `--list` before and after: **no test name is missing**, and the added names (none yet) are listed. Read every changed ARIA snapshot (expected: none; `aria.spec.ts` ignores Next's announcer).
- [ ] **Step 4:** Run `leaks.spec.ts` and `session-cover.spec.ts` on their own and read the numbers: the DOM-counter slack of `leaks.spec.ts` is not changed.
- [ ] **Step 5: Commit.** `test(frontend): the accessibility gate runs on the Vite dev server`

### Task B2.5: Fixtures: UUID ids, a date flow, a table report, two new states

**Files:** Create `frontend/tests/fixtures/ids.json`. Modify `frontend/tests/e2e/stub-server.py`, `frontend/tests/e2e/screens.ts`, every gate or production test that names `flow-1` to `flow-4` (`rg -n "flow-[0-9]" frontend/tests`), `frontend/tests/prod/weight.spec.ts`, `frontend/tests/prod/weight-budget.json`.

Why now: the live route takes `UUID` path parameters (`backend/app/main.py`, `live_transcription(websocket, flow_id: UUID, step_id: UUID)`), and the stub's principal flow is `"flow-1"` (`stub-server.py`, opened by `screens.ts` `setup()`). A request through the real backend for it fails the route's validation, and adding upstream aliases, tickets and sockets cannot change that. Production validation is not weakened and `stromma` is not skipped: the fixtures become real identifiers, once, in one file.

- [ ] **Step 1: `tests/fixtures/ids.json`** maps `flow1` to `flow5` (and the stub's step ids, already UUIDs) to UUIDs of the shape Eneo's are; the stub reads it with `json.load`, the tests import it (`resolveJsonModule` is on). The unit tests under `lib/` keep their string ids: nothing there reaches a validating route.
- [ ] **Step 2: Replace the consumers.** The stub's `FLOWS`, `screens.ts` (`setup()`, `run()`, the flow-specific states), the other gate specs, `weight.spec.ts` (its path and `HEADING` are keyed by a label such as `/flows/:id`, and `weight-budget.json` with them). Run the dev profile: the same states pass.
- [ ] **Step 3: A flow with a date and a run with a table.** In the stub: a published flow whose form has a `date` field, not listed by the flow list (so no existing state's list or snapshot changes), and a finished run `run-table` of flow 1 whose report has a GFM table. In `screens.ts`: `setup-date` (open the flow, open the calendar popover, which loads the lazy `DateInput` chunk) and `result-table` (open the run, the table is rendered by react-markdown and remark-gfm, with a header row and body cells). New ARIA snapshots only for these two, read before committing.
- [ ] **Step 4: Run** the dev profile. The test-set comparison of B2.4 now shows exactly two added names per project. **Step 5: Commit.** `test(frontend): the stub's flows have real identifiers; a date control and a Markdown table are gate states`

### Task B2.6: Colour mode with no flash, no inline script

**Files:** Create `frontend/kit/ColorModeProvider.tsx` (copy of `eneo-module-kit-ui/packages/ui/src/color-mode.tsx`, with the header comment), `frontend/public/color-mode.js`. Modify `frontend/scripts/finish-build.mjs` (the hashing part), `frontend/kit/ModuleProviders.tsx`, `frontend/components/AccountMenu.tsx`, `frontend/app/globals.css` (now `styles/globals.css`), `frontend/lib/brand.test.ts`, `frontend/lib/accessibility.test.ts`, the six unit tests that wrap `ThemeProvider`, `frontend/tests/e2e/color-mode.spec.ts`.

- [ ] **Step 1: `public/color-mode.js`**

```js
(function () {
  try {
    var mode = localStorage.getItem("theme");
    if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
  } catch (e) {}
})();
```

It sets nothing for `system` or no choice: verified in `node_modules/@astryxdesign/core/dist/theme/Theme.js:196-222` that `Theme` sets `data-theme` for `light` and `dark` and removes it for `system`, and that `reset.css` then defaults to `color-scheme: light dark`, so the browser's own preference paints `system` correctly with no script at all. The script exists for the stored explicit choice that differs from the system's: CSS cannot read `localStorage`, and a correct first React render is not a correct first paint. It is not inline, so `script-src 'self'` allows it; it is parser-blocking, so no frame is painted before it has run. The proof that no wrong frame is painted with the script slow, the bundle slow or JavaScript blocked is `first-paint.spec.ts` (B3.3), on a production build, because in Vite's dev mode the application's CSS arrives through JavaScript.
- [ ] **Step 2: `scripts/finish-build.mjs`** renames `<outDir>/color-mode.js` to `<outDir>/assets/color-mode.<8-hex content hash>.js`, rewrites the `<script src>` in `<outDir>/index.html`, and removes the root copy. It fails the build if `index.html` still names `/color-mode.js`, and unless `index.html` has exactly one `<meta name="eneo-branding" content="">` (Vite re-serialises the HTML; the backend refuses to start without the marker, so the build should fail first). The name is then under `/assets/` and immutable. Run for `dist` and for `dist-check` from clean outputs; each ends with its own hashed script and no root `color-mode.js`.
- [ ] **Step 3: Providers.** `ModuleProviders` uses the copied `ColorModeProvider` and passes `mode` to Astryx's `<Theme mode>` as the kit does; the `useSyncExternalStore` observer of the `<html>` class and its comment are removed. `AccountMenu` reads `useColorMode()`; the `themeReady` workaround for hydration goes (no server render). The six unit tests that wrap next-themes' `ThemeProvider` wrap `ColorModeProvider`.
- [ ] **Step 4: Every consumer, then the bridge.** First list every consumer of the old class: `rg -n '\.dark' frontend --glob '!node_modules'`, plus `html.light`, `:root.dark`, `[class~=dark]` and `dark:`, and put the list in the pull request. Known today: `app/globals.css:80-83` (the `html.dark … { color-scheme }` bridge) and `:130-132` (`html.dark` and `html:not(.dark)` logo selectors), `lib/brand.test.ts:73` (asserts that selector text), `lib/accessibility.test.ts:55` (a `.dark` fallback for `--record` that `--module-color-record` makes dead: delete it). Move each live one to `:root[data-theme="dark"]` with a `@media (prefers-color-scheme: dark) { :root:not([data-theme]) … }` fallback, as the kit's `packages/ui/src/base.css` does at its end, and change `brand.test.ts` to assert those selectors; domain colours that use `light-dark()` need nothing. Delete the bridge in the same commit, last. A test fails if `rg '\.dark'` finds a hit in `styles`, `components` or `kit`.
- [ ] **Step 5: Tests.** `color-mode.spec.ts` keeps its four stored/system combinations (every frame's card colour) and its `useTheme()` agreement tests on the dev profile; the `<noscript>` text, blocked JavaScript, the delayed bundle and the delayed script are `first-paint.spec.ts`'s (B3.3). Unit tests: the provider reads the stored choice before the first render, ignores anything but `light`, `dark`, `system`, survives a throwing `localStorage`, follows another tab's `storage` event and the system's change.
- [ ] **Step 6: Run** `npm test`, `npm run lint`, the colour-mode spec on the dev profile. **Step 7: Commit.** `feat(frontend): the colour mode is a provider and one same-origin script, no inline script`

### Task B2.7: The organisation's mark from the page itself

**Files:** Modify `frontend/lib/read-branding.ts`, `frontend/components/Brand.tsx`, `frontend/routes/Root.tsx`, `frontend/lib/read-branding.test.ts`, `frontend/lib/brand.test.ts`.

- [ ] **Step 1: Failing tests.** `readBranding()` returns the JSON of `<meta name="eneo-branding">` synchronously when the attribute is non-empty; invalid JSON or an unexpected shape is `{ organization: null }` with a `console.error`; an empty attribute (the dev server does not fill it) falls back to `GET /api/branding` with the existing 2 s deadline (the current function body), so the dev profile and `test:a11y:branding` keep working; with that answer delayed or failing, the header shows the product name alone and never another organisation's mark.
- [ ] **Step 2: Implement.** The provider's value is read once, before the first render. In production there is then no `/api/branding` request and the mark is in the first frame; on the dev server it appears after the answer, as the kit's does, and no frame shows another organisation's mark.
- [ ] **Step 3: Run** `npm test`. **Step 4: Commit.** `feat(frontend): the page reads the organisation from its own HTML`

### Task B2.8: Route titles, announcement, focus and scroll

**Files:** Create `frontend/routes/RouteEffects.tsx`, `frontend/tests/e2e/route-change.spec.ts`. Modify `frontend/routes.tsx`, `frontend/routes/Root.tsx`, the four route components (a `useRouteReady` call each), `frontend/tests/e2e/aria.spec.ts` (the `__next-route-announcer__` ignore at line 67 becomes ours).

This replaces what Next did without being asked: it moved focus to the new page, scrolled to the top and announced the new title through `__next-route-announcer__` (WCAG 2.4.2, 2.4.3, 4.1.3). It is one component with one clock, because `AuthGate` replaces the whole shell when the session answer arrives, so what exists at the moment of the navigation (a spinner with its own `h1`) is not the page.

**Design.**
- `RouteEffects` (inside the data router) reacts to a change of **pathname** only; a change of the query or hash (the page writing `?run=`) does nothing. At once it sets `document.title` from the deepest match's `handle.title`.
- Each route component calls `useRouteReady(ready)` when its first real content is there: `LoginPage` when it has stopped checking, `FlowsPage` when the list answered or failed, `FlowPage` when the flow loaded or failed, `SignedInAgain` always. `AuthGate`'s spinner phase is not ready, so nothing is decided while the shell is about to be replaced.
- When the page is ready for the current navigation, once, in the next animation frame (so the focus the page took itself in its own effects, such as `usePhaseHeading`, has happened): announce the title through a live region that stays mounted (check `npm run astryx -- search announce`: `@astryxdesign/core` has `hooks/useAnnounce`; use it if it is public, else a 15-line component); if focus is not already inside the main region, focus the page's heading (`[data-phase-heading]`, `h1[tabindex]`, else the first `h1`, given `tabIndex={-1}`) with `preventScroll`; then scroll.
- Scroll has one owner: `PUSH` and `REPLACE` scroll to the top; `POP` restores the offset saved for that location key (saved in memory as the entry is left; `history.scrollRestoration` is `manual`, B2.1). `<ScrollRestoration>` is not used, because it runs before content that is fetched outside a loader exists; and nothing queries the DOM in a loop to find the heading.
- The first load announces nothing, moves nothing and scrolls nothing.

- [ ] **Step 1: Write `route-change.spec.ts` first** (dev profile, projects `laptop-1440-light` and `phone-390-light`): from `/flows` open a flow with its link; from the flow go Back with the browser button; sign out; each time assert (a) `document.title` is the route's (`Välj ett flöde · Tal till text`, `Tal till text` then the page's own), (b) the new title is in a polite live region within 1 s of the content, once, (c) focus is in the page's heading and not on `<body>` or on the spinner's `h1`, **with the session answer delayed 1.5 s** (`page.route` on `/api/auth/status`), (d) a list scrolled well down (a short viewport, so it scrolls) is scrolled to the top on a link and back where it was on Back, (e) nothing steals focus from a control the page focused itself (`usePhaseHeading`), (f) a change of the query only (`?run=` written by the page) does none of it, including no scroll reset, (g) the first load announces nothing and moves nothing, (h) axe passes on both pages, (i) it coexists with the page's own focus management: a phase heading that takes focus, a dialog that gives focus back, and the three `/inloggad` states (`?fel=utgangen`, `?fel=annan-anvandare`, none) each keep their title and are not moved by a second mechanism.
- [ ] **Step 2: Implement** the design. Add the `useRouteReady` calls.
- [ ] **Step 3: Update `aria.spec.ts`** line 67 and run `npm run test:a11y -- aria.spec.ts --update-snapshots` only after reading each diff. The expected diffs: the announcer element and nothing else.
- [ ] **Step 4: Commit.** `feat(frontend): a route change sets the title at once, and announces, focuses and scrolls when the page has its content`

### Task B2.9: Leaving a page that holds work: `useBlocker` replaces the history sentinel

**Files:** Delete `frontend/lib/leave-guard.ts`. Modify `frontend/components/flow/useLeaveQuestion.tsx`, `components/flow/FlowFrame.tsx`, `components/flow/BackToFlows.tsx`, `components/AppHeader.tsx`, `components/Brand.tsx`, `components/AccountMenu.tsx`, `routes/FlowPage.tsx` (its `beforeunload` stays), `lib/recording-view.test.ts`, `lib/interactions.test.ts`, `lib/account-menu.test.ts`. Create `frontend/tests/e2e/leave-guard.spec.ts`.

What the guard is for: a recording must not be lost to a stray navigation. Today two mechanisms do it. `lib/leave-guard.ts` pushes one extra history entry (state `{...history.state, talTillTextGuard: true}`, no URL) so that Back lands on it, puts it back at once and asks, and its release calls `history.back()` and `replaceState(null, …)` ("without the app router's own state" is Next-specific). `onLeave` makes the links of the bar ask, and `leaveFirst` makes Logga ut ask before the session is ended. The flow page also writes `?run=` and `?recording=` with `history.replaceState`, which the router does not see. Two history owners are one too many (Codex finding 1, the owner's ruling).

**Design.** One owner, react-router's data router:
- `useLeaveQuestion(active, warning)` calls `useBlocker(({ currentLocation, nextLocation }) => active && !allowed.current && currentLocation.pathname !== nextLocation.pathname)`. A change that keeps the pathname (the page writing `?run=`, a hash) never blocks. While `blocker.state === "blocked"` the same `AlertDialog` is open with the same warning (`leaveWarning`); `Lämna sidan` calls `blocker.proceed()`, `Stanna kvar` calls `blocker.reset()`.
- `leaveFirst(goOn)` stays, for Logga ut only: it is a request, not a navigation, so the question has to come before `POST /api/auth/logout` ends the session. On `Lämna sidan` it sets `allowed.current = true` before calling `goOn`, so the `navigate("/", { replace: true })` that follows is not asked a second time; `allowed` is cleared when `active` changes.
- The `onLeave` plumbing goes: `LeaveContext.onLeave`, the `onLeave` props of `FlowFrame`, `BackToFlows` and `HeaderBrand`, and `Brand`'s `onClickCapture`. Every in-app departure, link or Back or Forward, now reaches the blocker.
- `lib/leave-guard.ts`, its extra entry and its `go(-2)` are deleted. `beforeunload` stays: it alone covers reload, close, and Back from the **first** entry of a visit (a deep link or a reload), where no in-app navigation exists to block. That case now shows the browser's own question instead of the page's dialog (decision D8); it requires a user gesture on the page, which a recording always has had.
- The flow page's `?run=` and `?recording=` writes are `navigate({ search }, { replace: true })` (B2.2). `/inloggad` is outside `AuthGate` and outside every blocker: it is its own route with no gate and no redirect when signed out.

- [ ] **Step 1: Write `leave-guard.spec.ts` first** (dev profile, `laptop-1440-light`, which runs `StrictMode`). Each scenario asserts the question dialog is open with focus on `Stanna kvar` and the recording is still running:
  1. Back in the middle of a visit (list, then flow): one question; `Stanna kvar` leaves the page, the address and `history.state` unchanged; `Lämna sidan` goes to the list.
  2. Repeated Back while the question is open: still one dialog, nothing stacked.
  3. Back on the first page of a visit (open a flow directly): the browser's `beforeunload` dialog, not the page's; dismissing it keeps the page and the recording; accepting leaves. `history.length` is the same before and after the recording starts (no sentinel entry).
  4. The page writes `?run=` (a run starts): no question, no new entry (`history.length` unchanged), and Back then asks once and goes to the list once.
  5. A link in the bar, and the brand: one question; `Stanna kvar` stays.
  6. Logga ut: the question comes **before** `POST /api/auth/logout` is sent (assert the request order); `Stanna kvar` sends none; `Lämna sidan` sends it once and the navigation to `/` that follows is not asked again.
  7. Forward after `Stanna kvar`: nothing asks and nothing breaks.
  8. Reload asks only through `beforeunload`.
  9. `AuthGate` is not re-run by any of this (`GET /api/auth/status` is requested once per page), and `AuthGate`'s own `navigate("/", { replace: true })` when the first status read fails is not asked (the blocker is not active yet).
  10. `/inloggad?fel=utgangen` opened directly while signed out shows its page, with its title, and does not redirect or ask.
- [ ] **Step 2: Run against Task B2.8's code.** Expected: 1 to 9 fail (the sentinel is still there or the blocker is not yet written). Then implement the design above.
- [ ] **Step 3: Unit tests.** In `lib/interactions.test.ts` (the three tests that use `useLeaveQuestion` and `window.history.back()`) and `lib/account-menu.test.ts` mount the hook in `withRouter` and drive it with `router.navigate(-1)` and `router.navigate("/flows")`. Delete the history-simulation cases of `lib/recording-view.test.ts` that exist only for the sentinel and keep the warning-text cases.
- [ ] **Step 4: Commit.** `feat(frontend): useBlocker owns leaving a page that holds work; the history sentinel is gone`

### Task B2.10: The dev server against the real backend

**Files:** Modify `frontend/package.json` scripts, `.devcontainer/devcontainer.json` (label of port 3002), `docs/development.md`, `README.md`.

- [ ] **Step 1:** `npm run dev` on 3002; `npm run dev:stub` starts `tests/e2e/stub-server.py` and `vite` with `DEV_API_BASE` set to the stub (done in B2.4).
- [ ] **Step 2: Prove the proxy against the real backend**, in the devcontainer layout: `.venv/bin/python -m app.serve --api-only --port 8000 --reload` with `.env` for `AUTH_MODE=access_code`, `MODULE_PUBLIC_URL=http://localhost:3002`; sign in, open a flow, start a live session against a stand-in Eneo, send a 70 KB PCM frame and an oversize frame. Expected: the session works through the dev server's WebSocket proxy and an oversize frame closes with 1009. If Vite's WebSocket proxy changes the `Origin` or splits frames, the dev proxy is not equivalent: report it (the gates are not affected). Uses `--api-only`: the launcher refuses to start without a built UI otherwise.
- [ ] **Step 3: Docs.** `docs/development.md` ports and commands (3002 dev, `DEV_API_BASE`, the `--api-only` launcher), `README.md`.
- [ ] **Step 4: Commit.** `feat(frontend): the Vite dev server proxies HTTP and WebSocket to the backend`

### Phase B2 exit

`npm run lint`, `npm test` (`# fail 0`), `npm run build` and `npm run build:check` (each from clean outputs) pass; `npm run test:a11y`, `test:a11y:review` and `test:a11y:branding` pass with every earlier test name present and the added ones listed; `rg "from \"next|next-themes|AppRouterContext" frontend --glob '!node_modules' --glob '!package*.json'` prints nothing; `route-change.spec.ts`, `leave-guard.spec.ts` and `color-mode.spec.ts` pass on the dev profile; every file of "File structure" is where it says. `test:prod` and the real profile do not exist yet (B3).

---

## Phase B3 — Production-shaped proof

Result: one fake Eneo, the real backend and the strict policy carry the gate, `test:prod` and (in B4) the image acceptance; no coverage lost.

### Task B3.1: The stub as Eneo, and the real-backend harness

**Files:**
- Modify: `frontend/tests/e2e/stub-server.py`
- Create: `frontend/tests/prod/start-backend.mjs`, `frontend/tests/e2e/auth.ts`, `frontend/tests/prod/upstream.spec.ts`

The stub answers the BFF's paths today (`/api/auth/*`, `/api/eneo/*`, `/api/config`, `/api/branding*`, `/api/live/*`). Production-shaped tests need it to be Eneo too, for the real BFF in front of it. One process plays both roles, told apart by path prefix; the Eneo role reuses the BFF role's data, so every flow, run and file exists once. It is the only fake Eneo of Plan B: the real gate, `test:prod` and the image acceptance (B4.2) all use it, and the backend's own unit tests keep their in-process fakes.

- [ ] **Step 1: The Eneo role.** (a) The module-login handshake, copied from `eneo-module-kit-ui/template/stub-eneo/server.py` (`GET /module-login` redirecting back with a one-time ticket and the unchanged state, `POST /api/v1/module-auth/token/`, the session and refresh routes, `POST /__stub/end-session`), with the user, tenant and module key the real backend is started with (`MODULE_KEY`, `ENEO_API_KEY`). (b) The `/api/v1/` alias: every route the BFF role serves under `/api/eneo/` is also served under `/api/v1/` (`do_GET`, `do_POST`, `do_PATCH`), so the real backend's allowlisted proxy reaches the same data. (c) The signed-URL mint for a run's input file and a run's artifact (`POST …/signed-url/` answers `{url, expires_at}` with a URL on the stub, which the backend rebases to `ENEO_BACKEND_URL`), and a file endpoint that serves the stub's WAV and PDF with `Range`, `206`, `Content-Range` and a `416` for an unsatisfiable range. (d) The live ticket (`POST …/live-transcription-sessions/` answers `{ticket, websocket_path}`) and a socket at that path, speaking the subprotocol `eneo-live.v1` with the ticket the backend offers (the stub's existing relay logic answers a word per four audio frames). (e) A test-only control surface, never shipped: `GET /__stub/stats` (open file streams, live frames and bytes received, the last upload's byte count, uploads received) and `POST /__stub/reset`. Nothing of this changes the stub's behaviour as a BFF for the dev profile.
- [ ] **Step 2: `start-backend.mjs`** starts `python -m app.serve --host 127.0.0.1 --port <port>` from `backend/` with `STATIC_DIR=<dir>`, `ENEO_BACKEND_URL` and `ENEO_PUBLIC_URL` pointing at the stub, `AUTH_MODE=eneo_sso`, `MODULE_PUBLIC_URL=http://127.0.0.1:<port>`, `COOKIE_SECURE=false`, and optional deployment branding variables; it waits for `/health`.
- [ ] **Step 3: `auth.ts`: a test-scoped session.** A Playwright fixture that, for every test, signs the test's own browser context in through the real handshake (`GET /api/auth/login?next=/flows` followed through the stub's `/module-login` and `/api/auth/callback`; the cookies stay in that context) and tears it down at the end. A test that logs out, or lets the session end, invalidates only its own session on the server (`module_auth.py` deletes it); no test shares one. A test that needs a signed-out page uses the unauthenticated project fixture instead.
- [ ] **Step 4: `upstream.spec.ts`** (a `shipped` test of B3.3's `prod` profile, API-level, Chromium): sign in; the flow list through the real backend; `X-Expected-User` is required for a write (409 `user_changed` without) and not for a read; the artifact route with a PDF answers `frame-ancestors 'self'` and `SAMEORIGIN` and the audio route answers 206 with `Content-Range` and 416 for an unsatisfiable range; a live socket opened from a page of the module's origin (so the browser sets `Origin`) with `?expected_user=` relays a 64 KiB frame to the stub (`/__stub/stats` shows it) and closes with 1009 on a frame of 128 KiB + 1; an upload of a few MB reaches the stub whole (stats) and the answer is the stub's.
- [ ] **Step 5: Run** the harness spec against a local backend (`npm run build:check` first). **Step 6: Commit.** `test(frontend): the stub is also Eneo, and the real backend is started and signed into the way production is`

### Task B3.2: The real target of the gate

**Files:**
- Create: `frontend/tests/e2e/sentinel.ts`
- Modify: `frontend/playwright.config.ts` (`GATE_TARGET=real`), `frontend/tests/e2e/screens.ts` (`REAL_SKIP`, `expects`), the gate specs that are `@dev-only`, `frontend/package.json` (`test:a11y:real`, `build:check`), `.github/workflows/ci.yml`

After headers and routing move into FastAPI, "Vite plus the stub" no longer reaches the new production owner. This target runs the gate's states through the real static serving and the real headers, with the stub as Eneo, over a production build.

- [ ] **Step 1: The target.** `GATE_TARGET=real` (the `real` profile): `webServer` entries for the stub and for the real backend on `dist-check/` (built by `npm run build:check`), the test-scoped session fixture of B3.1, and the gate's own spec list minus the `@dev-only` tests: `leaks.spec.ts` (needs `/dev/dialog-leak`, which only the dev server has), `live-sheet.spec.ts` and `recording-short.spec.ts` (they replace the live socket in the browser with `routeWebSocket`, so they would skip the relay they are meant to exercise), `review-flag.spec.ts` (needs the review build) and `branding.spec.ts` (needs another deployment). The tag is in the test title and each config selects by `grep`/`grepInvert`; there is no runtime skip. CI runs the projects `phone-390-light` and `laptop-1440-dark`; the phase exit runs all 19. `REAL_EXTERNAL_URL` replaces the started backend with a running URL (the image behind Traefik, B4.2); the stub is then the image's upstream and its address is the one the browser can reach.
- [ ] **Step 2: `REAL_SKIP`.** Every state of `screens.ts` runs on this target unless it is in `REAL_SKIP` (a map from state name to a written reason); the expected entries are the `branding-*` states. Any other state that cannot be expressed as an Eneo answer is listed after the first run with its reason, and the list is read in the pull request. A state is never skipped to make the run pass. A state that intercepts the very endpoint it is meant to exercise is not a claim state (see Step 5).
- [ ] **Step 3: The sentinel** (`sentinel.ts`, a fixture used by the gate specs on this target only): `addInitScript` listens for `securitypolicyviolation`; `page.on("console")` and `page.on("requestfailed")` collect errors; every redirected request (a 301, 302, 303, 307 or 308 on a fetch, a stream, a frame or an image; the BFF's own `/api/auth/login` and `/api/auth/callback` navigations are the only allowed ones) is recorded. At the end of every test: **any CSP violation fails**, always; any redirect fails (this is the evidence for item 25: the browser's exact paths, with and without the slash, never meet a redirect); any console error or failed request fails unless the state **declared it**. A state that deliberately causes an error (the HTTP 503 of `flow-list-error`, an aborted request) declares `expects: [{ console: /status of 503/ }]` in `screens.ts`: the declared pattern is matched narrowly, and the test fails if a declared failure did **not** occur. Nothing is filtered silently.
- [ ] **Step 4: The evidence**, recorded in the pull request: the number of states and projects run with the sentinel on, and the one-line answer to "does anything inject inline styles": what was found. If a violation occurs the evidence section was wrong: find the source of it (`rg` for the DOM API it names), fix it in the component, and add a unit test where it can be tested. Never relax the policy: the stop condition.
- [ ] **Step 5: Run** `npm run test:a11y:real`. The states that carry the claim, by name, must run and pass, and none of them may intercept the endpoint it is meant to prove: `recording` and `stromma` (the microphone, and the live socket through the real relay and the stub), `result` and `result-docked-player` (playback through `_stream_signed` with Range), `result-pdf-dialog` and `result-pdf-preview-whole` (PDF framing), `result-table`, `setup-date`, `account-menu`, `leave-dialog`, `naming-dialog`, `ready-delete-dialog`; and the renewal tests of `names.spec.ts` and `session-cover.spec.ts`, whose sessions are now the backend's. Expected: all pass with the sentinel on.
- [ ] **Step 6: CI.** The browser job builds `dist-check` and runs the two projects of the real profile.
- [ ] **Step 7: Commit.** `test(frontend): the gate also runs through the real backend under the strict policy, with a sentinel for violations, errors and redirects`

### Task B3.3: `test:prod` on the real backend

**Files:** Create `frontend/tests/prod/headers.spec.ts`, `routes.spec.ts`, `first-paint.spec.ts`, `stale-chunk.spec.ts`. Modify `frontend/playwright.prod.config.ts`, `frontend/tests/prod/smoke.spec.ts`, `weight.spec.ts`, `weight-budget.json`, `branding.spec.ts`; delete `frontend/tests/prod/serve.mjs` in B5.1.

- [ ] **Step 1: The profile.** `playwright.prod.config.ts` has three backends and three projects: `shipped` (the real backend on `dist/`, built by `npm run build`; Chromium, WebKit, Firefox; every test not tagged `@fixture` or `@branded`), `fixture` (on `dist-check/`; Chromium; the `@fixture` tests: the foundation smoke test), `branded` (on `dist/` started as a green deployment with `ORGANIZATION_ACCENT`, `ORGANIZATION_NAME` and a logo; Chromium; the `@branded` tests). `PROD_EXTERNAL_URL` replaces the `shipped` project's backend with a running URL (the image, B4.2). No test asks a build for what it does not contain.
- [ ] **Step 2: `headers.spec.ts`.** For `/`, `/flows`, `/assets/<a hashed file>`, `/live-pcm-worklet.js`, `/api/nope`, `/health`: every header of `security_headers.json`; the inline PDF response carries `frame-ancestors 'self'` and `SAMEORIGIN` and no other response does; `index.html` is `no-cache` with an ETag and `If-None-Match` gives 304; a hashed asset is `immutable`; no `X-Powered-By`, no `Server: uvicorn`; `Content-Encoding` is `br` or `gzip` for `.js` and `.css` when the browser sends it.
- [ ] **Step 3: `routes.spec.ts`.** Direct hits (`page.goto`) on `/flows`, `/flows/<flow id>?run=run-done`, `/inloggad`, `/inloggad?fel=utgangen`, `/inloggad?fel=annan-anvandare` render the page, with the right title and `lang="sv"`; `/openapi.json` is a 404 with a JSON body and `/docs` is an ordinary unknown page that goes to `/`; in the default build `/dev/foundation` and `/dev/speaker-review` have no route (the app goes to `/`) and a `@fixture` test shows they render in the check build; `/assets/missing.js`, `/missing.png`, `/api/nope`, `/api` are 404 with a non-HTML content type; `HEAD /` is 200.
- [ ] **Step 4: `first-paint.spec.ts`** (three engines, `shipped`; the accent tests `@branded`). With JavaScript blocked a Swedish `<noscript>` text shows and the page's colour is the stored choice or the system's; production issues no request to `/api/branding`; the mark is in the first frame; for each of the four stored/system combinations, with the entry bundle delayed 3 s, with `color-mode.js` itself delayed, and with the stored choice differing from the system's, **no frame is in the wrong mode** (frames are sampled from navigation start with `requestAnimationFrame`, reading `getComputedStyle(documentElement).colorScheme` and the body's background, not a component that may not exist yet); with `/api/branding/theme.css` delayed 3 s the first painted frame already has the deployment's accent (`@branded`: the link is render-blocking, so the page waits for it rather than painting the old colour). Run this once against the provider without `color-mode.js` to see it fail: that is the evidence for the script.
- [ ] **Step 5: `stale-chunk.spec.ts`** (Chromium, `shipped`). Serve the build, then make the lazy chunk files answer 404, as a deploy that removed them would (`page.route` on `/assets/<chunk>-*.js`): the `DateInput` field, the Markdown text and the review editor each keep their content, say what happened in a status line, and recover with a press once the route is lifted; a route chunk that cannot load shows the root `errorElement` with the reload as a button and replaces only that route; with every unloaded chunk answering 404 and a recording in progress, the page stays and the recording can be stopped and saved. Nothing reloads by itself in any of them.
- [ ] **Step 6: `smoke.spec.ts`, `branding.spec.ts`.** The foundation test is `@fixture`; the flow-list test is `shipped` and signs in with the fixture of B3.1; the accent test is `@branded`. Remove the `route.fulfill` that rewrote the CSP, because the policy is strict for style already, and assert the accent applies under it; the `/api` rewrite test becomes "the backend serves the stylesheet".
- [ ] **Step 7: Weight, on what ships.** `weight.spec.ts` measures `/flows` and `/flows/<id>` on the default build (`shipped`), where the fixtures are not (its old header's `FOUNDATION_CHECK` allowance of about 6.5 KB goes). Put the numbers next to B0.1's. Set `weight-budget.json` to the new numbers rounded up to the next 5 KB **only with the reason in the pull request** (the precompression and the removed Next runtime change them; ADR 0007 is updated in B5.2). A result above the Plan A target is a finding.
- [ ] **Step 8: Run** `npm run test:prod`. **Step 9: Commit.** `test(frontend): test:prod runs the shipped build, the check build and a branded build on the real backend and proves headers, routes, first paint, stale chunks and weight`

### Phase B3 exit

| Area | Required |
|---|---|
| Harness | `upstream.spec.ts` passes: sign-in through the handshake, `user_changed`, PDF headers, audio 206 and 416, live relay and 1009, an upload |
| Real profile | `test:a11y:real` passes for all 19 projects at the exit (two in CI) with the sentinel on: no violation, no redirect, every declared failure occurred; `REAL_SKIP` is short and each entry has its reason; the claim states ran and none intercepts its endpoint |
| Production tests | `test:prod` passes in Chromium, WebKit, Firefox for `shipped`, and its `fixture` and `branded` projects pass; the weight numbers are in the pull request next to B0.1's |
| Gate | The dev profile still passes with the test-name comparison of B2.4 (no name missing, the added ones listed) |
| Accessibility | `route-change.spec.ts`, `leave-guard.spec.ts`, `color-mode.spec.ts`, `session-cover.spec.ts`, `leaks.spec.ts` pass on their profiles |

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

There is no `apt-get` and no `libstdc++6`. The `node:22` stage satisfies the floor of B2.1 (check `node --version` in the build). After the build, `docker run --rm <image> python -c "import uvicorn, httptools, websockets, uvloop, pydantic_core"` must pass; if an import fails for a missing library, add that one package back and say why in the commit.
- [ ] **Step 2: `docker-compose.yml`**: the root image and Compose run one and the same image, built from the root `Dockerfile`: one service, built from the root (`build: .`), `restart: unless-stopped` (restarting is the container's job now that supervisord is gone), `expose: ["3001"]`, the backend's environment unchanged, the `SPEAKER_REVIEW_ENABLED` build arg (default `false`), the health check on `http://127.0.0.1:3001/health`. The `frontend` service goes. The service is named `speech-to-text` (decision D2). `docker-compose.override.yml` publishes `3001:3001`.
- [ ] **Step 3: `.env.example`** drops `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED` and names `SPEAKER_REVIEW_ENABLED` with the note that it is a build argument.
- [ ] **Step 4: `test_deployment_compose.py`.** The first test becomes: exactly one service; no `frontend`; port 3001 exposed; health check calls `/health` on 3001; the build context is the repository root and the build arg `SPEAKER_REVIEW_ENABLED` defaults to `false`. Keep the branding and body-limit tests.
- [ ] **Step 5: CI.** `frontend` job: `npm run build` is the Vite build; the browser job builds `dist-check` and runs the real profile's two projects (B3.2) and `test:prod`. `compose` job unchanged. `image` job builds the image once and runs `deploy/acceptance.sh` on that very image (`ACCEPT_SKIP_BUILD=1`, B4.2). Publishing promotes the tested artifact and never rebuilds: `publish.yml` runs only after CI passed on the same commit, and pushes the digest the acceptance tested. A failed acceptance cannot reach the registry. CI and the Dockerfile install the backend from one generated transitive lock with hashes (`backend/requirements.lock`, as the kit's template has it), so the audited set is the shipped set. Actions are pinned to full SHAs and base images to digests, with the update routine written in `docs/operations.md`. The image is built with SBOM and provenance attestations. The compose service runs `read_only` with `cap_drop: [ALL]`, `no-new-privileges` and a writable temp sized for concurrent uploads × `MAX_UPLOAD_BYTES`, tested with a real upload.
- [ ] **Step 6: Run** `docker build -t eneo-mod-speech-to-text:test .`, `docker compose --env-file .env.example config -q`, the backend tests. **Step 7: Commit.** `build: one image, one process, no Node and no supervisord`

### Task B4.2: Production image acceptance

**Files:** Create `deploy/acceptance.sh`, `deploy/acceptance/compose.yml`, `deploy/acceptance/traefik.yml`, `deploy/acceptance/checks.py`. Modify `frontend/package.json` (`test:image`). The fake Eneo is `frontend/tests/e2e/stub-server.py` (B3.1), mounted into a `python:3.12-slim` container as the kit's template does; there is no second fake. The upload scripts of B0.1 are reused.

`deploy/acceptance.sh` builds the image, starts the acceptance stack (`deploy/acceptance/compose.yml`: the image with `MAX_UPLOAD_BYTES` set as check 9 says, the stub as Eneo with its control surface, and a Traefik with one router for the image; the stub is published on a host port and is the image's `ENEO_PUBLIC_URL`, so the browser can follow the sign-in handshake), waits for `healthy`, runs the checks, runs the `shipped` project of `test:prod` and the real profile's claim states for `phone-390-light` against the Traefik URL (`PROD_EXTERNAL_URL`, `REAL_EXTERNAL_URL`), and removes only the containers it started. A client that acts as the page names its user: `X-Expected-User` on a write and `?expected_user=` on the socket.

| # | Check on the running image | Fails when |
|---|---|---|
| 1 | `docker inspect` health is `healthy`; `GET /health` and `GET /api/healthz` answer `{"ok": true}` on 3001 | health moved or died |
| 2 | One process: `docker top` shows one `python` and no `node`, no `supervisord`; `command -v node supervisord` inside is empty; user is not root | a second process or root |
| 3 | Every route of the app as a direct GET is the page (200, `text/html`, `no-cache`), and none of them or of the API paths the UI calls answers a redirect | a deep link breaks, or a redirect would carry `http://` |
| 4 | `/api/nope`, `/assets/x.js`, `/x.png` are 404 with no HTML body | the fallback answers HTML |
| 5 | Headers of check 3 and 4 equal `security_headers.json`; script and style policy has no `unsafe-*` | a header lost |
| 6 | The `shipped` project of `test:prod` (Chromium) passes against the image: headers, routes, first paint, stale chunks, weight, the flow-list smoke test; and the real profile's claim states and the renewal tests of `names.spec.ts` and `session-cover.spec.ts` pass for `phone-390-light` against the image, with the sentinel on | UI regressed in the image |
| 7 | A signed-in Range request for the audio route answers 206 with `Content-Range`; a second range after it; an unsatisfiable range is 416; the connection closed half-way leaves no open upstream (the stub's stats count them) | streaming broke |
| 8 | A live session through the real socket, naming its user: a 64 KiB frame reaches the stub (its stats), a 128 KiB + 1 frame closes with 1009 and the stub sees nothing of it | limits lost |
| 9 | Upload memory, measured as the baseline was (the scripts copied into `deploy/acceptance/upload/` by B0.1). The image is run with `MAX_UPLOAD_BYTES` above the largest file's **encoded body** (file plus multipart overhead; `MAX_UPLOAD_BYTES` caps the whole body, and the default of 1 GiB is below a 1 GiB file's body, so flat memory there would only show an early rejection). A 300 MiB upload through `/api/eneo/flows/<id>/files` completes, the stub's stats show every byte received and the answer is the stub's, and the backend's resident memory grows by the spool's few MB (baseline on Next: +308 MB); a 1 GiB upload completes the same way and leaves memory flat (baseline: +576 to +1077 MB); two 300 MiB at once do not add up (baseline: +612 MB). **Separately**, an upload whose body is over the cap is a 413 with `max_upload_bytes` in its body, with memory flat (baseline: the client hangs at about 2 GiB); one the client abandons half-way leaves the process healthy and no temp file behind | memory follows the file size, a completing upload is rejected, or the 413 is lost |
| 10 | `docker stop` ends the container in under 10 s with a file still streaming | graceful stop lost |
| 11 | The inline PDF response has `frame-ancestors 'self'` and `SAMEORIGIN`; the result page's preview frame loads it (browser, `result-pdf-dialog`) | PDF preview broke |
| 12 | A build with `--build-arg SPEAKER_REVIEW_ENABLED=true` yields a `dist/` that contains the speaker-review marker string and the default image does not | the flag is lost or leaks |
| 13 | The default image's `dist/` contains no `Grundkontroll` and no `/dev/` route | a dev page shipped |
| 14 | Image size, start to `healthy`, idle and loaded resident memory, CPU under the B0.1 polling load, and `docs/plans/page-cost.cjs` (transfer, LCP, total blocking time, layout shift on the throttled profile) for `/flows` and `/flows/<id>`, against B0.1's numbers. The layout shift of the header is the evidence for decision D4 (the mark is in the first frame). | the module got heavier or slower |
| 15 | The live relay under static load. Static files, uploads and the WebSocket relay share one event loop. With one live session streaming 20 frames a second, measure the frame-to-event round trip idle, then while 200 concurrent clients fetch the page and its assets (cold cache) for 30 s | the loaded p95 is more than twice the idle p95 (stop condition: serve the assets from a faster path, or cache them at the edge, before the first deployment). The owner accepted this result on 2026-10-04: the reason and the numbers are in `deploy/acceptance/waivers.json`, and the check still fails and prints `FAIL (waived: ...)` |
| 16 | Through Traefik. The acceptance stack puts a Traefik (v3, one router for the module, an HTTP entrypoint) in front of the image: the live socket upgrades and relays and the browser's `Origin` reaches the BFF's check unchanged (a request with another `Origin` is refused); the 300 MiB and the 1 GiB upload complete, and an over-cap one is refused, with the same answers as direct; an audio `Range` is 206 and an unsatisfiable one 416; a cookie the BFF sets reaches the browser and comes back; a write that names no user is a 409 `user_changed`; `docker stop` with a stream open ends in under 10 s. Not covered: TLS and the `Secure` cookie (a hand check at B6.1) | the ingress changes what the module's contracts promise |

- [ ] **Step 1: Write the checks first**, run them against the image of B0.1 (`stt-before`) where they apply (1, 2, 4, 7, 8, 9, 10, 14) and record which fail there: that is the proof that they can fail (4 should, on `/_next/static/missing.js`'s HTML).
- [ ] **Step 2: Run on the new image.** Expected: all pass. Put the tables of checks 14 and 15, and the answers of check 16, in the pull request.
- [ ] **Step 3: Commit.** `test(deploy): acceptance of the production image, through Traefik`

### Phase B4 exit

`docker build` and `deploy/acceptance.sh` pass; checks 14 and 15 show no regression (stop condition otherwise); `docker compose --env-file .env.example config -q` passes.

---

## Phase B5 — Remove Next, update the records

### Task B5.1: Delete Next and next-themes

**Files:** Delete `frontend/next.config.mjs`, `frontend/lib/backend-base.mjs`, `frontend/tests/prod/serve.mjs`, `frontend/tests/next-types.d.ts`, `frontend/components/theme-provider.tsx`, `frontend/next-env.d.ts` if tracked. Modify `frontend/package.json`, `frontend/package-lock.json`, `frontend/AGENTS.md` (regenerated block: `npm run astryx -- upgrade --from 0.6.3 --apply`), `AGENTS.md` (the Plan B line), every `// eslint-disable-next-line @next/next/…` (`components/Brand.tsx`).

- [ ] **Step 1:** `npm uninstall next next-themes`; `npm run dev:next`, `build:next` scripts go.
- [ ] **Step 2:** `rg -i "next(\.config|/|-themes|js| dev)|nextjs|__next|INTERNAL_API_BASE|FOUNDATION_CHECK|NEXT_PUBLIC" -g '!node_modules' -g '!docs/plans' -g '!docs/decisions' -g '!package-lock.json' .` prints only text that is about history (the ADRs) and nothing in code, scripts, CI or compose.
- [ ] **Step 3: A test that it stays gone.** In `lib/design-system.test.ts`: `package.json` has no `next`, `next-themes`; `next.config.mjs` does not exist.
- [ ] **Step 4: Run** `npm run lint && npm test && npm run build && npm run test:a11y && npm run test:a11y:real && npm run test:prod`, and `deploy/acceptance.sh`. **Step 5: Commit.** `chore(frontend): remove Next.js and next-themes`

### Task B5.2: Docs and decisions

**Files:** Modify `README.md` (the Nuvarande and Planerat rows, ports 3000/3002, commands), `docs/architecture.md`, `docs/operations.md`, `docs/frontend.md`, `docs/backend.md`, `docs/development.md`, `docs/design-system.md`, `docs/quality-gates.md`, `docs/glossary.md`, `docs/eneo-integration.md`, `docs/decisions/0002-fastapi-bff-kept.md` (status: the checklist is carried out), `docs/decisions/0003-…` (superseded by 0008), `docs/decisions/0007-weight-budget.md` (new budget and why), `docs/decisions/README.md`. Find the lines with `rg -n -i "next|supervisord|rewrite|3000|3002|INTERNAL_API_BASE|NEXT_PUBLIC" docs README.md` (the line numbers move). Create `docs/decisions/0008-static-ui-served-by-the-bff.md`.

- [ ] **Step 1: Write ADR 0008** (Swedish, like its neighbours): decision, the strict policy and its evidence (B3.2), the first-paint script and why it is a file, the branding marker, why the history sentinel is gone and what that costs (Back from the first entry is the browser's own question), the header precedence, the lazy-chunk rule, the removed slash tolerance, what was measured (B0.1 and B4.2 checks 14 and 15), what was copied from the kit and what Plan C deletes.
- [ ] **Step 2: Update the pages above** so that no page says Next serves, supervisord starts, or `frontend` is a service. `docs/backend.md` loses "Next.js ligger före BFF:en" and the `next dev` slash note (the backend sees the browser's exact paths, a slash twin that is not a route is a 404, and the allowlist matches as spelled). `docs/operations.md` documents the new variables (`STATIC_DIR` set by the image, `SPEAKER_REVIEW_ENABLED` build argument, `DEV_API_BASE`) and drops the removed ones; it gains a section on what stands in front of the limits: Traefik's entrypoint read and idle timeouts and any buffering `maxRequestBodyBytes` (the deployment's, now the only layer in front of `MAX_UPLOAD_BYTES`, which caps the whole request body), and the rule to deploy by stop then start because two containers up at once misroute sessions (they are process-local). `docs/quality-gates.md` describes the test profiles of "Test profiles".
- [ ] **Step 3: Check the claims.** `rg "supervisord|next\.config|rewrite|Next.js" docs README.md` prints nothing except the ADRs and the history sentences. Run `rg "docs/plans" docs README.md AGENTS.md` and leave the plan references (the port cleanup bead `stt-plan-a-astryx-port-57a.24` removes them).
- [ ] **Step 4: Commit.** `docs: the module is one process serving a static UI`

---

## Phase B6 — First deployment

### Task B6.1: Merge, try out, deploy

Owner and lead task. Nothing here is automatic.

- [ ] **Step 1:** Merge `main` into `feat/one-process`; the whole exit run again (`lint`, `test`, `build`, the dev and real profiles, `test:prod`, `deploy/acceptance.sh`). Open the pull request to `main` when the owner asks.
- [ ] **Step 2: Try-out.** The owner signs in, opens a flow, records, uploads a file, opens a result with a PDF, and opens the module on a Safari 17/18 device, on a preview of the image.
- [ ] **Step 3: The first deployment**, which is not in this repository. The Dokploy service is the single one on port 3001 (the published image, `ghcr.io/eneo-ai/eneo-mod-speech-to-text` from `publish.yml`, listens there; Compose names the service `speech-to-text`). Traefik passes the WebSocket upgrade to it. Read the deployment's Traefik configuration, which was not seen when this plan was written: the entrypoint's read and idle timeouts, any `maxRequestBodyBytes`, compression, forwarded-header trust. A 1 GiB upload and a long live session must fit them, and the TLS and `Secure`-cookie path is checked by hand (check 16 does not cover it). Deploy by stop then start.
- [ ] **Step 4:** After a week with no incident, close the epic.

---

## What differs from the Next version

For the owner's information; none of it needs a decision.

1. With JavaScript disabled the page shows a Swedish notice instead of the loading shell Next rendered on the server.
2. The organisation's mark is in the first paint in production; on the Vite dev server it appears after `GET /api/branding` answers (the kit's behaviour).
3. A stale tab that asks for a removed lazy chunk shows a message and does not reload by itself (Next recovers from a failed chunk with a full reload, as far as its documentation says; not verified here), because a reload loses a recording in progress.
4. Back from the first page of a visit asks through the browser's own `beforeunload` question (reload already did); the page's dialog no longer opens for it, because the history sentinel is gone. Back and links inside the visit still use the page's dialog.

## Risks and stop conditions

| Risk | Guard |
|---|---|
| A component writes an inline style or script the evidence missed | The sentinel over every state of the real profile (B3.2); stop condition; never `'unsafe-inline'` |
| Back or a link loses a recording on the new router | `useBlocker` and B2.9's scenarios in a real browser; `beforeunload` for the first entry (the browser's own question); stop condition |
| `AuthGate` and `LoginPage` re-run on every navigation | Data router, and the count test of B2.3 |
| Focus or scroll land on a page that is not there yet | One component, a content-ready signal from each page, no DOM polling; `route-change.spec.ts` with a delayed session answer and a scrolled Back (B2.8) |
| The first paint shows the wrong colour mode when JS is slow | The same-origin script and `first-paint.spec.ts` on a production build (B3.3) |
| `react-router` does not load or drive in the CommonJS unit tests, or the Node floor is too low | The probe of B2.1 runs on the declared floor; `engines` follows the highest dependency |
| The gate changes silently with the server | The test-name comparison (no name missing, additions listed), snapshots read, B2.4 |
| Live states cannot reach the real relay (ids that the live route rejects) | UUID fixtures (B2.5) before the real profile; no state of the claim list intercepts its endpoint |
| One saved session shared by tests that log out | A test-scoped session per test (B3.1) |
| A deliberate error state fails the sentinel, or an unexpected one is hidden | Declared, narrowly matched expectations that must occur; CSP violations and redirects never allowed (B3.2) |
| A stale tab after a deploy | `index.html` is `no-cache`, assets hashed; the three lazy loaders recover locally and keep the work; a route chunk goes to the root `errorElement`, never a reload by itself; `stale-chunk.spec.ts` (B3.3). Old assets are not kept |
| Chrome offers brotli only over HTTPS, so `test:prod` on plain HTTP measures gzip | The weight numbers are compared with B0.1's gzip; the image check under HTTPS is a hand check at B6.1 |
| A redirect built behind Traefik says `http://` (item 24) | No UI path redirects (row 25); image check 3; do not turn on `forwarded_allow_ips="*"` without the owner |
| Keep-alive: uvicorn closes an idle connection after 5 s; Traefik reuses connections | Next's Node server has the same 5 s: parity. A 502 rate in production is the signal to set `timeout_keep_alive` above Traefik's idle timeout |
| Deployment configuration outside the repository (service, Traefik) | B6.1 Step 3 |
| Two containers up at once | Deploy by stop then start; documented in `docs/operations.md` (sessions are process-local) |
| A burst of first-time visitors delays the live relay (one event loop) | B4.2 check 15: the relay is unaffected up to 45 real visits/s and only the saturating stress exceeds 2× idle; the owner accepted that on 2026-10-04 (deploy/acceptance/waivers.json), so no sidecar. Files are indexed once at start, so a request does no file-system lookup |
| A path the browser sends was only working because Next stripped its slash | `test_slashes.py` and the sentinel's redirect check (B3.2); the tolerance is deleted, not kept |

**Stop and ask the owner if** a stop condition under "How to work" holds, or a step's expected result does not appear after one honest attempt to fix the cause.

## Decisions needed from the owner

Defaults are what the plan assumes if nothing is said.

| # | Question | Default |
|---|---|---|
| D1 | One integration branch `feat/one-process`, merged once after the image acceptance; B1 goes to `main` first | Yes |
| D2 | The Compose service is named `speech-to-text` | Yes |
| D3 | Port 3001 in the image and in Compose | 3001 |
| D4 | The organisation's mark written into `index.html` by the backend, or fetched after the first render as the kit does | Written into the page; B4.2 check 14 measures the layout shift and can reverse it |
| D5 | Compression: precompressed brotli and gzip at build time; the API is compressed by the edge or not at all, unless B0.1 shows Next gzips it, in which case a JSON-only compression of the non-streaming proxy route is added in B1.4 (never for Range, audio or PDF) | As stated |
| D6 | `SPEAKER_REVIEW_ENABLED` stays a build-time flag (a published image then always has it off). A run-time flag would ride in the same `<meta>` as the organisation. | Build time; ask later if a deployer needs it |
| D7 | After a navigation the title is set at once, and the announcement, the focus on the page's heading and the scroll happen when the page has its content | Yes |
| D8 | `useBlocker` replaces the history sentinel. Cost: Back from the first entry of a visit, and reload, are the browser's own question (`beforeunload`), not the page's dialog | Yes |
| D9 | Two server profiles of the gate: the Vite dev server for every day, the real backend on a production build for the CI subset and the exit; no header-replaying preview server | Yes |
| D10 | The production-shaped tests sign in through the SSO handshake with the stub as Eneo (not `access_code`, which the README schedules for removal) | Yes |
| D11 | `/health` and `/api/healthz` both stay | Yes |
| D12 | The launcher refuses to start without the built UI unless `--api-only` (development and tests) | Yes |
| D13 | `redirect_slashes=False`, and the slash tolerance of `_resolve_proxy_path` is deleted | Yes |
| D14 | Old hashed assets are not kept across deploys; every lazy chunk fails locally and recoverably | Yes |

## Not in Plan B

SSR or any server rendering; Hono; a nonce or a hash CSP (the policy has nothing inline); HSTS and other new headers; a service worker or an offline mode; moving this module onto the kit's packages (Plan C); changing the BFF's auth, allowlist or session store; more than one replica; the access-code login's removal (README schedules it).

## Review record

**Pass 1.** Codex design review: `gpt-6-astra`, `xhigh`, session `stt-planb-design` (artifact `scratchpad/codex-pb/codex-peer-loop-plan-b-design-remove-next-js-20261001T192233Z-766d82762a8c4f8faead9f9b65d776ef.md`, local, not committed): `changes_required`, MIN_SCORE 7. It reviewed the approach before this plan existed, at `d114f27`. The target, Vite + React served by one uvicorn process, was accepted.

| # | Finding | Built into |
|---|---|---|
| 1 (P1) | One router and history owner; replace the guard, do not combine it with a blocker; URL writes through the router and not a departure; `beforeunload` and the question before logout kept; `/inloggad` outside the gate | Global Constraints "One history owner"; row 9; Task B2.2 (URL writes); Task B2.9; D8; "What differs" 4 |
| 2 (P1) | Header precedence, not the kit's policy: `setdefault`, endpoint headers win, `microphone=(self)`, PDF exception and logo sandbox kept, tests for HTML, redirects, errors, SVG logos, inline and downloaded artifacts | Global Constraints "Header precedence"; rows 1 and 2; the JSON and "Precedence"; Task B1.2 |
| 3 (P1) | Old tabs after a deploy: lazy chunks may vanish; no blind reload, no root boundary over the recording | Row 30; Task B2.2 Step 1c; B2.1 root `errorElement`; B3.3 Step 5; "What differs" 3; D14 |
| 4 (P1) | A production integration gate through the real serving code, not Vite and the stub; the exercised list; keep the 19-project gate | Tasks B3.1 and B3.2 (real backend, stub as Eneo, sentinel, new states in B2.5); "Evidence" widened |
| 5 (P2) | Migrate every colour-mode consumer before deleting the bridge; no flash is more than a correct first render | Row 29; Task B2.6 Step 4; the same-origin script; `first-paint.spec.ts` |
| 6 (P2) | Complete the static contract: API and health before the fallback, reserved namespaces, GET and HEAD, MIME, conditional requests, cache classes, missing-file answers, startup validation; FastAPI docs routes | "Static serving rules"; rows 17 and 27; Tasks B1.1 (launcher refuses to start without the UI), B1.2, B1.3; D12 |
| 7 (P2) | Both deployment paths on one image; restart as the container's job; one worker, no access log, WebSocket limits, bounded shutdown | Task B4.1 Step 2; rows 5, 22, 28; Risks; B6.1 (stop then start) |
| 8 (P2) | Build-time contracts and route splitting: flag and fixture constants explicit, no wholesale environment, fixtures absent from the shipped bundle, login does not download the recording | Rows 12 and 15; route-level `lazy` (B2.1); B4.2 checks 12 and 13 |

Pass 1 also asked for the hardening baseline to be named (now "Prerequisite, named"), the ingress to be read (B6.1 Step 3) and exercised (check 16), and capacity claims to be measured (B0.1, checks 14 and 15). The lead's rulings on it, the measured upload and trailing-slash evidence, and sec-media's findings were folded in the same way (rows 1, 25, 26; B1.2; B0.1 Step 5b; checks 9 and 16).

Not taken, or taken differently:

- *The kit's branding fetch as the default (Codex "SHOULD copy ... branding-fetch behavior").* Kept the backend's write of the answer into `index.html` (D4, B1.4, B2.7). The fetch shifts the header on every load; Next does not. B4.2 check 14 records the layout shift; if the fetch version shows none, the marker half of B1.4 is deleted.
- *Bounded retention of earlier hashed assets.* Not taken (the lead's ruling): it needs storage that outlives a deploy and keeps old code served, and local recovery is needed anyway.
- *A static-serving sidecar.* Not built: B4.2 check 15 was measured and the owner accepted the result (deploy/acceptance/waivers.json).
- *Prefer the ingress's compression.* Precompressed static files cost nothing at run time and need no ingress knowledge; the API is not compressed (never Range, audio or PDF) unless B0.1 shows Next does (D5).
- *The kit's `BrowserRouter`.* Not adopted: `useBlocker` needs a data router.

**Pass 2.** Codex design pass 2 on the finished plan (`a5e832f` and `08466b2`; `gpt-6-astra`, `xhigh`; artifact `scratchpad/codex-pb/codex-peer-loop-plan-b-design-remove-next-js-20261001T200322Z-f7b2497d214e43f1ba5a22b6fe324ced.md`): `changes_required`, MIN_SCORE 7, architecture accepted, seven MUST corrections and two SHOULD, all accepted. The owner's two rules applied at the same time: the module is not in production and nobody runs it, so there is no backwards compatibility (the interim upload paragraph in Risks, the rollback and repoint wording, the accepted-change confirmations and the decision about an interruption at the cut-over are gone, and the slash tolerance is deleted instead of kept); and always the clean solution.

| # | Finding | Built into |
|---|---|---|
| 1 (P1 MUST) | The image acceptance required fixtures the image excludes; the gate requested dev-only specs on a build; check 6 named tests `test:prod` does not run | "Test profiles" (seven profiles; specs belong by tag, never a runtime skip); B3.2 Step 1 (`@dev-only`); B3.3 Step 1 (`shipped`, `fixture`, `branded` projects); B4.2 check 6 (the `shipped` project and the real profile's claim states run against the image) |
| 2 (P1 MUST) | The live route takes UUIDs; the stub's flow is `flow-1` | Task B2.5 (`tests/fixtures/ids.json`, one source for the stub and the tests, before the real profile); Review Focus 6; Risks |
| 3 (P2 MUST) | One saved session cannot serve tests that log out | B3.1 Step 3 (a test-scoped session per test through the real handshake); Review Focus 13; D10 (SSO through the stub, not `access_code`) |
| 4 (P2 MUST) | Focus and scroll specified against a loading shell that `AuthGate` replaces; router scroll restoration runs before content exists; query writes reset scroll | Task B2.8 (one component, `useRouteReady` from each page, announcement and focus and scroll once at content, `<ScrollRestoration>` not used, no DOM polling, only a pathname change acts, tests with a delayed session answer and a scrolled Back); Global Constraints "One owner for what happens after a navigation"; Review Focus 12 |
| 5 (P2 MUST) | Phase exits depended on later tasks: the Vite gate arrives after the browser tests that need it; blocked-JS colour tests cannot use Vite dev; PDF headers needed the stub's minting before it existed; B2.8's launcher lacked `--api-only` | Reordered: the gate on Vite is B2.4, before every browser test of B2; the fixtures B2.5; the blocked and delayed JS proofs moved to `first-paint.spec.ts` on a production build (B3.3); the stub as Eneo is B3.1, before `test:prod`; B2.10 uses `--api-only`; the dependencies on the board are exactly the order stated at the top |
| 6 (P2 MUST) | `finish-build.mjs` was specified against `dist/` only | B2.1 Step 8 and the interface: it takes the output directory as its argument and works only there; B2.1 Step 9 and B2.6 Step 2 verify both builds from clean outputs |
| 7 (P2 MUST) | The sentinel failed on deliberate error states; "identical test count" | B3.2 Step 3 (states declare narrowly matched expected failures that must occur; CSP violations and redirects never allowed); Global Constraints "No lost coverage" and B2.4 Step 0 (a test-name comparison: none missing, additions listed) |
| 8 (P2 SHOULD) | React Router 8.4 declares Node `>=22.22.0`; the repository `>=22.13.0`; probe the CommonJS compiler with jsdom early | B2.1 Step 1 (engines read with versions, the floor follows the highest) and Step 3 (the probe, on the declared floor, before any dependent edit) |
| 9 (P2 SHOULD) | The upload benchmark could not tell streaming from early rejection: the cap is on the whole request body | B4.2 check 9 and Review Focus 7 (the cap is set above the encoded size so the upload must complete and the stub's stats prove receipt; rejection is measured separately) |

Simplifications taken from the pass: one fake Eneo for the real profile, `test:prod` and the image acceptance (B3.1; `deploy/acceptance/fake_eneo.py` is dropped); the header-replaying preview server and the `built` gate target are dropped (two server profiles: the Vite dev server and the real backend on a production build; D9); route effects and scroll in one owner.

Two things the base had that the first version of this plan did not know, now handled: `playwright.review.config.ts` and `review-flag.spec.ts` read `NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED` (row 12, B2.4); and the page's user is required for writes and the live socket, so every client that acts as the page names it (Global Constraints, B3.1, B4.2).

**Still not verified by running code** (this worktree has no `node_modules`; Docker and Playwright were not run): the CSP evidence is read from source and from the kit's trial, proven only by B3.2; whether Next gzips proxied API JSON, the keep-alive behaviour behind Traefik, and Chrome's brotli over plain HTTP are unmeasured; `react-router` 8.4.0 loads through `require` on Node 22.23 and exports every API the plan uses (checked in the kit's checkout), but its loading and driving under this repository's `tsc` CommonJS test build with jsdom on the declared Node floor is the probe of B2.1 Step 3; the stub's conformance to the real backend's handshake is shown only by B3.1's `upstream.spec.ts`; the Dokploy and Traefik configuration is outside the repository and was not read.
