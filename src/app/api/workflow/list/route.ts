import { NextResponse } from "next/server";
import { listWorkflowsFromDynamo } from "@/lib/workflow/dynamo-read";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const workflows = await listWorkflowsFromDynamo();
    return NextResponse.json({ workflows });
  } catch (err) {
    console.error("[list] Error listing workflows:", err);
    return NextResponse.json(
      { error: `Failed to list workflows: ${(err as Error).message}`, workflows: [] },
      { status: 500 }
    );
  }
}
