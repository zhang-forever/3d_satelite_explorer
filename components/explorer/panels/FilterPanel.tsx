"use client";

import { SlidersHorizontal } from "lucide-react";

import type { Copy } from "@/lib/ui/i18n";

import { PanelSection } from "../PanelSection";
import type { CollapsiblePanelId } from "../explorerTypes";

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
