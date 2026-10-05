/**
 * Every control of every state does something. Each visible, enabled button, link, menu item, tab, switch, checkbox and
 * radio of a state is activated in a fresh copy of that state (a browser context of its own, so what one activation
 * stores or sends is not there for the next), and must
 *
 * - cause no console error, uncaught error or failed request the state did not declare (the sentinel's rules);
 * - show a response: the URL changed, focus moved elsewhere, an overlay (dialog, menu, list) opened or closed, an
 *   aria-pressed/checked/expanded/selected/current changed, a live region said something, a new tab, download or native
 *   dialog came up, or the page's own content changed (a region that changes by itself, a timer, is left out);
 * - leave the page usable: an overlay it opened closes on Escape or on its own close control.
 *
 * What it does not activate is listed in SKIPPED, by state and control, with the reason; an external link is checked for
 * its address only. What is the current choice already (a chosen radio, the selected tab, the link to the page the person
 * is on) is not pressed: it does nothing by design. A failure a control is meant to cause is declared in EXPECTS, as a
 * state declares its own.
 */
import { type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { expect, test } from "./gate";
import { Sentinel, type Expectation } from "./sentinel";
import { STATES, type State } from "./screens";

test.beforeEach(({}, info) => test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "two widths are enough"));
test.use({ screenshot: "off", trace: "off" });

/** Controls that are not activated, `<state> | <role> "<name>"`, and why. Never a pattern. */
const SKIPPED: Record<string, string> = {
  'signin-sso | button "Logga in med Eneo"': "starts the sign-in handshake, which the dev profile's stub does not answer (tests/prod and the real target do)",
};

/** Failures a control is meant to cause, `<state> | <role> "<name>"`, as a state declares its own (screens.ts). */
const EXPECTS: Record<string, { reason: string; expects: Expectation[] }> = {};

