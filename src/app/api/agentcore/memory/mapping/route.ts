import { NextRequest } from "next/server";
import {
  setMemoryMapping,
  removeMemoryMapping,
  getAllMemoryMappings,
  discoverMemories,
  DEFAULT_REGION,
} from "@/lib/agentcore-sdk";

/**
 * GET /api/agentcore/memory/mapping
 * Returns all agent->memory mappings and available memories.
 */
export async function GET(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  const [mappings, memories] = await Promise.all([
    Promise.resolve(getAllMemoryMappings()),
    discoverMemories(region),
  ]);

  return Response.json({ mappings, memories });
}

/**
 * POST /api/agentcore/memory/mapping
 * Set a memory mapping: { agentId, memoryId }
 */
export async function POST(req: NextRequest) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { agentId, memoryId } = body;

  if (!agentId) {
    return Response.json({ error: "agentId required" }, { status: 400 });
  }

  if (memoryId) {
    setMemoryMapping(agentId, memoryId);
  } else {
    removeMemoryMapping(agentId);
  }

  return Response.json({ success: true, mappings: getAllMemoryMappings() });
}
