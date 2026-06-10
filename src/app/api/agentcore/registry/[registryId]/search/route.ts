import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_REGION,
  searchRegistryRecords,
  type RegistryDescriptorType,
} from "@/lib/agentcore-sdk";

export const dynamic = "force-dynamic";

type Ctx = { params: { registryId: string } };

/**
 * POST /api/agentcore/registry/[registryId]/search
 * Full-text search records in a registry (data plane).
 * Body: { query, descriptorType?, maxResults? }
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const body = await req.json();
    if (!body?.query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }
    const records = await searchRegistryRecords(
      {
        registryId: params.registryId,
        query: body.query,
        descriptorType: body.descriptorType as RegistryDescriptorType | undefined,
        maxResults: body.maxResults,
      },
      region
    );
    return NextResponse.json({ records });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to search records";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
