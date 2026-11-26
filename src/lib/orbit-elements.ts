/**
 * Earth geometry, vector helpers, sun/shadow model, and OMM element-set
 * interpretation (epoch parsing, classification, SGP4 record construction).
 */
import { json2satrec } from "satellite.js";

import type { ObjectClass, OmmRecord } from "./orbit-types";

export const EARTH_RADIUS_KM = 6378.137;

export type Vector3 = { x: number; y: number; z: number };

export function vectorMagnitude(vector: { x: number; y: number; z: number }) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

export function vectorDistance(left: Vector3, right: Vector3) {
  return Math.sqrt(
    (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2
  );
}

export function vectorDifference(left: Vector3, right: Vector3) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

export function toScenePosition(ecfKm: Vector3) {
  return {
    x: ecfKm.x / EARTH_RADIUS_KM,
    y: ecfKm.z / EARTH_RADIUS_KM,
    z: -ecfKm.y / EARTH_RADIUS_KM
  };
}

export function isFiniteVector(vector: Vector3) {
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
  const epoch = parseOmmEpoch(record.EPOCH);
  if (!epoch) throw new Error("OMM record contains an invalid epoch");

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
    // satellite.js 6 appends its own Z. Normalize explicit offsets to UTC and
    // pass the timezone-less UTC shape it expects, rather than producing ZZ.
    EPOCH: epoch.toISOString().slice(0, -1),
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

export function orbitalPeriodMinutes(record: OmmRecord) {
  const meanMotion = Number(record.MEAN_MOTION);
  if (!Number.isFinite(meanMotion) || meanMotion <= 0) return 90;
  return 1440 / meanMotion;
}

export function dataAgeHours(epoch: string, at = new Date()) {
  const parsed = parseOmmEpoch(epoch);
  if (!parsed) return null;
  return (at.getTime() - parsed.getTime()) / 3_600_000;
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
