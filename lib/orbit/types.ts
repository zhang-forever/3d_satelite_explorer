/** A CelesTrak OMM/GPV record, kept in its wire form (numbers arrive as strings). */
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
