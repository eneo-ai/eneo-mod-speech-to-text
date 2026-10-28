/**
 * The gate's own checks against pages built to fail them: a check that passes
 * these would pass the app's faults too. They run once in each engine, on the project the config names
 * (playwright.config.ts): every engine must see each check fail.
 */
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { type Page, type TestInfo } from "@playwright/test";
import { expect, test } from "./gate";
import { axe, blocking, focusStop, movingAnimations, placeholderContrast, settle, stopProblems, tabKey, tabWalk, targetSizes, undecidedContrast } from "./checks";
import { sweep } from "./controls";
import { STATES, type State } from "./screens";

/**
 * A page of the checks' own, as a state that the press on every control (controls.ts) can copy. The test serves it at an
 * address of the app's origin, so the page can ask for other addresses, which `answers` serves.
 */
const fixture = (name: string, html: string, answers?: (page: Page) => Promise<unknown>): State => ({
  name,
  go: async (page) => {
    // The viewport line makes the page as wide as a phone's screen, so a tap lands where the control is.
    const body = `<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Prov</title>${html}`;
    await page.route("**/fixture/page", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body }));
    await answers?.(page);
    await page.goto("/fixture/page");
  },
});

/** The project's browser context with a mouse, or with a finger. */
const held = (info: TestInfo, hasTouch: boolean) => ({ ...info.project.use, hasTouch });

test("a keyboard trap that cycles between two controls is caught", async ({ page }) => {
  await page.setContent(`
    <button id="a">A</button><button id="b">B</button><button id="c">C</button>
    <script>
      // Tab from B goes back to A, and Shift+Tab from A to B: focus never reaches C or leaves.
      document.getElementById("b").addEventListener("keydown", (e) => {
        if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); document.getElementById("a").focus(); }
      });
    </script>`);
  const { left } = await tabWalk(page, 12);
  expect(left, "the walk says focus never left the page").toBe(false);
});

test("a control in a dialog is in a dialog, native or with the role, so the page's reading order does not judge it", async ({ page }) => {
  await page.setContent(`
    <main><h1>Prov</h1><button>Bakom</button></main>
    <dialog id="native" aria-label="Namnge"><button>Spara</button></dialog>
    <div role="alertdialog" aria-label="Fråga"><button>Svara</button></div>
    <script>document.getElementById("native").showModal()</script>`);
  const inDialog = async (name: string) => {
    await page.getByRole("button", { name }).evaluate((element) => (element as HTMLElement).focus());
    return (await focusStop(page))?.inDialog;
  };
  expect(await inDialog("Spara"), "a native <dialog> has no role attribute").toBe(true);
  expect(await inDialog("Svara")).toBe(true);
  // The page behind a modal dialog cannot take focus, so what is not in a dialog is read where nothing is open.
  await page.evaluate(() => (document.getElementById("native") as HTMLDialogElement).close());
  expect(await inDialog("Bakom"), "the page itself is not a dialog").toBe(false);
});

test("a WCAG violation blocks the gate whatever axe calls its impact", async ({ page }) => {
  // html-xml-lang-mismatch is WCAG 3.1.1 and axe calls it moderate.
  await page.setContent(`<html lang="sv" xml:lang="en"><head><title>Prov</title></head><body><main><h1>Prov</h1></main></body></html>`);
  const scan = await axe(page);
  expect(blocking(scan.violations).map((v) => v.id)).toContain("html-xml-lang-mismatch");
});

test("colours are measured once a colour change has ended, not halfway through it", async ({ page }) => {
  // A button enabled a moment before the scan fades from its disabled grey to its colour.
  await page.setContent(`
    <style>
      button { color: #fff; background: #ddd; border: 0; padding: 8px; transition: background-color 1s linear; }
      button.on { background: #1d4ed8; }
    </style>
    <main><h1>Prov</h1><button>Godkänn</button></main>`);
  await page.evaluate(() => requestAnimationFrame(() => document.querySelector("button")!.classList.add("on")));
  await page.waitForFunction(() => document.getAnimations().length > 0);
  const scan = await axe(page);
  expect(scan.violations.map((v) => v.id)).not.toContain("color-contrast");
});

