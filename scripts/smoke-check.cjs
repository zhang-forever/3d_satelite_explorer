// Manual smoke check: load the app, wait for the globe, measure frame pacing,
// capture a screenshot and report any console errors.
const { chromium } = require("playwright");

const URL = process.env.TARGET_URL || "http://localhost:3123";

(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="globe-scene"] canvas', { timeout: 60000 });
  // Let the catalogs load (they come from the local .cache) and the scene settle.
  await page.waitForTimeout(25000);

  const metrics = await page.evaluate(async () => {
    const frameTimes = [];
    await new Promise((resolve) => {
      let last = performance.now();
      let frames = 0;
      const tick = () => {
        const now = performance.now();
        frameTimes.push(now - last);
        last = now;
        frames += 1;
        if (frames >= 120) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    frameTimes.sort((a, b) => a - b);
    const metricValues = Array.from(document.querySelectorAll(".metric span")).map((n) =>
      (n.textContent || "").trim()
    );
    const canvas = document.querySelector('[data-testid="globe-scene"] canvas');
    return {
      medianFrameMs: Number(frameTimes[Math.floor(frameTimes.length / 2)].toFixed(2)),
      p95FrameMs: Number(frameTimes[Math.floor(frameTimes.length * 0.95)].toFixed(2)),
      maxFrameMs: Number(frameTimes[frameTimes.length - 1].toFixed(2)),
      metrics: metricValues,
      canvasSize: canvas ? [canvas.width, canvas.height] : null,
      legendVisible: Boolean(document.querySelector(".legend")),
      catalogCount: document.querySelectorAll(".catalog-item").length,
      scanButton: document.querySelector(".scan-button")?.textContent?.trim() ?? null
    };
  });

  await page.screenshot({ path: "docs/perf-smoke.png", fullPage: false });
  console.log(JSON.stringify({ ...metrics, errors }, null, 2));
  await browser.close();
})();
