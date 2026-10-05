/**
 * How to reach every screen and state of the app against the stub backend
 * (stub-server.py): each state is a name and the steps a user takes to get there.
 */
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { declare, REAL, type Expectation } from "./sentinel";

export const isPhone = (info: TestInfo) => info.project.name.startsWith("phone") || info.project.name === "reduced-motion";
export const isLaptop = (info: TestInfo) => (info.project.use.viewport?.width ?? 0) >= 1024;

const heading = (page: Page, name: string | RegExp) => expect(page.getByRole("heading", { name })).toBeVisible();

export async function signIn(page: Page, query = "") {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { authenticated: false, user: null } }));
  await page.goto(`/${query}`);
  await expect(page.getByRole("button", { name: "Logga in med Eneo" })).toBeVisible();
}

async function loading(page: Page, path: string) {
  await page.route("**/api/auth/status", () => {});
  await page.goto(path);
  await expect(page.getByRole("status", { name: "Laddar" })).toBeVisible();
}

/** The flow list five minutes before the login ends: the warning is open. */
export async function sessionWarning(page: Page) {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: { id: "user-1", email: "erik.lund@sundsvall.se", username: "Erik Lund" },
        session_ends_in: 200,
      },
    }),
  );
  await page.goto("/flows");
  await expect(page.getByRole("alertdialog", { name: "Du loggas snart ut" })).toBeVisible();
}

async function foundation(page: Page) {
  await page.goto("/dev/foundation");
  await heading(page, "Grundkontroll");
}

export async function flows(page: Page) {
  await page.goto("/flows");
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
}

export async function setup(page: Page, flow = ids.flows.flow1) {
  await page.goto(`/flows/${flow}`);
  await heading(page, "Hur vill du lägga till ljudet?");
}

/**
 * The flow's page reached from the flow list by its link: Back then has a page of the app to go to, which the router
 * asks about. Opened by its address instead, Back leaves the app, and only the browser's own question is asked.
 */
export async function setupFromList(page: Page) {
  await page.goto("/flows");
  await page.getByRole("link", { name: /^Nämndmöte till rapport/ }).click();
  await heading(page, "Hur vill du lägga till ljudet?");
}

export async function chooseMode(page: Page, mode: "Strömma" | "Spela in" | "Ladda upp") {
  await page.getByRole("radio", { name: new RegExp(`^${mode}`) }).click();
}

export async function addParticipants(page: Page, names: string[]) {
  const input = page.getByRole("textbox", { name: /^Deltagare/ });
  for (const name of names) {
    await input.fill(name);
    await input.press("Enter");
  }
  await expect(page.getByRole("button", { name: `Ta bort ${names.at(-1)}` })).toBeVisible();
}

export async function record(page: Page, mode: "Strömma" | "Spela in") {
  await chooseMode(page, mode);
  await page.getByRole("button", { name: mode === "Strömma" ? "Starta strömning" : "Starta inspelning" }).click();
  await expect(page.getByRole("button", { name: "Stoppa" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Spelar in." })).toBeAttached();
  // Pausa and Stoppa ignore a double tap's second tap for 700 ms after they appear.
  await page.waitForTimeout(800);
}

export async function stop(page: Page) {
  await page.getByRole("button", { name: "Stoppa" }).click();
  await heading(page, "Inspelningen är klar");
}

/** The flow takes audio in `files` files of at most `seconds` each (Eneo's max_duration_seconds). */
async function limitAudio(page: Page, seconds: number, files: number) {
  await page.route(/\/run-contract\/?(\?|$)/, async (route) => {
    const contract = await (await route.fetch()).json();
    contract.steps_requiring_input = contract.steps_requiring_input.map((step: object) => ({
      ...step,
      max_duration_seconds: seconds,
      max_files: files,
    }));
    return route.fulfill({ json: contract });
  });
}

/** A recording with a line in the recording bar, `line`, once `start` has set the scene. */
async function recordingSays(page: Page, line: string | RegExp, start?: () => Promise<unknown>) {
  await setup(page);
  await record(page, "Spela in");
  await start?.();
  await expect(page.getByText(line)).toBeVisible({ timeout: 30_000 });
}

/** The login ends while the page is open: the page is covered and a dialog asks for a new login in place. */
export async function endLogin(page: Page) {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { authenticated: false, user: null } }));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alertdialog", { name: "Du behöver logga in igen" })).toBeVisible();
}

/** The way back to the flow list that the current width shows. */
export function backLink(page: Page) {
  return page.getByRole("link", { name: "Alla flöden" }).filter({ visible: true }).first();
}

