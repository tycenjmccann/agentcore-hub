/**
 * /api/workflow/performance — fleet + per-run performance cards.
 *
 *   GET ?days=7&defId=all|<workflowDefId>  → FleetView (cost / time / quality
 *        medians for the window vs the prior window, anomaly bands against the
 *        prior 28 days, by-agent and by-engine rollups, infra allocation)
 *   GET ?workflowId=<id>                    → that run's performance-card.json
 *   POST { workflowId }                     → 202, asynchronously recompute a
 *        terminal run's card via the cost-report Lambda (or 200 with the card
 *        when it is already at the current report version)
 *
 * GET reads only what the cost-report Lambda already wrote to the artifact
 * bucket (performance/index.json + workflows/{id}/shared/performance-card.json);
 * no Logs Insights or Cost Explorer calls happen on the request path. The index
 * cache lives in @/lib/workflow/performance-index so the list route shares it.
 *
 * This module is READ-ONLY with respect to DynamoDB: the only DynamoDB traffic
 * is getWorkflowFromDynamo's GetCommand. Nothing here writes the workflows
 * table — the recompute is a fire-and-forget Lambda invoke, and the Lambda owns
 * every write that follows from it.
 */

import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { ARTIFACT_BUCKET } from "@/lib/workflow/agent-setup";
import { getWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { buildFleetView, CURRENT_REPORT_VERSION } from "@/lib/workflow/performance";
import { getJson, loadIndex } from "@/lib/workflow/performance-index";
import { isTerminalPhase } from "@/lib/workflow/types";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const lambda = new LambdaClient({ region: REGION });

/** Shared by every branch that takes a workflowId, so the guard can't drift. */
const WORKFLOW_ID_RE = /^[\w-]+$/;
const BAD_ID = { error: "invalid workflowId" };
const CARD_KEY = (workflowId: string) => `workflows/${workflowId}/shared/performance-card.json`;

/** How long the client should wait before GETting the recomputed card. */
const POLL_AFTER_MS = 3000;

/**
 * How long a submitted recompute is assumed to still be running. Sized to the
 * cost-report Lambda's own timeout, not to a client's patience: while an invoke
 * may still be in flight, re-invoking only burns Logs Insights scans to write
 * the same S3 key twice.
 *
 * Best-effort and per-ECS-task BY DESIGN. With more than one task behind the
 * ALB, two concurrent POSTs on different tasks both invoke; that is acceptable
 * because the Lambda is idempotent (it recomputes and overwrites the same key),
 * and a cross-task lock would mean writing the workflows table, which this
 * surface deliberately never does.
 */
const INFLIGHT_TTL_MS = 600_000;
const inflight = new Map<string, number>();

/** Test-only: drop every in-flight marker so a spec starts from a clean map. */
export function __resetInflightForTests(): void {
  inflight.clear();
}

/** Test-only: how many markers are held, for asserting the sweep actually sweeps. */
export function __inflightSizeForTests(): number {
  return inflight.size;
}

export async function GET(request: NextRequest) {
  if (!ARTIFACT_BUCKET) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 500 });
  }
  const params = request.nextUrl.searchParams;
  try {
    const workflowId = params.get("workflowId");
    if (workflowId) {
      if (!WORKFLOW_ID_RE.test(workflowId)) return NextResponse.json(BAD_ID, { status: 400 });
      const card = await getJson<Record<string, unknown>>(CARD_KEY(workflowId));
      if (!card) return NextResponse.json({ error: "no performance card for this run yet" }, { status: 404 });
      return NextResponse.json({ card });
    }
    const days = Number(params.get("days") || 7);
    const defId = params.get("defId") || "all";
    const index = await loadIndex();
    const view = buildFleetView(index, { days: Number.isFinite(days) ? days : 7, workflowDefId: defId });
    return NextResponse.json(view);
  } catch (err) {
    // Static message: an AWS error string embeds the account id and the
    // assumed-role ARN of the task role (IAM AccessDenied especially).
    console.error("[performance] GET failed:", err);
    return NextResponse.json({ error: "failed to load performance data" }, { status: 500 });
  }
}

