"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  Camera,
  Satellite,
  Search,
  SlidersHorizontal,
  Star,
  StarOff,
  Telescope
} from "lucide-react";
import GlobeScene, { GlobeSceneHandle } from "@/components/GlobeScene";
import { CATALOGS, CatalogDefinition } from "@/lib/catalogs";
import { copy, initialLocale, Locale } from "@/lib/i18n";
import {
  dataAgeHours,
  OmmRecord,
  parseOmmEpoch,
  PropagatedObject,
  RendezvousScanHit,
  sampleOrbitTrack
} from "@/lib/orbit";
import { azimuthToCompass, predictPasses } from "@/lib/passes";

type CatalogSummary = CatalogDefinition & {
  cachedCount: number;
  fetchedAt: string | null;
  sourceUpdatedAt: string | null;
  stale: boolean;
  error: string | null;
};

type LoadedGroup = {
  catalog: CatalogDefinition;
  records: OmmRecord[];
  fetchedAt: string | null;
  sourceUpdatedAt: string | null;
  stale: boolean;
  cacheState: string;
  error: string | null;
};

type CollapsiblePanelId = "catalogs" | "filters" | "analysis" | "selected" | "status" | "watchlist";
type AnalysisTab = "rendezvous" | "passes";

const RENDER_LIMIT = 16000;
const SPEEDS = [0, 1, 10, 60, 600];
const WATCHLIST_KEY = "orbital-field:watchlist";
const CATALOG_SHORTCUT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "q", "w", "e", "r", "t", "y", "u"];

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

