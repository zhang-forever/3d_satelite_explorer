import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const scriptUrl = new URL("../scripts/update-static-data.mjs", import.meta.url).href;
const { createSnapshotUpdater, loadCatalogDefinitions, selectGroups, updateSnapshotGroups,
  validateRecords, parseSnapshot } = await import(/* @vite-ignore */ scriptUrl);
const groups = selectGroups(await loadCatalogDefinitions(), "active,stations");
const group = groups[0];
const timestamp = new Date("2026-09-30T14:00:00.000Z");
const record = { OBJECT_NAME: "TEST SAT", NORAD_CAT_ID: 25544, EPOCH: "2026-09-30T09:00:00",
  MEAN_MOTION: 15.5, ECCENTRICITY: 0.001, INCLINATION: 51.6, RA_OF_ASC_NODE: 10,
  ARG_OF_PERICENTER: 20, MEAN_ANOMALY: 30 };
const directories: string[] = [];

async function workspace() {
  const parent = path.resolve(".cache", "static-data-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  directories.push(root);
  return root;
}

async function seed(root: string, options: Record<string, unknown> = {}, id = "active") {
  const value = { groupId: id, records: [record], fetchedAt: "2026-09-30T08:00:00.000Z",
    sourceUpdatedAt: "2026-09-30T09:00:00.000Z", ...options };
  await mkdir(path.join(root, ".cache", "static-data"), { recursive: true });
  await writeFile(path.join(root, ".cache", "static-data", `${id}.json`), JSON.stringify(value));
  return value;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("static mirror data", () => {
  it("uses exact catalog definitions and rejects unknown or escaping IDs", () => {
    expect(groups.map((catalog: { id: string }) => catalog.id)).toEqual(["active", "stations"]);
    expect(() => selectGroups(groups, "../active")).toThrow("Invalid snapshot catalog ID");
    expect(() => selectGroups(groups, "missing")).toThrow("Unknown snapshot catalog");
    expect(() => validateRecords([{ ...record, ECCENTRICITY: 1 }])).toThrow("invalid orbital record");
    expect(() => parseSnapshot({ groupId: "stations", records: [record] }, group)).toThrow();
  });

  it("merges concurrent downloads and keeps the actual request catalog", async () => {
    const root = await workspace();
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.includes("GROUP=active")) throw new Error("Unexpected catalog request");
      return Response.json([record]);
    });
    const updater = createSnapshotUpdater({ root, fetchImpl, now: () => timestamp });
    const results = await Promise.all([updater.updateGroup(group), updater.updateGroup(group)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain("GROUP=active&FORMAT=json");
    expect(results[0].fetchedAt).toBe(timestamp.toISOString());
    expect(results[1].records).toEqual([record]);
  });

  it("reuses fresh snapshots without an upstream request", async () => {
    const root = await workspace();
    await seed(root, { fetchedAt: "2026-09-30T12:00:00.000Z" });
    const fetchImpl = vi.fn();
    const result = await createSnapshotUpdater({ root, fetchImpl, now: () => timestamp }).updateGroup(group);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.stale).toBe(false);
    expect(result.fetchedAt).toBe("2026-09-30T12:00:00.000Z");
  });

  it.each([
    ["malformed JSON", () => new Response("{", { headers: { "Content-Type": "application/json" } })],
    ["empty records", () => Response.json([])],
    ["invalid records", () => Response.json([{ ...record, MEAN_MOTION: "" }])],
    ["upstream failure", () => new Response("down", { status: 500 })],
  ])("retains last-good data and a two-hour cooldown after %s", async (_name, response) => {
    const root = await workspace();
    const previous = await seed(root);
    const fetchImpl = vi.fn(async () => response());
    const result = await createSnapshotUpdater({ root, fetchImpl, now: () => timestamp }).updateGroup(group);
    expect(result.records).toEqual(previous.records);
    expect(result.fetchedAt).toBe(previous.fetchedAt);
    expect(result.stale).toBe(true);
    expect(result.error).toBeTruthy();
    const stored = JSON.parse(await readFile(path.join(root, ".cache", "static-data", "active.json"), "utf8"));
    expect(stored.nextRetryAt).toBe("2026-09-30T16:00:00.000Z");
    const restoredFetch = vi.fn();
    await createSnapshotUpdater({ root, fetchImpl: restoredFetch,
      now: () => new Date("2026-09-30T15:59:59.000Z") }).updateGroup(group);
    expect(restoredFetch).not.toHaveBeenCalled();
  });

  it.each([403, 404])("preserves permanent HTTP %i rejection across process restarts", async (status) => {
    const root = await workspace();
    const previous = await seed(root);
    await createSnapshotUpdater({ root, fetchImpl: vi.fn(async () => new Response("blocked", { status })),
      now: () => timestamp }).updateGroup(group);
    const laterFetch = vi.fn();
    const result = await createSnapshotUpdater({ root, fetchImpl: laterFetch,
      now: () => new Date("2026-10-04T14:00:00.000Z") }).updateGroup(group);
    expect(laterFetch).not.toHaveBeenCalled();
    expect(result.fetchedAt).toBe(previous.fetchedAt);
    expect(result.records).toEqual(previous.records);
    expect(result.error).toContain(String(status));
  });

  it("keeps download time unchanged after a conditional 304", async () => {
    const root = await workspace();
    const previous = await seed(root, { etag: "\"reference\"" });
    const result = await createSnapshotUpdater({ root, now: () => timestamp,
      fetchImpl: vi.fn(async () => new Response(null, { status: 304 })) }).updateGroup(group);
    expect(result.fetchedAt).toBe(previous.fetchedAt);
    expect(result.checkedAt).toBe(timestamp.toISOString());
    expect(result.error).toBeNull();
  });

  it("refuses to publish a manifest when the first download has no valid data", async () => {
    const root = await workspace();
    await expect(updateSnapshotGroups({ root, groups, now: () => timestamp,
      fetchImpl: vi.fn(async () => Response.json([])) })).rejects.toThrow("No valid snapshot");
    await expect(readFile(path.join(root, "public", "data", "catalogs.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bootstraps an existing cache without faking its timestamp or fetching unused groups", async () => {
    const root = await workspace();
    const fetchedAt = "2026-09-30T08:00:00.000Z";
    await mkdir(path.join(root, ".cache", "celestrak"), { recursive: true });
    for (const id of ["active", "stations"]) await writeFile(path.join(root, ".cache", "celestrak", `${id}.json`),
      JSON.stringify({ groupId: id, records: [record], fetchedAt, sourceUpdatedAt: null }));
    const fetchImpl = vi.fn();
    const manifest = await updateSnapshotGroups({ root, groups, bootstrapOnly: true,
      now: () => timestamp, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(manifest.catalogs.map((catalog: { id: string }) => catalog.id)).toEqual(["active", "stations"]);
    const data = JSON.parse(await readFile(path.join(root, "public", "data", "gp", "active.json"), "utf8"));
    expect(data.fetchedAt).toBe(fetchedAt);
    expect(data.stale).toBe(true);
    await expect(readFile(path.join(root, "public", "data", "gp", "starlink.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
