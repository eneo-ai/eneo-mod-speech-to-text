# Handover to Eneo: Lyssna transcript review and operator editing

Date: 2026-09-15
Source repository: `/Users/alexander/code/eneo-mod-speech-to-text`
Module devcontainer workspace: `/workspaces/eneo-mod-speech-to-text`
Eneo repository: `/Users/alexander/code/eneo` (devcontainer: `/workspace`)

## Purpose and delivery state

Continue from the initial Vemsa/Lyssna speaker-review handover, using the current
Lyssna implementation and the interaction decisions below. The work now includes
Eneo v3 correction integration and a transcript-first editor refined against
operator feedback on real screenshots.

The reviewed Vemsa reference was commit
`97096dcacb919ed8f8258552f807b39d5bdc4ddb`. This delivery is bundled in the local
`main` commit titled `feat(transcript): add accessible speaker review and inline editing`,
based on module HEAD `1a518c5` (`fix(upload): stop Next truncating proxied uploads
at 10MB`). The commit includes implementation, fixtures, tests and handover files.
It has not been pushed and no PR has been created.

This handover describes the module's final behavior and the contract Eneo must
preserve. The later UI refinements do not introduce another API schema version.
Do not overwrite either repository's existing local changes.

## 1. What changed after the original handover

### Durable v3 decisions

Lyssna moved from displaying overlap evidence to saving actual human speaker
decisions through Eneo's existing correction API. It supports:

- Confirmation of the existing model speaker, even when the label is unchanged.
- Assignment to another speaker, including when the original speaker is unknown.
- An explicit reviewed-but-unresolved decision.
- Decisions for only part of a source segment.
- Removing decisions for a selected range and undoing the latest local action.
- The same saving lifecycle for paused review checkpoints and completed runs.

### A transcript-first editor

The first UI exposed every uncertainty boundary as a separate row and placed a
large review panel above the text. Operators found it difficult to follow a
sentence or change the speaker of words in its middle.

The replacement presents coherent paragraphs with inline speaker markings. The
transcript gets the full editing width. Global speaker naming lives in a separate,
collapsible **Talare** section. The former `SpeakerReviewPanel.tsx` and its
start/end-word dropdown workflow have been replaced by `TranscriptEditor.tsx`.

## 2. Final interaction rules — preserve these

| Operator action | Required behavior |
| --- | --- |
| Click a dotted passage | Select its entire displayed passage, including punctuation and boundary whitespace, using original source anchors. Do not require precise manual selection. |
| Focus a dotted passage and press Enter or Space | Select the same complete passage. |
| Drag over text or select using the keyboard | Select only those words, including across original segment boundaries. Native selection must remain available. |
| Click **Bekräfta alla förslag (N)** | Confirm all remaining attributable speaker proposals in the transcript, using each passage’s own model speaker. Preserve existing human decisions (including unresolved), text corrections and original evidence. Save as one action with one-step undo. |
| Click **Bekräfta förslagen i markeringen (N)** | For a mixed-speaker selection, confirm only the pending suggestions within its original character boundaries, retaining each suggested speaker. |
| Click **Bekräfta [name]** | Save a confirmed speaker decision for the selected words without opening a menu. |
| Choose **Tilldela talare** | Assign the selected words to the chosen speaker; include **Går inte att avgöra**. |
| Click a solid-underlined word | Move the playhead to that word, preserving whether audio is paused or playing. **Do not start paused audio.** Use the passage start when word timing is unavailable. |
| Click **Lyssna** in the selection toolbar | Explicitly play the selection with surrounding context. Current implementation starts about 1.5 seconds before it and stops about 1 second after it. |
| Click **Nästa/Föregående** | Select the next/previous outstanding passage inside the transcript. Do not duplicate its text in a separate editor. |
| Place the caret and type | Edit exact characters directly, including a missing period in the middle of a sentence. Preserve the caret after each update. Native selection replacement, Backspace/Delete and plain-text paste use the same correction/save queue. Do not snap text edits to whole words or treat the toolbar’s whole-passage selection as the native caret range. |
| Click **Rätta text** | Open the larger selected-text correction field when useful; it remains available alongside direct typing. |
| Click **Återställ talare** | Remove speaker decisions for the selected range; preserve unrelated decisions. |
| Click **Ångra** or press Ctrl/Cmd+Z in the transcript | Restore the latest local change while keeping the current save revision. The current undo implementation is one action deep. |
| Rename a speaker under **Talare** | Change that speaker's display name globally. This does not confirm who said any particular words. |

