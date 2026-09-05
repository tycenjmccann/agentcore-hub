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
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { JiraClient } from "@/lib/workflow/jira-client";
import { resolveWorkflowDef } from "@/lib/workflow/defs-loader";
import { SHIP_BLOCKED_OUTCOMES } from "@/lib/workflow/types";
import {
  resolveMissingEvidenceFromRecords,
  // TEAM-3991 D1.4 — the pure twins, shared with lambda/orchestrator/completion.mjs
  // through completion-evidence-parity.test.ts.
  openGateOf,
  parseCdEvidence,
  blockReasonWithGate,
  shipVerdictOf as classifyShipEntry,
  type OpenGate,
} from "@/lib/workflow/completion-evidence";
import {
  featureBranchMergeProbe,
  type MergeProbeInput,
  type MergeProbeResult,
} from "@/lib/workflow/merge-probe";
import agentsConfig from "@/config/agents.json";

const REGION = process.env.AWS_REGION || "us-east-1";
// TEAM-3976: the completions-record fallback reads completions/{ticketId}.json
// (same client/bucket pattern as src/app/api/workflow/[id]/agent-output/route.ts).
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
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

/**
 * TEAM-3755 F2 — build the "not already terminal" half of a terminal-claim
 * ConditionExpression from the ONE list above, so both of this route's terminal
 * writes (the green complete and closeBlocked) refuse the SAME five phases.
 *
 * The bug: the complete write listed only complete/error/cancelled by hand, so a
 * completion racing in behind an honest deploy-blocked / static-ci-only close
 * overwrote it with "complete" and destroyed the FR-D2.2 evidence. PARITY with
 * notTerminalPhaseGuard in lambda/orchestrator/completion.mjs.
 *
 * Placeholders are positional (:tp0…) so they cannot collide with a caller's SET
 * values, and each declared value IS referenced — DynamoDB rejects unused ones.
 */
function terminalPhaseGuard(): { condition: string; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const condition = TERMINAL_PHASES.map((phase, i) => {
    const key = `:tp${i}`;
    values[key] = phase;
    return `#phase <> ${key}`;
  }).join(" AND ");
  return { condition, values };
}
// PARITY with lambda/orchestrator/completion.mjs SHIP_PHASES — the phases whose
// done tickets owe a merge/deploy verdict rather than mere output.
const SHIP_PHASES = new Set(["ship"]);
// TEAM-3991 D1.4: the epic roll-up is now a retried obligation, not a one-shot
// best effort, and it works on BOTH providers (before, the dynamodb path simply
// never closed the epic — wf 7ef4fp finished with its epic open on the board).
// The backoff is env-tunable so tests pin it to 0; a real retry sleeps 1/2/4s.
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const EPIC_ROLLUP_RETRIES = Number(process.env.EPIC_ROLLUP_RETRIES) || 3;
const EPIC_ROLLUP_BACKOFF_MS = Number(process.env.EPIC_ROLLUP_BACKOFF_MS ?? 1000);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const eventBridge = new EventBridgeClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

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

/**
 * TEAM-3755 F4 — PARITY with the per-required-phase branch of
 * lambda/orchestrator/completion.mjs `isWorkflowComplete`: for EVERY phase the
 * def requires, at least one AGENT (non-human) ticket in that phase must be
 * `done`. Returns the required phases that have no such ticket (empty = clean).
 *
 * The divergence this closes: this route's only structural gate was
 * openChildren(), and its DONE_STATUSES counts "cancelled" as closed. So a run
 * whose single ship ticket was CANCELLED had no open children, produced ZERO
 * done ship tickets, and evaluateShipVerdict's "nothing to inspect" branch
 * returned green — the route completed a run whose required ship phase never
 * ran, while the orchestrator twin refused it. `done` is checked strictly here
 * (completion.mjs `isDone` is status === "done"), so cancelled can never satisfy
 * a required phase.
 *
 * Deliberately NOT ported: completion.mjs also requires every ACTIVE BLOCKING
 * review gate for the phase to be approved. That clause needs the def's
 * reviewGates + gate-ticket resolution and is a separate finding — this helper
 * closes only the cancelled/empty-phase hole.
 */
