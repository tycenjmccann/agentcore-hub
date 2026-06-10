import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_REGION,
  getRegistryRecord,
  updateRegistryRecord,
  deleteRegistryRecord,
} from "@/lib/agentcore-sdk";

export const dynamic = "force-dynamic";

type Ctx = { params: { registryId: string; recordId: string } };

/**
 * GET /api/agentcore/registry/[registryId]/records/[recordId]
 * Get a single record incl. full descriptors payload.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const record = await getRegistryRecord(params.registryId, params.recordId, region);
    return NextResponse.json({ record });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to get record";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * PATCH /api/agentcore/registry/[registryId]/records/[recordId]
 * Update a record's name and/or descriptors inline content.
 * Body: { name?, descriptorType?, inlineContent? }
 * descriptorType is required when inlineContent is provided.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const body = await req.json();
    if (body?.inlineContent !== undefined && !body?.descriptorType) {
      return NextResponse.json(
        { error: "descriptorType is required when inlineContent is provided" },
        { status: 400 }
      );
    }
    await updateRegistryRecord(
      params.registryId,
      params.recordId,
      { name: body?.name, descriptorType: body?.descriptorType, inlineContent: body?.inlineContent },
      region
    );
    return NextResponse.json({ updated: true }, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update record";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/agentcore/registry/[registryId]/records/[recordId]
 * Delete a record.
 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    await deleteRegistryRecord(params.registryId, params.recordId, region);
    return NextResponse.json({ deleted: true }, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete record";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
