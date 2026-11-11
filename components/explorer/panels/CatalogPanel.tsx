"use client";

import clsx from "clsx";
import { AlertTriangle, Layers, Loader2 } from "lucide-react";

import { AVAILABLE_CATALOGS, IS_SNAPSHOT_MODE, snapshotIsStale } from "@/lib/data/dataAccess";
import { formatDateTimeShort } from "@/lib/ui/format";
import type { Copy, Locale } from "@/lib/ui/i18n";

import { PanelSection } from "../PanelSection";
import type {
  CatalogSummary,
  CollapsiblePanelId,
  LoadedGroup
} from "../explorerTypes";

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
          {t.fetchError}: {catalogError}
        </p>
      ) : null}
      {Object.entries(loadErrors).map(([groupId, error]) => (
        <p key={groupId} className="error-text" role="alert">
          {AVAILABLE_CATALOGS.find((catalog) => catalog.id === groupId)?.label[locale]}: {error}
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
