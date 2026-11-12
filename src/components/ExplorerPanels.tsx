"use client";

import { Fragment } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Database,
  Layers,
  Loader2,
  SlidersHorizontal,
  Star,
  StarOff
} from "lucide-react";

import { AVAILABLE_CATALOGS, IS_SNAPSHOT_MODE, snapshotIsStale } from "@/lib/dataAccess";
import type { PropagatedObject } from "@/lib/orbit";
import { formatDateTimeShort, formatNumber } from "@/lib/format";
import type { Copy, Locale } from "@/lib/i18n";
import type { CatalogSummary, CollapsiblePanelId, LoadedGroup } from "@/lib/explorer-types";
import { localizeCatalogError } from "@/lib/errorMessages";

import { PanelSection } from "./ExplorerPanelSection";

type CatalogPanelProps = {
  t: Copy;
  locale: Locale;
  collapsed: boolean;
  onToggle: (panelId: CollapsiblePanelId) => void;
  catalogs: CatalogSummary[];
  loadedGroups: Record<string, LoadedGroup>;
  loadingGroups: Record<string, boolean>;
  loadErrors: Record<string, string>;
  catalogError: string | null;
  dataNowMs: number;
  onToggleGroup: (groupId: string) => void;
  onLoadAll: () => void;
  onUnloadAll: () => void;
};