test("text that axe cannot decide (over a gradient) is measured on the screen's pixels: too faint fails, clear passes", async ({ page }) => {
  await page.setContent(`
    <style>
      body { margin: 0; font: 16px/1.5 sans-serif; }
      .ground { padding: 16px; background: linear-gradient(90deg, #ffffff, #f2f2f2); }
    </style>
    <main><h1>Prov</h1>
      <div class="ground"><p id="faint" style="color: #959595">Svag text</p><p id="clear" style="color: #333333">Tydlig text</p><p id="none" style="color: transparent">Ingen färg</p></div>
    </main>`);
  const scan = await axe(page);
  const targets = scan.undecidedText.map((item) => item.target);
  expect(targets, "axe leaves both to a person").toEqual(expect.arrayContaining(["#faint", "#clear"]));
  const measured = await undecidedContrast(page, scan.undecidedText);
  const ratio = (target: string) => measured.find((item) => item.target === target)!;
  expect(ratio("#faint").ratio).toBeLessThan(ratio("#faint").needed);
  expect(ratio("#clear").ratio).toBeGreaterThanOrEqual(7);
  expect(await page.locator("[data-contrast-probe]").count(), "the page is left as it was").toBe(0);
  // Drawn in no colour (a field whose value another layer shows): no text a person reads there, not measured.
  expect(await undecidedContrast(page, [{ target: "#none", reason: "bgGradient" }])).toEqual([]);
  // Covered by a layer of its own colour (a popover over the page): not text a person reads, not measured.
  await page.evaluate(() => {
    const cover = Object.assign(document.createElement("div"), { style: "position: fixed; inset: 0; background: #959595" });
    document.body.append(cover);
  });
  expect(await undecidedContrast(page, [{ target: "#faint", reason: "bgOverlap" }])).toEqual([]);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("clear")!).color)).toBe("rgb(51, 51, 51)");
});

test("undecided text is measured on what is behind its letters, not on the rest of its box", async ({ page }) => {
  await page.setContent(`
    <style>
      body { margin: 0; font: 16px/1.5 sans-serif; }
      p { width: fit-content; margin: 16px; color: #000000; }
      /* Most of the box is white, but its first words stand on black. */
      #mixed { padding-right: 120px; background: linear-gradient(90deg, #000000 0 40%, #ffffff 40%); }
      /* Most of the box is black, in a padding where no letter stands; the words stand on white. */
      #beside { padding-left: 200px; background: linear-gradient(90deg, #000000 0 190px, #ffffff 190px); }
      /* A word in a colour and on a ground of its own is its own text, not its parent's. */
      #parent { background: linear-gradient(90deg, #ffffff, #f2f2f2); }
      #parent mark { color: #ffffff; background: #000000; }
    </style>
    <main><h1>Prov</h1>
      <p id="mixed">Delvis på svart botten</p><p id="beside">På vit botten</p><p id="parent">Text och <mark>märkt</mark> ord</p>
    </main>`);
  const scan = await axe(page);
  expect(scan.undecidedText.map((item) => item.target), "axe leaves them to a person").toEqual(expect.arrayContaining(["#mixed", "#beside", "#parent"]));
  const measured = await undecidedContrast(page, scan.undecidedText);
  const of = (target: string) => measured.find((item) => item.target === target)!;
  expect(of("#mixed").ratio, "letters on black: about 1:1, whatever the white around them").toBeLessThan(of("#mixed").needed);
  expect(of("#beside").ratio, "letters on white: 21:1, whatever the black beside them").toBeGreaterThanOrEqual(7);
  expect(of("#parent").ratio, "the marked word's black ground is not under the parent's black letters").toBeGreaterThanOrEqual(7);
});

