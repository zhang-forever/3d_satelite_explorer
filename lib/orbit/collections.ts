/** Record-set helpers shared by the catalogs and the propagation input. */
import type { OmmRecord } from "./types";

export function dedupeByNorad<T extends { record: OmmRecord }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    const id = String(row.record.NORAD_CAT_ID);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(row);
  }
  return unique;
}