/** A recording left on the device: recorded, stopped, and the page left through "Lämna sidan?". */
export async function leaveRecording(page: Page) {
  await setup(page);
  await record(page, "Spela in");
  await page.waitForTimeout(1_500);
  await stop(page);
  await backLink(page).click();
  await page.getByRole("alertdialog", { name: "Lämna sidan?" }).getByRole("button", { name: "Lämna sidan" }).click();
  await expect(page.getByRole("heading", { name: "En inspelning har inte skickats" })).toBeVisible();
}

/** A short silent WAV file. */
export function wav(seconds = 1): Buffer {
  const rate = 8_000;
  const data = Buffer.alloc(rate * seconds * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

export async function chooseFile(page: Page, name = "kommunstyrelsen-mote.wav") {
  await chooseMode(page, "Ladda upp");
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "audio/wav", buffer: wav() });
  await expect(page.getByRole("button", { name: "Byt fil" })).toBeVisible();
}

/** The view while the file goes to Eneo, held there by the stub's slow answer to a "langsam" file. */
export async function sending(page: Page) {
  await setup(page);
  await chooseFile(page, "langsam-uppladdning.wav");
  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await expect(page.getByText("Laddar upp filen")).toBeVisible();
}

/**
 * A run's transcript asks Eneo for the words a person has confirmed, and Eneo answers 404 when none are: the page reads that
 * as "none yet". The browser logs every failed resource as a console error all the same. Optional: a run without a
 * transcript does not ask.
 */
