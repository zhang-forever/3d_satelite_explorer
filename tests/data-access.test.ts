import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOGS } from "@/lib/catalogs";

describe("data source URLs and available catalogs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", undefined);
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", undefined);
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_GROUPS", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the existing API URLs and every catalog in Node mode", async () => {
    const source = await import("@/lib/dataAccess");
    expect(source.IS_SNAPSHOT_MODE).toBe(false);
    expect(source.catalogsDataUrl()).toBe("/api/catalogs");
    expect(source.groupDataUrl("active")).toBe("/api/gp?group=active");
    expect(source.AVAILABLE_CATALOGS.map((catalog) => catalog.id)).toEqual(CATALOGS.map((catalog) => catalog.id));
  });

  it("prefixes API and texture URLs when Node is hosted under a base path", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/orbital-field");
    const source = await import("@/lib/dataAccess");
    expect(source.catalogsDataUrl()).toBe("/orbital-field/api/catalogs");
    expect(source.groupDataUrl("stations")).toBe("/orbital-field/api/gp?group=stations");
    expect(source.publicAssetUrl("/textures/earth_atmos_2048.jpg")).toBe("/orbital-field/textures/earth_atmos_2048.jpg");
  });

  it("uses prefixed JSON snapshots and advertises only active and stations by default", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "snapshot");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/3d_satelite_explorer/");
    const source = await import("@/lib/dataAccess");
    expect(source.IS_SNAPSHOT_MODE).toBe(true);
    expect(source.catalogsDataUrl()).toBe("/3d_satelite_explorer/data/catalogs.json");
    expect(source.groupDataUrl("active")).toBe("/3d_satelite_explorer/data/gp/active.json");
    expect(source.AVAILABLE_CATALOGS.map((catalog) => catalog.id)).toEqual(["active", "stations"]);
    expect(() => source.groupDataUrl("starlink")).toThrow("unavailable in this release");
  });

  it("restricts optional snapshot groups to configured known catalogs", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "snapshot");
    vi.stubEnv("NEXT_PUBLIC_SNAPSHOT_GROUPS", "stations, unknown, stations");
    const source = await import("@/lib/dataAccess");
    expect(source.AVAILABLE_CATALOGS.map((catalog) => catalog.id)).toEqual(["stations"]);
    expect(source.groupDataUrl("stations")).toBe("/data/gp/stations.json");
    expect(() => source.groupDataUrl("active")).toThrow("unavailable in this release");
  });

  it("checks static freshness against wall time and preserves upstream error flags", async () => {
    const { snapshotIsStale } = await import("@/lib/dataAccess");
    const now = Date.parse("2026-10-05T14:00:00Z");
    const snapshot = { fetchedAt: "2026-10-01T00:00:00Z", checkedAt: "2026-10-05T12:00:00Z", stale: false };
    expect(snapshotIsStale(snapshot, now)).toBe(false);
    expect(snapshotIsStale({ ...snapshot, checkedAt: null }, now)).toBe(true);
    expect(snapshotIsStale({ ...snapshot, checkedAt: "2026-10-05T10:00:00Z" }, now)).toBe(true);
    expect(snapshotIsStale({ ...snapshot, checkedAt: "2026-10-06T00:00:00Z" }, now)).toBe(true);
    expect(snapshotIsStale({ ...snapshot, stale: true }, now)).toBe(true);
    expect(snapshotIsStale({ ...snapshot, error: "Source unavailable" }, now)).toBe(true);
    expect(snapshotIsStale({ ...snapshot, checkedAt: "invalid" }, now)).toBe(true);
  });
});