// The flow that must be republished answers 409 to the page that opens it (the state flow-republish-required declares the same).
for (const state of ["flow-list", "unsent-recordings", "unsent-recording-delete-question"]) {
  EXPECTS[`${state} | link "Nämndmöte till strukturerat protokoll med beslut, reservatio"`] = {
    reason: "its flow must be republished: Eneo answers 409 to the page that opens it, and the page says so",
    expects: [{ console: /status of 409.*\/published\// }, { console: /status of 409.*\/run-contract\// }],
  };
}
// An earlier run opened from the setup page: the fake Eneo has no word timings for it, which the page takes as none.
for (const state of ["setup", "setup-participants", "setup-microphone-check", "setup-count-from-names", "setup-count-invalid", "upload-chosen-file", "unsent-on-setup"]) {
  for (const when of ["23 sep 11:00", "22 sep 16:30"]) {
    EXPECTS[`${state} | button "Öppna, körningen ${when}"`] = {
      reason: "the fake Eneo has no word timings for an earlier run (404), which the page takes as none",
      expects: [{ console: /status of 404.*\/transcript-words\// }],
    };
  }
}

/** Presses that change nothing by design, `<state> | <role> "<name>"`, and why: they are still activated, and judged on everything else. */
const NO_RESPONSE: Record<string, string> = {
  'review-editor-selection | button "Rätta text"': "the correction field is open already: the state is reached by pressing it",
  'review-editor-speakers | button "Markera stycket: programledare/intervjuare"': "the passage is marked already: the state is reached by pressing it",
  'review-editor-speakers | button "Flytta uppspelningen till 0:00"': "the recording is paused at 0:00 already: it moves to where it is",
  'review-editor-speakers | button "Bakåt 10 sekunder"': "the recording is at 0:00: it cannot go back",
};
for (const state of ["result", "result-table", "result-steps-open", "result-regenerate", "result-pdf-preview-whole", "result-transcript-tab", "failure", "review", "review-reject"]) {
  NO_RESPONSE[`${state} | button "Alla"`] = "the speaker filter's chosen value: pressed again, it stays";
  NO_RESPONSE[`${state} | button "Spela från 0:00 i del 1"`] = "the recording is paused at 0:00 already: it moves to where it is";
  NO_RESPONSE[`${state} | button "Bakåt 10 sekunder"`] = "the recording is at 0:00: it cannot go back";
}

const SELECTOR = [
  "button", "a[href]", '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemradio"]', '[role="menuitemcheckbox"]',
  '[role="tab"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]', 'input[type="checkbox"]', 'input[type="radio"]',
].join(",");

interface Control {
  index: number;
  role: string;
  name: string;
  /** The address of a link. */
  href: string | null;
  external: boolean;
  /** What the person has chosen or is on already: pressing it changes nothing by design. */
  current: boolean;
}

/** Tags the controls a person can use now with data-controls-index, in document order, and describes them. */
function tagControls(selector: string): Control[] {
  document.querySelectorAll("[data-controls-index]").forEach((element) => element.removeAttribute("data-controls-index"));
  const modal = [...document.querySelectorAll("dialog")].filter((dialog) => dialog.matches(":modal")).at(-1);
  const popover = [...document.querySelectorAll("[popover]")].filter((element) => element.matches(":popover-open") && element.querySelector(selector)).at(-1);
  // Under an open modal, or an open menu, what lies behind it cannot be reached.
  const scope: ParentNode = modal ?? popover ?? document;
  const found: Control[] = [];
  const seen = new Set<Element>();
  for (const element of scope.querySelectorAll(selector)) {
    if (seen.has(element)) continue;
    seen.add(element);
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (style.visibility === "hidden" || style.display === "none" || box.width === 0 || box.height === 0) continue;
    if (element.closest("[inert], [aria-hidden='true']")) continue;
    if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") ?? (tag === "a" ? "link" : tag === "input" ? (element as HTMLInputElement).type : tag);
    const labelledBy = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    const name = (
      element.getAttribute("aria-label") ??
      labelledBy ??
      (element as HTMLInputElement).labels?.[0]?.textContent ??
      element.getAttribute("title") ??
      element.textContent ??
      ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 60);
    const href = tag === "a" ? (element as HTMLAnchorElement).href : null;
    const external = href !== null && (!/^https?:$/.test(new URL(href).protocol) || new URL(href).origin !== location.origin);
    const chosen =
      (role === "radio" && ((element as HTMLInputElement).checked === true || element.getAttribute("aria-checked") === "true")) ||
      (role === "menuitemradio" && element.getAttribute("aria-checked") === "true") ||
      (role === "tab" && element.getAttribute("aria-selected") === "true");
    const here =
      tag === "a" &&
      !external &&
      ((element.getAttribute("aria-current") ?? "false") !== "false" || new URL(href!).pathname + new URL(href!).search === location.pathname + location.search);
    const current = chosen || here;
    element.setAttribute("data-controls-index", String(found.length));
    found.push({ index: found.length, role, name, href: tag === "a" ? element.getAttribute("href") : null, external, current });
  }
  return found;
}

/**
 * Installed before an activation: remembers what the page shows now, and watches for what changes in it. A region that
 * changes with nobody touching the page (a timer, a poll) is found by watching it idle first, and is not a response.
 */
function watch() {
  const key = (element: Element | null) =>
    element ? `${element.tagName.toLowerCase()}${element.getAttribute("role") ? `[${element.getAttribute("role")}]` : ""}:${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}` : "none";
  const shown = (element: Element) => {
    const box = element.getBoundingClientRect();
    return getComputedStyle(element).visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const overlays = () =>
    [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [popover]')]
      .filter((element) => !element.matches('[role="tooltip"]') && (element.matches("dialog") || element.matches("[popover]") ? element.matches(":modal, :popover-open") : shown(element)))
      .map(key)
      .sort();
  const snapshot = () => ({
    url: location.href,
    focus: key(document.activeElement),
    overlays: overlays().join("|"),
    states: [
      ...[...document.querySelectorAll("[aria-pressed], [aria-checked], [aria-expanded], [aria-selected], [aria-current]")].map(
        (element) => `${key(element)}=${["pressed", "checked", "expanded", "selected", "current"].map((name) => element.getAttribute(`aria-${name}`) ?? "").join(",")}`,
      ),
      ...[...document.querySelectorAll("input")].map((input) => `${input.type}:${input.name}:${input.checked}`),
    ].join("|"),
    live: [...document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [data-astryx-live-region]')]
      .map((element) => (element.textContent ?? "").trim())
      .join("|"),
  });
  const SEMANTIC = /^(aria-|disabled$|hidden$|open$|checked$|selected$|value$|href$|src$|role$|tabindex$)/;
  const noisy = new Set<Element>();
  let learning = true;
  const changes: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || target.closest('[role="tooltip"], [data-controls-index-ignore]')) continue;
      if (record.type === "attributes" && !SEMANTIC.test(record.attributeName ?? "")) continue;
      if (record.type === "childList" && [...record.addedNodes, ...record.removedNodes].every((node) => node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())) continue;
      if (learning) noisy.add(target);
      else if (![...noisy].some((region) => region === target || region.contains(target))) changes.push(`${record.type} in ${key(target)}`);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  const before = snapshot();
  const state = {
    before,
    changes,
    endLearning() {
      learning = false;
      Object.assign(state, { before: snapshot() });
    },
    /** What differs now, as words; empty when nothing shows a response. */
    response(target: Element | null): string[] {
      const now = snapshot();
      const out: string[] = [];
      if (now.url !== state.before.url) out.push("the address changed");
      const moved = now.focus !== state.before.focus && !(target && document.activeElement && target.contains(document.activeElement));
      if (moved) out.push(`focus moved to ${now.focus}`);
      if (now.overlays !== state.before.overlays) out.push("an overlay opened or closed");
      if (now.states !== state.before.states) out.push("a state (pressed, checked, expanded, selected) changed");
      if (now.live !== state.before.live) out.push("a live region said something");
      if (changes.length) out.push(`the page changed (${changes[0]})`);
      return out;
    },
    overlays,
  };
  (window as unknown as { __controls: typeof state }).__controls = state;
}

/** The overlays that are open now (dialogs, menus, lists), each as words. */
const overlays = (page: Page) => page.evaluate(() => (window as unknown as { __controls: { overlays(): string[] } }).__controls.overlays());

interface Copy {
  context: BrowserContext;
  page: Page;
  sentinel: Sentinel;
  /** Pages, downloads and native dialogs the page caused. */
  caused: string[];
  close(): Promise<void>;
}

/** A fresh copy of a state: a context of its own, the state reached, the page quiet. */
async function copyOf(browser: Browser, info: TestInfo, state: State): Promise<Copy> {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId, permissions, baseURL, colorScheme, reducedMotion, forcedColors } = info.project.use;
  const context = await browser.newContext({ viewport, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId, permissions, baseURL, colorScheme, reducedMotion, forcedColors });
  const sentinel = new Sentinel();
  await sentinel.watch(context);
  const caused: string[] = [];
  context.on("page", (popup) => void caused.push(`a new tab opened (${popup.url()})`));
  // The dev server has no favicon, and the stub no sign-in: a full navigation to either is not what is under test.
  await context.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  await context.route("**/api/auth/login**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Inloggning hos Eneo</title>" }));
  const page = await context.newPage();
  page.on("download", (download) => void caused.push(`a download (${download.suggestedFilename()})`));
  page.on("filechooser", () => void caused.push("a file chooser opened"));
  page.on("dialog", (dialog) => {
    caused.push(`a native ${dialog.type()} dialog`);
    void dialog.dismiss();
  });
  await state.go(page, info);
  caused.length = 0;
  return { context, page, sentinel, caused, close: () => context.close() };
}

/** Waits until the page has stopped changing for a moment (late data, an animation). */
async function quiet(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let timer = setTimeout(done, 200);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, 200);
        });
        const stop = setTimeout(done, 2_500);
        function done() {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(stop);
          resolve();
        }
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      }),
  );
}

