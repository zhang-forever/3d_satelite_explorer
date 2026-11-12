import type { ObjectClass } from "@/lib/orbit";

import type { CollapsiblePanelId } from "@/lib/explorer-types";

export const RENDER_LIMIT = 16000;
export const SPEEDS = [0, 1, 10, 60, 600];
export const CATALOG_SHORTCUT_KEYS = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
  "q", "w", "e", "r", "t", "y", "u", "i"
];

// localStorage keys for the persisted UI preferences.
export const WATCHLIST_KEY = "orbital-field:watchlist";
export const LOCALE_KEY = "orbital-field:locale";
export const LEFT_RAIL_KEY = "orbital-field:left-rail";
export const RIGHT_RAIL_KEY = "orbital-field:right-rail";
export const PANELS_KEY = "orbital-field:panels";
export const AUTO_ROTATE_KEY = "orbital-field:auto-rotate";
export const CLASS_FILTER_KEY = "orbital-field:class-filter";
export const SHOW_DEBRIS_KEY = "orbital-field:show-debris";

// Derived-work cadence. The scene clock ticks at 1 Hz, but neither the full
// 48 h pass list nor a freshly sampled orbit needs recomputing that often —
// they only care about the minute / few seconds respectively.
export const TRACK_TICK_MS = 5_000;
export const PASSES_TICK_MS = 60_000;
export const DATA_REQUEST_TIMEOUT_MS = 30_000;

export const DEFAULT_COLLAPSED_PANELS: Record<CollapsiblePanelId, boolean> = {
  catalogs: false,
  filters: false,
  analysis: false,
  selected: false,
  status: true,
  watchlist: false
};

/** Stable reference required as the `usePersistentState` default. */
export const EMPTY_WATCHLIST: string[] = [];

export const LEGEND_CLASSES: ObjectClass[] = ["payload", "debris", "rocket", "unknown"];
