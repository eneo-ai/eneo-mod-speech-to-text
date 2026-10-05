/**
 * A file that Eneo no longer has is asked for before a person is sent to it: the viewer, the tab and the download are
 * never given the module's raw answer, and the page says in words that the file is gone, with Försök igen.
 */
import { expect, test } from "./gate";
import { isLaptop, result } from "./screens";

test.beforeEach(({}, info) =>
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "behaviour, at a laptop's and a phone's width"),
);

/** Eneo's answer for the run's files, which the test switches: gone, or the stub's own. */
async function filesGone(page: import("@playwright/test").Page) {
  const state = { gone: true };
  await page.route("**/artifacts/*/content*", (route) =>
    state.gone ? route.fulfill({ status: 404, json: { detail: "File not found" } }) : route.fallback(),
  );
  return state;
}
const gone = (page: import("@playwright/test").Page) => page.getByRole("alert").filter({ hasText: "Filen finns inte kvar hos Eneo." });

test("a PDF that is gone is not opened, and is opened by Försök igen once it is back", async ({ page, sentinel }, info) => {
  sentinel.expect({ console: /status of 404.*\/artifacts\// });
  const files = await filesGone(page);
  await result(page);

  if (isLaptop(info)) {
    await page.getByRole("button", { name: /^Öppna Protokoll .*\.pdf$/ }).click();
    await expect(gone(page)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    files.gone = false;
    await page.getByRole("button", { name: "Försök igen" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("iframe")).toHaveAttribute("src", /disposition=inline/);
    await expect(gone(page)).toHaveCount(0);
  } else {
    const popups: string[] = [];
    page.on("popup", (popup) => void popups.push(popup.url()));
    const opening = page.waitForEvent("popup");
    await page.getByRole("link", { name: /^Öppna Protokoll .*\.pdf i en ny flik$/ }).click();
    const tab = await opening;
    await expect(gone(page)).toBeVisible();
    await expect.poll(() => tab.isClosed(), "the tab that was opened for it is closed again").toBe(true);
    files.gone = false;
    const again = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Försök igen" }).click();
    const shown = await again;
    await expect.poll(() => shown.url()).toMatch(/disposition=inline/);
    await expect(gone(page)).toHaveCount(0);
  }
});

test("a download of a file that is gone starts nothing, and starts when the file is back", async ({ page, sentinel }) => {
  sentinel.expect({ console: /status of 404.*\/artifacts\// });
  const files = await filesGone(page);
  await result(page);
  const downloads: string[] = [];
  page.on("download", (download) => void downloads.push(download.url()));

  await page.getByRole("link", { name: /^Ladda ner PDF/ }).click();
  await expect(gone(page)).toBeVisible();
  expect(downloads, "no download of the module's answer under the file's name").toEqual([]);

  files.gone = false;
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Försök igen" }).click();
  expect((await saved).url()).toMatch(/disposition=attachment/);
  await expect(gone(page)).toHaveCount(0);
});