test("text behind an open modal dialog is out of reach, so its contrast is not measured; the dialog's own is", async ({ page }) => {
  await page.setContent(`
    <style>body { margin: 0; font: 16px/1.5 sans-serif; } dialog { inset-block-start: 60vh; } dialog::backdrop { background: rgb(0 0 0 / 0.6); }</style>
    <main><h1>Prov</h1><p id="behind" style="color: #333333">Bakom dialogen</p><p id="inert" inert style="color: #333333">Inert</p></main>
    <dialog><p id="inside" style="color: #959595">I dialogen</p></dialog>`);
  await page.evaluate(() => document.querySelector("dialog")!.showModal());
  const reasons = ["#behind", "#inert", "#inside"].map((target) => ({ target, reason: "bgOverlap" }));
  expect((await undecidedContrast(page, reasons)).map((item) => item.target)).toEqual(["#inside"]);
});

test("a placeholder colour the browser gives as color(srgb …) is read as it is, not as near-black", async ({ page }) => {
  // A colour mix computes to color(srgb 0.6 0.6 0.6 / 0.8): #999 at 80 % on white, about 2.3:1.
  await page.setContent(`
    <style>input::placeholder { color: color-mix(in srgb, #999999 80%, transparent); } input.clear::placeholder { color: color-mix(in srgb, #333333 90%, transparent); }</style>
    <main><h1>Prov</h1><input aria-label="Svag" placeholder="Svag"><input class="clear" aria-label="Tydlig" placeholder="Tydlig"></main>`);
  expect(await page.locator("input").first().evaluate((el) => getComputedStyle(el, "::placeholder").color)).toMatch(/^color\(srgb /);
  expect(await placeholderContrast(page)).toEqual([expect.stringMatching(/^input "Svag" 2\.\d\d:1$/)]);
});

test("with reduced motion, what moves on screen is caught and a fade is not", async ({ page }) => {
  await page.setContent(`
    <style>
      .fade { transition: opacity 5s linear; } .fade.on { opacity: 0.2; }
      .slide { transition: transform 5s linear; } .slide.on { transform: translateY(40px); }
      @keyframes rise { from { margin-top: 20px; } to { margin-top: 0; } }
      .rise { animation: rise 5s linear; }
    </style>
    <main><h1>Prov</h1><p class="fade">Tonar</p><p class="slide">Glider</p></main>`);
  await page.evaluate(() => requestAnimationFrame(() => document.querySelectorAll(".fade, .slide").forEach((p) => p.classList.add("on"))));
  await page.waitForFunction(() => document.getAnimations().length === 2);
  expect(await movingAnimations(page)).toEqual(["transform on p.slide.on"]);
  await page.evaluate(() => document.querySelector("h1")!.classList.add("rise"));
  expect(await movingAnimations(page)).toContain("margin-top on h1.rise");
});

test("targets are measured once a smooth scroll has ended, not on their way past a pinned bar", async ({ page }) => {
  // A step to the next passage scrolls it to the window's middle, smoothly: what it scrolls by passes under the dock.
  await page.setContent(`<main><h1>Prov</h1><div style="block-size: 6000px"></div><button>Mål</button><div style="block-size: 6000px"></div></main>`);
  await page.evaluate(() => document.querySelector("button")!.scrollIntoView({ block: "start", behavior: "smooth" }));
  await settle(page);
  // Firefox comes to rest at a fraction of a pixel (and Math.round of -0.3 is -0, which toBe tells from 0); a scroll still
  // under way is hundreds of pixels off.
  const top = await page.evaluate(() => document.querySelector("button")!.getBoundingClientRect().top);
  expect(Math.abs(top), "the scroll has come to rest").toBeLessThanOrEqual(1);
});

test("a control Tab focuses is measured where the engine's own scroll brings it, not on that scroll's way", async ({ page }) => {
  // As WebKit on a loaded Linux runner reveals a focused control far down the page: with a scroll still on its way when
  // focus has moved. Here the page takes the focus without a scroll and then scrolls smoothly itself.
  await page.setContent(`
    <main><h1>Prov</h1><button id="a">Först</button><div style="block-size: 4000px"></div><button id="b">Längre ner</button></main>
    <script>
      document.getElementById("a").addEventListener("keydown", (e) => {
        if (e.key !== "Tab" || e.shiftKey) return;
        e.preventDefault();
        const far = document.getElementById("b");
        far.focus({ preventScroll: true });
        far.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    </script>`);
  await page.locator("#a").focus();
  await page.keyboard.press("Tab");
  const stop = await focusStop(page);
  expect(stop?.label).toContain("Längre ner");
  expect(stop?.offscreen, "measured where it came to rest").toBe(false);
});

test("a focus outline that cannot be seen is not taken for a focus indicator", async ({ page }) => {
  await page.setContent(`
    <style>
      body { background: #fff; }
      button { background: #fff; color: #111; border: 1px solid #767676; outline: none; }
      #white:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
      #black:focus-visible { outline: 3px solid #111; outline-offset: 2px; }
    </style>
    <p><button id="white">Vit ring</button></p>
    <p><button id="black">Svart ring</button></p>`);
  await page.keyboard.press(tabKey(page));
  expect((await focusStop(page))?.indicator, "white on white").toBe(false);
  await page.keyboard.press(tabKey(page));
  expect((await focusStop(page))?.indicator, "black on white").toBe(true);
});

const RINGED = `
  <style>
    body { background: #fff; }
    button { background: #fff; color: #111; border: 1px solid #767676; outline: none; }
    button:focus-visible { outline: 3px solid #111; outline-offset: 2px; }
  </style>`;

test("a control that moves while its ring is measured is measured where it stands", async ({ page }) => {
  await page.setContent(`${RINGED}
    <p id="above"></p>
    <p><button id="once">Flyttas en gång</button></p>
    <script>
      // As a status line that wraps anew above it: the first time the probe takes focus off it, it moves 40 px down.
      document.getElementById("once").addEventListener("blur", () => setTimeout(() => (document.getElementById("above").style.height = "40px")), { once: true });
    </script>`);
  await page.keyboard.press(tabKey(page));
  expect((await focusStop(page))?.indicator, "the ring, where the control moved to").toBe(true);
});

test("a control that never stands still while its ring is measured is reported as such, not as ringless", async ({ page }) => {
  await page.setContent(`${RINGED}
    <p><button id="always">Står aldrig still</button></p>
    <script>
      // Never still through a measurement, in every engine: it moves each time focus leaves it, and the measurement
      // takes focus off it between its two screenshots. (A timer would not do: WebKit runs none while it takes them.)
      const always = document.getElementById("always");
      let shift = 0;
      always.addEventListener("blur", () => (always.style.marginInlineStart = (shift += 10) + "px"));
    </script>`);
  await page.keyboard.press(tabKey(page));
  const restless = await focusStop(page);
  expect(restless?.unsettled, "never still").toBe(true);
  expect(stopProblems([restless!])).toEqual([`${restless!.label}: kept moving while its focus indicator was measured`]);
});

test("a region taller than the window is held to the ring on its edges that show, and a ring that shows nowhere fails", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`
    <style>
      body { margin: 0; background: #fff; }
      .region { box-sizing: border-box; margin: 520px 40px 40px; height: 1400px; border: 1px solid #ddd; outline: none; }
      #ringed:focus-visible { outline: 2px solid #111; outline-offset: -2px; }
    </style>
    <div class="region" id="ringed" tabindex="0" role="region" aria-label="Med ring"></div>
    <div class="region" id="bare" tabindex="0" role="region" aria-label="Utan ring"></div>`);
  // Its top and 80 px of its sides show, as a transcript below the fold does; its bottom is far past the window's.
  await page.keyboard.press(tabKey(page));
  await page.evaluate(() => window.scrollTo(0, 0));
  expect((await focusStop(page))?.indicator, "a ring on the top and the sides that show").toBe(true);
  await page.keyboard.press(tabKey(page));
  await page.evaluate(() => document.getElementById("bare")!.scrollIntoView({ block: "start" }));
  expect((await focusStop(page))?.indicator, "no ring at all").toBe(false);
});