The quick-confirm button is shown only when the selection has a shared, known
model suggestion compatible with its existing decisions. It must not guess across
mixed suggestions or overwrite a different human assignment under the guise of
accepting a suggestion. After confirmation, it shows **Bekräftad: [name]**.
Confirmation stays on the current selection; advancing is an explicit action.
Bulk confirmation is a separate, explicit control. Its count covers only pending
passages with a known, compatible model speaker. It leaves unknown proposals and
all existing human decisions untouched, and does not confirm timing-uncertain
words or approve the overall workflow. Bulk controls use the same audio,
write-permission, save-queue and revision guards as individual confirmation.

Without audio, affirmative speaker assignment and confirmation are disabled.
Leaving a passage unresolved and restoring decisions remain available. This is
unchanged from the v3 review workflow.

### Direct text editing implementation

Native `beforeinput` is intercepted before it can alter React's word markup.
Exact character ranges resolve to displayed source fragments; corrections are
recomputed within each existing speaker partition and anchored to immutable raw
text. This keeps punctuation at a speaker boundary from absorbing a neighbouring
speaker’s words. The caret is restored using its corrected-source offset after
rendering, including after a length-changing earlier correction. Unicode insertion
anchors include the complete neighbouring code point. Names and timestamps remain
outside editable text. Read-only guards, failed-save drafts and revision checks
continue to apply. No new API endpoint or schema is required.

### Reading, grouping and highlights

- Uncertainty or correction boundaries alone must not break a sentence into rows.
- Speaker identity and review status are separate: speaker colours identify spans;
  dotted underlines indicate words needing speaker review. A provisional name is
  labelled as a suggestion, not displayed as a confirmed attribution.
- Join an adjacent continuation when the preceding paragraph ends with the same
  settled effective speaker that begins the next source segment. Example: Stefan's
  “Jag har läst den flera gånger.” and “än vad du har gjort.” should read together,
  even if the earlier paragraph contains an Annie span.
- Keep file boundaries, substantial pauses and readable paragraph lengths. The
  current grouping uses a gap greater than 3 seconds and a roughly 650-character
  accumulated-length threshold at source boundaries. Do not merge two unknown
  speakers merely because both have a null label.
- Grouping is presentation only. Never renumber, merge or rewrite the underlying
  source segments to achieve this appearance.
- Restore the strong current-word style: `bg-accent text-accent-foreground`.
  The current word remains distinct even inside a selected range. During silence,
  keep the last completed word highlighted until the next word starts. Preserve
  simultaneous active words, recalculate correctly on backward seeks/file changes,
  and never extend the stored word timings to achieve this visual continuity. A passage with
  no word timing gets only a subdued passage highlight, not fabricated word timing.
- Long speaker names wrap within the name column, including unbroken names and
  slash-separated roles. Inline name labels are also constrained to the transcript
  width; names must never overlap the text.
- Keep the scroll container flush with the opaque sticky toolbar. Padding belongs
  inside the editor, so transcript content cannot bleed through a gap above it.
- Remove the large outline around the entire transcript textbox. Individual
  keyboard controls retain visible focus indicators. Keyboard editing now uses a
  local label/paragraph indicator. Tab follows normal order; Alt+T moves to the tools.
- Selecting/editing text suspends automatic follow scrolling. The operator can
  explicitly turn following back on.
