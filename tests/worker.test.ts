import { beforeEach, describe, expect, it, vi } from "vitest";

const calculations = vi.hoisted(() => ({ propagate: vi.fn(), scan: vi.fn() }));
vi.mock("@/lib/orbit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/orbit")>(),
  propagateBatch: calculations.propagate, scanRendezvous: calculations.scan
}));

describe("orbital worker failures", () => {
  beforeEach(() => {
    vi.resetModules();
    calculations.propagate.mockReset();
    calculations.scan.mockReset();
  });

  async function createWorkerHarness() {
    let handleMessage!: (event: { data: unknown }) => void;
    const replies = vi.fn();
    vi.stubGlobal("self", {
      addEventListener: (_type: string, handler: typeof handleMessage) => { handleMessage = handler; },
      postMessage: replies
    });
    await import("@/lib/propagationWorker");
    return { send: (data: unknown) => handleMessage({ data }), replies };
  }

  it("reports a propagation exception with its request ID", async () => {
    const worker = await createWorkerHarness();
    calculations.propagate.mockImplementation(() => { throw new Error("Propagation failed"); });
    worker.send({ type: "setRecords", version: 1, records: [] });
    worker.send({ type: "propagate", version: 1, requestId: 7, atMs: 0 });
    expect(worker.replies).toHaveBeenCalledExactlyOnceWith({
      type: "workerError", requestId: 7, message: "Propagation failed"
    });
    vi.unstubAllGlobals();
  });

  it("reports a scan exception so the caller can stop its progress indicator", async () => {
    const worker = await createWorkerHarness();
    calculations.scan.mockImplementation(() => { throw new Error("Scan failed"); });
    worker.send({ type: "scanRendezvous", requestId: 9, primary: {}, atMs: 0 });
    expect(worker.replies).toHaveBeenCalledExactlyOnceWith({
      type: "workerError", requestId: 9, message: "Scan failed"
    });
    vi.unstubAllGlobals();
  });
});
