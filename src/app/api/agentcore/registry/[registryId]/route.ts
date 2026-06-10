import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_REGION, getRegistry, updateRegistry, deleteRegistry } from "@/lib/agentcore-sdk";

export const dynamic = "force-dynamic";

type Ctx = { params: { registryId: string } };

/**
 * GET /api/agentcore/registry/[registryId]
 * Get a single registry (full detail).
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const registry = await getRegistry(params.registryId, region);
    return NextResponse.json({ registry });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to get registry";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * PATCH /api/agentcore/registry/[registryId]
 * Update a registry (name and/or description).
 * Body: { name?, description? }
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const body = await req.json();
    await updateRegistry(params.registryId, { name: body?.name, description: body?.description }, region);
    return NextResponse.json({ updated: true }, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update registry";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/agentcore/registry/[registryId]
 * Delete a registry (async).
 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    await deleteRegistry(params.registryId, region);
    return NextResponse.json({ deleted: true }, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete registry";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
