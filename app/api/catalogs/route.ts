import { NextResponse } from "next/server";
import { getCatalogSummaries } from "@/lib/celestrakCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const catalogs = await getCatalogSummaries();
  return NextResponse.json({
    refreshIntervalMs: 4 * 60 * 60 * 1000,
    catalogs
  });
}
