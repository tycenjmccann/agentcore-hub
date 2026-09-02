import { NextResponse } from "next/server";
import { getPipelineStatus } from "@/lib/pipeline/status";

// Pipeline module (bolt-on) status endpoint. Read-only. Returns the CI project's
// recent builds + the deploy pipeline's stage state. Safe to call when the
// module infra is not deployed — surfaces `error` instead of throwing.
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getPipelineStatus();
  return NextResponse.json(status, {
    // don't cache — pipeline state is live
    headers: { "Cache-Control": "no-store" },
  });
}