- Copying a selection produces transcript text without inline speaker labels.

Overlap intervals, model suggestions, missing detector information and wordless
intervals remain accessible through **Detaljer**. Explicit unresolved decisions
remain visibly reviewed. A truly wordless overlap has no text range to assign.
Whitespace-only remnants must not create phantom outstanding review tasks.

## 3. API and data contract for Eneo

### Existing module-facing routes

These are the Lyssna browser/BFF paths, not a request to add duplicate Eneo routes:

```text
GET   /api/eneo/flows/{flow_id}/runs/{run_id}/transcript-corrections/
PATCH /api/eneo/flows/{flow_id}/runs/{run_id}/steps/{step_id}/transcript-corrections/
GET   /api/eneo/flows/{flow_id}/runs/{run_id}/steps/{step_id}/transcript-words/
```

PATCH replaces the complete correction set for the transcription step:

```json
{
  "schema_version": 3,
  "segments_hash": "<original 64-character hash supplied by Eneo>",
  "expected_revision": 8,
  "occurrences": [],
  "speaker_edits": [
    {
      "segment_index": 0,
      "char_start": null,
      "char_end": null,
      "original": null,
      "original_speaker": "SPEAKER_00",
      "speaker": "SPEAKER_00",
      "decision": "confirmed"
    }
  ]
}
```

This is an illustrative same-speaker confirmation. Use `expected_revision: null`
for the first correction set and the last accepted revision thereafter. Whole-source
segment decisions use null character bounds and null `original`; partial decisions
use an exact nonempty raw text interval and matching `original` text. An unresolved
decision uses `decision: "unresolved"` and `speaker: null`. The original speaker
can itself be null and must remain anchored to the source.

### Invariants

1. **Original source is immutable.** Preserve the model speaker, attribution,
   overlap IDs, source order and raw text independently of human corrections.
2. **Original hash is authoritative.** Lyssna obtains it from transcription metadata
   or a compatible non-stale correction response. It does not hash normalized UI text.
3. **Wire offsets are Unicode code points.** DOM/JavaScript offsets are UTF-16.
   Lyssna converts in both directions. Preserve this distinction for emoji and other
   non-BMP characters.
4. **Selections can cross source segments.** Lyssna creates the corresponding edits
   for each affected source segment and sends one complete replacement set.
5. **Human decisions are durable overlays.** Same-label confirmation is meaningful;
   it must not be discarded as a no-op. Explicit unresolved is different from no review.
6. **Text changes invalidate touched word timings.** Preserve untouched timings and
   original replay bounds. Reject corrections that cannot safely coexist with speaker
   boundaries; do not silently move those boundaries or invent timing.
7. **Metadata remains file-scoped.** Support `transcription.speaker_review.files`,
   preserve Eneo's file-prefixed overlap IDs, and retain file index in UI identity.
   Distinguish detector-unavailable, available-with-no-overlaps and omitted details.
8. **Conflicts must remain conflicts.** Stale source hashes, invalid anchors,
   unsupported data and conflicting revisions must not become successful overwrites.
   Preserve Eneo's tenant/authorization and mutation-audit coverage.

The shared save hook serializes full-list writes. A failure keeps local drafts,
blocks later queued replacements, and prevents approval from reporting success.
Retry retains the original revision rather than silently rebasing a conflicting
edit. Unsaved drafts can be downloaded. Approval awaits the save queue; explicitly
unresolved passages are allowed.

The separate browser-local word-confidence acknowledgements remain lexical review
only. They are not server-persisted speaker decisions.

## 4. Remaining Eneo work

### Regeneration after editing a completed run

At the last Eneo inspection in this task, the local checkout had **no usable
per-step rerun or summary-regeneration endpoint**. Lyssna's older `rerunStep` helper
references a route that was absent, so the editor does not invoke it.

Completed-run edits therefore do not automatically update an existing summary or
generated files. Lyssna displays this limitation and offers a reviewed transcript
download. The notice survives reload by comparing correction and run timestamps.

