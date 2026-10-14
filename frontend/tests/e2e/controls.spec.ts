/**
 * Every control of every state does something. Each visible, enabled button, link, menu item, tab, switch, checkbox and
 * radio of a state is activated in a fresh copy of that state (a browser context of its own, so what one activation
 * stores or sends is not there for the next), and must
 *
 * - take the press of the project's person: a finger's tap on a touch screen, a mouse's click elsewhere. A control that
 *   pointer cannot reach (it is under something, or off the screen) fails;
 * - cause no console error, uncaught error or failed request the state did not declare, no redirect, and every failure
 *   that is declared (the sentinel's rules, all of them);
 * - show a response: the URL changed, focus moved elsewhere, an overlay (dialog, menu, list) opened or closed, an
 *   aria-pressed/checked/expanded/selected/current changed, a live region said something, a new tab, download or native
 *   dialog came up, or the page's own content changed (a region that changes by itself, a timer, is left out);
 * - leave the page usable: an overlay it opened closes on Escape or on its own close control, and a hint goes by itself.
 *
 * What it does not activate is listed in SKIPPED, by state and control, with the reason; an external link is checked for
 * its address only. What is the current choice already (a chosen radio, the selected tab, the link to the page the person
 * is on) is not pressed: it does nothing by design. A failure a control is meant to cause is declared in EXPECTS, as a
 * state declares its own, and a control that only a keyboard reaches in KEYBOARD_ONLY. The press itself and what judges
 * it are in controls.ts, which the checks' own tests run too (harness.spec.ts).
 */
import { expect, test } from "./gate";
import { sweep } from "./controls";
import { type Expectation } from "./sentinel";
import { STATES } from "./screens";

// Which projects press every control is the config's to say (playwright.config.ts): a phone, both tablets and a laptop.
test.use({ screenshot: "off", trace: "off" });

/** Controls that are not activated (a press the shared fake Eneo could not take back), `<state> | <role> "<name>"`, and why. Never a pattern. None today. */
const SKIPPED: Record<string, string> = {};

/** Failures a control is meant to cause, `<state> | <role> "<name>"`, as a state declares its own (screens.ts). */
const EXPECTS: Record<string, { reason: string; expects: Expectation[] }> = {};

// The flow that must be republished answers 409 to the page that opens it (the state flow-republish-required declares the same).
for (const state of ["flow-list", "branding-custom-flow-list", "branding-name-flow-list", "version", "version-commit-only", "version-nothing-known", "unsent-recordings", "unsent-recording-delete-question"]) {
  EXPECTS[`${state} | link "Nämndmöte till strukturerat protokoll med beslut, reservatio"`] = {
    reason: "its flow must be republished: Eneo answers 409 to the page that opens it, and the page says so",
    expects: [{ console: /status of 409.*\/published\// }, { console: /status of 409.*\/run-contract\// }],
  };
}
/** Presses that change nothing by design, `<state> | <role> "<name>"`, and why: they are still activated, and judged on everything else. */
const NO_RESPONSE: Record<string, string> = {
  'review-editor-selection | button "Rätta text"': "the correction field is open already: the state is reached by pressing it",
  'review-editor-details | button "Markera hela passagen: Nu har vi pratat ganska länge om det "': "the passage is marked already: the state is reached by marking it",
  'review-editor-readonly | button "Markera hela passagen: Nu har vi pratat ganska länge om det "': "the passage is marked already: the state is reached by marking it",
  'review-editor-speakers | button "Markera stycket: programledare/intervjuare"': "the passage is marked already: the state is reached by pressing it",
  'review-editor-speakers | button "Flytta uppspelningen till 0:00"': "the recording is paused at 0:00 already: it moves to where it is",
};
for (const state of ["result", "result-file-backed-text", "result-table", "result-steps-open", "result-regenerate", "result-pdf-preview-whole", "result-transcript-tab", "result-word-selected", "result-search-and-playhead", "result-correction-open", "file-missing", "failure", "review", "review-reject"]) {
  NO_RESPONSE[`${state} | button "Alla"`] = "the speaker filter's chosen value: pressed again, it stays";
  NO_RESPONSE[`${state} | button "Spela från 0:00 i del 1"`] = "the recording is paused at 0:00 already: it moves to where it is";
}

/**
 * Controls no pointer reaches by design, `<state> | <role> "<name>"`, and why: these alone are given focus and Enter, as a
 * keyboard user does it. Any other control that a tap or a click cannot reach fails.
 */
const KEYBOARD_ONLY: Record<string, string> = {
  'foundation-selector | combobox "Talare"': "its own open list lies over it, as the design system's selector opens: a pointer chooses in the list or presses beside it",
  'setup-date | button "Stäng kalender"': "the calendar's close for a keyboard and a screen reader, which the design system keeps out of sight: a pointer presses beside the calendar",
};

/**
 * Controls Safari takes a tap on that Playwright's WebKit cannot tap, `<state> | <role> "<name>"`, and the evidence: on a
 * WebKit touch project these alone are clicked. Checked in Safari on an iOS 27 simulator (agent-device).
 */
const CLICKED_IN_WEBKIT: Record<string, string> = {
  'result-search-and-playhead | button "Rensa Sök i transkriberingen"':
    "the design system's clear button prevents its pointerdown to keep the field focused; Playwright's WebKit then fires no click after the tap, while Safari on iOS 27 clears the search (2026-10-13)",
};

// CI shards this file by count, in order, and the slowest states (review, result) sit together at the end of STATES: taken
// from both ends in turn, each shard gets its share of them.
const ORDER = STATES.map((_, i) => STATES[i % 2 ? STATES.length - 1 - (i - 1) / 2 : i / 2]);

for (const state of ORDER) {
  test(`every control of ${state.name} does something`, async ({ browser }, info) => {
    test.skip(state.only ? !state.only(info) : false, "the state does not exist at this width or in this browser");
    test.setTimeout(900_000);
    const { controls, problems, notes } = await sweep(browser, info, state, { skipped: SKIPPED, expects: EXPECTS, noResponse: NO_RESPONSE, clickedInWebKit: CLICKED_IN_WEBKIT, keyboardOnly: KEYBOARD_ONLY });
    if (!controls) test.skip(true, "a state with no control to activate");
    for (const note of notes) info.annotations.push({ type: "controls", description: note });
    info.annotations.push({ type: "controls", description: `${controls} controls` });
    expect(problems, `controls of ${state.name} that do nothing, break something or leave something open`).toEqual([]);
  });
}
