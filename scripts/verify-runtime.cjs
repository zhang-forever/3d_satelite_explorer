// Focused runtime check: verifies there are no hydration errors and no stray
// 4xx/5xx resources, then samples the scene counters a few times.
const { chromium } = require("playwright");

const URL = process.env.TARGET_URL || "http://localhost:3123";

(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  const badResponses = [];
  const actors = [];

  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" || /hydrat|Minified React error/i.test(text)) {
      errors.push(`[console:${m.type()}] ${text}`);
    }
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  page.on("response", (r) => {
    const status = r.status();
    if (status >= 400) badResponses.push(`${status} ${r.url()}`);
  });
  page.on("requestfailed", (r) =>
    badResponses.push(`FAILED ${r.url()} :: ${r.failure()?.errorText}`)
  );
  page.on("worker", (w) => actors.push(`worker: ${w.url()}`));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(6000);

  const clockA = await page.$eval(".metric.wide span", (n) => n.textContent.trim());
  await page.waitForTimeout(3000);
  const clockB = await page.$eval(".metric.wide span", (n) => n.textContent.trim());

  const state = await page.evaluate(() => {
    const metrics = Array.from(document.querySelectorAll(".metric span")).map((n) =>
      (n.textContent || "").trim()
    );
    const iconHref =
      document.querySelector('link[rel~="icon"]')?.getAttribute("href") ?? null;
    return {
      metrics,
      iconHref,
      legendVisible: !!document.querySelector(".legend"),
      catalogs: document.querySelectorAll(".catalog-item.active").length
    };
  });

  console.log(
    JSON.stringify(
      {
        state,
        clockA,
        clockB,
        clockAdvanced: clockA !== clockB,
        badResponses,
        errors,
        actors
      },
      null,
      2
    )
  );

  await browser.close();
})();