For Eneo follow-up:

- Check whether a regeneration workflow has since landed before creating another.
- If it has not, provide an explicit workflow that consumes the saved reviewed
  transcript and regenerates the relevant downstream output.
- Define the input correction revision, conflict/idempotency behavior, output
  provenance and the module response contract before connecting the UI.
- Verify that downstream processing preserves human speaker decisions and explicit
  unresolved spans. Do not strip review metadata to bypass Vemsa's rejection of
  realignment of a reviewed transcript.

These are follow-up requirements; regeneration is not implemented by this handover.
The existing editor interactions otherwise use the current v3 correction contract.

## 5. Where to continue in the module

Paths below are relative to the source repository:

| File | Responsibility |
| --- | --- |
| `frontend/components/TranscriptEditor.tsx` | Coherent transcript, direct selection, click-to-review, quick confirmation, text correction, undo, details and inline presentation. |
| `frontend/lib/transcript-selection.ts` | Original selection anchors, whole-passage selection, suggestion eligibility and paragraph continuation grouping. |
| `frontend/components/TranscriptPlayer.tsx` | Audio transport, pause/play state, word seeking, selection replay bounds and editor integration. |
| `frontend/lib/transcript-corrections.ts` | v3 serialization, Unicode conversion, validation, correction overlays and reviewed transcript export. |
| `frontend/components/useTranscriptCorrections.ts` | Shared save queue, revision tracking, retry and draft download. |
| `frontend/components/useTranscriptContext.ts` | Load original transcript, word sidecars, metadata and corrections. |
| `frontend/lib/transcript.ts` and `frontend/lib/speaker-review.ts` | Model metadata, timing, review state and review navigation. |
| `frontend/app/flows/[id]/page.tsx` | Full-width checkpoint editor, collapsible speaker naming, approval and completed-run integration. |
| `frontend/components/SpeakerMappingEditor.tsx` | Global naming and suitable speaker-reference audio. |
| `frontend/lib/api.ts` | Module-facing API types and correction requests. |
| `frontend/lib/confirmed-words.ts` | Stable lexical-confidence keys after source-span splitting. |
| `frontend/lib/transcript-selection.test.ts`, `frontend/lib/speaker-review*.test.ts` | Selection, rendering and v3 regression coverage. |
| `frontend/tests/fixtures/speaker_review.json` | Unmodified shared Vemsa fixtures. |
| `frontend/tests/eneo-review-cases.cjs`, `frontend/tests/verify-eneo-review.py` | Module/Eneo request and export parity checks. |
| `frontend/app/dev/speaker-review/` | Development-only interactive fixtures, including the longer `operator` example. |

This module uses Next.js/React. If Eneo needs an equivalent native Svelte UI,
port the interaction rules and contract tests rather than copying React components
into the Svelte application.

## 6. Enablement and local operation

`NEXT_PUBLIC_SPEAKER_REVIEW_ENABLED=true` enables the new editor and controls.
The default remains false. Metadata preservation and saved correction/export
behavior remain active with the flag off. The upstream Eneo/Vemsa request flag
was not changed by this module work.

For a production image, this is a frontend build setting. Both Dockerfiles and
Compose forward the build argument. For local development, load the root `.env`
in the frontend terminal as well as the backend terminal, then restart the frontend:

```bash
cd /workspaces/eneo-mod-speech-to-text
set -a
source .env
set +a
cd frontend
npm run dev
```

Run these inside the module devcontainer. Its Linux Python 3.12 `.venv` is not
usable from a host macOS terminal. README startup instructions now make that clear
and start the backend with `.venv/bin/python -m uvicorn`.

All Eneo/module repository commands in this environment should run through
`docker exec`. Container names below reflect this session; resolve the current
names if the containers have been recreated.

## Accessibility follow-up

