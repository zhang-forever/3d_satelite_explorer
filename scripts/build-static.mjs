import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GROUPS, loadCatalogDefinitions, parseSnapshot, selectGroups, writeSnapshotData } from "./update-static-data.mjs";
import { validateStaticOutput } from "./validate-static-output.mjs";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(import.meta.url);
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/3d_satelite_explorer";
if (basePath && (!/^\/[a-zA-Z0-9_/-]+$/.test(basePath) || basePath.includes("//") || basePath.endsWith("/"))) {
  throw new Error("Static base path must be empty or an absolute URL path without a trailing slash.");
}
const groupIds = process.env.NEXT_PUBLIC_SNAPSHOT_GROUPS || DEFAULT_GROUPS.join(",");
const groups = selectGroups(await loadCatalogDefinitions(root), groupIds);
const publicDataRoot = path.join(root, "public", "data");
const snapshots = [];
for (const group of groups) {
  const payload = JSON.parse(await readFile(path.join(publicDataRoot, "gp", `${group.id}.json`), "utf8"));
  const stored = parseSnapshot(payload, group);
  if (!stored.records.length) throw new Error(`Prepare a real snapshot for ${group.id} before building.`);
  snapshots.push(payload);
}

// This build uses the repository source and its own Next.js output directory.
const child = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build", "--webpack"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_DATA_MODE: "snapshot",
    NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_SNAPSHOT_GROUPS: groupIds },
});
if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);

const nextRoot = path.join(root, ".next-static");
const appRoot = path.join(nextRoot, "server", "app");
await readFile(path.join(appRoot, "index.html"));
await readFile(path.join(appRoot, "index.rsc"));
const outputRoot = path.join(root, "out");
const existing = await lstat(outputRoot).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (path.relative(root, path.resolve(outputRoot)) !== "out" ||
  existing && (!existing.isDirectory() || existing.isSymbolicLink() ||
    path.relative(root, await realpath(outputRoot)) !== "out")) {
  throw new Error("Refusing to replace a redirected or non-directory static output.");
}
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(path.join(root, "public"), outputRoot, { recursive: true, filter: (source) => source !== publicDataRoot });
await cp(path.join(nextRoot, "static"), path.join(outputRoot, "_next", "static"), { recursive: true });
await cp(path.join(appRoot, "index.html"), path.join(outputRoot, "index.html"));
await cp(path.join(appRoot, "index.rsc"), path.join(outputRoot, "index.rsc"));
await cp(path.join(root, "app", "icon.svg"), path.join(outputRoot, "icon.svg"));
await writeSnapshotData(groups, snapshots, path.join(outputRoot, "data"));
await writeFile(path.join(outputRoot, ".nojekyll"), "");
const result = await validateStaticOutput({ root, directory: outputRoot, basePath, groupIds });
console.log(`Static mirror ready: out (${result.groups.join(", ")}, base ${basePath || "/"}).`);
