/**
 * TEAM-4453 D1 — hub-side intake MATERIALIZATION.
 *
 * For most workflow defs the hub creates ONE ticket at start (the intake ticket)
 * and the intake agent plans the rest of the run from inside its first turn. That
 * costs a whole model turn whose only output is a handful of
 * `Tickets___create_ticket` calls, and it is non-deterministic: the agent can
 * title a ticket wrongly (TEAM-4450), create a gate twice, or skip one.
 *
 * Everything in that skeleton is already declared in config: the def's phases,
 * its review gates, the CD registry's merge/deploy allow-list, and the agent
 * roster. So a def may opt in with `intakeMaterialization: "hub"` and the HUB
 * plans the whole skeleton up-front — deterministically, testably, with no model
 * in the loop. The agent's first ticket is then its real work ticket.
 *
 * This module is PURE: no I/O, no AWS, no clock. The start route resolves the
 * roster + CD registry and executes the plan; everything decidable from config
 * is decided here so it can be unit-tested exhaustively.
 *
 * Two invariants the rest of the system depends on:
 *   1. WRITE ORDER — `items[i].blockedByKeys ⊆ keys(items[0..i-1])`. The executor
 *      creates items in array order and resolves `blocked_by` through a key→id
 *      map, so a forward reference would create a ticket blocked by an id that
 *      does not exist yet. {@link assertWriteOrder} pins it.
 *   2. GATE ASSIGNEES ARE CONFIG-ONLY — a gate's assignee comes from
 *      `gate.assignee` or the `"human:reviewer"` default, NEVER from the request
 *      body. `POST /api/workflow/start` has no auth under AUTH_MODE=none, so a
 *      caller-supplied reviewer would let anyone nominate themselves as the
 *      approver of their own change.
 */

import type { RosterAgent } from "./roster-loader";
import type { WorkflowInput } from "./types";
import type { ReviewGate, WorkflowDef, WorkflowDefPhase } from "./workflow-defs";
import { resolveReviewGateCap } from "./workflow-defs";

/**
 * Agent phases that only run when the run's repo is CD-registered. Mirror of
 * `SHIP_PHASES` in lambda/orchestrator/completion.mjs — keep in sync.
 */
export const SHIP_PHASES: ReadonlySet<string> = new Set(["ship"]);

/** Fallback gate assignee when the def names no reviewer: anyone watching the board. */
export const DEFAULT_GATE_ASSIGNEE = "human:reviewer";

/** The marker a hub-materialized agent ticket carries in its description. */
export const HUB_MATERIALIZED_MARKER = "Created by the hub at intake";

/** One ticket the hub will create, in creation order. */
export interface TicketPlanItem {
  /**
   * Stable plan-local identity — `phase:<agentPhase>` or `gate:<slug>@<afterPhase>`.
   * Used for `blockedByKeys` wiring, for the executor's key→ticketId map, and in
   * error messages. Never written to a ticket.
   */
  key: string;
  kind: "phase" | "gate";
  /** Ticket summary/title. Its prefix (text before the first ":") is the dispatch signal. */
  summary: string;
  /** `human:<who>` for a gate, an agentId for a phase ticket. */
  assignee: string;
  /** The agent phase this ticket belongs to — stamped on the ticket so the orchestrator can read it. */
  phase: string;
  /** Gate items only: the gate's display name (also the title prefix). */
  gateName?: string;
  description: string;
  /** Keys of EARLIER items in this plan that must finish first. */
  blockedByKeys: string[];
  /** Blocker ticket ids that already exist outside the plan (e.g. an Intent Acceptance gate). */
  externalBlockedBy: string[];
  /** True when nothing blocks this ticket, so the executor may release it immediately. */
  readyOnCreate: boolean;
  labels: string[];
}

/** A phase the hub deliberately did NOT materialize, and why. */
export interface DeferredPhase {
  phase: string;
  reason: "upstream-deferred" | "multiple-assignees" | "no-planned-upstream";
  detail: string;
  /** `multiple-assignees` only: the ambiguous roster candidates, sorted. */
  candidates?: string[];
}

