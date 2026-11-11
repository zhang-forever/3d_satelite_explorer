"use client";

import { Download, Satellite, Star, StarOff } from "lucide-react";

import { dataAgeHours, parseOmmEpoch, type PropagatedObject } from "@/lib/orbit";
import { formatDateTimeShort, formatNumber } from "@/lib/ui/format";
import type { Copy } from "@/lib/ui/i18n";

import { PanelSection } from "../PanelSection";
import type { CollapsiblePanelId } from "../explorerTypes";

type SelectedPanelProps = {
  t: Copy;
  collapsed: boolean;
  onToggle: (panelId: CollapsiblePanelId) => void;
  selectedObject: PropagatedObject | null;
  sceneTime: Date;
  watchlist: string[];
  propagatedCount: number;
  onToggleWatchlist: (id: string) => void;
  onExportOmm: () => void;
};

export function SelectedPanel({
  t,
  collapsed,
  onToggle,
  selectedObject,
  sceneTime,
  watchlist,
  propagatedCount,
  onToggleWatchlist,
  onExportOmm
}: SelectedPanelProps) {
  return (
    <PanelSection
      panelId="selected"
      className="selected-panel"
      collapsed={collapsed}
      onToggle={onToggle}
      t={t}
      label={selectedObject ? t.selected : t.noSelection}
      title={
        <>
          <Satellite size={16} />
          <span>{selectedObject ? t.selected : t.noSelection}</span>
        </>
      }
    >
      {!collapsed && selectedObject ? (
        <>
          <div className="selected-head">
            <h2>{selectedObject.name}</h2>
            <div className="selected-head-actions">
              <button
                type="button"
                className="icon-button compact"
                onClick={onExportOmm}
                title={t.exportOmm}
                aria-label={t.exportOmm}
              >
                <Download size={16} />
              </button>
              <button
                type="button"
                className="icon-button compact"
                onClick={() => onToggleWatchlist(selectedObject.id)}
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
            <strong>
              {formatDateTimeShort(parseOmmEpoch(selectedObject.epoch) ?? Number.NaN)}
            </strong>
            <span>{t.latitude}</span>
            <strong>{selectedObject.latitude.toFixed(3)} deg</strong>
            <span>{t.longitude}</span>
            <strong>{selectedObject.longitude.toFixed(3)} deg</strong>
            <span>{t.altitudeKm}</span>
            <strong>{formatNumber(selectedObject.altitudeKm, 1)} km</strong>
            <span>{t.velocity}</span>
            <strong>{selectedObject.speedKmS.toFixed(3)} km/s</strong>
            <span>{t.dataAge}</span>
            <strong>
              {formatNumber(Math.abs(dataAgeHours(selectedObject.epoch, sceneTime) ?? 0), 1)} h
            </strong>
            <span>{t.trackFrame}</span>
            <strong>{t.inertialTrack}</strong>
          </div>
        </>
      ) : !collapsed ? (
        <p className="empty-state">{propagatedCount ? t.noSelection : t.noMatches}</p>
      ) : null}
    </PanelSection>
  );
}
