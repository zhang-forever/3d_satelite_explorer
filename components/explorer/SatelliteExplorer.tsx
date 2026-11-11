"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Satellite,
  Search
} from "lucide-react";

import GlobeScene, { type GlobeSceneHandle } from "@/components/globe/GlobeScene";
import type { CatalogDefinition } from "@/lib/data/catalogs";
import { AVAILABLE_CATALOGS, IS_SNAPSHOT_MODE } from "@/lib/data/dataAccess";
import {
  dedupeByNorad,
  objectClass,
  type OmmRecord,
  type PropagatedObject,
  quantizeDown,
  type RendezvousScanHit,
  sampleOrbitTrack
} from "@/lib/orbit";
import { predictPasses } from "@/lib/orbit/passes";
import { copy, initialLocale, type Locale } from "@/lib/ui/i18n";

import { ExplorerLegend } from "./ExplorerLegend";
import { ExplorerTopBar } from "./ExplorerTopBar";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { TimeTimeline } from "./TimeTimeline";
import { fallbackCatalogs, normalizeText } from "./apiResponse";
import {
  AUTO_ROTATE_KEY,
  CATALOG_SHORTCUT_KEYS,
  CLASS_FILTER_KEY,
  DEFAULT_COLLAPSED_PANELS,
  EMPTY_WATCHLIST,
  LEFT_RAIL_KEY,
  LOCALE_KEY,
  PANELS_KEY,
  PASSES_TICK_MS,
  RENDER_LIMIT,
  RIGHT_RAIL_KEY,
  SHOW_DEBRIS_KEY,
  SPEEDS,
  TRACK_TICK_MS,
  WATCHLIST_KEY
} from "./explorerConstants";
import type {
  AnalysisTab,
  CatalogSummary,
  CollapsiblePanelId,
  IndexedRecord,
  RecordMeta
} from "./explorerTypes";
import { AnalysisPanel } from "./panels/AnalysisPanel";
import { CatalogPanel } from "./panels/CatalogPanel";
import { FilterPanel, type ClassFilter } from "./panels/FilterPanel";
import { SelectedPanel } from "./panels/SelectedPanel";
import { StatusPanel } from "./panels/StatusPanel";
import { WatchlistPanel } from "./panels/WatchlistPanel";
import { useCatalogLoader } from "./useCatalogLoader";
import { usePersistentState } from "./usePersistentState";
import { usePropagationWorker } from "./usePropagationWorker";

