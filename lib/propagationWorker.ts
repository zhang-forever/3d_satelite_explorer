/// <reference lib="webworker" />

import {
  allocatePropagationBuffers,
  createSatrec,
  propagateBatch,
  scanRendezvous,
  sunDirectionEci,
  type OmmRecord,
  type PropagationBuffers,
  type RendezvousScanHit,
  type RendezvousScanOptions
} from "@/lib/orbit";

type IndexedRecord = { groupId: string; record: OmmRecord };

type InboundMessage =
  | { type: "setRecords"; version: number; records: IndexedRecord[] }
  | { type: "propagate"; requestId: number; version: number; atMs: number }
  | {
      type: "scanRendezvous";
      requestId: number;
      primary: OmmRecord;
      atMs: number;
      options?: RendezvousScanOptions;
    };

/**
 * Positions travel as typed arrays rather than as one object per satellite.
 * A snapshot is a flat copy of the reusable buffers — no per-object allocation
 * on either side of the thread boundary, no GC churn at 1 Hz.
 */
type PropagationSnapshot = {
  type: "propagated";
  requestId: number;
  version: number;
  atMs: number;
  scene: Float32Array;
  ecf: Float32Array;
  geo: Float32Array;
  speed: Float32Array;
  flags: Uint8Array;
};

type OutboundMessage =
  | PropagationSnapshot
  | { type: "workerError"; requestId: number | null; message: string }
  | {
      type: "rendezvousScan";
      requestId: number;
      atMs: number;
      hits: RendezvousScanHit[];
    }
  | {
      type: "scanProgress";
      requestId: number;
      done: number;
      total: number;
    };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let records: IndexedRecord[] = [];
let satrecs: Array<ReturnType<typeof createSatrec> | null> = [];
let buffers: PropagationBuffers = allocatePropagationBuffers(0);
let recordsVersion = 0;
let satrecsStale = true;
let lastProgressAt = 0;

/**
 * Parsing the record set is the expensive part of a `setRecords`, and the scan
 * worker never propagates anything itself (`scanRendezvous` builds what it
 * needs). Building the satrec cache lazily means only the worker that actually
 * ticks the clock pays for it.
 */
function buildSatrecs() {
  satrecs = new Array(records.length);
  for (let i = 0; i < records.length; i += 1) {
    try {
      satrecs[i] = createSatrec(records[i].record);
    } catch {
      satrecs[i] = null;
    }
  }
  satrecsStale = false;
  // Grow (or shrink) the reusable sink to match the record set once, instead
  // of allocating fresh arrays on every animation tick.
  if (buffers.length !== records.length) {
    buffers = allocatePropagationBuffers(records.length);
  } else {
    buffers.flags.fill(0);
  }
}

function handleMessage(msg: InboundMessage) {
  if (msg.type === "setRecords") {
    records = msg.records;
    recordsVersion = msg.version;
    satrecsStale = true;
    satrecs = [];
    return;
  }

  if (msg.type === "propagate") {
    // A stale request would index into a record set we no longer have.
    if (msg.version !== recordsVersion) return;
    if (satrecsStale) buildSatrecs();

    const at = new Date(msg.atMs);
    propagateBatch(satrecs, at, buffers, sunDirectionEci(at));

    const reply: PropagationSnapshot = {
      type: "propagated",
      requestId: msg.requestId,
      version: recordsVersion,
      atMs: msg.atMs,
      scene: buffers.scene,
      ecf: buffers.ecf,
      geo: buffers.geo,
      speed: buffers.speed,
      flags: buffers.flags
    };
    ctx.postMessage(reply);
    return;
  }

  if (msg.type === "scanRendezvous") {
    const at = new Date(msg.atMs);
    const hits = scanRendezvous(msg.primary, records, at, msg.options, (done, total) => {
      // Throttle progress traffic; the UI only needs a few updates per second.
      const now = Date.now();
      if (done < total && now - lastProgressAt < 120) return;
      lastProgressAt = now;
      const progress: OutboundMessage = {
        type: "scanProgress",
        requestId: msg.requestId,
        done,
        total
      };
      ctx.postMessage(progress);
    });
    const reply: OutboundMessage = {
      type: "rendezvousScan",
      requestId: msg.requestId,
      atMs: msg.atMs,
      hits
    };
    ctx.postMessage(reply);
    return;
  }
}

ctx.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  try {
    handleMessage(msg);
  } catch (error) {
    const reply: OutboundMessage = {
      type: "workerError",
      requestId: "requestId" in msg ? msg.requestId : null,
      message: error instanceof Error ? error.message : "Orbital calculation failed"
    };
    ctx.postMessage(reply);
  }
});

export {};
