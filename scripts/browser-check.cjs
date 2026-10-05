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

// Keep this self-contained: Playwright serializes it into the browser context.
function readRuntimeState({ waitForReady = false } = {}) {
  const countText = document.querySelector('[data-testid="propagated-count"]')?.textContent ?? "";
  const normalizedCount = countText.replace(/[,\s]/g, "");
  const parsedCount = /^\d+$/.test(normalizedCount) ? Number(normalizedCount) : 0;
  const propagatedCount = Number.isSafeInteger(parsedCount) ? parsedCount : 0;
  const uiErrors = Array.from(document.querySelectorAll('[role="alert"]'))
    .map((node) => node.textContent.trim() || "Empty UI error alert");
  const ready = propagatedCount > 0 && uiErrors.length === 0;

  if (waitForReady) {
    if (uiErrors.length) throw new Error(`UI error alerts: ${uiErrors.join("; ")}`);
    return ready;
  }

  const canvas = document.querySelector('[data-testid="globe-scene"] canvas');
  return {
    ready,
    propagatedCount,
    uiErrors,
    metrics: Array.from(document.querySelectorAll(".metric span")).map((node) => node.textContent.trim()),
    canvasSize: canvas ? [canvas.width, canvas.height] : null,
    legendVisible: Boolean(document.querySelector(".legend")),
    loadedCatalogs: document.querySelectorAll(".catalog-item.active").length,
    catalogCount: document.querySelectorAll(".catalog-item").length,
    iconHref: document.querySelector('link[rel~="icon"]')?.getAttribute("href") ?? null
  };
}

async function configureFixture(page, targetUrl) {
  const fixturePath = process.env.VERIFY_GP_FIXTURE;
  if (!fixturePath) return false;
  const parsed = JSON.parse(await readFile(fixturePath, "utf8"));
  const records = Array.isArray(parsed) ? parsed : parsed.records;
  if (!Array.isArray(records) || !records.length) throw new Error("GP fixture must contain OMM records.");
  const appRoot = new URL(targetUrl);
  appRoot.pathname = `${appRoot.pathname.replace(/\/+$/, "")}/`;
  appRoot.search = "";
  appRoot.hash = "";
  const response = await page.request.get(new URL("api/catalogs", appRoot).href);
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

module.exports = { openBrowser, collectFailures, readRuntimeState, configureFixture, markFailure };
