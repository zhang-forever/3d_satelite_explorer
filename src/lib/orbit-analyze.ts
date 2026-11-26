/**
 * Close-approach analysis: a single-pair search and the multi-object sweep used
 * by the rendezvous panel.
 */
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate
} from "satellite.js";

import {
  altitudeRangeKm,
  createSatrec,
  isFiniteVector,
  parseOmmEpoch,
  vectorDifference,
  vectorDistance,
  vectorMagnitude
} from "./orbit-elements";
import type {
  EciState,
  OmmRecord,
  RendezvousResult,
  RendezvousScanHit
} from "./orbit-types";

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
  // Several candidates refine the same time interval. Share those primary
  // propagations just as the coarse sweep shares its precomputed samples.
  const refinedPrimaryStates = new Map<number, ReturnType<typeof propagate>>();
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

    // Record the id only once the candidate is usable: an unusable first
    // duplicate must not shadow a valid one later in the list.
    seenNorad.add(norad);

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
    if (!Number.isFinite(coarseBestSq)) continue;

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
      if (!refinedPrimaryStates.has(atMs)) {
        refinedPrimaryStates.set(atMs, propagate(primarySatrec, at));
      }
      const primaryResult = refinedPrimaryStates.get(atMs);
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
    // Coarse samples can straddle a close encounter while both lie outside
    // the cutoff. Apply the distance threshold only after refining it.
    if (!Number.isFinite(bestDist) || bestDistSq > hitMaxSq) continue;

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
      currentDistanceKm: Number.isFinite(currentDist) ? currentDist : null,
      closestLatitudeDeg,
      closestLongitudeDeg,
      closestAltitudeKm
    });
  }

  hits.sort((a, b) => a.missDistanceKm - b.missDistanceKm);
  return hits.slice(0, maxResults);
}
