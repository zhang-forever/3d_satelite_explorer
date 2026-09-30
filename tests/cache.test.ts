import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOGS } from "@/lib/catalogs";
import { cacheFileFor, getCacheDirectory, getCatalogSummaries, getGpGroup } from "@/lib/celestrakCache";
import type { OmmRecord } from "@/lib/orbit";

const sample: OmmRecord[] = [
  {
    OBJECT_NAME: "ISS (ZARYA)",
    OBJECT_ID: "1998-067A",
    EPOCH: "2026-04-28T04:47:58.358400",
    MEAN_MOTION: 15.49001185,
    ECCENTRICITY: 0.00070642,
    INCLINATION: 51.632,
    RA_OF_ASC_NODE: 187.5201,
    ARG_OF_PERICENTER: 359.4554,
    MEAN_ANOMALY: 0.6426,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U",
    NORAD_CAT_ID: 25544,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 56400,
    BSTAR: 0.00015976466,
    MEAN_MOTION_DOT: 0.00008365,
    MEAN_MOTION_DDOT: 0
  }
];

let dirs: string[] = [];

async function tempCacheDir() {
  const dir = await mkdtemp(join(tmpdir(), "3d-satelite-explorer-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function storedGroup(cacheDir: string) {
  return JSON.parse(await readFile(cacheFileFor(CATALOGS[1].id, cacheDir), "utf8"));
}

describe("CelesTrak cache", () => {
  it("stores a fetched group and reports an updated state", async () => {
    const cacheDir = await tempCacheDir();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sample), { status: 200 }));

    const result = await getGpGroup(CATALOGS[1], {
      cacheDir,
      fetchImpl,
      now: new Date("2026-04-28T06:00:00.000Z")
    });

    expect(result.cacheState).toBe("updated");
    expect(result.records).toHaveLength(1);
    expect(result.sourceUpdatedAt).toBe("2026-04-28T04:47:58.358Z");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await storedGroup(cacheDir)).records).toEqual(sample);
    expect(await readdir(cacheDir)).toEqual([`${CATALOGS[1].id}.json`]);
  });

  it("uses a fresh cache without requesting CelesTrak", async () => {
    const cacheDir = await tempCacheDir();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sample), { status: 200 }));

    await getGpGroup(CATALOGS[1], {
      cacheDir,
      fetchImpl,
      now: new Date("2026-04-28T06:00:00.000Z")
    });
    const second = await getGpGroup(CATALOGS[1], {
      cacheDir,
      fetchImpl,
      now: new Date("2026-04-28T07:00:00.000Z")
    });

    expect(second.cacheState).toBe("hit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns stale cached data when the source rejects a refresh", async () => {
    const cacheDir = await tempCacheDir();
    const okFetch = vi.fn(async () => new Response(JSON.stringify(sample), { status: 200 }));

    await getGpGroup(CATALOGS[1], {
      cacheDir,
      fetchImpl: okFetch,
      now: new Date("2026-04-28T06:00:00.000Z")
    });

    const rejectFetch = vi.fn(async () => new Response("blocked", { status: 403 }));
    const stale = await getGpGroup(CATALOGS[1], {
      cacheDir,
      fetchImpl: rejectFetch,
      now: new Date("2026-04-28T12:30:00.000Z")
    });

    expect(stale.cacheState).toBe("stale");
    expect(stale.stale).toBe(true);
    expect(stale.records).toHaveLength(1);
    expect(stale.error).toContain("403");
  });

  it("uses the configured cache directory without changing the local default", async () => {
    const cacheDir = await tempCacheDir();
    vi.stubEnv("CELESTRAK_CACHE_DIR", cacheDir);
    expect(getCacheDirectory()).toBe(cacheDir);
    expect(cacheFileFor("stations")).toBe(join(cacheDir, "stations.json"));

    vi.stubEnv("CELESTRAK_CACHE_DIR", "");
    expect(getCacheDirectory()).toBe(join(process.cwd(), ".cache", "celestrak"));
  });

  it("merges concurrent refreshes for the same directory and group", async () => {
    const cacheDir = await tempCacheDir();
    let startFetch!: () => void;
    let finishFetch!: (response: Response) => void;
    const started = new Promise<void>((resolve) => { startFetch = resolve; });
    const response = new Promise<Response>((resolve) => { finishFetch = resolve; });
    const fetchImpl = vi.fn(async () => { startFetch(); return response; });
    const options = { cacheDir, fetchImpl, now: new Date("2026-04-28T06:00:00Z") };

    const requests = Array.from({ length: 12 }, () => getGpGroup(CATALOGS[1], options));
    await started;
    finishFetch(new Response(JSON.stringify(sample), { status: 200 }));
    const results = await Promise.all(requests);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.records.length === 1)).toBe(true);
    expect((await getGpGroup(CATALOGS[1], options)).cacheState).toBe("hit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readdir(cacheDir)).toEqual(["stations.json"]);
  });

  it("keeps requests for different directories or groups independent", async () => {
    const firstDir = await tempCacheDir();
    const secondDir = await tempCacheDir();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sample)));

    await Promise.all([
      getGpGroup(CATALOGS[1], { cacheDir: firstDir, fetchImpl }),
      getGpGroup(CATALOGS[0], { cacheDir: firstDir, fetchImpl }),
      getGpGroup(CATALOGS[1], { cacheDir: secondDir, fetchImpl })
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((await storedGroup(firstDir)).records).toEqual(sample);
    expect((await storedGroup(secondDir)).records).toEqual(sample);
  });

  it("retains valid upstream data in memory when the cache cannot be written", async () => {
    const cacheRoot = await tempCacheDir();
    const cacheDir = join(cacheRoot, "not-a-directory");
    await writeFile(cacheDir, "blocks directory creation");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sample)));
    const options = { cacheDir, fetchImpl, now: new Date("2026-04-28T06:00:00Z") };

    const result = await getGpGroup(CATALOGS[1], options);
    const second = await getGpGroup(CATALOGS[1], options);

    expect(result.cacheState).toBe("updated");
    expect(result.records).toEqual(sample);
    expect(result.fetchedAt).toBe("2026-04-28T06:00:00.000Z");
    expect(result.error).toContain("Cache persistence unavailable");
    expect(second.records).toEqual(sample);
    expect(second.cacheState).toBe("hit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[CelesTrak] Cache write failed", {
      group: "stations", code: expect.any(String)
    });
  });

  it("persists a first-fetch failure cooldown across module reloads", async () => {
    const cacheDir = await tempCacheDir();
    const failedFetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl: failedFetch, now: new Date("2026-04-28T06:00:00Z")
    });
    const stored = await storedGroup(cacheDir);
    expect(stored.fetchedAt).toBeNull();
    expect(stored.nextRetryAt).toBe("2026-04-28T08:00:00.000Z");

    vi.resetModules();
    const reloaded = await import("@/lib/celestrakCache");
    const retryFetch = vi.fn(async () => new Response(JSON.stringify(sample)));
    const held = await reloaded.getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl: retryFetch, now: new Date("2026-04-28T07:59:59Z")
    });
    expect(held.cacheState).toBe("miss");
    expect(held.error).toContain("503");
    expect(retryFetch).not.toHaveBeenCalled();

    const recovered = await reloaded.getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl: retryFetch, now: new Date("2026-04-28T08:00:00Z")
    });
    expect(recovered.records).toEqual(sample);
    expect(recovered.error).toBeNull();
    expect((await storedGroup(cacheDir)).nextRetryAt).toBeNull();
    expect(retryFetch).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])("stops automatic requests after a persisted %s rejection", async (status) => {
    const cacheDir = await tempCacheDir();
    const failedFetch = vi.fn(async () => new Response("rejected", { status }));
    await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl: failedFetch, now: new Date("2026-04-28T06:00:00Z")
    });
    expect((await storedGroup(cacheDir)).blockedStatus).toBe(status);

    vi.resetModules();
    const reloaded = await import("@/lib/celestrakCache");
    const retryFetch = vi.fn(async () => new Response(JSON.stringify(sample)));
    const held = await reloaded.getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl: retryFetch, now: new Date("2026-04-30T06:00:00Z")
    });

    expect(held.error).toContain(String(status));
    expect(retryFetch).not.toHaveBeenCalled();
    const summary = (await reloaded.getCatalogSummaries(cacheDir)).find((catalog) => catalog.id === "stations");
    expect(summary?.blockedStatus).toBe(status);
  });

  it("honors a longer upstream Retry-After than the minimum cooldown", async () => {
    const cacheDir = await tempCacheDir();
    const fetchImpl = vi.fn(async () => new Response("limited", {
      status: 429, headers: { "Retry-After": "10800" }
    }));

    await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl, now: new Date("2026-04-28T06:00:00Z")
    });
    await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl, now: new Date("2026-04-28T08:30:00Z")
    });

    expect((await storedGroup(cacheDir)).nextRetryAt).toBe("2026-04-28T09:00:00.000Z");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes validation time on 304 without changing source epochs or records", async () => {
    const cacheDir = await tempCacheDir();
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(sample), {
      headers: { ETag: '"v1"', "Last-Modified": "Tue, 28 Apr 2026 04:47:58 GMT" }
    }));
    await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl, now: new Date("2026-04-28T06:00:00Z")
    });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: '"v2"' } }));

    const refreshed = await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl, now: new Date("2026-04-28T12:00:00Z")
    });
    const requestHeaders = new Headers(fetchImpl.mock.calls[1][1]?.headers);

    expect(requestHeaders.get("If-None-Match")).toBe('"v1"');
    expect(requestHeaders.get("If-Modified-Since")).toBe("Tue, 28 Apr 2026 04:47:58 GMT");
    expect(refreshed.records).toEqual(sample);
    expect(refreshed.fetchedAt).toBe("2026-04-28T12:00:00.000Z");
    expect(refreshed.sourceUpdatedAt).toBe("2026-04-28T04:47:58.358Z");
    expect(refreshed.etag).toBe('"v2"');
    expect(refreshed.stale).toBe(false);
    expect((await storedGroup(cacheDir)).fetchedAt).toBe(refreshed.fetchedAt);
  });

  it("does not accept 304 without a previously validated snapshot", async () => {
    const cacheDir = await tempCacheDir();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));

    const result = await getGpGroup(CATALOGS[1], { cacheDir, fetchImpl });

    expect(result.fetchedAt).toBeNull();
    expect(result.cacheState).toBe("miss");
    expect(result.error).toContain("304");
    expect((await storedGroup(cacheDir)).nextRetryAt).toBeTruthy();
  });

  it.each([
    "{",
    JSON.stringify(null),
    JSON.stringify({ groupId: "stations", records: null }),
    JSON.stringify({ groupId: "stations", records: [null], fetchedAt: "2026-04-28T06:00:00Z", sourceUpdatedAt: null }),
    JSON.stringify({ groupId: "stations", records: sample, fetchedAt: "invalid", sourceUpdatedAt: null })
  ])("recovers from an invalid stored cache without breaking summaries (%#)", async (raw) => {
    const cacheDir = await tempCacheDir();
    await writeFile(cacheFileFor("stations", cacheDir), raw);
    const source = vi.spyOn(globalThis, "fetch");

    const summary = (await getCatalogSummaries(cacheDir)).find((catalog) => catalog.id === "stations");
    expect(summary?.cachedCount).toBe(0);
    expect(summary?.error).toContain("could not be read or validated");
    expect(source).not.toHaveBeenCalled();

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sample)));
    const recovered = await getGpGroup(CATALOGS[1], { cacheDir, fetchImpl });
    expect(recovered.records).toEqual(sample);
    expect(recovered.error).toBeNull();
    expect((await storedGroup(cacheDir)).records).toEqual(sample);
  });

  it.each([
    { payload: { records: sample } }, { payload: [null] },
    { payload: [{ ...sample[0], OBJECT_NAME: 123 }] },
    { payload: [{ ...sample[0], EPOCH: "invalid" }] },
    { payload: [{ ...sample[0], MEAN_MOTION: "" }] },
    { payload: [{ ...sample[0], BSTAR: "invalid" }] }
  ])("keeps the last good snapshot when upstream records are invalid (%#)", async ({ payload: invalid }) => {
    const cacheDir = await tempCacheDir();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sample)));
    await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl, now: new Date("2026-04-28T06:00:00Z")
    });
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(invalid)));

    const result = await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl, now: new Date("2026-04-28T12:00:00Z")
    });

    expect(result.records).toEqual(sample);
    expect(result.fetchedAt).toBe("2026-04-28T06:00:00.000Z");
    expect(result.stale).toBe(true);
    expect(result.error).toContain("invalid OMM records");
    const persisted = await storedGroup(cacheDir);
    expect(persisted.records).toEqual(sample);
    expect(persisted.fetchedAt).toBe(result.fetchedAt);
  });

  it("keeps the last good snapshot when upstream JSON cannot be parsed", async () => {
    const cacheDir = await tempCacheDir();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(sample)));
    await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl, now: new Date("2026-04-28T06:00:00Z")
    });
    fetchImpl.mockResolvedValueOnce(new Response("<html>not JSON</html>"));

    const result = await getGpGroup(CATALOGS[1], {
      cacheDir, fetchImpl, now: new Date("2026-04-28T12:00:00Z")
    });

    expect(result.records).toEqual(sample);
    expect(result.error).toContain("not valid JSON");
  });

  it("accepts a validated empty group and serves it from cache", async () => {
    const cacheDir = await tempCacheDir();
    const fetchImpl = vi.fn(async () => new Response("[]"));
    const options = { cacheDir, fetchImpl, now: new Date("2026-04-28T06:00:00Z") };

    const result = await getGpGroup(CATALOGS[1], options);
    const cached = await getGpGroup(CATALOGS[1], options);

    expect(result.records).toEqual([]);
    expect(result.fetchedAt).not.toBeNull();
    expect(result.sourceUpdatedAt).toBeNull();
    expect(result.error).toBeNull();
    expect(cached.cacheState).toBe("hit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