export interface TicketPlan {
  defId: string;
  workflowId: string;
  epicId: string;
  /** Which side planned the skeleton — `def.intakeMaterialization`, resolved. */
  mode: "hub" | "agent";
  /**
   * Whether the run's repo is CD-registered. Only meaningful for `mode: "hub"`:
   * an agent-mode plan never consults the registry (its single item is the same
   * either way), so the route does not resolve it and this stays false.
   */
  cdRegistered: boolean;
  items: TicketPlanItem[];
  /** Phases left to the agent to create. Non-empty means the skeleton is partial BY DESIGN. */
  deferred: DeferredPhase[];
  /** Non-fatal notes for the start log (e.g. an assignee resolved by fallback). */
  warnings: string[];
}

export interface PlanContext {
  workflowId: string;
  epicId: string;
  /** The LIVE roster (S3 config/agents.json). `[]` is valid — every phase then falls back. */
  roster: RosterAgent[];
  /**
   * Whether the run's first repo is in the CD registry. Only consulted for
   * hub-mode defs; agent-mode plans never read it (the single intake ticket is
   * the same either way), so the route resolves it lazily.
   */
  cdRegistered: boolean;
  /** The hub-created Intent Acceptance gate ticket id, when the def has one (playbook defs). */
  intentGateTicketId?: string;
}

/** Def ids an agent is bound to, applying the repo-wide fallback used everywhere else. */
function defIdsFor(agent: RosterAgent): string[] {
  return agent.workflowDefIds?.length ? agent.workflowDefIds : [agent.workflowDefId || "software-delivery"];
}

/** The dispatch prefix of a title: everything before the first ":". */
function titlePrefixOf(title: string | undefined): string {
  const s = String(title ?? "");
  const i = s.indexOf(":");
  return i < 0 ? s.trim() : s.slice(0, i).trim();
}

/** `"Merge Approval"` → `"merge-approval"`. Stable, lower-case, label-safe. */
export function gateSlug(name: string | undefined): string {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "review";
}

/**
 * TEAM-4450: the hub-created intake ticket's title prefix must come from the
 * def's INTAKE (`type:"app"`) phase, not the first `type:"agent"` phase. For
 * most defs this only changes a cosmetic label ("Requirements:" / "Triage:" →
 * "Intake:"; no consumer keys on it), but for `operator` the first agent phase
 * is named "Build" — titling the intake ticket "Build: agentcore_hub_operator —
 * …" made it indistinguishable from the operator's own BUILD ticket to
 * blueprints/operator.md's title-prefix dispatch, so the intake ticket got
 * routed into BUILD and skipped planning. Both backends call this so they can't
 * drift apart again.
 *
 * TEAM-4453: moved here from the start route and exported so the planner and the
 * route share one definition. Agent-mode item 0 is titled by this function, so
 * every non-hub def keeps its byte-identical TEAM-4450 title.
 */
export function intakeTicketTitle(def: WorkflowDef, title: string): string {
  const intakePhaseName = def.phases.find((p) => p.type === "app")?.name || "Intake";
  return `${intakePhaseName}: ${def.intakeAgentId} — ${title}`;
}

/**
 * The def a run actually follows given its CD status — TS mirror of
 * `stripShipPhases` (lambda/orchestrator/cd-registry.mjs), which is the
 * enforcer. A handoff run's ship completion phases and every review gate
 * guarding a ship phase are removed; everything else is untouched, and the def
 * itself is returned when nothing needs stripping so identity checks hold.
 *
 * NOTE the mirror does not filter `phases` — the orchestrator blocks ship-phase
 * WORK with its CD handoff guard instead. The planner therefore skips ship
 * phases itself (see {@link planIntakeTickets}); this function exists so the
 * gate/completion view of a handoff run matches the orchestrator's exactly.
 */