The review editor, audio controls and speaker naming received a WCAG 2.2 AA pass.
Preserve the revised contrast tokens, local focus indicators, normal Tab order,
Alt+T access, valid combobox option IDs, target sizes and narrow-screen scrolling.
The production dependencies and correction API are unchanged.

See [the accessibility review](accessibility-review-2026-09-15.md) for measured
ratios, the 40-state automated audit, reproduction steps and remaining manual
screen-reader/real-workflow acceptance. Do not describe the whole app as certified
from these component checks.

## 7. Verification and acceptance

### Evidence already obtained

- **Latest module state:** 96 tests pass, TypeScript checks pass, and `git diff --check`
  passes after the accessibility changes.
- **Production build:** passed again on the final accessibility state.
- **Earlier v3 integration verification:** 3 Eneo API/persistence/audit tests plus
  79 Eneo domain/propagation/approval tests passed. These were run against the
  local Eneo checkout during integration, not repeated for each UI refinement.
- **Earlier cross-consumer verification:** 26 module-generated request/export cases
  matched Eneo's API models and renderer, including Unicode and partial decisions.
- **Browser checks:** whole dotted passage selection; partial mouse/keyboard text
  selection; cross-fragment assignment and text correction; quick confirmation;
  unresolved without audio; undo; continuation grouping; desktop/narrow layout;
  paused seeking versus seeking during playback; strong word highlight without the
  outer textbox outline; global and mixed-selection bulk confirmation with undo; direct punctuation insertion, continued typing, exact character replacement and deletion with a stable caret.

The interactive fixture saves to React state and uses synthetic silent audio.
It verifies interactions, not real speaker-detection quality or live persistence.
Server persistence was checked separately through the Eneo tests. A dedicated
screen-reader session and a systematic real-recording accuracy evaluation remain
outside the verification performed here.

### Reproduce module checks

```bash
docker exec blissful_boyd sh -lc 'cd /workspaces/eneo-mod-speech-to-text/frontend && npm test && npm run lint && npm run build'
```

After `npm test`, reproduce cross-consumer checks:

```bash
docker exec blissful_boyd cat /workspaces/eneo-mod-speech-to-text/frontend/tests/verify-eneo-review.py | docker exec -i eneo_devcontainer-eneo-1 sh -c 'cat > /tmp/verify-lyssna-review.py'
docker exec blissful_boyd sh -lc 'cd /workspaces/eneo-mod-speech-to-text/frontend && node tests/eneo-review-cases.cjs' | docker exec -i eneo_devcontainer-eneo-1 sh -lc 'cd /workspace/backend && .venv/bin/python /tmp/verify-lyssna-review.py'
```

### Eneo acceptance checklist

- [ ] Confirm the target Eneo revision supports v3, original hashes, null original
  speakers, same-label confirmation, unresolved decisions and optimistic revisions.
- [ ] Save a partial decision, reload the real run, and verify the exact selected
  words, model evidence and revision survive.
- [ ] Select across two source segments, confirm in one operation, reload, and verify
  unaffected words and file identities are unchanged.
- [ ] Insert a missing period directly, continue typing, delete it and undo; save and reload the real run to confirm persistence.
- [ ] Confirm mixed-speaker suggestions globally and within a selection; verify prior human decisions remain and one undo restores the batch.
- [ ] Verify punctuation-complete dotted-passage selection, quick confirmation,
  partial reset and undo after a successful save.
- [ ] Verify a conflict preserves drafts and blocks approval rather than silently
  replacing another operator's work.
- [ ] Verify paused word-click seeking stays paused, active playback keeps playing,
  explicit **Lyssna** starts context replay, and the active word is clearly visible.
- [ ] Verify the Stefan continuation example joins visually without changing original
  segment indices, timing or correction anchors.
- [ ] Check reviewed export and approval propagation against the saved decisions.
- [ ] Confirm the intended regeneration behavior for completed runs before promising
  updated summaries or files.
- [ ] Transfer the complete delivery commit, run the production build in the target
  environment, and enable the feature at frontend build time for deployment.
