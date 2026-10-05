const { mkdir } = require("node:fs/promises");
const path = require("node:path");
const { openBrowser, collectFailures, readRuntimeState, configureFixture, markFailure } = require("./browser-check.cjs");

const targetUrl = process.env.TARGET_URL || "http://localhost:3123";

async function main() {
  const browser = await openBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const failures = collectFailures(page);
    const fixtureMode = await configureFixture(page, targetUrl);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="globe-scene"] canvas', { timeout: 60_000 });
    await page.waitForFunction(readRuntimeState, { waitForReady: true }, { timeout: 60_000 });
    const metrics = await page.evaluate(async () => {
      const frameTimes = [];
      await new Promise((resolve) => {
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          frameTimes.push(now - last);
          last = now;
          if (frameTimes.length >= 120) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      frameTimes.sort((left, right) => left - right);
      return {
        medianFrameMs: Number(frameTimes[60].toFixed(2)),
        p95FrameMs: Number(frameTimes[114].toFixed(2)),
        maxFrameMs: Number(frameTimes[119].toFixed(2))
      };
    });
    const outputDir = path.resolve("output/playwright");
    await mkdir(outputDir, { recursive: true });
    const screenshot = path.join(outputDir, "perf-smoke.png");
    await page.screenshot({ path: screenshot });
    const state = await page.evaluate(readRuntimeState);
    const workerStarted = failures.workers.length > 0;
    console.log(JSON.stringify({ fixtureMode, ...metrics, ...state, workerStarted, screenshot, ...failures }, null, 2));
    markFailure(failures, [state.ready, workerStarted, Boolean(state.canvasSize?.every((size) => size > 0)), state.loadedCatalogs > 0]);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