/**
 * Trigger a recompute of one terminal run's performance card.
 *
 * Ordered so that nothing reaches AWS until the id is known-good, and nothing
 * is invoked that a cheaper answer already covers: a malformed id costs zero
 * SDK calls, an unknown or still-running workflow costs one GetItem, and an
 * already-current card costs one extra S3 GET and no Lambda invoke.
 */
export async function POST(request: NextRequest) {
  // (a) Configuration.
  if (!ARTIFACT_BUCKET) {
    return NextResponse.json({ error: "ARTIFACT_BUCKET not configured" }, { status: 500 });
  }

  // (b) Body. An unparseable body and a missing/ill-typed workflowId are the
  // same client error. The `typeof` half of the guard is MANDATORY: RegExp.test
  // stringifies its argument, so ["wf_a"] and 12345 both satisfy the pattern.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(BAD_ID, { status: 400 });
  }
  const workflowId = (body as { workflowId?: unknown } | null | undefined)?.workflowId;
  if (typeof workflowId !== "string" || !WORKFLOW_ID_RE.test(workflowId)) {
    return NextResponse.json(BAD_ID, { status: 400 });
  }

  let claimed = false;
  try {
    // (c) The run must exist. READ ONLY — a GetCommand, never a write.
    const workflow = await getWorkflowFromDynamo(workflowId);
    if (!workflow) {
      return NextResponse.json({ error: "unknown workflow" }, { status: 404 });
    }

    // (d) Only a finished run has a stable card to compute.
    if (!isTerminalPhase(workflow.phase as string | null | undefined)) {
      return NextResponse.json({ error: "run is not terminal" }, { status: 409 });
    }

    // (e) Already current — hand back what's there instead of recomputing it.
    const card = await getJson<{ reportVersion?: number }>(CARD_KEY(workflowId));
    if (card && card.reportVersion === CURRENT_REPORT_VERSION) {
      return NextResponse.json({ card });
    }

    // (f) De-dupe. Sweep EVERY expired marker first, so the map cannot grow
    // without bound on a long-lived task, then claim — only here, after a-e
    // passed, so a bad / unknown / still-running id never leaves a marker.
    const now = Date.now();
    for (const [id, startedAt] of inflight) {
      if (now - startedAt >= INFLIGHT_TTL_MS) inflight.delete(id);
    }
    const heldSince = inflight.get(workflowId);
    if (heldSince !== undefined) {
      return NextResponse.json(
        {
          error: "compute already in flight",
          // retryAfterMs: don't re-POST before this. pollAfterMs: how soon to
          // GET the card. They differ by orders of magnitude on purpose.
          retryAfterMs: INFLIGHT_TTL_MS - (now - heldSince),
          pollAfterMs: POLL_AFTER_MS,
        },
        { status: 429 }
      );
    }
    inflight.set(workflowId, now);
    claimed = true;

    // (g) Fire and forget. FunctionName comes from env or the convention —
    // NEVER from the body — and the payload carries the validated id and
    // nothing else, so no request field can steer the Lambda.
    await lambda.send(
      new InvokeCommand({
        FunctionName: process.env.COST_REPORT_FUNCTION || "agentcore-hub-cost-report",
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ workflowId })),
      })
    );
    return NextResponse.json({ accepted: true, workflowId, pollAfterMs: POLL_AFTER_MS }, { status: 202 });
  } catch (err) {
    // (h) Release the claim so a retry isn't locked out by a failure, and answer
    // with a STATIC message: err.message from the Lambda or DynamoDB client
    // embeds the account id and the assumed-role ARN.
    if (claimed) inflight.delete(workflowId);
    console.error("[performance] POST failed:", err);
    return NextResponse.json({ error: "failed to start performance report" }, { status: 500 });
  }
}
