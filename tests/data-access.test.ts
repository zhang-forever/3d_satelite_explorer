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
});
