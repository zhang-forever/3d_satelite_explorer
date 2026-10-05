import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const FAILURE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_GROUPS = ["active", "stations"];
export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export async function loadCatalogDefinitions(root = projectRoot) {
  // Keep the mirror's labels and upstream queries tied to the application's catalog.
  const source = await readFile(path.join(root, "lib", "catalogs.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const catalogModule = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
  return catalogModule.CATALOGS;
}

export function selectGroups(catalogs, value = DEFAULT_GROUPS.join(",")) {
  const ids = [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) throw new Error("Select at least one snapshot catalog.");
  return ids.map((id) => {
    assertGroupId(id);
    const group = catalogs.find((catalog) => catalog.id === id);
    if (!group) throw new Error(`Unknown snapshot catalog: ${id}`);
    return group;
  });
}

function assertGroupId(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error("Invalid snapshot catalog ID.");
  }
}

function epochTime(value) {
  if (typeof value !== "string" || !value.trim()) return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
}

function numeric(value) {
  return (typeof value === "number" || typeof value === "string" && value.trim() !== "") &&
    Number.isFinite(Number(value));
}

export function validateRecords(records) {
  if (!Array.isArray(records) || !records.length) throw new Error("GP data must be a non-empty array.");
  const required = ["NORAD_CAT_ID", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
    "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY"];
  const optional = ["EPHEMERIS_TYPE", "ELEMENT_SET_NO", "REV_AT_EPOCH", "BSTAR",
    "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT"];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record) ||
      typeof record.OBJECT_NAME !== "string" || !Number.isFinite(epochTime(record.EPOCH)) ||
      !required.every((key) => numeric(record[key])) ||
      !optional.every((key) => record[key] === undefined || numeric(record[key])) ||
      !Number.isInteger(Number(record.NORAD_CAT_ID)) || Number(record.NORAD_CAT_ID) <= 0 ||
      Number(record.MEAN_MOTION) <= 0 || Number(record.ECCENTRICITY) < 0 ||
      Number(record.ECCENTRICITY) >= 1 ||
      record.OBJECT_ID !== undefined && typeof record.OBJECT_ID !== "string" ||
      record.CLASSIFICATION_TYPE !== undefined && typeof record.CLASSIFICATION_TYPE !== "string") {
      throw new Error("GP data contains an invalid orbital record.");
    }
  }
  return records;
}

function nullableDate(value) {
  return value == null || typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function parseSnapshot(value, group) {
  assertGroupId(group.id);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (value.groupId ?? value.group?.id) !== group.id || !Array.isArray(value.records) ||
    ![value.fetchedAt, value.sourceUpdatedAt, value.lastAttemptAt, value.nextRetryAt,
      value.checkedAt].every(nullableDate) ||
    value.blockedStatus != null && ![403, 404].includes(value.blockedStatus) ||
    value.error != null && typeof value.error !== "string") {
    throw new Error(`Invalid stored snapshot for ${group.id}.`);
  }
  if (value.records.length) {
    validateRecords(value.records);
    if (!value.fetchedAt) throw new Error(`Snapshot ${group.id} has no download timestamp.`);
  } else if (value.fetchedAt != null) {
    throw new Error(`Snapshot ${group.id} has a timestamp without records.`);
  }
  for (const header of [value.etag, value.lastModified]) {
    if (header != null && (typeof header !== "string" || /[\r\n\0]/.test(header))) {
      throw new Error(`Invalid stored snapshot header for ${group.id}.`);
    }
  }
  return {
    groupId: group.id,
    records: value.records,
    fetchedAt: value.fetchedAt ?? null,
    sourceUpdatedAt: value.sourceUpdatedAt ?? null,
    checkedAt: value.checkedAt ?? value.fetchedAt ?? null,
    etag: value.etag ?? null,
    lastModified: value.lastModified ?? null,
    error: value.error ?? null,
    lastAttemptAt: value.lastAttemptAt ?? value.fetchedAt ?? null,
    nextRetryAt: value.nextRetryAt ?? null,
    blockedStatus: value.blockedStatus ?? null,
    source: value.source ?? upstreamUrl(group),
  };
}

