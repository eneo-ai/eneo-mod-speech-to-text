/**
 * Eneo's own faults, as the module's backend turns them into answers and the page into words: the stub fails the file it
 * receives by the file's name (tests/e2e/stub-server.py), the real backend maps the fault, and the person reads what
 * happened, that the file is kept, and how to send it again. On the real target only: on the dev profile the stub is the
 * module too, and there is no mapping to prove.
 */
import { expect, test } from "./gate";
import { chooseFile, setup } from "./screens";
import { REAL } from "./sentinel";

test.beforeEach(({}, info) => {
  test.skip(!REAL, "the module's own mapping of Eneo's faults: the real target's");
  test.skip(!["laptop-1440-light", "laptop-1440-dark", "phone-390-light"].includes(info.project.name), "a laptop and a phone");
});

const KEPT = "Filen finns kvar. Välj Skapa dokument när du vill försöka igen.";
// The fault, how Eneo answers, what the page says, and whether the module answers the browser with an error (a 5xx it
// tries again) or relays Eneo's success whose body the page cannot read.
const FAULTS: [string, string, string, boolean][] = [
  ["trasig", "an error of its own (500)", "Tjänsten svarade med ett fel. Försök igen om en stund.", true],
  ["html", "its gateway's HTML page (502)", "Servern kunde inte nås just nu. Försök igen om en stund.", true],
  ["avbruten", "a connection closed with no answer", "Eneo gick inte att nå just nu. Försök igen om en stund.", true],
  ["trunkerad", "an answer cut off", "Servern svarade med något som inte gick att läsa. Försök igen om en stund.", false],
];

for (const [name, what, says, refused] of FAULTS) {
  test(`Eneo answers a file with ${what}: the page says so, keeps the file and lets the person send it again`, async ({ page, sentinel }) => {
    // The module's answer to each try of the file, which the page tries again by itself before it says so.
    if (refused) sentinel.expect({ console: /status of 50\d .*\/runtime-files\/\]$/ });
    let runs = 0;
    await page.route(/\/flows\/[^/]+\/runs\/$/, (route) => {
      if (route.request().method() === "POST") runs += 1;
      return route.fallback();
    });
    await setup(page);
    await chooseFile(page, `${name}-mote.wav`);
    await page.getByRole("button", { name: "Skapa dokument" }).click();

    await expect(page.getByRole("alert")).toHaveText(`${says}${KEPT}`, { timeout: 30_000 });
    await expect(page.getByText(`${name}-mote.wav`, { exact: true }), "the file is still chosen").toBeVisible();
    await expect(page.getByRole("button", { name: "Skapa dokument" })).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" }), "the person is back at the question").toBeFocused();
    expect(runs, "no run was started for a file Eneo does not have").toBe(0);
  });
}
