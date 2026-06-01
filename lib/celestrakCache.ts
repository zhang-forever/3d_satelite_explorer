import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CATALOGS, CatalogDefinition } from "@/lib/catalogs";
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
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_CACHE_DIR = path.join(process.cwd(), ".cache", "celestrak");
const DEFAULT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export function cacheFileFor(groupId: string, cacheDir = DEFAULT_CACHE_DIR) {
  return path.join(cacheDir, `${groupId}.json`);
}

export async function readCachedGp(group: CatalogDefinition, cacheDir = DEFAULT_CACHE_DIR) {
  try {
    const raw = await readFile(cacheFileFor(group.id, cacheDir), "utf8");
    const parsed = JSON.parse(raw) as StoredPayload;
    return parsed.groupId === group.id ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCachedGp(
  group: CatalogDefinition,
  payload: StoredPayload,
  cacheDir = DEFAULT_CACHE_DIR
) {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFileFor(group.id, cacheDir), JSON.stringify(payload, null, 2), "utf8");
}

function isFresh(fetchedAt: string | null, now: Date, maxAgeMs: number) {
  if (!fetchedAt) return false;
  const age = now.getTime() - new Date(fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs;
}

function buildCelesTrakUrl(group: CatalogDefinition) {
  const params = new URLSearchParams({
    [group.queryKey]: group.queryValue,
    FORMAT: "json"
  });
  return `https://celestrak.org/NORAD/elements/gp.php?${params.toString()}`;
}

function latestEpoch(records: OmmRecord[]) {
  let latest = 0;
  for (const record of records) {
    const epoch = parseOmmEpoch(String(record.EPOCH ?? ""));
    if (epoch && epoch.getTime() > latest) latest = epoch.getTime();
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function toPublicPayload(
  group: CatalogDefinition,
  stored: StoredPayload,
  cacheState: CacheState,
  stale: boolean,
  error?: string | null
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
    error: error ?? stored.error ?? null
  };
}

export async function getGpGroup(
  group: CatalogDefinition,
  options: {
    fetchImpl?: FetchLike;
    cacheDir?: string;
    now?: Date;
    maxAgeMs?: number;
  } = {}
): Promise<CachedGpPayload> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cached = await readCachedGp(group, cacheDir);

  if (cached && isFresh(cached.fetchedAt, now, maxAgeMs)) {
    return toPublicPayload(group, cached, "hit", false);
  }

  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": "3DSateliteExplorer/0.1 (+local development)"
  });
  if (cached?.etag) headers.set("If-None-Match", cached.etag);
  if (cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);

  try {
    const response = await fetchImpl(buildCelesTrakUrl(group), {
      headers,
      cache: "no-store"
    });

    if (response.status === 304 && cached) {
      const refreshed = { ...cached, fetchedAt: now.toISOString(), error: null };
      await writeCachedGp(group, refreshed, cacheDir);
      return toPublicPayload(group, refreshed, "updated", false);
    }

    if (!response.ok) {
      const message = `CelesTrak returned ${response.status}`;
      if (cached) return toPublicPayload(group, cached, "stale", true, message);
      return toPublicPayload(
        group,
        {
          groupId: group.id,
          records: [],
          fetchedAt: null,
          sourceUpdatedAt: null,
          etag: null,
          lastModified: null,
          error: message
        },
        "miss",
        true,
        message
      );
    }

    const records = (await response.json()) as OmmRecord[];
    if (!Array.isArray(records)) {
      throw new Error("CelesTrak response was not an OMM JSON array");
    }

    const stored: StoredPayload = {
      groupId: group.id,
      records,
      fetchedAt: now.toISOString(),
      sourceUpdatedAt: latestEpoch(records),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      error: null
    };
    await writeCachedGp(group, stored, cacheDir);
    return toPublicPayload(group, stored, "updated", false);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch CelesTrak data";
    if (cached) return toPublicPayload(group, cached, "stale", true, message);
    return toPublicPayload(
      group,
      {
        groupId: group.id,
        records: [],
        fetchedAt: null,
        sourceUpdatedAt: null,
        etag: null,
        lastModified: null,
        error: message
      },
      "miss",
      true,
      message
    );
  }
}

export async function getCatalogSummaries(cacheDir = DEFAULT_CACHE_DIR) {
  return Promise.all(
    CATALOGS.map(async (group) => {
      const cached = await readCachedGp(group, cacheDir);
      return {
        ...group,
        cachedCount: cached?.records.length ?? 0,
        fetchedAt: cached?.fetchedAt ?? null,
        sourceUpdatedAt: cached?.sourceUpdatedAt ?? null,
        stale: cached?.fetchedAt
          ? !isFresh(cached.fetchedAt, new Date(), DEFAULT_MAX_AGE_MS)
          : true,
        error: cached?.error ?? null
      };
    })
  );
}
