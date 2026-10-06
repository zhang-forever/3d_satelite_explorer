// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SatelliteExplorer from "@/components/SatelliteExplorer";
import { CATALOGS } from "@/lib/catalogs";
import type { OmmRecord, RendezvousScanHit } from "@/lib/orbit";

vi.mock("@/components/GlobeScene", () => ({
  default: React.forwardRef<HTMLDivElement, { objects: { id: string; groupId: string }[]; selectedId: string | null }>(function GlobeStub({ objects, selectedId }, ref) {
    return <div ref={ref} data-testid="globe-stub" data-selected={selectedId ?? ""} data-groups={objects.map((object) => object.groupId).join(",")} data-ids={objects.map((object) => object.id).join(",")}>{objects.length}</div>;
  })
}));
vi.mock("@/lib/passes", () => ({ predictPasses: () => [], azimuthToCompass: () => "N" }));
vi.mock("@/lib/orbit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/orbit")>(), sampleOrbitTrack: () => []
}));

const record: OmmRecord = {
  OBJECT_NAME: "TEST SATELLITE", OBJECT_ID: "1998-067A", NORAD_CAT_ID: 25544,
  EPOCH: "2026-09-30T00:00:00.000Z", MEAN_MOTION: 15.49, ECCENTRICITY: 0.0007,
  INCLINATION: 51.6, RA_OF_ASC_NODE: 187.5, ARG_OF_PERICENTER: 359.4, MEAN_ANOMALY: 0.6
};
const summaries = CATALOGS.map((catalog) => ({
  ...catalog, cachedCount: 1, fetchedAt: null, sourceUpdatedAt: null, stale: false, error: null
}));

class MockWorker {
  static instances: MockWorker[] = [];
  messages: Array<Record<string, unknown>> = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() { MockWorker.instances.push(this); }
  postMessage(message: Record<string, unknown>) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  deliver(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status,
    headers: { "Content-Type": "application/json" } }));
}

function installFetch(gpRequest?: (signal: AbortSignal) => Promise<Response>) {
  const fetchMock = vi.fn((url: string, options?: RequestInit) => {
    if (url === "/api/catalogs") return jsonResponse({ catalogs: summaries });
    if (gpRequest) return gpRequest(options!.signal as AbortSignal);
    const groupId = new URL(url, "http://localhost").searchParams.get("group");
    return jsonResponse({ group: CATALOGS.find((catalog) => catalog.id === groupId),
      records: [record], stale: false });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function startScan() {
  await waitFor(() => expect(MockWorker.instances[0].messages.filter((message) =>
    message.type === "setRecords").at(-1)?.records).toHaveLength(1));
  const worker = MockWorker.instances[0];
  const tick = worker.messages.filter((message) => message.type === "propagate").at(-1)!;
  act(() => worker.deliver({ type: "propagated", requestId: tick.requestId, version: tick.version,
    atMs: tick.atMs, scene: new Float32Array([1.1, 0, 0]), ecf: new Float32Array([7000, 0, 0]),
    geo: new Float32Array([0, 0, 420]), speed: new Float32Array([7.6]), flags: new Uint8Array([1]) }));
  await waitFor(() => expect(MockWorker.instances).toHaveLength(2));
  return MockWorker.instances[1];
}


function snapshot(worker: MockWorker, count = 1, altitude = 420) {
  const tick = worker.messages.filter((message) => message.type === "propagate").at(-1)!;
  return { type: "propagated", requestId: tick.requestId, version: tick.version, atMs: tick.atMs,
    scene: new Float32Array(count * 3), ecf: new Float32Array(count * 3),
    geo: new Float32Array(Array.from({ length: count }, () => [0, 0, altitude]).flat()),
    speed: new Float32Array(count).fill(7.6), flags: new Uint8Array(count).fill(1) };
}

async function loadTwoCatalogs(shared = false) {
  installFetch();
  vi.mocked(fetch).mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/catalogs") return jsonResponse({ catalogs: summaries });
    const groupId = new URL(url, "http://localhost").searchParams.get("group");
    return jsonResponse({ group: CATALOGS.find((catalog) => catalog.id === groupId),
      records: [groupId === "active" || shared ? record : { ...record, NORAD_CAT_ID: 99999, OBJECT_NAME: "SECOND SATELLITE" }] });
  });
  render(<SatelliteExplorer />);
  await startScan();
  fireEvent.click(screen.getByRole("button", { name: /Stations/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Stations/ })).toHaveClass("active"));
  const worker = MockWorker.instances[0];
  act(() => worker.deliver(snapshot(worker, shared ? 1 : 2)));
  return worker;
}