export default function SatelliteExplorer() {
  const [locale, setLocale] = useState<Locale>("zh");
  const t = copy[locale];
  const [catalogs, setCatalogs] = useState<CatalogSummary[]>([]);
  const [loadedGroups, setLoadedGroups] = useState<Record<string, LoadedGroup>>({});
  const [loadingGroups, setLoadingGroups] = useState<Record<string, boolean>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState<"all" | "payload" | "debris" | "rocket" | "unknown">(
    "all"
  );
  const [showDebris, setShowDebris] = useState(true);
  const [altitudeMin, setAltitudeMin] = useState(0);
  const [altitudeMax, setAltitudeMax] = useState(42000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sceneTime, setSceneTime] = useState(() => new Date());
  const [isPlaying, setIsPlaying] = useState(true);
  const [speedIndex, setSpeedIndex] = useState(1);
  const [leftRailCollapsed, setLeftRailCollapsed] = useState(false);
  const [rightRailCollapsed, setRightRailCollapsed] = useState(false);
  const [collapsedPanels, setCollapsedPanels] = useState<Record<CollapsiblePanelId, boolean>>({
    catalogs: false,
    filters: false,
    analysis: false,
    selected: false,
    status: true,
    watchlist: false
  });
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>("rendezvous");
  const [primaryQuery, setPrimaryQuery] = useState("");
  const [rendezvousWindowHours, setRendezvousWindowHours] = useState(24);
  const [rendezvousMaxMissKm, setRendezvousMaxMissKm] = useState(50);
  const [rendezvousHits, setRendezvousHits] = useState<RendezvousScanHit[]>([]);
  const [rendezvousScanning, setRendezvousScanning] = useState(false);
  const [expandedHitKey, setExpandedHitKey] = useState<string | null>(null);
  const [observerLat, setObserverLat] = useState<number>(40.0);
  const [observerLon, setObserverLon] = useState<number>(116.4);
  const [minElevationDeg, setMinElevationDeg] = useState(10);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [workerObjects, setWorkerObjects] = useState<PropagatedObject[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const globeRef = useRef<GlobeSceneHandle>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const latestRequestIdRef = useRef(0);
  const scanRequestIdRef = useRef(0);
  const latestScanRequestIdRef = useRef(0);

  useEffect(() => {
    setLocale(initialLocale());
    fetch("/api/catalogs")
      .then((response) => response.json())
      .then((payload) => {
        setCatalogs(payload.catalogs ?? []);
      })
      .catch(() => setCatalogs(CATALOGS.map((catalog) => ({ ...catalog, cachedCount: 0, fetchedAt: null, sourceUpdatedAt: null, stale: true, error: null }))));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(WATCHLIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setWatchlist(parsed.filter((item): item is string => typeof item === "string"));
        }
      }
    } catch {
      // ignore corrupt storage
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
    } catch {
      // storage may be full or disabled
    }
  }, [watchlist]);

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
    if (loadingGroups[groupId]) return;
    if (!force && loadedGroups[groupId]) return;
    setLoadingGroups((current) => ({ ...current, [groupId]: true }));
    setLoadErrors((current) => {
      const next = { ...current };
      delete next[groupId];
      return next;
    });
    try {
      const response = await fetch(`/api/gp?group=${encodeURIComponent(groupId)}`);
      const payload = await response.json();
      if (!response.ok && !payload.records?.length) {
        throw new Error(payload.error ?? "Unable to load catalog");
      }
      setLoadedGroups((current) => ({
        ...current,
        [groupId]: {
          catalog: payload.group,
          records: payload.records ?? [],
          fetchedAt: payload.fetchedAt ?? null,
          sourceUpdatedAt: payload.sourceUpdatedAt ?? null,
          stale: Boolean(payload.stale),
          cacheState: payload.cacheState ?? "miss",
          error: payload.error ?? null
        }
      }));
      setCatalogs((current) =>
        current.map((catalog) =>
          catalog.id === groupId
            ? {
                ...catalog,
                cachedCount: payload.records?.length ?? catalog.cachedCount,
                fetchedAt: payload.fetchedAt ?? catalog.fetchedAt,
                sourceUpdatedAt: payload.sourceUpdatedAt ?? catalog.sourceUpdatedAt,
                stale: Boolean(payload.stale),
                error: payload.error ?? null
              }
            : catalog
        )
      );
    } catch (error) {
      setLoadErrors((current) => ({
        ...current,
        [groupId]: error instanceof Error ? error.message : "Unable to load catalog"
      }));
    } finally {
      setLoadingGroups((current) => ({ ...current, [groupId]: false }));
    }
  };

  const unloadGroup = (groupId: string) => {
    setLoadedGroups((current) => {
      if (!current[groupId]) return current;
      const next = { ...current };
      delete next[groupId];
      return next;
    });
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
    for (const catalog of CATALOGS) {
      void loadGroup(catalog.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    for (const loaded of Object.values(loadedGroups)) {
      for (const record of loaded.records) {
        rows.push({ groupId: loaded.catalog.id, record, catalog: loaded.catalog });
      }
    }
    return rows;
  }, [loadedGroups]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const worker = new Worker(new URL("@/lib/propagationWorker.ts", import.meta.url), {
      type: "module"
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: "propagated"; requestId: number; objects: PropagatedObject[] }
        | { type: "rendezvousScan"; requestId: number; hits: RendezvousScanHit[] };
      if (msg.type === "propagated") {
        if (msg.requestId < latestRequestIdRef.current) return;
        latestRequestIdRef.current = msg.requestId;
        setWorkerObjects(msg.objects);
        return;
      }
      if (msg.type === "rendezvousScan") {
        if (msg.requestId < latestScanRequestIdRef.current) return;
        latestScanRequestIdRef.current = msg.requestId;
        setRendezvousHits(msg.hits);
        setRendezvousScanning(false);
        return;
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const records = indexedRecords.map((row) => ({ groupId: row.groupId, record: row.record }));
    worker.postMessage({ type: "setRecords", records });
  }, [indexedRecords]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const requestId = ++requestIdRef.current;
    worker.postMessage({ type: "propagate", requestId, atMs: sceneTime.getTime() });
  }, [sceneTime, indexedRecords]);

  const debrisGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const catalog of CATALOGS) {
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

  const selectedRecord = useMemo(() => {
    if (!selectedId) return null;
    return indexedRecords.find((row) => String(row.record.NORAD_CAT_ID) === selectedId) ?? null;
  }, [indexedRecords, selectedId]);

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

  const selectedTrack = useMemo(() => {
    if (!selectedRecord) return [];
    return sampleOrbitTrack(selectedRecord.record, sceneTime, selectedRecord.groupId);
  }, [sceneTime, selectedRecord]);

  const passes = useMemo(() => {
    if (!selectedRecord) return [];
    return predictPasses(
      selectedRecord.record,
      { latitudeDeg: observerLat, longitudeDeg: observerLon },
      sceneTime,
      { windowHours: 48, minElevationDeg, maxResults: 6 }
    );
  }, [minElevationDeg, observerLat, observerLon, sceneTime, selectedRecord]);

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

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    if (!selectedRecord) {
      setRendezvousHits([]);
      setRendezvousScanning(false);
      return;
    }
    const requestId = ++scanRequestIdRef.current;
    setRendezvousScanning(true);
    worker.postMessage({
      type: "scanRendezvous",
      requestId,
      primary: selectedRecord.record,
      atMs: sceneTime.getTime(),
      options: {
        windowHours: rendezvousWindowHours,
        stepMinutes: 5,
        refinementSeconds: 30,
        hitMaxDistanceKm: rendezvousMaxMissKm,
        maxResults: 25
      }
    });
  }, [
    indexedRecords,
    rendezvousMaxMissKm,
    rendezvousWindowHours,
    sceneTime,
    selectedRecord
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

  const timeOffsetHours = Math.round((sceneTime.getTime() - Date.now()) / 3_600_000);
  const displayCatalogs: CatalogSummary[] = catalogs.length
    ? catalogs
    : CATALOGS.map((catalog) => ({
        ...catalog,
        cachedCount: 0,
        fetchedAt: null,
        sourceUpdatedAt: null,
        stale: true,
        error: null
      }));

  // -- keyboard shortcuts --
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
        default: {
          const idx = CATALOG_SHORTCUT_KEYS.indexOf(e.key);
          if (idx >= 0 && idx < displayCatalogs.length) {
            e.preventDefault();
            const catalog = displayCatalogs[idx];
            toggleGroup(catalog.id);
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [displayCatalogs]);

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
              <p>{t.subtitle}</p>
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
                </span>
                {renderPanelToggle("catalogs", t.catalogs)}
              </div>
              {!collapsedPanels.catalogs ? (
                <div className="catalog-list">
                  {displayCatalogs.map((catalog) => {
                    const loaded = loadedGroups[catalog.id];
                    const loading = loadingGroups[catalog.id];
                    const error = loadErrors[catalog.id] ?? loaded?.error;
                    return (
                      <button
                        key={catalog.id}
                        className={clsx("catalog-item", loaded && "active")}
                        onClick={() => toggleGroup(catalog.id)}
                        type="button"
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
                        </span>
                        <span className="catalog-meta">
                          {loading ? <Loader2 className="spin" size={15} /> : loaded ? t.loaded : t.load}
                          <small>
                            {loaded?.records.length ?? catalog.cachedCount ?? 0} {t.objects}
                          </small>
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
            <span>{formatNumber(propagated.length)}</span>
            <small>{t.visible}</small>
          </div>
          <div className="metric wide">
            <Clock3 size={16} />
            <span>{formatDate(sceneTime)}</span>
          </div>
          <button className="icon-button" type="button" onClick={() => setLocale(locale === "zh" ? "en" : "zh")} title={t.language}>
            <Languages size={18} />
          </button>
          <button className="icon-button" type="button" onClick={() => void refreshLoaded()} title={t.refresh}>
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
        />

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
          <button className="text-button" type="button" onClick={() => setSceneTime(new Date())}>
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
                      <small>min</small>
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
                      <small>max</small>
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
                      <div className="status-row">
                        <span>{t.scanResultsCount}</span>
                        <strong>
                          {rendezvousScanning
                            ? t.rendezvousScanning
                            : formatNumber(rendezvousHits.length)}
                        </strong>
                      </div>
                      {!selectedRecord ? (
                        <p className="empty-state">{t.needSelection}</p>
                      ) : rendezvousHits.length === 0 ? (
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
                                      {new Date(hit.closestAt).toLocaleString()}
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
                                <strong>{new Date(pass.startAt).toLocaleString()}</strong>
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
                    <strong>{parseOmmEpoch(selectedObject.epoch)?.toLocaleString() ?? "-"}</strong>
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
                      <div key={group.catalog.id} className="status-row">
                        <span>{group.catalog.label[locale]}</span>
                        <strong>{group.stale ? t.stale : t.updated}</strong>
                      </div>
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
