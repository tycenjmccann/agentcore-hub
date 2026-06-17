import { NextRequest, NextResponse } from "next/server";
import { listWorkflowsFromDynamo } from "@/lib/workflow/dynamo-read";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "1";
    const workflows = await listWorkflowsFromDynamo({ includeArchived });
    return NextResponse.json({ workflows });
  } catch (err) {
    console.error("[list] Error listing workflows:", err);
    return NextResponse.json(
      { error: `Failed to list workflows: ${(err as Error).message}`, workflows: [] },
      { status: 500 }
    );
  }
}