function upstreamUrl(group) {
  if (!["GROUP", "SPECIAL"].includes(group.queryKey) || typeof group.queryValue !== "string") {
    throw new Error(`Invalid upstream query for ${group.id}.`);
  }
  const query = new URLSearchParams({ [group.queryKey]: group.queryValue, FORMAT: "json" });
  return `https://celestrak.org/NORAD/elements/gp.php?${query}`;
}

async function readSnapshot(filename, group) {
  try { return parseSnapshot(JSON.parse(await readFile(filename, "utf8")), group); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read a valid ${group.id} snapshot: ${error.message}`);
  }
}

async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", "utf8");
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function fresh(timestamp, now) {
  const age = now.getTime() - Date.parse(timestamp ?? "");
  return Number.isFinite(age) && age >= 0 && age < REFRESH_INTERVAL_MS;
}

export function publicSnapshot(group, stored, now = new Date()) {
  return {
    group,
    records: stored.records,
    fetchedAt: stored.fetchedAt,
    sourceUpdatedAt: stored.sourceUpdatedAt,
    checkedAt: stored.checkedAt,
    stale: !!stored.error || !fresh(stored.checkedAt ?? stored.fetchedAt, now),
    cacheState: "snapshot",
    error: stored.error,
    source: stored.source,
  };
}

function retryDelay(value, now) {
  if (!value) return FAILURE_COOLDOWN_MS;
  const seconds = Number(value);
  const requested = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000 : Date.parse(value) - now.getTime();
  return Math.max(FAILURE_COOLDOWN_MS, Number.isFinite(requested) ? requested : 0);
}

export function createSnapshotUpdater({
  root = projectRoot,
  stateDir = path.join(root, ".cache", "static-data"),
  seedDirs = [path.join(root, ".cache", "celestrak"), path.join(root, "public", "data", "gp")],
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 15_000,
  bootstrapUrl = null,
} = {}) {
  const inFlight = new Map();

  async function load(group) {
    const filename = path.join(stateDir, `${group.id}.json`);
    const saved = await readSnapshot(filename, group);
    if (saved) return saved;
    for (const seedDir of seedDirs) {
      const seed = await readSnapshot(path.join(seedDir, `${group.id}.json`), group);
      if (seed) { await atomicJson(filename, seed); return seed; }
    }
    return null;
  }

  async function update(group, { bootstrapOnly = false } = {}) {
    assertGroupId(group.id);
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Snapshot update requires a valid clock.");
    }
    const filename = path.join(stateDir, `${group.id}.json`);
    let saved = await load(group);
    if (saved?.blockedStatus || saved?.nextRetryAt && Date.parse(saved.nextRetryAt) > timestamp.getTime() ||
      saved && (bootstrapOnly || fresh(saved.checkedAt ?? saved.fetchedAt, timestamp))) {
      return publicSnapshot(group, saved, timestamp);
    }
    if (bootstrapOnly && !bootstrapUrl) {
      throw new Error(`No saved snapshot for ${group.id}; provide a verified bootstrap source.`);
    }

    const empty = { groupId: group.id, records: [], fetchedAt: null, sourceUpdatedAt: null,
      checkedAt: null, etag: null, lastModified: null, error: null, lastAttemptAt: null,
      nextRetryAt: null, blockedStatus: null, source: upstreamUrl(group) };
    saved ??= empty;
    let status = null;
    let cooldown = FAILURE_COOLDOWN_MS;
    try {
      const headers = new Headers({ Accept: "application/json", "User-Agent": "OrbitalFieldStaticMirror/0.1" });
      if (saved.fetchedAt && saved.etag) headers.set("If-None-Match", saved.etag);
      if (saved.fetchedAt && saved.lastModified) headers.set("If-Modified-Since", saved.lastModified);
      const url = bootstrapOnly
        ? new URL(`api/gp?group=${encodeURIComponent(group.id)}`, `${bootstrapUrl.replace(/\/$/, "")}/`).href
        : upstreamUrl(group);
      const response = await fetchImpl(url, {
        headers, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      cooldown = retryDelay(response.headers.get("Retry-After"), timestamp);
      if (status === 304 && saved.records.length) {
        saved = { ...saved, checkedAt: timestamp.toISOString(), lastAttemptAt: timestamp.toISOString(),
          error: null, nextRetryAt: null, blockedStatus: null };
      } else {
        if (!response.ok) throw new Error(`GP source returned HTTP ${status}.`);
        const body = await response.json();
        if (bootstrapOnly) {
          saved = parseSnapshot(body, group);
          if (!saved.records.length) throw new Error("Bootstrap source has no saved records.");
        } else {
          const records = validateRecords(body);
          saved = { ...empty, records, fetchedAt: timestamp.toISOString(),
            checkedAt: timestamp.toISOString(), lastAttemptAt: timestamp.toISOString(),
            sourceUpdatedAt: new Date(Math.max(...records.map((record) => epochTime(record.EPOCH)))).toISOString(),
            etag: response.headers.get("ETag"), lastModified: response.headers.get("Last-Modified") };
        }
      }
    } catch (error) {
      saved = { ...saved, error: error instanceof Error ? error.message : "GP source unavailable.",
        lastAttemptAt: timestamp.toISOString(),
        nextRetryAt: [403, 404].includes(status) ? null : new Date(timestamp.getTime() + cooldown).toISOString(),
        blockedStatus: [403, 404].includes(status) ? status : null };
    }
    await atomicJson(filename, saved);
    return publicSnapshot(group, saved, timestamp);
  }

  return {
    updateGroup(group, options = {}) {
      assertGroupId(group.id);
      const key = group.id;
      if (inFlight.has(key)) return inFlight.get(key);
      const operation = update(group, options).finally(() => inFlight.delete(key));
      inFlight.set(key, operation);
      return operation;
    },
  };
}

export async function writeSnapshotData(groups, snapshots, outputDir, now = new Date()) {
  // Validate every selected group before replacing any public file.
  const stored = groups.map((group, index) => {
    const value = parseSnapshot(snapshots[index], group);
    if (!value.records.length) throw new Error(`No valid snapshot available for ${group.id}.`);
    return publicSnapshot(group, value, now);
  });
  for (const payload of stored) {
    await atomicJson(path.join(outputDir, "gp", `${payload.group.id}.json`), payload);
  }
  const manifest = { mode: "snapshot", generatedAt: now.toISOString(), refreshIntervalMs: REFRESH_INTERVAL_MS,
    catalogs: stored.map(({ group, records, ...metadata }) => ({ ...group, ...metadata, cachedCount: records.length })) };
  await atomicJson(path.join(outputDir, "catalogs.json"), manifest);
  return manifest;
}

export async function updateSnapshotGroups({ groups, root = projectRoot, bootstrapOnly = false,
  outputDir = path.join(root, "public", "data"), ...options } = {}) {
  const selected = groups ?? selectGroups(await loadCatalogDefinitions(root),
    process.env.NEXT_PUBLIC_SNAPSHOT_GROUPS || DEFAULT_GROUPS.join(","));
  const updater = createSnapshotUpdater({ root, ...options });
  const snapshots = [];
  // Only selected catalogs are requested; a page build never fetches all groups.
  for (const group of selected) snapshots.push(await updater.updateGroup(group, { bootstrapOnly }));
  const timestamp = options.now ? options.now() : new Date();
  return writeSnapshotData(selected, snapshots, outputDir, timestamp);
}

async function main() {
  const args = process.argv.slice(2);
  let bootstrapOnly = false;
  let bootstrapUrl = null;
  let groupIds = process.env.NEXT_PUBLIC_SNAPSHOT_GROUPS || DEFAULT_GROUPS.join(",");
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--bootstrap-only") bootstrapOnly = true;
    else if (args[index] === "--bootstrap-url" && args[index + 1]) bootstrapUrl = args[++index];
    else if (args[index] === "--groups" && args[index + 1]) groupIds = args[++index];
    else throw new Error(`Unknown snapshot updater argument: ${args[index]}`);
  }
  if (bootstrapUrl && !bootstrapOnly) throw new Error("A bootstrap URL requires --bootstrap-only.");
  if (bootstrapUrl && !["https:", "http:"].includes(new URL(bootstrapUrl).protocol)) {
    throw new Error("Bootstrap URL must use HTTP or HTTPS.");
  }
  const groups = selectGroups(await loadCatalogDefinitions(), groupIds);
  const manifest = await updateSnapshotGroups({ groups, bootstrapOnly, bootstrapUrl });
  for (const group of manifest.catalogs) {
    console.log(`${group.id}: ${group.cachedCount} records; fetched ${group.fetchedAt}; ${group.stale ? "stale" : "current"}${group.error ? `; ${group.error}` : ""}`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
