import { NextRequest, NextResponse } from "next/server";
import { getPayloadFormat, setPayloadFormat, getAllPayloadFormats } from "@/lib/agentcore-sdk";

/**
 * GET /api/agentcore/payload-format?agent_id=xxx
 * Returns the configured payload format for an agent (or all if no agent_id).
 */
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get("agent_id");
  if (agentId) {
    return NextResponse.json({ agentId, format: getPayloadFormat(agentId) || "prompt" });
  }
  return NextResponse.json(getAllPayloadFormats());
}

/**
 * POST /api/agentcore/payload-format
 * Set the payload format for an agent.
 * Body: { agent_id: "xxx", format: "prompt" | "messages" | "input_text" | "query" | "custom" }
 */
export async function POST(req: NextRequest) {
  const { agent_id, format } = await req.json();
  if (!agent_id || !format) {
    return NextResponse.json({ error: "agent_id and format required" }, { status: 400 });
  }
  const valid = ["prompt", "messages", "input_text", "query", "custom"];
  if (!valid.includes(format)) {
    return NextResponse.json({ error: `Invalid format. Must be one of: ${valid.join(", ")}` }, { status: 400 });
  }
  setPayloadFormat(agent_id, format);
  return NextResponse.json({ agent_id, format, saved: true });
}
