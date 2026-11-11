/**
 * SGP4 propagation entry points. The batch API writes into reused typed arrays
 * because it runs on the worker for the whole catalog every second.
 */
import {
  degreesLat,
  degreesLong,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate
} from "satellite.js";

import {
  EARTH_RADIUS_KM,
  isFiniteVector,
  isInEarthShadow,
  sunDirectionEci,
  vectorMagnitude
} from "./earth";
import { createSatrec, objectClass } from "./elements";
import type {
  EciState,
  ObjectClass,
  OmmRecord,
  PropagatedObject
} from "./types";

export const PROPAGATION_VALID = 1;
export const PROPAGATION_SHADOW = 2;

/**
 * Struct-of-arrays sink for a whole constellation's worth of state.
 *
 * The UI needs ~16k positions every second. Building 16k plain objects per tick
 * on the worker, structured-cloning them across the thread boundary and then
 * throwing them away was the single hottest path in the app. Instead the worker
 * fills these typed arrays once and reuses them; the main thread keeps a pool of
 * plain objects and patches it in place.
 */
export type PropagationBuffers = {
  length: number;
  /** Scene-space position (Earth radii), three floats per object. */
  scene: Float32Array;
  /** ECF position in km, three floats per object. */
  ecf: Float32Array;
  /** `[latitudeDeg, longitudeDeg, altitudeKm]` per object. */
  geo: Float32Array;
  /** Speed in km/s per object. */
  speed: Float32Array;
  /** Bitfield per object, see `PROPAGATION_*`. */
  flags: Uint8Array;
};

export function allocatePropagationBuffers(length: number): PropagationBuffers {
  return {
    length,
    scene: new Float32Array(length * 3),
    ecf: new Float32Array(length * 3),
    geo: new Float32Array(length * 3),
    speed: new Float32Array(length),
    flags: new Uint8Array(length)
  };
}

/** Scratch sink used by the single-object helpers so they stay allocation-free. */
const singleSink = allocatePropagationBuffers(1);

function writeState(
  sink: PropagationBuffers,
  index: number,
  satrec: ReturnType<typeof createSatrec>,
  date: Date,
  gmst: number,
  sunEci: { x: number; y: number; z: number }
) {
  const result = propagate(satrec, date);
  if (!result || typeof result.position === "boolean" || typeof result.velocity === "boolean") {
    return false;
  }

  const geodetic = eciToGeodetic(result.position, gmst);
  const ecf = eciToEcf(result.position, gmst);
  const speedKmS = vectorMagnitude(result.velocity);
  if (
    !isFiniteVector(ecf) ||
    !Number.isFinite(speedKmS) ||
    !Number.isFinite(geodetic.latitude) ||
    !Number.isFinite(geodetic.longitude) ||
    !Number.isFinite(geodetic.height)
  ) {
    return false;
  }

  const i3 = index * 3;
  sink.scene[i3] = ecf.x / EARTH_RADIUS_KM;
  sink.scene[i3 + 1] = ecf.z / EARTH_RADIUS_KM;
  sink.scene[i3 + 2] = -ecf.y / EARTH_RADIUS_KM;
  sink.ecf[i3] = ecf.x;
  sink.ecf[i3 + 1] = ecf.y;
  sink.ecf[i3 + 2] = ecf.z;
  sink.geo[i3] = degreesLat(geodetic.latitude);
  sink.geo[i3 + 1] = degreesLong(geodetic.longitude);
  sink.geo[i3 + 2] = geodetic.height;
  sink.speed[index] = speedKmS;
  sink.flags[index] =
    PROPAGATION_VALID |
    (isInEarthShadow(result.position, sunEci) ? PROPAGATION_SHADOW : 0);
  return true;
}

/**
 * Propagate every satrec into `sink` for a single epoch.
 * Returns how many entries are valid. Uses one shared GMST + sun vector, which
 * is both faster and more consistent than recomputing them per object.
 */
export function propagateBatch(
  satrecs: Array<ReturnType<typeof createSatrec> | null>,
  date: Date,
  sink: PropagationBuffers,
  precomputedSunEci?: { x: number; y: number; z: number }
): number {
  const count = Math.min(satrecs.length, sink.length);
  if (count === 0) return 0;

  const gmst = gstime(date);
  const sunEci = precomputedSunEci ?? sunDirectionEci(date);
  sink.flags.fill(0, 0, count);

  let valid = 0;
  for (let i = 0; i < count; i += 1) {
    const satrec = satrecs[i];
    if (!satrec) continue;
    try {
      if (writeState(sink, i, satrec, date, gmst, sunEci)) valid += 1;
    } catch {
      // A single bad element set must not abort the whole batch.
    }
  }
  return valid;
}

export function propagateOmm(
  record: OmmRecord,
  date: Date,
  groupId = "unknown"
): PropagatedObject | null {
  try {
    const satrec = createSatrec(record);
    return propagateWithSatrec(satrec, record, date, groupId);
  } catch {
    return null;
  }
}

export function propagateWithSatrec(
  satrec: ReturnType<typeof createSatrec>,
  record: OmmRecord,
  date: Date,
  groupId = "unknown",
  precomputedObjectType?: ObjectClass,
  precomputedSunEci?: { x: number; y: number; z: number }
): PropagatedObject | null {
  let ok = false;
  try {
    singleSink.flags[0] = 0;
    ok = writeState(
      singleSink,
      0,
      satrec,
      date,
      gstime(date),
      precomputedSunEci ?? sunDirectionEci(date)
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  const ecf = { x: singleSink.ecf[0], y: singleSink.ecf[1], z: singleSink.ecf[2] };
  return {
    id: String(record.NORAD_CAT_ID),
    name: record.OBJECT_NAME,
    objectId: record.OBJECT_ID ?? null,
    noradId: String(record.NORAD_CAT_ID),
    epoch: record.EPOCH,
    latitude: singleSink.geo[0],
    longitude: singleSink.geo[1],
    altitudeKm: singleSink.geo[2],
    speedKmS: singleSink.speed[0],
    positionKm: ecf,
    scene: {
      x: singleSink.scene[0],
      y: singleSink.scene[1],
      z: singleSink.scene[2]
    },
    error: null,
    objectType: precomputedObjectType ?? objectClass(record),
    groupId,
    inShadow: (singleSink.flags[0] & PROPAGATION_SHADOW) !== 0
  };
}

export function propagateOmmEci(record: OmmRecord, date: Date): EciState | null {
  try {
    const satrec = createSatrec(record);
    const result = propagate(satrec, date);
    if (!result || typeof result.position === "boolean" || typeof result.velocity === "boolean") {
      return null;
    }
    if (!isFiniteVector(result.position) || !isFiniteVector(result.velocity)) {
      return null;
    }

    return {
      positionKm: result.position,
      velocityKmS: result.velocity
    };
  } catch {
    return null;
  }
}