function requiredPhasesMissingDoneAgent(tickets: Ticket[], requiredPhases: string[]): string[] {
  if (!requiredPhases.length) return [];
  const isHuman = (a: unknown) => typeof a === "string" && a.startsWith("human:");
  return requiredPhases.filter(
    (phase) =>
      !tickets.some(
        (t) =>
          t.type !== "epic" &&
          !isHuman(t.assignee) &&
          phaseOfTicket(t) === phase &&
          String(t.status || "").toLowerCase() === "done"
      )
  );
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
 * `shipVerdictOf`. Classify ONE ship-phase agentTasks entry: "shipped" (a
 * non-empty mergeCommit, or an explicit outcome==="shipped"), a
 * SHIP_BLOCKED_OUTCOMES value (an explicit terminal block), or null (a phantom
 * green close — CI may be green but nothing merged/deployed and no block
 * declared). Unlike missingEvidenceTickets, mere output/artifact is NOT proof
 * the work shipped. Keep in agreement with completion.mjs.
 *
 * TEAM-3755 F1 (P0): `commitSha` is deliberately NOT a merge signal, in BOTH
 * twins. It is the HEAD of the still-unmerged feature branch and is harvested
 * onto every dev/ship completion record, so accepting it returned "shipped" for
 * unmerged work and let the gate close a run "complete" over an unshipped branch
 * (the 29g73c failure; FR-D2.2 / AC-D2.4).
 *
 * TEAM-3991 D1.4: the implementation now lives in completion-evidence.ts next to
 * its parity test, and accepts `deployed` as proof of the same strength as
 * `shipped` (wf sffzti deployed and was filed static-ci-only because no accepted
 * outcome spelled the word the CD agent's own evidence uses).
 */
function shipVerdictOf(entry: ShipTaskLike | undefined): string | null {
  return classifyShipEntry(entry);
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
  // No done ship AGENT ticket to inspect: keep the twin's "cannot prove a
  // phantom" stance (completion.mjs evaluateShipVerdict does the same) rather
  // than inventing a block here. TEAM-3755 F4: this branch is no longer a way to
  // complete a run whose required ship phase never produced a done ticket — the
  // requiredPhasesMissingDoneAgent gate refuses that case UPSTREAM of this call,
  // exactly as isWorkflowComplete does on the orchestrator side. Reaching here
  // with required=true and shipped=true now means only "nothing owed a verdict".
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
  reason: string | undefined,
  // TEAM-3991 D1.4: the human gate this run is actually waiting on, if any. It
  // goes into the blockReason AND the terminal event, so a reader can link
  // straight to the ticket instead of re-deriving it (wf 1pl3h1 closed with no
  // mention of escalation TEAM-3757, the one thing a human had to act on).
  openGate: OpenGate | null = null
): Promise<NextResponse> {
  const outcome = verdict.outcome as string; // a SHIP_BLOCKED_OUTCOMES value
  const completedAt = new Date().toISOString();
  const blockReason = blockReasonWithGate(verdict.blockReason || reason || null, openGate);
  const compacted = compactNotifications((workflow.humanNotifications as Notification[]) || []);
  // TEAM-3755 F2: same derived guard as the green complete write above — one list,
  // both terminal writes.
  const guard = terminalPhaseGuard();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        UpdateExpression:
          "SET #phase = :outcome, completedAt = :ts, previousPhase = :prev, managerWatch = :false, humanNotifications = :notifs" +
          (blockReason ? ", blockReason = :reason" : ""),
        ConditionExpression: `${guard.condition} AND attribute_not_exists(cancelledAt)`,
        ExpressionAttributeNames: { "#phase": "phase" },
        ExpressionAttributeValues: {
          ":outcome": outcome,
          ":ts": completedAt,
          ":prev": workflow.phase,
          ":false": false,
          ":notifs": compacted,
          ...guard.values,
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
    openGate: openGate || null,
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

/**
 * TEAM-3991 D1.3 PARITY (mirrors the orchestrator's merge-proof stamp) — write
 * GitHub's merge proof onto the ship tasks that self-reported nothing, so the
 * re-judged verdict (and the dashboard) tell the truth.
 *
 * Two rules that are not negotiable here:
 *  - A recorded BLOCK is never overwritten. An offender whose verdict is anything
 *    other than "none" already said something; a merge does not un-block a
 *    deploy-blocked ticket, and `blockReason` is never touched by this path.
 *  - Scoped conditional write on the EXISTING entry only
 *    (`attribute_exists(agentTasks.#tid)`), same shape as the cd-evidence stamp, so
 *    a stale ticket id can never materialize a phantom task.
 */
async function stampMergeProof(
  workflowId: string,
  workflow: Record<string, unknown>,
  verdict: ShipVerdict,
  probe: MergeProbeResult,
  agentTasks: Record<string, Record<string, unknown>>
): Promise<void> {
  for (const o of verdict.offenders) {
    if (o.verdict && o.verdict !== "none") continue;
    const fields: Record<string, unknown> = {
      mergeCommit: probe.mergeCommit || `merged:${String(workflow.featureBranch || "")}`,
      mergeVerifiedBy: "github",
    };
    if (probe.prUrl && !agentTasks[o.ticketId]?.prUrl) fields.prUrl = probe.prUrl;
    const names: Record<string, string> = { "#tid": o.ticketId };
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    let i = 0;
    for (const [k, v] of Object.entries(fields)) {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      sets.push(`agentTasks.#tid.#f${i} = :v${i}`);
      i++;
    }
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: WORKFLOWS_TABLE,
          Key: { workflowId },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "attribute_exists(agentTasks.#tid)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        })
      );
    } catch (err) {
      if ((err as Error).name !== "ConditionalCheckFailedException") {
        console.warn(`[complete] merge-proof stamp failed for ${o.ticketId}: ${(err as Error).message}`);
      }
    }
    agentTasks[o.ticketId] = { ...(agentTasks[o.ticketId] || {}), ...fields };
  }
  console.log(
    `[complete] ${workflowId}: GitHub proves ${String(workflow.featureBranch || "")} merged ` +
      `(${probe.mergeCommit || "compare"}) — ship verdict taken from ground truth`
  );
}

/**
 * TEAM-3991 D1.4 PARITY (mirrors the orchestrator's harvestCdEvidence) — the
 * run's OWN account of its deploy. The release manager writes
 * `workflows/<wf>/shared/cd-evidence/deploy-*.md` ("# DEPLOY SUCCEEDED …" /
 * "# PREFLIGHT BLOCKED …") but its report_completion tool has no outcome field,
 * so the ship gate saw a done CD ticket carrying no verdict at all and closed
 * every deployed run static-ci-only (wf sffzti) — while wf 1pl3h1's
 * "PREFLIGHT BLOCKED" file went unread and the run closed `complete`.
 *
 * Newest file wins (LastModified, key as tiebreak). Stamps the parsed verdict
 * onto every passed ship ticket AND onto the in-memory agentTasks, so the ship
 * ladder below decides on it exactly as if the agent had self-reported it.
 * Best-effort: no bucket, no file, an unparseable file or any S3 error ⇒ null.
 */
async function harvestCdEvidence(
  workflowId: string,
  shipTicketIds: string[],
  agentTasks: Record<string, Record<string, unknown>>
): Promise<{ outcome: string; blockReason?: string; evidenceKey: string } | null> {
  if (!ARTIFACT_BUCKET || shipTicketIds.length === 0) return null;
  try {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: ARTIFACT_BUCKET,
        Prefix: `workflows/${workflowId}/shared/cd-evidence/`,
      })
    );
    const files = (listed?.Contents || [])
      .filter((o) => /\/deploy-[^/]*\.md$/i.test(String(o?.Key || "")))
      .sort((a, b) => {
        const at = Date.parse(String(a.LastModified || "")) || 0;
        const bt = Date.parse(String(b.LastModified || "")) || 0;
        return bt - at || String(b.Key).localeCompare(String(a.Key));
      });
    if (files.length === 0) return null;
    const evidenceKey = String(files[0].Key);
    const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: evidenceKey }));
    const parsed = parseCdEvidence(await obj.Body?.transformToString());
    if (!parsed) return null;
    const fields: Record<string, unknown> = { outcome: parsed.outcome, evidenceKey };
    if (parsed.blockReason) fields.blockReason = String(parsed.blockReason).slice(0, 500);
    for (const ticketId of shipTicketIds) {
      // Scoped conditional write on the existing entry only — same shape as the
      // evidence backfill above (never materializes a phantom task).
      const names: Record<string, string> = { "#tid": ticketId };
      const values: Record<string, unknown> = {};
      const sets: string[] = [];
      let i = 0;
      for (const [k, v] of Object.entries(fields)) {
        names[`#f${i}`] = k;
        values[`:v${i}`] = v;
        sets.push(`agentTasks.#tid.#f${i} = :v${i}`);
        i++;
      }
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: WORKFLOWS_TABLE,
            Key: { workflowId },
            UpdateExpression: `SET ${sets.join(", ")}`,
            ConditionExpression: "attribute_exists(agentTasks.#tid)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          })
        );
      } catch (err) {
        if ((err as Error).name !== "ConditionalCheckFailedException") {
          console.warn(`[complete] cd-evidence stamp failed for ${ticketId}: ${(err as Error).message}`);
        }
      }
      agentTasks[ticketId] = { ...(agentTasks[ticketId] || {}), ...fields };
    }
    console.log(`[complete] ${workflowId}: cd-evidence ${evidenceKey} → outcome ${parsed.outcome}`);
    return { ...parsed, evidenceKey };
  } catch (err) {
    console.warn(`[complete] cd-evidence harvest skipped for ${workflowId}: ${(err as Error).message}`);
    return null;
  }
}