test("a bar pinned over the lower part of a region taller than the room the bars leave passes; over its top, or over a field or a button that tall, it fails", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`
    <style>
      body { margin: 0; background: #fff; }
      .tall { display: block; box-sizing: border-box; margin: 40px; height: 1400px; width: 700px; border: 1px solid #ddd; }
      .tall:focus-visible { outline: 2px solid #111; outline-offset: -2px; }
      .bar { position: fixed; inset-inline: 0; height: 120px; background: #eee; }
    </style>
    <div class="tall" id="region" tabindex="0" role="region" aria-label="Transkribering"></div>
    <textarea class="tall" id="field" aria-label="Text"></textarea>
    <span class="tall" id="passage" tabindex="0" role="button" aria-label="Rätta repliken"></span>
    <div class="bar" id="bar" style="bottom: 0"></div>`);
  const under = async (id: string) => {
    await page.evaluate((id) => {
      document.getElementById(id)!.focus({ preventScroll: true });
      document.getElementById(id)!.scrollIntoView({ block: "start" });
    }, id);
    return stopProblems([(await focusStop(page))!]).filter((problem) => problem.includes("partly under"));
  };
  expect(await under("region"), "a region's lower part under a bar at the window's bottom").toEqual([]);
  expect(await under("field"), "a field is a control: no bar over it").toEqual([expect.stringContaining("partly under")]);
  expect(await under("passage"), "so is a passage's [role=button], however tall").toEqual([expect.stringContaining("partly under")]);
  // Shorter than the window and taller than the room its bar leaves (the page's scroll padding): no scroll uncovers it.
  await page.evaluate(() => {
    document.getElementById("region")!.style.height = "560px";
    document.documentElement.style.scrollPaddingBottom = "120px";
  });
  expect(await under("region"), "a region taller than the room the bar leaves").toEqual([]);
  // The room is the window less the padding at both edges (a player docked at the top, a decision at the bottom).
  await page.evaluate(() => {
    document.getElementById("region")!.style.height = "520px";
    Object.assign(document.documentElement.style, { scrollPaddingTop: "60px", scrollPaddingBottom: "60px" });
  });
  expect(await under("region"), "a region taller than the room both paddings leave").toEqual([]);
  await page.evaluate(() => Object.assign(document.documentElement.style, { scrollPaddingTop: "0px", scrollPaddingBottom: "0px" }));
  expect(await under("region"), "with no padding for the bar, the room is the whole window").toEqual([expect.stringContaining("partly under")]);
  await page.evaluate(() => {
    document.getElementById("region")!.style.height = "";
    Object.assign(document.getElementById("bar")!.style, { bottom: "auto", top: "0" });
  });
  expect(await under("region"), "a bar over the region's top, where its ring and name start").toEqual([expect.stringContaining("partly under")]);
});

