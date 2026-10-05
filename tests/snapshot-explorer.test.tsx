// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SatelliteExplorer from "@/components/SatelliteExplorer";
import { CATALOGS } from "@/lib/catalogs";

vi.mock("@/lib/dataAccess", async (importOriginal) => {
  const { CATALOGS } = await import("@/lib/catalogs");
  return {
    ...await importOriginal<typeof import("@/lib/dataAccess")>(),
    IS_SNAPSHOT_MODE: true,
    AVAILABLE_CATALOGS: CATALOGS.filter((catalog) => ["active", "stations"].includes(catalog.id)),
    catalogsDataUrl: () => "/3d_satelite_explorer/data/catalogs.json",
    groupDataUrl: (id: string) => `/3d_satelite_explorer/data/gp/${id}.json`
  };
});
vi.mock("@/components/GlobeScene", () => ({ default: () => <div data-testid="globe-stub" /> }));
vi.mock("@/lib/passes", () => ({ predictPasses: () => [], azimuthToCompass: () => "N" }));
vi.mock("@/lib/orbit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/orbit")>(), sampleOrbitTrack: () => []
}));

const publishedFetchedAt = "2026-09-29T00:00:00.000Z";
const orbitalEpoch = "2026-09-28T22:00:00.000Z";
const available = CATALOGS.filter((catalog) => ["active", "stations"].includes(catalog.id));
const record = {
  OBJECT_NAME: "TEST SATELLITE", OBJECT_ID: "1998-067A", NORAD_CAT_ID: 25544,
  EPOCH: orbitalEpoch, MEAN_MOTION: 15.49, ECCENTRICITY: 0.0007, INCLINATION: 51.6,
  RA_OF_ASC_NODE: 187.5, ARG_OF_PERICENTER: 359.4, MEAN_ANOMALY: 0.6
};

function installSnapshotFetch(extraMetadata: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((url: string) => {
    const metadata = { fetchedAt: publishedFetchedAt, sourceUpdatedAt: orbitalEpoch, stale: false, error: null,
      ...extraMetadata };
    const payload = url.endsWith("catalogs.json")
      ? { catalogs: available.map((catalog) => ({ ...catalog, cachedCount: 1, ...metadata })) }
      : { group: available.find((catalog) => url.endsWith(`/${catalog.id}.json`)), records: [record], ...metadata };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("snapshot explorer", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("orbital-field:locale", JSON.stringify("en"));
    vi.stubGlobal("Worker", class { postMessage() {} terminate() {} });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows only published groups and loads their JSON with the base path", async () => {
    const fetchMock = installSnapshotFetch();
    render(<SatelliteExplorer />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Active/ })).toHaveClass("active"));
    expect(document.querySelectorAll(".catalog-item")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Starlink/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/3d_satelite_explorer/data/catalogs.json", expect.anything());
    expect(fetchMock).toHaveBeenCalledWith("/3d_satelite_explorer/data/gp/active.json", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Load all" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Stations/ })).toHaveClass("active"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "3" }));
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/data/gp/"))).toHaveLength(2);
  });

  it("identifies snapshot refresh and preserves the published fetch and epoch timestamps", async () => {
    const fetchMock = installSnapshotFetch();
    render(<SatelliteExplorer />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Active/ })).toHaveClass("active"));
    expect(screen.getByText("Published data snapshot; refresh only reloads that snapshot.")).toBeInTheDocument();
    expect(document.querySelector(`time[datetime="${publishedFetchedAt}"]`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload published snapshot" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/active.json"))).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Expand Data status" }));
    expect(screen.getByText("Data snapshot", { exact: true })).toBeInTheDocument();
    expect(document.querySelector(`time[datetime="${orbitalEpoch}"]`)).toBeInTheDocument();
    expect(document.querySelector(`time[datetime="${publishedFetchedAt}"]`)).toBeInTheDocument();
    expect(screen.queryByText("Updated", { exact: true })).not.toBeInTheDocument();
  });

  it("marks an old published snapshot stale even when its static metadata says fresh", async () => {
    installSnapshotFetch();
    render(<SatelliteExplorer />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Active/ })).toHaveClass("active"));
    expect(screen.getAllByText("Snapshot out of date").length).toBeGreaterThan(0);
  });

  it("ages revalidated snapshots while simulation playback is paused", async () => {
    vi.useFakeTimers();
    const checkedAt = "2026-10-05T10:00:00.000Z";
    vi.setSystemTime(new Date("2026-10-05T13:59:30.000Z"));
    installSnapshotFetch({ checkedAt });
    await act(async () => { render(<SatelliteExplorer />); });
    expect(screen.queryByText("Snapshot out of date")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getAllByText("Snapshot out of date").length).toBeGreaterThan(0);
  });
});
