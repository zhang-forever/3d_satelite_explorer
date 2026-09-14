import {
  degreesLat,
  degreesLong,
  eciToEcf,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate
} from "satellite.js";

export const EARTH_RADIUS_KM = 6378.137;

export type OmmRecord = {
  OBJECT_NAME: string;
  OBJECT_ID?: string;
  EPOCH: string;
  MEAN_MOTION: number | string;
  ECCENTRICITY: number | string;
  INCLINATION: number | string;
  RA_OF_ASC_NODE: number | string;
  ARG_OF_PERICENTER: number | string;
  MEAN_ANOMALY: number | string;
  EPHEMERIS_TYPE?: number | string;
  CLASSIFICATION_TYPE?: string;
  NORAD_CAT_ID: number | string;
  ELEMENT_SET_NO?: number | string;
  REV_AT_EPOCH?: number | string;
  BSTAR?: number | string;
  MEAN_MOTION_DOT?: number | string;
  MEAN_MOTION_DDOT?: number | string;
};

export type PropagatedObject = {
  id: string;
  name: string;
  objectId: string | null;
  noradId: string;
  epoch: string;
  latitude: number;
  longitude: number;
  altitudeKm: number;
  speedKmS: number;
  positionKm: { x: number; y: number; z: number };
  scene: { x: number; y: number; z: number };
  error: string | null;
  objectType: ObjectClass;
  groupId: string;
  inShadow: boolean;
};

export type ObjectClass = "payload" | "debris" | "rocket" | "unknown";

/** Fallback colour per object class, shared by the 3D scene and the UI legend. */
export const OBJECT_CLASS_COLORS: Record<ObjectClass, string> = {
  payload: "#22d3ee",
  debris: "#ef4444",
  rocket: "#c084fc",
  unknown: "#94a3b8"
};

export type EciState = {
  positionKm: { x: number; y: number; z: number };
  velocityKmS: { x: number; y: number; z: number };
};

export type RendezvousResult = {
  primaryId: string;
  secondaryId: string;
  start: string;
  end: string;
  closestAt: string;
  missDistanceKm: number;
  relativeSpeedKmS: number;
  currentDistanceKm: number | null;
  samples: number;
};

export type RendezvousScanHit = {
  noradId: string;
  name: string;
  groupId: string;
  closestAt: string;
  missDistanceKm: number;
  relativeSpeedKmS: number;
  currentDistanceKm: number;
  closestLatitudeDeg: number | null;
  closestLongitudeDeg: number | null;
  closestAltitudeKm: number | null;
};

