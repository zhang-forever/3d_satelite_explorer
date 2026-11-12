import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: repoRoot,
  test: {
    include: ["project/tests/**/*.test.{ts,tsx}"],
    environment: "node",
    globals: true,
    setupFiles: ["project/tests/setup.ts"]
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url))
    }
  }
});
