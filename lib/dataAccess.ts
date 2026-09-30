import { CATALOGS } from "@/lib/catalogs";

export const IS_SNAPSHOT_MODE = process.env.NEXT_PUBLIC_DATA_MODE === "snapshot";

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
