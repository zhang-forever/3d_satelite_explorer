import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CATALOGS, type CatalogDefinition } from "@/lib/catalogs";
import { parseOmmEpoch, type OmmRecord } from "@/lib/orbit";

export type CacheState = "hit" | "updated" | "stale" | "miss";

export type CachedGpPayload = {
  group: CatalogDefinition;
  records: OmmRecord[];
  fetchedAt: string | null;
  sourceUpdatedAt: string | null;
  stale: boolean;
  cacheState: CacheState;
  etag?: string | null;
  lastModified?: string | null;
  error?: string | null;
};

type StoredPayload = Omit<CachedGpPayload, "group" | "cacheState" | "stale"> & {
  groupId: string;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  blockedStatus: 403 | 404 | null;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type GetGpOptions = {
  fetchImpl?: FetchLike;
  cacheDir?: string;
  now?: Date;
  maxAgeMs?: number;
  timeoutMs?: number;
};

export const GP_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const memoryCache = new Map<string, StoredPayload>();
const inFlight = new Map<string, Promise<CachedGpPayload>>();
const cacheReadErrors = new Map<string, string>();

export function getCacheDirectory() {
  const configured = process.env.CELESTRAK_CACHE_DIR?.trim();
  return path.resolve(configured || path.join(process.cwd(), ".cache", "celestrak"));
}

export function cacheFileFor(groupId: string, cacheDir = getCacheDirectory()) {
  return path.resolve(cacheDir, `${groupId}.json`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumeric(value: unknown) {
  return (
    (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
    Number.isFinite(Number(value))
  );
}

function isOmmRecord(value: unknown): value is OmmRecord {
  if (!isObject(value) || typeof value.OBJECT_NAME !== "string" || typeof value.EPOCH !== "string") {
    return false;
  }
  if (!parseOmmEpoch(value.EPOCH)) return false;

  const required = [
    "NORAD_CAT_ID", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
    "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY"
  ];
  const optional = [
    "EPHEMERIS_TYPE", "ELEMENT_SET_NO", "REV_AT_EPOCH", "BSTAR",
    "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT"
  ];
  if (!required.every((key) => isNumeric(value[key]))) return false;
  if (!optional.every((key) => value[key] === undefined || isNumeric(value[key]))) return false;
  if (value.OBJECT_ID !== undefined && typeof value.OBJECT_ID !== "string") return false;
  if (value.CLASSIFICATION_TYPE !== undefined && typeof value.CLASSIFICATION_TYPE !== "string") {
    return false;
  }

  return Number.isInteger(Number(value.NORAD_CAT_ID)) && Number(value.NORAD_CAT_ID) > 0 &&
    Number(value.MEAN_MOTION) > 0 && Number(value.ECCENTRICITY) >= 0 &&
    Number(value.ECCENTRICITY) < 1;
}

function isOmmArray(value: unknown): value is OmmRecord[] {
  return Array.isArray(value) && value.every(isOmmRecord);
}

function isNullableDate(value: unknown) {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isNullableString(value: unknown) {
  return value === undefined || value === null || typeof value === "string";
}

function isNullableHeader(value: unknown) {
  return isNullableString(value) && (typeof value !== "string" || !/[\r\n\0]/.test(value));
}

function parseStoredPayload(value: unknown, groupId: string): StoredPayload | null {
  if (!isObject(value) || value.groupId !== groupId || !isOmmArray(value.records)) return null;
  if (!isNullableDate(value.fetchedAt) || !isNullableDate(value.sourceUpdatedAt)) return null;
  if (value.fetchedAt === null && value.records.length > 0) return null;
  if (![value.etag, value.lastModified].every(isNullableHeader) || !isNullableString(value.error)) {
    return null;
  }
  if (value.lastAttemptAt !== undefined && !isNullableDate(value.lastAttemptAt)) return null;
  if (value.nextRetryAt !== undefined && !isNullableDate(value.nextRetryAt)) return null;
  if (value.blockedStatus != null && value.blockedStatus !== 403 && value.blockedStatus !== 404) {
    return null;
  }

  return {
    groupId,
    records: value.records,
    fetchedAt: value.fetchedAt as string | null,
    sourceUpdatedAt: value.sourceUpdatedAt as string | null,
    etag: (value.etag as string | null) ?? null,
    lastModified: (value.lastModified as string | null) ?? null,
    error: (value.error as string | null) ?? null,
    lastAttemptAt: (value.lastAttemptAt as string | null) ?? (value.fetchedAt as string | null),
    nextRetryAt: (value.nextRetryAt as string | null) ?? null,
    blockedStatus: (value.blockedStatus as 403 | 404 | null) ?? null
  };
}

function errorCode(error: unknown) {
  return isObject(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function storedVersion(payload: StoredPayload) {
  return Date.parse(payload.lastAttemptAt ?? payload.fetchedAt ?? "") || 0;
}

export async function readCachedGp(group: CatalogDefinition, cacheDir = getCacheDirectory()) {
  const key = cacheFileFor(group.id, cacheDir);
  const memory = memoryCache.get(key);
  try {
    const raw = await readFile(key, "utf8");
    const parsed = parseStoredPayload(JSON.parse(raw), group.id);
    if (!parsed) throw new Error("Invalid cached payload");
    cacheReadErrors.delete(key);
    const cached = memory && storedVersion(memory) >= storedVersion(parsed) ? memory : parsed;
    memoryCache.set(key, cached);
    return cached;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      const message = "Stored CelesTrak cache could not be read or validated";
      if (!cacheReadErrors.has(key)) {
        console.warn("[CelesTrak] Cache read failed", { group: group.id, code: errorCode(error) });
      }
      cacheReadErrors.set(key, message);
    }
    return memory ?? null;
  }
}

async function writeCachedGp(group: CatalogDefinition, payload: StoredPayload, cacheDir: string) {
  const destination = cacheFileFor(group.id, cacheDir);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(payload), "utf8");
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") {
        console.warn("[CelesTrak] Cache cleanup failed", { group: group.id, code: errorCode(error) });
      }
    });
  }
}

async function storePayload(group: CatalogDefinition, payload: StoredPayload, cacheDir: string) {
  const key = cacheFileFor(group.id, cacheDir);
  memoryCache.set(key, payload);
  try {
    await writeCachedGp(group, payload, cacheDir);
    cacheReadErrors.delete(key);
    return payload;
  } catch (error) {
    const warning = `Cache persistence unavailable (${errorCode(error)}); using memory cache`;
    console.warn("[CelesTrak] Cache write failed", { group: group.id, code: errorCode(error) });
    const retained = { ...payload, error: payload.error ? `${payload.error}; ${warning}` : warning };
    memoryCache.set(key, retained);
    return retained;
  }
}

function isFresh(fetchedAt: string | null, now: Date, maxAgeMs: number) {
  if (!fetchedAt) return false;
  const age = now.getTime() - Date.parse(fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs;
}

function buildCelesTrakUrl(group: CatalogDefinition) {
  const params = new URLSearchParams({ [group.queryKey]: group.queryValue, FORMAT: "json" });
  return `https://celestrak.org/NORAD/elements/gp.php?${params.toString()}`;
}

function latestEpoch(records: OmmRecord[]) {
  let latest = 0;
  for (const record of records) {
    const epoch = parseOmmEpoch(record.EPOCH);
    if (epoch && epoch.getTime() > latest) latest = epoch.getTime();
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function toPublicPayload(
  group: CatalogDefinition,
  stored: StoredPayload,
  cacheState: CacheState,
  stale: boolean
): CachedGpPayload {
  return {
    group,
    records: stored.records,
    fetchedAt: stored.fetchedAt,
    sourceUpdatedAt: stored.sourceUpdatedAt,
    stale,
    cacheState,
    etag: stored.etag,
    lastModified: stored.lastModified,
    error: stored.error ?? null
  };
}

class UpstreamError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly retryAfterMs = 0) {
    super(message);
  }
}

function retryAfterMs(value: string | null, now: Date) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now.getTime()) : 0;
}

