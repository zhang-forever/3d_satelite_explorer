const { readFile, writeFile, rename, unlink } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

async function main() {
  const group = process.argv[2];
  if (!group || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(group) || process.argv.length !== 3) {
    throw new Error("Usage: npm run cache:resume -- <group-id>");
  }
  const cacheDir = path.resolve(process.env.CELESTRAK_CACHE_DIR || ".cache/celestrak");
  const file = path.join(cacheDir, `${group}.json`);
  const payload = JSON.parse(await readFile(file, "utf8"));
  if (payload.groupId !== group || !Array.isArray(payload.records)) {
    throw new Error("The cache does not contain a valid group snapshot; it was left unchanged.");
  }
  payload.error = null;
  payload.nextRetryAt = null;
  payload.blockedStatus = null;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  console.log(`Source error cleared for ${group}; ${payload.records.length} records preserved.`);
  console.log("Restart the service after fixing the reported source problem to resume fetching.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
