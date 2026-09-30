const { openBrowser, collectFailures, configureFixture, markFailure } = require("./browser-check.cjs");

const targetUrl = process.env.TARGET_URL || "http://localhost:3123";

async function main() {
  const browser = await openBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const failures = collectFailures(page);
    const fixtureMode = await configureFixture(page, targetUrl);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="globe-scene"] canvas', { timeout: 60_000 });
    await page.waitForFunction(() => {
      const metric = document.querySelector(".metric span")?.textContent || "0";
      return Number(metric.replace(/[^0-9]/g, "")) > 0;
    }, null, { timeout: 60_000 });

    const clockA = await page.locator(".metric.wide span").textContent();
    await page.waitForTimeout(3000);
    const clockB = await page.locator(".metric.wide span").textContent();
    const state = await page.evaluate(() => ({
      metrics: Array.from(document.querySelectorAll(".metric span")).map((node) => node.textContent.trim()),
      legendVisible: Boolean(document.querySelector(".legend")),
      loadedCatalogs: document.querySelectorAll(".catalog-item.active").length,
      iconHref: document.querySelector('link[rel~="icon"]')?.getAttribute("href") ?? null
    }));
    const clockAdvanced = clockA !== clockB;
    const workerStarted = failures.workers.length > 0;
    console.log(JSON.stringify({ fixtureMode, state, clockA, clockB, clockAdvanced, workerStarted, ...failures }, null, 2));
    markFailure(failures, [clockAdvanced, workerStarted, state.legendVisible, state.loadedCatalogs > 0]);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