export function effectiveDefFor(def: WorkflowDef, opts: { cdRegistered: boolean }): WorkflowDef {
  if (!def || opts.cdRegistered) return def;
  const required = Array.isArray(def.completionRequiresAgentPhases) ? def.completionRequiresAgentPhases : [];
  const gates = Array.isArray(def.reviewGates) ? def.reviewGates : [];
  const hasShipPhase = required.some((p) => SHIP_PHASES.has(p));
  const hasShipGate = gates.some((g) => SHIP_PHASES.has(g?.afterPhase));
  if (!hasShipPhase && !hasShipGate) return def;
  return {
    ...def,
    completionRequiresAgentPhases: required.filter((p) => !SHIP_PHASES.has(p)),
    reviewGates: gates.filter((g) => !SHIP_PHASES.has(g?.afterPhase)),
    cdHandoff: true,
  } as WorkflowDef;
}

/** How a phase ticket's assignee was decided — surfaced so the start log can explain itself. */
export type AssigneeResolution =
  | { assignee: string; how: "phase-agentId" | "roster-unique" }
  | { assignee: string; how: "intake-fallback"; warning: string }
  | { assignee: null; how: "multiple"; candidates: string[] };

/**
 * Who owns a phase's ticket.
 *
 * 1. `phase.agentId` — the def said so explicitly. Always wins.
 * 2. Exactly one roster agent on this phase bound to this def — unambiguous.
 * 3. No roster match — fall back to the def's intake agent (single-agent defs
 *    like `operator` run every phase themselves) and warn.
 * 4. MORE than one candidate — refuse to guess. The phase is deferred to the
 *    agent, which can read the tickets and decide; a wrong pick would dispatch
 *    the whole phase to the wrong persona.
 */
export function resolvePhaseAssignee(
  phase: WorkflowDefPhase,
  def: WorkflowDef,
  roster: RosterAgent[]
): AssigneeResolution {
  if (phase.agentId) return { assignee: phase.agentId, how: "phase-agentId" };

  const matches = (roster || [])
    .filter((a) => a?.phase === phase.agentPhase && defIdsFor(a).includes(def.id))
    .map((a) => a.agentId)
    .filter(Boolean);
  const candidates = [...new Set(matches)].sort();

  if (candidates.length === 1) return { assignee: candidates[0], how: "roster-unique" };
  if (candidates.length === 0) {
    return {
      assignee: def.intakeAgentId,
      how: "intake-fallback",
      warning:
        `phase "${phase.agentPhase}" has no roster agent bound to def "${def.id}" — ` +
        `assigned to the intake agent ${def.intakeAgentId}`,
    };
  }
  return { assignee: null, how: "multiple", candidates };
}

/**
 * The review gates that actually apply to a run. `afterPhase: "intake"` gates
 * are excluded: that is the Intent Acceptance gate, which the route creates
 * itself before item 0 (see intent.ts / intentGateFor) and hands to the planner
 * as `ctx.intentGateTicketId`.
 */
export function activeGates(def: WorkflowDef, requestedGates: string[] = []): ReviewGate[] {
  const requested = Array.isArray(requestedGates) ? requestedGates : [];
  return (def.reviewGates || []).filter(
    (g) =>
      g?.afterPhase !== "intake" &&
      (g?.condition === "always" || (g?.condition === "flagged" && requested.includes(g.afterPhase)))
  );
}

/** Blocking gates first: an advisory gate must not steal the blocking gate's place in the chain. */
function gatesFor(def: WorkflowDef, afterPhase: string, requestedGates: string[]): ReviewGate[] {
  return activeGates(def, requestedGates)
    .filter((g) => g.afterPhase === afterPhase)
    .sort((a, b) => Number(Boolean(b.blocking)) - Number(Boolean(a.blocking)));
}

function hubItem0Description(def: WorkflowDef, phase: WorkflowDefPhase, input: WorkflowInput): string {
  return [
    `Title: ${input.title}`,
    `Description: ${input.description || "(none)"}`,
    "",
    `${HUB_MATERIALIZED_MARKER}: this ticket is the ${phase.name} ticket; the run's gate/phase ` +
      `skeleton is hub-created — do not create gate or ship tickets.`,
    "",
    `Workflow def: ${def.id}. Do your ${phase.name} work on this ticket and report completion on it.`,
  ].join("\n");
}

