/// <reference lib="webworker" />

import {
  createSatrec,
  objectClass,
  propagateWithSatrec,
  scanRendezvous,
  sunDirectionEci,
  type ObjectClass,
  type OmmRecord,
  type PropagatedObject,
  type RendezvousScanHit,
  type RendezvousScanOptions
} from "@/lib/orbit";

type IndexedRecord = { groupId: string; record: OmmRecord };

type InboundMessage =
  | { type: "setRecords"; records: IndexedRecord[] }
  | { type: "propagate"; requestId: number; atMs: number }
  | {
      type: "scanRendezvous";
      requestId: number;
      primary: OmmRecord;
      atMs: number;
      options?: RendezvousScanOptions;
    };

type OutboundMessage =
  | {
      type: "propagated";
      requestId: number;
      atMs: number;
      objects: PropagatedObject[];
    }
  | {
      type: "rendezvousScan";
      requestId: number;
      atMs: number;
      hits: RendezvousScanHit[];
    };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let records: IndexedRecord[] = [];
let satrecs: Array<ReturnType<typeof createSatrec> | null> = [];
let objectTypes: ObjectClass[] = [];

function rebuildSatrecs() {
  satrecs = records.map((row) => {
    try {
      return createSatrec(row.record);
    } catch {
      return null;
    }
  });
  objectTypes = records.map((row) => objectClass(row.record));
}

ctx.addEventListener("message", (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (msg.type === "setRecords") {
    records = msg.records;
    rebuildSatrecs();
    return;
  }
  if (msg.type === "propagate") {
    const at = new Date(msg.atMs);
    const sunEci = sunDirectionEci(at);
    const objects: PropagatedObject[] = [];
    for (let i = 0; i < records.length; i += 1) {
      const satrec = satrecs[i];
      if (!satrec) continue;
      const row = records[i];
      const obj = propagateWithSatrec(satrec, row.record, at, row.groupId, objectTypes[i], sunEci);
      if (obj) objects.push(obj);
    }
    const reply: OutboundMessage = {
      type: "propagated",
      requestId: msg.requestId,
      atMs: msg.atMs,
      objects
    };
    ctx.postMessage(reply);
    return;
  }
  if (msg.type === "scanRendezvous") {
    const at = new Date(msg.atMs);
    const hits = scanRendezvous(msg.primary, records, at, msg.options);
    const reply: OutboundMessage = {
      type: "rendezvousScan",
      requestId: msg.requestId,
      atMs: msg.atMs,
      hits
    };
    ctx.postMessage(reply);
    return;
  }
});

export {};