test("a main command under another layer is caught: no pointer presses it, and the keyboard's focus on it is hidden", async ({ browser, page }, info) => {
  const covered = fixture("covered", `
    <main><h1>Prov</h1><p id="said"></p><button onclick="document.getElementById('said').textContent = 'Skapat'">Skapa dokument</button></main>
    <div style="position: fixed; inset: 0; background: #fff">Ett lager över sidan</div>`);
  for (const [pointer, hasTouch] of [["mouse", false], ["finger", true]] as const) {
    const { problems } = await sweep(browser, info, covered, {}, held(info, hasTouch));
    // Enter on the button would have been answered: a press that cannot land is not made with the keyboard instead.
    expect(problems, `with a ${pointer}`).toEqual([expect.stringContaining(`button "Skapa dokument" (1 of 1): a ${pointer} cannot press it`)]);
  }
  // The sweep's copies are contexts of its own: the copy that failed leaves its picture and its tree in the report.
  const attached = info.attachments.map((attachment) => attachment.name);
  expect(attached).toContain('button-Skapa-dokument-1-of-1-.png');
  expect(attached).toContain('button-Skapa-dokument-1-of-1-.aria.yml');
  await covered.go(page, info);
  const { stops } = await tabWalk(page);
  expect(stopProblems(stops)).toContainEqual(expect.stringContaining('button "Skapa dokument": entirely hidden by div'));
});