export default function SatelliteExplorer() {
  // "zh" is the SSR/hydration snapshot; the browser language is only used as a
  // client-side fallback once running, and a stored choice always wins.
  const [locale, setLocale] = usePersistentState<Locale>(LOCALE_KEY, "zh", initialLocale());
  const t = copy[locale];
  const {
    catalogs,
    catalogError,
    loadedGroups,
    loadingGroups,
    loadErrors,
    toggleGroup,
    refreshLoaded,
    loadAllGroups,
    unloadAllGroups
  } = useCatalogLoader();
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = usePersistentState<ClassFilter>(CLASS_FILTER_KEY, "all");
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
  const [watchlist, setWatchlist] = usePersistentState<string[]>(WATCHLIST_KEY, EMPTY_WATCHLIST);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const globeRef = useRef<GlobeSceneHandle>(null);
  // Scans run on their own worker: a 16k-object close-approach sweep takes
  // seconds, and sharing a thread with propagation would freeze the globe.
  const scanWorkerRef = useRef<Worker | null>(null);
  const scanRequestIdRef = useRef(0);
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
    const rows: IndexedRecord[] = [];
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

  const {
    workerObjects,
    propagationError,
    retryPropagation,
    workerNonce,
    recordsVersionRef
  } = usePropagationWorker(indexedRecords, recordMeta, sceneTime);

  const debrisGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const catalog of AVAILABLE_CATALOGS) {
      if (catalog.includesDebris) ids.add(catalog.id);
    }
    return ids;
  }, []);

  const recordByNorad = useMemo(() => {
    const map = new Map<string, { groupId: string; record: OmmRecord; catalog: CatalogDefinition }>();
    for (const row of indexedRecords) map.set(String(row.record.NORAD_CAT_ID), row);
    return map;
  }, [indexedRecords]);

  const metaById = useMemo(() => new Map(recordMeta.map((meta) => [meta.id, meta])), [recordMeta]);

  // Catalog membership is authoritative even while propagation is pending or
  // failed. Keep shared NORAD ids, but never render telemetry for unloaded ids.
  const loadedObjects = useMemo(() => {
    const rows: PropagatedObject[] = [];
    for (const object of workerObjects) {
      const meta = metaById.get(object.id);
      if (!meta) continue;
      rows.push(object.groupId === meta.groupId ? object : { ...object, ...meta });
    }
    return rows;
  }, [metaById, workerObjects]);

  const propagated = useMemo(() => {
    const needle = normalizeText(query);
    const rows: PropagatedObject[] = [];

    for (const object of loadedObjects) {
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
  }, [altitudeMax, altitudeMin, classFilter, debrisGroupIds, query, showDebris, loadedObjects]);

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
    for (const obj of loadedObjects) {
      if (watchlist.includes(obj.id)) map.set(obj.id, obj);
    }
    return watchlist.map((id) => map.get(id) ?? null);
  }, [watchlist, loadedObjects]);

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
      worker = new Worker(new URL("@/lib/workers/propagationWorker.ts", import.meta.url), { type: "module" });
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
    workerNonce,
    recordsVersionRef
  ]);

  useEffect(() => {
    if (!selectedId || !recordByNorad.has(selectedId)) {
      setSelectedId(propagated[0]?.id ?? null);
    }
  }, [propagated, recordByNorad, selectedId]);

  const handleScreenshot = () => {
    globeRef.current?.takeScreenshot();
  };

  const rescanRendezvous = () => setScanNonce((value) => value + 1);

  const goLive = () => {
    setIsPlaying(true);
    setSpeedIndex(1);
    setSceneTime(new Date());
  };

  const timeOffsetHours = Math.round((sceneTime.getTime() - Date.now()) / 3_600_000);
  const isLive = isPlaying && speedIndex === 1 && timeOffsetHours === 0;
  const displayCatalogs: CatalogSummary[] = catalogs.length ? catalogs : fallbackCatalogs();

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
        <ShortcutsOverlay t={t} onClose={() => setShowShortcuts(false)} />
      ) : null}

      <aside className={clsx("sidebar", leftRailCollapsed && "side-collapsed")}>
        <div className="brand-row">
          <div className="brand-mark" title={t.appName}>
            <Satellite size={22} />
          </div>
          {!leftRailCollapsed ? (
            <div className="brand-copy">
              <h1>{t.appName}</h1>
              <p>
                {t.subtitle}
                {IS_SNAPSHOT_MODE ? ` · ${t.dataSnapshot}` : ""}
              </p>
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

            <CatalogPanel
              t={t}
              locale={locale}
              collapsed={collapsedPanels.catalogs}
              onToggle={togglePanel}
              catalogs={displayCatalogs}
              loadedGroups={loadedGroups}
              loadingGroups={loadingGroups}
              loadErrors={loadErrors}
              catalogError={catalogError}
              dataNowMs={dataNowMs}
              onToggleGroup={toggleGroup}
              onLoadAll={loadAllGroups}
              onUnloadAll={unloadAllGroups}
            />
          </>
        ) : null}
      </aside>

      <section className="stage">
        <ExplorerTopBar
          t={t}
          indexedCount={indexedRecords.length}
          visibleCount={propagated.length}
          sceneTime={sceneTime}
          autoRotate={autoRotate}
          onToggleAutoRotate={() => setAutoRotate((value) => !value)}
          onToggleLocale={() => setLocale(locale === "zh" ? "en" : "zh")}
          onRefresh={() => void refreshLoaded()}
          onScreenshot={handleScreenshot}
          onToggleShortcuts={() => setShowShortcuts((v) => !v)}
        />

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
          <div
            className="panel"
            role="alert"
            style={{ position: "absolute", top: 78, left: 16, right: 16, zIndex: 5 }}
          >
            <p className="error-text">
              {t.propagationFailed}: {propagationError}
            </p>
            <button className="text-button" type="button" onClick={retryPropagation}>
              {t.retry}
            </button>
          </div>
        ) : null}

        <ExplorerLegend t={t} />

        <TimeTimeline
          t={t}
          isPlaying={isPlaying}
          isLive={isLive}
          timeOffsetHours={timeOffsetHours}
          speedIndex={speedIndex}
          onTogglePlay={() => setIsPlaying((value) => !value)}
          onScrub={(hours) => {
            setIsPlaying(false);
            setSceneTime(new Date(Date.now() + hours * 3_600_000));
          }}
          onGoLive={goLive}
          onSpeedChange={setSpeedIndex}
        />
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
            <FilterPanel
              t={t}
              collapsed={collapsedPanels.filters}
              onToggle={togglePanel}
              classFilter={classFilter}
              onClassFilterChange={setClassFilter}
              showDebris={showDebris}
              onShowDebrisChange={setShowDebris}
              altitudeMin={altitudeMin}
              altitudeMax={altitudeMax}
              onAltitudeMinChange={setAltitudeMin}
              onAltitudeMaxChange={setAltitudeMax}
            />

            <AnalysisPanel
              t={t}
              collapsed={collapsedPanels.analysis}
              onToggle={togglePanel}
              analysisTab={analysisTab}
              onAnalysisTabChange={setAnalysisTab}
              selectedObject={selectedObject}
              selectedRecord={selectedRecord}
              selectedId={selectedId}
              onSelect={setSelectedId}
              primaryQuery={primaryQuery}
              onPrimaryQueryChange={setPrimaryQuery}
              primaryCandidates={primaryCandidates}
              rendezvousWindowHours={rendezvousWindowHours}
              onRendezvousWindowHoursChange={setRendezvousWindowHours}
              rendezvousMaxMissKm={rendezvousMaxMissKm}
              onRendezvousMaxMissKmChange={setRendezvousMaxMissKm}
              rendezvousHits={rendezvousHits}
              rendezvousScanning={rendezvousScanning}
              scanError={scanError}
              scanProgress={scanProgress}
              scanAnchor={scanAnchor}
              expandedHitKey={expandedHitKey}
              onExpandedHitKeyChange={setExpandedHitKey}
              onRescan={rescanRendezvous}
              observerLat={observerLat}
              observerLon={observerLon}
              onObserverLatChange={setObserverLat}
              onObserverLonChange={setObserverLon}
              minElevationDeg={minElevationDeg}
              onMinElevationDegChange={setMinElevationDeg}
              locating={locating}
              locationError={locationError}
              onRequestLocation={requestLocation}
              passes={passes}
            />

            <SelectedPanel
              t={t}
              collapsed={collapsedPanels.selected}
              onToggle={togglePanel}
              selectedObject={selectedObject}
              sceneTime={sceneTime}
              watchlist={watchlist}
              propagatedCount={propagated.length}
              onToggleWatchlist={toggleWatchlist}
              onExportOmm={exportSelectedOmm}
            />

            <WatchlistPanel
              t={t}
              collapsed={collapsedPanels.watchlist}
              onToggle={togglePanel}
              watchlist={watchlist}
              watchlistObjects={watchlistObjects}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onToggleWatchlist={toggleWatchlist}
            />

            <StatusPanel
              t={t}
              locale={locale}
              collapsed={collapsedPanels.status}
              onToggle={togglePanel}
              loadedGroups={loadedGroups}
              loadErrors={loadErrors}
              dataNowMs={dataNowMs}
            />
          </>
        ) : null}
      </aside>
    </main>
  );
}
