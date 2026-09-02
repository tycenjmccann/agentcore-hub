/**
 * POST /api/workflow/[id]/complete
 *
 * Honestly closes out a workflow whose work is actually finished but whose
 * bookkeeping never rolled up (the orchestrator missed the final phase_change,
 * or the last tickets were closed out-of-band). This is the write path the
 * Workflow Manager's watch-mode `complete` intervention calls.
 *
 * Guardrail — this NEVER fakes completion, and there is NO bypass:
 *   1. Reads every child ticket via the configured provider (Jira or DynamoDB).
 *   2. Refuses (409) unless ALL non-epic children are done/cancelled. There is
 *      deliberately no `force` flag — the manager toolkit is unauthenticated, so
 *      an unconditional bypass would let a mistaken diagnosis (or prompt
 *      injection) mark unfinished work complete. Genuinely-finished-but-
 *      unrecorded work is resolved by closing the child ticket, not bypassing.
 *   3. Transitions the epic ticket to Done (Jira) so the board rolls up.
 *   4. Conditional write: phase → "complete", completedAt, managerWatch=false,
 *      and compacts runaway escalation noise in the same write.
 *   5. Publishes workflow.complete on EventBridge (drives the ANALYZE trigger)
 *      AND to the events table under workflowId (clears the live SSE board).
 *
 * Body: { reason?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { JiraClient } from "@/lib/workflow/jira-client";
import { resolveWorkflowDef } from "@/lib/workflow/defs-loader";
import { SHIP_BLOCKED_OUTCOMES } from "@/lib/workflow/types";
import agentsConfig from "@/config/agents.json";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const EVENT_BUS = process.env.EVENT_BUS || "default";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

// TEAM-3619 D4a / TEAM-3690: the deliverable-evidence gate. DEFAULT ON
// (ENFORCE). The design (§X.5 step 6) mandated "evidence check behind
// COMPLETION_EVIDENCE_REQUIRED flag (shadow-log first)"; that shadow-first
// observation step is now COMPLETE. Per QA finding F2 (AC-D4.1: "a ticket with
// an empty completion record cannot close") the rollout has advanced to
// enforce-by-default — a run missing evidence gets a 409, not a shadow-log.
// Shadow mode remains ONLY as an explicit emergency opt-OUT: set
// COMPLETION_EVIDENCE_REQUIRED=off|false|0 (case-insensitive) to fall back to
// shadow-log-and-complete. This is fail-closed: any other value — unset, empty,
// or unrecognized garbage — ENFORCES, so an unparseable value can never
// silently disable the invariant. As with the other lifecycle guards there is
// deliberately still NO force/bypass request parameter regardless of the flag.
const COMPLETION_EVIDENCE_REQUIRED = !/^(off|false|0)$/i.test(
  (process.env.COMPLETION_EVIDENCE_REQUIRED || "").trim()
);

// agentId → agent phase, from the bundled roster (same doc the pipeline reads).
// Used to route a child ticket to its agent phase when the ticket carries no
// explicit `phase` stamp (TEAM-3619 D4c stamps spawned fixes; agent tickets are
// derived from their assignee, exactly as the orchestrator does).
const AGENT_PHASE_BY_ID: Record<string, string> = Object.fromEntries(
  (agentsConfig.agents as Array<{ agentId: string; phase: string }>).map((a) => [a.agentId, a.phase])
);

// TEAM-3747 D2: the lifecycle-integrity ship outcomes are ALSO terminal — a run
// closed deploy-blocked / static-ci-only cannot be re-"completed" out from under
// its honest verdict (the early guard below returns 409). Additive: legacy runs
// never carry these phases, so their behavior is unchanged.
const TERMINAL_PHASES = ["complete", "error", "cancelled", ...SHIP_BLOCKED_OUTCOMES] as const;
const DONE_STATUSES = new Set(["done", "cancelled"]);
// PARITY with lambda/orchestrator/completion.mjs SHIP_PHASES — the phases whose
// done tickets owe a merge/deploy verdict rather than mere output.
const SHIP_PHASES = new Set(["ship"]);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const eventBridge = new EventBridgeClient({ region: REGION });

export const dynamic = "force-dynamic";

type Ticket = Record<string, unknown>;
type Notification = Record<string, unknown>;

/** Non-epic children that are not yet in a terminal (done/cancelled) status. */
function openChildren(tickets: Ticket[]): Ticket[] {
  return tickets.filter((t) => {
    if (t.type === "epic") return false;
    const status = String(t.status || "").toLowerCase();
    return !DONE_STATUSES.has(status);
  });
}

