const { readFile } = require("node:fs/promises");
const { chromium } = require("playwright");

async function openBrowser() {
  return chromium.launch({
    channel: process.env.BROWSER_CHANNEL || "chrome",
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
  });
}

function collectFailures(page) {
  const errors = [];
  const badResponses = [];
  const workers = [];
  page.on("console", (message) => {
    if (message.type() === "error" || /hydrat|Minified React error/i.test(message.text())) {
      errors.push(`[console:${message.type()}] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`[pageerror] ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    badResponses.push(`FAILED ${request.url()} :: ${request.failure()?.errorText}`);
  });
  page.on("worker", (worker) => workers.push(worker.url()));
  return { errors, badResponses, workers };
}

async function configureFixture(page, targetUrl) {
  const fixturePath = process.env.VERIFY_GP_FIXTURE;
  if (!fixturePath) return false;
  const parsed = JSON.parse(await readFile(fixturePath, "utf8"));
  const records = Array.isArray(parsed) ? parsed : parsed.records;
  if (!Array.isArray(records) || !records.length) throw new Error("GP fixture must contain OMM records.");
  const response = await page.request.get(new URL("/api/catalogs", targetUrl).href);
  if (!response.ok()) throw new Error(`Catalog API returned ${response.status()}`);
  const { catalogs } = await response.json();
  await page.route("**/api/gp?*", (route) => {
    const groupId = new URL(route.request().url()).searchParams.get("group");
    const group = catalogs.find((catalog) => catalog.id === groupId);
    if (!group) return route.abort();
    return route.fulfill({
      json: {
        group,
        records,
        fetchedAt: parsed.fetchedAt ?? null,
        sourceUpdatedAt: parsed.sourceUpdatedAt ?? null,
        cacheState: "hit",
        stale: true,
        error: null
      }
    });
  });
  return true;
}

function markFailure(failures, checks = []) {
  if (failures.errors.length || failures.badResponses.length || checks.some((check) => !check)) {
    process.exitCode = 1;
  }
}

module.exports = { openBrowser, collectFailures, configureFixture, markFailure };
