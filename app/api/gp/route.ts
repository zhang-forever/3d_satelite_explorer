import { NextRequest, NextResponse } from "next/server";
import { getCatalogById } from "@/lib/catalogs";
import { getGpGroup } from "@/lib/celestrakCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const groupId = request.nextUrl.searchParams.get("group") ?? "active";
  const catalog = getCatalogById(groupId);

  if (!catalog) {
    return NextResponse.json(
      { error: "Unknown catalog group", group: groupId },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const payload = await getGpGroup(catalog);
    const status = payload.fetchedAt === null ? 502 : 200;
    const cacheControl = status !== 200 || payload.stale || payload.error
      ? "no-store"
      : "public, max-age=60, s-maxage=60";
    return NextResponse.json(payload, { status, headers: { "Cache-Control": cacheControl } });
  } catch (error) {
    console.error("[CelesTrak] Unable to serve group", {
      group: groupId,
      kind: error instanceof Error ? error.name : "UnknownError"
    });
    return NextResponse.json(
      {
        error: "Unable to fetch GP data",
        group: groupId
      },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