/** The agent phase a child ticket belongs to: an explicit `phase` stamp wins
 *  (TEAM-3619 D4c routes spawned fixes to their originating upstream phase),
 *  else derive it from the assignee's roster phase. Undefined for humans/unknowns. */
function phaseOfTicket(t: Ticket): string | undefined {
  if (typeof t.phase === "string" && t.phase) return t.phase;
  const assignee = typeof t.assignee === "string" ? t.assignee : "";
  return AGENT_PHASE_BY_ID[assignee];
}

interface AgentTaskLike {
  ticketId?: string;
  output?: unknown;
  artifactKey?: unknown;
}

/**
 * TEAM-3619 D4a deliverable-evidence check. For every DONE (not cancelled) child
 * ticket whose phase is one the def requires for completion, assert its agentTask
 * entry carries proof of work: a non-empty `output` OR an `artifactKey`. A "done"
 * ticket with an empty task is a phantom deliverable — the very thing a mistaken
 * or injected `complete` call would rubber-stamp. Returns the offenders (empty =
 * clean). Tickets whose phase we can't resolve, or that aren't a required phase,
 * are left alone — this only tightens, never invents work.
 */
function missingEvidenceTickets(
  tickets: Ticket[],
  agentTasks: Record<string, AgentTaskLike>,
  requiredPhases: string[]
): Array<{ ticketId: string; phase: string }> {
  if (!requiredPhases.length) return [];
  const required = new Set(requiredPhases);
  const tasks = agentTasks && typeof agentTasks === "object" ? agentTasks : {};
  const byTicketId = new Map<string, AgentTaskLike>();
  for (const entry of Object.values(tasks)) {
    if (entry && typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
  }
  const missing: Array<{ ticketId: string; phase: string }> = [];
  for (const t of tickets) {
    if (t.type === "epic") continue;
    if (String(t.status || "").toLowerCase() !== "done") continue; // cancelled excluded
    const phase = phaseOfTicket(t);
    if (!phase || !required.has(phase)) continue;
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const hasOutput = typeof entry?.output === "string" && entry.output.trim().length > 0;
    const hasArtifact = typeof entry?.artifactKey === "string" && entry.artifactKey.length > 0;
    if (!hasOutput && !hasArtifact) missing.push({ ticketId, phase });
  }
  return missing;
}

interface ShipTaskLike extends AgentTaskLike {
  mergeCommit?: unknown;
  commitSha?: unknown;
  outcome?: unknown;
  blockReason?: unknown;
}

interface ShipVerdict {
  required: boolean;
  shipped: boolean;
  outcome: string | null;
  blockReason: string | null;
  offenders: Array<{ ticketId: string; phase: string; verdict: string }>;
}

/**
 * TEAM-3747 D2 PARITY — hand-port of lambda/orchestrator/completion.mjs
 * `shipVerdictOf`. Classify ONE ship-phase agentTasks entry: "shipped" (a merge
 * commit / commit_sha, or an explicit outcome==="shipped"), a SHIP_BLOCKED_OUTCOMES
 * value (an explicit terminal block), or null (a phantom green close — CI may be
 * green but nothing merged/deployed and no block declared). Unlike
 * missingEvidenceTickets, mere output/artifact is NOT proof the work shipped.
 * Keep in agreement with completion.mjs.
 */
function shipVerdictOf(entry: ShipTaskLike | undefined): string | null {
  if (!entry || typeof entry !== "object") return null;
  const outcome = typeof entry.outcome === "string" ? entry.outcome.trim().toLowerCase() : "";
  if ((SHIP_BLOCKED_OUTCOMES as readonly string[]).includes(outcome)) return outcome;
  const merged =
    (typeof entry.mergeCommit === "string" && entry.mergeCommit.trim().length > 0) ||
    (typeof entry.commitSha === "string" && entry.commitSha.trim().length > 0);
  if (merged || outcome === "shipped") return "shipped";
  return null;
}

/**
 * TEAM-3747 D2 PARITY — hand-port of lambda/orchestrator/completion.mjs
 * `evaluateShipVerdict`. Decide the ship/CD verdict for the whole run: every done
 * ship AGENT ticket must carry a positive merge/deploy verdict. Same discipline as
 * the orchestrator twin — "cannot prove a phantom with nothing to inspect → stay
 * green"; human review-gate tickets owe no verdict; "deploy-blocked" outranks
 * "static-ci-only". Runs with no ship phase return required=false (untouched).
 * Keep this in agreement with completion.mjs.
 */
function evaluateShipVerdict(
  tickets: Ticket[],
  agentTasks: Record<string, ShipTaskLike>,
  requiredPhases: string[]
): ShipVerdict {
  const inert: ShipVerdict = { required: false, shipped: true, outcome: null, blockReason: null, offenders: [] };
  const shipPhases = requiredPhases.filter((p) => SHIP_PHASES.has(p));
  if (!shipPhases.length) return inert;
  const phases = new Set(shipPhases);
  const tasks = agentTasks && typeof agentTasks === "object" ? agentTasks : {};
  const byTicketId = new Map<string, ShipTaskLike>();
  for (const entry of Object.values(tasks)) {
    if (entry && typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
  }
  const isHuman = (a: unknown) => typeof a === "string" && a.startsWith("human:");
  const shipTickets = tickets.filter(
    (t) =>
      t.type !== "epic" &&
      String(t.status || "").toLowerCase() === "done" &&
      !isHuman(t.assignee) &&
      phases.has(phaseOfTicket(t) as string)
  );
  if (shipTickets.length === 0) return { ...inert, required: true };
  let blocked: string | null = null;
  let blockReason: string | null = null;
  const offenders: ShipVerdict["offenders"] = [];
  for (const t of shipTickets) {
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const verdict = shipVerdictOf(entry);
    if (verdict === "shipped") continue;
    offenders.push({ ticketId, phase: phaseOfTicket(t) as string, verdict: verdict || "none" });
    if (verdict === "deploy-blocked") {
      blocked = "deploy-blocked";
      if (!blockReason && entry && typeof entry.blockReason === "string") blockReason = entry.blockReason;
    } else if (!blocked) {
      blocked = "static-ci-only";
    }
  }
  if (offenders.length === 0) return { required: true, shipped: true, outcome: null, blockReason: null, offenders: [] };
  return { required: true, shipped: false, outcome: blocked || "static-ci-only", blockReason, offenders };
}

/**
 * Compact humanNotifications so the terminal write SHRINKS the record instead
 * of growing it. Runaway `manager_escalation` entries are the bloat that pushes
 * a run's item toward the 400KB DynamoDB limit — the very thing that would make
 * the completion write fail (leaving the run stuck "open" forever). We drop the
 * no-op manager escalations (each is already mirrored as a manager.escalation
 * row in the events table) and keep genuine human-facing notifications
 * (review_needed, etc.), preserving the last few escalations for audit.
 */
function compactNotifications(notifs: Notification[]): Notification[] {
  if (!Array.isArray(notifs) || notifs.length === 0) return notifs || [];
  const kept: Notification[] = [];
  const recentEscalations: Notification[] = [];
  for (const n of notifs) {
    if (n?.type === "manager_escalation") {
      recentEscalations.push(n);
    } else {
      kept.push(n);
    }
  }
  // Keep the 3 most recent escalations for traceability; drop the rest.
  return [...kept, ...recentEscalations.slice(-3)];
}

/**
 * TEAM-3747 D2 PARITY (mirrors the orchestrator's closeWorkflowBlocked) — close a
 * run on an HONEST terminal ship outcome instead of a fake "complete". A
 * conditional write to the blocked phase (same CAS shape as the complete write, so
 * it never clobbers a cancel or an already-terminal run) followed by a TERMINAL
 * verdict event on both sinks. The event type is workflow.deploy_blocked /
 * workflow.static_ci_only but ALSO carries an `outcome` field so a
 * workflow.complete-shaped consumer can branch on it — the close is never silent.
 * No epic roll-up: the work did NOT ship, so the epic must not be marked Done.
 */
async function closeBlocked(
  workflowId: string,
  workflow: Record<string, unknown>,
  verdict: ShipVerdict,
  reason: string | undefined
): Promise<NextResponse> {
  const outcome = verdict.outcome as string; // a SHIP_BLOCKED_OUTCOMES value
  const completedAt = new Date().toISOString();
  const blockReason = verdict.blockReason || reason || null;
  const compacted = compactNotifications((workflow.humanNotifications as Notification[]) || []);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression:
          "SET #phase = :outcome, completedAt = :ts, previousPhase = :prev, managerWatch = :false, humanNotifications = :notifs" +
          (blockReason ? ", blockReason = :reason" : ""),
        ConditionExpression:
          "#phase <> :complete AND #phase <> :error AND #phase <> :alreadyCancelled " +
          "AND #phase <> :deployBlocked AND #phase <> :staticCi AND attribute_not_exists(cancelledAt)",
        ExpressionAttributeNames: { "#phase": "phase" },
        ExpressionAttributeValues: {
          ":outcome": outcome,
          ":ts": completedAt,
          ":prev": workflow.phase,
          ":false": false,
          ":notifs": compacted,
          ":complete": "complete",
          ":error": "error",
          ":alreadyCancelled": "cancelled",
          ":deployBlocked": "deploy-blocked",
          ":staticCi": "static-ci-only",
          ...(blockReason ? { ":reason": blockReason } : {}),
        },
      })
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return NextResponse.json(
        { error: "Workflow already in terminal state", phase: workflow.phase },
        { status: 409 }
      );
    }
    throw err;
  }

  const detailType = outcome === "deploy-blocked" ? "workflow.deploy_blocked" : "workflow.static_ci_only";
  const detail = {
    workflowId,
    outcome,
    completedAt,
    previousPhase: workflow.phase,
    closedBy: "workflow-manager",
    reason: blockReason,
    offenders: verdict.offenders,
  };
  try {
    await eventBridge.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: "agentcore-hub.orchestrator",
            DetailType: detailType,
            Detail: JSON.stringify({ ...detail, timestamp: completedAt }),
            EventBusName: EVENT_BUS,
          },
        ],
      })
    );
  } catch (err) {
    console.warn(`[complete] EventBridge publish failed: ${(err as Error).message}`);
  }
  try {
    await ddb.send(
      new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
          workflowId,
          eventId: `${Date.now()}-${outcome}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: completedAt,
          type: detailType,
          detail,
        },
      })
    );
  } catch {
    /* event publish is non-fatal */
  }

  console.log(`[complete] Workflow ${workflowId} closed ${outcome} (was: ${workflow.phase}) — not shipped`);
  return NextResponse.json(
    { status: outcome, completedAt, outcome, offenders: verdict.offenders, ...(blockReason ? { reason: blockReason } : {}) },
    { status: 200 }
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  if (!workflowId || typeof workflowId !== "string") {
    return NextResponse.json({ error: "Invalid workflow ID" }, { status: 400 });
  }

  let reason: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 500);
    }
  } catch {
    /* no body */
  }

  try {
    // 1. Read current workflow (consistent — we're about to gate on its phase).
    const wfResult = await ddb.send(
      new GetCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        ConsistentRead: true,
      })
    );
    if (!wfResult.Item) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    const workflow = wfResult.Item;

    // TEAM-3619 D4a: cancellation strictly precedes completion. If the run was
    // cancelled, refuse with a specific error — a cancelled run cannot be
    // "completed" (its phase attribute may still lag behind the cancelledAt
    // stamp, so we gate on the stamp, not only on phase === "cancelled").
    if (workflow.cancelledAt) {
      return NextResponse.json(
        {
          error: "workflow_cancelled",
          cancelledAt: workflow.cancelledAt,
          detail: "cancellation precedes completion; a cancelled run cannot be completed",
        },
        { status: 409 }
      );
    }

    if (TERMINAL_PHASES.includes(workflow.phase as (typeof TERMINAL_PHASES)[number])) {
      return NextResponse.json(
        { error: "Workflow already in terminal state", phase: workflow.phase },
        { status: 409 }
      );
    }

    // 2. Load children via the configured provider and enforce the gate.
    let tickets: Ticket[];
    try {
      tickets =
        TICKET_PROVIDER === "jira"
          ? await getTicketsForWorkflowFromJira(workflowId)
          : // TEAM-3686 Finding 4: consistent read — a fix ticket filed moments
            // before this completion call must be visible to the gates below.
            await getTicketsForWorkflowFromDynamo(workflowId, { consistentRead: true });
    } catch (err) {
      return NextResponse.json(
        { error: `Could not load tickets to verify completion: ${(err as Error).message}` },
        { status: 502 }
      );
    }

    const open = openChildren(tickets);
    if (open.length > 0) {
      return NextResponse.json(
        {
          error: "Work not finished — refusing to complete",
          openTickets: open.map((t) => ({
            ticketId: t.ticketId,
            status: t.status,
            title: t.title,
          })),
          hint: "Finish or cancel these tickets first — completion has no bypass.",
        },
        { status: 409 }
      );
    }

    // 2b. TEAM-3619 D4a: deliverable-evidence gate. Every done ticket in a
    //     completion-required phase must have real work behind it (task output or
    //     an artifact). Enforced by default (TEAM-3690): missing evidence → 409.
    //     Only the explicit opt-out COMPLETION_EVIDENCE_REQUIRED=off|false|0 falls
    //     back to shadow-log-and-continue. No bypass parameter: the same reason
    //     the open-children gate has none.
    try {
      const def = await resolveWorkflowDef(String(workflow.workflowDefId || ""));
      const requiredPhases = def?.completionRequiresAgentPhases || [];
      const missing = missingEvidenceTickets(
        tickets,
        (workflow.agentTasks as Record<string, AgentTaskLike>) || {},
        requiredPhases
      );
      if (missing.length > 0) {
        if (COMPLETION_EVIDENCE_REQUIRED) {
          return NextResponse.json({ error: "missing_evidence", tickets: missing }, { status: 409 });
        }
        console.warn(
          `[complete] ${workflowId} would be blocked for missing evidence (shadow opt-out): ` +
            missing.map((m) => `${m.ticketId}@${m.phase}`).join(", ")
        );
      }
    } catch (err) {
      // Never let evidence resolution (def load) turn a legitimate completion into
      // a 500 — the gate only tightens when it can prove a phantom deliverable.
      console.warn(`[complete] evidence check skipped: ${(err as Error).message}`);
    }

    // 2c. TEAM-3747 D2 — ship/CD merge-verdict gate ("no green close over
    //     unshipped work"), PARITY with the orchestrator's completeWorkflow. If the
    //     def has a ship phase, a done ship ticket must carry a merge/deploy verdict
    //     OR an explicit SHIP_BLOCKED_OUTCOMES outcome — "done + output" is NOT
    //     proof it shipped. When a ship phase isn't shipped this route must NOT fake
    //     "complete": it closes on the honest terminal phase and emits a terminal
    //     event (see closeBlocked). Same COMPLETION_EVIDENCE_REQUIRED gate — enforce
    //     by default; the explicit opt-out only shadow-logs and completes.
    try {
      const def = await resolveWorkflowDef(String(workflow.workflowDefId || ""));
      const requiredPhases = def?.completionRequiresAgentPhases || [];
      const verdict = evaluateShipVerdict(
        tickets,
        (workflow.agentTasks as Record<string, ShipTaskLike>) || {},
        requiredPhases
      );
      if (verdict.required && !verdict.shipped) {
        const offenders = verdict.offenders.map((o) => `${o.ticketId}@${o.phase}:${o.verdict}`).join(", ");
        if (COMPLETION_EVIDENCE_REQUIRED) {
          return await closeBlocked(workflowId, workflow, verdict, reason);
        }
        console.warn(
          `[complete] ${workflowId} would close as ${verdict.outcome} (shadow opt-out) — ship verdict missing: ${offenders}`
        );
      }
    } catch (err) {
      // A failure resolving the ship verdict must never turn a legitimate
      // completion into a stall — it only diverts when it can prove nothing shipped.
      console.warn(`[complete] ship-verdict check skipped: ${(err as Error).message}`);
    }

    const completedAt = new Date().toISOString();

    // 3. Roll the epic up in Jira so the board reflects the closure. Best-effort:
    //    a board without a Done transition (or DynamoDB mode) just skips this.
    let epicRolledUp = false;
    if (TICKET_PROVIDER === "jira" && workflow.epicId) {
      try {
        await JiraClient.fromEnv().transitionIssue(String(workflow.epicId), "Done");
        epicRolledUp = true;
      } catch (err) {
        console.warn(`[complete] epic ${workflow.epicId} roll-up skipped: ${(err as Error).message}`);
      }
    }

    // 4. Conditional write — set terminal phase, stamp completion, stop the
    //    watch, AND compact runaway escalation noise in the SAME write so the
    //    item shrinks rather than grows. A bloated record (near the 400KB limit
    //    from thousands of no-op escalations) is exactly what makes this write
    //    fail; rewriting humanNotifications smaller guarantees it lands.
    const compacted = compactNotifications(
      (workflow.humanNotifications as Notification[]) || []
    );
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: WORKFLOWS_TABLE,
          Key: { workflowId },
          UpdateExpression:
            "SET #phase = :complete, completedAt = :ts, previousPhase = :prev, managerWatch = :false, humanNotifications = :notifs" +
            (reason ? ", completeReason = :reason" : ""),
          // TEAM-3686: also CAS-guard on cancelledAt — a cancel landing between
          // the pre-read above (which serves the friendly 409) and this write
          // stamps cancelledAt before phase flips, and must not be overwritten
          // to complete. Mirrors workflow-store.mjs completeWorkflow.
          ConditionExpression:
            "#phase <> :complete AND #phase <> :error AND #phase <> :alreadyCancelled AND attribute_not_exists(cancelledAt)",
          ExpressionAttributeNames: { "#phase": "phase" },
          ExpressionAttributeValues: {
            ":complete": "complete",
            ":ts": completedAt,
            ":prev": workflow.phase,
            ":false": false,
            ":notifs": compacted,
            ":error": "error",
            ":alreadyCancelled": "cancelled",
            ...(reason ? { ":reason": reason } : {}),
          },
        })
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        // Distinguish a cancel that raced in after our pre-read from a phase
        // that was already terminal — the caller needs workflow_cancelled to
        // know completion lost to cancellation, not that it double-completed.
        try {
          const recheck = await ddb.send(
            new GetCommand({
              TableName: WORKFLOWS_TABLE,
              Key: { workflowId },
              ConsistentRead: true,
            })
          );
          if (recheck.Item?.cancelledAt) {
            return NextResponse.json(
              {
                error: "workflow_cancelled",
                cancelledAt: recheck.Item.cancelledAt,
                detail:
                  "cancellation precedes completion; a cancelled run cannot be completed",
              },
              { status: 409 }
            );
          }
        } catch {
          /* best-effort recheck — fall through to the generic 409 */
        }
        return NextResponse.json(
          { error: "Workflow already in terminal state", phase: workflow.phase },
          { status: 409 }
        );
      }
      throw err;
    }

    // 5. Publish workflow.complete. Two sinks, matching the orchestrator's
    //    publishEvent: EventBridge (source agentcore-hub.orchestrator, detail
    //    type workflow.complete) drives the ANALYZE trigger; the events-table
    //    row is partitioned under workflowId so the live SSE board — which
    //    queries by workflowId — clears immediately. Both are non-fatal.
    const detail = {
      workflowId,
      completedAt,
      previousPhase: workflow.phase,
      closedBy: "workflow-manager",
      epicRolledUp,
      ...(reason ? { reason } : {}),
    };
    try {
      await eventBridge.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: "agentcore-hub.orchestrator",
              DetailType: "workflow.complete",
              Detail: JSON.stringify({ ...detail, timestamp: completedAt }),
              EventBusName: EVENT_BUS,
            },
          ],
        })
      );
    } catch (err) {
      console.warn(`[complete] EventBridge publish failed: ${(err as Error).message}`);
    }
    try {
      await ddb.send(
        new PutCommand({
          TableName: EVENTS_TABLE,
          Item: {
            workflowId,
            eventId: `${Date.now()}-complete-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: completedAt,
            type: "workflow.complete",
            detail,
          },
        })
      );
    } catch {
      /* event publish is non-fatal */
    }

    console.log(
      `[complete] Workflow ${workflowId} completed (was: ${workflow.phase}, epicRolledUp=${epicRolledUp})`
    );
    return NextResponse.json(
      { status: "complete", completedAt, epicRolledUp, ...(reason ? { reason } : {}) },
      { status: 200 }
    );
  } catch (err) {
    console.error("[complete] Error:", err);
    return NextResponse.json(
      { error: `Failed to complete workflow: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