function agentItem0Description(input: WorkflowInput, ctx: PlanContext): string {
  return ctx.intentGateTicketId
    ? `Turn the accepted intent (workflows/${ctx.workflowId}/shared/intent.md) into the spec and the ticket plan. Blocked until the product owner approves the Intent Acceptance gate ${ctx.intentGateTicketId}.\n\nTitle: ${input.title}`
    : `Analyze the request and create tickets for the relevant agents.\n\nTitle: ${input.title}\nDescription: ${input.description}`;
}

function gateDescription(
  gate: ReviewGate,
  def: WorkflowDef,
  upstreamKeys: string[],
  ctx: PlanContext
): string {
  const cap = resolveReviewGateCap(gate);
  const meta = {
    gate: gateSlug(gate.name),
    afterPhase: gate.afterPhase,
    blocking: Boolean(gate.blocking),
    onReject: gate.onReject,
    maxRounds: cap.maxRounds,
    regressionCountsDouble: cap.regressionCountsDouble,
    onCapReached: cap.onCapReached,
    workflowId: ctx.workflowId,
    materializedBy: "hub",
  };
  return [
    `${gate.name || "Review"} — human review gate.`,
    "",
    `Guards phase: ${gate.afterPhase} (upstream: ${upstreamKeys.join(", ") || "none"})`,
    `Blocking: ${gate.blocking ? "yes — downstream phases wait for this approval" : "no — advisory, work continues"}`,
    `On reject: ${gate.onReject === "rework" ? "rework — the upstream work re-opens" : "hold — the run pauses"}`,
    `Reviewer role: ${gate.reviewerRole || "(unspecified)"}`,
    `Assignee: ${gate.assignee || DEFAULT_GATE_ASSIGNEE}`,
    `Review cap: ${cap.maxRounds} round(s); a regression counts double: ${cap.regressionCountsDouble}; at the cap: ${cap.onCapReached}`,
    `Delivery: ${ctx.cdRegistered ? "CD_REGISTERED — the hub merges and deploys this repo" : "HANDOFF — the hub opens the PR and the owning team merges"}`,
    ...(ctx.cdRegistered
      ? []
      : ["This run is a handoff, so the ship phase is not part of it — approving here does not trigger a deploy."]),
    "",
    "Approve: transition this ticket to Done. Request changes: transition it to Blocked and leave a comment saying what must change.",
    "",
    `${HUB_MATERIALIZED_MARKER} for workflow def ${def.id}.`,
    `gate-meta: ${JSON.stringify(meta)}`,
  ].join("\n");
}

function phaseDescription(
  phase: WorkflowDefPhase,
  assignee: string,
  def: WorkflowDef,
  blockedByKeys: string[],
  input: WorkflowInput,
  ctx: PlanContext
): string {
  const lines = [
    `${phase.name} — phase "${phase.agentPhase}" of workflow def ${def.id}.`,
    "",
    `Title: ${input.title}`,
    `Description: ${input.description || "(none)"}`,
    "",
    `Assignee: ${assignee}`,
    `Waits on: ${blockedByKeys.join(", ") || "nothing"}`,
    `Delivery: ${ctx.cdRegistered ? "CD_REGISTERED — the hub merges and deploys this repo" : "HANDOFF — the hub opens the PR and the owning team merges"}`,
    "",
    `${HUB_MATERIALIZED_MARKER}: the run's skeleton is hub-created — do not create gate or phase tickets.`,
  ];
  if (SHIP_PHASES.has(phase.agentPhase)) {
    lines.push(
      "",
      "Merge the approved PR at the approved SHA and deploy per ## Delivery Mode; report outcome=shipped + merge_commit."
    );
  }
  return lines.join("\n");
}

/**
 * Plan every ticket the hub will create for a run.
 *
 * Agent-mode defs (the default) get EXACTLY one item — the intake ticket, titled
 * and described exactly as before TEAM-4453 — so their behaviour is unchanged.
 * Hub-mode defs additionally get their gates and downstream phase tickets.
 */
