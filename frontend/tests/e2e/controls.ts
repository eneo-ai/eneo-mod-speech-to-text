/**
 * The press on every control of a state, and what judges it: controls.spec.ts runs it on the app's states, and the
 * checks' own tests (harness.spec.ts) on pages built to fail it, which is why it is here and not in the spec.
 *
 * A control is pressed the way the project's person presses it: a finger taps (`hasTouch`), a mouse clicks. A control
 * that neither reaches is a fault and is reported as one. Only a control declared as a keyboard's own (`keyboardOnly`: a
 * skip link, clipped until it has focus) is given focus and Enter instead.
 */
import { type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { Sentinel, type Expectation } from "./sentinel";
import { type State } from "./screens";

/** What a spec declares about its controls, each keyed `<state> | <role> "<name>"` with its reason. Never a pattern. */
export interface Declared {
  /** Controls that are not activated (a press the shared fake Eneo could not take back). */
  skipped?: Record<string, string>;
  /** Failures a control is meant to cause, as a state declares its own (screens.ts). */
  expects?: Record<string, { reason: string; expects: Expectation[] }>;
  /** Presses that change nothing by design: they are still activated, and judged on everything else. */
  noResponse?: Record<string, string>;
  /** Controls no pointer reaches by design: activated with focus and Enter, as a keyboard user does it. */
  keyboardOnly?: Record<string, string>;
  /**
   * Controls a finger presses in Safari that Playwright's WebKit cannot tap, with the evidence from Safari itself: these
   * alone are clicked on a WebKit touch project. Never a pattern.
   */
  clickedInWebKit?: Record<string, string>;
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
  // The modal dialog on top is the one a point inside it reaches: one opened over another (a leave question over the
  // sign-in dialog) covers it, wherever the two stand in the document.
  const modals = [...document.querySelectorAll("dialog")].filter((dialog) => dialog.matches(":modal"));
  const onTop = (dialog: HTMLDialogElement) => {
    const box = dialog.getBoundingClientRect();
    return dialog.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  };
  const modal = modals.find(onTop) ?? modals.at(-1);
  const popover = [...document.querySelectorAll("[popover]")].filter((element) => element.matches(":popover-open") && element.querySelector(selector)).at(-1);
  // Under an open modal, or an open menu, what lies behind it cannot be reached; nor can what is outside an element shown
  // on the whole screen (Strömma's room view), which covers the rest of the page.
  const scope: ParentNode = modal ?? popover ?? document.fullscreenElement ?? document;
  const found: Control[] = [];
  const seen = new Set<Element>();
  for (const element of scope.querySelectorAll(selector)) {
    if (seen.has(element)) continue;
    seen.add(element);
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (style.visibility === "hidden" || style.display === "none" || box.width === 0 || box.height === 0) continue;
    // What a closed <details> holds is not drawn, though a box can be read for it: there is nothing there to press.
    if (!element.checkVisibility()) continue;
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
  // A hint, as the design system's keyboard hint (useKeyboardHint) is: a popover whose content is hidden from assistive
  // tech, which shows on keyboard focus and goes by itself, so no Escape closes it.
  const hint = (element: Element) => element.matches("[popover]") && [...element.children].every((child) => child.getAttribute("aria-hidden") === "true");
  const overlays = () =>
    [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [popover]')]
      .filter((element) => !element.matches('[role="tooltip"]') && (element.matches("dialog") || element.matches("[popover]") ? element.matches(":modal, :popover-open") : shown(element)))
      .map((element) => (hint(element) ? `hint ${key(element)}` : key(element)))
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

/** The browser context a copy of a state is made in: the project's, or a self-test's own (a finger on a laptop's project). */
type Use = TestInfo["project"]["use"];

interface Copy {
  context: BrowserContext;
  page: Page;
  sentinel: Sentinel;
  /** Pages, downloads and native dialogs the page caused. */
  caused: string[];
  close(): Promise<void>;
}

/** A fresh copy of a state: a context of its own, the state reached, the page quiet. */
async function copyOf(browser: Browser, info: TestInfo, state: State, use: Use): Promise<Copy> {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId, permissions, baseURL, colorScheme, reducedMotion, forcedColors } = use;
  const context = await browser.newContext({ viewport, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId, permissions, baseURL, colorScheme, reducedMotion, forcedColors });
  const sentinel = new Sentinel();
  await sentinel.watch(context);
  const caused: string[] = [];
  // The operating system's share sheet is outside the page and Playwright's native-dialog events. Observe the
  // real API boundary; the mutation check still fails a Dela button whose handler never calls it.
  await context.exposeBinding("__controlsShare", (_source, data: { title?: string; text?: string; files?: number }) => {
    if (data.title && (data.text?.trim() || data.files)) caused.push("the device was asked to share text or a file");
  });
  await context.addInitScript(() => {
    if (typeof navigator.share !== "function") return;
    const share = navigator.share.bind(navigator);
    navigator.share = (data) => {
      void (window as unknown as { __controlsShare(data: { title?: string; text?: string; files?: number }): void })
        .__controlsShare({ title: data?.title, text: data?.text, files: data?.files?.length });
      return share(data);
    };
  });
  // The page's microphone streams, so that a copy can let go of them before it goes (see `close` below).
  await context.addInitScript(() => {
    const streams: MediaStream[] = [];
    (window as unknown as { __controlsStreams: MediaStream[] }).__controlsStreams = streams;
    if (typeof MediaDevices === "undefined") return;
    const open = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = async function (this: MediaDevices, ...args: Parameters<typeof open>) {
      const stream = await open.apply(this, args);
      streams.push(stream);
      return stream;
    };
  });
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
  // A state that is not reached (or that leaves the test out, where the browser cannot record) takes its context with it.
  await state.go(page, info).catch(async (error) => {
    await context.close();
    throw error;
  });
  caused.length = 0;
  // A copy ends its own recording before its context goes. WebKit takes the microphone from a recording that began just
  // before another context's was closed under it, and the next copy of a recording state would then record nothing.
  const close = async () => {
    await page
      .evaluate(() => (window as unknown as { __controlsStreams?: MediaStream[] }).__controlsStreams?.forEach((stream) => stream.getTracks().forEach((track) => track.stop())))
      .catch(() => undefined);
    await context.close();
  };
  return { context, page, sentinel, caused, close };
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

/** Why a press did not land, from Playwright's log of it: what was in the way if it says, else its first line. */
function whyNot(error: unknown) {
  // Without the colours Playwright writes its log in.
  const lines = String(error).replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim());
  return lines.findLast((line) => /intercepts pointer events|outside of the viewport|not visible|not stable/.test(line)) ?? lines[0];
}

/** Activates one control in a fresh copy of the state, and says what is wrong with it, if anything. */
async function check(browser: Browser, info: TestInfo, state: State, control: Control, of: number, declared: Declared, use: Use): Promise<string[]> {
  const label = `${state.name} | ${control.role} "${control.name}"`;
  const where = `${control.role} "${control.name}" (${control.index + 1} of ${of})`;
  const problems: string[] = [];
  const finger = use.hasTouch === true && !(info.project.use.browserName === "webkit" && label in (declared.clickedInWebKit ?? {}));
  const press = (locator: Locator, timeout: number) => (finger ? locator.tap({ timeout }) : locator.click({ timeout }));
  let copy: Copy;
  try {
    copy = await copyOf(browser, info, state, use);
  } catch (error) {
    return [`${where}: the state could not be reached in a fresh copy: ${String(error).split("\n")[0]}`];
  }
  try {
    await quiet(copy.page);
    const tagged = await copy.page.evaluate(tagControls, SELECTOR);
    if (tagged[control.index]?.name !== control.name) return [`${where}: the state differs between two copies (found ${JSON.stringify(tagged[control.index]?.name)})`];
    copy.sentinel.expect(...(declared.expects?.[label]?.expects ?? []));
    const target = copy.page.locator(`[data-controls-index="${control.index}"]`);
    await copy.page.evaluate(watch);
    const initial = await overlays(copy.page);
    // Long enough to see what ticks by itself once a second (a timer).
    await copy.page.waitForTimeout(1_100);
    await copy.page.evaluate(() => (window as unknown as { __controls: { endLearning(): void } }).__controls.endLearning());

    if (label in (declared.keyboardOnly ?? {})) {
      await target.focus({ timeout: 2_000 });
      await copy.page.keyboard.press("Enter");
    } else {
      try {
        await press(target, 5_000);
      } catch (error) {
        // No press landed, so there is no response to judge: under something, off the screen, or never still.
        return [`${where}: a ${finger ? "finger" : "mouse"} cannot press it (${whyNot(error)})`];
      }
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
    if (!navigated && !response.length && !copy.caused.length && !(label in (declared.noResponse ?? {}))) problems.push(`${where}: nothing happened that a person could see`);

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
          await press(closer.first(), 3_000).catch(() => undefined);
          opened = await openedSince(copy.page, initial, 1_500);
        }
      }
      // A hint goes by itself (the design system's keyboard hint after 3 s, shown when Escape gives a toolbar the focus back).
      if (opened.length && opened.every((overlay) => overlay.startsWith("hint "))) opened = await openedSince(copy.page, initial, 4_000);
      if (opened.length) problems.push(`${where}: opened ${opened.join(", ")}, and neither Escape nor a close control closed it`);
    }

    // Everything the sentinel judges, as on the real target. A failure that is declared may come a moment after what the
    // person sees (the page a link opens asks Eneo and is refused), so it is waited for before it is called missing.
    for (const until = Date.now() + 5_000; copy.sentinel.verify().missing.length && Date.now() < until; ) await copy.page.waitForTimeout(100);
    const { unexpectedConsole, unexpectedFailed, missing } = copy.sentinel.verify();
    if (unexpectedConsole.length) problems.push(`${where}: console errors: ${unexpectedConsole.join("; ")}`);
    if (unexpectedFailed.length) problems.push(`${where}: failed requests: ${unexpectedFailed.join("; ")}`);
    if (missing.length) problems.push(`${where}: declared failures that did not occur: ${missing.join("; ")}`);
    if (copy.sentinel.redirects.length) problems.push(`${where}: redirects: ${copy.sentinel.redirects.join("; ")}`);
    if (copy.sentinel.violations.length) problems.push(`${where}: Content-Security-Policy: ${copy.sentinel.violations.join("; ")}`);
  } catch (error) {
    problems.push(`${where}: ${String(error).split("\n")[0]}`);
  } finally {
    await copy.close();
  }
  return problems;
}

/**
 * Presses every control of a state, each in a fresh copy of it. `controls` is how many the state has; `problems` what is
 * wrong with them; `notes` what was not pressed with a pointer, and why. `use` is the browser context of the copies: the
 * project's own unless a self-test asks for another.
 */
export async function sweep(browser: Browser, info: TestInfo, state: State, declared: Declared, use: Use = info.project.use) {
  const problems: string[] = [];
  const notes: string[] = [];

  const first = await copyOf(browser, info, state, use);
  await quiet(first.page);
  const controls = await first.page.evaluate(tagControls, SELECTOR);
  await first.close();

  for (const control of controls) {
    const label = `${state.name} | ${control.role} "${control.name}"`;
    if (label in (declared.skipped ?? {})) {
      notes.push(`skipped ${label}: ${declared.skipped![label]}`);
    } else if (control.href !== null && control.external) {
      if (!control.href || control.href === "#" || /^javascript:/i.test(control.href)) problems.push(`${control.role} "${control.name}": an external link without an address`);
      notes.push(`external ${label}: ${control.href}`);
    } else if (control.href === "#" || control.href === "") {
      problems.push(`${control.role} "${control.name}": a link without an address`);
    } else if (control.current) {
      notes.push(`current ${label}: the choice or the page it is already`);
    } else {
      if (label in (declared.keyboardOnly ?? {})) notes.push(`keyboard ${label}: ${declared.keyboardOnly![label]}`);
      if (label in (declared.clickedInWebKit ?? {})) notes.push(`clicked in WebKit ${label}: ${declared.clickedInWebKit![label]}`);
      problems.push(...(await check(browser, info, state, control, controls.length, declared, use)));
    }
  }
  return { controls: controls.length, problems, notes };
}
