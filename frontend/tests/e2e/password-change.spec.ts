/**
 * The user's password changed in Eneo while the page was open: Eneo refuses every token of that login from then on, and
 * the module's session ends at the next call that reaches Eneo, once Eneo's own session route says the same. The page
 * asks for a new login in place and keeps what it holds. Nothing is faked: the real backend, the stub as Eneo, and the
 * new login made in the window the page opens, through the module's handshake.
 */
import { type APIRequestContext, type Page } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { chooseMode, run, setup, stop, wav } from "./screens";
import { declare, REAL } from "./sentinel";

test.beforeEach(({}, info) => {
  test.skip(!REAL, "Eneo's refusal and the module's answer to it: the real target's");
  // One laptop and one phone: the real target's job in CI has the dark laptop.
  test.skip(!["laptop-1440-light", "laptop-1440-dark", "phone-390-light"].includes(info.project.name), "one laptop and one phone");
});

const SIGN_IN = { name: "Du behöver logga in igen" };

/** Eneo ends this test's login, as a changed password does (tests/e2e/stub-server.py, /__stub/end-session). */
async function changePassword(request: APIRequestContext, session: { login: string; eneo: string }) {
  expect((await request.post(`${session.eneo}/__stub/end-session`, { data: { login: session.login } })).status()).toBe(200);
}

/** The page asks for a new login, and does not say that something has no access; the module's session is gone. */
async function askedToSignIn(page: Page) {
  await expect(page.getByRole("alertdialog", SIGN_IN)).toBeVisible();
  await expect(page.getByText(/har inte behörighet/)).toHaveCount(0);
  expect((await (await page.context().request.get("/api/auth/status")).json()).authenticated).toBe(false);
}

/** The same person signs in again in the window the page opens for it. */
async function signInAgain(page: Page) {
  const opening = page.context().waitForEvent("page");
  await page.getByRole("alertdialog", SIGN_IN).getByRole("button", { name: "Logga in igen" }).click();
  await (await opening).waitForEvent("close");
  await expect(page.getByRole("alertdialog", SIGN_IN)).toBeHidden();
}

/** What the page sends with this method to an address that matches, counted from now. */
function sent(page: Page, method: string, address: RegExp) {
  const urls: string[] = [];
  page.on("request", (request) => void (request.method() === method && address.test(request.url()) && urls.push(request.url())));
  return urls;
}

test("a run followed while the password changes: its next read asks for a new login, and goes again after it", async ({ page, request, session }) => {
  declare(page, [{ console: /status of 401.*\/api\/eneo\/flows\// }]);
  await run(page, ids.runs.running);
  await expect(page.getByRole("heading", { name: "Dokumentet skapas" })).toBeVisible();

  await changePassword(request, session);
  await askedToSignIn(page);
  const readAgain = page.waitForResponse((response) => response.url().includes(`/runs/${ids.runs.running}/`) && response.status() === 200);
  await signInAgain(page);
  await readAgain;
  await expect(page.getByRole("heading", { name: "Dokumentet skapas" })).toBeVisible();
});

test("names typed in who is who whose save the password change refused: they are there after the new login, and the save waits for a press", async ({ page, request, session }) => {
  declare(page, [{ console: /status of 401.*\/review-checkpoints\// }]);
  await run(page, ids.runs.review, ids.flows.flow2);
  await expect(page.getByRole("button", { name: /^Spela från/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Namnge talarna" }).click();
  const dialog = page.getByRole("dialog", { name: "Namnge talarna" });
  const name = dialog.getByRole("combobox", { name: "Vem är Talare 2?" });
  await name.fill("Sara Holm");
  await dialog.getByRole("heading", { name: "Namnge talarna" }).click();
  const saves = sent(page, "PATCH", /\/review-checkpoints\//);

  await changePassword(request, session);
  await dialog.getByRole("button", { name: "Spara namnen" }).click();
  await askedToSignIn(page);
  await signInAgain(page);
  await expect(name).toHaveValue("Sara Holm");
  await page.waitForTimeout(1_000);
  expect(saves, "not sent again by itself").toHaveLength(1);

  await dialog.getByRole("button", { name: "Spara namnen" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("listitem").filter({ hasText: "Talare 2" })).toContainText("Sara Holm");
  expect(saves).toHaveLength(2);
});

test("an edit in a text review whose save the password change refused is there after the new login", async ({ page, request, session }) => {
  declare(page, [{ console: /status of 401.*\/review-checkpoints\// }]);
  const edit = "Kommunstyrelsen beslutade att höja budgetramen med tre procent.";
  await run(page, ids.runs.reviewText);
  await expect(page.getByRole("heading", { name: "Sammanfattning" })).toBeVisible();
  await page.getByRole("button", { name: "Redigera" }).click();
  const text = page.getByRole("main").locator("textarea");
  await text.fill(edit);
  const saves = sent(page, "PATCH", /\/review-checkpoints\//);

  await changePassword(request, session);
  await page.getByRole("button", { name: "Spara ändring" }).click();
  await askedToSignIn(page);
  await signInAgain(page);
  await expect(text).toHaveValue(edit);
  await page.waitForTimeout(1_000);
  expect(saves, "not sent again by itself").toHaveLength(1);
});

test("a stream started after the password change: the recording goes on through the new login, and its live text with it", async ({ page, request, session }) => {
  await setup(page);
  await changePassword(request, session);
  await chooseMode(page, "Strömma");
  await page.getByRole("button", { name: "Starta strömning" }).click();
  await askedToSignIn(page);
  await signInAgain(page);
  await expect(page.getByRole("button", { name: "Stoppa" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Spelar in." })).toBeAttached();
  await expect(page.getByRole("log", { name: "Preliminär text" })).toContainText("Välkomna", { timeout: 15_000 });
  await stop(page);
});

test("a large file sent as the password changes: the send asks for a new login, the file stays, and sending it again goes up once and starts one run", async ({ page, request, session }) => {
  declare(page, [{ console: /status of 401.*\/api\/uploads\/.*\/complete/ }]);
  let changed = false;
  await page.route(/\/api\/uploads\//, async (route) => {
    // Between the page's read of the flow and the module's, before the file is complete: the module's read refuses it.
    if (route.request().method() === "PATCH" && !changed) {
      changed = true;
      await changePassword(request, session);
    }
    return route.fallback();
  });
  const parts = sent(page, "PATCH", /\/api\/uploads\//);
  const completions = sent(page, "POST", /\/api\/uploads\/.*\/complete$/);
  const runs = sent(page, "POST", /\/flows\/[^/]+\/runs\/$/);
  await setup(page);
  await chooseMode(page, "Ladda upp");
  await page.locator('input[type="file"]').setInputFiles({ name: "langt-mote.wav", mimeType: "audio/wav", buffer: wav(280) });
  await expect(page.getByRole("button", { name: "Byt fil" })).toBeVisible();

  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await askedToSignIn(page);
  await signInAgain(page);
  await expect(page.getByText("Inloggningen hade gått ut och det här skickades inte. Försök igen.")).toBeVisible();
  await expect(page.getByText("langt-mote.wav", { exact: true }), "the file is still chosen").toBeVisible();
  expect(runs).toHaveLength(0);

  await page.getByRole("button", { name: "Skapa dokument" }).click();
  await page.waitForURL(/[?&]run=/);
  expect(new Set([...parts, ...completions].map((url) => url.replace(/\/complete$/, ""))).size, "one upload").toBe(1);
  expect(parts, "its two parts went up once each").toHaveLength(2);
  expect(completions, "refused once, then forwarded").toHaveLength(2);
  expect(runs).toHaveLength(1);
});