function emptySnapshot(groupId: string): StoredPayload {
  return {
    groupId, records: [], fetchedAt: null, sourceUpdatedAt: null,
    etag: null, lastModified: null, error: null,
    lastAttemptAt: null, nextRetryAt: null, blockedStatus: null
  };
}

async function loadGpGroup(group: CatalogDefinition, options: GetGpOptions, cacheDir: string) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? GP_REFRESH_INTERVAL_MS;
  const cached = await readCachedGp(group, cacheDir);

  // Cooldown and permanent rejections survive restarts, including a first-fetch miss.
  if (cached?.blockedStatus || (cached?.nextRetryAt && Date.parse(cached.nextRetryAt) > now.getTime())) {
    return toPublicPayload(group, cached, cached.fetchedAt ? "stale" : "miss", true);
  }
  if (cached && isFresh(cached.fetchedAt, now, maxAgeMs)) {
    return toPublicPayload(group, cached, "hit", false);
  }

  const headers = new Headers({ Accept: "application/json", "User-Agent": "3DSateliteExplorer/0.1" });
  if (cached?.fetchedAt && cached.etag) headers.set("If-None-Match", cached.etag);
  if (cached?.fetchedAt && cached.lastModified) headers.set("If-Modified-Since", cached.lastModified);

  try {
    const response = await fetchImpl(buildCelesTrakUrl(group), {
      headers, cache: "no-store", signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS)
    });

    if (response.status === 304 && cached?.fetchedAt) {
      const refreshed = await storePayload(group, {
        ...cached, fetchedAt: now.toISOString(), lastAttemptAt: now.toISOString(),
        etag: response.headers.get("etag") ?? cached.etag,
        lastModified: response.headers.get("last-modified") ?? cached.lastModified,
        error: null, nextRetryAt: null, blockedStatus: null
      }, cacheDir);
      return toPublicPayload(group, refreshed, "updated", false);
    }
    if (!response.ok) {
      throw new UpstreamError(`CelesTrak returned ${response.status}`, response.status,
        retryAfterMs(response.headers.get("retry-after"), now));
    }

    let records: unknown;
    try {
      records = await response.json();
    } catch {
      throw new UpstreamError("CelesTrak response was not valid JSON", response.status);
    }
    if (!isOmmArray(records)) {
      throw new UpstreamError("CelesTrak response contained invalid OMM records", response.status);
    }

    const stored = await storePayload(group, {
      groupId: group.id, records, fetchedAt: now.toISOString(), sourceUpdatedAt: latestEpoch(records),
      etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"),
      error: null, lastAttemptAt: now.toISOString(), nextRetryAt: null, blockedStatus: null
    }, cacheDir);
    return toPublicPayload(group, stored, "updated", false);
  } catch (error) {
    const failure = error instanceof UpstreamError ? error : new UpstreamError(
      error instanceof Error && error.name === "TimeoutError"
        ? "CelesTrak request timed out" : "Unable to fetch CelesTrak data"
    );
    const blockedStatus = failure.status === 403 || failure.status === 404 ? failure.status : null;
    const cooldown = Math.max(FAILURE_COOLDOWN_MS, failure.retryAfterMs);
    console.warn("[CelesTrak] Refresh failed", { group: group.id, status: failure.status });
    const failed = await storePayload(group, {
      ...(cached ?? emptySnapshot(group.id)),
      error: failure.message, lastAttemptAt: now.toISOString(), blockedStatus,
      nextRetryAt: blockedStatus ? null : new Date(now.getTime() + cooldown).toISOString()
    }, cacheDir);
    return toPublicPayload(group, failed, failed.fetchedAt ? "stale" : "miss", true);
  }
}

export async function getGpGroup(group: CatalogDefinition, options: GetGpOptions = {}): Promise<CachedGpPayload> {
  const cacheDir = options.cacheDir ?? getCacheDirectory();
  const key = cacheFileFor(group.id, cacheDir);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = loadGpGroup(group, options, cacheDir);
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}

export async function getCatalogSummaries(cacheDir = getCacheDirectory()) {
  return Promise.all(CATALOGS.map(async (group) => {
    const cached = await readCachedGp(group, cacheDir);
    return {
      ...group,
      cachedCount: cached?.records.length ?? 0,
      fetchedAt: cached?.fetchedAt ?? null,
      sourceUpdatedAt: cached?.sourceUpdatedAt ?? null,
      stale: !isFresh(cached?.fetchedAt ?? null, new Date(), GP_REFRESH_INTERVAL_MS),
      error: cached?.error ?? cacheReadErrors.get(cacheFileFor(group.id, cacheDir)) ?? null,
      lastAttemptAt: cached?.lastAttemptAt ?? null,
      nextRetryAt: cached?.nextRetryAt ?? null,
      blockedStatus: cached?.blockedStatus ?? null
    };
  }));
}
