const { cp, access } = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const root = path.resolve(__dirname, "..");
  const standalone = path.join(root, ".next", "standalone");
  await access(path.join(standalone, "server.js"));
  // Next.js tracing omits these browser assets; keep the portable server complete.
  await cp(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
  await cp(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), {
    recursive: true
  });
  console.log("Standalone server prepared with textures, browser bundles, and workers.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