export function parseOmmEpoch(epoch: string) {
  if (!epoch) return null;
  const normalized = /z$/i.test(epoch) || /[+-]\d\d:?\d\d$/.test(epoch) ? epoch : `${epoch}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function objectClass(record: OmmRecord): ObjectClass {
  const name = record.OBJECT_NAME?.toUpperCase() ?? "";
  if (name.includes("DEB") || name.includes("DEBRIS")) return "debris";
  if (name.includes(" R/B") || name.includes("ROCKET BODY")) return "rocket";
  if (record.OBJECT_ID) return "payload";
  return "unknown";
}

export function createSatrec(record: OmmRecord) {
  const required = [
    record.NORAD_CAT_ID,
    record.MEAN_MOTION,
    record.ECCENTRICITY,
    record.INCLINATION,
    record.RA_OF_ASC_NODE,
    record.ARG_OF_PERICENTER,
    record.MEAN_ANOMALY
  ].map(Number);
  if (required.some((value) => !Number.isFinite(value))) {
    throw new Error("OMM record contains non-finite orbital elements");
  }

  const omm = {
    ...record,
    NORAD_CAT_ID: Number(record.NORAD_CAT_ID),
    MEAN_MOTION: Number(record.MEAN_MOTION),
    ECCENTRICITY: Number(record.ECCENTRICITY),
    INCLINATION: Number(record.INCLINATION),
    RA_OF_ASC_NODE: Number(record.RA_OF_ASC_NODE),
    ARG_OF_PERICENTER: Number(record.ARG_OF_PERICENTER),
    MEAN_ANOMALY: Number(record.MEAN_ANOMALY),
    EPHEMERIS_TYPE: Number(record.EPHEMERIS_TYPE ?? 0),
    ELEMENT_SET_NO: Number(record.ELEMENT_SET_NO ?? 999),
    REV_AT_EPOCH: Number(record.REV_AT_EPOCH ?? 0),
    BSTAR: Number(record.BSTAR ?? 0),
    MEAN_MOTION_DOT: Number(record.MEAN_MOTION_DOT ?? 0),
    MEAN_MOTION_DDOT: Number(record.MEAN_MOTION_DDOT ?? 0)
  };
  return json2satrec(omm as unknown as Parameters<typeof json2satrec>[0]);
}

function vectorMagnitude(vector: { x: number; y: number; z: number }) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function vectorDistance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number }
) {
  return Math.sqrt(
    (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2
  );
}

function vectorDifference(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number }
) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

function toScenePosition(ecfKm: { x: number; y: number; z: number }) {
  return {
    x: ecfKm.x / EARTH_RADIUS_KM,
    y: ecfKm.z / EARTH_RADIUS_KM,
    z: -ecfKm.y / EARTH_RADIUS_KM
  };
}

function isFiniteVector(vector: { x: number; y: number; z: number }) {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

export function sunDirectionEci(date: Date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const Ldeg = (280.46 + 0.9856474 * n) % 360;
  const gdeg = (357.528 + 0.9856003 * n) % 360;
  const lambdaDeg =
    Ldeg + 1.915 * Math.sin((gdeg * Math.PI) / 180) + 0.02 * Math.sin((2 * gdeg * Math.PI) / 180);
  const epsilonDeg = 23.439 - 0.0000004 * n;
  const lambda = (lambdaDeg * Math.PI) / 180;
  const epsilon = (epsilonDeg * Math.PI) / 180;
  return {
    x: Math.cos(lambda),
    y: Math.cos(epsilon) * Math.sin(lambda),
    z: Math.sin(epsilon) * Math.sin(lambda)
  };
}

export function isInEarthShadow(
  positionEciKm: { x: number; y: number; z: number },
  sunDirection: { x: number; y: number; z: number }
) {
  const dot = positionEciKm.x * sunDirection.x + positionEciKm.y * sunDirection.y + positionEciKm.z * sunDirection.z;
  if (dot >= 0) return false;
  const px = positionEciKm.x - dot * sunDirection.x;
  const py = positionEciKm.y - dot * sunDirection.y;
  const pz = positionEciKm.z - dot * sunDirection.z;
  return px * px + py * py + pz * pz < EARTH_RADIUS_KM * EARTH_RADIUS_KM;
}

/**
 * Flag bits packed into `PropagationBuffers.flags`.
 * Bit 0 — the object propagated successfully for this epoch.
 * Bit 1 — the object is inside Earth's umbra/penumbra approximation.
 */
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

export function orbitalPeriodMinutes(record: OmmRecord) {
  const meanMotion = Number(record.MEAN_MOTION);
  if (!Number.isFinite(meanMotion) || meanMotion <= 0) return 90;
  return 1440 / meanMotion;
}

export function calculateRendezvous(
  primary: OmmRecord,
  secondary: OmmRecord,
  start: Date,
  options: { windowHours?: number; stepMinutes?: number; refinementSeconds?: number } = {}
): RendezvousResult | null {
  const windowHours = options.windowHours ?? 24;
  const stepMinutes = options.stepMinutes ?? 5;
  const refinementSeconds = options.refinementSeconds ?? 30;
  const end = new Date(start.getTime() + windowHours * 3_600_000);
  const coarseStepMs = Math.max(60_000, stepMinutes * 60_000);
  const refineStepMs = Math.max(5_000, refinementSeconds * 1000);
  let primarySatrec: ReturnType<typeof createSatrec>;
  let secondarySatrec: ReturnType<typeof createSatrec>;

  try {
    primarySatrec = createSatrec(primary);
    secondarySatrec = createSatrec(secondary);
  } catch {
    return null;
  }

  type ClosestState = {
    at: Date;
    distanceKm: number;
    relativeSpeedKmS: number;
  };
  let closest: ClosestState | null = null;
  let samples = 0;

  const stateFor = (satrec: ReturnType<typeof createSatrec>, at: Date): EciState | null => {
    const result = propagate(satrec, at);
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
  };

  const evaluate = (at: Date) => {
    const primaryState = stateFor(primarySatrec, at);
    const secondaryState = stateFor(secondarySatrec, at);
    if (!primaryState || !secondaryState) return;

    const distanceKm = vectorDistance(primaryState.positionKm, secondaryState.positionKm);
    const relativeSpeedKmS = vectorMagnitude(
      vectorDifference(primaryState.velocityKmS, secondaryState.velocityKmS)
    );
    if (!Number.isFinite(distanceKm) || !Number.isFinite(relativeSpeedKmS)) return;
    samples += 1;

    if (!closest || distanceKm < closest.distanceKm) {
      closest = { at, distanceKm, relativeSpeedKmS };
    }
  };

  for (let atMs = start.getTime(); atMs <= end.getTime(); atMs += coarseStepMs) {
    evaluate(new Date(atMs));
  }

  const coarseClosest = closest as ClosestState | null;
  if (!coarseClosest) return null;

  const refineStart = Math.max(start.getTime(), coarseClosest.at.getTime() - coarseStepMs);
  const refineEnd = Math.min(end.getTime(), coarseClosest.at.getTime() + coarseStepMs);
  for (let atMs = refineStart; atMs <= refineEnd; atMs += refineStepMs) {
    evaluate(new Date(atMs));
  }

  const finalClosest = closest as ClosestState | null;
  if (!finalClosest) return null;

  const currentPrimary = stateFor(primarySatrec, start);
  const currentSecondary = stateFor(secondarySatrec, start);
  const currentDistanceKm =
    currentPrimary && currentSecondary
      ? vectorDistance(currentPrimary.positionKm, currentSecondary.positionKm)
      : null;

  return {
    primaryId: String(primary.NORAD_CAT_ID),
    secondaryId: String(secondary.NORAD_CAT_ID),
    start: start.toISOString(),
    end: end.toISOString(),
    closestAt: finalClosest.at.toISOString(),
    missDistanceKm: finalClosest.distanceKm,
    relativeSpeedKmS: finalClosest.relativeSpeedKmS,
    currentDistanceKm,
    samples
  };
}

export function sampleOrbitTrack(record: OmmRecord, start: Date, groupId: string, maxHours = 24) {
  const minutes = Math.min(orbitalPeriodMinutes(record), maxHours * 60);
  const samples = Math.max(80, Math.min(240, Math.round(minutes * 1.5)));
  const points: PropagatedObject[] = [];
  const satrec = createSatrec(record);
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

export function dataAgeHours(epoch: string, at = new Date()) {
  const parsed = parseOmmEpoch(epoch);
  if (!parsed) return null;
  return (at.getTime() - parsed.getTime()) / 3_600_000;
}

/**
 * Snap a timestamp down to a fixed grid. Used to decouple expensive derived
 * work (orbit tracks, pass prediction) from the 1 Hz scene clock: the result
 * only changes when the grid step is crossed, so `useMemo` can skip the
 * recomputation on every intervening tick.
 */
export function quantizeDown(ms: number, stepMs: number) {
  if (!Number.isFinite(ms) || !Number.isFinite(stepMs) || stepMs <= 0) return ms;
  return Math.floor(ms / stepMs) * stepMs;
}

/**
 * Drop rows whose NORAD id was already seen, keeping the first occurrence.
 * Catalog groups overlap heavily (a Starlink satellite is also an "active"
 * object), so without this the same object is propagated, drawn and listed
 * several times.
 */
export function dedupeByNorad<T extends { record: OmmRecord }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    const id = String(row.record.NORAD_CAT_ID);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(row);
  }
  return unique;
}

function semiMajorAxisKm(record: OmmRecord) {
  const meanMotion = Number(record.MEAN_MOTION);
  if (!Number.isFinite(meanMotion) || meanMotion <= 0) return null;
  const periodSec = 86400 / meanMotion;
  const mu = 398600.4418;
  return Math.cbrt((mu * periodSec * periodSec) / (4 * Math.PI * Math.PI));
}

export function altitudeRangeKm(record: OmmRecord) {
  const a = semiMajorAxisKm(record);
  if (a == null) return null;
  const e = Number(record.ECCENTRICITY);
  const ecc = Number.isFinite(e) ? Math.max(0, Math.min(0.99, e)) : 0;
  return {
    minKm: a * (1 - ecc) - EARTH_RADIUS_KM,
    maxKm: a * (1 + ecc) - EARTH_RADIUS_KM
  };
}

export type RendezvousScanOptions = {
  windowHours?: number;
  stepMinutes?: number;
  refinementSeconds?: number;
  altitudeMarginKm?: number;
  hitMaxDistanceKm?: number;
  maxResults?: number;
  maxEpochAgeDays?: number;
};

export function scanRendezvous(
  primary: OmmRecord,
  secondaries: Array<{ groupId: string; record: OmmRecord }>,
  start: Date,
  options: RendezvousScanOptions = {},
  /** Called as the scan walks the secondary set — used to drive a progress bar. */
  onProgress?: (done: number, total: number) => void
): RendezvousScanHit[] {
  const windowHours = options.windowHours ?? 24;
  const stepMinutes = options.stepMinutes ?? 5;
  const refinementSeconds = options.refinementSeconds ?? 30;
  const altitudeMarginKm = options.altitudeMarginKm ?? 200;
  const hitMaxDistanceKm = options.hitMaxDistanceKm ?? 50;
  const maxResults = options.maxResults ?? 25;

  let primarySatrec: ReturnType<typeof createSatrec>;
  try {
    primarySatrec = createSatrec(primary);
  } catch {
    return [];
  }

  const primaryRange = altitudeRangeKm(primary);
  if (!primaryRange) return [];

  const endMs = start.getTime() + windowHours * 3_600_000;
  const coarseStepMs = Math.max(60_000, stepMinutes * 60_000);
  const refineStepMs = Math.max(5_000, refinementSeconds * 1000);

  const sampleTimes: Date[] = [];
  for (let atMs = start.getTime(); atMs <= endMs; atMs += coarseStepMs) {
    sampleTimes.push(new Date(atMs));
  }
  if (sampleTimes.length === 0) return [];

  const primaryStates: Array<EciState | null> = sampleTimes.map((at) => {
    const result = propagate(primarySatrec, at);
    if (!result || typeof result.position === "boolean" || typeof result.velocity === "boolean") {
      return null;
    }
    if (!isFiniteVector(result.position) || !isFiniteVector(result.velocity)) return null;
    return { positionKm: result.position, velocityKmS: result.velocity };
  });

  const primaryAtStart = primaryStates[0];
  const primaryNorad = String(primary.NORAD_CAT_ID);
  const hits: RendezvousScanHit[] = [];
  const seenNorad = new Set<string>([primaryNorad]);
  const maxEpochAgeDays = options.maxEpochAgeDays ?? 30;
  const hitMaxSq = hitMaxDistanceKm * hitMaxDistanceKm;

  const sampleCount = sampleTimes.length;
  const primaryX = new Float64Array(sampleCount);
  const primaryY = new Float64Array(sampleCount);
  const primaryZ = new Float64Array(sampleCount);
  const primaryVx = new Float64Array(sampleCount);
  const primaryVy = new Float64Array(sampleCount);
  const primaryVz = new Float64Array(sampleCount);
  const primaryValid = new Uint8Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const state = primaryStates[i];
    if (!state) continue;
    primaryValid[i] = 1;
    primaryX[i] = state.positionKm.x;
    primaryY[i] = state.positionKm.y;
    primaryZ[i] = state.positionKm.z;
    primaryVx[i] = state.velocityKmS.x;
    primaryVy[i] = state.velocityKmS.y;
    primaryVz[i] = state.velocityKmS.z;
  }

  for (let secondaryIndex = 0; secondaryIndex < secondaries.length; secondaryIndex += 1) {
    const secondary = secondaries[secondaryIndex];
    if (onProgress) {
      const done = secondaryIndex + 1;
      if (done === secondaries.length || done % 64 === 0) onProgress(done, secondaries.length);
    }
    const record = secondary.record;
    const norad = String(record.NORAD_CAT_ID);
    if (seenNorad.has(norad)) continue;
    seenNorad.add(norad);

    const epoch = parseOmmEpoch(record.EPOCH);
    if (!epoch) continue;
    const ageDays = (start.getTime() - epoch.getTime()) / 86_400_000;
    if (Math.abs(ageDays) > maxEpochAgeDays) continue;

    const range = altitudeRangeKm(record);
    if (!range) continue;
    if (range.minKm > primaryRange.maxKm + altitudeMarginKm) continue;
    if (range.maxKm < primaryRange.minKm - altitudeMarginKm) continue;

    let satrec: ReturnType<typeof createSatrec>;
    try {
      satrec = createSatrec(record);
    } catch {
      continue;
    }

    let coarseBestIdx = -1;
    let coarseBestSq = Infinity;
    let coarseBestRelSq = 0;

    for (let i = 0; i < sampleCount; i += 1) {
      if (!primaryValid[i]) continue;
      const result = propagate(satrec, sampleTimes[i]);
      if (!result || typeof result.position === "boolean" || typeof result.velocity === "boolean") {
        continue;
      }
      const dx = primaryX[i] - result.position.x;
      const dy = primaryY[i] - result.position.y;
      const dz = primaryZ[i] - result.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < coarseBestSq) {
        coarseBestSq = distSq;
        coarseBestIdx = i;
        const rvx = primaryVx[i] - result.velocity.x;
        const rvy = primaryVy[i] - result.velocity.y;
        const rvz = primaryVz[i] - result.velocity.z;
        coarseBestRelSq = rvx * rvx + rvy * rvy + rvz * rvz;
      }
    }

    if (coarseBestIdx < 0) continue;
    if (!Number.isFinite(coarseBestSq) || coarseBestSq > hitMaxSq) continue;

    const refineStart = Math.max(
      start.getTime(),
      sampleTimes[coarseBestIdx].getTime() - coarseStepMs
    );
    const refineEnd = Math.min(endMs, sampleTimes[coarseBestIdx].getTime() + coarseStepMs);
    let bestAtMs = sampleTimes[coarseBestIdx].getTime();
    let bestDistSq = coarseBestSq;
    let bestRelSq = coarseBestRelSq;

    for (let atMs = refineStart; atMs <= refineEnd; atMs += refineStepMs) {
      const at = new Date(atMs);
      const primaryResult = propagate(primarySatrec, at);
      const secondaryResult = propagate(satrec, at);
      if (
        !primaryResult ||
        !secondaryResult ||
        typeof primaryResult.position === "boolean" ||
        typeof secondaryResult.position === "boolean" ||
        typeof primaryResult.velocity === "boolean" ||
        typeof secondaryResult.velocity === "boolean"
      ) {
        continue;
      }
      const dx = primaryResult.position.x - secondaryResult.position.x;
      const dy = primaryResult.position.y - secondaryResult.position.y;
      const dz = primaryResult.position.z - secondaryResult.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestAtMs = atMs;
        const rvx = primaryResult.velocity.x - secondaryResult.velocity.x;
        const rvy = primaryResult.velocity.y - secondaryResult.velocity.y;
        const rvz = primaryResult.velocity.z - secondaryResult.velocity.z;
        bestRelSq = rvx * rvx + rvy * rvy + rvz * rvz;
      }
    }

    const bestDist = Math.sqrt(bestDistSq);
    const bestRel = Math.sqrt(bestRelSq);
    if (!Number.isFinite(bestDist)) continue;

    let currentDist = Number.NaN;
    if (primaryAtStart) {
      const result = propagate(satrec, start);
      if (
        result &&
        typeof result.position !== "boolean" &&
        isFiniteVector(result.position)
      ) {
        currentDist = vectorDistance(primaryAtStart.positionKm, result.position);
      }
    }

    let closestLatitudeDeg: number | null = null;
    let closestLongitudeDeg: number | null = null;
    let closestAltitudeKm: number | null = null;
    const closestAt = new Date(bestAtMs);
    const closestResult = propagate(satrec, closestAt);
    if (
      closestResult &&
      typeof closestResult.position !== "boolean" &&
      isFiniteVector(closestResult.position)
    ) {
      const geodetic = eciToGeodetic(closestResult.position, gstime(closestAt));
      if (
        Number.isFinite(geodetic.latitude) &&
        Number.isFinite(geodetic.longitude) &&
        Number.isFinite(geodetic.height)
      ) {
        closestLatitudeDeg = degreesLat(geodetic.latitude);
        closestLongitudeDeg = degreesLong(geodetic.longitude);
        closestAltitudeKm = geodetic.height;
      }
    }

    hits.push({
      noradId: String(record.NORAD_CAT_ID),
      name: record.OBJECT_NAME,
      groupId: secondary.groupId,
      closestAt: closestAt.toISOString(),
      missDistanceKm: bestDist,
      relativeSpeedKmS: bestRel,
      currentDistanceKm: Number.isFinite(currentDist) ? currentDist : 0,
      closestLatitudeDeg,
      closestLongitudeDeg,
      closestAltitudeKm
    });
  }

  hits.sort((a, b) => a.missDistanceKm - b.missDistanceKm);
  return hits.slice(0, maxResults);
}