export function planIntakeTickets(def: WorkflowDef, input: WorkflowInput, ctx: PlanContext): TicketPlan {
  const eff = effectiveDefFor(def, { cdRegistered: ctx.cdRegistered });
  const hub = eff.intakeMaterialization === "hub";
  const requested = Array.isArray(input.reviewGates) ? input.reviewGates : [];
  const items: TicketPlanItem[] = [];
  const deferred: DeferredPhase[] = [];
  const warnings: string[] = [];

  const agentPhases = eff.phases.filter((p) => p.type === "agent");
  const first = agentPhases[0];
  const firstPhase = first?.agentPhase || "requirements";

  // ─── Item 0: the ticket that starts the run ────────────────────────────────
  items.push({
    key: `phase:${firstPhase}`,
    kind: "phase",
    summary: hub && first ? `${first.name}: ${eff.intakeAgentId} — ${input.title}` : intakeTicketTitle(eff, input.title),
    assignee: eff.intakeAgentId,
    phase: firstPhase,
    description: hub && first ? hubItem0Description(eff, first, input) : agentItem0Description(input, ctx),
    blockedByKeys: [],
    externalBlockedBy: ctx.intentGateTicketId ? [ctx.intentGateTicketId] : [],
    readyOnCreate: !ctx.intentGateTicketId,
    labels: [`wfdef:${eff.id}`, `phase:${firstPhase}`],
  });

  // Agent-mode defs stop here: the agent plans the rest from its first turn.
  if (!hub || !first) {
    return finish(eff, ctx, hub, items, deferred, warnings);
  }

  const emitGate = (gate: ReviewGate, upstreamKeys: string[]): string => {
    const slug = gateSlug(gate.name);
    const key = `gate:${slug}@${gate.afterPhase}`;
    items.push({
      key,
      kind: "gate",
      summary: `${gate.name || "Review"}: ${input.title}`,
      // NEVER from the request body — see the module docblock.
      assignee: gate.assignee || DEFAULT_GATE_ASSIGNEE,
      phase: gate.afterPhase,
      gateName: gate.name || "Review",
      description: gateDescription(gate, eff, upstreamKeys, ctx),
      blockedByKeys: [...upstreamKeys],
      externalBlockedBy: [],
      readyOnCreate: false,
      labels: [`wfdef:${eff.id}`, `phase:${gate.afterPhase}`, `gate:${slug}`],
    });
    return key;
  };

  // Keys the NEXT phase waits on: the previous phase, or its blocking gate.
  let prevKeys: string[] = [items[0].key];
  for (const gate of gatesFor(eff, firstPhase, requested)) {
    const key = emitGate(gate, [items[0].key]);
    if (gate.blocking) prevKeys = [key];
  }

  let chainBroken = false;
  for (const phase of agentPhases.slice(1)) {
    // A handoff run does no ship work (the orchestrator's CD handoff guard would
    // block it anyway), so it gets no ship ticket.
    if (!ctx.cdRegistered && SHIP_PHASES.has(phase.agentPhase)) continue;

    if (chainBroken) {
      deferred.push({
        phase: phase.agentPhase,
        reason: "upstream-deferred",
        detail: `an earlier phase was deferred, so "${phase.agentPhase}" has no hub-planned blocker to wait on`,
      });
      continue;
    }

    const resolved = resolvePhaseAssignee(phase, eff, ctx.roster);
    if (resolved.assignee === null) {
      deferred.push({
        phase: phase.agentPhase,
        reason: "multiple-assignees",
        detail: `phase "${phase.agentPhase}" has ${resolved.candidates.length} candidate agents — refusing to guess`,
        candidates: resolved.candidates,
      });
      chainBroken = true;
      continue;
    }
    if (resolved.how === "intake-fallback") warnings.push(resolved.warning);

    const key = `phase:${phase.agentPhase}`;
    items.push({
      key,
      kind: "phase",
      summary: `${phase.name}: ${resolved.assignee} — ${input.title}`,
      assignee: resolved.assignee,
      phase: phase.agentPhase,
      description: phaseDescription(phase, resolved.assignee, eff, prevKeys, input, ctx),
      blockedByKeys: [...prevKeys],
      externalBlockedBy: [],
      readyOnCreate: false,
      labels: [`wfdef:${eff.id}`, `phase:${phase.agentPhase}`],
    });
    prevKeys = [key];

    for (const gate of gatesFor(eff, phase.agentPhase, requested)) {
      const gateKey = emitGate(gate, [key]);
      if (gate.blocking) prevKeys = [gateKey];
    }
  }

  // An active gate can name a phase this plan never materializes — a deferred
  // phase, or config drift (software-delivery declares a ship GATE but no ship
  // phase). Say so instead of dropping it silently: a gate with no upstream
  // ticket has nothing to block on, so the agent owns it.
  const emitted = new Set(items.filter((i) => i.kind === "gate").map((i) => i.key));
  for (const gate of activeGates(eff, requested)) {
    if (emitted.has(`gate:${gateSlug(gate.name)}@${gate.afterPhase}`)) continue;
    deferred.push({
      phase: gate.afterPhase,
      reason: "no-planned-upstream",
      detail: `gate "${gate.name || "Review"}" guards phase "${gate.afterPhase}", which this plan does not materialize`,
    });
  }

  return finish(eff, ctx, hub, items, deferred, warnings);
}

