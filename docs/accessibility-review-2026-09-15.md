# Lyssna accessibility review — 2026-09-15

## Scope and baseline

WCAG 2.2 Level AA pass on the transcript review/editor, audio transport and speaker
naming controls. Includes the shared theme tokens used by these components.
Implemented locally in the module; this is not a certification of the entire
application or the surrounding Eneo workflow.

References: [WCAG 2.2](https://www.w3.org/TR/WCAG22/),
[text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html),
[non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html),
[focus visibility](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html),
[unobscured focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html),
[target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html),
[reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), and
[text spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html).

## Fixes

| Area | Implemented change |
| --- | --- |
| Text / speaker contrast (1.4.3) | Darkened the light-theme green and orange speaker colors. All six speaker colors now meet 4.5:1 against paper and chip backgrounds. |
| Review marks / control edges (1.4.11) | Darkened light-theme review marks; strengthened input borders in both themes. Decorative card separators remain subtle. |
| Keyboard navigation (2.1.1, 2.1.2, 2.4.3) | Removed the selection-to-toolbar Tab loop. Tab follows document order; Alt+T moves from transcript text to the tools. Escape clears selection. Enter/Space on a focused dotted passage selects it and focuses its controls. |
| Focus visibility (2.4.7, 2.4.11) | Explicit local focus rings on controls, including the previously outline-free speaker select. The editable transcript gets a small label/paragraph focus indicator, without the rejected full-textbox outline. Scrolling accounts for the toolbar height. |
| Focus after actions | When confirmation disables/removes its focused control, focus goes to Undo. Closing the selection or undoing returns focus to the transcript. Cancelling the text field returns focus to its tools. |
| Accessible names / state (1.3.1, 4.1.2) | Passage labels include speaker and review status. Details links to its controlled region. The audio slider announces elapsed and total time. Status messages have a stable live region. No word-by-word live announcements during playback. |
| Naming combobox (4.1.2) | Unique option IDs no longer contain names/spaces or collide with reserved options. Labelled listbox, visible active option, keyboard option scrolling, and an operable toggle. Long option names wrap. |
| Targets (2.5.8) | Increased small timestamp, follow and file controls, plus the inline passage hit area. |
| Reflow / spacing (1.4.10, 1.4.12) | Wrapped controls and long transcript words. On narrow or short screens, the toolbar stops sticking and the transcript uses page scrolling, so enlarged controls cannot cover the text. |
| Motion / forced colors | Reduced-motion preference disables smooth transcript following and decorative recording loops. Forced-color mode uses system colors for the active word and review underlines, retaining text labels and dotted/solid patterns. |

## Measured contrast

Ratios are computed from CSS HSL tokens with WCAG relative luminance, not sampled
from antialiased screenshot pixels. Normal text requires at least 4.5:1; meaningful
control edges and graphical indicators require at least 3:1. Disabled controls and
decorative separators are not treated as active control boundaries.

| Pair | Before | After |
| --- | ---: | ---: |
| Light green speaker / chip | 4.42:1 | 5.14:1 |
| Light orange speaker / paper | 4.48:1 | 5.83:1 |
| Light orange speaker / chip | 3.92:1 | 5.10:1 |
| Light review mark / paper | 2.00:1 | 5.43:1 |
| Light input border / paper | 2.03:1 | 3.87:1 |
| Dark input border / paper | 2.70:1 | 3.88:1 |

The regression tests also check primary/secondary/muted text, all speaker labels,
accent text, active-word foregrounds, alpha-blended selection backgrounds and
quick-confirm hover backgrounds in both themes.

## Verification

- 96 module tests pass, including contrast and accessible option-ID regressions.
- TypeScript checks pass. Production build is checked with this delivery.
- Playwright 1.63.0 and axe-core/playwright 4.13.0: **40 rendered states, zero
  automated WCAG A/AA violations and zero document horizontal overflow**.
- Matrix: light/dark × 1280/320 CSS-pixel widths × unavailable audio, selection,
  details, text correction, confirmed proposals, read-only, open speaker names,
  all six speaker colors, increased text spacing and forced colors.
- Keyboard assertions cover normal Tab order after selection, Alt+T tool access,
  focus restoration after bulk confirmation, valid active-descendant targets and
  focused transcript text remaining visible.
- Screenshots inspected for narrow light and desktop dark layouts with increased
  spacing and long names/words.
- Four open-name-list scans mark background contrast as needing manual review
  because the popup covers controls beneath it. The same controls pass in the
  closed-popup scans, and their foreground/background pairs pass token tests.
  These are retained in the report rather than silently suppressed.

Raw results: [accessibility-audit-results-2026-09-15.json](accessibility-audit-results-2026-09-15.json).
All browser fixtures are synthetic. No real-run data is accessed or changed by the audit.

## Repeat the checks

Commands run inside the devcontainer. Audit tools are temporary test dependencies,
not production app dependencies. The dev frontend must be running on port 3002.

```sh
docker exec blissful_boyd npm install --prefix /tmp/lyssna-a11y-tools --no-audit --no-fund playwright@1.63.0 @axe-core/playwright@4.13.0
docker exec blissful_boyd /tmp/lyssna-a11y-tools/node_modules/.bin/playwright install --with-deps chromium
docker exec blissful_boyd sh -lc 'cd /workspaces/eneo-mod-speech-to-text/frontend && NODE_PATH=/tmp/lyssna-a11y-tools/node_modules node tests/accessibility-audit.cjs'
docker exec blissful_boyd sh -lc 'cd /workspaces/eneo-mod-speech-to-text/frontend && npm test && npm run lint && npm run build'
```

## Remaining manual acceptance before a conformance claim

- VoiceOver/Safari and NVDA/Firefox or Chrome on a real run: read the coherent
  transcript, identify speakers without color, select/edit a phrase, assign it,
  hear save errors/status, confirm a batch, undo, and finish review.
- Actual browser zoom at 200% and 400%, OS text enlargement, and mobile screen-reader
  operation. The 320px automated checks verify reflow; they do not replace all
  browser/assistive-technology zoom combinations.
- Full Eneo page/workflow review, including authentication, upload, approval footer,
  error recovery and generated/exported documents. The shared components were
  audited through fixtures; the surrounding authenticated page was not scanned.
- Real audio/transcript accuracy and completeness. Synthetic silence verifies media
  controls and timing UI, not the quality of the audio alternative.

Carry these checks into Eneo acceptance. Zero automated findings is useful evidence,
not proof of complete WCAG conformance.
