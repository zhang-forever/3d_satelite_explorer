import type { CatalogDefinition } from "@/lib/data/catalogs";
import type { ObjectClass, OmmRecord } from "@/lib/orbit";

/** Catalog metadata as returned by `/api/catalogs`, merged with the static list. */
export type CatalogSummary = CatalogDefinition & {
  cachedCount: number;
  fetchedAt: string | null;
  checkedAt?: string | null;
  sourceUpdatedAt: string | null;
  stale: boolean;
  error: string | null;
};

/** A catalog whose records have been fetched and are part of the scene. */
export type LoadedGroup = {
  catalog: CatalogDefinition;
  records: OmmRecord[];
  fetchedAt: string | null;
  checkedAt?: string | null;
  sourceUpdatedAt: string | null;
  stale: boolean;
  cacheState: string;
  error: string | null;
};

/** Everything the renderer needs about an object but that never changes. */
export type RecordMeta = {
  id: string;
  name: string;
  objectId: string | null;
  noradId: string;
  epoch: string;
  objectType: ObjectClass;
  groupId: string;
};

/** A catalog record row tagged with where it was loaded from. */
export type IndexedRecord = {
  groupId: string;
  record: OmmRecord;
  catalog: CatalogDefinition;
};

/** Typed-array reply from the propagation worker. */
export type PropagationSnapshot = {
  requestId: number;
  version: number;
  atMs: number;
  scene: Float32Array;
  ecf: Float32Array;
  geo: Float32Array;
  speed: Float32Array;
  flags: Uint8Array;
};

export type CollapsiblePanelId =
  | "catalogs"
  | "filters"
  | "analysis"
  | "selected"
  | "status"
  | "watchlist";

export type AnalysisTab = "rendezvous" | "passes";
