// What a flow page costs a server while browsers sit on it: the load of "10 browsers polling a run" that B0.1 measured on the image before
// Plan B (bead stt-plan-b-one-process-runtime-bbs.4 has the numbers) and that B4.2 check 14 repeats on the new one.
//
// usage: node poll.cjs <frontend dir with node_modules> <base url> <browsers> <seconds> [run id]
//   <frontend dir>  any directory whose node_modules hold @playwright/test (1.63.0, its Chromium installed)
//   <base url>      the image as a browser reaches it. It is the image's MODULE_PUBLIC_URL, and its Eneo must be reachable from the browser
//                   too: the sign-in handshake redirects there and back (GET /api/auth/login -> Eneo /module-login -> /api/auth/callback)
//   <browsers>      signed-in contexts in one headless Chromium, each with its own session (the baseline: 10)
//   <seconds>       length of the steady window, which starts 5 s after the last browser is on the run page (the baseline: 60)
//   [run id]        a run that never finishes, so the page keeps polling; default run-running (frontend/tests/e2e/stub-server.py)
//
// Every context opens /flows/flow-1?run=<run id>. While the page is visible the app asks the run's status every 2 s, so 10 browsers make
// about 5 requests a second. Prints one JSON line: the window's start and end (epoch seconds), the status polls the pages made in it, per
// second, and how many pages ended on the run page.
//
// It measures nothing of the server itself. Sample the processes from inside the container over the same window (container_probe.py is in
// upload/), then read the window from the line above:
//   docker cp deploy/acceptance/upload/container_probe.py <container>:/tmp/container_probe.py
//   docker exec -d <container> python /tmp/container_probe.py sample /tmp/poll.jsonl 500
//   node deploy/acceptance/poll.cjs <frontend dir> <base url> 10 60
//   docker exec <container> touch /tmp/upload-probe-stop; docker exec <container> cat /tmp/poll.jsonl
// A role's CPU is the change of its summed cpu_ticks (utime + stime, 1/100 s) between the first and last sample inside [from, to], divided
// by 100 and by the seconds between those samples: a share of one core. Its RSS is the summed rss_kb of the role at the start of the
// window, the maximum in it and the end. For the idle row, take a window of the same container with no browser. The baseline used a
// container that had been up 40 s.
const [, , pwDir, base, n, seconds, runId = "run-running"] = process.argv;
const { chromium } = require(pwDir + "/node_modules/@playwright/test");
(async () => {
  const browser = await chromium.launch();
  const pages = [];
  let polls = 0, counting = false;
  for (let i = 0; i < Number(n); i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "sv-SE" });
    const page = await context.newPage();
    page.on("request", (r) => { if (counting && /\/runs\/[^/]+\/status\/?/.test(r.url())) polls++; });
    await page.goto(base + "/api/auth/login?next=" + encodeURIComponent(`/flows/flow-1?run=${runId}`), { waitUntil: "networkidle" });
    pages.push(page);
  }
  await new Promise((r) => setTimeout(r, 5000));   // all of them are on the run page and polling
  const from = Date.now() / 1000; counting = true;
  await new Promise((r) => setTimeout(r, Number(seconds) * 1000));
  counting = false; const to = Date.now() / 1000;
  const urls = pages.map((p) => p.url().replace(base, ""));
  console.log(JSON.stringify({ browsers: Number(n), from, to, statusPolls: polls, pollsPerSecond: +(polls / (to - from)).toFixed(2), onRunPage: urls.filter((u) => u.includes("run=")).length }));
  await browser.close();
})();