test("a control that answers a mouse and not a finger is caught on a touch screen", async ({ browser }, info) => {
  const deaf = fixture("deaf-to-touch", `
    <main><h1>Prov</h1><p id="said"></p><button>Spela in</button></main>
    <script>
      const button = document.querySelector("button");
      button.addEventListener("click", () => (document.getElementById("said").textContent = "Spelar in"));
      // A handler that keeps the touch for itself (a swipe that never came): the browser then makes no click of the tap.
      button.addEventListener("touchend", (event) => event.preventDefault());
    </script>`);
  expect((await sweep(browser, info, deaf, {}, held(info, false))).problems, "a mouse's click is answered").toEqual([]);
  expect((await sweep(browser, info, deaf, {}, held(info, true))).problems, "a finger's tap is not").toEqual(['button "Spela in" (1 of 1): nothing happened that a person could see']);
});

test("a hint that goes by itself is waited for, not closed, and one that stays is an overlay left open", async ({ browser }, info) => {
  // A hint as the design system's keyboard hint is (useKeyboardHint): a manual popover that no Escape closes, its content
  // hidden from assistive tech, gone after `ms`, or never.
  const hinting = (ms: number | null) =>
    fixture("hint", `
      <main><h1>Prov</h1><button>Visa tipset</button></main>
      <div id="hint" popover="manual"><span aria-hidden="true">← → för att navigera</span></div>
      <script>
        document.querySelector("button").addEventListener("click", () => {
          document.getElementById("hint").showPopover();
          ${ms === null ? "" : `setTimeout(() => document.getElementById("hint").hidePopover(), ${ms});`}
        });
      </script>`);
  expect((await sweep(browser, info, hinting(3_000), {}, held(info, false))).problems, "gone after 3 s, as the design system's").toEqual([]);
  expect((await sweep(browser, info, hinting(null), {}, held(info, false))).problems).toEqual([
    expect.stringMatching(/^button "Visa tipset" \(1 of 1\): opened hint div:← → för att navigera, and neither Escape nor a close control closed it$/),
  ]);
});

test("a control that only a keyboard reaches is pressed with the keyboard where it is declared so, and fails where it is not", async ({ browser }, info) => {
  // Off the screen until it has focus, as a way past a long list is.
  const skip = fixture("skip", `
    <style>button { position: absolute; left: -999px; } button:focus { left: 0; }</style>
    <button onclick="document.querySelector('main').focus()">Hoppa förbi listan</button><main tabindex="-1"><h1>Prov</h1></main>`);
  const undeclared = await sweep(browser, info, skip, {}, held(info, false));
  expect(undeclared.problems).toEqual([expect.stringContaining('button "Hoppa förbi listan" (1 of 1): a mouse cannot press it')]);
  const declared = await sweep(browser, info, skip, { keyboardOnly: { 'skip | button "Hoppa förbi listan"': "off the screen until it has focus" } }, held(info, false));
  expect(declared.problems).toEqual([]);
  expect(declared.notes).toEqual(['keyboard skip | button "Hoppa förbi listan": off the screen until it has focus']);
});

