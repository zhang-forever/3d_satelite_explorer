import { CATALOGS } from "@/lib/catalogs";

export const IS_SNAPSHOT_MODE = process.env.NEXT_PUBLIC_DATA_MODE === "snapshot";

/** Published freshness flags cannot age themselves while a static site is idle. */
export function snapshotIsStale(snapshot: {
  fetchedAt: string | null;
  checkedAt?: string | null;
  stale: boolean;
  error?: string | null;
}, nowMs: number) {
  const timestamp = Date.parse(snapshot.checkedAt ?? snapshot.fetchedAt ?? "");
  const age = nowMs - timestamp;
  return snapshot.stale || Boolean(snapshot.error) || !Number.isFinite(age) ||
    age < 0 || age >= 4 * 60 * 60 * 1000;
}

const configuredBasePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").trim().replace(/\/+$/, "");
const basePath = configuredBasePath && !configuredBasePath.startsWith("/")
  ? `/${configuredBasePath}` : configuredBasePath;

const snapshotGroupIds = new Set(
  (process.env.NEXT_PUBLIC_SNAPSHOT_GROUPS ?? "active,stations")
    .split(",").map((id) => id.trim()).filter(Boolean)
);

/** A static export only advertises groups included in its published snapshot. */
export const AVAILABLE_CATALOGS = IS_SNAPSHOT_MODE
  ? CATALOGS.filter((catalog) => snapshotGroupIds.has(catalog.id)) : CATALOGS;

export function publicAssetUrl(path: string) {
  return `${basePath}/${path.replace(/^\/+/, "")}`;
}

export function catalogsDataUrl() {
  return publicAssetUrl(IS_SNAPSHOT_MODE ? "/data/catalogs.json" : "/api/catalogs");
}

export function groupDataUrl(groupId: string) {
  if (!AVAILABLE_CATALOGS.some((catalog) => catalog.id === groupId)) {
    throw new Error(`Catalog is unavailable in this release: ${groupId}`);
  }
  return IS_SNAPSHOT_MODE
    ? publicAssetUrl(`/data/gp/${encodeURIComponent(groupId)}.json`)
    : publicAssetUrl(`/api/gp?group=${encodeURIComponent(groupId)}`);
}