function finish(
  eff: WorkflowDef,
  ctx: PlanContext,
  hub: boolean,
  items: TicketPlanItem[],
  deferred: DeferredPhase[],
  warnings: string[]
): TicketPlan {
  assertWriteOrder(items);
  return {
    defId: eff.id,
    workflowId: ctx.workflowId,
    epicId: ctx.epicId,
    mode: hub ? "hub" : "agent",
    cdRegistered: ctx.cdRegistered,
    items,
    deferred,
    warnings,
  };
}

/**
 * The write-order invariant: every blocker an item names must already have been
 * created. Throws (a planner bug, not a user error) — the start route runs the
 * plan inside its try/catch, so a violation marks the run phase=error rather
 * than creating a half-wired skeleton.
 */
export function assertWriteOrder(items: TicketPlanItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    for (const dep of item.blockedByKeys) {
      if (!seen.has(dep)) {
        throw new Error(
          `intake plan write-order violation: "${item.key}" is blocked by "${dep}", which is not created before it`
        );
      }
    }
    seen.add(item.key);
  }
}

/** The subset of an existing ticket {@link isMaterialized} needs. Both backends expose these. */
export interface ExistingTicketView {
  id?: string;
  title?: string;
  assignee?: string;
  status?: string;
  type?: string;
  workflowId?: string;
  phase?: string;
  labels?: string[];
}

/**
 * Does `existing` already satisfy `item`? Used by the blueprint's verify-then-create
 * fallback and by tests; the hub itself does not re-check (it creates once).
 *
 * SR-1.2: the DynamoDB `list_tickets` projection does not expose `phase`, so a
 * phase ticket is ALSO accepted on its title prefix. That is safe because the
 * prefix is the def's phase name, which is exactly what the planner wrote.
 */
export function isMaterialized(
  existing: ExistingTicketView,
  item: TicketPlanItem,
  workflowId: string,
  roster: RosterAgent[] = []
): boolean {
  if (!existing) return false;
  // A ticket stamped with a DIFFERENT run never counts. An unstamped ticket is
  // accepted: agent-created tickets predate the stamp, and the caller already
  // scoped the list to this run's epic.
  if (existing.workflowId && existing.workflowId !== workflowId) return false;
  if (existing.type === "epic") return false;
  if (existing.status === "cancelled") return false;

  const assignee = existing.assignee || "";
  const isHuman = assignee.startsWith("human:");
  const prefix = titlePrefixOf(existing.title);

  if (item.kind === "gate") {
    if (!isHuman) return false;
    return prefix === item.gateName || (existing.labels || []).includes(`gate:${gateSlug(item.gateName)}`);
  }

  if (isHuman) return false;
  const rosterPhase = (roster || []).find((a) => a?.agentId === assignee)?.phase;
  if ((existing.phase || rosterPhase) === item.phase) return true;
  return prefix === titlePrefixOf(item.summary);
}
