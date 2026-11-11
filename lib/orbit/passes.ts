import {
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  gstime,
  propagate,
  radiansToDegrees
} from "satellite.js";
import { createSatrec, type OmmRecord } from "@/lib/orbit";

export type ObserverLocation = {
  latitudeDeg: number;
  longitudeDeg: number;
  heightKm?: number;
};

export type PassWindow = {
  startAt: string;
  peakAt: string;
  endAt: string;
  durationSec: number;
  peakElevationDeg: number;
  startAzimuthDeg: number;
  endAzimuthDeg: number;
  peakAzimuthDeg: number;
};

export type PassPredictionOptions = {
  windowHours?: number;
  stepSeconds?: number;
  minElevationDeg?: number;
  maxResults?: number;
};

type Sample = {
  at: Date;
  elevationDeg: number;
  azimuthDeg: number;
};

function lookAngles(
  satrec: ReturnType<typeof createSatrec>,
  observerRad: { latitude: number; longitude: number; height: number },
  at: Date
): Sample | null {
  const result = propagate(satrec, at);
  if (!result || typeof result.position === "boolean") return null;
  const ecf = eciToEcf(result.position, gstime(at));
  const angles = ecfToLookAngles(observerRad, ecf);
  if (!Number.isFinite(angles.elevation) || !Number.isFinite(angles.azimuth)) return null;
  return {
    at,
    elevationDeg: radiansToDegrees(angles.elevation),
    azimuthDeg: (radiansToDegrees(angles.azimuth) + 360) % 360
  };
}

function refinePeak(
  satrec: ReturnType<typeof createSatrec>,
  observer: { latitude: number; longitude: number; height: number },
  before: Sample,
  middle: Sample,
  after: Sample
): Sample {
  let lo = before.at.getTime();
  let hi = after.at.getTime();
  let best = middle;
  for (let i = 0; i < 12; i += 1) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const s1 = lookAngles(satrec, observer, new Date(m1));
    const s2 = lookAngles(satrec, observer, new Date(m2));
    if (!s1 || !s2) break;
    if (s1.elevationDeg > s2.elevationDeg) {
      hi = m2;
      if (s1.elevationDeg > best.elevationDeg) best = s1;
    } else {
      lo = m1;
      if (s2.elevationDeg > best.elevationDeg) best = s2;
    }
  }
  return best;
}

function refineCrossing(
  satrec: ReturnType<typeof createSatrec>,
  observer: { latitude: number; longitude: number; height: number },
  below: Sample,
  above: Sample,
  threshold: number
): Sample {
  let lo = below.at.getTime();
  let hi = above.at.getTime();
  let mid = above;
  for (let i = 0; i < 18; i += 1) {
    const midMs = (lo + hi) / 2;
    const sample = lookAngles(satrec, observer, new Date(midMs));
    if (!sample) break;
    if (sample.elevationDeg >= threshold) {
      hi = midMs;
      mid = sample;
    } else {
      lo = midMs;
    }
  }
  return mid;
}

export function predictPasses(
  record: OmmRecord,
  observer: ObserverLocation,
  start: Date,
  options: PassPredictionOptions = {}
): PassWindow[] {
  const windowHours = options.windowHours ?? 48;
  const stepSeconds = Math.max(10, options.stepSeconds ?? 60);
  const minElevationDeg = options.minElevationDeg ?? 10;
  const maxResults = options.maxResults ?? 8;

  let satrec: ReturnType<typeof createSatrec>;
  try {
    satrec = createSatrec(record);
  } catch {
    return [];
  }

  const observerRad = {
    latitude: degreesToRadians(observer.latitudeDeg),
    longitude: degreesToRadians(observer.longitudeDeg),
    height: observer.heightKm ?? 0
  };

  const endMs = start.getTime() + windowHours * 3_600_000;
  const stepMs = stepSeconds * 1000;
  const passes: PassWindow[] = [];

  let prev = lookAngles(satrec, observerRad, start);
  let pendingStart: Sample | null =
    prev && prev.elevationDeg >= minElevationDeg ? prev : null;
  let pendingPeak: Sample | null = pendingStart;

  for (let atMs = start.getTime() + stepMs; atMs <= endMs; atMs += stepMs) {
    const sample = lookAngles(satrec, observerRad, new Date(atMs));
    if (!sample || !prev) {
      prev = sample;
      continue;
    }

    const wasUp = prev.elevationDeg >= minElevationDeg;
    const isUp = sample.elevationDeg >= minElevationDeg;

    if (!wasUp && isUp) {
      const startSample = refineCrossing(satrec, observerRad, prev, sample, minElevationDeg);
      pendingStart = startSample;
      pendingPeak = sample;
    } else if (isUp && pendingPeak && sample.elevationDeg > pendingPeak.elevationDeg) {
      pendingPeak = sample;
    } else if (wasUp && !isUp && pendingStart && pendingPeak) {
      const endSample = refineCrossing(
        satrec,
        observerRad,
        sample,
        prev,
        minElevationDeg
      );
      const peak = refinePeak(satrec, observerRad, pendingStart, pendingPeak, endSample);
      passes.push({
        startAt: pendingStart.at.toISOString(),
        peakAt: peak.at.toISOString(),
        endAt: endSample.at.toISOString(),
        durationSec: Math.max(
          0,
          Math.round((endSample.at.getTime() - pendingStart.at.getTime()) / 1000)
        ),
        peakElevationDeg: peak.elevationDeg,
        startAzimuthDeg: pendingStart.azimuthDeg,
        endAzimuthDeg: endSample.azimuthDeg,
        peakAzimuthDeg: peak.azimuthDeg
      });
      pendingStart = null;
      pendingPeak = null;
      if (passes.length >= maxResults) break;
    }
    prev = sample;
  }

  return passes;
}

const COMPASS_POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW"
];

export function azimuthToCompass(azimuthDeg: number) {
  const normalized = ((azimuthDeg % 360) + 360) % 360;
  const index = Math.round(normalized / 22.5) % 16;
  return COMPASS_POINTS[index];
}
