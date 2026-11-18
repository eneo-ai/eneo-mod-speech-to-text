/**
 * A recording whose send was cut off keeps its upload in parts, and the next send asks the module for it before any
 * byte goes. When that first ask has to wait (the module has no free place, or the connection fails), the wait is on the
 * page with Avbryt, from its first moment: the page shows the upload, without a position until the module has said where
 * it stands, and a cancel sends nothing more and keeps the recording.
 */
import { type Route } from "@playwright/test";
import ids from "../fixtures/ids.json";
import { expect, test } from "./gate";
import { keptRecording } from "./screens";
import { declare } from "./sentinel";

const PIECE = 4 * 1024 * 1024;

test.beforeEach(({}, info) =>
  test.skip(!["laptop-1440-light", "phone-390-light"].includes(info.project.name), "one laptop and one phone"),
);

const CASES = [
  {
    why: "the module has no free place",
    refuse: (route: Route) =>
      route.fulfill({
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "2" },
        body: JSON.stringify({ error: "uploads_busy", detail: "Too many heavy operations are running. Try again shortly." }),
      }),
    line: /^Många skickar just nu\. Vi försöker igen\. Har väntat .*Inspelningen finns kvar på enheten\.$/,
    expected: [{ console: /status of 503/ }],
  },
  {
    why: "the connection fails",
    refuse: (route: Route) => route.abort("failed"),
    line: /^Försöker igen om \d+\s?s\.$/,
    expected: [{ console: /net::ERR_FAILED/ }, { requestFailed: /PUT .*\/api\/uploads\/.*net::ERR_FAILED/ }],
  },
] as const;

for (const { why, refuse, line, expected } of CASES) {
  test(`a recording whose send was cut off waits in view when ${why}, and a cancel sends nothing more and keeps it`, async ({ page }) => {
    declare(page, [...expected]);
    let resending = false;
    const asked: string[] = [];
    let pieceGoes!: () => void;
    const firstPieceGoes = new Promise<void>((resolve) => (pieceGoes = resolve));
    await page.route(/\/api\/uploads\//, async (route) => {
      const method = route.request().method();
      if (!resending) {
        // The first send's first part is left unanswered, and the page is reloaded: the recording keeps its upload.
        if (method === "PATCH") return pieceGoes();
        return route.fallback();
      }
      asked.push(method);
      return method === "PUT" ? refuse(route) : route.fallback();
    });
    await page.goto("/flows");
    const recording = await keptRecording(page, PIECE + 300_000);
    await page.goto(`/flows/${ids.flows.flow1}?recording=${recording}`);
    await firstPieceGoes;
    page.on("dialog", (dialog) => void dialog.accept());
    resending = true;
    await page.reload();

    await page.getByRole("button", { name: "Skapa dokument av inspelningen" }).click();
    await expect(page.getByText(line)).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Uppladdning" }), "no position before the module has said one").not.toHaveAttribute("aria-valuenow", /.*/);
    await expect(page.getByText("Pågår", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Avbryt uppladdningen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Inspelningen finns kvar på enheten." }), "the recording is kept").toBeVisible();
    await expect(page.getByRole("button", { name: "Skapa dokument", exact: true })).toBeEnabled();
    const before = asked.length;
    expect(asked.every((method) => method === "PUT"), `only asks for the place: ${asked.join(", ")}`).toBe(true);
    // Past the next try's time either way: nothing more is asked.
    await page.waitForTimeout(6_000);
    expect(asked).toHaveLength(before);
  });
}