export const NO_CONFIRMED_WORDS: Expectation = { console: /status of 404.*\/transcript-words\//, optional: true };

export async function run(page: Page, id: string, flow = ids.flows.flow1) {
  declare(page, [NO_CONFIRMED_WORDS]);
  await page.goto(`/flows/${flow}?run=${id}`);
}

/**
 * Holds the requests to `url`: the module took them and says nothing. `letThrough` lets the requests made after it go on
 * as they would; the held ones stay held.
 */
export async function hold(page: Page, url: string | RegExp) {
  let holding = true;
  await page.route(url, (route) => (holding ? undefined : route.fallback()));
  return { letThrough: () => void (holding = false) };
}

/** The page's own clock, past the point where a wait that has no answer says so (components/SlowWait). */
export const pastSlowWait = (page: Page) => page.clock.fastForward(15_000);
const slowWaitSays = (page: Page) => expect(page.getByText("Det tar längre tid än vanligt.")).toBeVisible();

/** A flow's page whose reads of the flow get no answer, for more than 15 s. */
export async function flowSlow(page: Page) {
  await page.clock.install();
  const held = await hold(page, `**/api/eneo/flows/${ids.flows.flow1}/published/`);
  await page.goto(`/flows/${ids.flows.flow1}`);
  await expect(page.getByRole("status").filter({ hasText: "Laddar flödet…" })).toBeAttached();
  await pastSlowWait(page);
  await slowWaitSays(page);
  return held;
}

/** The flow list whose reads get no answer, for more than 15 s. */
export async function flowsSlow(page: Page) {
  await page.clock.install();
  const held = await hold(page, "**/api/eneo/flows/?*");
  await page.goto("/flows");
  await expect(page.getByRole("status").filter({ hasText: "Laddar flödena…" })).toBeAttached();
  await pastSlowWait(page);
  await slowWaitSays(page);
  return held;
}

/** An earlier run opened by its address, its status reads answered by nothing, for more than 15 s. */
export async function runOpeningSlow(page: Page) {
  await page.clock.install();
  const held = await hold(page, `**/runs/${ids.runs.done}/status/**`);
  await run(page, ids.runs.done);
  await expect(page.getByRole("status").filter({ hasText: "Hämtar körningen…" })).toBeAttached();
  await pastSlowWait(page);
  await slowWaitSays(page);
  return held;
}

/**
 * A run that is shown going on, whose status then cannot be read: the page says it tries again, and then that it takes
 * long. `mend` lets the reads through again.
 */
export async function runReconnecting(page: Page) {
  await page.clock.install();
  let failing = false;
  await page.route(`**/runs/${ids.runs.running}/status/**`, (route) =>
    failing ? route.fulfill({ status: 503, json: { code: "internal_error" } }) : route.fallback(),
  );
  await run(page, ids.runs.running);
  await heading(page, "Dokumentet skapas");
  failing = true;
  // The next poll is two seconds on, and fails.
  await page.clock.fastForward(2_000);
  await expect(page.getByText("Försöker igen. Körningen fortsätter i Eneo.")).toBeVisible();
  await pastSlowWait(page);
  await slowWaitSays(page);
  return { mend: () => void (failing = false) };
}

/**
 * A finished run whose result is blank, its audio in Eneo so that a new run can use it (the stub's runs say neither;
 * its steps do not name the file that went in).
 */
export async function emptyResult(page: Page) {
  await page.route(`**/runs/${ids.runs.plain}/`, async (route) => {
    const body = await (await route.fetch()).json();
    return route.fulfill({ json: { ...body, result: { kind: "inline_text", text: "" } } });
  });
  await page.route(`**/runs/${ids.runs.plain}/steps/`, async (route) => {
    const steps: object[] = await (await route.fetch()).json();
    return route.fulfill({ json: steps.map((step) => ({ ...step, runtime_input_file_ids: [ids.files.audioA] })) });
  });
  await run(page, ids.runs.plain);
  await heading(page, "Resultatet är tomt");
}

/** The finished run with its transcript loaded. */
export async function result(page: Page) {
  await run(page, ids.runs.done);
  await heading(page, "Dokumentet är klart");
  // Below a laptop's width the transcript waits in its tab.
  await expect(page.getByRole("button", { name: /^Spela från/, includeHidden: true }).first()).toBeAttached();
}

/**
 * The speaker-review editor (docs/eneo-integration.md, "Granskning och talarmappning"): the development page's
 * fixtures, the "bulk" case with its test audio. The setting that shows the editor in a run is off by default, so no
 * run reaches it; this page does.
 */
export async function reviewEditor(page: Page, testCase = "bulk") {
  await page.goto("/dev/speaker-review");
  await pick(page.getByRole("combobox", { name: "Testfall" }), testCase);
  await page.getByRole("checkbox", { name: "Tillgängligt testljud" }).check();
  await expect(page.getByRole("textbox", { name: "Transkript, markera ord för att redigera" })).toBeVisible();
}

/**
 * The text at the top of the screen. A tall page scanned from its top has the docked player over whatever lies in the
 * screen's last 70 px, and a time button half under it is a target "partly obscured" that no one meets by scrolling.
 */
const readingTheText = (page: Page) => page.locator("[data-turn-index]").first().evaluate((turn) => turn.scrollIntoView({ block: "start" }));

/** Chooses `option` in one of the design system's selectors. */
export async function pick(field: Locator, option: string) {
  await field.click();
  await field.page().getByRole("option", { name: option, exact: true }).click();
}

export interface State {
  name: string;
  go: (page: Page, info: TestInfo) => Promise<void>;
  /** Only where the state exists, e.g. the PDF dialog is a new tab on a phone. */
  only?: (info: TestInfo) => boolean;
  /**
   * The console errors and failed requests the state is meant to cause (the 503 of the flow list's error, an aborted
   * request). On the gate's real target the sentinel fails a test for any it was not told about, and for a declared one
   * that did not happen.
   */
  expects?: Expectation[];
}

/**
 * The states that do not run on the gate's real target, each with its reason. A state runs there unless it is listed; none
 * is listed to make a run pass.
 */
export const REAL_SKIP: Record<string, string> = {};

/** Every screen and state the gate visits. */
export const STATES: State[] = [
  // The design system's parts on one page (routes/dev/FoundationCheck).
  { name: "foundation", go: (page) => foundation(page) },
  {
    name: "foundation-dialog",
    go: async (page) => {
      await foundation(page);
      await page.getByRole("button", { name: "Primär" }).click();
      await expect(page.getByRole("alertdialog", { name: "Du behöver logga in igen" })).toBeVisible();
    },
  },
  {
    name: "foundation-alert",
    go: async (page) => {
      await foundation(page);
      await page.getByRole("button", { name: "Liten" }).click();
      await expect(page.getByRole("alertdialog", { name: "Lämna sidan?" })).toBeVisible();
    },
  },
  {
    name: "foundation-menu",
    go: async (page) => {
      await foundation(page);
      await page.getByRole("button", { name: "Konto" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    name: "foundation-selector",
    go: async (page) => {
      await foundation(page);
      await page.getByRole("combobox", { name: "Talare" }).click();
      await expect(page.getByRole("option", { name: "Erik Lund" })).toBeVisible();
    },
  },
  { name: "signin-sso", go: (page) => signIn(page) },
  {
    name: "signin-error",
    go: async (page) => {
      await signIn(page, "?auth_error=1");
      await expect(page.getByRole("alert").filter({ hasText: "Inloggningen kunde inte" })).toBeVisible();
    },
  },
  {
    name: "signin-unreachable",
    expects: [{ console: /net::ERR_FAILED.*\/api\/auth\/status/ }, { requestFailed: /GET .*\/api\/auth\/status: net::ERR_FAILED/ }],
    go: async (page) => {
      await page.route("**/api/auth/status", (route) => route.abort());
      await page.goto("/");
      await expect(page.getByRole("alert").filter({ hasText: "Kunde inte kontakta modulen" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Försök igen" })).toBeVisible();
    },
  },
  {
    // A page behind AuthGate whose first status read fails keeps its address: a link into a run is still there when the
    // module is back.
    name: "flows-unreachable",
    expects: [{ console: /net::ERR_FAILED.*\/api\/auth\/status/ }, { requestFailed: /GET .*\/api\/auth\/status: net::ERR_FAILED/ }],
    go: async (page) => {
      await page.route("**/api/auth/status", (route) => route.abort());
      await page.goto("/flows");
      await expect(page.getByRole("alert").filter({ hasText: "Kunde inte kontakta modulen" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Försök igen" })).toBeVisible();
      await expect(page).toHaveURL(/\/flows$/);
    },
  },
  // The sign-in page and a signed-in page while the session is still being asked for.
  { name: "signin-loading", go: (page) => loading(page, "/") },
  { name: "page-loading", go: (page) => loading(page, "/flows") },
  { name: "flow-list", go: flows },
  { name: "session-warning", go: sessionWarning },
  {
    name: "signed-in-again",
    go: async (page) => {
      await page.goto("/inloggad");
      await heading(page, "Du är inloggad igen");
    },
  },
  {
    name: "flow-list-error",
    expects: [{ console: /status of 503.*\/api\/eneo\/flows\// }],
    go: async (page) => {
      await page.route("**/api/eneo/flows/?*", (route) => route.fulfill({ status: 503, json: { code: "internal_error" } }));
      await page.goto("/flows");
      await expect(page.getByRole("alert")).toBeVisible();
    },
  },
  {
    name: "account-menu",
    go: async (page) => {
      await flows(page);
      await page.getByRole("button", { name: /^Öppna konto för/ }).click();
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    // A long name and a long address, every word of a Swedish compound whole: the menu wraps them, and Logga ut, the
    // last row, is still in view inside the menu with nothing to scroll to (the identity may end in an ellipsis).
    name: "account-menu-long-name",
    go: async (page) => {
      await page.route("**/api/auth/status", (route) =>
        route.fulfill({
          json: {
            authenticated: true,
            user: {
              id: "user-1",
              email: "gunnar.bostadsforvaltningsnamndsordforande.langefternamnsson@sundsvallskommunsstjansteorganisation.se",
              username: "Gunnar Bostadsförvaltningsnämndsordförande Långefternamnsson-Östergren",
            },
          },
        }),
      );
      await flows(page);
      await page.getByRole("button", { name: /^Öppna konto för/ }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect
        .poll(() =>
          menu.evaluate((element) => {
            const row = [...element.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes("Logga ut"))!.getBoundingClientRect();
            const box = element.getBoundingClientRect();
            return {
              scrolls: element.scrollHeight > element.clientHeight + 1,
              insideMenu: row.top >= box.top - 0.5 && row.bottom <= box.bottom + 0.5,
              inView: row.top >= 0 && row.bottom <= window.innerHeight,
            };
          }),
        )
        .toEqual({ scrolls: false, insideMenu: true, inView: true });
    },
  },
  { name: "unsent-recordings", go: leaveRecording },
  {
    name: "unsent-recording-delete-question",
    go: async (page) => {
      await leaveRecording(page);
      await page.getByRole("button", { name: "Ta bort" }).click();
      await expect(page.getByRole("button", { name: "Avbryt" })).toBeFocused();
    },
  },
  {
    name: "setup",
    go: async (page) => {
      await setup(page);
      await expect(page.getByRole("heading", { name: "Tidigare körningar" })).toBeVisible();
    },
  },
  {
    name: "setup-participants",
    go: async (page) => {
      await setup(page);
      await chooseMode(page, "Strömma");
      await addParticipants(page, ["Anna Berg", "Erik Lund"]);
    },
  },
  {
    name: "setup-microphone-check",
    go: async (page) => {
      await setup(page);
      await chooseMode(page, "Spela in");
      await page.getByRole("button", { name: "Testa mikrofonen" }).click();
      await expect(page.getByRole("button", { name: "Sluta testa" })).toBeVisible();
    },
  },
  {
    name: "setup-count-from-names",
    go: async (page) => {
      await setup(page);
      await chooseMode(page, "Spela in");
      await addParticipants(page, ["Anna Berg", "Erik Lund"]);
      await page.getByRole("switch", { name: "Märk upp talare" }).click();
      // Deltagare is the contract's participants field: the count follows the names.
      await expect(page.getByRole("textbox", { name: /^Antal talare/ })).toHaveValue("2");
    },
  },
  {
    name: "setup-count-invalid",
    go: async (page) => {
      await setup(page);
      await chooseMode(page, "Spela in");
      await page.getByRole("switch", { name: "Märk upp talare" }).click();
      await page.getByRole("textbox", { name: /^Antal talare/ }).fill("e");
      await page.getByRole("button", { name: "Starta inspelning" }).click();
      // The sentence is also in a live region of the design system, outside the page's main region.
      await expect(page.getByRole("main").getByText("Skriv ett heltal från 1 till 20, eller lämna fältet tomt.")).toBeVisible();
    },
  },
  {
    name: "upload-chosen-file",
    go: async (page) => {
      await setup(page);
      await chooseFile(page);
    },
  },
  {
    name: "setup-required-detail",
    go: async (page) => {
      await setup(page, ids.flows.flow3);
      await chooseFile(page);
      await page.getByRole("button", { name: "Skapa dokument" }).click();
      // The sentence is also in a live region of the design system, outside the page's main region.
      await expect(page.getByRole("main").getByText("Fyll i det här för att skapa dokumentet.")).toBeVisible();
    },
  },
  {
    name: "setup-own-count-invalid",
    go: async (page) => {
      await setup(page, ids.flows.flow3);
      await chooseFile(page);
      await page.getByRole("textbox", { name: "Ärende" }).fill("Samråd om detaljplan");
      await page.getByRole("textbox", { name: "Antal talare" }).fill("2,5");
      await page.getByRole("button", { name: "Skapa dokument" }).click();
      // The sentence is also in a live region of the design system, outside the page's main region.
      await expect(page.getByRole("main").getByText("Skriv ett heltal från 1, eller lämna fältet tomt.")).toBeVisible();
    },
  },
  {
    // A flow that asks a date: the calendar is its own chunk, loaded when the field is first shown, and here opened. A finger
    // gets the browser's own date field instead, which is not the page's to open.
    name: "setup-date",
    go: async (page) => {
      await setup(page, ids.flows.flow5);
      if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
        await expect(page.getByLabel("Mötesdatum")).toBeVisible();
        return;
      }
      await page.getByRole("button", { name: "Öppna kalender" }).click();
      await expect(page.getByRole("dialog", { name: "Välj datum" })).toBeVisible();
    },
  },
  {
    name: "setup-republished",
    expects: [{ console: /status of 409.*\/runs\// }],
    go: async (page) => {
      await setup(page, ids.flows.flow3);
      await chooseFile(page);
      await page.getByRole("textbox", { name: "Ärende" }).fill("Samråd om detaljplan");
      await page.getByRole("button", { name: "Skapa dokument" }).click();
      const alert = page.getByRole("alert").filter({ hasText: "Flödet har uppdaterats" });
      await expect(alert).toBeVisible();
      // The answer to the docked button is brought into view, above the dock.
      await expect(alert).toBeInViewport();
      const dock = page.locator("[data-docked-action]");
      if (await dock.isVisible()) {
        await expect
          .poll(async () => (await alert.boundingBox())!.y + (await alert.boundingBox())!.height <= (await dock.boundingBox())!.y)
          .toBe(true);
      }
    },
  },
  {
    name: "recording",
    go: async (page) => {
      await setup(page);
      await addParticipants(page, ["Anna Berg"]);
      await record(page, "Spela in");
    },
  },
  {
    name: "recording-paused",
    go: async (page) => {
      await setup(page);
      await record(page, "Spela in");
      await page.getByRole("button", { name: "Pausa" }).click();
      await expect(page.getByRole("button", { name: "Fortsätt" })).toBeVisible();
    },
  },
  {
    name: "recording-details-open",
    only: (info) => !isLaptop(info),
    go: async (page) => {
      await setup(page);
      await addParticipants(page, ["Anna Berg", "Erik Lund"]);
      await record(page, "Spela in");
      await page.getByRole("button", { name: /^Uppgifter, Deltagare: Anna Berg/ }).click();
      await expect(page.getByRole("button", { name: "Ta bort Erik Lund" })).toBeVisible();
    },
  },
  {
    name: "stromma",
    go: async (page) => {
      await setup(page);
      await record(page, "Strömma");
      // The stub's first word, not the placeholder: live text has arrived.
      await expect(page.getByRole("log", { name: "Preliminär text" })).toContainText("Välkomna", { timeout: 15_000 });
    },
  },
  {
    name: "leave-dialog",
    go: async (page) => {
      await setup(page);
      await record(page, "Spela in");
      await backLink(page).click();
      await expect(page.getByRole("alertdialog", { name: "Lämna sidan?" })).toBeVisible();
    },
  },
  {
    name: "ready",
    go: async (page) => {
      await setup(page);
      await record(page, "Spela in");
      // Well past 2 s, which the ready view calls very short.
      await page.waitForTimeout(2_000);
      await stop(page);
      await expect(page.getByRole("slider", { name: "Position" })).toBeVisible();
    },
  },
  {
    name: "ready-delete-dialog",
    go: async (page) => {
      await setup(page);
      await record(page, "Spela in");
      await stop(page);
      await page.getByRole("button", { name: "Ta bort" }).click();
      await expect(page.getByRole("alertdialog", { name: "Ta bort inspelningen?" })).toBeVisible();
    },
  },
  {
    name: "unsent-on-setup",
    go: async (page) => {
      await leaveRecording(page);
      await setup(page);
      await expect(page.getByRole("heading", { name: "En inspelning har inte skickats" })).toBeVisible();
    },
  },
  { name: "sending", go: sending },
  {
    name: "time-left-15",
    go: async (page) => {
      await limitAudio(page, 12 * 60, 1);
      await recordingSays(page, /^Mindre än 15 minuter kvar till flödets maxlängd\./);
    },
  },
  {
    name: "time-left-5",
    go: async (page) => {
      await limitAudio(page, 4 * 60, 1);
      await recordingSays(page, /^Mindre än 5 minuter kvar till flödets maxlängd\./);
    },
  },
  {
    name: "too-long-for-one-file",
    go: async (page) => {
      // A page the browser held still past the handover (a laptop lid): its part runs past Eneo's time per file.
      await page.clock.install();
      await limitAudio(page, 60, 5);
      await setup(page);
      await record(page, "Spela in");
      // The recorder hands its audio over in real time, a chunk every 2 s: some audio first, then the lid.
      await page.waitForTimeout(3_000);
      await page.clock.fastForward("02:00");
      await stop(page);
      await page.getByRole("button", { name: "Skapa dokument" }).click();
      await expect(page.getByText(/Inspelningen är för lång för en fil/)).toBeVisible();
    },
  },
  {
    name: "silent-microphone",
    go: async (page) => {
      // A muted input: the stream carries digital silence.
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
      });
      await recordingSays(page, "Vi hör inget från mikrofonen.");
    },
  },
  {
    name: "disk-full",
    go: async (page) => {
      await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
          if ((window as unknown as { diskFull?: boolean }).diskFull) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
          return put.apply(this, args);
        };
      });
      await recordingSays(page, /^Enheten har inte plats för att spara mer\./, () =>
        page.evaluate(() => ((window as unknown as { diskFull?: boolean }).diskFull = true)),
      );
    },
  },
  {
    name: "microphone-muted",
    go: async (page) => {
      // Chromium's fake microphone cannot be muted: the track says it is and fires the event, as a headset's route
      // change does. The recording goes on, and the bar says so.
      await page.addInitScript(() => {
        const streams: MediaStream[] = [];
        (window as unknown as { streams: MediaStream[] }).streams = streams;
        const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await open(constraints);
          streams.push(stream);
          return stream;
        };
      });
      await recordingSays(page, "Mikrofonen är tillfälligt borta.", () =>
        page.evaluate(() => {
          for (const stream of (window as unknown as { streams: MediaStream[] }).streams)
            for (const track of stream.getAudioTracks()) {
              Object.defineProperty(track, "muted", { configurable: true, get: () => true });
              track.dispatchEvent(new Event("mute"));
            }
        }),
      );
    },
  },
  {
    name: "signed-out",
    go: async (page) => {
      await setup(page);
      await endLogin(page);
    },
  },
  {
    name: "signed-out-recording",
    go: async (page) => {
      await setup(page);
      await record(page, "Spela in");
      await endLogin(page);
      // A recording's Pausa and Stoppa need no login: they stay in reach in the sign-in dialog.
      await expect(page.getByRole("alertdialog").getByRole("button", { name: "Pausa" })).toBeVisible();
    },
  },
  {
    name: "signed-out-leave",
    go: async (page) => {
      await setupFromList(page);
      await record(page, "Spela in");
      await endLogin(page);
      await page.goBack();
      await expect(page.getByRole("alertdialog", { name: "Lämna sidan?" })).toBeVisible();
    },
  },
  {
    name: "run-progress",
    go: async (page) => {
      await run(page, ids.runs.running);
      await heading(page, "Dokumentet skapas");
      await expect(page.getByRole("status").filter({ hasText: "Skriv rapporten" })).toBeVisible();
    },
  },
  { name: "flow-slow", go: async (page) => void (await flowSlow(page)) },
  { name: "flows-slow", go: async (page) => void (await flowsSlow(page)) },
  { name: "run-opening-slow", go: async (page) => void (await runOpeningSlow(page)) },
  {
    name: "run-reconnecting",
    expects: [{ console: /status of 503.*\/status\// }],
    go: async (page) => void (await runReconnecting(page)),
  },
  {
    name: "run-started",
    go: async (page) => {
      await setup(page);
      await chooseFile(page);
      await page.getByRole("button", { name: "Skapa dokument" }).click();
      await heading(page, "Dokumentet skapas");
    },
  },
  { name: "result", go: result },
  {
    // A report with a table: the Markdown component draws it, its header row and its cells.
    name: "result-table",
    go: async (page) => {
      await run(page, ids.runs.table);
      await heading(page, "Dokumentet är klart");
      await expect(page.getByRole("table")).toBeVisible();
      await expect(page.getByRole("columnheader", { name: "Ärende" })).toBeVisible();
    },
  },
  { name: "result-empty", go: emptyResult },
  {
    name: "result-steps-open",
    go: async (page) => {
      await result(page);
      await page.getByRole("button", { name: /^Hur resultatet togs fram/ }).click();
      await expect(page.getByText("Flödets version 3")).toBeVisible();
    },
  },
  {
    name: "result-pdf-dialog",
    // Below a laptop's width the document's PDF opens in a new tab instead.
    only: isLaptop,
    go: async (page) => {
      await result(page);
      await page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    // The module cannot get the document's file from Eneo: said in words, never as its raw answer.
    name: "file-missing",
    expects: [{ console: /status of 404.*\/artifacts\// }],
    go: async (page) => {
      await page.route("**/artifacts/*/content*", (route) => route.fulfill({ status: 404, json: { detail: "File not found" } }));
      await result(page);
      await page.getByRole("link", { name: /^Ladda ner PDF/ }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Filen finns inte kvar hos Eneo." })).toBeVisible();
    },
  },
  {
    name: "result-transcript-tab",
    only: (info) => !isLaptop(info),
    go: async (page) => {
      await result(page);
      await page.getByRole("tab", { name: "Transkript" }).click();
      await expect(page.getByRole("tab", { name: "Transkript" })).toHaveAttribute("aria-selected", "true");
    },
  },
  {
    name: "result-docked-player",
    only: (info) => !isLaptop(info),
    go: async (page) => {
      await result(page);
      await page.getByRole("tab", { name: "Transkript" }).click();
      await page.getByRole("button", { name: "Spela upp", exact: true }).first().click();
      await page.getByRole("tab", { name: "Dokument" }).click();
      await expect(page.getByRole("button", { name: "Pausa uppspelningen" })).toBeVisible();
    },
  },
  {
    name: "result-regenerate",
    go: async (page) => {
      await run(page, ids.runs.corrected);
      await expect(page.getByText("Dokumentet skapades före dina rättningar")).toBeVisible();
    },
  },
  {
    name: "result-pdf-preview-whole",
    go: async (page) => {
      await run(page, ids.runs.pdfLong);
      await heading(page, "Dokumentet är klart");
      await page.getByRole("button", { name: "Visa hela texten" }).click();
      await expect(page.getByRole("button", { name: "Visa mindre" })).toBeVisible();
    },
  },
  {
    name: "result-without-transcript",
    go: async (page) => {
      await run(page, ids.runs.plain);
      // Its result is text, so the page says so.
      await heading(page, "Texten är klar");
    },
  },
  {
    name: "failure",
    go: async (page) => {
      await run(page, ids.runs.failed);
      await heading(page, "Dokumentet kunde inte skapas");
      await page.getByRole("button", { name: "Visa teknisk information" }).click();
    },
  },
  {
    name: "review",
    go: async (page) => {
      await run(page, ids.runs.review, ids.flows.flow2);
      await heading(page, "Vem är vem?");
      await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
    },
  },
  {
    name: "naming-dialog",
    go: async (page) => {
      await run(page, ids.runs.review, ids.flows.flow2);
      // With the transcript read, each speaker's sample can be played, so the dialog opens on the first one's button.
      await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
      await page.getByRole("button", { name: "Namnge talarna" }).click();
      await expect(page.getByRole("dialog", { name: "Namnge talarna" })).toBeVisible();
    },
  },
  {
    // "Ändra talare" on a passage: the popover's rows, whose touch targets the gate measures where it is open.
    name: "review-change-speaker",
    go: async (page) => {
      await run(page, ids.runs.review, ids.flows.flow2);
      await page.getByRole("button", { name: "Anna Berg, ändra talare" }).first().click();
      await expect(page.getByRole("dialog", { name: "Ändra talare" }).getByRole("radio").first()).toBeFocused();
    },
  },
  {
    name: "review-reject",
    go: async (page) => {
      await run(page, ids.runs.review, ids.flows.flow2);
      await page.getByRole("button", { name: "Avvisa" }).click();
      await expect(page.getByRole("button", { name: "Bekräfta avvisning" })).toBeVisible();
    },
  },
  {
    name: "review-text-edit",
    go: async (page) => {
      await run(page, ids.runs.reviewText);
      await heading(page, "Sammanfattning");
      await page.getByRole("button", { name: "Redigera" }).click();
      await expect(page.getByRole("main").locator("textarea")).toBeVisible();
    },
  },
  {
    name: "review-din-version",
    go: async (page) => {
      await run(page, ids.runs.reviewText);
      await heading(page, "Sammanfattning");
      await page.getByRole("button", { name: "Redigera" }).click();
      await page.getByRole("main").locator("textarea").fill("Kommunstyrelsen beslutade att höja budgetramen med tre procent.");
      // Someone else saves the review meanwhile: the page opens on the newer revision, and the edit waits beside it.
      await page.route("**/review-checkpoints/active**", async (route) => {
        const checkpoint = await (await route.fetch()).json();
        return route.fulfill({ json: { ...checkpoint, revision: checkpoint.revision + 1 } });
      });
      await page.reload();
      await expect(page.getByRole("button", { name: "Använd din version" })).toBeVisible();
    },
  },
  { name: "review-editor", go: (page) => reviewEditor(page) },
  {
    // A passage marked, and the field for correcting it.
    name: "review-editor-selection",
    go: async (page) => {
      await reviewEditor(page);
      await page.getByRole("button", { name: "Nästa passage som behöver talarbeslut" }).click();
      await page.getByRole("button", { name: "Rätta text", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Rätta markerad text" })).toBeFocused();
      await readingTheText(page);
    },
  },
  {
    // A passage marked, and what the text says about it.
    name: "review-editor-details",
    go: async (page) => {
      await reviewEditor(page);
      await page.getByRole("button", { name: "Nästa passage som behöver talarbeslut" }).click();
      await page.getByRole("button", { name: "Detaljer" }).click();
      await expect(page.getByText("Om markeringen")).toBeVisible();
      await readingTheText(page);
    },
  },
  {
    // The widest the editor gets: six speakers, a word with no break point, a passage chosen by its speaker's name.
    name: "review-editor-speakers",
    go: async (page) => {
      await reviewEditor(page, "accessibility");
      await page.getByRole("button", { name: /^Markera stycket: / }).first().click();
      await expect(page.getByRole("group", { name: "Markerade ord" })).toBeVisible();
      await readingTheText(page);
    },
  },
  {
    name: "review-editor-confirmed",
    go: async (page) => {
      await reviewEditor(page);
      await page.getByRole("button", { name: /^Bekräfta alla förslag/ }).click();
      await expect(page.getByRole("button", { name: "Ångra", exact: true })).toBeVisible();
      await expect(page.getByText("Inga väntande talarbeslut")).toBeVisible();
    },
  },
  {
    name: "review-editor-readonly",
    go: async (page) => {
      await reviewEditor(page);
      await page.getByRole("checkbox", { name: "Skrivskyddat" }).check();
      await page.getByRole("button", { name: "Nästa passage som behöver talarbeslut" }).click();
      await expect(page.getByText("Talargranskningen är skrivskyddad.")).toBeVisible();
    },
  },
  {
    name: "flow-gone",
    expects: [{ console: /status of 404.*\/run-contract\// }, { console: /status of 404.*\/published\// }],
    go: async (page) => {
      await page.goto("/flows/flow-gone");
      await heading(page, "Flödet är inte längre tillgängligt.");
    },
  },
  {
    name: "flow-republish-required",
    expects: [{ console: /status of 409.*\/published\// }, { console: /status of 409.*\/run-contract\// }],
    go: async (page) => {
      await page.goto(`/flows/${ids.flows.flow4}`);
      await heading(page, /^Flödet (kan inte användas just nu|kunde inte laddas)\.$/);
    },
  },
];

/**
 * A deployment with an organisation of its own and a green accent. The stub serves it when STUB_BRANDING is set, so
 * these states exist only in `npm run test:a11y:branding`; they take the default states' steps. "custom": wide logos
 * for both colour modes. "name": no logo, a long name as text.
 */
const BRANDED: Record<string, string[]> = {
  custom: [
    "signin-sso",
    "flow-list",
    "account-menu",
    "setup",
    "setup-participants",
    "setup-microphone-check",
    "recording",
    "result-transcript-tab",
  ],
  name: ["signin-sso", "flow-list", "setup"],
};
for (const name of BRANDED[process.env.STUB_BRANDING ?? ""] ?? []) {
  STATES.push({ ...STATES.find((state) => state.name === name)!, name: `branding-${process.env.STUB_BRANDING}-${name}` });
}

// On the gate's real target a state that cannot be an Eneo answer is left out (REAL_SKIP), and a state tells the sentinel
// what it is meant to cause.
for (const name of Object.keys(REAL_SKIP)) {
  const at = STATES.findIndex((state) => state.name === name);
  if (at < 0) throw new Error(`REAL_SKIP names ${name}, which is no state`);
  if (REAL) STATES.splice(at, 1);
}
for (const state of STATES) {
  const { go, expects } = state;
  if (expects) state.go = async (page, info) => (declare(page, expects), go(page, info));
}
