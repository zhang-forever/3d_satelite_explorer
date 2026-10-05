// @vitest-environment jsdom
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(path.resolve("package.json"));
const { readRuntimeState, configureFixture } = require("./scripts/browser-check.cjs");
const directories: string[] = [];

beforeEach(() => {
  document.body.innerHTML = `
    <div class="metric"><span>16,000</span></div>
    <div class="metric"><span data-testid="propagated-count">0</span></div>
    <div data-testid="globe-scene"><canvas width="1440" height="900"></canvas></div>
    <div class="legend"></div>
    <div class="catalog-item active"></div>
    <div class="catalog-item"></div>
  `;
});

afterEach(async () => {
  document.body.innerHTML = "";
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

function setPropagatedCount(count: string) {
  document.querySelector('[data-testid="propagated-count"]')!.textContent = count;
}

// Match Playwright's serialization, so accidentally capturing module variables fails.
function readSerializedState(waitForReady = false) {
  return runInNewContext(`(${readRuntimeState.toString()})({ waitForReady: ${waitForReady} })`, { document });
}

describe("browser-check readiness", () => {
  it("does not treat loaded records as successfully propagated objects", () => {
    expect(readSerializedState()).toMatchObject({ ready: false, propagatedCount: 0, uiErrors: [] });
    expect(readSerializedState(true)).toBe(false);
  });

  it.each(["", "0", "-1", "NaN", "failed 1", "9007199254740992"])("rejects an invalid or zero propagated count: %s", (count) => {
    setPropagatedCount(count);
    expect(readSerializedState(true)).toBe(false);
  });

  it("does not fall back to an unrelated metric when the propagated selector is missing", () => {
    document.querySelector('[data-testid="propagated-count"]')!.remove();
    expect(readSerializedState(true)).toBe(false);
  });

  it.each(["1", "1,234", "1\u202f234"])("accepts a positive propagated count: %s", (count) => {
    setPropagatedCount(count);
    expect(readSerializedState(true)).toBe(true);
    expect(readSerializedState()).toMatchObject({
      ready: true,
      propagatedCount: count === "1" ? 1 : 1234,
      uiErrors: [],
      canvasSize: [1440, 900],
      legendVisible: true,
      loadedCatalogs: 1,
      catalogCount: 2
    });
  });

  it("fails immediately on a handled worker error even with a stale positive propagated count", () => {
    setPropagatedCount("42");
    expect(readSerializedState(true)).toBe(true);
    document.body.insertAdjacentHTML("beforeend", '<div role="alert">Orbital worker failed</div>');
    expect(readSerializedState()).toMatchObject({ ready: false, propagatedCount: 42, uiErrors: ["Orbital worker failed"] });
    expect(() => readSerializedState(true)).toThrow("UI error alerts: Orbital worker failed");
  });

  it("rejects empty error alerts too", () => {
    setPropagatedCount("1");
    document.body.insertAdjacentHTML("beforeend", '<p role="alert"> </p>');
    expect(readSerializedState().ready).toBe(false);
    expect(() => readSerializedState(true)).toThrow("Empty UI error alert");
  });
});

describe("fixture API URL", () => {
  it.each([
    ["https://example.test", "https://example.test/api/catalogs"],
    ["https://example.test/", "https://example.test/api/catalogs"],
    ["https://example.test/satellite", "https://example.test/satellite/api/catalogs"],
    ["https://example.test/satellite/", "https://example.test/satellite/api/catalogs"],
    ["https://example.test/apps/satellite?lang=zh#globe", "https://example.test/apps/satellite/api/catalogs"]
  ])("keeps the app root for %s", async (targetUrl, expectedUrl) => {
    const directory = await mkdtemp(path.join(tmpdir(), "browser-check-test-"));
    directories.push(directory);
    const fixturePath = path.join(directory, "fixture.json");
    await writeFile(fixturePath, JSON.stringify({ records: [{ NORAD_CAT_ID: 25544 }] }));
    vi.stubEnv("VERIFY_GP_FIXTURE", fixturePath);
    const page = {
      request: { get: vi.fn(async () => ({ ok: () => true, json: async () => ({ catalogs: [{ id: "stations" }] }) })) },
      route: vi.fn()
    };

    expect(await configureFixture(page, targetUrl)).toBe(true);
    expect(page.request.get).toHaveBeenCalledExactlyOnceWith(expectedUrl);
    expect(page.route).toHaveBeenCalledWith("**/api/gp?*", expect.any(Function));
  });
});

describe.each(["verify-runtime.cjs", "smoke-check.cjs"])("%s integration without a browser", (filename) => {
  async function runCheck(afterReadiness: () => void) {
    setPropagatedCount("42");
    const errors: string[] = [];
    const fakeProcess = { env: { TARGET_URL: "https://example.test/satellite/" }, exitCode: 0 };
    const page = {
      goto: vi.fn(),
      waitForSelector: vi.fn(),
      waitForFunction: vi.fn(async (fn: typeof readRuntimeState, options: { waitForReady: boolean }) => {
        expect(fn(options)).toBe(true);
        afterReadiness();
      }),
      locator: () => ({ textContent: vi.fn().mockResolvedValueOnce("00:00:01").mockResolvedValueOnce("00:00:02") }),
      waitForTimeout: vi.fn(),
      evaluate: vi.fn(async (fn: typeof readRuntimeState) => fn === readRuntimeState ? fn() : { medianFrameMs: 16, p95FrameMs: 17, maxFrameMs: 20 }),
      screenshot: vi.fn()
    };
    // The runtime script creates a locator for each read; keep a shared advancing clock.
    const clock = { textContent: vi.fn().mockResolvedValueOnce("00:00:01").mockResolvedValueOnce("00:00:02") };
    page.locator = () => clock;
    const browser = { newPage: vi.fn(async () => page), close: vi.fn() };
    const markFailure = vi.fn((failures: { errors: string[]; badResponses: string[] }, checks: boolean[]) => {
      if (failures.errors.length || failures.badResponses.length || checks.some((check) => !check)) fakeProcess.exitCode = 1;
    });
    const source = await readFile(path.resolve("scripts", filename), "utf8");
    await runInNewContext(source, {
      process: fakeProcess,
      console: { log: vi.fn(), error: (message: string) => errors.push(message) },
      require: (id: string) => {
        if (id === "./browser-check.cjs") return {
          readRuntimeState,
          openBrowser: async () => browser,
          collectFailures: () => ({ errors: [], badResponses: [], workers: ["https://example.test/worker.js"] }),
          configureFixture: async () => false,
          markFailure
        };
        if (id === "node:fs/promises") return { mkdir: vi.fn() };
        if (id === "node:path") return path;
        throw new Error(`Unexpected module: ${id}`);
      }
    });
    expect(errors).toEqual([]);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(page.waitForFunction).toHaveBeenCalledWith(readRuntimeState, { waitForReady: true }, { timeout: 60_000 });
    expect(markFailure).toHaveBeenCalledOnce();
    return fakeProcess.exitCode;
  }

  it("passes when successful propagation remains healthy", async () => {
    expect(await runCheck(() => {})).toBe(0);
  });

  it("fails when propagated objects disappear after readiness", async () => {
    expect(await runCheck(() => setPropagatedCount("0"))).toBe(1);
  });

  it("fails on a later handled worker error without console or network errors", async () => {
    expect(await runCheck(() => {
      document.body.insertAdjacentHTML("beforeend", '<div role="alert">Orbital worker failed</div>');
    })).toBe(1);
  });
});
