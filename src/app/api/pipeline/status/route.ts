import { NextRequest, NextResponse } from "next/server";
import { getPipelineStatus } from "@/lib/pipeline/status";

// Pipeline module (bolt-on) status endpoint. Read-only. Returns one entry per CD
// target (registered repos with a pipeline + the env default): recent CI builds
// and deploy-pipeline stage state. `?repo=<url|owner/repo>` narrows to that
// repo's target — an unknown/unregistered repo falls back to the env default, so
// callers must check the returned `repo` before attributing state to a run. Safe
// to call when the module infra is not deployed — surfaces a per-target `error`
// instead of throwing.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const repo = req.nextUrl.searchParams.get("repo") ?? undefined;
  const status = await getPipelineStatus({ repo });
  return NextResponse.json(status, {
    // don't cache — pipeline state is live
    headers: { "Cache-Control": "no-store" },
  });
}
