/**
 * GET    /api/routines/[id]  → fetch one routine (tenant-checked)
 * PATCH  /api/routines/[id]  → enable/disable or edit schedule/input/name
 * DELETE /api/routines/[id]  → delete routine record + its EventBridge schedule
 *
 * All handlers are tenant-scoped via getOwnedRoutine — a routine owned by another
 * tenant reads as 404, so a probe cannot distinguish "exists elsewhere" from
 * "doesn't exist".
 */

import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import { getOwnedRoutine, mutateRoutine, deleteRoutine } from "@/lib/routines/store";
import { upsertSchedule, deleteSchedule } from "@/lib/routines/schedule";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { tenantId } = getIdentity(request);
  const routine = await getOwnedRoutine(id, tenantId);
  if (!routine) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ routine });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { tenantId } = getIdentity(request);
    const existing = await getOwnedRoutine(id, tenantId);
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const now = new Date().toISOString();

    // Apply the record change first, then reconcile the schedule to the new state.
    const updated = await mutateRoutine(id, (r) => {
      if (typeof body.enabled === "boolean") r.enabled = body.enabled;
      if (typeof body.name === "string" && body.name.trim()) r.name = body.name.trim().slice(0, 120);
      if (typeof body.description === "string") r.description = body.description.trim() || undefined;
      if (body.schedule?.expression) {
        r.schedule = { expression: body.schedule.expression, timezone: body.schedule.timezone || r.schedule.timezone || "UTC" };
      }
      if (body.input) r.input = { ...r.input, ...body.input };
      r.updatedAt = now;
      return r;
    });
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Reconcile EventBridge to the routine's new enabled/schedule state.
    updated.scheduleArn = await upsertSchedule(id, updated.schedule, updated.enabled);
    await mutateRoutine(id, (r) => { r.scheduleArn = updated.scheduleArn; return r; });

    return NextResponse.json({ routine: updated });
  } catch (err) {
    console.error("[routines] patch error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { tenantId } = getIdentity(request);
    const existing = await getOwnedRoutine(id, tenantId);
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Delete the schedule first — an orphaned schedule would keep firing at a
    // deleted routine (the runner then 404s), so kill the trigger before the row.
    await deleteSchedule(id);
    await deleteRoutine(id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[routines] delete error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
