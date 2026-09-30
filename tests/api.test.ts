import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOGS } from "@/lib/catalogs";
import { GET as getGp } from "@/app/api/gp/route";
import { GET as getCatalogs } from "@/app/api/catalogs/route";
import { getCatalogSummaries, getGpGroup, GP_REFRESH_INTERVAL_MS } from "@/lib/celestrakCache";
import type { CachedGpPayload } from "@/lib/celestrakCache";

vi.mock("@/lib/celestrakCache", () => ({
  GP_REFRESH_INTERVAL_MS: 4 * 60 * 60 * 1000,
  getGpGroup: vi.fn(),
  getCatalogSummaries: vi.fn()
}));

const validEmpty: CachedGpPayload = {
  group: CATALOGS[1], records: [], fetchedAt: "2026-04-28T06:00:00.000Z",
  sourceUpdatedAt: null, stale: false, cacheState: "updated", error: null
};

function gpRequest(group = "stations") {
  return new NextRequest(`http://localhost/api/gp?group=${group}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GP API responses", () => {
  it("serves a validated empty catalog as HTTP 200 with a short cache lifetime", async () => {
    vi.mocked(getGpGroup).mockResolvedValue(validEmpty);

    const response = await getGp(gpRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=60");
    expect((await response.json()).records).toEqual([]);
  });

  it("serves stale snapshots without caching the error response", async () => {
    vi.mocked(getGpGroup).mockResolvedValue({ ...validEmpty, stale: true, cacheState: "stale", error: "CelesTrak returned 503" });

    const response = await getGp(gpRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).stale).toBe(true);
  });

  it("marks a first-fetch failure as HTTP 502 and no-store", async () => {
    vi.mocked(getGpGroup).mockResolvedValue({ ...validEmpty, fetchedAt: null, stale: true, cacheState: "miss", error: "CelesTrak returned 503" });

    const response = await getGp(gpRequest());

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects unknown groups without requesting the source", async () => {
    const response = await getGp(gpRequest("unknown"));

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getGpGroup).not.toHaveBeenCalled();
  });

  it("does not expose unexpected internal errors to API clients", async () => {
    vi.mocked(getGpGroup).mockRejectedValue(new Error("private filesystem path"));

    const response = await getGp(gpRequest());

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).error).toBe("Unable to fetch GP data");
  });
});

describe("catalog API responses", () => {
  it("uses the shared refresh interval and a short cache lifetime", async () => {
    vi.mocked(getCatalogSummaries).mockResolvedValue([]);

    const response = await getCatalogs();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=15, s-maxage=30");
    expect((await response.json()).refreshIntervalMs).toBe(GP_REFRESH_INTERVAL_MS);
  });

  it("does not cache catalog read failures", async () => {
    vi.mocked(getCatalogSummaries).mockRejectedValue(new Error("private filesystem path"));

    const response = await getCatalogs();

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).error).toBe("Unable to read catalog cache");
  });
});
