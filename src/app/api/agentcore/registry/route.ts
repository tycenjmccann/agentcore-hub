import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_REGION, listRegistries, createRegistry } from "@/lib/agentcore-sdk";

export const dynamic = "force-dynamic";

/**
 * GET /api/agentcore/registry
 * List all registries in the account.
 */
export async function GET(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const registries = await listRegistries(region);
    return NextResponse.json({ registries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list registries";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/agentcore/registry
 * Create a registry.
 * Body: { name, description?, authorizerType?, authorizerConfiguration?, approvalConfiguration? }
 */
export async function POST(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  try {
    const body = await req.json();
    if (!body?.name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const registry = await createRegistry(
      {
        name: body.name,
        description: body.description,
        authorizerType: body.authorizerType,
        authorizerConfiguration: body.authorizerConfiguration,
        approvalConfiguration: body.approvalConfiguration,
      },
      region
    );
    return NextResponse.json({ registry }, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create registry";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
