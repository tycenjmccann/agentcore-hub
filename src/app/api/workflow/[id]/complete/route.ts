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
 *   2b. Refuses (409 open_follow_up_pr) once the unified PR merged while a
 *      follow-up PR this run opened into the default branch is still open — the
 *      orchestrator's own followUpPrGate (TEAM-6032 DL-038, TEAM-6136) — and
 *      (409 unmerged_branch) when GitHub proves the feature branch never landed
 *      (TEAM-6187, the orchestrator's merge-verify refusal). TEAM-6187: every
 *      gate here reads the EFFECTIVE def (framework overlay + CD-registry ship
 *      strip) and the LIVE roster, exactly as completeWorkflow does.
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
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { JiraClient } from "@/lib/workflow/jira-client";
import { resolveWorkflowDef } from "@/lib/workflow/defs-loader";
import { applyFramework, type WorkflowDef } from "@/lib/workflow/workflow-defs";
import { effectiveDefFor } from "@/lib/workflow/intake-materialize";
import { loadRoster } from "@/lib/workflow/roster-loader";
import { deliveryModeFor, loadCdRegistry } from "@/lib/cd-registry";
import { SHIP_BLOCKED_OUTCOMES } from "@/lib/workflow/types";
import { resolveMissingEvidenceFromRecords } from "@/lib/workflow/completion-evidence";
import {
  followUpPrGateConfigured,
  memoizedReader,
  openFollowUpPrsAtCompletion,
  readCompletionRecords,
  recheckShipVerdict,
  type MergeProbe,
} from "@/lib/workflow/follow-up-pr-gate";
// TEAM-6136 F6: the orchestrator's OWN framework selector (pure, no imports) —
// imported directly, as follow-up-pr-gate.ts imports completion.mjs, so there is
// one implementation of "which SDLC framework does this run follow".
import { frameworkOfWorkflow } from "../../../../../../lambda/orchestrator/artifact-chain.mjs";
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

// agentId → agent phase, from the BUNDLED roster. TEAM-6187: this is the
// FALLBACK only — the orchestrator reads the live S3 config/agents.json
// (loadAgentRoster, FALLBACK_ROSTER on failure), so does this route (livePhaseMap).
// Used to route a child ticket to its agent phase when the ticket carries no
// explicit `phase` stamp (TEAM-3619 D4c stamps spawned fixes; agent tickets are
// derived from their assignee, exactly as the orchestrator does).
const AGENT_PHASE_BY_ID: Record<string, string> = Object.fromEntries(
  (agentsConfig.agents as Array<{ agentId: string; phase: string }>).map((a) => [a.agentId, a.phase])
);
type PhaseById = Record<string, string>;

/**
 * TEAM-6187 — the live roster's agentId → phase map, read ONCE per request and
 * only when a gate actually needs it (lazy, so the TEAM-3976 zero-S3-reads happy
 * path holds). Mirror of the orchestrator's getAgentDef(id)?.phase: the S3 doc
 * REPLACES the bundled map when it loads; an unreadable/empty roster falls back
 * to the bundled agents.json (the orchestrator's FALLBACK_ROSTER). Never throws.
 */
function livePhaseMap(): () => Promise<PhaseById> {
  let loading: Promise<PhaseById> | null = null;
  return () => {
    if (!loading) {
      loading = loadRoster()
        .then((roster) => {
          const live = roster.filter((a) => a?.agentId && typeof a.phase === "string" && a.phase);
          return live.length ? Object.fromEntries(live.map((a) => [a.agentId, a.phase as string])) : AGENT_PHASE_BY_ID;
        })
        .catch(() => AGENT_PHASE_BY_ID);
    }
    return loading;
  };
}

/**
 * TEAM-6187 — mirror of the orchestrator's getEffectiveWorkflowDef (index.mjs):
 * the configured def with the run's SDLC framework overlay applied, then the
 * CD-registry handoff strip (effectiveDefFor ≡ cd-registry.mjs stripShipPhases).
 * Every gate/verdict decision reads THIS, never the raw def. The registry is read
 * only when the def has a ship phase/gate to strip — stripping is a no-op
 * otherwise, and the TEAM-3976 happy path contractually makes zero S3 reads.
 * Null when the def id is unknown (callers treat that as "nothing required").
 *
 * TEAM-6136 F6 — the framework itself is chosen by the orchestrator's exported
 * frameworkOfWorkflow (artifact-chain.mjs: `row.sdlcFramework || input.sdlcFramework`,
 * then resolveFramework), NOT a hand-mirror: the mirror used `??`, so an
 * empty-string row stamp was rejected by resolveFramework here while the
 * orchestrator fell through to the request's overlay — two verdicts for one run.
 * The row's `input` is the same plain object on both sides (Document client).
 */
async function resolveEffectiveWorkflowDef(workflow: Record<string, unknown>): Promise<WorkflowDef | null> {
  const def = await resolveWorkflowDef(String(workflow.workflowDefId || ""));
  if (!def) return null;
  const framed = applyFramework(def, frameworkOfWorkflow(def, workflow));
  const touchesShip =
    (framed.completionRequiresAgentPhases || []).some((p) => SHIP_PHASES.has(p)) ||
    (framed.reviewGates || []).some((g) => SHIP_PHASES.has(g?.afterPhase));
  if (!touchesShip) return framed;
  const repoUrl = (workflow.repoConfig as { repos?: Array<{ url?: string }> } | undefined)?.repos?.[0]?.url;
  const cdRegistered = deliveryModeFor(await loadCdRegistry(), repoUrl) === "cd";
  return effectiveDefFor(framed, { cdRegistered });
}

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

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const eventBridge = new EventBridgeClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

/**
 * TEAM-3976 — completions/{ticketId}.json, or null when absent (404 / NoSuchKey).
 * Any other failure throws; each caller decides what that means (the evidence
 * resolver keeps the offender, the follow-up PR gate falls back to prUrl).
 * TEAM-6136: hoisted out of step 2b so the follow-up PR gate reads the same way.
 */
async function readCompletionRecordFromS3(ticketId: string): Promise<Record<string, unknown> | null> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: `completions/${ticketId}.json` }));
  const body = await obj.Body?.transformToString();
  return body ? (JSON.parse(body) as Record<string, unknown>) : null;
}

