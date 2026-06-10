import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_REGION,
  listRegistryRecords,
  createRegistryRecord,
  type RecordStatus,
  type RegistryDescriptorType,
} from "@/lib/agentcore-sdk";

export const dynamic = "force-dynamic";

type Ctx = { params: { registryId: string } };

/**
 * GET /api/agentcore/registry/[registryId]/records
 * List records in a registry. Query params: status, descriptorType, name.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const sp = req.nextUrl.searchParams;
    const records = await listRegistryRecords(
      {
        registryId: params.registryId,
        status: (sp.get("status") as RecordStatus) || undefined,
        descriptorType: (sp.get("descriptorType") as RegistryDescriptorType) || undefined,
        name: sp.get("name") || undefined,
      },
      region
    );
    return NextResponse.json({ records });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list records";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/agentcore/registry/[registryId]/records
 * Create a record.
 * Body: { name, description?, descriptorType, descriptors, recordVersion? }
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const body = await req.json();
    if (!body?.name || !body?.descriptorType) {
      return NextResponse.json({ error: "name and descriptorType are required" }, { status: 400 });
    }
    const result = await createRegistryRecord(
      params.registryId,
      {
        name: body.name,
        description: body.description,
        descriptorType: body.descriptorType,
        descriptors: body.descriptors,
        recordVersion: body.recordVersion,
      },
      region
    );
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create record";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
