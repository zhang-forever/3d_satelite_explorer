"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  Download,
  HelpCircle,
  Languages,
  Layers,
  Loader2,
  LocateFixed,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Radar,
  RefreshCw,
  RotateCw,
  Camera,
  Satellite,
  Search,
  SlidersHorizontal,
  Star,
  StarOff,
  Telescope
} from "lucide-react";
import GlobeScene, { GlobeSceneHandle } from "@/components/GlobeScene";
import { CatalogDefinition } from "@/lib/catalogs";
import { AVAILABLE_CATALOGS, IS_SNAPSHOT_MODE, catalogsDataUrl, groupDataUrl, snapshotIsStale } from "@/lib/dataAccess";
import { formatDateTime, formatDateTimeShort, formatNumber } from "@/lib/format";
import { copy, initialLocale, Locale } from "@/lib/i18n";
import {
  dataAgeHours,
  dedupeByNorad,
  objectClass,
  ObjectClass,
  OBJECT_CLASS_COLORS,
  OmmRecord,
  parseOmmEpoch,
  PROPAGATION_SHADOW,
  PROPAGATION_VALID,
  PropagatedObject,
  quantizeDown,
  RendezvousScanHit,
  sampleOrbitTrack
} from "@/lib/orbit";
import { azimuthToCompass, predictPasses } from "@/lib/passes";

type CatalogSummary = CatalogDefinition & {
  cachedCount: number;
  fetchedAt: string | null;
  checkedAt?: string | null;
  sourceUpdatedAt: string | null;
  stale: boolean;
  error: string | null;
};

type LoadedGroup = {
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
type RecordMeta = {
  id: string;
  name: string;
  objectId: string | null;
  noradId: string;
  epoch: string;
  objectType: ObjectClass;
  groupId: string;
};

type PropagationSnapshot = {
  requestId: number;
  version: number;
  atMs: number;
  scene: Float32Array;
  ecf: Float32Array;
  geo: Float32Array;
  speed: Float32Array;
  flags: Uint8Array;
};

type CollapsiblePanelId = "catalogs" | "filters" | "analysis" | "selected" | "status" | "watchlist";
type AnalysisTab = "rendezvous" | "passes";

const RENDER_LIMIT = 16000;
const SPEEDS = [0, 1, 10, 60, 600];
const CATALOG_SHORTCUT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "q", "w", "e", "r", "t", "y", "u"];

// localStorage keys for the persisted UI preferences.
const WATCHLIST_KEY = "orbital-field:watchlist";
const LOCALE_KEY = "orbital-field:locale";
const LEFT_RAIL_KEY = "orbital-field:left-rail";
const RIGHT_RAIL_KEY = "orbital-field:right-rail";
const PANELS_KEY = "orbital-field:panels";
const AUTO_ROTATE_KEY = "orbital-field:auto-rotate";
const CLASS_FILTER_KEY = "orbital-field:class-filter";
const SHOW_DEBRIS_KEY = "orbital-field:show-debris";

// Derived-work cadence. The scene clock ticks at 1 Hz, but neither the full
// 48 h pass list nor a freshly sampled orbit needs recomputing that often —
// they only care about the minute / few seconds respectively.
const TRACK_TICK_MS = 5_000;
const PASSES_TICK_MS = 60_000;
const DATA_REQUEST_TIMEOUT_MS = 30_000;

function isApiObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readApiResponse(response: Response) {
  const payload: unknown = await response.json();
  if (!isApiObject(payload)) throw new Error("Invalid data response");
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`);
  }
  return payload;
}

function isOmmRecord(value: unknown): value is OmmRecord {
  if (!isApiObject(value) || typeof value.OBJECT_NAME !== "string" ||
      typeof value.EPOCH !== "string" || !parseOmmEpoch(value.EPOCH)) return false;
  return ["NORAD_CAT_ID", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER", "MEAN_ANOMALY"].every((key) =>
    (typeof value[key] === "number" || typeof value[key] === "string") &&
    value[key] !== "" && Number.isFinite(Number(value[key])));
}

function fallbackCatalogs(): CatalogSummary[] {
  return AVAILABLE_CATALOGS.map((catalog) => ({
    ...catalog, cachedCount: 0, fetchedAt: null, sourceUpdatedAt: null, stale: true, error: null
  }));
}

const DEFAULT_COLLAPSED_PANELS: Record<CollapsiblePanelId, boolean> = {
  catalogs: false,
  filters: false,
  analysis: false,
  selected: false,
  status: true,
  watchlist: false
};

/** Stable references required as `usePersistentState` defaults. */
const EMPTY_WATCHLIST: string[] = [];

const LEGEND_CLASSES: ObjectClass[] = ["payload", "debris", "rocket", "unknown"];

// ---- persisted preferences ----------------------------------------------
// A tiny localStorage-backed store exposed through `useSyncExternalStore`.
// Reading storage during an effect and calling setState would trigger a second
// render pass on mount (and React flags it); going through an external store
// lets React reconcile the server snapshot with the stored value in one go.

type PreferenceListener = () => void;

const preferenceListeners = new Map<string, Set<PreferenceListener>>();
const preferenceCache = new Map<string, unknown>();

function readPreference<T>(key: string, fallback: T): T {
  if (preferenceCache.has(key)) return preferenceCache.get(key) as T;
  if (typeof window === "undefined") return fallback;
  let value = fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) value = JSON.parse(raw) as T;
  } catch {
    // ignore corrupt or unavailable storage
  }
  preferenceCache.set(key, value);
  return value;
}

function subscribePreference(key: string, listener: PreferenceListener) {
  let bucket = preferenceListeners.get(key);
  if (!bucket) {
    bucket = new Set();
    preferenceListeners.set(key, bucket);
  }
  bucket.add(listener);
  return () => {
    bucket.delete(listener);
  };
}

function writePreference<T>(key: string, value: T) {
  preferenceCache.set(key, value);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage may be full or disabled
    }
  }
  preferenceListeners.get(key)?.forEach((listener) => listener());
}

/**
 * State that survives a reload.
 *
 * `serverValue` is what the server renders *and* what hydration expects, so it
 * must not depend on the browser (use "zh", not the detected language).
 * `clientValue` is the fallback used once running in the browser when nothing
 * was stored yet — pass a primitive only, it is part of the snapshot identity.
 */
function usePersistentState<T>(key: string, serverValue: T, clientValue?: T) {
  const fallback = clientValue === undefined ? serverValue : clientValue;
  const getSnapshot = useCallback(() => readPreference(key, fallback), [key, fallback]);
  const getServerSnapshot = useCallback(() => serverValue, [serverValue]);
  const subscribe = useCallback(
    (listener: PreferenceListener) => subscribePreference(key, listener),
    [key]
  );

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setValue = useCallback(
    (next: T | ((current: T) => T)) => {
      const current = readPreference(key, fallback);
      writePreference(key, typeof next === "function" ? (next as (input: T) => T)(current) : next);
    },
    [key, fallback]
  );

  return [value, setValue] as const;
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

export default function SatelliteExplorer() {
  // "zh" is the SSR/hydration snapshot; the browser language is only used as a
  // client-side fallback once running, and a stored choice always wins.
  const [locale, setLocale] = usePersistentState<Locale>(LOCALE_KEY, "zh", initialLocale());
  const t = copy[locale];
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>(fallbackCatalogs);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loadedGroups, setLoadedGroups] = useState<Record<string, LoadedGroup>>({});
  const [loadingGroups, setLoadingGroups] = useState<Record<string, boolean>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = usePersistentState<
    "all" | "payload" | "debris" | "rocket" | "unknown"
  >(CLASS_FILTER_KEY, "all");
  const [showDebris, setShowDebris] = usePersistentState(SHOW_DEBRIS_KEY, true);
  const [altitudeMin, setAltitudeMin] = useState(0);
  const [altitudeMax, setAltitudeMax] = useState(42000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sceneTime, setSceneTime] = useState(() => new Date());
  const [dataNowMs, setDataNowMs] = useState(() => Date.now());
  const [isPlaying, setIsPlaying] = useState(true);
  const [speedIndex, setSpeedIndex] = useState(1);
  const [autoRotate, setAutoRotate] = usePersistentState(AUTO_ROTATE_KEY, true);
  const [leftRailCollapsed, setLeftRailCollapsed] = usePersistentState(LEFT_RAIL_KEY, false);
  const [rightRailCollapsed, setRightRailCollapsed] = usePersistentState(RIGHT_RAIL_KEY, false);
  const [collapsedPanels, setCollapsedPanels] = usePersistentState<Record<CollapsiblePanelId, boolean>>(
    PANELS_KEY,
    DEFAULT_COLLAPSED_PANELS
  );
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>("rendezvous");
  const [primaryQuery, setPrimaryQuery] = useState("");
  const [rendezvousWindowHours, setRendezvousWindowHours] = useState(24);
  const [rendezvousMaxMissKm, setRendezvousMaxMissKm] = useState(50);
  const [rendezvousHits, setRendezvousHits] = useState<RendezvousScanHit[]>([]);
  const [rendezvousScanning, setRendezvousScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanAnchor, setScanAnchor] = useState<Date | null>(null);
  const [scanNonce, setScanNonce] = useState(0);
  const [expandedHitKey, setExpandedHitKey] = useState<string | null>(null);
  const [observerLat, setObserverLat] = useState<number>(40.0);
  const [observerLon, setObserverLon] = useState<number>(116.4);
  const [minElevationDeg, setMinElevationDeg] = useState(10);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [workerObjects, setWorkerObjects] = useState<PropagatedObject[]>([]);
  const [propagationError, setPropagationError] = useState<string | null>(null);
  const [workerNonce, setWorkerNonce] = useState(0);
  const [watchlist, setWatchlist] = usePersistentState<string[]>(WATCHLIST_KEY, EMPTY_WATCHLIST);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const globeRef = useRef<GlobeSceneHandle>(null);
  const workerRef = useRef<Worker | null>(null);
  // Scans run on their own worker: a 16k-object close-approach sweep takes
  // seconds, and sharing a thread with propagation would freeze the globe.
  const scanWorkerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const latestRequestIdRef = useRef(0);
  const scanRequestIdRef = useRef(0);
  const recordsVersionRef = useRef(0);
  const loadedGroupsRef = useRef<Record<string, LoadedGroup>>({});
  const groupRequestsRef = useRef(new Map<string, AbortController>());
  const objectPoolRef = useRef<PropagatedObject[]>([]);
  const recordMetaRef = useRef<RecordMeta[]>([]);
  const sceneTimeRef = useRef(sceneTime);

  useEffect(() => {
    sceneTimeRef.current = sceneTime;
  }, [sceneTime]);

  useEffect(() => {
    if (!IS_SNAPSHOT_MODE) return;
    // Data age follows wall time, including while simulation playback is paused.
    const update = () => setDataNowMs(Date.now());
    const interval = window.setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DATA_REQUEST_TIMEOUT_MS);
    fetch(catalogsDataUrl(), { signal: controller.signal })
      .then(readApiResponse)
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(payload.catalogs) || !payload.catalogs.every((catalog) =>
          isApiObject(catalog) && AVAILABLE_CATALOGS.some((known) => known.id === catalog.id) &&
          typeof catalog.cachedCount === "number" && Number.isFinite(catalog.cachedCount) &&
          typeof catalog.stale === "boolean")) throw new Error("Invalid catalog response");
        const summaries = payload.catalogs as CatalogSummary[];
        setCatalogs(fallbackCatalogs().map((known) => {
          const summary = summaries.find((catalog) => catalog.id === known.id);
          return summary ? { ...known, cachedCount: summary.cachedCount,
            fetchedAt: typeof summary.fetchedAt === "string" ? summary.fetchedAt : null,
            checkedAt: typeof summary.checkedAt === "string" ? summary.checkedAt : null,
            sourceUpdatedAt: typeof summary.sourceUpdatedAt === "string" ? summary.sourceUpdatedAt : null,
            stale: summary.stale, error: typeof summary.error === "string" ? summary.error : null } : known;
        }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted && !timedOut) return;
        setCatalogError(timedOut ? "Catalog request timed out" : error instanceof Error ? error.message : "Unable to load catalogs");
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const toggleWatchlist = (id: string) => {
    setWatchlist((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const exportSelectedOmm = () => {
    if (typeof window === "undefined") return;
    if (!selectedRecord) return;
    const blob = new Blob([JSON.stringify(selectedRecord.record, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const safeName = selectedRecord.record.OBJECT_NAME.replace(/[^a-z0-9_-]+/gi, "_");
    link.download = `${safeName}-${selectedRecord.record.NORAD_CAT_ID}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const loadGroup = async (groupId: string, force = false) => {
    if (groupRequestsRef.current.has(groupId)) return;
    if (!force && loadedGroupsRef.current[groupId]) return;
    const catalog = AVAILABLE_CATALOGS.find((item) => item.id === groupId);
    if (!catalog) return;
    const controller = new AbortController();
    groupRequestsRef.current.set(groupId, controller);
    const isCurrentRequest = () => groupRequestsRef.current.get(groupId) === controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DATA_REQUEST_TIMEOUT_MS);
    setLoadingGroups((current) => ({ ...current, [groupId]: true }));
    setLoadErrors((current) => {
      const next = { ...current };
      delete next[groupId];
      return next;
    });
    try {
      const response = await fetch(groupDataUrl(groupId), { signal: controller.signal });
      const payload = await readApiResponse(response);
      if (!isCurrentRequest() || controller.signal.aborted) return;
      if (!isApiObject(payload.group) || payload.group.id !== groupId ||
          !Array.isArray(payload.records) || !payload.records.every(isOmmRecord)) {
        throw new Error("Invalid GP catalog response");
      }
      loadedGroupsRef.current = {
        ...loadedGroupsRef.current,
        [groupId]: {
          catalog,
          records: payload.records,
          fetchedAt: typeof payload.fetchedAt === "string" ? payload.fetchedAt : null,
          checkedAt: typeof payload.checkedAt === "string" ? payload.checkedAt : null,
          sourceUpdatedAt: typeof payload.sourceUpdatedAt === "string" ? payload.sourceUpdatedAt : null,
          stale: Boolean(payload.stale),
          cacheState: typeof payload.cacheState === "string" ? payload.cacheState : "miss",
          error: typeof payload.error === "string" ? payload.error : null
        }
      };
      setLoadedGroups(loadedGroupsRef.current);
      setCatalogs((current) =>
        current.map((catalog) =>
          catalog.id === groupId
            ? {
                ...catalog,
                cachedCount: (payload.records as OmmRecord[]).length,
                fetchedAt: typeof payload.fetchedAt === "string" ? payload.fetchedAt : catalog.fetchedAt,
                checkedAt: typeof payload.checkedAt === "string" ? payload.checkedAt : null,
                sourceUpdatedAt: typeof payload.sourceUpdatedAt === "string" ? payload.sourceUpdatedAt : catalog.sourceUpdatedAt,
                stale: Boolean(payload.stale),
                error: typeof payload.error === "string" ? payload.error : null
              }
            : catalog
        )
      );
    } catch (error) {
      if (!isCurrentRequest() || (controller.signal.aborted && !timedOut)) return;
      setLoadErrors((current) => ({
        ...current,
        [groupId]: timedOut ? "Data request timed out" : error instanceof Error ? error.message : "Unable to load catalog"
      }));
    } finally {
      window.clearTimeout(timeout);
      if (isCurrentRequest()) {
        groupRequestsRef.current.delete(groupId);
        setLoadingGroups((current) => ({ ...current, [groupId]: false }));
      }
    }
  };

  const unloadGroup = (groupId: string) => {
    groupRequestsRef.current.get(groupId)?.abort();
    groupRequestsRef.current.delete(groupId);
    const next = { ...loadedGroupsRef.current };
    delete next[groupId];
    loadedGroupsRef.current = next;
    setLoadedGroups(next);
    setLoadingGroups((current) => ({ ...current, [groupId]: false }));
    setLoadErrors((current) => {
      if (!current[groupId]) return current;
      const next = { ...current };
      delete next[groupId];
      return next;
    });
  };

  const toggleGroup = (groupId: string) => {
    if (loadingGroups[groupId]) return;
    if (loadedGroups[groupId]) {
      unloadGroup(groupId);
    } else {
      void loadGroup(groupId);
    }
  };

  useEffect(() => {
    const requests = groupRequestsRef.current;
    const defaults = AVAILABLE_CATALOGS.filter((item) => item.defaultSelected);
    for (const catalog of defaults.length ? defaults : AVAILABLE_CATALOGS.slice(0, 1)) {
      void loadGroup(catalog.id);
    }
    return () => {
      for (const controller of requests.values()) controller.abort();
      requests.clear();
    };
  }, []);

  useEffect(() => {
    if (!isPlaying || SPEEDS[speedIndex] === 0) return;
    let last = performance.now();
    const interval = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - last;
      last = now;
      setSceneTime((current) => new Date(current.getTime() + elapsed * SPEEDS[speedIndex]));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isPlaying, speedIndex]);

  const indexedRecords = useMemo(() => {
    const rows: Array<{ groupId: string; record: OmmRecord; catalog: CatalogDefinition }> = [];
    // Walk the available catalogs rather than key order so the group that
    // "wins" a duplicated NORAD id is deterministic regardless of the order in
    // which the groups finished loading.
    for (const catalog of AVAILABLE_CATALOGS) {
      const loaded = loadedGroups[catalog.id];
      if (!loaded) continue;
      for (const record of loaded.records) {
        rows.push({ groupId: catalog.id, record, catalog });
      }
    }
    return dedupeByNorad(rows);
  }, [loadedGroups]);

  // Static per-object description, in exactly the same order as the record set
  // handed to the workers — the propagation snapshot is indexed against it.
  const recordMeta = useMemo<RecordMeta[]>(
    () =>
      indexedRecords.map((row) => {
        const noradId = String(row.record.NORAD_CAT_ID);
        return {
          id: noradId,
          name: row.record.OBJECT_NAME,
          objectId: row.record.OBJECT_ID ?? null,
          noradId,
          epoch: row.record.EPOCH,
          objectType: objectClass(row.record),
          groupId: row.groupId
        };
      }),
    [indexedRecords]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    /**
     * Turn a flat typed-array snapshot into the object list the UI consumes.
     * Objects are reused between ticks; only the returned array identity
     * changes, which is all React needs to observe the update.
     */
    const applySnapshot = (snapshot: PropagationSnapshot): PropagatedObject[] => {
      const meta = recordMetaRef.current;
      const pool = objectPoolRef.current;
      const { scene, ecf, geo, speed, flags } = snapshot;
      const total = flags.length;
      let used = 0;

      for (let i = 0; i < total; i += 1) {
        if ((flags[i] & PROPAGATION_VALID) === 0) continue;
        const info = meta[i];
        if (!info) continue;
        const i3 = i * 3;

        let object = pool[used];
        if (!object) {
          object = {
            id: info.id,
            name: info.name,
            objectId: info.objectId,
            noradId: info.noradId,
            epoch: info.epoch,
            latitude: 0,
            longitude: 0,
            altitudeKm: 0,
            speedKmS: 0,
            positionKm: { x: 0, y: 0, z: 0 },
            scene: { x: 0, y: 0, z: 0 },
            error: null,
            objectType: info.objectType,
            groupId: info.groupId,
            inShadow: false
          };
          pool[used] = object;
        }

        object.id = info.id;
        object.name = info.name;
        object.objectId = info.objectId;
        object.noradId = info.noradId;
        object.epoch = info.epoch;
        object.objectType = info.objectType;
        object.groupId = info.groupId;
        object.latitude = geo[i3];
        object.longitude = geo[i3 + 1];
        object.altitudeKm = geo[i3 + 2];
        object.speedKmS = speed[i];
        object.scene.x = scene[i3];
        object.scene.y = scene[i3 + 1];
        object.scene.z = scene[i3 + 2];
        object.positionKm.x = ecf[i3];
        object.positionKm.y = ecf[i3 + 1];
        object.positionKm.z = ecf[i3 + 2];
        object.inShadow = (flags[i] & PROPAGATION_SHADOW) !== 0;
        used += 1;
      }

      return pool.slice(0, used);
    };

    // Orbital propagation keeps ticking every second; the rendezvous sweep runs
    // on its own worker because a full 16k-object scan takes seconds and would
    // otherwise stall the globe for that whole time.
    let propagateWorker: Worker;
    try {
      propagateWorker = new Worker(new URL("@/lib/propagationWorker.ts", import.meta.url), {
        type: "module"
      });
    } catch (error) {
      setPropagationError(error instanceof Error ? error.message : "Unable to start orbital worker");
      return;
    }
    const failPropagation = (message: string) => {
      if (workerRef.current !== propagateWorker) return;
      propagateWorker.terminate();
      workerRef.current = null;
      setPropagationError(message);
    };
    propagateWorker.onerror = (event) => {
      event.preventDefault();
      failPropagation(event.message || "Orbital worker failed");
    };
    propagateWorker.onmessageerror = () => failPropagation("Invalid orbital worker message");
    propagateWorker.onmessage = (event: MessageEvent) => {
      const msg = event.data as ({ type: "propagated" } & PropagationSnapshot) |
        { type: "workerError"; message: string };
      if (msg.type === "workerError") {
        failPropagation(msg.message);
        return;
      }
      if (msg.type !== "propagated") return;
      if (msg.requestId < latestRequestIdRef.current) return;
      // Snapshots are indexed into the worker's copy of the record set — drop
      // any reply that belongs to a set we have already replaced.
      if (msg.version !== recordsVersionRef.current) return;
      latestRequestIdRef.current = msg.requestId;
      setWorkerObjects(applySnapshot(msg));
    };

    workerRef.current = propagateWorker;

    return () => {
      propagateWorker.terminate();
      if (workerRef.current === propagateWorker) workerRef.current = null;
    };
  }, [workerNonce]);

  useEffect(() => {
    recordMetaRef.current = recordMeta;
    const propagateWorker = workerRef.current;
    if (!propagateWorker) return;

    const version = recordsVersionRef.current + 1;
    recordsVersionRef.current = version;
    const records = indexedRecords.map((row) => ({ groupId: row.groupId, record: row.record }));
    propagateWorker.postMessage({ type: "setRecords", version, records });
  }, [indexedRecords, recordMeta, workerNonce]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const requestId = ++requestIdRef.current;
    worker.postMessage({
      type: "propagate",
      requestId,
      version: recordsVersionRef.current,
      atMs: sceneTime.getTime()
    });
  }, [sceneTime, recordMeta, workerNonce]);

  const debrisGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const catalog of AVAILABLE_CATALOGS) {
      if (catalog.includesDebris) ids.add(catalog.id);
    }
    return ids;
  }, []);

  const propagated = useMemo(() => {
    const needle = normalizeText(query);
    const rows: PropagatedObject[] = [];

    for (const object of workerObjects) {
      if (needle) {
        const haystack = `${object.name} ${object.noradId} ${object.objectId ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      if (!showDebris && (object.objectType === "debris" || debrisGroupIds.has(object.groupId)))
        continue;
      if (classFilter !== "all" && object.objectType !== classFilter) continue;
      if (object.altitudeKm < altitudeMin || object.altitudeKm > altitudeMax) continue;
      rows.push(object);
      if (rows.length >= RENDER_LIMIT) break;
    }

    return rows;
  }, [altitudeMax, altitudeMin, classFilter, debrisGroupIds, query, showDebris, workerObjects]);

  const recordByNorad = useMemo(() => {
    const map = new Map<string, { groupId: string; record: OmmRecord; catalog: CatalogDefinition }>();
    for (const row of indexedRecords) map.set(String(row.record.NORAD_CAT_ID), row);
    return map;
  }, [indexedRecords]);

  const selectedRecord = useMemo(
    () => (selectedId ? recordByNorad.get(selectedId) ?? null : null),
    [recordByNorad, selectedId]
  );

  const primaryCandidates = useMemo(() => {
    const needle = normalizeText(primaryQuery);
    if (!needle) return [];
    const matches: Array<{ groupId: string; record: OmmRecord }> = [];
    for (const row of indexedRecords) {
      const haystack = `${row.record.OBJECT_NAME} ${row.record.NORAD_CAT_ID} ${row.record.OBJECT_ID ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push(row);
      if (matches.length >= 8) break;
    }
    return matches;
  }, [indexedRecords, primaryQuery]);

  const selectedObject = useMemo(
    () => propagated.find((object) => object.id === selectedId) ?? null,
    [propagated, selectedId]
  );

  const watchlistObjects = useMemo(() => {
    if (!watchlist.length) return [];
    const map = new Map<string, PropagatedObject>();
    for (const obj of workerObjects) {
      if (watchlist.includes(obj.id)) map.set(obj.id, obj);
    }
    return watchlist.map((id) => map.get(id) ?? null);
  }, [watchlist, workerObjects]);

  // Anchors snapped to a fixed grid: the expensive kinematics below only
  // recompute when the grid step is crossed, not on every 1 Hz clock tick.
  const trackAnchorMs = quantizeDown(sceneTime.getTime(), TRACK_TICK_MS);
  const passesAnchorMs = quantizeDown(sceneTime.getTime(), PASSES_TICK_MS);

  const selectedTrack = useMemo(() => {
    if (!selectedRecord) return [];
    return sampleOrbitTrack(selectedRecord.record, new Date(trackAnchorMs), selectedRecord.groupId);
  }, [selectedRecord, trackAnchorMs]);

  const passesVisible = !leftRailCollapsed && !collapsedPanels.analysis && analysisTab === "passes";
  const passes = useMemo(() => {
    // A 48 h sweep is only useful while its results are visible. In particular,
    // accelerated playback crosses the scene-time minute grid every real tick.
    if (!passesVisible || !selectedRecord) return [];
    return predictPasses(
      selectedRecord.record,
      { latitudeDeg: observerLat, longitudeDeg: observerLon },
      new Date(passesAnchorMs),
      { windowHours: 48, minElevationDeg, maxResults: 6 }
    );
  }, [minElevationDeg, observerLat, observerLon, passesAnchorMs, passesVisible, selectedRecord]);

  const requestLocation = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocationError(t.locationUnavailable);
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setObserverLat(Number(position.coords.latitude.toFixed(4)));
        setObserverLon(Number(position.coords.longitude.toFixed(4)));
        setLocating(false);
      },
      () => {
        setLocationError(t.locationUnavailable);
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  };

  // The sweep is anchored to the scene time captured when it starts, so it is
  // driven by the selection / settings / explicit re-scan — never by the clock.
  useEffect(() => {
    const requestId = ++scanRequestIdRef.current;
    setRendezvousHits([]);
    setScanError(null);
    if (!selectedRecord) {
      setRendezvousScanning(false);
      setScanProgress(0);
      setScanAnchor(null);
      return;
    }
    // A synchronous scan cannot process cancellation messages. Replacing its
    // worker cancels obsolete work immediately instead of queuing more scans.
    let worker: Worker;
    try {
      worker = new Worker(new URL("@/lib/propagationWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "Unable to start scan worker");
      setRendezvousScanning(false);
      return;
    }
    scanWorkerRef.current = worker;
    const isCurrentScan = () => scanWorkerRef.current === worker && scanRequestIdRef.current === requestId;
    const failScan = (message: string) => {
      if (!isCurrentScan()) return;
      worker.terminate();
      scanWorkerRef.current = null;
      setScanError(message);
      setRendezvousScanning(false);
      setScanProgress(0);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      failScan(event.message || "Scan worker failed");
    };
    worker.onmessageerror = () => failScan("Invalid scan worker message");
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: "scanProgress"; requestId: number; done: number; total: number }
        | { type: "rendezvousScan"; requestId: number; atMs: number; hits: RendezvousScanHit[] }
        | { type: "workerError"; requestId: number; message: string };
      if (!isCurrentScan() || msg.requestId !== requestId) return;
      if (msg.type === "workerError") {
        failScan(msg.message);
      } else if (msg.type === "scanProgress") {
        setScanProgress(msg.total > 0 ? msg.done / msg.total : 1);
      } else if (msg.type === "rendezvousScan") {
        setRendezvousHits(msg.hits);
        setRendezvousScanning(false);
        setScanProgress(1);
      }
    };
    const startedAt = sceneTimeRef.current;
    setRendezvousScanning(true);
    setScanProgress(0);
    setScanAnchor(startedAt);
    worker.postMessage({ type: "setRecords", version: recordsVersionRef.current,
      records: indexedRecords.map((row) => ({ groupId: row.groupId, record: row.record })) });
    worker.postMessage({
      type: "scanRendezvous",
      requestId,
      primary: selectedRecord.record,
      atMs: startedAt.getTime(),
      options: {
        windowHours: rendezvousWindowHours,
        stepMinutes: 5,
        refinementSeconds: 30,
        hitMaxDistanceKm: rendezvousMaxMissKm,
        maxResults: 25
      }
    });
    return () => {
      worker.terminate();
      if (scanWorkerRef.current === worker) scanWorkerRef.current = null;
    };
  }, [
    indexedRecords,
    rendezvousMaxMissKm,
    rendezvousWindowHours,
    scanNonce,
    selectedRecord,
    workerNonce
  ]);

  useEffect(() => {
    if (!selectedId && propagated[0]) setSelectedId(propagated[0].id);
  }, [propagated, selectedId]);

  const refreshLoaded = async () => {
    await Promise.all(Object.keys(loadedGroups).map((groupId) => loadGroup(groupId, true)));
  };

  const handleScreenshot = () => {
    globeRef.current?.takeScreenshot();
  };

  const rescanRendezvous = () => setScanNonce((value) => value + 1);

  const loadAllGroups = () => {
    for (const catalog of AVAILABLE_CATALOGS) {
      if (!loadedGroups[catalog.id] && !loadingGroups[catalog.id]) void loadGroup(catalog.id);
    }
  };

  const unloadAllGroups = () => {
    for (const controller of groupRequestsRef.current.values()) controller.abort();
    groupRequestsRef.current.clear();
    loadedGroupsRef.current = {};
    setLoadedGroups({});
    setLoadingGroups({});
    setLoadErrors({});
  };

  const retryPropagation = () => {
    setPropagationError(null);
    setWorkerNonce((value) => value + 1);
  };

  const goLive = () => {
    setIsPlaying(true);
    setSpeedIndex(1);
    setSceneTime(new Date());
  };

  const timeOffsetHours = Math.round((sceneTime.getTime() - Date.now()) / 3_600_000);
  const isLive = isPlaying && speedIndex === 1 && timeOffsetHours === 0;
  const displayCatalogs: CatalogSummary[] = catalogs.length
    ? catalogs
    : AVAILABLE_CATALOGS.map((catalog) => ({
        ...catalog,
        cachedCount: 0,
        fetchedAt: null,
        sourceUpdatedAt: null,
        stale: true,
        error: null
      }));
  const loadedGroupCount = displayCatalogs.filter((catalog) => loadedGroups[catalog.id]).length;
  const busyGroupCount = displayCatalogs.filter((catalog) => loadingGroups[catalog.id]).length;

  // -- keyboard shortcuts --
  // Registered once: the handler reads the current catalog list and toggle
  // callback through a ref, so the listener is not torn down on every render.
  const shortcutTargetsRef = useRef({ displayCatalogs, toggleGroup });
  useEffect(() => {
    shortcutTargetsRef.current = { displayCatalogs, toggleGroup };
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.key) {
        case "?":
          e.preventDefault();
          setShowShortcuts((v) => !v);
          break;
        case " ":
          e.preventDefault();
          setIsPlaying((v) => !v);
          break;
        case "+":
        case "=":
          e.preventDefault();
          setSpeedIndex((i) => Math.min(i + 1, SPEEDS.length - 1));
          break;
        case "-":
        case "_":
          e.preventDefault();
          setSpeedIndex((i) => Math.max(i - 1, 0));
          break;
        case "l":
        case "L":
          e.preventDefault();
          setLocale((loc) => (loc === "zh" ? "en" : "zh"));
          break;
        case "a":
        case "A":
          e.preventDefault();
          setAutoRotate((value) => !value);
          break;
        case "s":
        case "S":
          e.preventDefault();
          setScanNonce((value) => value + 1);
          break;
        default: {
          const { displayCatalogs: current, toggleGroup: toggle } = shortcutTargetsRef.current;
          const idx = CATALOG_SHORTCUT_KEYS.indexOf(e.key);
          if (idx >= 0 && idx < current.length) {
            e.preventDefault();
            toggle(current[idx].id);
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setAutoRotate, setLocale]);

  const togglePanel = (panelId: CollapsiblePanelId) => {
    setCollapsedPanels((current) => ({
      ...current,
      [panelId]: !current[panelId]
    }));
  };
  const renderPanelToggle = (panelId: CollapsiblePanelId, label: string) => {
    const collapsed = collapsedPanels[panelId];
    const action = collapsed ? t.expandPanel : t.collapsePanel;

    return (
      <button
        className="icon-button compact"
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${action} ${label}`}
        title={`${action} ${label}`}
        onClick={() => togglePanel(panelId)}
      >
        {collapsed ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
      </button>
    );
  };

  return (
    <main
      className={clsx(
        "app-shell",
        leftRailCollapsed && "left-rail-collapsed",
        rightRailCollapsed && "right-rail-collapsed"
      )}
      style={{ position: "relative" }}
    >
      {showShortcuts ? (
        <div className="shortcuts-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="shortcuts-panel" onClick={(e) => e.stopPropagation()}>
            <div className="shortcuts-header">
              <h2>{t.keyboardShortcuts}</h2>
              <button
                className="icon-button compact"
                type="button"
                onClick={() => setShowShortcuts(false)}
                title={t.close}
              >
                ✕
              </button>
            </div>
            <div className="shortcuts-body">
              <div className="shortcut-row">
                <kbd>?</kbd>
                <span>{t.keyboardShortcuts}</span>
              </div>
              <div className="shortcut-row">
                <kbd>Space</kbd>
                <span>{t.spacePause}</span>
              </div>
              <div className="shortcut-row">
                <kbd>+</kbd> / <kbd>-</kbd>
                <span>{t.plusMinusSpeed}</span>
              </div>
              <div className="shortcut-row">
                <kbd>L</kbd>
                <span>{t.lLanguage}</span>
              </div>
              <div className="shortcut-row">
                <kbd>A</kbd>
                <span>{t.keyboardAutoRotate}</span>
              </div>
              <div className="shortcut-row">
                <kbd>S</kbd>
                <span>{t.keyboardRescan}</span>
              </div>
              <div className="shortcut-row">
                <kbd>1</kbd> – <kbd>9</kbd>
                <span>{t.selectCatalog}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <aside className={clsx("sidebar", leftRailCollapsed && "side-collapsed")}>
        <div className="brand-row">
          <div className="brand-mark" title={t.appName}>
            <Satellite size={22} />
          </div>
          {!leftRailCollapsed ? (
            <div className="brand-copy">
              <h1>{t.appName}</h1>
              <p>{t.subtitle}{IS_SNAPSHOT_MODE ? ` · ${t.dataSnapshot}` : ""}</p>
            </div>
          ) : null}
          <button
            className="icon-button compact side-toggle"
            type="button"
            aria-expanded={!leftRailCollapsed}
            aria-label={leftRailCollapsed ? t.expandLeftRail : t.collapseLeftRail}
            title={leftRailCollapsed ? t.expandLeftRail : t.collapseLeftRail}
            onClick={() => setLeftRailCollapsed((value) => !value)}
          >
            {leftRailCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>

        {!leftRailCollapsed ? (
          <>
            <div className="search-box">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t.searchPlaceholder}
              />
            </div>

            <section className={clsx("panel", "catalog-panel", collapsedPanels.catalogs && "collapsed")}>
              <div className="panel-title collapsible-title">
                <span className="panel-title-main">
                  <Layers size={16} />
                  <span>{t.catalogs}</span>
                  <small className="panel-count">
                    {loadedGroupCount}/{displayCatalogs.length}
                  </small>
                </span>
                <span className="panel-title-actions">
                  <button
                    className="mini-button"
                    type="button"
                    onClick={loadAllGroups}
                    disabled={busyGroupCount > 0 || loadedGroupCount === displayCatalogs.length}
                    title={t.loadAll}
                  >
                    {t.loadAll}
                  </button>
                  <button
                    className="mini-button"
                    type="button"
                    onClick={unloadAllGroups}
                    disabled={loadedGroupCount === 0 && busyGroupCount === 0}
                    title={t.unloadAll}
                  >
                    {t.unloadAll}
                  </button>
                  {renderPanelToggle("catalogs", t.catalogs)}
                </span>
              </div>
              {IS_SNAPSHOT_MODE ? <p className="empty-state">{t.snapshotHint}</p> : null}
              {catalogError ? <p className="error-text" role="alert">{t.fetchError}: {catalogError}</p> : null}
              {Object.entries(loadErrors).map(([groupId, error]) => (
                <p key={groupId} className="error-text" role="alert">
                  {AVAILABLE_CATALOGS.find((catalog) => catalog.id === groupId)?.label[locale]}: {error}
                </p>
              ))}
              {busyGroupCount > 0 ? (
                <div className="load-progress" role="status" aria-live="polite">
                  <span
                    className="load-progress-bar"
                    style={{ width: `${(loadedGroupCount / displayCatalogs.length) * 100}%` }}
                  />
                  <small>{t.loading}</small>
                </div>
              ) : null}
              {!collapsedPanels.catalogs ? (
                <div className="catalog-list">
                  {displayCatalogs.map((catalog) => {
                    const loaded = loadedGroups[catalog.id];
                    const loading = loadingGroups[catalog.id];
                    const error = loadErrors[catalog.id] ?? loaded?.error;
                    const fetchedAt = loaded?.fetchedAt ?? catalog.fetchedAt;
                    return (
                      <button
                        key={catalog.id}
                        className={clsx("catalog-item", loaded && "active", loading && "pending")}
                        onClick={() => toggleGroup(catalog.id)}
                        type="button"
                        disabled={loading}
                        title={loaded ? t.unload : t.load}
                        aria-pressed={Boolean(loaded)}
                      >
                        <span>
                          <span className="catalog-label">
                            <span
                              className="catalog-swatch"
                              style={{ backgroundColor: catalog.color }}
                              aria-hidden
                            />
                            <strong>{catalog.label[locale]}</strong>
                          </span>
                          <small>{catalog.description[locale]}</small>
                          {IS_SNAPSHOT_MODE && fetchedAt ? (
                            <small>{t.dataFetchedAt}: <time dateTime={fetchedAt}>{formatDateTimeShort(fetchedAt)}</time></small>
                          ) : null}
                        </span>
                        <span className="catalog-meta" aria-busy={Boolean(loading)}>
                          {loading ? <Loader2 className="spin" size={15} /> : loaded ? t.loaded : t.load}
                          <small>
                            {loaded?.records.length ?? catalog.cachedCount ?? 0} {t.objects}
                          </small>
                          {IS_SNAPSHOT_MODE && fetchedAt && snapshotIsStale(loaded ?? catalog, dataNowMs)
                            ? <small>{t.snapshotStale}</small> : null}
                          {error ? <AlertTriangle size={14} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </aside>

      <section className="stage">
        <div className="topbar">
          <div className="metric">
            <Database size={16} />
            <span>{formatNumber(indexedRecords.length)}</span>
            <small>{t.objects}</small>
          </div>
          <div className="metric">
            <LocateFixed size={16} />
            <span data-testid="propagated-count">{formatNumber(propagated.length)}</span>
            <small>{t.visible}</small>
          </div>
          <div className="metric wide">
            <Clock3 size={16} />
            {/* The clock is a live wall-clock time: the server formats it in its
                own locale/timezone and the values differ by the time hydration
                runs. Suppressing the check here is the documented fix for
                timestamps; the 1 Hz tick corrects the text immediately after. */}
            <span suppressHydrationWarning>{formatDateTime(sceneTime)}</span>
          </div>
          <button
            className={clsx("icon-button", autoRotate && "toggled")}
            type="button"
            onClick={() => setAutoRotate((value) => !value)}
            aria-pressed={autoRotate}
            title={`${t.autoRotate} (A)`}
          >
            <RotateCw size={18} />
          </button>
          <button className="icon-button" type="button" onClick={() => setLocale(locale === "zh" ? "en" : "zh")} title={t.language}>
            <Languages size={18} />
          </button>
          <button className="icon-button" type="button" onClick={() => void refreshLoaded()} title={IS_SNAPSHOT_MODE ? t.refreshSnapshot : t.refresh}>
            <RefreshCw size={18} />
          </button>
          <button className="icon-button" type="button" onClick={handleScreenshot} title={t.screenshot}>
            <Camera size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => setShowShortcuts((v) => !v)}
            title={t.keyboardShortcuts}
          >
            <HelpCircle size={18} />
          </button>
        </div>

        <GlobeScene
          ref={globeRef}
          objects={propagated}
          selectedId={selectedId}
          track={selectedTrack}
          onSelect={setSelectedId}
          observer={{ latitudeDeg: observerLat, longitudeDeg: observerLon }}
          sceneTime={sceneTime}
          autoRotate={autoRotate}
        />

        {propagationError ? (
          <div className="panel" role="alert" style={{ position: "absolute", top: 78, left: 16, right: 16, zIndex: 5 }}>
            <p className="error-text">{t.propagationFailed}: {propagationError}</p>
            <button className="text-button" type="button" onClick={retryPropagation}>{t.retry}</button>
          </div>
        ) : null}

        <div className="legend" aria-label={t.legend}>
          <span className="legend-title">{t.legend}</span>
          <ul>
            {LEGEND_CLASSES.map((objectClassKey) => (
              <li key={objectClassKey}>
                <span
                  className="legend-dot"
                  style={{ backgroundColor: OBJECT_CLASS_COLORS[objectClassKey] }}
                  aria-hidden
                />
                {t[objectClassKey]}
              </li>
            ))}
            <li className="legend-separator" aria-hidden />
            <li>
              <span className="legend-line amber" aria-hidden />
              {t.orbitTrack}
            </li>
            <li>
              <span className="legend-line pale" aria-hidden />
              {t.groundTrack}
            </li>
            <li>
              <span className="legend-dot observer" aria-hidden />
              {t.observerLocation}
            </li>
          </ul>
        </div>

        <div className="timeline">
          <button
            className="icon-button strong"
            type="button"
            onClick={() => setIsPlaying((value) => !value)}
            title={isPlaying ? t.pause : t.play}
          >
            {isPlaying ? <Pause size={19} /> : <Play size={19} />}
          </button>
          <label className="range-label">
            <span>{t.time}</span>
            <input
              type="range"
              min={-24}
              max={24}
              step={1}
              value={timeOffsetHours}
              onChange={(event) => {
                setIsPlaying(false);
                setSceneTime(new Date(Date.now() + Number(event.target.value) * 3_600_000));
              }}
            />
          </label>
          <button
            className={clsx("text-button", isLive && "toggled")}
            type="button"
            onClick={goLive}
            aria-pressed={isLive}
          >
            {t.now}
          </button>
          <select
            value={speedIndex}
            onChange={(event) => setSpeedIndex(Number(event.target.value))}
            aria-label={t.speed}
          >
            {SPEEDS.map((speed, index) => (
              <option key={speed} value={index}>
                {speed === 0 ? "0x" : `${speed}x`}
              </option>
            ))}
          </select>
        </div>
      </section>

      <aside className={clsx("inspector", rightRailCollapsed && "side-collapsed")}>
        <div className="inspector-rail-row">
          <button
            className="icon-button compact side-toggle"
            type="button"
            aria-expanded={!rightRailCollapsed}
            aria-label={rightRailCollapsed ? t.expandRightRail : t.collapseRightRail}
            title={rightRailCollapsed ? t.expandRightRail : t.collapseRightRail}
            onClick={() => setRightRailCollapsed((value) => !value)}
          >
            {rightRailCollapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}
          </button>
        </div>

        {!rightRailCollapsed ? (
          <>
            <section className={clsx("panel", "filter-panel", collapsedPanels.filters && "collapsed")}>
              <div className="panel-title collapsible-title">
                <span className="panel-title-main">
                  <SlidersHorizontal size={16} />
                  <span>{t.filter}</span>
                </span>
                {renderPanelToggle("filters", t.filter)}
              </div>
              {!collapsedPanels.filters ? (
                <div className="filter-body">
                  <div className="segmented">
                    {(["all", "payload", "debris", "rocket", "unknown"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={classFilter === value ? "active" : ""}
                        onClick={() => setClassFilter(value)}
                      >
                        {t[value]}
                      </button>
                    ))}
                  </div>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={showDebris}
                      onChange={(event) => setShowDebris(event.target.checked)}
                    />
                    <span>{t.showDebris}</span>
                  </label>
                  <div className="dual-range">
                    <span>{t.altitude}</span>
                    <label>
                      <small>{t.minLabel}</small>
                      <input
                        type="number"
                        value={altitudeMin}
                        min={0}
                        max={altitudeMax}
                        step={50}
                        onChange={(event) => setAltitudeMin(Number(event.target.value))}
                      />
                    </label>
                    <label>
                      <small>{t.maxLabel}</small>
                      <input
                        type="number"
                        value={altitudeMax}
                        min={altitudeMin}
                        step={50}
                        onChange={(event) => setAltitudeMax(Number(event.target.value))}
                      />
                    </label>
                  </div>
                </div>
              ) : null}
            </section>

            <section className={clsx("panel", "analysis-panel", collapsedPanels.analysis && "collapsed")}>
              <div className="panel-title collapsible-title">
                <span className="panel-title-main">
                  <Radar size={16} />
                  <span>{t.analysis}</span>
                </span>
                {renderPanelToggle("analysis", t.analysis)}
              </div>
              {!collapsedPanels.analysis ? (
                <>
                  <div className="segmented analysis-tabs">
                    <button
                      type="button"
                      className={analysisTab === "rendezvous" ? "active" : ""}
                      onClick={() => setAnalysisTab("rendezvous")}
                    >
                      <Radar size={14} /> {t.rendezvous}
                    </button>
                    <button
                      type="button"
                      className={analysisTab === "passes" ? "active" : ""}
                      onClick={() => setAnalysisTab("passes")}
                    >
                      <Telescope size={14} /> {t.passes}
                    </button>
                  </div>

                  {analysisTab === "rendezvous" ? (
                    <div className="rendezvous-body">
                      <div className="mini-field">
                        <span>{t.primaryTarget}</span>
                        <strong>{selectedObject?.name ?? t.needSelection}</strong>
                      </div>
                      <div className="search-box compact-search">
                        <Search size={15} />
                        <input
                          value={primaryQuery}
                          onChange={(event) => setPrimaryQuery(event.target.value)}
                          placeholder={t.searchTarget}
                        />
                      </div>
                      {primaryCandidates.length > 0 ? (
                        <div className="candidate-list">
                          {primaryCandidates.map((row) => {
                            const id = String(row.record.NORAD_CAT_ID);
                            return (
                              <button
                                key={`${row.groupId}-${id}`}
                                className={clsx("candidate-item", selectedId === id && "active")}
                                type="button"
                                onClick={() => {
                                  setSelectedId(id);
                                  setPrimaryQuery("");
                                }}
                              >
                                <span>{row.record.OBJECT_NAME}</span>
                                <small>{id}</small>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      <small>{t.rendezvousScanHint}</small>
                      <label className="window-row">
                        <span>{t.analysisWindow}</span>
                        <select
                          value={rendezvousWindowHours}
                          onChange={(event) =>
                            setRendezvousWindowHours(Number(event.target.value))
                          }
                        >
                          {[6, 12, 24, 48, 72].map((hours) => (
                            <option key={hours} value={hours}>
                              {hours} {t.hoursShort}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="window-row">
                        <span>{t.maxMissDistance}</span>
                        <select
                          value={rendezvousMaxMissKm}
                          onChange={(event) =>
                            setRendezvousMaxMissKm(Number(event.target.value))
                          }
                        >
                          {[5, 10, 25, 50, 100, 200].map((km) => (
                            <option key={km} value={km}>
                              {km} km
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="scan-action-row">
                        <button
                          className="text-button scan-button"
                          type="button"
                          onClick={rescanRendezvous}
                          disabled={!selectedRecord || rendezvousScanning}
                        >
                          {rendezvousScanning ? (
                            <Loader2 className="spin" size={14} />
                          ) : (
                            <Radar size={14} />
                          )}
                          {rendezvousScanning ? t.rendezvousScanning : t.rescan}
                        </button>
                        {scanAnchor ? (
                          <small className="scan-anchor" title={t.scanAnchor}>
                            {formatDateTimeShort(scanAnchor)}
                          </small>
                        ) : null}
                      </div>
                      {rendezvousScanning ? (
                        <div
                          className="scan-progress"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(scanProgress * 100)}
                        >
                          <span
                            className="scan-progress-bar"
                            style={{ width: `${Math.max(2, scanProgress * 100)}%` }}
                          />
                        </div>
                      ) : null}
                      <div className="status-row">
                        <span>{t.scanResultsCount}</span>
                        <strong>
                          {rendezvousScanning
                            ? `${Math.round(scanProgress * 100)}%`
                            : formatNumber(rendezvousHits.length)}
                        </strong>
                      </div>
                      {scanError ? <p className="error-text" role="alert">{t.scanFailed}: {scanError}</p> : null}
                      {!selectedRecord ? (
                        <p className="empty-state">{t.needSelection}</p>
                      ) : scanError ? null : rendezvousHits.length === 0 ? (
                        rendezvousScanning ? null : (
                          <p className="empty-state">{t.noRendezvous}</p>
                        )
                      ) : (
                        <ul className="pass-list">
                          {rendezvousHits.map((hit) => {
                            const key = `${hit.groupId}-${hit.noradId}`;
                            const expanded = expandedHitKey === key;
                            return (
                              <li key={key} className="pass-row hit-row">
                                <div className="hit-row-head">
                                  <button
                                    type="button"
                                    className="hit-row-toggle"
                                    aria-expanded={expanded}
                                    aria-label={expanded ? t.collapsePanel : t.expandPanel}
                                    onClick={() => setExpandedHitKey(expanded ? null : key)}
                                  >
                                    {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                  </button>
                                  <button
                                    type="button"
                                    className="hit-row-summary"
                                    onClick={() => setSelectedId(hit.noradId)}
                                  >
                                    <strong>{hit.name}</strong>
                                    <span>{formatNumber(hit.missDistanceKm, 1)} km</span>
                                  </button>
                                </div>
                                {expanded ? (
                                  <div className="pass-row-body hit-row-body">
                                    <span>
                                      {t.closestApproach}{" "}
                                      {formatDateTimeShort(hit.closestAt)}
                                    </span>
                                    {hit.closestLatitudeDeg !== null &&
                                    hit.closestLongitudeDeg !== null ? (
                                      <span>
                                        {hit.closestLatitudeDeg.toFixed(2)}°,{" "}
                                        {hit.closestLongitudeDeg.toFixed(2)}°
                                        {hit.closestAltitudeKm !== null
                                          ? ` · ${formatNumber(hit.closestAltitudeKm, 0)} km`
                                          : ""}
                                      </span>
                                    ) : null}
                                    <span>
                                      {t.relativeSpeed} {hit.relativeSpeedKmS.toFixed(2)} km/s
                                    </span>
                                    <span>
                                      {t.currentSeparation}{" "}
                                      {formatNumber(hit.currentDistanceKm, 0)} km
                                    </span>
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <div className="passes-body">
                      <div className="observer-row">
                        <label>
                          <small>{t.latitudeLabel}</small>
                          <input
                            type="number"
                            step={0.0001}
                            value={observerLat}
                            onChange={(event) => setObserverLat(Number(event.target.value))}
                          />
                        </label>
                        <label>
                          <small>{t.longitudeLabel}</small>
                          <input
                            type="number"
                            step={0.0001}
                            value={observerLon}
                            onChange={(event) => setObserverLon(Number(event.target.value))}
                          />
                        </label>
                        <button
                          type="button"
                          className="text-button"
                          onClick={requestLocation}
                          disabled={locating}
                          title={t.useMyLocation}
                        >
                          {locating ? t.locating : t.useMyLocation}
                        </button>
                      </div>
                      <label className="window-row">
                        <span>{t.minElevation}</span>
                        <select
                          value={minElevationDeg}
                          onChange={(event) => setMinElevationDeg(Number(event.target.value))}
                        >
                          {[0, 5, 10, 20, 30].map((deg) => (
                            <option key={deg} value={deg}>
                              {deg} deg
                            </option>
                          ))}
                        </select>
                      </label>
                      {locationError ? <p className="error-text">{locationError}</p> : null}
                      {!selectedRecord ? (
                        <p className="empty-state">{t.needSelection}</p>
                      ) : passes.length === 0 ? (
                        <p className="empty-state">{t.noPasses}</p>
                      ) : (
                        <ul className="pass-list">
                          {passes.map((pass) => (
                            <li key={pass.startAt} className="pass-row">
                              <div className="pass-row-head">
                                <strong>{formatDateTimeShort(pass.startAt)}</strong>
                                <span>{Math.round(pass.peakElevationDeg)} deg</span>
                              </div>
                              <div className="pass-row-body">
                                <span>
                                  {t.riseAt} {azimuthToCompass(pass.startAzimuthDeg)}
                                </span>
                                <span>
                                  {t.setAt} {azimuthToCompass(pass.endAzimuthDeg)}
                                </span>
                                <span>
                                  {t.duration} {Math.round(pass.durationSec / 60)}m
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              ) : null}
            </section>

            <section className={clsx("panel", "selected-panel", collapsedPanels.selected && "collapsed")}>
              <div className="panel-title collapsible-title">
                <span className="panel-title-main">
                  <Satellite size={16} />
                  <span>{selectedObject ? t.selected : t.noSelection}</span>
                </span>
                {renderPanelToggle("selected", selectedObject ? t.selected : t.noSelection)}
              </div>
              {!collapsedPanels.selected && selectedObject ? (
                <>
                  <div className="selected-head">
                    <h2>{selectedObject.name}</h2>
                    <div className="selected-head-actions">
                      <button
                        type="button"
                        className="icon-button compact"
                        onClick={exportSelectedOmm}
                        title={t.exportOmm}
                        aria-label={t.exportOmm}
                      >
                        <Download size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-button compact"
                        onClick={() => toggleWatchlist(selectedObject.id)}
                        aria-pressed={watchlist.includes(selectedObject.id)}
                        title={
                          watchlist.includes(selectedObject.id)
                            ? t.removeFromWatchlist
                            : t.addToWatchlist
                        }
                      >
                        {watchlist.includes(selectedObject.id) ? (
                          <Star size={16} fill="#fbbf24" stroke="#fbbf24" />
                        ) : (
                          <StarOff size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="detail-grid">
                    <span>{t.norad}</span>
                    <strong>{selectedObject.noradId}</strong>
                    <span>{t.internationalId}</span>
                    <strong>{selectedObject.objectId ?? "-"}</strong>
                    <span>{t.classification}</span>
                    <strong>{t[selectedObject.objectType]}</strong>
                    <span>{t.epoch}</span>
                    <strong>{formatDateTimeShort(parseOmmEpoch(selectedObject.epoch) ?? Number.NaN)}</strong>
                    <span>{t.latitude}</span>
                    <strong>{selectedObject.latitude.toFixed(3)} deg</strong>
                    <span>{t.longitude}</span>
                    <strong>{selectedObject.longitude.toFixed(3)} deg</strong>
                    <span>{t.altitudeKm}</span>
                    <strong>{formatNumber(selectedObject.altitudeKm, 1)} km</strong>
                    <span>{t.velocity}</span>
                    <strong>{selectedObject.speedKmS.toFixed(3)} km/s</strong>
                    <span>{t.dataAge}</span>
                    <strong>{formatNumber(Math.abs(dataAgeHours(selectedObject.epoch, sceneTime) ?? 0), 1)} h</strong>
                    <span>{t.trackFrame}</span>
                    <strong>{t.inertialTrack}</strong>
                  </div>
                </>
              ) : !collapsedPanels.selected ? (
                <p className="empty-state">{propagated.length ? t.noSelection : t.noMatches}</p>
              ) : null}
            </section>

            <section className={clsx("panel", "watchlist-panel", collapsedPanels.watchlist && "collapsed")}>
              <div className="panel-title collapsible-title">
                <span className="panel-title-main">
                  <Star size={16} />
                  <span>{t.watchlist}</span>
                  <small>({watchlist.length})</small>
                </span>
                {renderPanelToggle("watchlist", t.watchlist)}
              </div>
              {!collapsedPanels.watchlist ? (
                watchlist.length === 0 ? (
                  <p className="empty-state">{t.watchlistEmpty}</p>
                ) : (
                  <div className="candidate-list">
                    {watchlistObjects.map((obj, idx) => {
                      const id = watchlist[idx];
                      if (!obj) {
                        return (
                          <div key={id} className="candidate-item disabled">
                            <span>{id}</span>
                            <button
                              type="button"
                              className="icon-button compact"
                              onClick={() => toggleWatchlist(id)}
                              title={t.removeFromWatchlist}
                            >
                              <StarOff size={14} />
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={id}
                          className={clsx("candidate-item", selectedId === id && "active")}
                        >
                          <button
                            type="button"
                            className="candidate-summary"
                            onClick={() => setSelectedId(id)}
                          >
                            <span>{obj.name}</span>
                            <small>
                              {formatNumber(obj.altitudeKm, 0)} km · {obj.speedKmS.toFixed(2)} km/s
                            </small>
                          </button>
                          <button
                            type="button"
                            className="icon-button compact"
                            onClick={() => toggleWatchlist(id)}
                            title={t.removeFromWatchlist}
                          >
                            <Star size={14} fill="#fbbf24" stroke="#fbbf24" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : null}
            </section>

            <section className={clsx("panel", "status-panel", collapsedPanels.status && "collapsed")}>
              <div className="panel-title collapsible-title">
                <span className="panel-title-main">
                  <Database size={16} />
                  <span>{t.sourceStatus}</span>
                </span>
                {renderPanelToggle("status", t.sourceStatus)}
              </div>
              {!collapsedPanels.status ? (
                <>
                  {Object.values(loadedGroups).length ? (
                    Object.values(loadedGroups).map((group) => (
                      <Fragment key={group.catalog.id}>
                        <div className="status-row">
                          <span>{group.catalog.label[locale]}</span>
                          <strong>{IS_SNAPSHOT_MODE ? <>
                            <span>{t.dataSnapshot}</span>
                            {snapshotIsStale(group, dataNowMs) ? <> · <span>{t.snapshotStale}</span></> : null}
                          </> : group.stale ? t.stale : t.updated}</strong>
                        </div>
                        {IS_SNAPSHOT_MODE && group.sourceUpdatedAt ? (
                          <div className="status-row">
                            <span>{t.latestEpoch}</span>
                            <time dateTime={group.sourceUpdatedAt}>{formatDateTimeShort(group.sourceUpdatedAt)}</time>
                          </div>
                        ) : null}
                      </Fragment>
                    ))
                  ) : (
                    <p className="empty-state">{t.loading}</p>
                  )}
                  {Object.entries(loadErrors).map(([groupId, error]) => (
                    <p key={groupId} className="error-text">
                      {t.fetchError}: {error}
                    </p>
                  ))}
                </>
              ) : null}
            </section>
          </>
        ) : null}
      </aside>
    </main>
  );
}
