/**
 * Sampled orbital tracks and the time-grid helper that keeps expensive derived
 * work off the 1 Hz scene clock.
 */
import {
  degreesLat,
  degreesLong,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate
} from "satellite.js";

import { isFiniteVector, toScenePosition, vectorMagnitude } from "./earth";
import { createSatrec, objectClass, orbitalPeriodMinutes } from "./elements";
import type { OmmRecord, PropagatedObject } from "./types";

export function sampleOrbitTrack(record: OmmRecord, start: Date, groupId: string, maxHours = 24) {
  const minutes = Math.min(orbitalPeriodMinutes(record), maxHours * 60);
  const samples = Math.max(80, Math.min(240, Math.round(minutes * 1.5)));
  const points: PropagatedObject[] = [];
  let satrec: ReturnType<typeof createSatrec>;
  try {
    satrec = createSatrec(record);
  } catch {
    // A malformed catalog entry must not crash the selected-object panel.
    return points;
  }
  const sceneGmst = gstime(start);

  for (let index = 0; index <= samples; index += 1) {
    const at = new Date(start.getTime() + (minutes * 60 * 1000 * index) / samples);
    const result = propagate(satrec, at);
    if (!result || typeof result.position === "boolean" || typeof result.velocity === "boolean") {
      continue;
    }

    const geodetic = eciToGeodetic(result.position, gstime(at));
    const sceneEcf = eciToEcf(result.position, sceneGmst);
    const speedKmS = vectorMagnitude(result.velocity);
    if (
      !isFiniteVector(sceneEcf) ||
      !Number.isFinite(speedKmS) ||
      !Number.isFinite(geodetic.latitude) ||
      !Number.isFinite(geodetic.longitude) ||
      !Number.isFinite(geodetic.height)
    ) {
      continue;
    }

    points.push({
      id: String(record.NORAD_CAT_ID),
      name: record.OBJECT_NAME,
      objectId: record.OBJECT_ID ?? null,
      noradId: String(record.NORAD_CAT_ID),
      epoch: record.EPOCH,
      latitude: degreesLat(geodetic.latitude),
      longitude: degreesLong(geodetic.longitude),
      altitudeKm: geodetic.height,
      speedKmS,
      positionKm: sceneEcf,
      scene: toScenePosition(sceneEcf),
      error: null,
      objectType: objectClass(record),
      groupId,
      inShadow: false
    });
  }
  return points;
}

export function quantizeDown(ms: number, stepMs: number) {
  if (!Number.isFinite(ms) || !Number.isFinite(stepMs) || stepMs <= 0) return ms;
  return Math.floor(ms / stepMs) * stepMs;
}