test("a failure that is declared and does not happen fails the press, as one that happens and is not declared", async ({ browser }, info) => {
  // The button asks for an address that answers 503 when it is refused, and shows the answer either way.
  const asks = (refused: boolean) =>
    fixture(
      "asks",
      `<main><h1>Prov</h1><p id="said"></p><button onclick="fetch('/fixture/answer').then((answer) => (document.getElementById('said').textContent = answer.status))">Hämta</button></main>`,
      (page) => page.route("**/fixture/answer", (route) => route.fulfill({ status: refused ? 503 : 200, body: "" })),
    );
  const declared = { expects: { 'asks | button "Hämta"': { reason: "the address refuses", expects: [{ console: /status of 503.*\/fixture\/answer/ }] } } };
  expect((await sweep(browser, info, asks(true), declared)).problems, "declared, and it happens").toEqual([]);
  expect((await sweep(browser, info, asks(true), {})).problems, "it happens, and is not declared").toEqual([
    expect.stringContaining('button "Hämta" (1 of 1): console errors: Failed to load resource: the server responded with a status of 503'),
  ]);
  expect((await sweep(browser, info, asks(false), declared)).problems, "declared, and it does not happen").toEqual([
    'button "Hämta" (1 of 1): declared failures that did not occur: /status of 503.*\\/fixture\\/answer/',
  ]);
});

