"use client";

import clsx from "clsx";
import {
  Clock3,
  Database,
  Home,
  Languages,
  LocateFixed,
  RefreshCw,
  RotateCw
} from "lucide-react";

import { IS_SNAPSHOT_MODE } from "@/lib/dataAccess";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { Copy } from "@/lib/i18n";

type ExplorerTopBarProps = {
  t: Copy;
  indexedCount: number;
  visibleCount: number;
  sceneTime: Date;
  busy?: boolean;
  autoRotate: boolean;
  onToggleAutoRotate: () => void;
  onToggleLocale: () => void;
  onRefresh: () => void;
  /** Fly back to the opening overview; also leaves the chase view. */
  onResetView: () => void;
};

export function ExplorerTopBar({
  t,
  indexedCount,
  visibleCount,
  sceneTime,
  busy = false,
  autoRotate,
  onToggleAutoRotate,
  onToggleLocale,
  onRefresh,
  onResetView
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
        className="icon-button"
        type="button"
        onClick={onResetView}
        title={t.resetView}
        aria-label={t.resetView}
      >
        <Home size={18} />
      </button>
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
        aria-busy={busy}
        title={IS_SNAPSHOT_MODE ? t.refreshSnapshot : t.refresh}
      >
        <RefreshCw size={18} className={busy ? "spin" : undefined} />
      </button>
    </div>
  );
}
