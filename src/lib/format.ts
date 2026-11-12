// Cached Intl formatters.
//
// `new Intl.NumberFormat(...)` is surprisingly expensive: it resolves the
// locale, builds a pattern tree and instantiates a plural-rules object. The UI
// formats hundreds of values on every render (metrics, altitudes, hit list,
// watchlist), so allocating a formatter per call used to be one of the largest
// single costs of a re-render. One instance per digit-count is enough.

const numberFormats = new Map<number, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function clampDigits(digits: number) {
  if (!Number.isFinite(digits)) return 0;
  return Math.max(0, Math.min(6, Math.trunc(digits)));
}

export function formatNumber(value: number, digits = 0) {
  const key = clampDigits(digits);
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: key,
      minimumFractionDigits: key
    });
    numberFormats.set(key, formatter);
  }
  return formatter.format(Number.isFinite(value) ? value : 0);
}

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
};

function dateTimeFormat(kind: "full" | "short") {
  let formatter = dateTimeFormats.get(kind);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      undefined,
      kind === "full" ? DATE_TIME_OPTIONS : undefined
    );
    dateTimeFormats.set(kind, formatter);
  }
  return formatter;
}

function toDate(value: string | number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** `2026/06/15 12:19:10` — used for the scene clock and epoch fields. */
export function formatDateTime(value: string | number | Date) {
  const date = toDate(value);
  return date ? dateTimeFormat("full").format(date) : "-";
}

/** Browser-default date + time, equivalent to `toLocaleString()` but cached. */
export function formatDateTimeShort(value: string | number | Date) {
  const date = toDate(value);
  return date ? dateTimeFormat("short").format(date) : "-";
}
