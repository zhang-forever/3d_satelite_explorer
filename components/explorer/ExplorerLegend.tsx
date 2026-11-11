"use client";

import { OBJECT_CLASS_COLORS } from "@/lib/orbit";
import type { Copy } from "@/lib/ui/i18n";

import { LEGEND_CLASSES } from "./explorerConstants";

type ExplorerLegendProps = {
  t: Copy;
};

export function ExplorerLegend({ t }: ExplorerLegendProps) {
  return (
    <div className="legend" aria-label={t.legend}>
      <span className="legend-title">{t.legend}</span>
      <ul>
        {LEGEND_CLASSES.map((objectClassKey) => (
          <li key={objectClassKey}>
            <span
              className="legend-dot"
              style={{ backgroundColor: OBJECT_CLASS_COLORS[objectClassKey] }}
              aria-hidden
            />
            {t[objectClassKey]}
          </li>
        ))}
        <li className="legend-separator" aria-hidden />
        <li>
          <span className="legend-line amber" aria-hidden />
          {t.orbitTrack}
        </li>
        <li>
          <span className="legend-line pale" aria-hidden />
          {t.groundTrack}
        </li>
        <li>
          <span className="legend-dot observer" aria-hidden />
          {t.observerLocation}
        </li>
      </ul>
    </div>
  );
}
