// Usage: node page-cost.cjs <playwright-module-dir> <baseUrl> <label> <path> [path ...]
// What a page costs: JS and CSS as they travel (compressed), requests, long tasks, DOM nodes, JS heap, LCP/CLS.
const [, , pwDir, base, label, ...paths] = process.argv;
if (!pwDir || !base || !label || paths.length === 0) {
  console.error("usage: node page-cost.cjs <playwright-module-dir> <baseUrl> <label> <path> [path ...]");
  process.exit(2);
}
const { chromium } = require(pwDir + "/node_modules/@playwright/test");

(async () => {
  const browser = await chromium.launch({ args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] });
  const rows = [];
  for (const path of paths) {
    for (const [profile, opts] of [
      ["desktop", { viewport: { width: 1280, height: 800 } }],
      ["phone-4x-cpu", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
    ]) {
      const context = await browser.newContext({ ...opts, locale: "sv-SE" });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      if (profile === "phone-4x-cpu") {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
      }
      const sizes = { js: 0, css: 0, other: 0, requests: 0 };
      const pending = [];
      page.on("response", (response) => {
        const request = response.request();
        const type = request.resourceType();
        sizes.requests++;
        pending.push(request.sizes().then((s) => { sizes[type === "script" ? "js" : type === "stylesheet" ? "css" : "other"] += s.responseBodySize + s.responseHeadersSize; }).catch(() => {}));
      });
      await page.addInitScript(() => {
        window.__perf = { lcp: 0, cls: 0, longTasks: 0, tbt: 0 };
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__perf.longTasks++; window.__perf.tbt += Math.max(0, e.duration - 50); } }).observe({ type: "longtask", buffered: true });
      });
      await page.goto(base + path, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      await Promise.all(pending);
      await cdp.send("HeapProfiler.collectGarbage");
      const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }))).metrics.map((m) => [m.name, m.value]));
      await cdp.send("Performance.enable");
      const m2 = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
      const perf = await page.evaluate(() => ({ ...window.__perf, heap: performance.memory ? performance.memory.usedJSHeapSize : 0, nodes: document.getElementsByTagName("*").length }));
      rows.push({ path, profile, jsKB: +(sizes.js / 1024).toFixed(1), cssKB: +(sizes.css / 1024).toFixed(1), otherKB: +(sizes.other / 1024).toFixed(1), requests: sizes.requests, lcp: Math.round(perf.lcp), cls: +perf.cls.toFixed(3), longTasks: perf.longTasks, tbt: Math.round(perf.tbt), heapMB: +(perf.heap / 1048576).toFixed(1), nodes: perf.nodes, scriptMs: Math.round((m2.ScriptDuration || 0) * 1000), layoutMs: Math.round((m2.LayoutDuration || 0) * 1000) });
      await context.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify({ label, rows }));
})();
