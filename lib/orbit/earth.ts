/**
 * Earth geometry, vector helpers, and the sun/shadow model shared by every
 * propagation path. Pure math: no satellite.js dependency.
 */

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
