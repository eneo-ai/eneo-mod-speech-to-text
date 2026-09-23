/**
 * How to reach every screen and state of the app against the stub backend
 * (stub-server.py): each state is a name and the steps a user takes to get there.
 */
import { expect, type Page, type TestInfo } from "@playwright/test";

/** Opens a page of the app, with Next's dev-only indicator hidden (it is not the app). */
export async function open(page: Page, path: string) {
  await page.goto(path);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

export const isPhone = (info: TestInfo) => info.project.name.startsWith("phone") || info.project.name === "reduced-motion";
export const isLaptop = (info: TestInfo) => (info.project.use.viewport?.width ?? 0) >= 1024;

const heading = (page: Page, name: string | RegExp) => expect(page.getByRole("heading", { name })).toBeVisible();

export async function signIn(page: Page, mode: "eneo_sso" | "access_code", query = "") {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: { authenticated: false, auth_mode: mode, user: null } }));
  await open(page, `/${query}`);
  await expect(page.getByRole("button", { name: mode === "eneo_sso" ? "Logga in med Eneo" : "Fortsätt" })).toBeVisible();
}

export async function flows(page: Page) {
  await open(page, "/flows");
  await expect(page.getByRole("link", { name: /Nämndmöte till rapport/ })).toBeVisible();
}

export async function setup(page: Page, flow = "flow-1") {
  await open(page, `/flows/${flow}`);
  await heading(page, "Hur vill du ge ljudet?");
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
}

export async function stop(page: Page) {
  await page.getByRole("button", { name: "Stoppa" }).click();
  await heading(page, "Inspelningen är klar");
}

/** The way back to the flow list that the current width shows. */
export function backLink(page: Page) {
  return page.getByRole("link", { name: "Till flödena" }).or(page.getByRole("link", { name: "Flöden", exact: true })).filter({ visible: true }).first();
}

/** A recording left on the device: recorded, stopped, and the page left through "Lämna sidan?". */
export async function leaveRecording(page: Page) {
  await setup(page);
  await record(page, "Spela in");
  await page.waitForTimeout(1_500);
  await stop(page);
  await backLink(page).click();
  await page.getByRole("alertdialog", { name: "Lämna sidan?" }).getByRole("button", { name: "Lämna sidan" }).click();
  await expect(page.getByRole("heading", { name: "En inspelning är inte skickad" })).toBeVisible();
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

export async function run(page: Page, id: string, flow = "flow-1") {
  await open(page, `/flows/${flow}?run=${id}`);
}

/** The finished run with its transcript loaded. */
export async function result(page: Page) {
  await run(page, "run-done");
  await heading(page, "Dokumentet är klart");
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
}

export interface State {
  name: string;
  go: (page: Page, info: TestInfo) => Promise<void>;
  /** Only where the state exists, e.g. the PDF dialog is a new tab on a phone. */
  only?: (info: TestInfo) => boolean;
}

/** Every screen and state the gate visits. */
export const STATES: State[] = [
  { name: "signin-sso", go: (page) => signIn(page, "eneo_sso") },
  { name: "signin-access-code", go: (page) => signIn(page, "access_code") },
  {
    name: "signin-error",
    go: async (page) => {
      await signIn(page, "access_code", "?auth_error=1");
      await expect(page.getByRole("alert").filter({ hasText: "Inloggningen kunde inte" })).toBeVisible();
    },
  },
  { name: "flow-list", go: flows },
  {
    name: "flow-list-error",
    go: async (page) => {
      await page.route("**/api/eneo/flows/?*", (route) => route.fulfill({ status: 503, json: { code: "internal_error" } }));
      await open(page, "/flows");
      await expect(page.getByRole("alert").filter({ hasText: /\w/ })).toBeVisible();
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
  { name: "unsent-recordings", go: leaveRecording },
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
    name: "upload-chosen-file",
    go: async (page) => {
      await setup(page);
      await chooseFile(page);
    },
  },
  {
    name: "setup-required-detail",
    go: async (page) => {
      await setup(page, "flow-3");
      await chooseFile(page);
      await page.getByRole("button", { name: "Skapa dokument" }).click();
      await expect(page.getByText("Fyll i det här för att skapa dokumentet.")).toBeVisible();
    },
  },
  {
    name: "setup-republished",
    go: async (page) => {
      await setup(page, "flow-3");
      await chooseFile(page);
      await page.getByRole("textbox", { name: "Ärende" }).fill("Samråd om detaljplan");
      await page.getByRole("button", { name: "Skapa dokument" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Flödet har uppdaterats" })).toBeVisible();
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
      await page.getByRole("button", { name: /^Deltagare: Anna Berg/ }).click();
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
      await page.waitForTimeout(1_500);
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
      await expect(page.getByRole("heading", { name: "En inspelning är inte skickad" })).toBeVisible();
    },
  },
  { name: "sending", go: sending },
  {
    name: "run-progress",
    go: async (page) => {
      await run(page, "run-running");
      await heading(page, "Dokumentet skapas");
      await expect(page.getByRole("status").filter({ hasText: "Skriv rapporten" })).toBeVisible();
    },
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
    name: "result-steps-open",
    go: async (page) => {
      await result(page);
      await page.getByRole("button", { name: /^Visa stegen/ }).click();
      await expect(page.getByText("Flödets version 3")).toBeVisible();
    },
  },
  {
    name: "result-pdf-dialog",
    only: (info) => !isPhone(info) && (info.project.use.viewport?.width ?? 0) >= 640,
    go: async (page) => {
      await result(page);
      await page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "result-without-transcript",
    go: async (page) => {
      await run(page, "run-plain");
      await heading(page, "Dokumentet är klart");
    },
  },
  {
    name: "failure",
    go: async (page) => {
      await run(page, "run-failed");
      await heading(page, "Dokumentet kunde inte skapas");
      await page.getByRole("button", { name: "Visa teknisk information" }).click();
    },
  },
  {
    name: "review",
    go: async (page) => {
      await run(page, "run-review", "flow-2");
      await heading(page, "Vem är vem?");
      await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
    },
  },
  {
    name: "review-reject",
    go: async (page) => {
      await run(page, "run-review", "flow-2");
      await page.getByRole("button", { name: "Avvisa" }).click();
      await expect(page.getByRole("button", { name: "Bekräfta avvisning" })).toBeVisible();
    },
  },
  {
    name: "review-text-edit",
    go: async (page) => {
      await run(page, "run-review-text");
      await heading(page, "Sammanfattning");
      await page.getByRole("button", { name: "Redigera" }).click();
      await expect(page.locator("main textarea")).toBeVisible();
    },
  },
  {
    name: "flow-gone",
    go: async (page) => {
      await open(page, "/flows/flow-gone");
      await heading(page, "Flödet är inte längre tillgängligt.");
    },
  },
  {
    name: "flow-republish-required",
    go: async (page) => {
      await open(page, "/flows/flow-4");
      await heading(page, /^Flödet (kan inte användas just nu|kunde inte laddas)\.$/);
    },
  },
];