test("a redirect behind a press fails it", async ({ browser }, info) => {
  // A server of the test's own: a redirect has to come over the network, since WebKit lets no route answer with one.
  const server = createServer((request, response) => {
    if (request.url === "/moved") return void response.writeHead(302, { location: "/there" }).end();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="sv"><title>Prov</title><main><h1>Prov</h1><p id="said"></p>
      <button onclick="fetch('/moved').then(() => (document.getElementById('said').textContent = 'Hämtat'))">Hämta</button></main>`);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { problems } = await sweep(browser, info, { name: "moved", go: async (page) => void (await page.goto(address)) }, {});
    expect(problems).toEqual([`button "Hämta" (1 of 1): redirects: 302 GET ${address}/moved to /there`]);
  } finally {
    server.close();
  }
});

test("focus is measured where a phone shows it, also on a page wider than the phone", async ({ browser, browserName }) => {
  test.skip(browserName === "firefox", "Firefox has no phone to emulate (Playwright's isMobile): its layout viewport is the window's");
  // Content past the edge makes a phone's layout viewport wider than the screen; scrolled down, the box a script
  // reads and the picture of the screen then disagree by the visual viewport's offset.
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.setContent(`
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { margin: 0; font: 16px sans-serif; }
      button { margin: 8px; outline: none; }
      button:focus-visible { outline: 3px solid #111; outline-offset: 2px; }
    </style>
    <div style="width: 360px; height: 1200px"></div>
    <button>Längst ner</button>
    <div style="height: 900px"></div>`);
  await page.keyboard.press(tabKey(page));
  expect((await focusStop(page))?.indicator, "a black ring on white").toBe(true);
  await context.close();
});

test("a hit area grown by a pseudo-element is measured from the padding box, where its insets apply", async ({ page }) => {
  // 24 px across the border box, 16 px inside its 4 px border: grown by 12 px, the hit area is 40 px, not 48.
  await page.setContent(`
    <style>
      button { position: relative; box-sizing: border-box; width: 24px; height: 24px; border: 4px solid #333; padding: 0; }
      button::after { content: ""; position: absolute; inset: -12px; }
    </style>
    <button aria-label="Liten"></button>`);
  expect(await targetSizes(page, 44, false)).toEqual(['button "Liten" 24×24']);
});

test("a field's box counts as its control's target only for the control it activates", async ({ page }) => {
  await page.setContent(`
    <style>
      .astryx-text-input, .plain { display: flex; align-items: center; height: 44px; width: 240px; border: 1px solid #767676; }
      input { height: 20px; border: 0; }
      button { flex: none; width: 20px; height: 20px; padding: 0; margin-left: 40px; }
    </style>
    <div class="astryx-text-input"><input aria-label="I fältets ruta"><button aria-label="Rensa"></button></div>
    <div class="plain" style="margin-top: 40px"><input aria-label="I en vanlig ruta"></div>`);
  // The design system's field is credited with its box; a control of its own inside that box, and a field in any
  // other box, are measured as they are.
  expect(await targetSizes(page, 44, false)).toEqual(['button "Rensa" 20×20', expect.stringMatching(/^input "I en vanlig ruta" \d+×20$/)]);
});

test("the design system's field box does activate its control, so crediting it is true", async ({ browser, browserName, baseURL }) => {
  // A touch screen at a phone's width; a phone's own layout viewport where the engine can emulate one (not Firefox).
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: browserName !== "firefox", hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${baseURL}/dev/foundation`);
  for (const [name, selector] of [["Ärende", ".astryx-text-input"], ["Talare", ".astryx-selector"]] as const) {
    const control = page.locator(`${selector} :is(input, [role="combobox"])`).first();
    const box = (await page.locator(selector).first().boundingBox())!;
    expect(box.height, `${name}: the box is a 44 px target on a touch screen`).toBeGreaterThanOrEqual(44);
    // The box's own edge, outside the control inside it.
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 2);
    // A text field takes the focus; a picker opens.
    if (selector === ".astryx-selector") await expect(control, `${name}: a tap on the box's edge opens the picker`).toHaveAttribute("aria-expanded", "true");
    else await expect(control, `${name}: a tap on the box's edge reaches the field`).toBeFocused();
    await page.keyboard.press("Escape");
  }
  await context.close();
});

test("a target in an open modal dialog is measured even under an inert ancestor", async ({ page }) => {
  // Without its native look: WebKit draws a native button no lower than 15 px, whatever height it is given.
  await page.setContent(`<div inert><dialog><button aria-label="Liten" style="appearance: none; width: 10px; height: 10px; padding: 0"></button></dialog></div>`);
  await page.evaluate(() => document.querySelector("dialog")!.showModal());
  expect(await targetSizes(page, 24, false)).toEqual(['button "Liten" 10×10']);
});

test("a slider's control is its target, and a control too thin for a finger is reported", async ({ page }) => {
  // The design system's slider: a 20 px thumb inside a control, which takes the press and is the box that counts.
  const slider = (height: number) => `
    <div class="astryx-slider-control" data-orientation="horizontal" style="height: ${height}px; width: 240px">
      <div role="slider" aria-label="Läge" tabindex="0" style="width: 20px; height: 20px"></div>
    </div>`;
  await page.setContent(slider(44));
  expect(await targetSizes(page, 44, false), "44 px tall: the control is the target").toEqual([]);
  await page.setContent(slider(20));
  expect(await targetSizes(page, 44, false), "20 px tall: as the design system draws it").toEqual(['slider "Läge" 20×20']);
});

test("the design system's slider control does take a press beside its thumb, so crediting its box is true", async ({ page }, info) => {
  await STATES.find((s) => s.name === "ready")!.go(page, info);
  const thumb = page.getByRole("slider", { name: "Position i inspelningen" });
  const control = page.locator(".astryx-slider-control");
  const box = (await control.boundingBox())!;
  expect(box.height, "the control is a 24 px target with a mouse").toBeGreaterThanOrEqual(24);
  expect(Number(await thumb.getAttribute("aria-valuenow"))).toBe(0);
  // The control's own top edge, above the 4 px rail and the thumb's 20 px.
  await page.mouse.click(box.x + box.width * 0.9, box.y + 1);
  expect(Number(await thumb.getAttribute("aria-valuenow")), "a press on the control's edge moves the playhead").toBeGreaterThan(0);
});
