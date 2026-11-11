"use client";

import clsx from "clsx";
import {
  Camera,
  Clock3,
  Database,
  HelpCircle,
  Languages,
  LocateFixed,
  RefreshCw,
  RotateCw
} from "lucide-react";

import { IS_SNAPSHOT_MODE } from "@/lib/data/dataAccess";
import { formatDateTime, formatNumber } from "@/lib/ui/format";
import type { Copy } from "@/lib/ui/i18n";

type ExplorerTopBarProps = {
  t: Copy;
  indexedCount: number;
  visibleCount: number;
  sceneTime: Date;
  autoRotate: boolean;
  onToggleAutoRotate: () => void;
  onToggleLocale: () => void;
  onRefresh: () => void;
  onScreenshot: () => void;
  onToggleShortcuts: () => void;
};

export function ExplorerTopBar({
  t,
  indexedCount,
  visibleCount,
  sceneTime,
  autoRotate,
  onToggleAutoRotate,
  onToggleLocale,
  onRefresh,
  onScreenshot,
  onToggleShortcuts
}: ExplorerTopBarProps) {
  return (
    <div className="topbar">
      <div className="metric">
        <Database size={16} />
        <span>{formatNumber(indexedCount)}</span>
        <small>{t.objects}</small>
      </div>
      <div className="metric">
        <LocateFixed size={16} />
        <span data-testid="propagated-count">{formatNumber(visibleCount)}</span>
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
        onClick={onToggleAutoRotate}
        aria-pressed={autoRotate}
        title={`${t.autoRotate} (A)`}
      >
        <RotateCw size={18} />
      </button>
      <button className="icon-button" type="button" onClick={onToggleLocale} title={t.language}>
        <Languages size={18} />
      </button>
      <button
        className="icon-button"
        type="button"
        onClick={onRefresh}
        title={IS_SNAPSHOT_MODE ? t.refreshSnapshot : t.refresh}
      >
        <RefreshCw size={18} />
      </button>
      <button className="icon-button" type="button" onClick={onScreenshot} title={t.screenshot}>
        <Camera size={18} />
      </button>
      <button
        className="icon-button"
        type="button"
        onClick={onToggleShortcuts}
        title={t.keyboardShortcuts}
      >
        <HelpCircle size={18} />
      </button>
    </div>
  );
}
