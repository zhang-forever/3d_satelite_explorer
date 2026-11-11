"use client";

import clsx from "clsx";
import { Star, StarOff } from "lucide-react";

import type { PropagatedObject } from "@/lib/orbit";
import { formatNumber } from "@/lib/ui/format";
import type { Copy } from "@/lib/ui/i18n";

import { PanelSection } from "../PanelSection";
import type { CollapsiblePanelId } from "../explorerTypes";

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
