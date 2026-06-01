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
      { status: 404 }
    );
  }

  try {
    const payload = await getGpGroup(catalog);
    const status = payload.records.length === 0 ? 502 : 200;
    return NextResponse.json(payload, { status });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to fetch GP data",
        group: groupId
      },
      { status: 502 }
    );
  }
}
