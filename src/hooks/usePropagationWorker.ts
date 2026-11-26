"use client";

import { useEffect, useRef, useState } from "react";

import {
  PROPAGATION_SHADOW,
  PROPAGATION_VALID,
  type PropagatedObject
} from "@/lib/orbit";

import type {
  IndexedRecord,
  PropagationSnapshot,
  RecordMeta
} from "@/lib/explorer-types";

/**
 * Owns the propagation Web Worker: record sync, the 1 Hz propagate tick, and
 * the object pool that receives the typed-array snapshots.
 *
 * `recordsVersionRef` is exposed because the rendezvous scan runs on its own
 * worker and must tag its record set with the same version counter — a stale
 * reply from either worker is then dropped for the same reason.
 */
export function usePropagationWorker(
  indexedRecords: IndexedRecord[],
  recordMeta: RecordMeta[],
  sceneTime: Date
) {
  const [workerObjects, setWorkerObjects] = useState<PropagatedObject[]>([]);
  const [propagationError, setPropagationError] = useState<string | null>(null);
  const [workerNonce, setWorkerNonce] = useState(0);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const latestRequestIdRef = useRef(0);
  const recordsVersionRef = useRef(0);
  const objectPoolRef = useRef<PropagatedObject[]>([]);
  const recordMetaRef = useRef<RecordMeta[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    /**
     * Turn a flat typed-array snapshot into the object list the UI consumes.
     * Objects are reused between ticks; only the returned array identity
     * changes, which is all React needs to observe the update.
     */
    const applySnapshot = (snapshot: PropagationSnapshot): PropagatedObject[] => {
      const meta = recordMetaRef.current;
      const pool = objectPoolRef.current;
      const { scene, ecf, geo, speed, flags } = snapshot;
      const total = flags.length;
      let used = 0;

      for (let i = 0; i < total; i += 1) {
        if ((flags[i] & PROPAGATION_VALID) === 0) continue;
        const info = meta[i];
        if (!info) continue;
        const i3 = i * 3;

        let object = pool[used];
        if (!object) {
          object = {
            id: info.id,
            name: info.name,
            objectId: info.objectId,
            noradId: info.noradId,
            epoch: info.epoch,
            latitude: 0,
            longitude: 0,
            altitudeKm: 0,
            speedKmS: 0,
            positionKm: { x: 0, y: 0, z: 0 },
            scene: { x: 0, y: 0, z: 0 },
            error: null,
            objectType: info.objectType,
            groupId: info.groupId,
            inShadow: false
          };
          pool[used] = object;
        }

        object.id = info.id;
        object.name = info.name;
        object.objectId = info.objectId;
        object.noradId = info.noradId;
        object.epoch = info.epoch;
        object.objectType = info.objectType;
        object.groupId = info.groupId;
        object.latitude = geo[i3];
        object.longitude = geo[i3 + 1];
        object.altitudeKm = geo[i3 + 2];
        object.speedKmS = speed[i];
        object.scene.x = scene[i3];
        object.scene.y = scene[i3 + 1];
        object.scene.z = scene[i3 + 2];
        object.positionKm.x = ecf[i3];
        object.positionKm.y = ecf[i3 + 1];
        object.positionKm.z = ecf[i3 + 2];
        object.inShadow = (flags[i] & PROPAGATION_SHADOW) !== 0;
        used += 1;
      }

      return pool.slice(0, used);
    };

    let propagateWorker: Worker;
    try {
      propagateWorker = new Worker(new URL("@/lib/propagationWorker.ts", import.meta.url), {
        type: "module"
      });
    } catch (error) {
      setPropagationError(error instanceof Error ? error.message : "Unable to start orbital worker");
      return;
    }
    const failPropagation = (message: string) => {
      if (workerRef.current !== propagateWorker) return;
      propagateWorker.terminate();
      workerRef.current = null;
      setPropagationError(message);
    };
    propagateWorker.onerror = (event) => {
      event.preventDefault();
      failPropagation(event.message || "Orbital worker failed");
    };
    propagateWorker.onmessageerror = () => failPropagation("Invalid orbital worker message");
    propagateWorker.onmessage = (event: MessageEvent) => {
      if (workerRef.current !== propagateWorker) return;
      const msg = event.data as ({ type: "propagated" } & PropagationSnapshot) |
        { type: "workerError"; message: string };
      if (msg.type === "workerError") {
        failPropagation(msg.message);
        return;
      }
      if (msg.type !== "propagated") return;
      if (msg.requestId < latestRequestIdRef.current) return;
      // Snapshots are indexed into the worker's copy of the record set — drop
      // any reply that belongs to a set we have already replaced.
      if (msg.version !== recordsVersionRef.current) return;
      latestRequestIdRef.current = msg.requestId;
      setWorkerObjects(applySnapshot(msg));
    };

    workerRef.current = propagateWorker;

    return () => {
      propagateWorker.terminate();
      if (workerRef.current === propagateWorker) workerRef.current = null;
    };
  }, [workerNonce]);

  useEffect(() => {
    recordMetaRef.current = recordMeta;
    const propagateWorker = workerRef.current;
    if (!propagateWorker) return;

    const version = recordsVersionRef.current + 1;
    recordsVersionRef.current = version;
    const records = indexedRecords.map((row) => ({ groupId: row.groupId, record: row.record }));
    propagateWorker.postMessage({ type: "setRecords", version, records });
  }, [indexedRecords, recordMeta, workerNonce]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const requestId = ++requestIdRef.current;
    worker.postMessage({
      type: "propagate",
      requestId,
      version: recordsVersionRef.current,
      atMs: sceneTime.getTime()
    });
  }, [sceneTime, recordMeta, workerNonce]);

  const retryPropagation = () => {
    setPropagationError(null);
    setWorkerNonce((value) => value + 1);
  };

  return {
    workerObjects,
    propagationError,
    retryPropagation,
    workerNonce,
    recordsVersionRef
  };
}
