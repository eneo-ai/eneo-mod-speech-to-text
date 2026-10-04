// A file above what the module takes, chosen in a real page of the image: the page refuses it, and no request carries it (B4.2 check 16).
//
// usage: PW_DIR=<frontend dir with node_modules> node upload_cap.cjs <base url> <flow id> <file>
//   <base url>  the module as a browser reaches it (its Eneo must be reachable from here: the sign-in handshake goes there)
//   <flow id>   a flow with a file step
//   <file>      an audio file (a .wav: the page checks the type first) above the module's MAX_UPLOAD_BYTES and below the flow's own limit,
//               so that only the module's limit can refuse it
// A fresh signed-in context opens the flow, chooses "Ladda upp" and gives the file input the file. Prints one JSON object:
// {"message": the refusal the page shows, "sent": every request that is not a read (an upload is a POST)}. The page learns the
// module's limit from its status answer (max_upload_bytes) and holds the flow's files to it, so a file the module would refuse
// is never sent: a proxy in front turns the module's early 413 into a 502 for a client that does send it.
const [, , base, flow, file] = process.argv;
const { chromium } = require(process.env.PW_DIR + "/node_modules/@playwright/test");
(async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "sv-SE" });
    await context.request.get(`${base}/api/auth/login?next=/flows`);
    if (!(await context.cookies(base)).some((cookie) => cookie.name === "eneo_module_session")) {
      throw new Error(`upload_cap: the sign-in handshake at ${base} did not give the context a session`);
    }
    const page = await context.newPage();
    const sent = [];
    page.on("request", (request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) || request.url().includes("/runtime-files/")) sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await page.goto(`${base}/flows/${flow}`);
    await page.getByRole("heading", { name: "Hur vill du lägga till ljudet?" }).waitFor({ timeout: 15000 });
    await page.getByRole("radio", { name: /^Ladda upp/ }).click();
    await page.locator('input[type="file"]').setInputFiles(file);
    const refusal = page.getByText(/Filen är större än flödet tar emot/);
    await refusal.first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500); // a request the page makes late is still a request
    console.log(JSON.stringify({ message: (await refusal.first().innerText()).replace(/ /g, " "), sent }));
  } finally {
    await browser.close();
  }
})();
