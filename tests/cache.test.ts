import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATALOGS } from "@/lib/catalogs";
import { cacheFileFor, getGpGroup } from "@/lib/celestrakCache";
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
});

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
    await expect(cacheFileFor(CATALOGS[1].id, cacheDir)).toBeTruthy();
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
});
