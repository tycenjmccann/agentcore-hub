/**
 * GET  /api/routines   → list this tenant's routines (for the Routines tab)
 * POST /api/routines   → create a routine (persist record + create its schedule)
 *
 * Creating a routine assumes its workflow def already exists in config/workflows.json
 * (S3) — the Routine Builder harness writes the def + any persona blueprints before
 * (or as part of) creating the record. This POST is the record + schedule half.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getIdentity } from "@/lib/auth/identity";
import { listRoutines, putRoutine } from "@/lib/routines/store";
import { upsertSchedule } from "@/lib/routines/schedule";
import { validateScheduleFloor } from "@/lib/routines/cron";
import { resolveWorkflowDef } from "@/lib/workflow/defs-loader";
import type { Routine } from "@/lib/routines/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { tenantId } = getIdentity(request);
    const routines = await listRoutines(tenantId);
    return NextResponse.json({ routines });
  } catch (err) {
    console.error("[routines] list error:", err);
    return NextResponse.json(
      { error: (err as Error).message, routines: [] },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId, tenantId } = getIdentity(request);
    const body = await request.json().catch(() => ({}));

    const name: string = (body.name?.trim() || "").slice(0, 120);
    const workflowDefId: string = body.workflowDefId?.trim();
    const schedule = body.schedule;
    const input = body.input;

    if (!name || !workflowDefId || !schedule?.expression || !input?.titleTemplate) {
      return NextResponse.json(
        { error: "name, workflowDefId, schedule.expression, and input.titleTemplate are required" },
        { status: 400 }
      );
    }

    // Reject a routine whose workflow def doesn't actually exist in the live config
    // (S3) — otherwise it would fail on every fire, silently, forever.
    const def = await resolveWorkflowDef(workflowDefId);
    if (!def) {
      return NextResponse.json(
        { error: `Unknown workflowDefId "${workflowDefId}" — create the workflow def first` },
        { status: 400 }
      );
    }

    // Frequency floor — one fire per hour max (each fire = a full LLM pipeline).
    const floorErr = validateScheduleFloor(schedule.expression);
    if (floorErr) return NextResponse.json({ error: floorErr }, { status: 400 });

    const routineId = `rt-${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const enabled = body.enabled !== false;

    // Connectors may arrive top-level (intake form) or nested in input (builder).
    // Normalize onto input.connectors — that's what flows to the workflow payload.
    const connectors: string[] | undefined =
      (Array.isArray(body.connectors) && body.connectors.length ? body.connectors : input.connectors) || undefined;

    const routine: Routine = {
      routineId,
      tenantId,
      name,
      description: body.description?.trim() || undefined,
      workflowDefId,
      schedule: { expression: schedule.expression, timezone: schedule.timezone || "UTC" },
      input: { ...input, ...(connectors ? { connectors } : {}) },
      enabled,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };

    // Create the schedule first so a persisted routine always has a live trigger.
    routine.scheduleArn = await upsertSchedule(routineId, routine.schedule, enabled);
    await putRoutine(routine);

    return NextResponse.json({ routine }, { status: 201 });
  } catch (err) {
    console.error("[routines] create error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
