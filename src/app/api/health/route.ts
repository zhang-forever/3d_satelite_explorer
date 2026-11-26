import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { NextResponse } from "next/server";
import { getCacheDirectory, getCatalogSummaries } from "@/lib/celestrakCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let writable = false;
  try {
    const cacheDir = getCacheDirectory();
    await mkdir(cacheDir, { recursive: true });
    await access(cacheDir, constants.R_OK | constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  // A probe must not cause an upstream download, including during an outage.
  const catalogs = await getCatalogSummaries();
  const sourceErrors = catalogs.filter((catalog) => catalog.error).length;
  return NextResponse.json(
    {
      status: writable ? (sourceErrors ? "degraded" : "ok") : "error",
      cache: { writable, cachedGroups: catalogs.filter((catalog) => catalog.fetchedAt).length },
      source: { groupsWithErrors: sourceErrors }
    },
    { status: writable ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