export function CatalogPanel({
  t,
  locale,
  collapsed,
  onToggle,
  catalogs,
  loadedGroups,
  loadingGroups,
  loadErrors,
  catalogError,
  dataNowMs,
  onToggleGroup,
  onLoadAll,
  onUnloadAll
}: CatalogPanelProps) {
  const loadedGroupCount = catalogs.filter((catalog) => loadedGroups[catalog.id]).length;
  const busyGroupCount = catalogs.filter((catalog) => loadingGroups[catalog.id]).length;

  return (
    <PanelSection
      panelId="catalogs"
      className="catalog-panel"
      collapsed={collapsed}
      onToggle={onToggle}
      t={t}
      label={t.catalogs}
      title={
        <>
          <Layers size={16} />
          <span>{t.catalogs}</span>
          <small className="panel-count">
            {loadedGroupCount}/{catalogs.length}
          </small>
        </>
      }
      actions={
        <>
          <button
            className="mini-button"
            type="button"
            onClick={onLoadAll}
            disabled={busyGroupCount > 0 || loadedGroupCount === catalogs.length}
            title={t.loadAll}
          >
            {t.loadAll}
          </button>
          <button
            className="mini-button"
            type="button"
            onClick={onUnloadAll}
            disabled={loadedGroupCount === 0 && busyGroupCount === 0}
            title={t.unloadAll}
          >
            {t.unloadAll}
          </button>
        </>
      }
    >
      {IS_SNAPSHOT_MODE ? <p className="empty-state">{t.snapshotHint}</p> : null}
      {catalogError ? (
        <p className="error-text" role="alert">
          {t.fetchError}: <span title={catalogError}>{localizeCatalogError(t, catalogError)}</span>
        </p>
      ) : null}
      {Object.entries(loadErrors).map(([groupId, error]) => (
        <p key={groupId} className="error-text" role="alert">
          {AVAILABLE_CATALOGS.find((catalog) => catalog.id === groupId)?.label[locale]}:{" "}
          <span title={error}>{localizeCatalogError(t, error)}</span>
        </p>
      ))}
      {busyGroupCount > 0 ? (
        <div className="load-progress" role="status" aria-live="polite">
          <span
            className="load-progress-bar"
            style={{ width: `${(loadedGroupCount / catalogs.length) * 100}%` }}
          />
          <small>{t.loading}</small>
        </div>
      ) : null}
      {!collapsed ? (
        <div className="catalog-list">
          {catalogs.map((catalog) => {
            const loaded = loadedGroups[catalog.id];
            const loading = loadingGroups[catalog.id];
            const error = loadErrors[catalog.id] ?? loaded?.error;
            const fetchedAt = loaded?.fetchedAt ?? catalog.fetchedAt;
            return (
              <button
                key={catalog.id}
                className={clsx("catalog-item", loaded && "active", loading && "pending")}
                onClick={() => onToggleGroup(catalog.id)}
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
                    <small>
                      {t.dataFetchedAt}:{" "}
                      <time dateTime={fetchedAt}>{formatDateTimeShort(fetchedAt)}</time>
                    </small>
                  ) : null}
                </span>
                <span className="catalog-meta" aria-busy={Boolean(loading)}>
                  {loading ? <Loader2 className="spin" size={15} /> : loaded ? t.loaded : t.load}
                  <small>
                    {loaded?.records.length ?? catalog.cachedCount ?? 0} {t.objects}
                  </small>
                  {IS_SNAPSHOT_MODE && fetchedAt && snapshotIsStale(loaded ?? catalog, dataNowMs) ? (
                    <small>{t.snapshotStale}</small>
                  ) : null}
                  {error ? <AlertTriangle size={14} /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </PanelSection>
  );
}

export type ClassFilter = "all" | "payload" | "debris" | "rocket" | "unknown";

type FilterPanelProps = {
  t: Copy;
  collapsed: boolean;
  onToggle: (panelId: CollapsiblePanelId) => void;
  classFilter: ClassFilter;
  onClassFilterChange: (value: ClassFilter) => void;
  showDebris: boolean;
  onShowDebrisChange: (value: boolean) => void;
  altitudeMin: number;
  altitudeMax: number;
  onAltitudeMinChange: (value: number) => void;
  onAltitudeMaxChange: (value: number) => void;
};

export function FilterPanel({
  t,
  collapsed,
  onToggle,
  classFilter,
  onClassFilterChange,
  showDebris,
  onShowDebrisChange,
  altitudeMin,
  altitudeMax,
  onAltitudeMinChange,
  onAltitudeMaxChange
}: FilterPanelProps) {
  return (
    <PanelSection
      panelId="filters"
      className="filter-panel"
      collapsed={collapsed}
      onToggle={onToggle}
      t={t}
      label={t.filter}
      title={
        <>
          <SlidersHorizontal size={16} />
          <span>{t.filter}</span>
        </>
      }
    >
      {!collapsed ? (
        <div className="filter-body">
          <div className="segmented">
            {(["all", "payload", "debris", "rocket", "unknown"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={classFilter === value ? "active" : ""}
                onClick={() => onClassFilterChange(value)}
              >
                {t[value]}
              </button>
            ))}
          </div>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={showDebris}
              onChange={(event) => onShowDebrisChange(event.target.checked)}
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
                onChange={(event) => onAltitudeMinChange(Number(event.target.value))}
              />
            </label>
            <label>
              <small>{t.maxLabel}</small>
              <input
                type="number"
                value={altitudeMax}
                min={altitudeMin}
                step={50}
                onChange={(event) => onAltitudeMaxChange(Number(event.target.value))}
              />
            </label>
          </div>
        </div>
      ) : null}
    </PanelSection>
  );
}

type StatusPanelProps = {
  t: Copy;
  locale: Locale;
  collapsed: boolean;
  onToggle: (panelId: CollapsiblePanelId) => void;
  loadedGroups: Record<string, LoadedGroup>;
  loadErrors: Record<string, string>;
  dataNowMs: number;
};

export function StatusPanel({
  t,
  locale,
  collapsed,
  onToggle,
  loadedGroups,
  loadErrors,
  dataNowMs
}: StatusPanelProps) {
  return (
    <PanelSection
      panelId="status"
      className="status-panel"
      collapsed={collapsed}
      onToggle={onToggle}
      t={t}
      label={t.sourceStatus}
      title={
        <>
          <Database size={16} />
          <span>{t.sourceStatus}</span>
        </>
      }
    >
      {!collapsed ? (
        <>
          {Object.values(loadedGroups).length ? (
            Object.values(loadedGroups).map((group) => (
              <Fragment key={group.catalog.id}>
                <div className="status-row">
                  <span>{group.catalog.label[locale]}</span>
                  <strong>
                    {IS_SNAPSHOT_MODE ? (
                      <>
                        <span>{t.dataSnapshot}</span>
                        {snapshotIsStale(group, dataNowMs) ? (
                          <>
                            {" "}
                            · <span>{t.snapshotStale}</span>
                          </>
                        ) : null}
                      </>
                    ) : group.stale ? (
                      t.stale
                    ) : (
                      t.updated
                    )}
                  </strong>
                </div>
                {IS_SNAPSHOT_MODE && group.sourceUpdatedAt ? (
                  <div className="status-row">
                    <span>{t.latestEpoch}</span>
                    <time dateTime={group.sourceUpdatedAt}>
                      {formatDateTimeShort(group.sourceUpdatedAt)}
                    </time>
                  </div>
                ) : null}
              </Fragment>
            ))
          ) : (
            <p className="empty-state">{t.loading}</p>
          )}
          {Object.entries(loadErrors).map(([groupId, error]) => (
            <p key={groupId} className="error-text">
              {t.fetchError}: <span title={error}>{localizeCatalogError(t, error)}</span>
            </p>
          ))}
        </>
      ) : null}
    </PanelSection>
  );
}

type WatchlistPanelProps = {
  t: Copy;
  collapsed: boolean;
  onToggle: (panelId: CollapsiblePanelId) => void;
  watchlist: string[];
  /** Same order as `watchlist`; `null` means the object is not loaded right now. */
  watchlistObjects: Array<PropagatedObject | null>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleWatchlist: (id: string) => void;
};

export function WatchlistPanel({
  t,
  collapsed,
  onToggle,
  watchlist,
  watchlistObjects,
  selectedId,
  onSelect,
  onToggleWatchlist
}: WatchlistPanelProps) {
  return (
    <PanelSection
      panelId="watchlist"
      className="watchlist-panel"
      collapsed={collapsed}
      onToggle={onToggle}
      t={t}
      label={t.watchlist}
      title={
        <>
          <Star size={16} />
          <span>{t.watchlist}</span>
          <small>({watchlist.length})</small>
        </>
      }
    >
      {!collapsed ? (
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
                      onClick={() => onToggleWatchlist(id)}
                      title={t.removeFromWatchlist}
                    >
                      <StarOff size={14} />
                    </button>
                  </div>
                );
              }
              return (
                <div key={id} className={clsx("candidate-item", selectedId === id && "active")}>
                  <button
                    type="button"
                    className="candidate-summary"
                    onClick={() => onSelect(id)}
                  >
                    <span>{obj.name}</span>
                    <small>
                      {formatNumber(obj.altitudeKm, 0)} km · {obj.speedKmS.toFixed(2)} km/s
                    </small>
                  </button>
                  <button
                    type="button"
                    className="icon-button compact"
                    onClick={() => onToggleWatchlist(id)}
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
    </PanelSection>
  );
}
