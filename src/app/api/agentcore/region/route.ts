import { NextRequest } from "next/server";
import { DEFAULT_REGION } from "@/lib/agentcore-sdk";

// Regions where Bedrock AgentCore is available
const AGENTCORE_REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "eu-central-1",
  "ap-southeast-1",
  "ap-northeast-1",
];

/**
 * GET /api/agentcore/region
 * Returns the default region (from env) and available regions.
 * Region selection is now client-side state (localStorage) sent via x-aws-region header.
 */
export async function GET() {
  return Response.json({
    current: DEFAULT_REGION,
    available: AGENTCORE_REGIONS,
  });
}

/**
 * POST /api/agentcore/region
 * No-op — region is now per-request client-side state sent via x-aws-region header.
 * Kept for backward compatibility so existing UI code doesn't break.
 */
export async function POST(req: NextRequest) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { region } = body;

  if (!region || !AGENTCORE_REGIONS.includes(region)) {
    return Response.json(
      { error: `Invalid region. Available: ${AGENTCORE_REGIONS.join(", ")}` },
      { status: 400 }
    );
  }

  // No server-side state mutation — region travels with each request via x-aws-region header
  return Response.json({ current: region });
}
