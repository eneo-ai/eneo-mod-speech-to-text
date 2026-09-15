# Speaker review: Lyssna delivery status

## Contract

Reviewed Vemsa commit `97096dcacb919ed8f8258552f807b39d5bdc4ddb` and the local
Eneo v3 implementation. Shared synthetic fixtures are copied unchanged from Vemsa.

Lyssna now uses Eneo's existing correction PATCH with `schema_version: 3`, the
original `segments_hash`, `expected_revision`, and complete correction lists.
The hash comes from step transcription metadata or a non-stale correction response;
it is never recomputed from normalized client data. Character anchors convert
between JavaScript UTF-16 offsets and Eneo's Unicode code-point offsets.

Multi-file metadata uses `transcription.speaker_review.files`. Eneo's file-prefixed
overlap IDs are retained; file index remains part of UI identity. Legacy single
Vemsa objects and the earlier array form remain readable. Detail omission is
shown explicitly, separately from an unavailable detector or an available empty list.

## Implemented

- Preserve model suggestions, attribution, original offsets and overlap evidence.
  Provisional names are explicitly labelled suggestions. Speaker/evidence spans
  remain distinct inside coherent paragraphs; all intersecting spans can be active.
- Reading paragraphs with inline speaker markings and dotted uncertainty.
  Adjacent continuations join when their effective speakers agree; file, pause,
  and reading-length boundaries remain. Source anchors and word times stay intact.
  Compact previous/next review navigation selects words in the transcript.
  Wordless intervals and detector details remain available in expandable details.
  Context playback and 0.75× playback remain available.
- Durable same-label confirmation, reassignment (including unknown model speakers),
  explicit unresolved decisions, and undo via the shared correction API.
- Clicking solid-underlined words moves the playhead to their timestamp while
  preserving pause/play state, falling back to the passage start when timing
  is unavailable. The current word uses the original solid accent highlight,
  including inside a selection. Silent gaps retain the last completed word without
  modifying timing; simultaneous active words and backward/file seeking remain correct. The transcript-wide focus outline is removed;
  individual keyboard controls retain focus indicators. Dotted passages
  still select for review, and native drag selection is preserved.
- **Bekräfta alla förslag (N)** confirms pending known-speaker proposals across the
  transcript in one save with one-step undo. A mixed selection also offers
  **Bekräfta förslagen i markeringen (N)**. Each passage keeps its own proposed
  speaker; prior human decisions, unknown proposals and text corrections are
  preserved. Existing audio/edit guards apply.
- A named quick-confirm button accepts a shared speaker suggestion for the
  selection, with the existing audio/save guards and undo. Mixed or previously
  overridden suggestions still use explicit speaker assignment.
- One-click and keyboard selection of dotted passages includes punctuation and
  respects existing decision boundaries. Partial word selection remains available.
- Direct mouse and keyboard text selection across source segments, with exact raw
  anchors even after text corrections. A contextual toolbar assigns the selected
  words, confirms the current speaker, leaves them unresolved, or corrects text.
  Selection pauses follow scrolling. Undo keeps the current save revision.
  Speaker naming is a separate collapsible section above the full-width editor.
- Type directly at the caret to add punctuation or correct characters, with exact
  selection replacement, deletion and plain-text paste through existing saves.
  The caret survives rendering; raw anchors and speaker decisions stay intact.
  The toolbar text field remains available; undo restores the latest action.
- Text corrections remove touched word timings. Original source-span replay bounds
  remain available; corrected words are never assigned invented timings.
- An unresolved passage remains visibly reviewed, and overlap evidence stays visible
  after confirmation. Missing audio disables affirmative assignment but leaves
  unresolved review and undo available. A truly wordless interval without any stored
  segment has no correction anchor; its detector evidence remains visible.
- Full-list saves preserve decision fields and optimistic revision/hash guards.
  Failures retain local drafts, stop queued replacements and block approval.
  Explicit retry retains the original revision; it cannot overwrite a concurrent
  editor silently. Drafts can be downloaded before resolving a conflict.
