/**
 * POST /api/routines/[id]/run — fire a routine immediately ("Run now").
 *
 * Runs the exact same payload the scheduler would send: build from the routine's
 * input template and POST to /api/workflow/start on this same deployment. Records
 * the result in the routine's lastRun so the tab shows it, just like a scheduled
 * fire.
 */

import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { getOwnedRoutine, mutateRoutine } from "@/lib/routines/store";
import { buildStartPayload } from "@/lib/routines/payload";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { tenantId } = getIdentity(request);
  const routine = await getOwnedRoutine(id, tenantId);
  if (!routine) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const payload = buildStartPayload(routine.input, new Date());
  // Self-call over loopback: the public origin is not routable from inside the
  // container (no route back through the load balancer). The app listens on $PORT.
  const origin = `http://127.0.0.1:${process.env.PORT || 8080}`;

  try {
    const res = await fetch(`${origin}/api/workflow/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      await mutateRoutine(id, (r) => {
        r.lastRun = { at: new Date().toISOString(), status: "failed", error: data.error || `HTTP ${res.status}` };
        return r;
      });
      return NextResponse.json({ error: data.error || `workflow start failed (${res.status})` }, { status: 502 });
    }
    const workflowId = data.workflowId || data.id;
    await mutateRoutine(id, (r) => {
      r.lastRun = { at: new Date().toISOString(), status: "started", workflowId };
      return r;
    });
    return NextResponse.json({ started: true, workflowId });
  } catch (err) {
    await mutateRoutine(id, (r) => {
      r.lastRun = { at: new Date().toISOString(), status: "failed", error: (err as Error).message };
      return r;
    });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
