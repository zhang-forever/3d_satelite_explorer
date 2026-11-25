"use client";

import type { ComponentType } from "react";
import {
  Database,
  Layers,
  Radar,
  Search,
  Settings2,
  SlidersHorizontal,
  Star,
  Satellite
} from "lucide-react";

import type { DrawerId } from "@/lib/explorer-types";
import type { Copy } from "@/lib/i18n";

type RailItem = {
  id: DrawerId;
  label: string;
  icon: ComponentType<{ size?: number }>;
  badge?: number;
  attention?: boolean;
};

type ExplorerRailProps = {
  t: Copy;
  active: DrawerId | null;
  watchlistCount: number;
  sourceAlert: boolean;
  onSelect: (id: DrawerId) => void;
};

/**
 * Slim navigation rail. Each button opens exactly one drawer page; pressing
 * the active button again closes it.
 */
export function ExplorerRail({
  t,
  active,
  watchlistCount,
  sourceAlert,
  onSelect
}: ExplorerRailProps) {
  const items: RailItem[] = [
    { id: "catalogs", label: t.catalogs, icon: Layers },
    { id: "search", label: t.search, icon: Search },
    { id: "filters", label: t.filter, icon: SlidersHorizontal },
    { id: "analysis", label: t.analysis, icon: Radar },
    { id: "watchlist", label: t.watchlist, icon: Star, badge: watchlistCount },
    { id: "status", label: t.sourceStatus, icon: Database, attention: sourceAlert }
  ];

  const renderItem = (item: RailItem) => {
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        className="rail-button"
        type="button"
        aria-label={item.label}
        aria-pressed={active === item.id}
        title={item.label}
        onClick={() => onSelect(item.id)}
      >
        <Icon size={18} />
        {item.badge ? <span className="rail-badge">{item.badge}</span> : null}
        {item.attention ? <span className="rail-dot" aria-hidden /> : null}
      </button>
    );
  };

  return (
    <nav className="nav-rail" aria-label={t.appName}>
      <div className="rail-brand" title={t.appName} aria-hidden>
        <Satellite size={20} />
      </div>
      <div className="rail-group">{items.map(renderItem)}</div>
      <div className="rail-group rail-bottom">
        {renderItem({ id: "tools", label: t.tools, icon: Settings2 })}
      </div>
    </nav>
  );
}