/** Move the epic to Done through whichever backend is configured. */
async function transitionEpicToDone(epicId: string): Promise<void> {
  if (TICKET_PROVIDER === "jira") {
    await JiraClient.fromEnv().transitionIssue(epicId, "Done");
    return;
  }
  // PARITY with the orchestrator's transitionTicketToDone: a scoped write on the
  // TICKETS table (not the workflows table, so the single-writer rule is intact).
  await ddb.send(
    new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId: epicId },
      UpdateExpression: "SET #s = :s, #u = :u",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ":s": "done", ":u": new Date().toISOString() },
    })
  );
}

/**
 * TEAM-3991 D1.4 PARITY (mirrors rollUpEpic in lambda/orchestrator/index.mjs) —
 * roll the root epic to Done with retries. Idempotent by construction: a Done
 * epic transitioned to Done again is a success, not an error. Never throws.
 */
async function rollUpEpic(epicId: string): Promise<{ ok: boolean; attempts: number; lastError: string | null }> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= EPIC_ROLLUP_RETRIES; attempt++) {
    try {
      await transitionEpicToDone(epicId);
      return { ok: true, attempts: attempt, lastError: null };
    } catch (err) {
      lastError = (err as Error).message || String(err);
    }
    console.warn(`[complete] epic ${epicId} roll-up attempt ${attempt}/${EPIC_ROLLUP_RETRIES} failed: ${lastError}`);
    if (attempt < EPIC_ROLLUP_RETRIES && EPIC_ROLLUP_BACKOFF_MS > 0) {
      await new Promise((r) => setTimeout(r, EPIC_ROLLUP_BACKOFF_MS * 2 ** (attempt - 1)));
    }
  }
  return { ok: false, attempts: EPIC_ROLLUP_RETRIES, lastError };
}

