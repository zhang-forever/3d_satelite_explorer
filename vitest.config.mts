/**
 * Vitest auto-loads a config from the project root. Re-exporting the real
 * configuration here means `npx vitest run` (and single-file runs without
 * `--config`) resolves the `@/` alias exactly like `npm test` does, instead
 * of silently falling back to a default config with no aliases.
 */
export { default } from "./project/config/vitest.config.mts";
