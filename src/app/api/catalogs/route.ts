import { NextResponse } from "next/server";
import { getCatalogSummaries, GP_REFRESH_INTERVAL_MS } from "@/lib/celestrakCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const catalogs = await getCatalogSummaries();
    const cacheControl = catalogs.some((catalog) => catalog.error)
      ? "no-store" : "public, max-age=15, s-maxage=30";
    return NextResponse.json({
      refreshIntervalMs: GP_REFRESH_INTERVAL_MS,
      catalogs
    }, { headers: { "Cache-Control": cacheControl } });
  } catch (error) {
    console.error("[CelesTrak] Unable to read catalog cache", {
      kind: error instanceof Error ? error.name : "UnknownError"
    });
    return NextResponse.json({ error: "Unable to read catalog cache" }, {
      status: 500, headers: { "Cache-Control": "no-store" }
    });
  }
}
