import type { Copy } from "./i18n";

/**
 * Map upstream/cache failure text to a translated message.
 *
 * The server reports human-readable English so that operators see the detail in
 * logs and API responses; the UI shows a localized summary and keeps the raw
 * text as a tooltip. Unknown messages pass through unchanged rather than being
 * hidden.
 */
export function localizeCatalogError(t: Copy, message: string | null | undefined): string {
  if (!message) return "";
  if (/bundled snapshot/i.test(message)) return t.errorSnapshot;
  if (/timed out|timeout/i.test(message)) return t.errorTimeout;
  if (/\b(403|404)\b/.test(message)) return t.errorRejected;
  if (/invalid OMM|not valid JSON|invalid catalog response|Invalid GP catalog response/i.test(message)) {
    return t.errorInvalidData;
  }
  if (/cache (persistence )?unavailable|stored CelesTrak cache|could not be read or validated/i.test(message)) {
    return t.errorCache;
  }
  if (/CelesTrak returned \d{3}|Unable to fetch (GP data|CelesTrak data)|Unable to load catalog|failed to fetch/i.test(message)) {
    return t.errorUpstream;
  }
  return message;
}
