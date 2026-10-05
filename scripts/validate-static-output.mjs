import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_GROUPS, loadCatalogDefinitions, parseSnapshot, projectRoot, selectGroups } from "./update-static-data.mjs";

export async function validateStaticOutput({ root = projectRoot, directory = path.join(root, "out"),
  basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/3d_satelite_explorer",
  groupIds = process.env.NEXT_PUBLIC_SNAPSHOT_GROUPS || DEFAULT_GROUPS.join(",") } = {}) {
  const groups = selectGroups(await loadCatalogDefinitions(root), groupIds);
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(directory, "data", "catalogs.json"), "utf8"));
  if (manifest.mode !== "snapshot" || !Array.isArray(manifest.catalogs) ||
    manifest.catalogs.length !== groups.length || !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    groups.some((group) => !manifest.catalogs.some((catalog) => catalog.id === group.id))) {
    throw new Error("Static catalog manifest does not match the selected groups.");
  }
  for (const group of groups) {
    const payload = parseSnapshot(JSON.parse(await readFile(path.join(directory, "data", "gp", `${group.id}.json`), "utf8")), group);
    if (!payload.records.length) throw new Error(`Static group ${group.id} contains no orbital data.`);
    const summary = manifest.catalogs.find((catalog) => catalog.id === group.id);
    if (summary.cachedCount !== payload.records.length || summary.fetchedAt !== payload.fetchedAt) {
      throw new Error(`Static group ${group.id} metadata does not match its records.`);
    }
  }
  let frameworkResources = 0;
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    const url = match[1];
    if (!url.startsWith("/") || url.startsWith("//")) continue;
    if (basePath && !url.startsWith(`${basePath}/`)) {
      throw new Error(`Static HTML uses a resource outside its base path: ${url}`);
    }
    const relative = url.slice(basePath.length).split("?")[0].replace(/^\//, "");
    if (!relative) continue;
    const filename = path.resolve(directory, relative);
    const inside = path.relative(path.resolve(directory), filename);
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("Static resource escapes the output directory.");
    if (!(await stat(filename)).isFile()) throw new Error(`Missing static HTML resource: ${url}`);
    if (relative.startsWith("_next/static/")) frameworkResources++;
  }
  if (!frameworkResources) throw new Error("Static HTML has no Next.js resources.");
  const chunks = path.join(directory, "_next", "static", "chunks");
  const runtimeName = (await readdir(chunks)).find((name) => /^webpack-.*\.js$/.test(name));
  if (!runtimeName || !(await readFile(path.join(chunks, runtimeName), "utf8")).includes(`"${basePath}/_next/"`)) {
    throw new Error("Webpack public path does not match the static mirror's base path.");
  }
  await readFile(path.join(directory, "index.rsc"));
  await readFile(path.join(directory, "icon.svg"));
  return { groups: groups.map((group) => group.id), frameworkResources, basePath };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  validateStaticOutput().then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