- Approval awaits correction saves and allows explicitly unresolved decisions.
  Stale/unsupported correction data and missing review base hashes block editing
  and approval visibly.
- Paused and finished runs share the same saving lifecycle. Speaker naming is
  separate from word review; reference audio uses assigned, non-overlap examples.
- Reviewed plain-text download uses the player's exact effective speaker spans and
  uncertainty markers. Exports round-trip through text fallback.

## Existing summaries

Edits after completion do not automatically rewrite summaries or generated files.
The UI explains this and offers the reviewed transcript as input for a new summary.
The notice survives reload by comparing the correction update time with run completion.

**Remaining Eneo dependency:** this local Eneo checkout has no per-step rerun or
summary-regeneration endpoint. The module's older `rerunStep` client helper points
to a route that is absent in Eneo, so it is not invoked. In-place regeneration
requires a real endpoint/workflow that consumes the saved reviewed transcript.

## Feature switch

`NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED=true` enables review controls. It defaults to
false. Metadata preservation, uncertainty labels, saved-overlay rendering, and
export remain active when controls are disabled. The upstream Eneo/Vemsa request
flag is unchanged by this module work.

This is a frontend build setting: both Dockerfiles accept the build argument and
Compose forwards it. For local development, set it in the frontend process
environment and restart that process. Never strip review metadata to bypass
Vemsa's reviewed-transcript realignment rejection.

## Verification

- 96 Lyssna tests: shared fixtures through the actual React player, v3 requests,
  hash/version guards, nullable decisions, partial undo, timing invalidation,
  Unicode anchors, API conflicts, exports, and save-before-approve ordering.
- Latest type checks and production build pass after accessibility changes.
- Local Eneo: 3 v3 API/persistence/audit tests and 79 correction, propagation and
  approval tests pass against its existing test fixtures and disposable databases.
- 26 cross-consumer cases pass: the verifier passes Lyssna-generated requests into Eneo's actual API
  models, validates original anchors, and compares exports with Eneo's renderer.
  Cases cover all six shared fixtures, confirmation/unresolved/undo, partial spans,
  edited words and non-BMP Unicode.
- Browser smoke checks: unresolved without audio, durable-action UI wiring, undo,
  same-label confirmation, native text selection, keyboard extension and toolbar
  access, and assigning only a middle phrase while keeping the paragraph intact. The development fixture page simulates
  local decisions; persistence itself is covered by the API tests above.
- Earlier checks cover 0.75× playback, replay, two-file navigation, wordless overlap,
  multiple active rows, and accessibility labels. No dedicated screen-reader
  session or real-meeting audio quality evaluation has been performed.

Run module checks inside its devcontainer:

```sh
docker exec blissful_boyd sh -lc 'cd /workspaces/eneo-mod-speech-to-text/frontend && npm test && npm run lint && npm run build'
```

After `npm test`, run the cross-consumer comparison:

```sh
docker exec blissful_boyd cat /workspaces/eneo-mod-speech-to-text/frontend/tests/verify-eneo-review.py | docker exec -i eneo_devcontainer-eneo-1 sh -c 'cat > /tmp/verify-lyssna-review.py'
docker exec blissful_boyd sh -lc 'cd /workspaces/eneo-mod-speech-to-text/frontend && node tests/eneo-review-cases.cjs' | docker exec -i eneo_devcontainer-eneo-1 sh -lc 'cd /workspace/backend && .venv/bin/python /tmp/verify-lyssna-review.py'
```

The development-only `/dev/speaker-review` page accesses no real run data and
returns 404 in production. Its optional audio is synthetic silence, used solely
to exercise playback controls; it cannot verify the fixture's spoken content.


## Accessibility follow-up

Contrast, keyboard order/focus, control labels, speaker-name option IDs, target
sizes, reflow, reduced motion and forced colors were improved against WCAG 2.2 AA.
40 automated light/dark and desktop/narrow states have no WCAG A/AA violations.
See [the accessibility review](accessibility-review-2026-09-15.md) for measurements
and remaining manual assistive-technology and full-workflow checks.