/** Publish to both sinks (EventBridge + the events table). Both non-fatal. */
async function publishBoth(workflowId: string, type: string, detail: Record<string, unknown>): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    await eventBridge.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: "agentcore-hub.orchestrator",
            DetailType: type,
            Detail: JSON.stringify({ ...detail, timestamp }),
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
          eventId: `${Date.now()}-${type}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp,
          type,
          detail,
        },
      })
    );
  } catch {
    /* event publish is non-fatal */
  }
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
      const agentTasks = (workflow.agentTasks as Record<string, AgentTaskLike>) || {};
      let missing = missingEvidenceTickets(tickets, agentTasks, requiredPhases);
      // TEAM-3976: a ticket closed out-of-band (mark_done) BEFORE its
      // report_completion landed has an evidence-less agentTasks entry — the
      // orchestrator's one-shot harvest found no record, and the later done→done
      // transition was a no-op so it never re-ran. Consult the authoritative
      // completions/{ticketId}.json for the would-be offenders ONLY (no S3 reads
      // on the happy path) and backfill the entry so the run self-heals. The
      // resolver swallows read/backfill failures itself — a failed read keeps the
      // offender (409), it must never fall through to the outer "skipped" catch.
      if (missing.length > 0 && ARTIFACT_BUCKET) {
        missing = await resolveMissingEvidenceFromRecords(missing, agentTasks, {
          readCompletionRecord: async (ticketId) => {
            try {
              const obj = await s3.send(
                new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: `completions/${ticketId}.json` })
              );
              const body = await obj.Body?.transformToString();
              return body ? (JSON.parse(body) as Record<string, unknown>) : null;
            } catch (err) {
              const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
              if (e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) {
                return null;
              }
              throw err; // logged by the resolver; offender stays
            }
          },
          // Hand-port of lambda/orchestrator/workflow-store.mjs mergeTaskMetadata:
          // field-scoped SET on the existing entry only (attribute_exists guard),
          // a missing entry is dropped rather than materialized.
          backfill: async (ticketId, fields) => {
            const names: Record<string, string> = { "#tid": ticketId };
            const values: Record<string, unknown> = {};
            const sets: string[] = [];
            let i = 0;
            for (const [k, v] of Object.entries(fields)) {
              if (v === undefined || v === null) continue;
              names[`#f${i}`] = k;
              values[`:v${i}`] = v;
              sets.push(`agentTasks.#tid.#f${i} = :v${i}`);
              i++;
            }
            if (!sets.length) return;
            try {
              await ddb.send(
                new UpdateCommand({
                  TableName: WORKFLOWS_TABLE,
                  Key: { workflowId },
                  UpdateExpression: `SET ${sets.join(", ")}`,
                  ConditionExpression: "attribute_exists(agentTasks.#tid)",
                  ExpressionAttributeNames: names,
                  ExpressionAttributeValues: values,
                })
              );
            } catch (err) {
              if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
            }
          },
          log: console.warn,
        });
      }
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

    // 2b′. TEAM-3755 F4 — structural parity with completion.mjs
    //      isWorkflowComplete: every required agent phase must have a DONE agent
    //      ticket. openChildren() alone cannot see this, because it counts a
    //      CANCELLED ticket as closed — so a required ship phase whose only
    //      ticket was cancelled passed every gate and completed green here while
    //      the orchestrator twin refused. Enforced unconditionally (no
    //      COMPLETION_EVIDENCE_REQUIRED opt-out): this is a structural
    //      "the work never ran" refusal, the same class as the open-children
    //      gate, not an evidence heuristic.
    try {
      const def = await resolveWorkflowDef(String(workflow.workflowDefId || ""));
      const requiredPhases = def?.completionRequiresAgentPhases || [];
      const unrun = requiredPhasesMissingDoneAgent(tickets, requiredPhases);
      if (unrun.length > 0) {
        return NextResponse.json(
          {
            error: "required_phase_incomplete",
            phases: unrun,
            hint:
              "These required phases have no completed agent ticket (a cancelled ticket " +
              "does not count). Finish the phase — completion has no bypass.",
          },
          { status: 409 }
        );
      }
    } catch (err) {
      // A def that will not resolve must not turn a legitimate completion into a
      // 500 — same discipline as the evidence gate: only tighten when provable.
      console.warn(`[complete] required-phase check skipped: ${(err as Error).message}`);
    }

    // TEAM-3991 D1.4 — what the terminal event REPORTS. A run whose CD evidence
    // says DEPLOY SUCCEEDED is `deployed`, not the CI-only default.
    let provenShipOutcome: string | null = null;

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
      const agentTasks = (workflow.agentTasks as Record<string, Record<string, unknown>>) || {};
      // TEAM-3991 D1.4: before judging, read the CD agent's own deploy evidence for
      // any done ship ticket that reported NO outcome — its report_completion tool
      // has no outcome field, so the file on S3 is the only place the verdict
      // exists. `deployed` is what the terminal event must then REPORT.
      const shipPhases = requiredPhases.filter((ph) => SHIP_PHASES.has(ph));
      if (shipPhases.length > 0) {
        const outcomeless = tickets
          .filter(
            (t) =>
              t.type !== "epic" &&
              String(t.status || "").toLowerCase() === "done" &&
              !String(t.assignee || "").startsWith("human:") &&
              shipPhases.includes(phaseOfTicket(t) as string) &&
              !agentTasks[String(t.ticketId)]?.outcome
          )
          .map((t) => String(t.ticketId));
        if (outcomeless.length > 0) {
          const cd = await harvestCdEvidence(workflowId, outcomeless, agentTasks);
          if (cd?.outcome === "deployed") provenShipOutcome = "deployed";
        }
      }
      let verdict = evaluateShipVerdict(
        tickets,
        agentTasks as Record<string, ShipTaskLike>,
        requiredPhases
      );
      // TEAM-3991 D1.3 — GitHub is the ground truth, and it is consulted BEFORE the
      // verdict is acted on. The release manager's report_completion has no
      // merge_commit field, so a merged run's self-report can never say "shipped";
      // without this the route closed every deployed run static-ci-only and could
      // not distinguish it from a run whose branch never landed. Three answers:
      // proven merged → stamp the proof and re-judge; proven unmerged → the honest
      // blocked close names it; unknown → self-report decides, untouched.
      if (verdict.required && !verdict.shipped && shipPhases.length > 0) {
        const probe = await featureBranchMergeProbe(workflow as MergeProbeInput);
        if (probe.merged === true) {
          await stampMergeProof(workflowId, workflow, verdict, probe, agentTasks);
          verdict = evaluateShipVerdict(
            tickets,
            agentTasks as Record<string, ShipTaskLike>,
            requiredPhases
          );
        } else if (probe.merged === false) {
          console.error(
            `[complete] ${workflowId}: feature branch ${String(workflow.featureBranch)} is NOT merged ` +
              `(${probe.reason}) — refusing a green close.`
          );
          verdict = {
            ...verdict,
            blockReason: verdict.blockReason || `feature branch not merged: ${probe.reason}`,
          };
        }
      }
      if (verdict.required && !verdict.shipped) {
        const offenders = verdict.offenders.map((o) => `${o.ticketId}@${o.phase}:${o.verdict}`).join(", ");
        if (COMPLETION_EVIDENCE_REQUIRED) {
          return await closeBlocked(workflowId, workflow, verdict, reason, openGateOf(tickets));
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

    // 2d. TEAM-3991 D1.4 — an OPEN human gate forbids a green close, whatever the
    //     ship verdict says. wf 1pl3h1 closed `complete` while escalation gate
    //     TEAM-3757 sat in_review over unmerged PR #274: every agent ticket was
    //     done, so every gate above passed, and the one person who still owed the
    //     run a decision was never mentioned. Close honestly and NAME the gate.
    //
    //     The outcome is `static-ci-only`, deliberately NOT a literal "blocked"
    //     phase: TERMINAL_PHASES is the closed set both terminal writes refuse to
    //     overwrite, so a phase outside it could be silently clobbered by a later
    //     completion CAS (the TEAM-3755 F2 class). The specifics travel in
    //     `openGate` + the blockReason.
    const openGate = openGateOf(tickets);
    if (openGate) {
      console.error(
        `[complete] ${workflowId}: refusing green close — ${openGate.kind} ${openGate.ticketId} is ${openGate.status}`
      );
      return await closeBlocked(
        workflowId,
        workflow,
        {
          required: true,
          shipped: false,
          outcome: "static-ci-only",
          blockReason: `gate ${openGate.ticketId} (${openGate.title || openGate.kind}) is ${openGate.status}`,
          offenders: [],
        },
        reason,
        openGate
      );
    }

    const completedAt = new Date().toISOString();

    // 4. Conditional write — set terminal phase, stamp completion, stop the
    //    watch, AND compact runaway escalation noise in the SAME write so the
    //    item shrinks rather than grows. A bloated record (near the 400KB limit
    //    from thousands of no-op escalations) is exactly what makes this write
    //    fail; rewriting humanNotifications smaller guarantees it lands.
    const compacted = compactNotifications(
      (workflow.humanNotifications as Notification[]) || []
    );
    const completeGuard = terminalPhaseGuard();
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: WORKFLOWS_TABLE,
          Key: { workflowId },
          UpdateExpression:
            "SET #phase = :complete, completedAt = :ts, previousPhase = :prev, managerWatch = :false, " +
            // TEAM-3991 D1.4: the epic roll-up obligation is created ATOMICALLY with
            // the terminal claim (parity with workflow-store.mjs completeWorkflow), so
            // exactly one caller owns it and a crash leaves a flag the sweep retries —
            // there is no window where the run is complete with nobody responsible.
            (workflow.epicId ? "epicRollupPending = :pending, " : "") +
            "humanNotifications = :notifs" +
            (reason ? ", completeReason = :reason" : ""),
          // TEAM-3686: also CAS-guard on cancelledAt — a cancel landing between
          // the pre-read above (which serves the friendly 409) and this write
          // stamps cancelledAt before phase flips, and must not be overwritten
          // to complete. Mirrors workflow-store.mjs completeWorkflow.
          // TEAM-3755 F2: the phase half of the guard now covers ALL FIVE
          // terminal phases (it omitted the D2 blocked outcomes), derived from
          // TERMINAL_PHASES so it cannot drift from closeBlocked's guard.
          ConditionExpression: `${completeGuard.condition} AND attribute_not_exists(cancelledAt)`,
          ExpressionAttributeNames: { "#phase": "phase" },
          ExpressionAttributeValues: {
            ":complete": "complete",
            ...(workflow.epicId ? { ":pending": true } : {}),
            ":ts": completedAt,
            ":prev": workflow.phase,
            ":false": false,
            ":notifs": compacted,
            ...completeGuard.values,
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

    // 4b. TEAM-3991 D1.4 — discharge the roll-up obligation this claim created.
    //     Success → clear the flag, then announce epicRolledUp:true. Failure → keep
    //     the flag (so the sweep retries), announce the failure observably and say
    //     epicRolledUp:false. The run is NEVER un-completed: the delivery is real,
    //     only the board label is missing. PARITY: finalizeWithEpicRollUp.
    let epicRolledUp = false;
    if (workflow.epicId) {
      const rollup = await rollUpEpic(String(workflow.epicId));
      epicRolledUp = rollup.ok;
      if (rollup.ok) {
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: WORKFLOWS_TABLE,
              Key: { workflowId },
              UpdateExpression: "REMOVE epicRollupPending",
              ConditionExpression: "attribute_exists(epicRollupPending)",
            })
          );
        } catch (err) {
          if ((err as Error).name !== "ConditionalCheckFailedException") {
            console.warn(`[complete] clearing epicRollupPending failed: ${(err as Error).message}`);
          }
        }
      } else {
        console.error(
          `[complete] epic ${workflow.epicId} roll-up FAILED after ${rollup.attempts} attempts: ${rollup.lastError}`
        );
        await publishBoth(workflowId, "workflow.epic_rollup_failed", {
          workflowId,
          epicId: String(workflow.epicId),
          attempts: rollup.attempts,
          lastError: rollup.lastError,
        });
      }
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
      // TEAM-3991 D1.4: a deployed run reports `deployed`, not the CI-only default.
      ...(provenShipOutcome ? { outcome: provenShipOutcome } : {}),
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
      {
        status: "complete",
        completedAt,
        epicRolledUp,
        ...(provenShipOutcome ? { outcome: provenShipOutcome } : {}),
        ...(reason ? { reason } : {}),
      },
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