const CLOSERS = /^(Stäng|Avbryt|Stanna kvar|Kör vidare|Nej|Ångra|Behåll)/;

/** The overlays open now that were not there before the activation: what it opened. Waits up to `ms` for them to go. */
async function openedSince(page: Page, before: string[], ms: number) {
  const until = Date.now() + ms;
  let opened = (await overlays(page)).filter((overlay) => !before.includes(overlay));
  while (opened.length && Date.now() < until) {
    await page.waitForTimeout(100);
    opened = (await overlays(page)).filter((overlay) => !before.includes(overlay));
  }
  return opened;
}

/** Activates one control in a fresh copy of the state, and says what is wrong with it, if anything. */
async function check(browser: Browser, info: TestInfo, state: State, control: Control, of: number): Promise<string[]> {
  const label = `${state.name} | ${control.role} "${control.name}"`;
  const where = `${control.role} "${control.name}" (${control.index + 1} of ${of})`;
  const problems: string[] = [];
  let copy: Copy;
  try {
    copy = await copyOf(browser, info, state);
  } catch (error) {
    return [`${where}: the state could not be reached in a fresh copy: ${String(error).split("\n")[0]}`];
  }
  try {
    await quiet(copy.page);
    const tagged = await copy.page.evaluate(tagControls, SELECTOR);
    if (tagged[control.index]?.name !== control.name) return [`${where}: the state differs between two copies (found ${JSON.stringify(tagged[control.index]?.name)})`];
    copy.sentinel.expect(...(EXPECTS[label]?.expects ?? []));
    const target = copy.page.locator(`[data-controls-index="${control.index}"]`);
    await copy.page.evaluate(watch);
    const initial = await overlays(copy.page);
    // Long enough to see what ticks by itself once a second (a timer).
    await copy.page.waitForTimeout(1_100);
    await copy.page.evaluate(() => (window as unknown as { __controls: { endLearning(): void } }).__controls.endLearning());

    try {
      await target.click({ timeout: 5_000 });
    } catch {
      // Not reachable by a pointer (a skip link, clipped until it has focus): as a keyboard user does it.
      await target.focus({ timeout: 2_000 });
      await copy.page.keyboard.press("Enter");
    }
    let navigated = false;
    let response: string[] = [];
    const start = Date.now();
    while (Date.now() - start < 1_500) {
      await copy.page.waitForTimeout(100);
      try {
        response = await copy.page.evaluate(
          (index) => (window as unknown as { __controls: { response(target: Element | null): string[] } }).__controls.response(document.querySelector(`[data-controls-index="${index}"]`)),
          control.index,
        );
      } catch {
        navigated = true;
        break;
      }
      if (response.length || copy.caused.length) break;
    }
    if (!navigated && !response.length && !copy.caused.length && !(label in NO_RESPONSE)) problems.push(`${where}: nothing happened that a person could see`);

    if (!navigated) {
      // Usable afterwards: what it opened closes on Escape or on its own close control.
      let opened = await openedSince(copy.page, initial, 0);
      if (opened.length) {
        await copy.page.keyboard.press("Escape");
        opened = await openedSince(copy.page, initial, 1_500);
      }
      if (opened.length) {
        const closer = copy.page.locator("dialog[open]").last().getByRole("button", { name: CLOSERS });
        if (await closer.count()) {
          await closer.first().click({ timeout: 3_000 }).catch(() => undefined);
          opened = await openedSince(copy.page, initial, 1_500);
        }
      }
      if (opened.length) problems.push(`${where}: opened ${opened.join(", ")}, and neither Escape nor a close control closed it`);
    }

    const { unexpectedConsole, unexpectedFailed } = copy.sentinel.verify();
    if (unexpectedConsole.length) problems.push(`${where}: console errors: ${unexpectedConsole.join("; ")}`);
    if (unexpectedFailed.length) problems.push(`${where}: failed requests: ${unexpectedFailed.join("; ")}`);
    if (copy.sentinel.violations.length) problems.push(`${where}: Content-Security-Policy: ${copy.sentinel.violations.join("; ")}`);
  } catch (error) {
    problems.push(`${where}: ${String(error).split("\n")[0]}`);
  } finally {
    await copy.close();
  }
  return problems;
}

