// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SatelliteExplorer from "@/components/SatelliteExplorer";
import { CATALOGS } from "@/lib/catalogs";
import { predictPasses } from "@/lib/passes";
import type { OmmRecord, PropagatedObject } from "@/lib/orbit";

vi.mock("@/components/GlobeScene", () => ({
  default: React.forwardRef<HTMLDivElement, {
    objects: PropagatedObject[]; onSelect: (id: string) => void
  }>(function GlobeStub({ objects, onSelect }, ref) {
    return <div ref={ref}>{objects.map((object) => <button key={object.id} onClick={() => onSelect(object.id)}>
      Select {object.id}
    </button>)}</div>;
  })
}));
vi.mock("@/lib/passes", () => ({ predictPasses: vi.fn(() => []), azimuthToCompass: () => "N" }));
vi.mock("@/lib/orbit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/orbit")>(), sampleOrbitTrack: () => []
}));

const records: OmmRecord[] = [25544, 25545].map((id) => ({
  OBJECT_NAME: `TEST ${id}`, NORAD_CAT_ID: id, EPOCH: "2026-10-05T00:00:00Z",
  MEAN_MOTION: 15.49, ECCENTRICITY: 0.0007, INCLINATION: 51.6,
  RA_OF_ASC_NODE: 187.5, ARG_OF_PERICENTER: 359.4, MEAN_ANOMALY: 0.6
}));

class MockWorker {
  static instances: MockWorker[] = [];
  messages: Array<Record<string, unknown>> = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() { MockWorker.instances.push(this); }
  postMessage(message: Record<string, unknown>) { this.messages.push(message); }
  terminate() {}
}

async function mountExplorer(select = true) {
  await act(async () => { render(<SatelliteExplorer />); });
  if (!select) return;
  const worker = MockWorker.instances[0];
  const tick = worker.messages.filter((message) => message.type === "propagate").at(-1)!;
  act(() => worker.onmessage?.({ data: {
    type: "propagated", requestId: tick.requestId, version: tick.version, atMs: tick.atMs,
    scene: new Float32Array([1.1, 0, 0, 0, 1.1, 0]), ecf: new Float32Array(6),
    geo: new Float32Array([0, 0, 420, 0, 0, 430]), speed: new Float32Array([7.6, 7.6]),
    flags: new Uint8Array([1, 1])
  } } as MessageEvent));
}

describe("pass prediction visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:01Z"));
    vi.mocked(predictPasses).mockClear();
    MockWorker.instances = [];
    window.localStorage.setItem("orbital-field:locale", JSON.stringify("en"));
    vi.stubGlobal("Worker", MockWorker);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const payload = url === "/api/catalogs"
        ? { catalogs: CATALOGS.map((group) => ({ ...group, cachedCount: 2, stale: false })) }
        : { group: CATALOGS.find((group) => group.id === new URL(url, "http://localhost").searchParams.get("group")),
            records, stale: false };
      return new Response(JSON.stringify(payload), { status: 200 });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not predict without a selected object", async () => {
    await mountExplorer(false);
    fireEvent.click(screen.getByRole("button", { name: "Passes" }));
    expect(predictPasses).not.toHaveBeenCalled();
  });

  it("only predicts in the visible passes panel and refreshes current inputs when reopened", async () => {
    await mountExplorer();
    // The default tab is rendezvous, even though a primary satellite is selected.
    expect(predictPasses).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Passes" }));
    expect(predictPasses).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(predictPasses).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Lat"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("Lon"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Min elevation"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Select 25545" }));
    expect(predictPasses).toHaveBeenCalledTimes(5);
    expect(predictPasses).toHaveBeenLastCalledWith(records[1],
      { latitudeDeg: 45, longitudeDeg: 120 }, new Date("2026-10-05T12:00:00Z"),
      { windowHours: 48, minElevationDeg: 20, maxResults: 6 });

    fireEvent.click(screen.getByRole("button", { name: "Collapse Orbit analysis" }));
    // Accelerated playback must not do hidden 48 h sweeps each real second.
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(window, { key: "+" });
    act(() => vi.advanceTimersByTime(2000));
    expect(predictPasses).toHaveBeenCalledTimes(5);
    fireEvent.click(screen.getByRole("button", { name: "Expand Orbit analysis" }));
    expect(predictPasses).toHaveBeenCalledTimes(6);
    expect(vi.mocked(predictPasses).mock.calls.at(-1)![2]).toEqual(new Date("2026-10-05T12:20:00Z"));

    fireEvent.click(screen.getByRole("button", { name: "Collapse left rail" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(predictPasses).toHaveBeenCalledTimes(6);
    fireEvent.click(screen.getByRole("button", { name: "Expand left rail" }));
    expect(predictPasses).toHaveBeenCalledTimes(7);
    expect(vi.mocked(predictPasses).mock.calls.at(-1)![2]).toEqual(new Date("2026-10-05T12:30:00Z"));

    fireEvent.click(screen.getByRole("button", { name: "Rendezvous" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(predictPasses).toHaveBeenCalledTimes(7);
    fireEvent.click(screen.getByRole("button", { name: "Select 25544" }));
    expect(predictPasses).toHaveBeenCalledTimes(7);
    fireEvent.click(screen.getByRole("button", { name: "Passes" }));
    expect(predictPasses).toHaveBeenCalledTimes(8);
    expect(predictPasses).toHaveBeenLastCalledWith(records[0],
      { latitudeDeg: 45, longitudeDeg: 120 }, new Date("2026-10-05T12:40:00Z"),
      { windowHours: 48, minElevationDeg: 20, maxResults: 6 });
    act(() => vi.advanceTimersByTime(1000));
    expect(predictPasses).toHaveBeenCalledTimes(9);
    expect(vi.mocked(predictPasses).mock.calls.at(-1)![2]).toEqual(new Date("2026-10-05T12:50:00Z"));
  });
});
