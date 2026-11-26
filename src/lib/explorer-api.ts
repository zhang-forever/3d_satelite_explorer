import { AVAILABLE_CATALOGS } from "@/lib/dataAccess";
import { parseOmmEpoch, type OmmRecord } from "@/lib/orbit";

import type { CatalogSummary } from "@/lib/explorer-types";

export function isApiObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readApiResponse(response: Response) {
  const payload: unknown = await response.json();
  if (!isApiObject(payload)) throw new Error("Invalid data response");
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`
    );
  }
  return payload;
}

export function isOmmRecord(value: unknown): value is OmmRecord {
  if (
    !isApiObject(value) ||
    typeof value.OBJECT_NAME !== "string" ||
    typeof value.EPOCH !== "string" ||
    !parseOmmEpoch(value.EPOCH)
  ) {
    return false;
  }
  return [
    "NORAD_CAT_ID", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER", "MEAN_ANOMALY"
  ].every(
    (key) =>
      (typeof value[key] === "number" || typeof value[key] === "string") &&
      value[key] !== "" &&
      Number.isFinite(Number(value[key]))
  );
}

export function fallbackCatalogs(): CatalogSummary[] {
  return AVAILABLE_CATALOGS.map((catalog) => ({
    ...catalog,
    cachedCount: 0,
    fetchedAt: null,
    sourceUpdatedAt: null,
    stale: true,
    error: null
  }));
}

export function normalizeText(value: string) {
  return value.trim().toLowerCase();
}