describe("explorer loading and worker recovery", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("orbital-field:locale", JSON.stringify("en"));
    MockWorker.instances = [];
    vi.stubGlobal("Worker", MockWorker);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to a remaining satellite when its selected catalog is unloaded", async () => {
    const worker = await loadTwoCatalogs();
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-selected", "25544");
    fireEvent.click(screen.getByRole("button", { name: /Active/ }));
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-ids", "99999");
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-selected", "99999");
    act(() => worker.deliver(snapshot(worker)));
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-selected", "99999");
  });

  it("removes unloaded objects and watchlist telemetry even after propagation fails", async () => {
    const worker = await loadTwoCatalogs();
    fireEvent.click(screen.getByRole("button", { name: "Add to watchlist" }));
    act(() => worker.onmessageerror?.());
    fireEvent.click(screen.getByRole("button", { name: /Active/ }));
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-ids", "99999");
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-selected", "99999");
    expect(document.querySelectorAll(".watchlist-panel .candidate-item.disabled")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Unload all" }));
    expect(screen.getByTestId("globe-stub")).toHaveTextContent("0");
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-selected", "");
    expect(document.querySelectorAll(".watchlist-panel .candidate-item.disabled")).toHaveLength(1);
  });

  it("ignores snapshots from a failed worker before and after retry", async () => {
    installFetch();
    render(<SatelliteExplorer />);
    await startScan();
    const worker = MockWorker.instances[0];
    const stale = snapshot(worker, 0);
    act(() => worker.onmessageerror?.());
    act(() => worker.deliver(stale));
    expect(screen.getByTestId("globe-stub")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const replacement = MockWorker.instances.find((candidate) => candidate !== worker &&
      candidate.messages.some((message) => message.type === "propagate"))!;
    act(() => replacement.deliver(snapshot(replacement)));
    // Even a late message carrying the new version must not be accepted from the retired worker.
    act(() => worker.deliver({ ...snapshot(replacement, 0), requestId: 100000 }));
    expect(screen.getByTestId("globe-stub")).toHaveTextContent("1");
  });

  it("preserves a selected satellite still present in another loaded catalog", async () => {
    const worker = await loadTwoCatalogs(true);
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-groups", "active");
    act(() => worker.onmessageerror?.());
    fireEvent.click(screen.getByRole("button", { name: /Active/ }));
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-ids", "25544");
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-groups", "stations");
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-selected", "25544");
  });

  it("preserves selection when only a search filter hides it", async () => {
    await loadTwoCatalogs();
    fireEvent.change(document.querySelector(".search-box input")!, { target: { value: "SECOND" } });
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-ids", "99999");
    expect(screen.getByTestId("globe-stub")).toHaveAttribute("data-selected", "25544");
  });

  it("loads only the default catalog until another catalog is selected", async () => {
    const fetchMock = installFetch();
    render(<SatelliteExplorer />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Active/ })).toHaveClass("active"));
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith("/api/gp"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Stations/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/gp?group=stations", expect.anything()));
  });

  it("deduplicates simultaneous requests before React can commit the loading state", async () => {
    const fetchMock = installFetch(() => new Promise(() => {}));
    await act(async () => { render(<SatelliteExplorer />); });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/gp?group=stations")).toHaveLength(1);
  });

  it("aborts pending requests when all catalogs are unloaded and rejects late replies", async () => {
    let reply!: (response: Response) => void;
    let requestSignal!: AbortSignal;
    installFetch((signal) => {
      requestSignal = signal;
      return new Promise((resolve) => { reply = resolve; });
    });
    render(<SatelliteExplorer />);
    fireEvent.click(screen.getByRole("button", { name: "Unload all" }));
    expect(requestSignal.aborted).toBe(true);
    await act(async () => reply(await jsonResponse({ group: CATALOGS[0], records: [record] })));
    expect(screen.getByRole("button", { name: /Active/ })).not.toHaveClass("active");
  });

  it("shows malformed GP responses as failures and allows retry", async () => {
    const fetchMock = installFetch(() => jsonResponse({ group: CATALOGS[0], records: {} }));
    render(<SatelliteExplorer />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid GP catalog response");
    expect(screen.getByRole("button", { name: /Active/ })).not.toHaveClass("active");
    fireEvent.click(screen.getByRole("button", { name: /Active/ }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/gp?group=active")).toHaveLength(2));
  });

  it("rejects a failed HTTP response even when its body contains orbital records", async () => {
    installFetch(() => jsonResponse({ group: CATALOGS[0], records: [record], error: "Data service unavailable" }, 503));
    render(<SatelliteExplorer />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Data service unavailable");
    expect(screen.getByRole("button", { name: /Active/ })).not.toHaveClass("active");
  });

  it("keeps the local catalog list when the catalog API returns a non-array", async () => {
    installFetch();
    vi.mocked(fetch).mockImplementationOnce(() => jsonResponse({ catalogs: {} }));
    render(<SatelliteExplorer />);
    await screen.findByText(/Invalid catalog response/);
    expect(document.querySelectorAll(".catalog-item")).toHaveLength(CATALOGS.length);
  });

  it("terminates an obsolete scan and ignores its results after the window changes", async () => {
    installFetch();
    render(<SatelliteExplorer />);
    const oldScan = await startScan();
    const oldRequest = oldScan.messages.find((message) => message.type === "scanRendezvous")!;
    const selects = screen.getAllByRole("combobox");
    const windowSelect = selects.find((element) => element.querySelector('option[value="24"]'))!;
    fireEvent.change(windowSelect, { target: { value: "12" } });
    await waitFor(() => expect(MockWorker.instances).toHaveLength(3));
    expect(oldScan.terminated).toBe(true);
    act(() => oldScan.deliver({ type: "rendezvousScan", requestId: oldRequest.requestId,
      atMs: oldRequest.atMs, hits: [{ name: "OBSOLETE RESULT" } as RendezvousScanHit] }));
    expect(screen.queryByText("OBSOLETE RESULT")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("clears scan progress on a worker error and starts a fresh worker on rescan", async () => {
    installFetch();
    render(<SatelliteExplorer />);
    const scan = await startScan();
    act(() => scan.onerror?.({ message: "scan unavailable", preventDefault() {} } as ErrorEvent));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("scan unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(MockWorker.instances).toHaveLength(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers recovery after propagation fails and resends the current records", async () => {
    installFetch();
    render(<SatelliteExplorer />);
    const worker = MockWorker.instances[0];
    await waitFor(() => expect(worker.messages.filter((message) => message.type === "setRecords").at(-1)?.records).toHaveLength(1));
    act(() => worker.onmessageerror?.());
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid orbital worker message");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(MockWorker.instances[1].messages.find((message) => message.type === "setRecords")?.records).toHaveLength(1));
    expect(worker.terminated).toBe(true);
  });
});
