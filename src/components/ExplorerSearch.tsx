"use client";

import { Search } from "lucide-react";

import type { PropagatedObject } from "@/lib/orbit";
import { formatNumber } from "@/lib/format";
import type { Copy } from "@/lib/i18n";

type ExplorerSearchProps = {
  t: Copy;
  query: string;
  onQueryChange: (value: string) => void;
  results: PropagatedObject[];
  onSelect: (id: string) => void;
};

/** Search page: filters the globe and lists the matching objects. */
export function ExplorerSearch({
  t,
  query,
  onQueryChange,
  results,
  onSelect
}: ExplorerSearchProps) {
  return (
    <div className="drawer-search">
      <div className="search-box">
        <Search size={17} />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t.searchPlaceholder}
          aria-label={t.searchPlaceholder}
          autoFocus
        />
      </div>

      {query.trim() ? (
        results.length ? (
          <div className="search-results">
            {results.map((object) => (
              <button
                key={object.id}
                className="search-result"
                type="button"
                onClick={() => onSelect(object.id)}
              >
                <span className="search-result-name">{object.name}</span>
                <span className="search-result-meta">
                  <small>{object.noradId}</small>
                  <small>{formatNumber(object.altitudeKm, 0)} km</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="empty-state">{t.noSearchResults}</p>
        )
      ) : (
        <p className="empty-state">{t.searchPlaceholder}</p>
      )}
    </div>
  );
}