function isMissingObject(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

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

/** The phase a child ticket states on its own (no roster): an explicit `phase`
 *  stamp (TEAM-3619 D4c routes spawned fixes to their originating upstream phase),
 *  the `phase:<p>` label Jira mode keeps (the hub stamps it on every skeleton
 *  ticket), or a `Ship:`/`CD:` title — single-agent defs (operator) ship from a
 *  persona rostered under development, so the roster alone misses their Ship ticket. */
function statedTicketPhase(t: Ticket): string | undefined {
  if (typeof t.phase === "string" && t.phase) return t.phase;
  const labelled = (Array.isArray(t.labels) ? t.labels : [])
    .map((l) => (typeof l === "string" && l.startsWith("phase:") ? l.slice("phase:".length) : ""))
    .find(Boolean);
  if (labelled) return labelled;
  if (/^(Ship|CD):/i.test(String(t.title || ""))) return "ship";
  return undefined;
}

/** The agent phase a child ticket belongs to: its stated phase wins, else the
 *  assignee's roster phase (TEAM-6187: the LIVE roster map, bundled as fallback,
 *  exactly as the orchestrator's getAgentDef). Undefined for humans/unknowns. */
function phaseOfTicket(t: Ticket, phaseById: PhaseById): string | undefined {
  const stated = statedTicketPhase(t);
  if (stated) return stated;
  const assignee = typeof t.assignee === "string" ? t.assignee : "";
  return phaseById[assignee];
}

/** Does resolving these tickets' phases need the roster at all? Only a non-epic,
 *  non-human ticket with no stated phase does — so the TEAM-3976 happy path
 *  (every ticket phase-stamped) never pays the S3 read. */
function ticketsNeedRoster(tickets: Ticket[]): boolean {
  return tickets.some(
    (t) =>
      t.type !== "epic" &&
      !statedTicketPhase(t) &&
      typeof t.assignee === "string" &&
      t.assignee.length > 0 &&
      !t.assignee.startsWith("human:")
  );
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
  requiredPhases: string[],
  phaseById: PhaseById
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
    // Human review gates owe no deliverable (PARITY with completion.mjs
    // isHumanGateTicket): hub-materialized gates carry `phase:<afterPhase>`, so
    // phaseOfTicket resolves them into a required phase with no agentTask evidence.
    if (isHumanGateTicket(t)) continue;
    const phase = phaseOfTicket(t, phaseById);
    if (!phase || !required.has(phase)) continue;
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const hasOutput = typeof entry?.output === "string" && entry.output.trim().length > 0;
    const hasArtifact = typeof entry?.artifactKey === "string" && entry.artifactKey.length > 0;
    if (!hasOutput && !hasArtifact) missing.push({ ticketId, phase });
  }
  return missing;
}

