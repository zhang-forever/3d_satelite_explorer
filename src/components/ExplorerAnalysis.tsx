"use client";

import clsx from "clsx";
import {
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Radar,
  Satellite,
  Search,
  Star,
  StarOff,
  Telescope
} from "lucide-react";

import {
  dataAgeHours,
  parseOmmEpoch,
  type OmmRecord,
  type PropagatedObject,
  type RendezvousScanHit
} from "@/lib/orbit";
import { azimuthToCompass, type PassWindow } from "@/lib/passes";
import { formatDateTimeShort, formatNumber } from "@/lib/format";
import type { Copy } from "@/lib/i18n";
import type { AnalysisTab, CollapsiblePanelId } from "@/lib/explorer-types";

import { PanelSection } from "./ExplorerPanelSection";

export type PrimaryCandidate = { groupId: string; record: OmmRecord };

type AnalysisPanelProps = {
  t: Copy;
  collapsed: boolean;
  onToggle: (panelId: CollapsiblePanelId) => void;
  analysisTab: AnalysisTab;
  onAnalysisTabChange: (tab: AnalysisTab) => void;
  selectedObject: PropagatedObject | null;
  selectedRecord: PrimaryCandidate | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  primaryQuery: string;
  onPrimaryQueryChange: (value: string) => void;
  primaryCandidates: PrimaryCandidate[];
  rendezvousWindowHours: number;
  onRendezvousWindowHoursChange: (hours: number) => void;
  rendezvousMaxMissKm: number;
  onRendezvousMaxMissKmChange: (km: number) => void;
  rendezvousHits: RendezvousScanHit[];
  rendezvousScanning: boolean;
  scanError: string | null;
  scanProgress: number;
  scanAnchor: Date | null;
  expandedHitKey: string | null;
  onExpandedHitKeyChange: (key: string | null) => void;
  onRescan: () => void;
  observerLat: number;
  observerLon: number;
  onObserverLatChange: (value: number) => void;
  onObserverLonChange: (value: number) => void;
  minElevationDeg: number;
  onMinElevationDegChange: (value: number) => void;
  locating: boolean;
  locationError: string | null;
  onRequestLocation: () => void;
  passes: PassWindow[];
};

export function AnalysisPanel({
  t,
  collapsed,
  onToggle,
  analysisTab,
  onAnalysisTabChange,
  selectedObject,
  selectedRecord,
  selectedId,
  onSelect,
  primaryQuery,
  onPrimaryQueryChange,
  primaryCandidates,
  rendezvousWindowHours,
  onRendezvousWindowHoursChange,
  rendezvousMaxMissKm,
  onRendezvousMaxMissKmChange,
  rendezvousHits,
  rendezvousScanning,
  scanError,
  scanProgress,
  scanAnchor,
  expandedHitKey,
  onExpandedHitKeyChange,
  onRescan,
  observerLat,
  observerLon,
  onObserverLatChange,
  onObserverLonChange,
  minElevationDeg,
  onMinElevationDegChange,
  locating,
  locationError,
  onRequestLocation,
  passes
}: AnalysisPanelProps) {
  return (
    <PanelSection
      panelId="analysis"
      className="analysis-panel"
      collapsed={collapsed}
      onToggle={onToggle}
      t={t}
      label={t.analysis}
      title={
        <>
          <Radar size={16} />
          <span>{t.analysis}</span>
        </>
      }
    >
      {!collapsed ? (
        <>
          <div className="segmented analysis-tabs">
            <button
              type="button"
              className={analysisTab === "rendezvous" ? "active" : ""}
              onClick={() => onAnalysisTabChange("rendezvous")}
            >
              <Radar size={14} /> {t.rendezvous}
            </button>
            <button
              type="button"
              className={analysisTab === "passes" ? "active" : ""}
              onClick={() => onAnalysisTabChange("passes")}
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
                  onChange={(event) => onPrimaryQueryChange(event.target.value)}
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
                          onSelect(id);
                          onPrimaryQueryChange("");
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
                  onChange={(event) => onRendezvousWindowHoursChange(Number(event.target.value))}
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
                  onChange={(event) => onRendezvousMaxMissKmChange(Number(event.target.value))}
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
                  onClick={onRescan}
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
              {scanError ? (
                <p className="error-text" role="alert">
                  {t.scanFailed}: {scanError}
                </p>
              ) : null}
              {!selectedRecord ? (
                <p className="empty-state">{t.needSelection}</p>
              ) : scanError ? null : rendezvousHits.length === 0 ? (
                rendezvousScanning ? null : <p className="empty-state">{t.noRendezvous}</p>
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
                            onClick={() => onExpandedHitKeyChange(expanded ? null : key)}
                          >
                            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                          <button
                            type="button"
                            className="hit-row-summary"
                            onClick={() => onSelect(hit.noradId)}
                          >
                            <strong>{hit.name}</strong>
                            <span>{formatNumber(hit.missDistanceKm, 1)} km</span>
                          </button>
                        </div>
                        {expanded ? (
                          <div className="pass-row-body hit-row-body">
                            <span>
                              {t.closestApproach} {formatDateTimeShort(hit.closestAt)}
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
                              {t.currentSeparation} {formatNumber(hit.currentDistanceKm, 0)} km
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
                    onChange={(event) => onObserverLatChange(Number(event.target.value))}
                  />
                </label>
                <label>
                  <small>{t.longitudeLabel}</small>
                  <input
                    type="number"
                    step={0.0001}
                    value={observerLon}
                    onChange={(event) => onObserverLonChange(Number(event.target.value))}
                  />
                </label>
                <button
                  type="button"
                  className="text-button"
                  onClick={onRequestLocation}
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
                  onChange={(event) => onMinElevationDegChange(Number(event.target.value))}
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
    </PanelSection>
  );
}

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