for (const state of STATES) {
  test(`every control of ${state.name} does something`, async ({ browser }, info) => {
    test.skip(state.only ? !state.only(info) : false, "not on this width");
    test.setTimeout(900_000);
    const problems: string[] = [];
    const notes: string[] = [];

    const first = await copyOf(browser, info, state);
    await quiet(first.page);
    const controls = await first.page.evaluate(tagControls, SELECTOR);
    await first.close();
    if (!controls.length) test.skip(true, "a state with no control to activate");

    for (const control of controls) {
      const label = `${state.name} | ${control.role} "${control.name}"`;
      if (label in SKIPPED) {
        notes.push(`skipped ${label}: ${SKIPPED[label]}`);
      } else if (control.href !== null && control.external) {
        if (!control.href || control.href === "#" || /^javascript:/i.test(control.href)) problems.push(`${control.role} "${control.name}": an external link without an address`);
        notes.push(`external ${label}: ${control.href}`);
      } else if (control.href === "#" || control.href === "") {
        problems.push(`${control.role} "${control.name}": a link without an address`);
      } else if (control.current) {
        notes.push(`current ${label}: the choice or the page it is already`);
      } else {
        problems.push(...(await check(browser, info, state, control, controls.length)));
      }
    }
    for (const note of notes) info.annotations.push({ type: "controls", description: note });
    info.annotations.push({ type: "controls", description: `${controls.length} controls` });
    expect(problems, `controls of ${state.name} that do nothing, break something or leave something open`).toEqual([]);
  });
}