/** Human review gate (assignee `human:<who>` or `human-review` label) — twin of completion.mjs. */
function isHumanGateTicket(t: Ticket): boolean {
  if (typeof t.assignee === "string" && t.assignee.startsWith("human:")) return true;
  const labels = (t as { labels?: unknown }).labels;
  return Array.isArray(labels) && labels.some((l) => String(l).trim().toLowerCase() === "human-review");
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
function requiredPhasesMissingDoneAgent(tickets: Ticket[], requiredPhases: string[], phaseById: PhaseById): string[] {
  if (!requiredPhases.length) return [];
  const isHuman = (a: unknown) => typeof a === "string" && a.startsWith("human:");
  return requiredPhases.filter(
    (phase) =>
      !tickets.some(
        (t) =>
          t.type !== "epic" &&
          !isHuman(t.assignee) &&
          phaseOfTicket(t, phaseById) === phase &&
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
  /** TEAM-4768 pure handoff — read ONLY by the follow-up PR gate's guard (TEAM-6136). */
  handoff: boolean;
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
 * TEAM-4763 P1-A — this mirror gained two terms it had drifted without: "handoff"
 * (delivered to another team to land, so the PR is OPEN — its own verdict, never an
 * alias for "shipped", and it SATISFIES the gate) and "empty_sweep" (a sweep with
 * nothing to remove; TEAM-4740 landed it in completion.mjs only, docs/architecture.md
 * DL-031). Both were reading as null here, i.e. as silence.
 */
function shipVerdictOf(entry: ShipTaskLike | undefined): string | null {
  if (!entry || typeof entry !== "object") return null;
  const outcome = typeof entry.outcome === "string" ? entry.outcome.trim().toLowerCase() : "";
  if ((SHIP_BLOCKED_OUTCOMES as readonly string[]).includes(outcome)) return outcome;
  if (outcome === "handoff") return "handoff";
  const merged = typeof entry.mergeCommit === "string" && entry.mergeCommit.trim().length > 0;
  if (merged || outcome === "shipped" || outcome === "empty_sweep") return "shipped";
  return null;
}

/** Hand-port of completion.mjs SHIP_SATISFIED_VERDICTS (TEAM-4763 P1-A). */
const SHIP_SATISFIED_VERDICTS: readonly string[] = ["shipped", "handoff"];

/**
 * TEAM-3747 D2 PARITY — hand-port of lambda/orchestrator/completion.mjs
 * `evaluateShipVerdict`. Decide the ship/CD verdict for the whole run: every done
 * ship AGENT ticket must carry a positive merge/deploy verdict. Same discipline as
 * the orchestrator twin — "cannot prove a phantom with nothing to inspect → stay
 * green"; human review-gate tickets owe no verdict; "deploy-blocked" outranks
 * "static-ci-only". Runs with no ship phase return required=false (untouched).
 * Keep this in agreement with completion.mjs. TEAM-6136: TEAM-4768's `handoff`
 * key (every inspected ship ticket handed off) is now carried too — it exempts a
 * pure-handoff run from the follow-up PR gate, exactly as the orchestrator's
 * `!verdict?.handoff`, and nothing else in this route reads it.
 */
function evaluateShipVerdict(
  tickets: Ticket[],
  agentTasks: Record<string, ShipTaskLike>,
  requiredPhases: string[],
  phaseById: PhaseById
): ShipVerdict {
  const inert: ShipVerdict = { required: false, shipped: true, handoff: false, outcome: null, blockReason: null, offenders: [] };
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
      phases.has(phaseOfTicket(t, phaseById) as string)
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
  let handoffs = 0;
  const offenders: ShipVerdict["offenders"] = [];
  for (const t of shipTickets) {
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const verdict = shipVerdictOf(entry);
    // TEAM-4763 P1-A: "handoff" satisfies the gate alongside "shipped".
    if (verdict && SHIP_SATISFIED_VERDICTS.includes(verdict)) {
      if (verdict === "handoff") handoffs++;
      continue;
    }
    offenders.push({ ticketId, phase: phaseOfTicket(t, phaseById) as string, verdict: verdict || "none" });
    if (verdict === "deploy-blocked") {
      blocked = "deploy-blocked";
      if (!blockReason && entry && typeof entry.blockReason === "string") blockReason = entry.blockReason;
    } else if (!blocked) {
      blocked = "static-ci-only";
    }
  }
  if (offenders.length === 0) {
    return { required: true, shipped: true, handoff: handoffs === shipTickets.length, outcome: null, blockReason: null, offenders: [] };
  }
  return { required: true, shipped: false, handoff: false, outcome: blocked || "static-ci-only", blockReason, offenders };
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
          ? await getTicketsForWorkflowFromJira(workflowId, { requireComplete: true })
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

    // TEAM-6187: ONE effective def and ONE roster map feed every gate below (2b,
    // 2b′, 2c) — the orchestrator's getEffectiveWorkflowDef + getAgentDef. A def
    // that will not resolve must not turn a legitimate completion into a 500 (the
    // gates' long-standing discipline): it is logged once and nothing is required.
    let effectiveDef: WorkflowDef | null = null;
    try {
      effectiveDef = await resolveEffectiveWorkflowDef(workflow);
    } catch (err) {
      console.warn(`[complete] workflow def unresolved — phase gates skipped: ${(err as Error).message}`);
    }
    const requiredPhases: string[] = effectiveDef?.completionRequiresAgentPhases || [];
    const livePhases = livePhaseMap();
    const phaseById: PhaseById =
      requiredPhases.length > 0 && ticketsNeedRoster(tickets) ? await livePhases() : AGENT_PHASE_BY_ID;

    // 2b. TEAM-3619 D4a: deliverable-evidence gate. Every done ticket in a
    //     completion-required phase must have real work behind it (task output or
    //     an artifact). Enforced by default (TEAM-3690): missing evidence → 409.
    //     Only the explicit opt-out COMPLETION_EVIDENCE_REQUIRED=off|false|0 falls
    //     back to shadow-log-and-continue. No bypass parameter: the same reason
    //     the open-children gate has none.
    try {
      const agentTasks = (workflow.agentTasks as Record<string, AgentTaskLike>) || {};
      let missing = missingEvidenceTickets(tickets, agentTasks, requiredPhases, phaseById);
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
              return await readCompletionRecordFromS3(ticketId);
            } catch (err) {
              if (isMissingObject(err)) return null;
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
      const unrun = requiredPhasesMissingDoneAgent(tickets, requiredPhases, phaseById);
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

    // 2c. TEAM-3747 D2 — ship/CD merge-verdict gate ("no green close over
    //     unshipped work"), PARITY with the orchestrator's completeWorkflow. If the
    //     def has a ship phase, a done ship ticket must carry a merge/deploy verdict
    //     OR an explicit SHIP_BLOCKED_OUTCOMES outcome — "done + output" is NOT
    //     proof it shipped. When a ship phase isn't shipped this route must NOT fake
    //     "complete": it closes on the honest terminal phase and emits a terminal
    //     event (see closeBlocked). Same COMPLETION_EVIDENCE_REQUIRED gate — enforce
    //     by default; the explicit opt-out only shadow-logs and completes.
    //     TEAM-6192 — then, after the gate, the orchestrator's re-check: its own
    //     dropCarriedOffenders over the SAME inputs completeWorkflow uses (the gate's
    //     overlaid tasks + GitHub proof when the gate ran, else the stored row; every
    //     child's completions/<id>.json through one memoized reader).
    //     TEAM-6231 — via completion.mjs recheckShipVerdict: fresh records are overlaid
    //     even without the gate (F2), a FAILED read is remembered and never excused (F3).
    try {
      let view = (workflow.agentTasks as Record<string, ShipTaskLike>) || {};
      let mergeProof: MergeProbe | null = null;
      let verdict = evaluateShipVerdict(tickets, view, requiredPhases, phaseById);
      const readRecord = memoizedReader(async (ticketId) => {
        if (!ARTIFACT_BUCKET) return null;
        try {
          return await readCompletionRecordFromS3(ticketId);
        } catch (err) {
          if (isMissingObject(err)) return null;
          throw err; // the gate falls back to the cached prUrl; the re-check lists it as failed
        }
      });
      // 2c-0. TEAM-6136 — the TEAM-6032 (DL-038) follow-up PR gate, BEFORE the
      //       blocked close so both terminal writes are gated (the orchestrator's
      //       order). Same function as the orchestrator, same guard: no
      //       SHIP_MERGE_VERIFY opt-out, a ship phase (EFFECTIVE def), featureBranch,
      //       repoConfig, GITHUB_PAT, not a pure handoff. Fail-open: never throws.
      //       TEAM-6187 — and the orchestrator's INPUTS: the fresh-record overlay and
      //       the GitHub landing probe run first inside openFollowUpPrsAtCompletion
      //       (a PROVEN-unmerged branch refuses here, as completeWorkflow's
      //       CompletionRejectedUnmergedBranch does), the live roster classifies the
      //       ship agent, and only the epic's CHILDREN state `base_branch:` bases.
      if (
        followUpPrGateConfigured(workflow, requiredPhases.some((p: string) => SHIP_PHASES.has(p))) &&
        !verdict.handoff
      ) {
        const phases = await livePhases();
        const outcome = await openFollowUpPrsAtCompletion({
          workflow,
          tickets: tickets.filter((t) => t.type !== "epic"), // parity: children = getChildTickets(epicId)
          readCompletionRecord: readRecord,
          getAgentPhase: (agentId) => phases[agentId],
          token: process.env.GITHUB_PAT,
        });
        if ("unmerged" in outcome) {
          console.error(
            `[complete] CompletionRejectedUnmergedBranch ${workflowId}: feature branch ${workflow.featureBranch} ` +
              `is not merged into the base (${outcome.unmerged.reason}). CD did not land the merge — refusing.`
          );
          return NextResponse.json(
            {
              error: "unmerged_branch",
              featureBranch: workflow.featureBranch,
              reason: outcome.unmerged.reason,
              hint:
                "CD did not land the merge. Open (or merge) the PR from the feature branch to the default " +
                "branch, or have the release manager open a fresh unified PR through Merge Approval, then retry — " +
                "completion has no bypass.",
            },
            { status: 409 }
          );
        }
        if (outcome.prs.length > 0) {
          console.error(`[complete] CompletionRejectedOpenFollowUpPr ${workflowId}: ${outcome.prs.join(", ")} still open`);
          return NextResponse.json(
            {
              error: "open_follow_up_pr",
              prs: outcome.prs,
              hint: "Merge or close these follow-up PRs first — completion has no bypass.",
            },
            { status: 409 }
          );
        }
        view = (outcome.agentTasks as Record<string, ShipTaskLike> | undefined) ?? view;
        mergeProof = outcome.mergeProof ?? null;
      }
      if (verdict.required && !verdict.shipped) {
        const children = tickets.filter((t) => t.type !== "epic");
        const { records, failed } = await readCompletionRecords(
          children.map((t) => String(t.ticketId)),
          readRecord
        );
        verdict = recheckShipVerdict({
          evaluate: (tasks) => evaluateShipVerdict(tickets, tasks as Record<string, ShipTaskLike>, requiredPhases, phaseById),
          children,
          agentTasks: view,
          records,
          failed,
          mergeProof,
          shipPhases: requiredPhases.filter((p) => SHIP_PHASES.has(p)),
          getAgentPhase: (agentId) => phaseById[agentId],
        });
      }
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
    const completeGuard = terminalPhaseGuard();
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
          // TEAM-3755 F2: the phase half of the guard now covers ALL FIVE
          // terminal phases (it omitted the D2 blocked outcomes), derived from
          // TERMINAL_PHASES so it cannot drift from closeBlocked's guard.
          ConditionExpression: `${completeGuard.condition} AND attribute_not_exists(cancelledAt)`,
          ExpressionAttributeNames: { "#phase": "phase" },
          ExpressionAttributeValues: {
            ":complete": "complete",
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
