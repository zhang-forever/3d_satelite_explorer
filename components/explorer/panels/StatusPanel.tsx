"use client";

import { Fragment } from "react";
import { Database } from "lucide-react";

import { IS_SNAPSHOT_MODE, snapshotIsStale } from "@/lib/data/dataAccess";
import { formatDateTimeShort } from "@/lib/ui/format";
import type { Copy, Locale } from "@/lib/ui/i18n";

import { PanelSection } from "../PanelSection";
import type { CollapsiblePanelId, LoadedGroup } from "../explorerTypes";

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
              {t.fetchError}: {error}
            </p>
          ))}
        </>
      ) : null}
    </PanelSection>
  );
}
