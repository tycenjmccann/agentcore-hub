/**
 * Orchestration Lambda — Event-Driven Workflow Engine
 *
 * Triggered by DynamoDB Streams on the `agentcore-hub-tickets` table.
 * Reacts to ticket status changes and drives the workflow forward:
 *
 *   ticket → "done"  → unblock dependents, check QA gate, check completion
 *   ticket → "ready" → invoke the assigned agent via AgentCore Harness
 *   ticket → "in_progress" → publish status event (UI notification)
 *
 * The Next.js app is read-only. It just visualizes state.
 * This Lambda is the SOLE orchestrator.
 */

import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import * as store from "./workflow-store.mjs";
import {
  DEFAULT_TTL_MINUTES,
  STALE_CLAIM_MULTIPLIER,
  LEASE_TTL_MS,
  isLeaseLive,
  lastAgentActivity,
  stealClaim,
  lastStreamedText,
  hasAgentErrorSince,
} from "./lease.mjs";
import { resolveWatchdog, setWatchdogSource } from "./watchdog.mjs";
import { createDetector } from "./dead-session-detector.mjs";
import { createCascade } from "./cascade.mjs";
import { createReconcileSweep } from "./reconcile-sweep.mjs";
import { createAwaitedIds, normalizeAwaitedIdsMode } from "./awaited-ids.mjs";
import { createReviewCap, parseDecision } from "./review-cap.mjs";
import { createMergeOnGreen } from "./merge-on-green.mjs";
import { createShipHeadGate, createGitHubShipHeadProbe } from "./ship-head-stability.mjs";
import { shouldGateShipDispatch, normalizeShipDispatchMode, emitShipDispatchMetrics } from "./ship-dispatch-gate.mjs";
import { createReworkLoopCap, normalizeReworkLoopMode } from "./rework-loop-cap.mjs";
import { createLiveReverify, normalizeLiveReverifyMode } from "./live-reverify.mjs";
import { isWorkflowComplete as evaluateWorkflowComplete, missingEvidenceTickets, resolveMissingEvidenceFromRecords, evaluateShipVerdict, SHIP_PHASES, SHIP_BLOCKED_OUTCOMES, TERMINAL_WORKFLOW_PHASES, FIX_KINDS, REWORK_FIX_KINDS, normalizeAdvisoryRoutingMode, isAdvisoryTicket, nonAdvisory } from "./completion.mjs";
import { isPipelineEnabled } from "./pipeline-enabled.mjs";
import { CD_REGISTRY_KEY, EMPTY_CD_REGISTRY, parseCdRegistry, isCdRegistered, effectiveWorkflowDef, resolveDelivery, deliveryModeContext } from "./cd-registry.mjs";
import { validateEffectiveDef, validateDefForCreation } from "./workflow-def-validate.mjs";
import { buildReviewResolved } from "./review-resolved.mjs";
import { ensureRepoCheck, formatRepoCheckWarning } from "./repo-check.mjs";
import { ensureCiCheck, formatCiCheckBlock, prefixCiWarning, normalizeCiCheckMode } from "./ci-check.mjs";
import { syncBeforeCi, normalizeSyncMode } from "./sync-main.mjs";
import { eventIdFor, normalizeEventDedupeMode } from "./event-id.mjs";
import { GATE_STATES, classifyRejection, normalizeGateGuardMode } from "./gate-state.mjs";
import { createDeadSessionEscalation, normalizeEscalationMode } from "./dead-session-escalation.mjs";
import { applyBlockerEdge, normalizePreserveStatuses } from "./ticket-blockers.mjs";
// TEAM-4121 FR-8: the fix-ticket contract lives in a zero-import module that is
// byte-identical across the orchestrator + both ticket Lambdas (CI cmp's them).
// The orchestrator only READS contracts — it maps a Jira issue's labels and
// description block back into the same `spawnedBy` / `fixContract` shape the
// DynamoDB provider stores natively.
// (No `escapeJql` here: the orchestrator's ONE JQL site interpolates an issue
// key into an unquoted `parent = …` operand, which escaping cannot make safe —
// it is shape-checked and refused instead. See getChildTicketsFromJira.)
import {
  KIND_TO_ORIGIN_KEY,
  parseFixContractBlock,
  TICKET_KEY_RE,
  reportedAtFromLabels,
  maxReportedAt,
} from "./fix-contract.mjs";
import {
  normalizeChainGateMode, chainFor, chainDir, requiredArtifactsForTicket, sdlcFrameworkContext,
  gateInstructionOverride, fallbackReviewPackagePhase, artifactRepoPath, missingArtifactNote,
  applyFramework, frameworkOfWorkflow,
} from "./artifact-chain.mjs";

// Playbook artifact-chain gate (framework overlay): a ticket that owes a chain
// artifact (spec.md / design/<agent>.md / plan.md / findings.md) may not cascade
// until the file is on the shared branch. Only runs whose effective def carries
// `artifactChain` are affected; ARTIFACT_CHAIN_GATE=off disables the check.
const ARTIFACT_CHAIN_GATE = normalizeChainGateMode(process.env.ARTIFACT_CHAIN_GATE);

// ─── Config ────────────────────────────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const GITHUB_LAMBDA = process.env.GITHUB_LAMBDA || "agentcore-hub-github-mcp";
const EVENT_BUS = process.env.EVENT_BUS || "default";
const MAX_QA_RETRIES = 3;
// TEAM-3765 F4 — bound the advisory auto-approval transition retry. The
// auto-approve is the ONLY thing that moves an all-advisory review gate out of
// `blocked`; a swallowed transition failure stalls the gate forever. Bounded so
// a persistently-failing transition can't spin. Backoff is env-tunable (pinned
// to 0 in tests) — a false/throw from the transition is a transient candidate.
const ADVISORY_APPROVE_MAX_ATTEMPTS = Number(process.env.ADVISORY_APPROVE_MAX_ATTEMPTS) || 3;
const ADVISORY_APPROVE_BACKOFF_MS = Number(process.env.ADVISORY_APPROVE_BACKOFF_MS ?? 250);
// TEAM-3966 F4: stable marker stamped into the advisory park comment so a
// redelivered rejection (SQS retry, stream re-poll, webhook replay) can detect
// the gate is ALREADY parked and skip the duplicate comment + event.
const PARK_ADVISORY_MARKER = "[orchestrator:parked-advisory]";
// TEAM-3970: the park comment also embeds `[fp:<12 hex>]` — a fingerprint of the
// human's rejection note (gateTicket.reviewComment) at park time — so a later
// invocation can tell a TRUE redelivery (same note) from a NEW rejection cycle
// (different note) even when the provider never surfaces the note as a comment
// (the DDB tickets Lambda writes it to reviewComment only). See the park branch.
const PARK_FP_RE = /\[fp:([0-9a-f]{12})\]/;
function parkNoteFingerprint(note) {
  return createHash("sha256").update(String(note), "utf8").digest("hex").slice(0, 12);
}
// Dead-session detector rollout flag (TEAM-3618 D1.2): off = skip the sweep,
// shadow = observe + metrics + shadow-flagged events but ZERO writes, enforce =
// steal/retry/escalate. Unset/empty DEFAULTS TO SHADOW (TEAM-3763 F1): per the
// FR-D4.1 rollout, shadow → enforce is an explicit operator action, not a
// deploy-time flip. A fresh deploy that omits the var must stay observe-only —
// deploy.sh:94-99 forwards the var only when explicitly set, so an unset install
// (production today) must NOT silently begin stealing/retrying sessions. The
// fail-safe coercion still holds: runSweep normalizes (trim+lowercase) and
// coerces anything not exactly off|shadow|enforce back to shadow, so a typo in
// the env var can only ever DOWNGRADE to observe-only, never grant a rogue mode.
const DEAD_SESSION_DETECTOR_MODE = process.env.DEAD_SESSION_DETECTOR_MODE || "shadow";
// Cascade extended-states rollout flag (TEAM-3618 D3 commit 4b; tri-state as of
// TEAM-3747 D1). off = the cascade only re-Readies {blocked, todo} dependents
// (commit-4a behavior — the PRE-EPIC production path); shadow = evaluate the
// extended-state path and emit would-nudge/would-steal/would-reawaken metrics
// but perform ZERO writes; enforce = an in_progress dependent whose last blocker
// resolves is lease-guarded (live → nudge only; stale → steal + re-dispatch
// through the claim CAS) and an in_review gate is re-woken for real.
// Unset/empty DEFAULTS TO OFF (TEAM-3763 F6): "off" is the ONLY value that is
// byte-identical to pre-epic — shadow is not, because cascade.mjs's extended
// path issues extra DDB reads (the F9 strongly-consistent blocker confirm +
// lease-liveness lastAgentActivity read) before its no-write mode check. So an
// unset install (production today) must perform ZERO extra reads. Explicit "off"
// short-circuits in cascade.mjs before any of those reads (cascade.mjs:173).
// Backwards compatible: the legacy boolean "true"/"1"/"on" maps to enforce.
const CASCADE_EXTENDED_STATES_MODE = resolveCascadeMode(process.env.CASCADE_EXTENDED_STATES);
// Missed-unblock reconciliation sweep (TEAM-3747 D1). Tri-state, governed
// independently of the cascade's own mode (a separate safety-net rollout).
// Unset/empty DEFAULTS TO OFF (TEAM-3763 F2): the sweep is now scheduled
// (deploy.sh wires a reconcile_sweep EventBridge target), so a dark default is
// what keeps a fresh deploy byte-identical to pre-epic. runSweep("off")
// short-circuits before its first ScanCommand (reconcile-sweep.mjs:165) — ZERO
// DDB reads/writes. shadow/enforce only when the operator explicitly sets the
// var (deploy.sh forwards it only when set).
const RECONCILE_SWEEP_MODE = process.env.RECONCILE_SWEEP_MODE || "off";
// Awaited-ids re-wake (TEAM-4166 D1): off | shadow | enforce, default off. When
// a tool reports report_precondition_unmet, the orchestrator writes the awaited
// sibling ids as real blockedBy edges (preserving an in-flight status) so the
// parked ticket re-wakes through the SAME unblock cascade once every awaited fix
// closes — no bespoke wait path. off = byte-identical (no edge writes, no derived
// hook, no level-triggered pickup); the module mutates ticket state, so it stays
// dark until an operator opts in. Garbage fails safe to off (normalizeAwaitedIdsMode).
const AWAITED_IDS_MODE = normalizeAwaitedIdsMode(process.env.AWAITED_IDS_MODE);
// The wait-SLA (D1 §5): once a ticket has awaited its open fixes longer than this,
// the sweep/detector emit ONE advisory orchestrator.await_timeout (an event, never
// a humanNotification). Default 120 minutes. The event lists only ids still proven
// non-terminal, and carries reason=await_timeout (a real SLA breach) or
// reason=clean_exit_cap (re-woken to the D2 cap with nothing left awaited, so
// awaitingIds is empty) — TEAM-4184 F2.
const AWAITED_IDS_TIMEOUT_MINUTES = Number.parseInt(process.env.AWAITED_IDS_TIMEOUT_MINUTES || "", 10) > 0
  ? Number.parseInt(process.env.AWAITED_IDS_TIMEOUT_MINUTES, 10)
  : 120;
// D2 §2.3 clean-exit re-wake cap: how many times a cleanly-parked/completed ticket
// may be automatically re-woken before the wait-SLA takes over (NEVER escalated as
// a dead session). Positive integer; default 3.
const CLEAN_EXIT_REDISPATCH_CAP = Number.parseInt(process.env.CLEAN_EXIT_REDISPATCH_CAP || "", 10) > 0
  ? Number.parseInt(process.env.CLEAN_EXIT_REDISPATCH_CAP, 10)
  : 3;
// Level-triggered dispatch (TEAM-4060): off | shadow | enforce, default off.
// When enforce, the done-cascade invokes a newly-unblocked dependent in-process
// instead of waiting for its Ready webhook — closes the dispatch dead-zone.
const LEVEL_TRIGGER_DISPATCH = process.env.LEVEL_TRIGGER_DISPATCH || "off";
// Merge-on-green (TEAM-4110): off | shadow | enforce, default off. When enforce,
// completeWorkflow merges a human-approved (Merge-Approval gate done), clean+green
// final PR itself instead of leaving the run open on workflow.cd_unmerged (which
// has no consumer today). off is byte-identical to pre-4110. Normalized in
// merge-on-green.mjs (reuses normalizeExtendedMode: garbage → shadow, never merge).
const MERGE_ON_GREEN = process.env.MERGE_ON_GREEN || "off";
// ship-head-stability.mjs (STRICT allow-list: garbage / legacy "on" → off, never
// wedge ship). off = byte-identical (no GitHub probe, no metrics, always dispatch).
const SHIP_HEAD_STABILITY = process.env.SHIP_HEAD_STABILITY || "off";
// TEAM-4112 ship-dispatch prerequisite gate. Strict allow-list (garbage/legacy
// truthy → off); default off = byte-identical (helper returns dispatch without
// reading anything). Same fail-safe direction as SHIP_HEAD_STABILITY.
const SHIP_DISPATCH_GATE = normalizeShipDispatchMode(process.env.SHIP_DISPATCH_GATE);
// Default OFF (byte-identical) when UNSET; only a PRESENT-but-garbage value
// fails safe to shadow (normalizeReworkLoopMode), never silently off — an
// operator who typed a mode wanted at least observation, an operator who set
// nothing wanted nothing.
const REWORK_LOOP_CAP = process.env.REWORK_LOOP_CAP
  ? normalizeReworkLoopMode(process.env.REWORK_LOOP_CAP)
  : "off";
// Events-table double-write collapse (TEAM-4120 FR-2): off | enforce, default
// off (byte-identical — publishEvent keeps its random eventId). When enforce,
// the eventId is derived from the event's content, so the EventBridge copy
// written by events-writer.mjs lands on the SAME (workflowId, eventId) and
// overwrites the direct copy instead of doubling it. STRICT allow-list (garbage
// and "shadow" → off; see event-id.mjs). Instant rollback = set off. Must agree
// across all three writers, which is why deploy.sh forwards it to all three.
// TEAM-4167 D3 (FR-3.4): default ENFORCE. Leaving the twin write uncollapsed
// silently double-counts every consumer that reads events-table row counts;
// only an explicit EVENT_DEDUPE_MODE=off opts out (instant rollback). Must agree
// with agent-invoker + events-writer (deploy.sh forwards enforce to all three).
const EVENT_DEDUPE_MODE = normalizeEventDedupeMode(process.env.EVENT_DEDUPE_MODE, "enforce");
// Human review-gate state machine (TEAM-4120 FR-1): off | shadow | enforce,
// default off. The reject path today reads a human's intent off ONE ambiguous
// signal — a gate ticket reaching `blocked` — which also fires for a gate's
// creation-time dependency block (TEAM-4044), for a redelivered/twinned
// rejection, and for a gate no human was ever asked about. When on, the
// orchestrator records `requested` when it parks a gate and admits a rejection
// only for a gate actually sitting in `requested`. off = byte-identical (the
// guard returns "admitted" before reading anything — ZERO extra DDB I/O);
// shadow records state + publishes gate.reject_ignored{wouldDrop:true} but
// drops nothing; enforce drops the unrequested/duplicate ones. STRICT allow-list
// (garbage/legacy truthy → off; see gate-state.mjs) because the dangerous
// failure here is DROPPING a human's Request-changes. Instant rollback = off.
const GATE_STATE_GUARD = normalizeGateGuardMode(process.env.GATE_STATE_GUARD);
// Dead-session escalation tree (TEAM-4120 FR-3): off | shadow | enforce, default
// off. Today both exhausted-retry emitters end with an evidence-free
// manager_escalation ("needs a human") and leave the ticket held in `error`, so
// the run stops until somebody reconstructs it by hand. When on, the tree pages
// WITH evidence (last streamed words, spawned children, completion record, PR)
// and picks a resume path: synthesize from a fresh completion record, block the
// ticket on the children it spawned, or park it on one human gate. off = the
// module is never constructed and `escalate` stays undefined, so both emitters
// are byte-identical. UNSET → off, but a PRESENT-but-garbage value → shadow
// (normalizeEscalationMode, same fail-safe direction as REWORK_LOOP_CAP):
// somebody meant to enable it, and shadow only observes. Instant rollback = off.
const DEAD_SESSION_ESCALATION_MODE = normalizeEscalationMode(process.env.DEAD_SESSION_ESCALATION_MODE);
// Live-evidence re-verification (TEAM-4121 FR-9): off | shadow | enforce, default
// off. A fix ticket that declared evidence_source=live is closed today on the
// dev's word alone — nobody re-runs the live check at the new head, so the run
// ships on a claim. When on, a live fix reaching Done files ONE
// `Re-verify (QA): … @ <sha7>` ticket (blocking the run's open ship tickets) and
// a live fix whose completion record carries no live artifact is marked
// `verification: unverified`, which the release manager sees as
// `## Unverified Fixes`. off = byte-identical: the module is never constructed,
// the done twins take no extra read, and the context block is absent. STRICT
// allow-list (garbage → off, unlike REWORK_LOOP_CAP/FIX_TICKET_CONTRACT) because
// enforce CREATES REAL TICKETS that dispatch an agent and block ship. shadow
// publishes fix.reverify_planned only — zero ticket/workflow writes. Instant
// rollback = set off.
const LIVE_REVERIFY = normalizeLiveReverifyMode(process.env.LIVE_REVERIFY);
// CI reachability pre-flight (TEAM-4122 FR-5): off | shadow | enforce, default
// off. On a pipeline-mode run the CI agent is told to read the authoritative
// CodeBuild PR-check for the head SHA — but if the project has no PR webhook AND
// the pipeline-tools Lambda cannot StartBuild, no build can EVER exist, so the
// only honest verdict is a permanent BLOCKED that today reaches the human merge
// gate looking green. shadow = probe + state it in `## CI Certification` context
// (observe-only); enforce = additionally label the epic `ci:uncertifiable` and
// prefix the merge-gate package so the approver is told before they click.
// off = byte-identical: no probe, no CodeBuild/IAM SDK import, no context block,
// no label, no gate rewrite. STRICT allow-list (garbage → off, like
// LIVE_REVERIFY) because enforce WRITES to a real ticket. Instant rollback = off.
const CI_CHECK_MODE = normalizeCiCheckMode(process.env.CI_CHECK_MODE);

// Pre-CI default-branch sync (TEAM-4122 FR-6): off | shadow | enforce. The CI
// agent certifies the integration branch's head SHA, but `main` has moved since
// the devs branched — so a green build certifies code that is NOT what would
// land, and every conflict surfaces after the human merge approval instead of
// before it. shadow = one compare read + a `workflow.sync_dry_run` event (it
// CANNOT tell whether the merge would conflict — only a merge can); enforce =
// merge the default branch into the feature branch right before the CI agent is
// dispatched, and on a 409 file a `Fix (sync-main)` sync_fix ticket that blocks
// the CI ticket. off = byte-identical: no GitHub call, no event, no write.
// STRICT allow-list (garbage → off) because enforce PUSHES A COMMIT to a shared
// branch. Instant rollback = set off.
const SYNC_MAIN_BEFORE_CI = normalizeSyncMode(process.env.SYNC_MAIN_BEFORE_CI);

// Advisory-ticket routing (TEAM-4122 FR-7): off | enforce, default off. An
// "advisory" ticket is out-of-scope-but-worth-doing work the reviewers file as
// backlog (requirements analyst Step 2 / release manager Step 4). Today it still
// rides the run: the completion guard waits on it and the dev is told to branch
// off the shared integration branch, so its files land in the run's unified PR —
// scope the humans explicitly declined. enforce makes the label mean what the
// blueprints already promise: excluded from every completion/open-fix gate, and
// branched from + PR'd against the repo DEFAULT branch, never adopted as the
// integration branch. There is deliberately NO shadow: the routing is what the
// agent is TOLD to do (a branch name in its prompt), so "observe-only" would
// either lie to the agent or do nothing at all. STRICT allow-list (garbage → off)
// because enforce changes what the run waits on. Instant rollback = set off.
const ADVISORY_ROUTING = normalizeAdvisoryRoutingMode(process.env.ADVISORY_ROUTING);
/**
 * The children a completion GATE may consider (TEAM-4122 FR-7). Under enforce an
 * advisory ticket owes the run nothing — no deliverable evidence, no merge
 * verdict — so it must be invisible to the evidence and ship-verdict gates the
 * same way isWorkflowComplete's own filter makes it invisible to the phase gates.
 * Off returns the array untouched (identity), so nothing changes without the flag.
 */
const gateChildren = (children) => (ADVISORY_ROUTING === "enforce" ? nonAdvisory(children) : children);

// The one persona whose dispatch the sync gates on — it is the agent that reads
// and certifies the branch head. Matches the roster entry below.
const CI_AGENT_ID = "agentcore_hub_ci_agent";

/**
 * Resolve CASCADE_EXTENDED_STATES to off | shadow | enforce. Legacy truthies
 * ("true"/"1"/"on"/"enforce") → enforce; explicit "shadow" → shadow; unset, "",
 * "off", "false", "0", or anything unrecognized → off (the pre-epic passthrough,
 * TEAM-3763 F6). shadow/enforce are granted ONLY on an explicit, recognized
 * value so an unset or typo'd var can never add the extended path's extra DDB
 * reads. Trimmed + lowercased so a casing slip can never grant write access.
 */
function resolveCascadeMode(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "enforce" || v === "on" || v === "true" || v === "1") return "enforce";
  if (v === "shadow") return "shadow";
  return "off"; // "", unset, "off", "false", "0", or garbage → off (pre-epic)
}
// TEAM-3686 Finding 3 / TEAM-3690: deliverable-evidence gate on the orchestrator
// completion path — same flag, same semantics as the HTTP complete route
// (TEAM-3619 D4a, design §X.5 step 6: "evidence check behind
// COMPLETION_EVIDENCE_REQUIRED flag (shadow-log first)"). The shadow-first
// observation step is now COMPLETE: per QA finding F2 (AC-D4.1) this DEFAULTS ON
// (ENFORCE) — a completion missing evidence aborts. Shadow mode remains ONLY as
// an explicit emergency opt-OUT: COMPLETION_EVIDENCE_REQUIRED=off|false|0
// (case-insensitive, trimmed) falls back to shadow-log-and-continue. Fail-closed:
// any other value — unset, empty, unrecognized garbage — ENFORCES, so an
// unparseable value can never silently disable the invariant. No force/bypass
// parameter either way.
const COMPLETION_EVIDENCE_REQUIRED = !/^(off|false|0)$/i.test(
  (process.env.COMPLETION_EVIDENCE_REQUIRED || "").trim()
);
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";
const TICKET_TOOLS_LAMBDA = process.env.TICKET_TOOLS_LAMBDA || (TICKET_PROVIDER === "jira" ? "agentcore-hub-jira" : "agentcore-hub-tickets");
const CLOUD_CODE_TABLE = process.env.CLOUD_CODE_TABLE || "agentcore-hub-cloud-code-sessions";

// Jira config (only used when TICKET_PROVIDER=jira)
const JIRA_SITE_URL = process.env.JIRA_SITE_URL || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_AUTH = JIRA_EMAIL && JIRA_API_TOKEN
  ? `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`
  : "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
store.initWorkflowStore(ddb, WORKFLOWS_TABLE);
const lambda = new LambdaClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const events = new EventBridgeClient({ region: REGION });
const bedrockAgent = new BedrockAgentRuntimeClient({ region: REGION });

// ─── Agent Roster (config-driven from S3, falls back to hardcoded) ────────────

const FALLBACK_ROSTER = [
  { agentId: "agentcore_hub_requirements_analyst", phase: "requirements" },
  { agentId: "agentcore_hub_frontend_designer", phase: "design" },
  { agentId: "agentcore_hub_ios_designer", phase: "design" },
  { agentId: "agentcore_hub_backend_designer", phase: "design" },
  { agentId: "agentcore_hub_android_designer", phase: "design" },
  { agentId: "agentcore_hub_security_reviewer", phase: "design" },
  { agentId: "agentcore_hub_legal_compliance", phase: "design" },
  { agentId: "agentcore_hub_localization", phase: "design" },
  { agentId: "agentcore_hub_analytics_designer", phase: "design" },
  { agentId: "agentcore_hub_backend_dev", phase: "development" },
  { agentId: "agentcore_hub_api_dev", phase: "development" },
  { agentId: "agentcore_hub_frontend_dev", phase: "development" },
  { agentId: "agentcore_hub_qa_verifier", phase: "verification" },
  { agentId: "agentcore_hub_ci_agent", phase: "review" },
  { agentId: "agentcore_hub_release_manager", phase: "ship" },
];

let _agentRoster = null;

// ─── CD registry (which repos the hub merges + deploys) ──────────────────────
// config/cd-registry.json in the artifact bucket; see cd-registry.mjs for the
// semantics. Re-read every CD_REGISTRY_TTL_MS (default 60s) so registering a
// repo in the UI takes effect on warm containers too — a run that is mid-flight
// when its repo is registered picks the ship phase up at its next dispatch.
// A failed read keeps the last good copy; a never-loaded registry is EMPTY
// (nothing registered → HANDOFF), the fail-safe direction: no merge, no deploy.
const CD_REGISTRY_TTL_MS = Number(process.env.CD_REGISTRY_TTL_MS) || 60_000;
let _cdRegistry = { ...EMPTY_CD_REGISTRY };
let _cdRegistryLoadedAt = 0;

export async function loadCdRegistry({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cdRegistryLoadedAt && now - _cdRegistryLoadedAt < CD_REGISTRY_TTL_MS) return _cdRegistry;
  if (!ARTIFACT_BUCKET) { _cdRegistryLoadedAt = now; return _cdRegistry; }
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: CD_REGISTRY_KEY }));
    _cdRegistry = parseCdRegistry(await res.Body.transformToString());
    if (!_cdRegistryLoadedAt) {
      console.log(`[orchestrator] CD registry: ${_cdRegistry.repos.length} repo(s) registered for merge+deploy`);
    }
  } catch (err) {
    const missing = /NoSuchKey|NotFound|404/i.test(String(err?.name || err?.message));
    if (missing) {
      if (!_cdRegistryLoadedAt) console.log("[orchestrator] CD registry: none in S3 — every repo is HANDOFF (PR left open, no merge/deploy)");
      _cdRegistry = { ...EMPTY_CD_REGISTRY };
    } else {
      console.warn(`[orchestrator] CD registry read failed: ${err.message} — keeping ${_cdRegistryLoadedAt ? "last good copy" : "empty registry"}`);
    }
  }
  _cdRegistryLoadedAt = now;
  return _cdRegistry;
}

/** The def a run FOLLOWS: registered repo → as written; else ship phase stripped. */
// The def a run actually follows: the configured def, with the run's SDLC
// framework overlay applied (e.g. software-delivery + "playbook" → artifact
// chain, always-on gates, branch at requirements), then the CD-registry handoff
// strip. Every gate/artifact/branch decision reads THIS, never the raw def.
//
// TEAM-4167 D3 (FR-3.1): this is called on EVERY cascade tick, so it must NEVER
// throw — a def that fails validation must not wedge an in-flight run. We run
// the repo-aware validate in a try/catch: an invalid def is warned about ONCE
// per (workflowId, workflowDefId) and surfaced as a WorkflowDefInvalid metric,
// then the run proceeds with the ship-strip exactly as before. Run creation
// (bootstrapBugWorkflow / start route) is where an invalid def is REFUSED.
const _invalidDefWarned = new Set();

function emitWorkflowDefInvalid(workflowDefId) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "AgentCoreHub/Orchestrator",
        Dimensions: [["workflowDefId"]],
        Metrics: [{ Name: "WorkflowDefInvalid", Unit: "Count" }],
      }],
    },
    workflowDefId,
    WorkflowDefInvalid: 1,
  }));
}

function getEffectiveWorkflowDef(workflow) {
  const base = getWorkflowDef(workflow?.workflowDefId);
  const framed = applyFramework(base, frameworkOfWorkflow(base, workflow));
  try {
    validateEffectiveDef(framed, { cdRegistered: isCdRegistered(_cdRegistry, workflow?.repoConfig) });
  } catch (err) {
    const key = `${workflow?.id || ""}|${workflow?.workflowDefId || ""}`;
    if (!_invalidDefWarned.has(key)) {
      _invalidDefWarned.add(key);
      console.warn(`[orchestrator] workflow_def.invalid (in-flight, proceeding): workflow=${workflow?.id} def=${workflow?.workflowDefId}: ${err.message}`);
      emitWorkflowDefInvalid(workflow?.workflowDefId || "unknown");
    }
  }
  return effectiveWorkflowDef(framed, _cdRegistry, workflow?.repoConfig, SHIP_PHASES);
}

function getDelivery(workflow) {
  return resolveDelivery(_cdRegistry, workflow?.repoConfig, {
    pipelineEnabled: isPipelineEnabled(process.env.PIPELINE_ENABLED),
  });
}

/**
 * Emit workflow.phase_change when a dispatched agent ticket moves the run's
 * phase (TEAM-4167 D3 FR-3.3). Two cases, so the lifecycle stream is COMPLETE
 * (intake→requirements→development→…), not just the "jumps forward" subset:
 *   - a genuine forward advance (agentPhaseIdx > currentPhaseIdx): stamp the new
 *     phase and advancePhase, exactly as the two inline blocks did before.
 *   - the FIRST agent ticket of the run's INITIAL agent phase, where
 *     agentPhaseIdx === currentPhaseIdx (the run was created already at that
 *     phase, so there is no ">" advance to hang the event on). Here we emit BOTH
 *     the opening "intake" row AND the initial agent phase, in that order.
 *
 * CALL 6 F1: the "intake" phase_change is emitted HERE, not at a creation site.
 * There are two creation paths — the app start route (src/app/api/workflow/
 * start/route.ts, a direct PutCommand with NO event path) and bug bootstrap —
 * and only this dispatch site is common to both, so anchoring the single
 * intake emit here is what makes EVERY run (app-started ymo7dm-class included)
 * get its intake row. A once-only store CAS (markInitialPhaseAnnounced)
 * guarantees exactly one intake+initial pair per run across concurrent
 * deliveries and re-dispatches; both emits sit behind that one CAS. The intake
 * row is anchored at workflow.startedAt (publishEvent honors a valid ISO
 * detail.timestamp) so the opening phase's duration measures from run start.
 */
export async function announcePhaseTransition(workflow, wfDef, agentDef, ticketId) {
  const phaseOrder = Array.isArray(wfDef?.phaseOrder) ? wfDef.phaseOrder : [];
  const agentPhaseIdx = phaseOrder.indexOf(agentDef.phase);
  const currentPhaseIdx = phaseOrder.indexOf(workflow.phase);
  if (agentPhaseIdx > currentPhaseIdx) {
    workflow.phase = agentDef.phase;
    await publishEvent(ticketId, "workflow.phase_change", { phase: agentDef.phase, workflowId: workflow.id });
    await store.advancePhase(workflow.id, workflow.phase, workflow.featureBranch);
    return;
  }
  // The initial agent phase is the first phaseOrder entry after "intake".
  const firstAgentPhaseIdx = phaseOrder.findIndex((p) => p !== "intake");
  if (agentPhaseIdx >= 0 && agentPhaseIdx === currentPhaseIdx && agentPhaseIdx === firstAgentPhaseIdx) {
    if (await store.markInitialPhaseAnnounced(workflow.id, agentDef.phase)) {
      // Two lifecycle rows behind the ONE CAS this run ever wins, in order:
      // the run opened at "intake" (anchored at run start), then the initial
      // agent phase (now). workflow.startedAt is the run's own creation stamp;
      // if it is somehow absent publishEvent falls back to now.
      await publishEvent(ticketId, "workflow.phase_change", { phase: "intake", workflowId: workflow.id, timestamp: workflow.startedAt });
      await publishEvent(ticketId, "workflow.phase_change", { phase: agentDef.phase, workflowId: workflow.id });
    }
  }
}

async function loadAgentRoster() {
  if (_agentRoster) return _agentRoster;
  if (!ARTIFACT_BUCKET) {
    console.warn("[orchestrator] No ARTIFACT_BUCKET — using fallback roster");
    _agentRoster = FALLBACK_ROSTER;
    return _agentRoster;
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    // Feed the same S3 config to the watchdog resolver (D1.1) — per-agent +
    // defaults watchdog blocks, resolved without a second fetch.
    setWatchdogSource(config);
    _agentRoster = config.agents.map((a) => ({
      agentId: a.agentId,
      phase: a.phase,
      runtimeArn: a.runtimeArn || null,
      workflowDefId: a.workflowDefId || DEFAULT_WORKFLOW_DEF_ID,
      // An agent may serve multiple pipelines (e.g. reviewer/QA/CI run in both
      // software-delivery and bug-fix). workflowDefIds is the multi-def list;
      // fall back to the single workflowDefId shorthand.
      workflowDefIds: a.workflowDefIds?.length ? a.workflowDefIds : [a.workflowDefId || DEFAULT_WORKFLOW_DEF_ID],
    }));
    console.log(`[orchestrator] Loaded ${_agentRoster.length} agents from S3 config`);
  } catch (err) {
    console.warn(`[orchestrator] Failed to load roster from S3: ${err.message} — using fallback`);
    _agentRoster = FALLBACK_ROSTER;
  }
  return _agentRoster;
}

function getAgentDef(id) {
  const roster = _agentRoster || FALLBACK_ROSTER;
  return roster.find((a) => a.agentId === id);
}

// ─── Workflow Definitions (config-driven shapes, from S3) ─────────────────────

const DEFAULT_WORKFLOW_DEF_ID = "software-delivery";

// Reproduces the original hardcoded 14-agent pipeline exactly. Used as fallback
// and whenever a workflow has no (or an unknown) workflowDefId.
const FALLBACK_WORKFLOW_DEF = {
  id: DEFAULT_WORKFLOW_DEF_ID,
  intakeAgentId: "agentcore_hub_requirements_analyst",
  featureBranchPhase: "development",
  createsPullRequest: true,
  completionRequiresAgentPhases: ["development", "verification", "review"],
  reviewGates: [],
  // Mirror the config-derived order (agentPhases only). The CI agent's "review"
  // phase is not a pipeline phase, so it is intentionally absent — keeps the
  // fallback identical to the S3-config path for software-delivery.
  phaseOrder: ["intake", "requirements", "design", "development", "verification", "complete"],
};

let _workflowDefs = null;

// Exported for tests to seed a ship-phase def (completion-gates.test.mjs drives
// the TEAM-3721 merge gate, which only engages for defs whose
// completionRequiresAgentPhases includes "ship").
export async function loadWorkflowDefs() {
  if (_workflowDefs) return _workflowDefs;
  _workflowDefs = { [DEFAULT_WORKFLOW_DEF_ID]: FALLBACK_WORKFLOW_DEF };
  if (!ARTIFACT_BUCKET) return _workflowDefs;
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/workflows.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    for (const w of config.workflows || []) {
      // Derive the monotonic phase-advancement order from the def's phases.
      const order = ["intake"];
      for (const p of w.phases || []) {
        if (p.agentPhase && p.agentPhase !== "intake" && !order.includes(p.agentPhase)) {
          order.push(p.agentPhase);
        }
      }
      order.push("complete");
      _workflowDefs[w.id] = {
        id: w.id,
        intakeAgentId: w.intakeAgentId,
        featureBranchPhase: w.featureBranchPhase ?? null,
        createsPullRequest: w.createsPullRequest ?? false,
        completionRequiresAgentPhases: w.completionRequiresAgentPhases || [],
        reviewGates: w.reviewGates || [],
        phaseOrder: order,
        // SDLC framework: the def's own methodology, its committed artifact
        // chain, and the selectable overlays (artifact-chain.mjs applyFramework).
        sdlcFramework: w.sdlcFramework || "standard",
        artifactChain: w.artifactChain || null,
        frameworks: w.frameworks || null,
        // extraAgentPhases are display-only rollup phases (software-delivery's
        // "ship"/"review" fold onto the QA card); they never affect phase
        // advancement, but validateEffectiveDef needs them so a gate guarding a
        // rollup phase isn't spuriously flagged as guarding an unknown phase.
        phases: (w.phases || []).map((p) => ({
          id: p.id,
          name: p.name,
          agentPhase: p.agentPhase,
          extraAgentPhases: p.extraAgentPhases || undefined,
        })),
      };
    }
    console.log(`[orchestrator] Loaded ${Object.keys(_workflowDefs).length} workflow definitions from S3`);
  } catch (err) {
    console.warn(`[orchestrator] Failed to load workflow defs from S3: ${err.message} — using fallback only`);
  }
  return _workflowDefs;
}

/** Resolve a workflow def by id with fallback to the default (software-delivery). */
function getWorkflowDef(id) {
  const defs = _workflowDefs || { [DEFAULT_WORKFLOW_DEF_ID]: FALLBACK_WORKFLOW_DEF };
  return defs[id] || defs[DEFAULT_WORKFLOW_DEF_ID] || FALLBACK_WORKFLOW_DEF;
}

// ─── Dead-session detector (TEAM-3618 D1.2) ──────────────────────────────────

/**
 * Re-dispatch a ticket through the NORMAL invocation path (claim CAS → invoke).
 * Used by the dead-session detector's retry-once step after it has stolen the
 * stale claim (status→ready). The claim CAS is the final arbiter — a live
 * concurrent claim wins and this returns false. Best-effort context build.
 */
async function redispatchTicket(workflow, ticket) {
  const agentDef = getAgentDef(ticket.assignee);
  if (!agentDef) return false;
  const claimed = await claimTicketInvocation(workflow, ticket.ticketId, ticket.assignee);
  if (!claimed) return false;
  const context = await buildAgentContext(ticket, workflow);
  await invokeAgent(agentDef, context, workflow, ticket.ticketId);
  return true;
}

/**
 * Level-triggered dispatch (TEAM-4060). Invoke a now-dispatchable dependent
 * IN-PROCESS instead of waiting for its provider Ready-status webhook. Routes
 * through the SAME handler the webhook path uses (handleTicketReadyUnified), so
 * every guard is reused for free — cancel-guard, human-gate parking, the claim
 * CAS (sole dedup arbiter; a webhook that also fires no-ops), the In Progress
 * transition, phase advancement, and feature-branch creation. Re-fetch the
 * ticket so assignee/parent/status are authoritative (the cascade snapshot came
 * off the eventually-consistent parentId GSI). Injected into the cascade as
 * `dispatchReady`; the cascade wraps this in its own non-fatal try/catch.
 */
async function dispatchReadyDependent(_workflow, sibling) {
  const fresh = (await getTicket(sibling.ticketId)) || sibling;
  await handleTicketReadyUnified(sibling.ticketId, fresh);
}

/**
 * Read one JSON object out of the artifact bucket, or null when it isn't there /
 * isn't JSON (TEAM-4120 FR-3). Injected as the escalation tree's `s3Get` so the
 * module never constructs an S3 client. "Missing" and "unreadable" are the same
 * answer to the caller: there is no evidence.
 */
async function readArtifactJson(key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
    return JSON.parse(await res.Body.transformToString());
  } catch {
    return null;
  }
}

// ─── Dead-session escalation tree (TEAM-4120 FR-3) ───────────────────────────
// Lazy singleton, same shape as getReworkLoopCap(): returns null when the mode is
// off, so `escalate` threads into both sweeps as `undefined` and their
// exhausted-retry paths stay byte-identical to pre-4120. Constructed once per
// warm container; every dep is an existing orchestrator function, which is what
// keeps the module itself free of AWS clients and unit-testable.
let _deadSessionEscalation = null;
function getDeadSessionEscalation() {
  if (DEAD_SESSION_ESCALATION_MODE === "off") return null;
  if (_deadSessionEscalation) return _deadSessionEscalation;
  _deadSessionEscalation = createDeadSessionEscalation({
    mode: DEAD_SESSION_ESCALATION_MODE,
    store,
    // Read-only events-table queries (lease.mjs owns every events read so the
    // paging bound + filter shape have one definition).
    lease: { lastStreamedText, hasAgentErrorSince },
    ddb,
    eventsTable: EVENTS_TABLE,
    getChildTickets,
    getTicket,
    invokeTickets,
    s3Get: readArtifactJson,
    // Optional: no PAT → readPrUrl is skipped, never fatal.
    githubApi: process.env.GITHUB_PAT ? githubApi : undefined,
    addBlockers,
    parkGateForHuman,
    publishEvent,
    transitionTicket: transitionTicketStatus,
  });
  return _deadSessionEscalation;
}

// ─── CI reachability probe deps (TEAM-4122 FR-5) ─────────────────────────────
// Lazy singleton, one per warm container. The CodeBuild and IAM SDK clients are
// loaded by DYNAMIC import, so CI_CHECK_MODE=off never pays their module-load
// cost — the orchestrator's cold start is unchanged on a plain install. iam is
// imported only under CI_CHECK_USE_IAM_SIMULATE=1; `githubApi` is omitted
// without a PAT (probe 3 is then skipped, never fatal); the Lambda client is the
// existing shared one.
// A failed import returns null (not a throw): @aws-sdk/client-codebuild is not
// in this Lambda's package.json — it comes from the runtime-bundled SDK — so a
// runtime that ever stops shipping it must degrade to "no CI block", never to a
// dispatch-breaking throw inside buildAgentContext.
let _ciCheckDeps = null;
async function ciCheckDeps() {
  if (CI_CHECK_MODE === "off") return null;
  if (_ciCheckDeps) return _ciCheckDeps;
  let CodeBuildClient, BatchGetProjectsCommand;
  try {
    ({ CodeBuildClient, BatchGetProjectsCommand } = await import("@aws-sdk/client-codebuild"));
  } catch (err) {
    console.warn(`[ci-check] @aws-sdk/client-codebuild unavailable — CI check skipped: ${err.message}`);
    return null;
  }
  const codebuild = new CodeBuildClient({ region: REGION });
  const deps = {
    codebuildSend: (input) => codebuild.send(new BatchGetProjectsCommand(input)),
    // The pipeline-tools handler reads event.tool_name + event.parameters and
    // replies with the standard { content: [{ text: <json> }] } envelope, which
    // ci-check.mjs unwraps.
    invokeLambda: async (functionName, payload) => {
      const res = await lambda.send(new InvokeCommand({
        FunctionName: functionName,
        Payload: JSON.stringify(payload),
      }));
      const raw = res.Payload ? new TextDecoder().decode(res.Payload) : "";
      if (!raw) return null;
      let parsed = JSON.parse(raw);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return parsed;
    },
    githubApi: process.env.GITHUB_PAT ? githubApi : undefined,
  };
  if (process.env.CI_CHECK_USE_IAM_SIMULATE === "1") {
    // Optional probe: a missing client leaves iamSimulate undefined (ci-check
    // then skips the simulate), it does not disable the whole check.
    try {
      const { IAMClient, SimulatePrincipalPolicyCommand } = await import("@aws-sdk/client-iam");
      const iam = new IAMClient({ region: REGION });
      deps.iamSimulate = (input) => iam.send(new SimulatePrincipalPolicyCommand(input));
    } catch (err) {
      console.warn(`[ci-check] @aws-sdk/client-iam unavailable — simulate probe skipped: ${err.message}`);
    }
  }
  _ciCheckDeps = deps;
  return _ciCheckDeps;
}

/**
 * Seams for sync-main.mjs (TEAM-4122 FR-6). One object per warm container; every
 * member is an existing orchestrator helper, so the module itself does no I/O of
 * its own and the whole matrix is testable with plain objects.
 *
 * githubApi/githubApiRaw are omitted without a PAT — sync-main then returns
 * `skipped: no_pat` and CI dispatches exactly as it does today.
 */
let _syncDeps = null;
function syncDeps() {
  if (SYNC_MAIN_BEFORE_CI === "off") return null;
  if (_syncDeps) return _syncDeps;
  _syncDeps = {
    githubApi: process.env.GITHUB_PAT ? githubApi : undefined,
    githubApiRaw: process.env.GITHUB_PAT ? githubRequestRaw : undefined,
    store,
    invokeTickets,
    addBlockers,
    publishEvent,
    getAgentDef,
    // TEAM-4131 F1: sync-main must never block CI on a fix ticket that is already
    // closed. getTicketConsistent, not getTicket — this decides whether a blocker
    // edge is about to point at a corpse, so the eventually-consistent snapshot is
    // exactly the wrong read. Both syncBeforeCi call sites (the unified ready path
    // and the DDB ready path) share this one memoized object.
    getTicketStatus: async (id) => (await getTicketConsistent(id))?.status ?? null,
    // TEAM-4156 F2: the 409 path's duplicate guard. The `syncMain` record is
    // written after create_ticket, so a lost record used to mean a second
    // identical sync_fix ticket at the same dev on every redelivery. One list of
    // the epic's children — the same seam live-reverify uses for its own sibling
    // scan — sees the ticket the record forgot.
    getChildTickets,
    now: () => new Date(),
    mode: SYNC_MAIN_BEFORE_CI,
    log: console,
  };
  return _syncDeps;
}

// ─── Awaited-ids re-wake (TEAM-4166 D1) ──────────────────────────────────────

/**
 * Last agent.streaming timestamp for a ticket's current claim, for the D2
 * escalation-evidence payload (null when there is no claim/agent or nothing
 * streamed). Only ever called on the rare escalate path, so the one extra
 * workflow read to resolve the agentId is cheap. Reuses lease.lastAgentActivity
 * (the SAME last-activity read the liveness gate uses) rather than re-scanning.
 */
async function lastStreamAtForTicket(workflowId, ticketId) {
  try {
    const wf = await store.getWorkflow(workflowId);
    const agentId = wf?.agentTasks?.[ticketId]?.agentId;
    if (!agentId) return null;
    return (await lastAgentActivity(ddb, EVENTS_TABLE, workflowId, agentId, ticketId)) || null;
  } catch {
    return null;
  }
}

// One awaited-ids surface per warm container (mirrors getCascade()/getDetector()).
// The board write goes through the SAME provider-aware addBlockers seam the rest
// of the orchestrator uses (preserveStatusIf keeps a parked agent in_progress),
// and the preconditionUnmet stamp through the identical Tickets___* tool the
// workflow-output channel writes, so provider parity is free.
let _awaitedIds = null;
function getAwaitedIds() {
  if (_awaitedIds) return _awaitedIds;
  _awaitedIds = createAwaitedIds({
    send: (input) => ddb.send(input),
    ticketsTable: TICKETS_TABLE,
    provider: TICKET_PROVIDER,
    getChildTickets,
    leaseTtlMs: LEASE_TTL_MS,
    // Adapter: forward the awaited-edge write to the existing provider-aware seam,
    // threading preserveStatusIf (so the parked agent is never yanked to Blocked).
    addBlockers: (ticketId, ids, opts = {}) =>
      addBlockers(ticketId, ids, { preserveStatusIf: opts.preserveStatusIf, source: opts.source }),
    // Adapter: stamp the origin's preconditionUnmet through the SAME Tickets___*
    // tool as the report_precondition_unmet channel (provider-agnostic).
    annotatePreconditionUnmet: (originId, { awaitingIds, source, reportedAt }) =>
      invokeTickets("annotate_precondition_unmet", {
        ticket_id: originId, awaitingIds, source, reportedAt,
      }),
    publishEvent,
    getTicket: getTicketConsistent,
    store,
    mode: AWAITED_IDS_MODE,
    timeoutMinutes: AWAITED_IDS_TIMEOUT_MINUTES,
    log: (msg) => console.log(`[orchestrator] ${msg}`),
  });
  return _awaitedIds;
}

// One detector per warm container so its per-agent median cache is reused
// across the 5-minute sweeps (rebuilt from scratch on a cold start).
let _detector = null;
function getDetector() {
  if (_detector) return _detector;
  _detector = createDetector({
    ddb,
    workflowsTable: WORKFLOWS_TABLE,
    eventsTable: EVENTS_TABLE,
    store,
    lease: { isLeaseLive, lastAgentActivity, stealClaim, LEASE_TTL_MS },
    getTicket,
    getAgentDef,
    publishEvent,
    redispatch: redispatchTicket,
    blockTicket: blockTicketForFailedInvoke,
    // TEAM-4120 FR-3 — undefined when DEAD_SESSION_ESCALATION_MODE=off (default),
    // which keeps the exhausted-retry page byte-identical.
    escalate: getDeadSessionEscalation()?.escalateExhausted,
    // TEAM-4166 D2 §2.3 — the evidence-gated escalation guard. The guard engages
    // only when the store exposes incrementCleanExitRedispatch, so an unwired
    // store keeps the pre-4166 unconditional escalate.
    awaitedIds: getAwaitedIds(),
    cleanExitRedispatchCap: CLEAN_EXIT_REDISPATCH_CAP,
    getLastStreamAt: lastStreamAtForTicket,
    // TEAM-4166 §0 — the same sibling reader the cascade uses, so the detector's
    // clean-park anti-thrash sees the awaited-fix closure and never re-dispatches
    // a release manager that is legitimately still waiting.
    getChildTickets,
  });
  return _detector;
}

// ─── Unblock cascade (TEAM-3618 D3) ──────────────────────────────────────────

// One shared cascade helper behind BOTH "ticket done" paths (Jira-webhook and
// DDB-stream), wired with the real provider/DDB/event effects. Lazy singleton
// so warm containers reuse it (mirrors getDetector()).
let _cascade = null;
function getCascade() {
  if (_cascade) return _cascade;
  _cascade = createCascade({
    ddb,
    ticketsTable: TICKETS_TABLE,
    provider: TICKET_PROVIDER,
    jiraTransition,
    getChildTickets,
    publishEvent,
    // Extended states (commit 4b) — off | shadow | enforce (TEAM-3747 D1).
    extendedStates: CASCADE_EXTENDED_STATES_MODE,
    // Level-triggered dispatch (TEAM-4060) — off | shadow | enforce. When on,
    // the cascade invokes newly-unblocked dependents in-process (dispatchReady)
    // instead of waiting for the Ready webhook.
    levelTriggerDispatch: LEVEL_TRIGGER_DISPATCH,
    dispatchReady: dispatchReadyDependent,
    lease: { isLeaseLive, lastAgentActivity, stealClaim, LEASE_TTL_MS },
    eventsTable: EVENTS_TABLE,
    workflowsTable: WORKFLOWS_TABLE,
    redispatch: redispatchTicket,
    reawakenGate: handleHumanReviewGate,
    // TEAM-3755 F9 — the strongly-consistent blocker confirm the extended-state
    // event path runs before it steals a lease and re-dispatches.
    getTicketConsistent,
    // TEAM-3969 — shared dead-session retry budget for the reconcile sweep's
    // stale-lease recovery (one auto re-dispatch, then manager_escalation).
    store,
    blockTicket: blockTicketForFailedInvoke,
    // TEAM-4120 FR-3 — same hook as the detector; undefined when off.
    escalate: getDeadSessionEscalation()?.escalateExhausted,
    // TEAM-4166 D1/D2 — the awaited-ids surface (union blocker predicate +
    // wait-SLA timeout) and the §2.3 evidence-gated escalation guard. Guard
    // engages only when store.incrementCleanExitRedispatch exists.
    awaitedIds: getAwaitedIds(),
    cleanExitRedispatchCap: CLEAN_EXIT_REDISPATCH_CAP,
    getLastStreamAt: lastStreamAtForTicket,
  });
  return _cascade;
}

// ─── Missed-unblock reconciliation sweep (TEAM-3747 D1) ──────────────────────

// Periodic safety net for cascades that never fired (orchestrator crash, dropped
// stream/webhook delivery, or a stale-GSI miss past the cascade's one bounded
// retry). Reuses the cascade's reconcileDependent so the R3 invariant
// (live → nudge; stale → steal + re-dispatch) has exactly one implementation.
// Lazy singleton, same shape as getCascade()/getDetector().
let _reconcileSweep = null;
function getReconcileSweep() {
  if (_reconcileSweep) return _reconcileSweep;
  _reconcileSweep = createReconcileSweep({
    ddb,
    workflowsTable: WORKFLOWS_TABLE,
    cascade: getCascade(),
    getChildTickets,
    leaseTtlMs: LEASE_TTL_MS,
    // TEAM-4166 D1/D2 — the awaited-ids backstop (edge backfill + wait-SLA). The
    // §2.3 evidence guard itself lives in the cascade's reconcileDependent, which
    // this sweep routes every candidate through.
    awaitedIds: getAwaitedIds(),
  });
  return _reconcileSweep;
}

// ─── Review-gate round cap (TEAM-3619 D2c) ───────────────────────────────────

// Bounds the review→rework loop: after `maxRounds` effective rounds the gate is
// handed to a human instead of re-opening the upstream work yet again. Lazy
// singleton, same shape as getCascade()/getDetector().
let _reviewCap = null;
function getReviewCap() {
  if (_reviewCap) return _reviewCap;
  _reviewCap = createReviewCap({
    store,
    publishEvent,
    listReviewers,
    parkGateForHuman,
    commentOnGate: addTicketComment,
    log: (msg) => console.log(`[orchestrator] ${msg}`),
  });
  return _reviewCap;
}

// ─── Rework-loop cap (TEAM-4113) ─────────────────────────────────────────────
// Per-(workflow,phase) lineage backstop on the review→rework loop: counts fix
// tickets reaching Done PER PHASE (not per gate-ticket id, which the review-cap
// keys on and which resets when the loop hops to a new ticket id). Fires only
// when REWORK_LOOP_CAP != off; default off ⇒ getReworkLoopCap is never called.
let _reworkLoopCap = null;
function getReworkLoopCap() {
  if (_reworkLoopCap) return _reworkLoopCap;
  _reworkLoopCap = createReworkLoopCap({
    store,
    publishEvent,
    // enforce-only, best-effort: parks the run's OPEN release-manager escalation
    // gate if one exists; a gate-less phase degrades to the cap_reached signal.
    parkRunEscalationGate,
    // TEAM-4121 FR-8: the cap counts REWORK rounds only — ci_fix/sync_fix are
    // environmental and must not drive a human escalation (completion's open-fix
    // gate still waits on them via the full FIX_KINDS set).
    fixKinds: REWORK_FIX_KINDS,
    mode: REWORK_LOOP_CAP,
    log: (msg) => console.log(`[orchestrator] ${msg}`),
  });
  return _reworkLoopCap;
}

/**
 * Best-effort park of the run's OPEN release-manager ship-review escalation
 * gate (TEAM-4113 enforce). Only that gate has an unambiguous shape to park; a
 * phase with no human gate (dev/QA) returns false and enforce relies on the
 * rework.cap_reached signal instead (creating a per-phase gate is Phase-2).
 * Never throws — the caller already fails open on any error.
 */
async function parkRunEscalationGate(workflow, _phase) {
  try {
    const epicId = workflow?.epicId || workflow?.parentId;
    if (!epicId) return false;
    const kids = (await getChildTickets(epicId)) || [];
    const openGate = kids.find(
      (t) =>
        ESCALATION_GATE_TITLE.test(t?.title || t?.summary || "") &&
        !["done", "cancelled"].includes(String(t?.status).toLowerCase())
    );
    if (!openGate) return false;
    const gid = openGate.ticketId || openGate.id || openGate.key;
    await parkGateForHuman(gid, openGate.assignee || "human:reviewer", workflow);
    return true;
  } catch (err) {
    console.warn(`[orchestrator] parkRunEscalationGate failed (non-fatal): ${err?.message || err}`);
    return false;
  }
}

/**
 * Observe a just-completed ticket for the rework-loop cap (TEAM-4113). Called
 * from BOTH done paths. Cheap + non-fatal: returns at once for a non-fix ticket
 * or when REWORK_LOOP_CAP=off, and never lets a ledger/publish failure escape
 * into the done cascade.
 */
async function observeReworkLoop(workflow, ticket) {
  if (REWORK_LOOP_CAP === "off" || !ticket) return;
  try {
    const phase = ticket.phase || getAgentDef(ticket.assignee)?.phase;
    await getReworkLoopCap().observe({
      workflow,
      ticket,
      phase,
      feedback: ticket.resolutionComment || ticket.description || "",
    });
  } catch (err) {
    console.warn(`[orchestrator] rework-loop observe failed (non-fatal): ${err?.message || err}`);
  }
}

// ─── Live-evidence re-verification (TEAM-4121 FR-9) ──────────────────────────
// Lazy singleton, same shape as getReworkLoopCap(). Fires only when
// LIVE_REVERIFY != off; default off ⇒ never constructed, so the done twins keep
// their exact pre-4121 behaviour (no completion-record read, no ticket).
let _liveReverify = null;
function getLiveReverify() {
  if (_liveReverify) return _liveReverify;
  _liveReverify = createLiveReverify({
    mode: LIVE_REVERIFY,
    store,
    invokeTickets,
    getChildTickets,
    getAgentDef,
    // Which phases must be blocked on an outstanding re-verification. SHARED with
    // completion.mjs so "what counts as ship" has one definition.
    shipPhases: SHIP_PHASES,
    addBlockers,
    publishEvent,
    log: console,
  });
  return _liveReverify;
}

/**
 * Read one completion record (completions/<ticketId>.json), memoized for the
 * lifetime of this Lambda invocation.
 *
 * harvestCompletionEvidence already reads the same object a few lines earlier in
 * the done path; without the memo, turning LIVE_REVERIFY on would double every
 * done ticket's S3 GET. The cache is per-invocation on purpose — a record written
 * BETWEEN two invocations must be visible to the second one (that is the whole
 * mechanism behind re-Done'ing a ticket to re-check late evidence, TEAM-3985).
 */
let _completionRecordCache = new Map();
function resetCompletionRecordCache() {
  _completionRecordCache = new Map();
}
async function readCompletionRecord(ticketId) {
  if (!ARTIFACT_BUCKET || !ticketId) return null;
  if (_completionRecordCache.has(ticketId)) return _completionRecordCache.get(ticketId);
  const p = readArtifactJson(`completions/${ticketId}.json`);
  _completionRecordCache.set(ticketId, p);
  return p;
}

/**
 * Observe a just-completed FIX ticket for live re-verification (TEAM-4121 FR-9).
 * Called from BOTH done paths, right after observeReworkLoop. Cheap + non-fatal:
 * returns before any I/O for a non-fix ticket or when LIVE_REVERIFY=off, and the
 * module itself never throws.
 */
async function observeLiveReverify(workflow, ticket) {
  if (LIVE_REVERIFY === "off" || !workflow) return;
  if (!ticket?.spawnedBy?.kind || !FIX_KINDS.has(ticket.spawnedBy.kind)) return;
  try {
    await getLiveReverify().onFixDone({
      workflow,
      fixTicket: ticket,
      completionRecord: await readCompletionRecord(ticket.ticketId),
    });
  } catch (err) {
    console.warn(`[orchestrator] live-reverify observe failed (non-fatal): ${err?.message || err}`);
  }
}

// ─── Merge-on-green (TEAM-4110) ──────────────────────────────────────────────
// Merges a human-approved, clean+green final PR from the orchestrator so an
// approved run isn't left open on workflow.cd_unmerged. Lazy singleton, same
// shape as getCascade()/getReviewCap(). Fires only when MERGE_ON_GREEN != off.
let _mergeOnGreen = null;
function getMergeOnGreen() {
  if (_mergeOnGreen) return _mergeOnGreen;
  _mergeOnGreen = createMergeOnGreen({
    githubApi,
    getChildTickets,
    parseRepoUrl,
    publishEvent,
    getAgentPhase: (agentId) => getAgentDef(agentId)?.phase,
    log: (msg) => console.log(`[orchestrator] ${msg}`),
    mode: MERGE_ON_GREEN,
  });
  return _mergeOnGreen;
}

// ─── Ship-head stability (TEAM-4111) ─────────────────────────────────────────
// Keeps the release_manager off a moving branch head: at ship-ticket
// (re)dispatch time, dispatch only when the PR head has been quiet >= stableMs
// AND CI is green on THAT exact head; otherwise defer (re-queue). Fires only
// when SHIP_HEAD_STABILITY != off. The injected githubProbe reads the open PR's
// head SHA, its commit time, and the aggregate check-runs conclusion.
let _shipHeadGate = null;
function getShipHeadGate() {
  if (_shipHeadGate) return _shipHeadGate;
  _shipHeadGate = createShipHeadGate({
    githubProbe: createGitHubShipHeadProbe({ githubApi, parseRepoUrl }),
    log: (msg) => console.log(`[orchestrator] ${msg}`),
    mode: SHIP_HEAD_STABILITY,
  });
  return _shipHeadGate;
}

/**
 * Re-drive ship tickets this run deferred for head instability (TEAM-4111).
 * A deferred ship ticket stays Ready and idle — nothing edge-triggers it again
 * (the reconcile sweep's redispatch bypasses handleTicketReadyUnified, so it
 * would skip this gate). This runs on the reconcile-sweep tick: for every
 * non-terminal workflow carrying shipHeadDeferrals, re-invoke the SAME Ready
 * handler so the gate re-evaluates the (now hopefully quiet) head — dispatching
 * when stable-green, re-deferring otherwise, and force-dispatching at the
 * deadlock cap. No-op when SHIP_HEAD_STABILITY=off (byte-identical) and inert in
 * shadow (which never defers, so nothing carries the marker).
 */
async function redriveDeferredShipHeads() {
  if (SHIP_HEAD_STABILITY === "off") return { rechecked: 0, redriven: 0 };
  let workflows = [];
  try {
    ({ workflows } = await getReconcileSweep().scanNonTerminalWorkflows());
  } catch (err) {
    console.warn(`[orchestrator] ship-head re-drive scan failed (non-fatal): ${err?.message || err}`);
    return { rechecked: 0, redriven: 0 };
  }
  let rechecked = 0;
  let redriven = 0;
  for (const wf of workflows) {
    const tid = wf?.shipHeadTicketId;
    if (!tid || (Number(wf?.shipHeadDeferrals) || 0) <= 0) continue;
    rechecked++;
    try {
      const fresh = await getTicket(tid);
      // Only re-drive a ticket still resting in Ready — a claimed/moved ticket
      // is being handled elsewhere and the marker will clear on its next
      // dispatch/defer decision.
      if (!fresh || String(fresh.status).toLowerCase() !== "ready") continue;
      await handleTicketReadyUnified(tid, fresh);
      redriven++;
    } catch (err) {
      console.warn(`[orchestrator] ship-head re-drive ${tid} failed (non-fatal): ${err?.message || err}`);
    }
  }
  if (rechecked) console.log(`[orchestrator] ship-head re-drive — rechecked=${rechecked} redriven=${redriven}`);
  return { rechecked, redriven };
}

/**
 * Both ship-ticket dispatch gates, in one place, wired into BOTH Ready handlers
 * (the Jira/webhook `handleTicketReadyUnified` and the DDB-stream legacy
 * `handleTicketReady`). Runs only for ship-phase tickets (caller guards). Order
 * matters: check prerequisites FIRST (cheap-ish sibling read, and no point
 * probing GitHub for a run whose dev/QA isn't even done), THEN head-stability.
 *
 *   - TEAM-4112 SHIP_DISPATCH_GATE: gate the RM until its prerequisite dev/QA/CI
 *     siblings are terminal. enforce writes a blockedBy edge to the incomplete
 *     prerequisite (Jira issueLink + Blocked / DDB blockedBy+status), so the
 *     EXISTING unblock cascade re-wakes ship when that prerequisite completes.
 *   - TEAM-4111 SHIP_HEAD_STABILITY: defer the RM off a moving/not-green head;
 *     re-driven on the reconcile-sweep tick (redriveDeferredShipHeads).
 *
 * Returns "dispatch" (proceed to claim + invoke) or "skip" (the caller returns
 * immediately without claiming). Both gates default off ⇒ this returns
 * "dispatch" with zero I/O and zero metrics — byte-identical to pre-gate.
 * Never throws: a read/probe failure fails OPEN (dispatch) — a wedged ship is
 * worse than a redundant RM invocation.
 */
async function evaluateShipTicketDispatch({ ticketId, parentId, agentDef, workflow }) {
  // ── TEAM-4112: prerequisite gate ──────────────────────────────────────────
  if (SHIP_DISPATCH_GATE !== "off") {
    let siblings = null;
    try {
      siblings = await getChildTickets(parentId || workflow.epicId);
    } catch (err) {
      console.warn(`[orchestrator] ship-dispatch sibling read failed (dispatching, fail-open): ${err?.message || err}`);
    }
    if (siblings) {
      const verdict = shouldGateShipDispatch({
        agentDef,
        wfDef: getEffectiveWorkflowDef(workflow),
        siblings,
        getAgentPhase: (a) => getAgentDef(a)?.phase,
        shipPhases: SHIP_PHASES,
      });
      if (verdict.gated) {
        if (SHIP_DISPATCH_GATE === "shadow") {
          console.log(`[orchestrator] ship-dispatch WOULD gate ${ticketId} → prereq ${verdict.repairBlocker} incomplete (blockers=${verdict.blockers.join(",")}) — shadow`);
          emitShipDispatchMetrics("wouldGate");
        } else {
          const self = siblings.find((s) => (s.ticketId || s.id || s.key) === ticketId);
          try {
            await blockShipOnPrereq(ticketId, self, verdict.repairBlocker);
          } catch (err) {
            // Block-write failure fails OPEN: better a redundant RM run than a
            // ship ticket stuck Ready with no blockedBy edge to ever re-wake it.
            console.warn(`[orchestrator] ship-dispatch block-write failed (dispatching, fail-open): ${err?.message || err}`);
            emitShipDispatchMetrics("clear");
            return "dispatch";
          }
          console.log(`[orchestrator] ship-dispatch GATE ${ticketId} → blocked on ${verdict.repairBlocker} (prereqs incomplete) — not dispatching`);
          emitShipDispatchMetrics("gated");
          return "skip";
        }
      } else {
        emitShipDispatchMetrics("clear");
      }
    }
  }

  // ── TEAM-4111: head-stability gate ─────────────────────────────────────────
  // On defer we persist the consecutive-deferral count + this ticket id and skip;
  // the reconcile-tick re-drive re-enters the Ready handler once the head may
  // have settled. On dispatch we clear any prior marker so the deadlock cap resets.
  if (SHIP_HEAD_STABILITY !== "off") {
    const verdict = await getShipHeadGate().evaluate(workflow, { ticketId });
    if (verdict.action === "defer") {
      const n = (Number(workflow.shipHeadDeferrals) || 0) + 1;
      try { await store.setShipHeadDeferrals(workflow.id, n, ticketId); }
      catch (err) { console.warn(`[orchestrator] ship-head deferral persist failed (non-fatal): ${err?.message || err}`); }
      console.log(`[orchestrator] ship-head defer ${ticketId} (${verdict.reason}) — deferral ${n} — not dispatching`);
      return "skip";
    }
    if ((Number(workflow.shipHeadDeferrals) || 0) > 0) {
      try { await store.setShipHeadDeferrals(workflow.id, 0); }
      catch (err) { console.warn(`[orchestrator] ship-head deferral clear failed (non-fatal): ${err?.message || err}`); }
      workflow.shipHeadDeferrals = 0;
    }
  }

  return "dispatch";
}

/**
 * Block a ship ticket on an incomplete prerequisite (TEAM-4112 enforce). Writes
 * the blockedBy edge the requirements agent should have — Jira: a "Blocks" issue
 * link (blocker blocks ship) + a transition to Blocked; DynamoDB: append to the
 * blockedBy array + set status "blocked". Idempotent: if the ship ticket already
 * lists this blocker, only re-assert the Blocked status (Jira links dedupe by
 * (type, pair) anyway). The existing unblock cascade re-wakes ship to Ready when
 * the blocker reaches done/cancelled, so no bespoke re-drive is needed.
 */
async function blockShipOnPrereq(ticketId, shipTicket, blockerId) {
  if (!blockerId) return;
  const already = Array.isArray(shipTicket?.blockedBy) && shipTicket.blockedBy.includes(blockerId);
  if (TICKET_PROVIDER === "jira") {
    if (!already) {
      await jiraFetch("/rest/api/3/issueLink", "POST", {
        type: { name: "Blocks" },
        inwardIssue: { key: blockerId },
        outwardIssue: { key: ticketId },
      });
    }
    await jiraTransition(ticketId, "Blocked");
  } else {
    const merged = already
      ? shipTicket.blockedBy
      : [...((shipTicket && shipTicket.blockedBy) || []), blockerId];
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET blockedBy = :b, #s = :s, #u = :u",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ":b": merged, ":s": "blocked", ":u": new Date().toISOString() },
    }));
  }
}

/**
 * Add blockers to ANY ticket and park it Blocked (TEAM-4120 FR-3). Generalized
 * from blockShipOnPrereq (left untouched — it carries the TEAM-4112 ship
 * semantics): many blockers instead of one, and idempotent per blocker so a
 * re-run adds only what is missing. Returns the ids actually added.
 *
 * Jira: one "Blocks" issueLink per blocker (Jira dedupes by (type, pair), so a
 * repeat is a no-op) then ONE transition to Blocked. DynamoDB: a conditional
 * per-blocker list_append, so concurrent writers can't clobber each other's
 * edges the way a whole-array rewrite does; CCFE means "already linked" → skip.
 *
 * TEAM-4130 F1 — `opts.preserveStatusIf`: statuses whose ticket must KEEP its
 * status while still gaining the edge. Default `[]` = the pre-4130 behaviour,
 * byte for byte, which is what the dead-session escalation (its held ticket is
 * already board-`blocked`) and sync-main's `blockOnFix` (its CI ticket IS
 * `in_progress` at call time and RELIES on the flip to park it) both want.
 * live-reverify opts in with ["in_progress","in_review"], because a release
 * manager mid-run whose status is yanked to `blocked` can no longer reach Done
 * through the tickets Lambda's real `done` transition — TRANSITIONS.blocked has
 * no `done` row, so `to_status:"done"` would only resolve through the `skip`
 * row's `to` alias and record a SKIP where a completion belongs. The decision is
 * made inside the conditional write (see ticket-blockers.mjs), never by a
 * read-then-write that would race the agent's own transition.
 *
 * NOTE: this is a deliberate, acknowledged duplicate of the tickets-Lambda
 * `add_blockers` op added in PR #380, which main does not yet carry. When #380
 * merges, replace the body with invokeTickets("add_blockers", …) so the board
 * write lives in exactly one place again.
 */
async function addBlockers(ticketId, ids, opts = {}) {
  const blockers = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!ticketId || !blockers.length) return [];
  const preserveStatusIf = normalizePreserveStatuses(opts.preserveStatusIf);
  const added = [];
  if (TICKET_PROVIDER === "jira") {
    for (const id of blockers) {
      try {
        await jiraFetch("/rest/api/3/issueLink", "POST", {
          type: { name: "Blocks" },
          inwardIssue: { key: id },
          outwardIssue: { key: ticketId },
        });
        added.push(id);
      } catch (err) {
        console.warn(`[orchestrator] addBlockers: link ${id} → ${ticketId} failed (non-fatal): ${err?.message || err}`);
      }
    }
    if (added.length && !(await jiraStatusIsPreserved(ticketId, preserveStatusIf))) {
      await jiraTransition(ticketId, "Blocked");
    }
    return added;
  }
  for (const id of blockers) {
    const outcome = await applyBlockerEdge({
      send: (input) => ddb.send(new UpdateCommand(input)),
      table: TICKETS_TABLE,
      ticketId,
      blockerId: id,
      preserveStatusIf,
      now: new Date().toISOString(),
      warn: (msg) => console.warn(msg),
    });
    if (outcome === "preserved") {
      console.log(`[orchestrator] addBlockers: ${ticketId} += ${id} (edge only — status preserved, TEAM-4130 F1)`);
    }
    if (outcome === "blocked" || outcome === "preserved") added.push(id);
  }
  return added;
}

/**
 * TEAM-4130 F1 (Jira half) — is this issue in one of the statuses the caller
 * asked to preserve? Reads the issue's CURRENT status rather than trusting the
 * sibling snapshot the caller was handed, which may be seconds stale. Jira has
 * no conditional write, so this is a read-then-write and cannot be made atomic;
 * the fail-safe direction is today's behaviour — an unreadable status returns
 * false, i.e. we still transition to Blocked (an unnecessary park is recoverable
 * by the unblock cascade; a missed park would let a run ship past a live fix).
 */
async function jiraStatusIsPreserved(issueKey, preserveStatusIf) {
  if (!preserveStatusIf?.length) return false;
  try {
    const issue = await jiraFetch(`/rest/api/3/issue/${issueKey}?fields=status`);
    const name = issue?.fields?.status?.name;
    if (!name) throw new Error("no fields.status.name in the issue response");
    const current = mapJiraStatus(name);
    if (preserveStatusIf.includes(current)) {
      console.log(`[orchestrator] addBlockers: ${issueKey} left in ${current} (no Blocked hop, TEAM-4130 F1)`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[orchestrator] addBlockers: could not read ${issueKey}'s status (${err?.message || err}) — falling back to the Blocked transition`);
    return false;
  }
}

/**
 * Call the tickets/jira tools Lambda synchronously and return its parsed result
 * (TEAM-4120 FR-3 needs the new key back from create_ticket, so unlike
 * addTicketComment's fire-and-forget invoke this one reads the response). Both
 * provider Lambdas expose the identical `Tickets___*` interface, so the caller
 * never learns which backend is live.
 *
 * "Identical interface" was only true of the INPUTS, though — the two Lambdas
 * disagree on both halves of the answer (TEAM-4156 F1), and this seam is where
 * that is reconciled, once, so no caller has to know:
 *
 *   failures — the dynamodb Lambda answers a textResult envelope
 *     (`{content:[{text}]}`); the jira Lambda's handler catch-all and its
 *     unknown-tool path answer a BARE `{ error }`. Only the first was detected, so
 *     a jira failure came back as a truthy "result" and every caller read it as
 *     success. Both are now throws — a create that did not happen must never look
 *     like one that did.
 *   create_ticket's id — dynamodb answers `{ key, ticket:{key} }`, jira answers
 *     `{ ticketId }` (fresh) or `{ ...mapIssue(dup), deduplicated:true }` (summary
 *     dedupe), also `ticketId`. Normalized to `key` here, in place, keeping every
 *     other field (`deduplicated`, `warning`, `ticket`, …) so a caller can still
 *     see a dedupe hit. Callers ALSO read the id through
 *     ticket-blockers.mjs's `createdTicketId`, which handles both spellings on its
 *     own — belt and braces, because agents reach the same providers through paths
 *     that do not come through here.
 */
async function invokeTickets(toolName, parameters) {
  const res = await lambda.send(new InvokeCommand({
    FunctionName: TICKET_TOOLS_LAMBDA,
    Payload: JSON.stringify({ tool_name: `Tickets___${toolName}`, parameters }),
  }));
  const raw = res.Payload ? new TextDecoder().decode(res.Payload) : "";
  if (!raw) return null;
  let parsed = JSON.parse(raw);
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  const obj = parsed && typeof parsed === "object" ? parsed : null;
  // An id under EITHER provider's spelling means the op produced a real ticket,
  // whatever else rides along with it. Checked before both error shapes so a
  // legitimate ticket that happens to carry an `error`/`content` field is never
  // thrown away.
  const hasId = !!obj && (typeof obj.key === "string" || typeof obj.ticketId === "string");
  if (obj && !hasId && typeof obj.error === "string") {
    throw new Error(`Tickets___${toolName}: ${obj.error.slice(0, 300)}`);
  }
  if (obj?.content?.[0]?.text && !hasId) {
    throw new Error(`Tickets___${toolName}: ${String(obj.content[0].text).slice(0, 300)}`);
  }
  if (toolName === "create_ticket" && obj && typeof obj.key !== "string" && typeof obj.ticketId === "string") {
    obj.key = obj.ticketId;
  }
  return parsed;
}

/**
 * Hand an escalated review gate to a human: owned by `assignee`, parked in
 * in_review, with the decision instructions on the ticket.
 *
 * The gate is the only exit from a capped loop, so the human has to be able to
 * find it AND to know the syntax that re-authorizes rework — hence the comment,
 * not just the in-app notification.
 *
 * Assignment is provider-limited: DynamoDB mode writes the assignee field for
 * real, Jira mode cannot (the ticket-tools Lambda's update_ticket only carries
 * summary/description, and Jira's assignee needs an accountId). In Jira the
 * ownership therefore lives in the comment + the review_needed notification.
 */
async function parkGateForHuman(gateTicketId, assignee, workflow) {
  if (TICKET_PROVIDER !== "jira") {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId: gateTicketId },
      UpdateExpression: "SET #s = :s, #a = :a, #u = :u",
      ExpressionAttributeNames: { "#s": "status", "#a": "assignee", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":s": "in_review",
        ":a": assignee,
        ":u": new Date().toISOString(),
      },
    }));
  }
  // Transition (idempotent), notification, review.needed event — the same path
  // the "ready" flow uses, so the board state is identical to a normal gate.
  await handleHumanReviewGate(gateTicketId, assignee, workflow);
}

/**
 * Post a comment on a ticket via the ticket-tools Lambda. Best-effort: a failed
 * comment must not fail the escalation that is already recorded and parked.
 */
async function addTicketComment(ticketId, comment) {
  if (TICKET_PROVIDER !== "jira") return false;
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: TICKET_TOOLS_LAMBDA,
      Payload: JSON.stringify({
        tool_name: "Tickets___add_comment",
        parameters: { ticket_id: ticketId, comment },
      }),
    }));
    return true;
  } catch (err) {
    console.warn(`[orchestrator] addTicketComment(${ticketId}) failed: ${err.message}`);
    return false;
  }
}

/**
 * Enforce-mode side effect of an `uncertifiable` CI check (TEAM-4122 FR-5): mark
 * the run's epic so the state is visible on the BOARD, not only inside one
 * agent's context. The label is what makes it filterable after the fact ("which
 * runs shipped with no CI?") — a comment scrolls away, a label does not.
 *
 * Label is `ci:uncertifiable` with NO SPACE: Jira rejects whitespace in labels
 * outright (the whole PUT 400s), so the prose form "ci: uncertifiable" seen in
 * ticket text is not a legal label. `ci:` is already a reserved system prefix in
 * fix-contract.mjs, so no agent can squat it.
 *
 * Written at most ONCE per workflow: `ciCheck.labeled` is persisted immediately
 * after a successful write and survives every re-probe, so a warm container
 * dispatching ten tickets cannot label ten times. Best-effort and NEVER throws —
 * a provider that lacks labels_add, or a permissions gap, must not stop the
 * agent this context was being built for. Falls back to a comment.
 */
async function labelEpicUncertifiable(workflow, ciCheck) {
  const epicId = workflow?.epicId || workflow?.parentId;
  if (!epicId) return false;
  const note = `⚠ CI UNCERTIFIABLE: ${ciCheck?.reason || "no CodeBuild build can exist for this head."}`;
  let labeled = false;
  let commented = false;
  try {
    const res = await invokeTickets("labels_add", { ticket_id: epicId, issue_key: epicId, labels: ["ci:uncertifiable"] });
    // The jira Lambda's failure envelope is a BARE `{ error }` with no `content`
    // field. invokeTickets now throws on it (TEAM-4156 F1) and the catch below
    // does the right thing, so this check is redundant — kept because it is the
    // cheap, local guarantee that a 400 from Jira can never be recorded as a
    // successful label, which would suppress both the comment fallback and (via
    // labeled:true) every later retry. Check the payload, not just the throw.
    if (res?.error) throw new Error(String(res.error).slice(0, 300));
    labeled = true;
  } catch (err) {
    console.warn(`[ci-check] labels_add on ${epicId} failed: ${err.message} — falling back to a comment`);
    // Comment fallback is jira-only (addTicketComment no-ops in dynamodb mode);
    // in that mode the `## CI Certification` context block + the merge-gate
    // prefix remain the surfaces that carry the warning.
    commented = await addTicketComment(epicId, note);
  }
  // `labeled` is the "stop trying" flag, so only set it once the warning really
  // reached the board (label or comment). A failure that reached NEITHER leaves
  // it unset so the next dispatch on this run retries — bounded by the run's
  // ticket count, and far better than silently losing the only board-visible
  // record of an uncertifiable run.
  if (labeled || commented) {
    try {
      await store.setCiCheck(workflow.id, { ...ciCheck, labeled: true });
    } catch (err) {
      console.warn(`[ci-check] could not persist labeled flag for ${workflow.id}: ${err.message}`);
    }
  }
  return labeled;
}

// ─── Handler (DDB Stream OR direct webhook invocation) ───────────────────────

export const handler = async (event) => {
  // Per-invocation completion-record cache (TEAM-4121 FR-9). Cleared here, not on
  // a timer: a record written between two invocations must be visible to the
  // second one, otherwise re-Done'ing a ticket could not pick up late evidence.
  resetCompletionRecordCache();
  // Load roster + workflow defs from S3 on first invocation (cached for warm starts)
  await loadAgentRoster();
  await loadWorkflowDefs();
  await loadCdRegistry();

  // Scheduled dead-session sweep (TEAM-3618 D1.2). A rate(5 minutes) EventBridge
  // rule fires this sentinel. Branch BEFORE any stream/webhook parsing — it is a
  // synthetic invocation with no Records/source-webhook shape.
  if (event?.source === "orchestrator.sweep" && event?.action === "dead_session_sweep") {
    console.log(`[orchestrator] dead-session sweep (mode=${DEAD_SESSION_DETECTOR_MODE})`);
    return getDetector().runSweep(DEAD_SESSION_DETECTOR_MODE);
  }

  // Scheduled missed-unblock reconciliation sweep (TEAM-3747 D1). Same
  // sentinel-event pattern as the dead-session sweep above — a scheduled
  // EventBridge rule fires { source: "orchestrator.sweep",
  // action: "reconcile_sweep" }. Branch BEFORE any stream/webhook parsing.
  if (event?.source === "orchestrator.sweep" && event?.action === "reconcile_sweep") {
    console.log(`[orchestrator] reconcile sweep (mode=${RECONCILE_SWEEP_MODE})`);
    const reconcileResult = await getReconcileSweep().runSweep(RECONCILE_SWEEP_MODE);
    // TEAM-4111 — re-evaluate ship tickets deferred for head instability on the
    // same tick. No-op when SHIP_HEAD_STABILITY=off; inert in shadow.
    try { await redriveDeferredShipHeads(); }
    catch (err) { console.warn(`[orchestrator] ship-head re-drive failed (non-fatal): ${err?.message || err}`); }
    return reconcileResult;
  }

  // SQS FIFO command queue (R1 — docs/race-condition-study.md). One message
  // group per workflow root, so commands for a run arrive strictly in order
  // and never concurrently. Partial-batch failure reporting keeps a failed
  // command (and everything behind it in its group) on the queue for retry.
  if (event.Records?.[0]?.eventSource === "aws:sqs") {
    const batchItemFailures = [];
    for (let i = 0; i < event.Records.length; i++) {
      const record = event.Records[i];
      try {
        const cmd = JSON.parse(record.body);
        if (cmd.source === "jira-webhook") {
          if (TICKET_PROVIDER !== "jira") {
            console.log(`[orchestrator] Ignoring queued Jira command — TICKET_PROVIDER=${TICKET_PROVIDER}`);
            continue;
          }
          console.log(`[orchestrator] Command: ${cmd.ticketId} → ${cmd.newStatus} (group ${record.attributes?.MessageGroupId})`);
          await processStatusChange(cmd.ticketId, cmd.newStatus, cmd.oldStatus);
        } else {
          console.warn(`[orchestrator] Unknown command source "${cmd.source}" — dropping`);
        }
      } catch (err) {
        // FIFO: stop at the first failure and fail everything behind it too —
        // processing a later command past a failed one would break the very
        // per-group ordering this queue exists to provide.
        console.error(`[orchestrator] Command failed (will retry):`, err);
        for (let j = i; j < event.Records.length; j++) {
          batchItemFailures.push({ itemIdentifier: event.Records[j].messageId });
        }
        break;
      }
    }
    return { batchItemFailures };
  }

  // Direct invocation from Jira webhook (legacy path — installs without the
  // command queue; see WORKFLOW_COMMAND_QUEUE_URL on the app)
  if (event.source === "jira-webhook") {
    if (TICKET_PROVIDER !== "jira") {
      console.log(`[orchestrator] Ignoring Jira webhook — TICKET_PROVIDER=${TICKET_PROVIDER}, using DDB stream`);
      return;
    }
    console.log(`[orchestrator] Jira webhook: ${event.ticketId} → ${event.newStatus}`);
    await processStatusChange(event.ticketId, event.newStatus, event.oldStatus);
    return;
  }

  // DDB Stream invocation (TICKET_PROVIDER=dynamodb only)
  if (TICKET_PROVIDER === "jira") {
    console.log(`[orchestrator] Ignoring DDB stream — TICKET_PROVIDER=jira, using webhooks`);
    return;
  }

  console.log(`[orchestrator] Received ${event.Records.length} stream records`);

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error(`[orchestrator] Error processing record:`, err);
    }
  }
};

/**
 * Unified status change handler — called from both DDB stream and Jira webhook paths.
 */
async function processStatusChange(ticketId, newStatus, oldStatus) {
  if (newStatus === oldStatus) return;

  console.log(`[orchestrator] ${ticketId}: ${oldStatus || "NEW"} → ${newStatus}`);

  switch (newStatus) {
    case "done":
      await handleTicketDoneUnified(ticketId);
      break;
    case "blocked": {
      // A human-review gate moved to "blocked" = "Request changes". If the gate
      // is configured onReject:"rework", re-open the upstream work it reviewed.
      //
      // TEAM-3966 F2 (pin): handleReviewRejection is reached ONLY for a gate
      // whose assignee is "human:*" — here and in processRecord (the DDB-stream
      // twin). isHumanReviewGate() is a superset of this check, so inside the
      // handler `humanOrigin` is always true from a production trigger and the
      // release-manager-origin auto-approve branch is INTENTIONALLY unreachable
      // from any entry point (the blueprint never has the RM transition the
      // Merge Approval gate). Pinned by review-rejection.test.mjs.
      //
      // TEAM-4044: a gate's CREATION-TIME block is not a rejection. Every human
      // gate is created with blocked_by (its upstream chain), so the ticket
      // Lambda's initial status write is `todo → blocked` (Jira: create in To
      // Do, then transition) or an INSERT straight into blocked (DDB). That
      // transition used to be read as "Request changes": the Merge Approval
      // gate's creation reopened the Ship ticket and dispatched the release
      // manager at requirements time — on EVERY run (observed back to
      // 2026-08-31; wf c5y8xg/bwastu/trf22q on 2026-09-05). A real rejection
      // comes from a gate that was PRESENTED: ready/in_progress/in_review.
      if (isCreationTimeBlock(oldStatus)) {
        console.log(
          `[orchestrator] ${ticketId}: ${oldStatus || "NEW"} → blocked is the gate's creation-time ` +
            `dependency block, not a review rejection — ignoring.`
        );
        break;
      }
      const rejected = await getTicket(ticketId);
      if (rejected && isHumanAssignee(rejected.assignee)) {
        // TEAM-4120 FR-1: …and it must be a gate a human was actually ASKED
        // about, exactly once (no-op when GATE_STATE_GUARD is off).
        if (!(await gateRejectionAdmitted(rejected, oldStatus))) break;
        await handleReviewRejection(rejected);
      }
      break;
    }
    case "todo": {
      // Ticket created — track it immediately, then route accordingly
      const todoTicket = await getTicket(ticketId);
      if (!todoTicket) return;

      // Bug bootstrap: a top-level Bug filed directly in Jira (no parent, no workflow row)
      // is a workflow root. Provision the workflow + analyst sub-task here, mirroring
      // what /api/workflow/start does for the in-app/programmatic intake path.
      if (
        TICKET_PROVIDER === "jira" &&
        todoTicket.issueType === "Bug" &&
        !todoTicket.parentId &&
        !todoTicket.workflowId
      ) {
        await bootstrapBugWorkflow(todoTicket);
        return;
      }

      // Track in agentTasks at creation time (both paths)
      await trackTicketCreation(ticketId, todoTicket.assignee, todoTicket.workflowId, todoTicket.parentId, todoTicket.spawnedBy);

      // TEAM-4121 FR-8: a fix ticket the ticket Lambda accepted under
      // FIX_TICKET_CONTRACT=shadow with fields missing carries
      // fixContract.warnings. Surface it on the run's event stream so the shadow
      // rollout is measurable from the UI instead of only from Lambda logs. Rides
      // the same creation-time hook as trackTicketCreation, so a ticket driven
      // back to `todo` later would re-emit — acceptable for an advisory (nothing
      // reads it as a count of tickets). Best-effort and non-fatal: an
      // unpublishable advisory must never block the ticket from being routed.
      await emitContractWarning(ticketId, todoTicket);

      if (TICKET_PROVIDER === "jira") {
        // Jira mode: the agentcore-hub-jira Lambda handles initial routing by transitioning
        // to "Ready" (no blockers) or "Blocked" (has blockers) AFTER creating links.
        // We do NOT auto-transition here — doing so races with the Lambda's link creation.
        // The "ready" webhook will arrive when the Lambda transitions the ticket.
        console.log(`[orchestrator] ${ticketId} → todo (Jira mode: waiting for Lambda to route)`);
      } else {
        // DynamoDB mode — todo with all blockers resolved means ready to go
        const blockers = todoTicket.blockedBy || [];
        const allBlockersResolved = blockers.length === 0 || await checkAllBlockersResolved(blockers);
        if (allBlockersResolved) {
          // ─── CANCEL GUARD (todo with no blockers) ───
          let guardWorkflow;
          try {
            guardWorkflow = await resolveWorkflow(todoTicket.workflowId, todoTicket.parentId);
          } catch (err) {
            console.error(`[orchestrator] GUARD: Failed to resolve workflow for ticket ${ticketId}:`, err);
            return; // Fail closed
          }
          if (!guardWorkflow || guardWorkflow.phase === "cancelled") {
            console.log(`[orchestrator] GUARD: ${ticketId} unblocked but workflow ${guardWorkflow?.id || "unknown"} is cancelled — skipping`);
            return;
          }
          // ─── END CANCEL GUARD ───
          await handleTicketReadyUnified(ticketId, todoTicket);
        }
      }
      break;
    }
    case "ready": {
      // Ticket is ready — invoke the agent
      const ticket = await getTicket(ticketId);
      if (!ticket) return;
      // ─── CANCEL GUARD (Jira webhook path) ───
      let guardWorkflow;
      try {
        guardWorkflow = await resolveWorkflow(ticket.workflowId, ticket.parentId);
      } catch (err) {
        console.error(`[orchestrator] GUARD: Failed to resolve workflow for ticket ${ticketId}:`, err);
        return; // Fail closed
      }
      if (!guardWorkflow || guardWorkflow.phase === "cancelled") {
        console.log(`[orchestrator] GUARD: Jira webhook for ${ticketId} ignored — workflow ${guardWorkflow?.id || "unknown"} is cancelled`);
        return;
      }
      // ─── END CANCEL GUARD ───
      await handleTicketReadyUnified(ticketId, ticket);
      break;
    }
    case "in_progress": {
      const ticket = await getTicket(ticketId);
      const assignee = ticket?.assignee;
      await publishEvent(ticketId, "agent.started", { ticketId, assignee, agentId: assignee });
      break;
    }
  }
}

/**
 * Unified "ticket done" handler — works with both DynamoDB and Jira backends.
 * Called from processStatusChange (Jira webhook path).
 *
 * Exported solely so done-handlers-cascade.test.mjs can drive the REAL handler
 * end-to-end through the REAL cascade (TEAM-3688). No behavior change.
 */
export async function handleTicketDoneUnified(ticketId) {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;

  const parentId = ticket.parentId;
  const workflowId = ticket.workflowId;
  const assignee = ticket.assignee;

  if (!parentId) {
    console.log(`[orchestrator] ${ticketId} has no parent — likely an epic. Skipping cascade.`);
    return;
  }

  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) {
    console.warn(`[orchestrator] No workflow found for ${ticketId}`);
    return;
  }

  // Playbook artifact-chain gate — the file must be on the branch before the
  // next stage may start. Returns true when the ticket was sent back.
  if (await enforceArtifactChain(ticket, workflow)) return;

  // Dedup guard: if we already processed this ticket's completion, skip cascade.
  // Protects against double-transition (agent calls transition_ticket AND report_completion).
  if (workflow.agentTasks?.[ticketId]?.status === "complete") {
    console.log(`[orchestrator] ${ticketId} already marked complete — skipping duplicate cascade.`);
    // TEAM-3976 — heal an evidence-less complete entry (mark_done landed before
    // report_completion) even when the run is not yet complete; fill-only-if-
    // missing, and completeWorkflow's own re-harvest then short-circuits.
    const prior = workflow.agentTasks[ticketId];
    const priorHasEvidence =
      (typeof prior?.output === "string" && prior.output.trim().length > 0) ||
      (typeof prior?.artifactKey === "string" && prior.artifactKey.length > 0);
    if (!priorHasEvidence) await harvestCompletionEvidence(workflow, ticketId);
    // TEAM-3974 — the cascade is a one-shot, but a human RE-deciding a gate is
    // not: re-Done'ing an escalation gate (a corrected DECISION comment, a
    // second approval) has to reach the parked release manager, or the human's
    // only lever silently does nothing. Both calls below are idempotent.
    await ackApprovedGateNotification(workflow, ticketId, assignee);
    await wakeHeldTicketAfterEscalationGate(workflow, ticketId, ticket.title, assignee, parentId);
    // TEAM-3985 — re-Done'ing any ticket is the human's deterministic "re-check
    // completion" lever (evidence that landed late, gate opt-out flipped).
    // Idempotent: completeWorkflow returns at once on a terminal phase.
    if (await isWorkflowComplete(parentId, workflow, assignee)) {
      await completeWorkflow(workflow);
    }
    return;
  }

  // Update agent task status — SCOPED write. A full-row put here races the
  // concurrent invocation claims of just-unblocked siblings and can resurrect
  // a pre-claim snapshot (double invocation).
  await markTaskComplete(workflow, ticketId, assignee);
  await ackApprovedGateNotification(workflow, ticketId, assignee);
  await emitReviewResolvedApproved(workflow, ticketId, assignee);
  await wakeHeldTicketAfterEscalationGate(workflow, ticketId, ticket.title, assignee, parentId);

  // Unblock dependents via the shared cascade (TEAM-3618 D3). The helper owns
  // the blocker predicate, provider branching, and orchestrator.unblocked
  // journal events — identical to the DDB-stream twin (handleTicketDone).
  //
  // TEAM-3684 Finding 1: guard the whole invocation. The cascade isolates
  // per-dependent errors internally, but an UNEXPECTED throw (e.g. getChildTickets
  // failing) must never skip the agent.complete publish or the completion check
  // below — otherwise a completed run could silently never be finalized. Treat a
  // cascade failure as "unblocked nothing" and proceed. (Symmetric with the
  // DDB-stream twin handleTicketDone.)
  let unblocked = [];
  try {
    unblocked = await getCascade().cascadeUnblock(ticketId, parentId, workflow);
  } catch (err) {
    console.error(`[orchestrator] cascade failed for ${ticketId} — publishing completion anyway: ${err?.message || err}`);
  }

  await publishEvent(ticketId, "agent.complete", { ticketId, assignee, agentId: assignee, unblocked, workflowId: workflow?.id });

  // TEAM-4113 — observe the per-phase rework loop (no-op when off / non-fix).
  await observeReworkLoop(workflow, ticket);
  // TEAM-4121 FR-9 — re-verify a live-evidence fix at the new head (no-op when
  // off / non-fix). Runs AFTER harvestCompletionEvidence (markTaskComplete
  // above), so agentTasks already carries the harvested commitSha.
  if (LIVE_REVERIFY !== "off") await observeLiveReverify(workflow, ticket);

  // Always check workflow completion — the last ticket to close triggers this
  if (await isWorkflowComplete(parentId, workflow, assignee)) {
    await completeWorkflow(workflow);
  }
}

/** Whether an assignee refers to a human reviewer (review gate) vs an agent. */
function isHumanAssignee(assignee) {
  return typeof assignee === "string" && assignee.startsWith("human:");
}

// Release-manager convergence escalation gate. The summary shape is fixed by
// blueprints/release-manager.md ("Escalation gate ticket", step c); the
// transition API and the Telegram bot match the same shape.
const ESCALATION_GATE_TITLE = /^Escalation #\d+: ship-review not converging/i;
const RELEASE_MANAGER_AGENT = "agentcore_hub_release_manager";
// TEAM-4120 FR-3 — the escalation tree's park gate. The captures ARE the wake
// payload: m[1] = the held ticket, m[2] = the agent that died on it. Shape fixed
// by dead-session-escalation.mjs park() (keep the two in sync).
const DEAD_SESSION_GATE_TITLE = /^Escalation: dead session on (\S+) \((.+)\)$/i;

/**
 * TEAM-3971 — a human just Done'd a release-manager escalation gate. Nothing
 * depends on that gate (its blocked_by is deliberately empty), so until now the
 * parked release manager sat until a human hand-nudged it with force — the
 * "I approved and it still just sits there" class. Wake it deterministically:
 * the human decided, so the RM's dead-session retry budget resets (its next
 * silence is a new episode); its parked claim is taken over unless the lease is
 * live (a live RM reads the DECISION itself); then it is re-driven through the
 * normal path — Jira: hop the ticket to Ready so the ready webhook dispatches
 * via the claim CAS (the steal flipped the task to ready, so the claim wins);
 * DDB: re-dispatch directly. Best-effort: any failure logs and leaves the
 * reconcile sweep as the backstop.
 */
async function wakeHeldTicketAfterEscalationGate(workflow, gateTicketId, gateTitle, assignee, parentId) {
  if (!isHumanAssignee(assignee)) return false;
  // TEAM-4120 FR-3 — a dead-session park gate names the ticket it holds in its
  // own title, so the wake needs no sibling search: reset that ticket's retry
  // budget, announce the decision, and let the gate's OWN done cascade unblock it
  // (the gate is in the held ticket's blockedBy). Deliberately NO direct
  // re-dispatch: this module never invokes an agent (R3), and a second dispatch
  // path here would race the cascade's.
  const dead = DEAD_SESSION_GATE_TITLE.exec(gateTitle || "");
  if (dead) {
    const heldId = dead[1];
    const heldAgent = dead[2];
    try {
      await store.resetDeadSessionRetry(workflow.id, heldId);
      await publishEvent(heldId, "orchestrator.escalation_decided", {
        workflowId: workflow.id, gateTicketId, ticketId: heldId, agentId: heldAgent,
      });
      // Jira fallback: on a board whose Blocked→Ready hop needs a stop at To Do,
      // the cascade's single transition can leave the ticket sitting in Blocked.
      // Re-read AFTER the cascade has had its turn and hop it only if it is.
      if (TICKET_PROVIDER === "jira") {
        const held = await getTicket(heldId);
        if (held?.status === "blocked") {
          const woke = (await jiraTransition(heldId, "Ready"))
            || ((await jiraTransition(heldId, "To Do")) && (await jiraTransition(heldId, "Ready")));
          console.log(`[orchestrator] ${gateTicketId}: dead-session gate done — ${heldId} still blocked, hop ${woke ? "succeeded" : "failed (reconcile sweep is the backstop)"}`);
        }
      }
      console.log(`[orchestrator] ${gateTicketId}: dead-session gate done — ${heldId} retry budget reset, unblocked by the gate's own cascade`);
      return true;
    } catch (err) {
      console.warn(`[orchestrator] ${gateTicketId}: dead-session wake failed (non-fatal): ${err?.message || err}`);
      return false;
    }
  }
  if (!ESCALATION_GATE_TITLE.test(gateTitle || "")) return false;
  try {
    const siblings = await getChildTickets(parentId);
    const rm = (siblings || []).find(
      (s) => s.assignee === RELEASE_MANAGER_AGENT && !["done", "cancelled"].includes(s.status)
    );
    if (!rm) {
      console.log(`[orchestrator] ${gateTicketId}: escalation gate done but no open release-manager ticket under ${parentId} — nothing to wake`);
      return false;
    }
    await store.resetDeadSessionRetry(workflow.id, rm.ticketId);
    const task = workflow.agentTasks?.[rm.ticketId];
    const lastActivity = await lastAgentActivity(ddb, EVENTS_TABLE, workflow.id, rm.assignee, rm.ticketId);
    if (task && isLeaseLive(task, lastActivity, Date.now())) {
      console.log(`[orchestrator] ${gateTicketId}: escalation gate done — release manager ${rm.ticketId} lease is live; it reads the DECISION itself`);
      return false;
    }
    if (task?.startedAt) {
      await stealClaim(ddb, WORKFLOWS_TABLE, workflow.id, rm.ticketId, task.startedAt);
    }
    await publishEvent(rm.ticketId, "orchestrator.escalation_decided", {
      workflowId: workflow.id, gateTicketId, ticketId: rm.ticketId, agentId: rm.assignee,
    });
    let woke = false;
    if (TICKET_PROVIDER === "jira") {
      woke = (await jiraTransition(rm.ticketId, "Ready"))
        || ((await jiraTransition(rm.ticketId, "To Do")) && (await jiraTransition(rm.ticketId, "Ready")));
    }
    if (!woke) woke = await redispatchTicket(workflow, rm);
    console.log(`[orchestrator] ${gateTicketId}: escalation gate done — release manager ${rm.ticketId} ${woke ? "re-driven" : "NOT re-driven (reconcile sweep is the backstop)"}`);
    return woke;
  } catch (err) {
    console.warn(`[orchestrator] ${gateTicketId}: release-manager wake failed (non-fatal): ${err?.message || err}`);
    return false;
  }
}

/**
 * A human review gate went "done" = the reviewer APPROVED. Close the gate's open
 * review_needed notification. The watch scheduler (lambda/workflow-analyzer
 * parkedOnHuman) skips any run with an open review_needed, and until TEAM-3966
 * the approve path never acked — handleReviewRejection (the CHANGES-NEEDED twin)
 * was the ONLY caller of store.ackNotifications — so every approved gate muted
 * its run from the Workflow Manager for the rest of its life (RCA 2026-09-04:
 * 4 of 5 live runs unwatched, all three review_needed gates already done).
 * Best-effort: an ack failure must never block the done cascade.
 */
async function ackApprovedGateNotification(workflow, ticketId, assignee) {
  if (!isHumanAssignee(assignee)) return;
  try {
    await store.ackNotifications(
      workflow.id,
      (n) => n.ticketId === ticketId && n.type === "review_needed"
    );
    // TEAM-4120 FR-1: close the gate's cycle as APPROVED. Without this the gate
    // would sit in `requested` forever, so a later creation-time-ish `→ blocked`
    // on an already-decided gate would still read as a fresh rejection. Same
    // best-effort contract as the ack above (an approve must never be blocked by
    // a ledger write); no-op when the guard is off.
    if (GATE_STATE_GUARD !== "off") {
      await store.markGateApproved(workflow.id, ticketId, new Date().toISOString(), {
        requestedAt: workflow.gateStates?.[ticketId]?.requestedAt,
      });
    }
    console.log(`[orchestrator] ${ticketId}: human gate approved — review_needed acknowledged`);
  } catch (err) {
    console.warn(`[orchestrator] ${ticketId}: review_needed ack failed (non-fatal): ${err?.message || err}`);
  }
}

/**
 * TEAM-4167 D3 (FR-3.2): emit the ONE canonical review.resolved(approved) for a
 * human gate that resolved by approval. Called ONLY from the FRESH done-cascade
 * paths (never the re-Done idempotent replay), so each gate completion emits
 * exactly once. An advisory auto-approve reaches here too and correctly surfaces
 * as review.resolved(approved) alongside the existing review.approved_with_advisory.
 * A ship gate on a HANDOFF run is suppressed: it never had a human to approve —
 * skipShipGateForHandoff resolved it and owns the review.resolved(skipped) emit,
 * so emitting "approved" as well would double-count the same completion.
 * Best-effort: an emit failure must never block the done cascade.
 */
async function emitReviewResolvedApproved(workflow, ticketId, assignee) {
  if (!isHumanAssignee(assignee)) return;
  try {
    await loadCdRegistry();
    if (!isCdRegistered(_cdRegistry, workflow.repoConfig)) {
      const phase = await gatePhaseOf(ticketId);
      if (SHIP_PHASES.has(phase)) return; // handoff skip owns the "skipped" emit
    }
    await publishEvent(
      ticketId,
      "review.resolved",
      buildReviewResolved({ workflowId: workflow.id, ticketId, assignee, outcome: "approved", now: new Date().toISOString() })
    );
  } catch (err) {
    console.warn(`[orchestrator] ${ticketId}: review.resolved(approved) emit failed (non-fatal): ${err?.message || err}`);
  }
}

/**
 * TEAM-4167 D3 (FR-3.2): emit the canonical review.resolved(rejected) for a
 * human gate whose reviewer requested changes. Called alongside the terminal
 * review.rejected emits in handleReviewRejection (hold, cap-escalated, rework
 * re-open) — NOT the advisory auto-approve path, which resolves the gate to
 * done and is already covered by review.resolved(approved). Human-origin only;
 * best-effort (a failed emit must never block the rejection handling).
 */
async function emitReviewResolvedRejected(workflow, gateTicket) {
  if (!isHumanAssignee(gateTicket?.assignee)) return;
  try {
    await publishEvent(
      gateTicket.ticketId,
      "review.resolved",
      buildReviewResolved({ workflowId: workflow.id, ticketId: gateTicket.ticketId, assignee: gateTicket.assignee, outcome: "rejected", now: new Date().toISOString() })
    );
  } catch (err) {
    console.warn(`[orchestrator] ${gateTicket.ticketId}: review.resolved(rejected) emit failed (non-fatal): ${err?.message || err}`);
  }
}

/**
 * Atomically claim a ticket for invocation via a conditional write on
 * agentTasks[ticketId].status in the WORKFLOWS table. This is the ONE
 * invocation lock that works in both ticket providers — Jira transitions are
 * not atomic and concurrent webhook deliveries race straight through them —
 * the root cause of duplicate agent sessions and duplicate PRs (observed: the
 * same ticket invoked 3× within 3 seconds during a fix-ticket fan-out burst).
 *
 * Returns true when this caller won the claim; false when another invocation
 * already holds it (status=running). Sets status=running + startedAt in the
 * same write, so no follow-up save is needed for the task entry itself.
 */
/**
 * Mark a ticket's agentTasks entry complete with per-key writes (never a full
 * row put — completion cascades run concurrently with sibling claims).
 *
 * TEAM-3755 F3 — INVARIANT: a ticket-level "done" is NOT a lifecycle verdict.
 *
 * This function deliberately marks the task complete unconditionally, even when
 * the harvested completion record carries a SHIP_BLOCKED outcome
 * (deploy-blocked / static-ci-only). That is by design, not an oversight:
 *
 *   - A ticket status is the AGENT's report that its turn is over. The CD agent
 *     genuinely finished — it ran, it found the deploy blocked, and it said so.
 *     Diverting the ticket to a non-done status here would strand the run: the
 *     unblock cascade keys off `done` to release dependents, and completion's
 *     per-phase check requires a done agent ticket in every required phase, so a
 *     "blocked" CD ticket would wedge the epic open forever instead of closing
 *     it honestly.
 *   - The RUN-level verdict is the single enforcement point (FR-D2.1/FR-D2.2).
 *     harvestCompletionEvidence (called on the line below) lifts outcome +
 *     blockReason + mergeCommit off the S3 completion record onto
 *     agentTasks[ticketId] BEFORE completeWorkflow re-reads them, so
 *     evaluateShipVerdict sees the block in the SAME pass that this done
 *     triggered, and completeWorkflow closes the run on the honest terminal
 *     phase (claimTerminalOutcome → "deploy-blocked") instead of "complete".
 *
 * So the guarantee is: ticket done + a SHIP_BLOCKED outcome ALWAYS yields a
 * blocked terminal workflow phase, never "complete". That is what makes the
 * unconditional mark safe, and it depends on two things staying true — the
 * harvest running before the completion check, and shipVerdictOf treating only a
 * mergeCommit/explicit "shipped" as proof (TEAM-3755 F1; commitSha is the
 * unmerged branch HEAD and must never count). Both are pinned by
 * lambda/orchestrator/ticket-done-blocked-terminal.test.mjs — if you change this
 * function, that suite is the contract to keep green.
 */
async function markTaskComplete(workflow, ticketId, assignee) {
  const now = new Date().toISOString();
  const entry = {
    ...(workflow.agentTasks?.[ticketId] || {
      id: `task_${Date.now()}_${assignee}`,
      agentId: assignee,
      ticketId,
      createdAt: now,
    }),
    status: "complete",
    completedAt: now,
  };
  // Field-scoped: the webhook's metadata merge (branch/prUrl/output) can land
  // between our read and this write — a whole-entry put would erase it.
  await store.completeTaskEntry(workflow.id, ticketId, entry);
  if (!workflow.agentTasks) workflow.agentTasks = {};
  workflow.agentTasks[ticketId] = entry;
  await harvestCompletionEvidence(workflow, ticketId);
}

/**
 * Harvest deliverable evidence into agentTasks[ticketId] from the completion
 * record the agent's report_completion already writes to S3
 * (completions/{ticketId}.json — summary/branch/commit_sha/pr_url).
 *
 * The completion evidence gate (TEAM-3690, completion.mjs missingEvidenceTickets)
 * requires agentTasks output/artifactKey, but the only other writer of those
 * fields — the agent_completion webhook's metadata merge — has no live caller,
 * so every gated run stranded non-terminal with CompletionRejectedMissingEvidence
 * (first observed: wf coc7es/TEAM-3611). This closes the loop on the done
 * cascade itself: runs before completeWorkflow's fresh agentTasks re-read, so
 * the gate sees it in the same pass.
 *
 * Fills only when the entry has no evidence yet (a webhook merge that DID land
 * wins), and never throws — a missing record (human gates, legacy tickets)
 * just means the gate won't see harvested evidence for this ticket.
 */
async function harvestCompletionEvidence(workflow, ticketId) {
  if (!ARTIFACT_BUCKET) return;
  const entry = workflow.agentTasks?.[ticketId];
  const hasEvidence =
    (typeof entry?.output === "string" && entry.output.trim().length > 0) ||
    (typeof entry?.artifactKey === "string" && entry.artifactKey.length > 0);
  // TEAM-3747 D2: the ship/CD merge-verdict gate needs the merge commit / outcome
  // signals, and a ship ticket almost ALWAYS has a summary (so hasEvidence is
  // true). Harvesting must therefore run when EITHER the deliverable evidence OR
  // the ship-verdict signal is still absent — a plain `if (hasEvidence) return`
  // would starve the ship gate and false-block every shipped run.
  const hasShipSignal =
    (typeof entry?.mergeCommit === "string" && entry.mergeCommit.trim().length > 0) ||
    (typeof entry?.commitSha === "string" && entry.commitSha.trim().length > 0) ||
    (typeof entry?.outcome === "string" && entry.outcome.trim().length > 0);
  if (hasEvidence && hasShipSignal) return;
  try {
    // Shared per-invocation read (TEAM-4121 FR-9): the live-reverify hook needs
    // the same record moments later, and one GET serves both.
    const record = await readCompletionRecord(ticketId);
    if (!record) {
      console.warn(`[orchestrator] evidence harvest skipped for ${ticketId}: no readable completions/${ticketId}.json`);
      return;
    }
    const fields = {};
    // Deliverable evidence — only fill when absent (a webhook metadata merge that
    // DID land wins), exactly as before.
    if (!hasEvidence) {
      const summary = typeof record.summary === "string" ? record.summary.trim() : "";
      if (summary) fields.output = summary.slice(0, 10000);
      if (record.branch) fields.branch = record.branch;
    }
    // Ship/CD verdict signals — harvested regardless of deliverable evidence,
    // each filled only when the entry doesn't already carry it (additive; legacy
    // records simply lack these keys). commit_sha/pr_url kept here too so the
    // ship gate + the final PR label can find them.
    if (record.commit_sha && !entry?.commitSha) fields.commitSha = record.commit_sha;
    if (record.pr_url && !entry?.prUrl) fields.prUrl = record.pr_url;
    if (record.merge_commit && !entry?.mergeCommit) fields.mergeCommit = record.merge_commit;
    if (typeof record.outcome === "string" && !entry?.outcome) {
      const oc = record.outcome.trim().toLowerCase();
      if (SHIP_BLOCKED_OUTCOMES.includes(oc) || oc === "shipped") fields.outcome = oc;
    }
    if (record.block_reason && !entry?.blockReason) {
      fields.blockReason = String(record.block_reason).slice(0, 500);
    }
    if (Object.keys(fields).length === 0) return;
    await store.mergeTaskMetadata(workflow.id, ticketId, fields);
    if (entry) Object.assign(entry, fields);
  } catch (err) {
    console.warn(`[orchestrator] evidence harvest skipped for ${ticketId}: ${err?.message || err}`);
  }
}

async function claimTicketInvocation(workflow, ticketId, assignee) {
  const now = new Date().toISOString();
  const taskId = workflow.agentTasks?.[ticketId]?.id || `task_${Date.now()}_${assignee}`;
  // Stale-claim escape hatch: a claim older than this is a crashed session, not
  // a live one — a human moving the ticket back to Ready on the board must be
  // able to re-dispatch without the retry endpoint. 2× the lease TTL (R3):
  // same knob as the lease-aware retry/dispatch endpoints, doubled because
  // this path has no activity signal — only the claim's age.
  const ttlMinutes = Number(process.env.WORKFLOW_LEASE_TTL_MINUTES);
  const leaseTtlMs = (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : DEFAULT_TTL_MINUTES) * 60_000;
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MULTIPLIER * leaseTtlMs).toISOString();
  // TEAM-3698: drop any deadSessionDetectedAt from the PRIOR generation — this
  // is a new claim (new startedAt), so a stamp carried over would make the
  // dead-session detector skip it as "already handled" forever. The store
  // strips it on the write too (R2, sole writer); this keeps the in-memory
  // snapshot handed back to the caller honest.
  const { deadSessionDetectedAt: _priorStamp, ...priorEntry } = workflow.agentTasks?.[ticketId] || {};
  const entry = {
    ...priorEntry,
    id: taskId,
    agentId: assignee,
    ticketId,
    status: "running",
    startedAt: now,
  };
  const claimed = await store.claimInvocation(workflow.id, ticketId, entry, staleBefore);
  if (claimed) {
    if (!workflow.agentTasks) workflow.agentTasks = {};
    workflow.agentTasks[ticketId] = entry;
  }
  return claimed;
}

/**
 * A review-gate ticket became ready (its upstream work is done). Instead of
 * invoking an agent, park it for a human and emit a review_needed notification.
 * The ticket sits in "in_review"; downstream tickets that list it in blockedBy
 * stay blocked until a person transitions it to "done" (approve) — the existing
 * cascade then continues. Returns true if the ticket was handled as a gate.
 */
// ─── CD HANDOFF (cd-registry.mjs) ─────────────────────────────────────────────
// A repo outside the CD registry never gets a ship phase: the intake agent is
// told not to plan Ship/Merge Approval/CD tickets, and these guards make that
// deterministic — a ship-phase agent ticket or a ship-phase human gate that
// exists anyway (older run, model drift, hand-made ticket) is resolved Done with
// an explanatory comment instead of being dispatched or paged. Done feeds the
// normal cascade, so the run still completes and gets its handoff PR.

function handoffNote(workflow, what) {
  const url = workflow.repoConfig?.repos?.[0]?.url || "this repo";
  return (
    `Resolved by the orchestrator — CD handoff.\n` +
    `${url} is not in the hub's CD registry, so the hub does not merge or deploy it; ` +
    `this ${what} does not apply. The run completes once review/QA/CI are done and the ` +
    `unified PR is left OPEN for the owning team to merge and deploy.`
  );
}

/**
 * Provider-agnostic ticket status write (TEAM-4120 FR-3). Same two branches every
 * other status write in this file uses — Jira transitions by display name, the
 * DDB board writes the lowercase status; the ensuing webhook/stream is what
 * drives the normal done handlers, which is exactly what the escalation tree's
 * synthesize-from-completion-record path wants (it must NOT write agentTasks
 * itself; markTaskComplete → harvestCompletionEvidence owns that).
 */
async function transitionTicketStatus(ticketId, status) {
  if (TICKET_PROVIDER === "jira") {
    const display = { done: "Done", ready: "Ready", blocked: "Blocked", todo: "To Do" }[status] || status;
    return await jiraTransition(ticketId, display);
  }
  await ddb.send(new UpdateCommand({
    TableName: TICKETS_TABLE,
    Key: { ticketId },
    UpdateExpression: "SET #s = :s, #u = :u",
    ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
    ExpressionAttributeValues: { ":s": status, ":u": new Date().toISOString() },
  }));
  return true;
}

async function resolveTicketAsHandoff(ticketId, workflow, note, detail) {
  console.log(`[orchestrator] ${ticketId}: CD handoff — ${detail.kind} on unregistered repo resolved Done (workflow ${workflow.id})`);
  try { await commentOnTicket(ticketId, note); }
  catch (err) { console.warn(`[orchestrator] handoff comment on ${ticketId} failed: ${err.message}`); }
  if (TICKET_PROVIDER === "jira") {
    await jiraTransition(ticketId, "Done");
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #s = :s, #u = :u",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ":s": "done", ":u": new Date().toISOString() },
    }));
  }
  await publishEvent(ticketId, "cd.handoff_skip", { ticketId, workflowId: workflow.id, ...detail });
}

/** Ship-phase AGENT ticket on a HANDOFF run → resolved, not dispatched. */
async function skipShipTicketForHandoff(ticketId, agentDef, workflow) {
  if (!SHIP_PHASES.has(agentDef?.phase)) return false;
  await loadCdRegistry();
  if (isCdRegistered(_cdRegistry, workflow.repoConfig)) return false;
  await resolveTicketAsHandoff(
    ticketId, workflow,
    handoffNote(workflow, `ship-phase ticket (${agentDef.agentId})`),
    { kind: "ship_ticket", assignee: agentDef.agentId, phase: agentDef.phase }
  );
  return true;
}

/** Ship-phase HUMAN gate (Merge Approval) on a HANDOFF run → resolved, not paged. */
async function skipShipGateForHandoff(ticketId, workflow) {
  await loadCdRegistry();
  if (isCdRegistered(_cdRegistry, workflow.repoConfig)) return false;
  const phase = await gatePhaseOf(ticketId);
  if (!SHIP_PHASES.has(phase)) return false;
  await resolveTicketAsHandoff(
    ticketId, workflow,
    handoffNote(workflow, "merge-approval gate"),
    { kind: "ship_gate", phase }
  );
  // TEAM-4167 D3 (FR-3.2): this human gate resolved WITHOUT a human — the
  // canonical review.resolved for it is "skipped". Emitted here (the resolution
  // origin) so the ensuing Done cascade suppresses its "approved" emit and the
  // gate produces exactly one review.resolved.
  const gate = await getTicket(ticketId).catch(() => null);
  await publishEvent(
    ticketId,
    "review.resolved",
    buildReviewResolved({ workflowId: workflow.id, ticketId, assignee: gate?.assignee, outcome: "skipped", now: new Date().toISOString() })
  );
  return true;
}

/** The agent phase a human gate guards = the phase of the tickets it is blockedBy. */
async function gatePhaseOf(gateTicketId) {
  try {
    const gate = await getTicket(gateTicketId);
    for (const upId of gate?.blockedBy || []) {
      const up = await getTicket(upId);
      const def = up && getAgentDef(up.assignee);
      if (def?.phase) return def.phase;
    }
  } catch (err) {
    console.warn(`[orchestrator] gatePhaseOf(${gateTicketId}) failed: ${err.message}`);
  }
  return undefined;
}

/**
 * Playbook artifact-chain gate. For a ticket that owes a chain artifact
 * (artifact-chain.mjs requiredArtifactsForTicket) verify each file exists on the
 * run's shared feature branch via the GitHub contents API. Missing → the ticket
 * is moved back to Blocked with a comment naming the path, a resume note is
 * stashed for the re-dispatch, and `artifact_chain.missing` is published; the
 * cascade does NOT run. Fail-open on GitHub errors other than 404 (a rate limit
 * must not wedge a run), and a no-op for defs without a chain, for runs with no
 * shared branch yet, and when ARTIFACT_CHAIN_GATE=off. Returns true when the
 * caller must stop (ticket sent back).
 */
async function enforceArtifactChain(ticket, workflow) {
  if (ARTIFACT_CHAIN_GATE === "off" || !ticket || !workflow) return false;
  const wfDef = getEffectiveWorkflowDef(workflow);
  if (!chainFor(wfDef)) return false;
  const agentDef = getAgentDef(ticket.assignee);
  const required = requiredArtifactsForTicket({ def: wfDef, ticket, agentDef, intakeAgentId: wfDef.intakeAgentId });
  if (required.length === 0) return false;
  const branch = workflow.featureBranch;
  if (!branch || !workflow.repoConfig?.repos?.length) {
    console.warn(`[orchestrator] artifact-chain: ${ticket.ticketId} owes ${required.join(",")} but the run has no shared branch — cannot verify, passing.`);
    return false;
  }
  let owner, repo;
  try { ({ owner, repo } = parseRepoUrl(workflow.repoConfig)); } catch { return false; }
  const missing = [];
  for (const name of required) {
    const path = artifactRepoPath(wfDef, workflow.id, name);
    try {
      await githubApi(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    } catch (err) {
      if (err?.status === 404) { missing.push(name); continue; }
      console.warn(`[orchestrator] artifact-chain: GitHub check failed for ${path}@${branch} (${err?.message}) — passing open.`);
    }
  }
  if (missing.length === 0) {
    await publishEvent(ticket.ticketId, "artifact_chain.verified", {
      ticketId: ticket.ticketId, workflowId: workflow.id, artifacts: required, branch,
    });
    return false;
  }
  const dir = chainDir(wfDef, workflow.id);
  const note = missingArtifactNote({ missing, dir, branch });
  console.warn(`[orchestrator] artifact-chain: ${ticket.ticketId} missing ${missing.join(",")} on ${branch} — sending back.`);
  try { await store.setResumeContext(workflow.id, ticket.ticketId, note); } catch (err) { console.warn(`[orchestrator] artifact-chain: resume note failed: ${err.message}`); }
  try { await commentOnTicket(ticket.ticketId, note); } catch (err) { console.warn(`[orchestrator] artifact-chain: comment failed: ${err.message}`); }
  try {
    if (TICKET_PROVIDER === "jira") {
      const moved = (await jiraTransition(ticket.ticketId, "Blocked")) || (await jiraTransition(ticket.ticketId, "To Do"));
      if (!moved) console.warn(`[orchestrator] artifact-chain: could not re-open ${ticket.ticketId}`);
    } else {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId: ticket.ticketId },
        UpdateExpression: "SET #s = :s, #u = :u",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":s": "blocked", ":u": new Date().toISOString() },
      }));
    }
  } catch (err) {
    console.warn(`[orchestrator] artifact-chain: re-open failed for ${ticket.ticketId}: ${err.message}`);
  }
  // Release the invocation claim so the re-dispatch (Blocked → Ready) can claim
  // again: claimInvocation's CAS admits any status other than "running".
  try { await store.setTaskStatus(workflow.id, ticket.ticketId, "blocked"); } catch { /* entry may not exist yet */ }
  await publishEvent(ticket.ticketId, "artifact_chain.missing", {
    ticketId: ticket.ticketId, workflowId: workflow.id, missing, branch, dir, assignee: ticket.assignee,
  });
  return true;
}

async function handleHumanReviewGate(ticketId, assignee, workflow) {
  const reviewer = assignee.slice("human:".length);

  // CD HANDOFF: a Merge Approval gate on a repo the hub does not deploy has
  // nothing to approve — nobody here merges. Resolve it instead of paging a human.
  if (workflow && (await skipShipGateForHandoff(ticketId, workflow))) return false;

  // Park the ticket in "in_review" (idempotent — setting it again is a no-op).
  if (TICKET_PROVIDER === "jira") {
    await jiraTransition(ticketId, "In Review");
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #s = :s, #u = :u",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ":s": "in_review", ":u": new Date().toISOString() },
    }));
  }

  // Idempotency is tracked on the SIDE EFFECT (the notification), not the ticket
  // status — the status write and the notification aren't atomic, so a redelivery
  // after a status-write-but-save-failure must still create the missing one.
  // Only notify when no unacknowledged review_needed already exists.
  //
  // TEAM-3684 Finding 2: the open-notification check + append must be ATOMIC, not
  // a scan of the passed-in (possibly stale) snapshot. Concurrent last-blocker
  // completions re-wake the same gate from separate stale copies; the store's
  // appendReviewNotificationOnce runs the check under the notifVersion CAS so
  // exactly one caller appends. It returns whether THIS call notified, which the
  // cascade's re-wake uses to publish review.reawakened at most once.
  let notified = false;
  if (workflow) {
    // Review package: the upstream agent that closed the phase wrote a curated
    // summary/bullets/links file (blueprints/review-package.md). Best-effort —
    // a missing or malformed package must never delay the gate ping.
    let pkg = await loadReviewPackage(workflow, ticketId);

    // CI uncertifiable (TEAM-4122 FR-5, enforce only): the approver about to
    // click Merge is the LAST person who can catch "no CodeBuild build ever
    // existed for this head". Prefixing the package here reaches all three
    // surfaces at once — the phone notification (`details` is pkg.summary), the
    // in-app card, and the comment mirrored onto the gate ticket below. Pure
    // rewrite, no extra call: the verdict was already probed at dispatch.
    if (CI_CHECK_MODE === "enforce" && workflow?.ciCheck?.verdict === "uncertifiable") {
      pkg = prefixCiWarning(pkg, workflow.ciCheck);
    }

    const notification = {
      id: `notif_${ticketId}_${new Date().toISOString()}`,
      type: "review_needed",
      title: `Review needed: ${ticketId}`,
      details: pkg?.summary || `Ticket ${ticketId} is awaiting review by ${reviewer}.`,
      ticketId,
      reviewer,
      // TEAM-4166 §2.4: the FULL human:* assignee, so the analyzer's parkedOnHuman
      // parks on this gate only when a human genuinely owns it (a bare agent-side
      // notification lacking a human assignee must not silence the watchdog).
      humanAssignee: assignee,
      ...(pkg ? { summary: pkg.summary, bullets: pkg.bullets, links: pkg.links, gate: pkg.gate } : {}),
      timestamp: new Date().toISOString(),
      acknowledged: false,
    };
    notified = await store.appendReviewNotificationOnce(workflow.id, ticketId, notification);
    if (notified && Array.isArray(workflow.humanNotifications)) {
      workflow.humanNotifications.push(notification); // keep the in-memory copy consistent
    }
    if (!notified) {
      console.log(`[orchestrator] ${ticketId} already has an open review notification — skipping duplicate.`);
      return false;
    }

    // Mirror the package onto the gate ticket so the dashboard reviewer sees
    // the same context when they open it (Jira: comment; DDB: comment row).
    // Only the caller that actually appended attaches — a losing CAS racer
    // returned above, so redeliveries can't double-comment the ticket.
    if (pkg) {
      try { await attachPackageToTicket(ticketId, pkg); }
      catch (err) { console.warn(`[orchestrator] could not attach review package to ${ticketId}: ${err.message}`); }
    }
  }

  // TEAM-4120 FR-1: record that this gate is now PENDING A HUMAN — the state the
  // reject path checks before believing a `→ blocked` is a "Request changes".
  // Every way a gate reaches a human passes through here (the Ready path, the
  // park, the cascade's re-wake), so this is the ONE place the cycle opens.
  // Idempotent in the store (CAS on state <> "requested"), best-effort here: a
  // failed write must never delay the reviewer's ping — the guard's fallback is
  // the review_needed notification this function just appended.
  if (GATE_STATE_GUARD !== "off" && workflow) {
    try {
      await store.markGateRequested(workflow.id, ticketId, new Date().toISOString());
    } catch (err) {
      console.warn(`[gate-state] markGateRequested(${ticketId}) failed (non-fatal): ${err?.message || err}`);
    }
  }

  await publishEvent(ticketId, "review.needed", {
    ticketId, reviewer, workflowId: workflow?.id,
  });
  console.log(`[orchestrator] ${ticketId} parked for human review (${reviewer}) — not invoking an agent.`);
  return notified;
}

/**
 * Load the review package the pre-gate agent wrote for this gate
 * (shared/review-package-<phase>.json). The gate's phase comes from the agent
 * tickets it is blockedBy — same resolution as handleReviewRejection. Returns
 * a validated {gate, summary, bullets, links} or null; never throws.
 */
async function loadReviewPackage(workflow, gateTicketId) {
  try {
    const gateTicket = await getTicket(gateTicketId);
    // Playbook gates first: the Plan Approval gate is blocked by a DEV ticket
    // (phase "development") but reads the plan package; the Intent Acceptance
    // gate has no agent blockers at all (the hub created it).
    let phase = fallbackReviewPackagePhase(gateTicket);
    if (phase === undefined || phase === "intake") {
      for (const upId of gateTicket?.blockedBy || []) {
        const up = await getTicket(upId);
        const def = up && getAgentDef(up.assignee);
        if (def?.phase) { phase = def.phase; break; }
      }
    }
    // Playbook defs ONLY: the Plan Approval gate is blocked by a DEV ticket
    // (phase "development") but reads the plan package, and the Intent
    // Acceptance gate has no agent blockers at all (the hub created it). Other
    // defs keep the blocker walk untouched — software-delivery's opt-in "Plan
    // Approval" gate (after design) must still merge the designer packages.
    if (chainFor(getEffectiveWorkflowDef(workflow))) {
      const fallback = fallbackReviewPackagePhase(gateTicket);
      if (fallback === "plan" || (fallback === "intake" && !phase)) phase = fallback;
    }
    if (!phase || !ARTIFACT_BUCKET) return null;

    // Parallel pre-gate agents (design) each write their own
    // review-package-<phase>.<agentId>.json — read-merge-write on one shared
    // object would lose updates. Merge every matching file here instead.
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: ARTIFACT_BUCKET,
      Prefix: `workflows/${workflow.id}/shared/review-package-${phase}`,
    }));
    const keys = (listed.Contents || [])
      .map((o) => o.Key)
      .filter((k) => k.endsWith(".json"))
      .sort(); // deterministic merge order across redeliveries
    const parts = [];
    for (const key of keys) {
      const raw = await readS3Artifact(workflow.id, key.replace(`workflows/${workflow.id}/`, ""));
      if (!raw) continue;
      try {
        const p = JSON.parse(raw);
        if (typeof p.summary === "string" && p.summary.trim()) parts.push(p);
      } catch { /* one malformed part must not sink the rest */ }
    }
    if (!parts.length) return null;

    const merged = {
      summary: parts.map((p) => p.summary.trim()).join(" · "),
      bullets: parts.flatMap((p) => (Array.isArray(p.bullets) ? p.bullets : [])),
      links: parts.flatMap((p) => (Array.isArray(p.links) ? p.links : [])),
    };
    // Clamp to the contract so a rambling agent can't flood the ping: bullets
    // are one-liners, links carry either an in-run artifactKey or an https url.
    // Multi-part merges get proportionally wider caps, still phone-sized.
    const maxBullets = Math.min(6 * parts.length, 10);
    const maxLinks = Math.min(4 * parts.length, 8);
    const seen = new Set();
    const bullets = merged.bullets
      .filter((b) => typeof b === "string" && b.trim())
      .map((b) => b.trim().slice(0, 200))
      .slice(0, maxBullets);
    const links = merged.links
      .filter((l) => l && typeof l.label === "string" &&
        (typeof l.url === "string" && /^https:\/\//.test(l.url) ||
         typeof l.artifactKey === "string" && l.artifactKey.startsWith(`workflows/${workflow.id}/`)))
      .map((l) => ({
        label: l.label.trim().slice(0, 60),
        ...(l.url ? { url: l.url } : { artifactKey: l.artifactKey }),
      }))
      .filter((l) => {
        const target = l.url || l.artifactKey;
        if (seen.has(target)) return false; // designers may all link the same shared doc
        seen.add(target);
        return true;
      })
      .slice(0, maxLinks);
    return { gate: phase, summary: merged.summary.slice(0, 500), bullets, links };
  } catch (err) {
    console.warn(`[orchestrator] review package load failed for ${gateTicketId}: ${err.message}`);
    return null;
  }
}

/** Post the review package onto the gate ticket as a comment (both providers). */
async function attachPackageToTicket(ticketId, pkg) {
  const lines = [
    `Review package — ${pkg.summary}`,
    ...pkg.bullets.map((b) => `• ${b}`),
    ...pkg.links.map((l) => `→ ${l.label}: ${l.url || l.artifactKey}`),
  ];
  const text = lines.join("\n");
  if (TICKET_PROVIDER === "jira") {
    await jiraFetch(`/rest/api/3/issue/${ticketId}/comment`, "POST", {
      body: {
        type: "doc", version: 1,
        content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
      },
    });
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #c = list_append(if_not_exists(#c, :empty), :n), #u = :u",
      ExpressionAttributeNames: { "#c": "comments", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":n": [{ id: `comment-${Date.now()}`, author: "orchestrator", content: text, timestamp: new Date().toISOString() }],
        ":empty": [],
        ":u": new Date().toISOString(),
      },
    }));
  }
}

/**
 * Post a plain-text comment on a ticket, either provider (TEAM-3756 F3b audit
 * trail). Same write shapes as attachPackageToTicket; throws to the caller —
 * every current caller treats the comment as best-effort and catches.
 */
async function commentOnTicket(ticketId, text) {
  const lines = String(text).split("\n");
  if (TICKET_PROVIDER === "jira") {
    await jiraFetch(`/rest/api/3/issue/${ticketId}/comment`, "POST", {
      body: {
        type: "doc", version: 1,
        content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
      },
    });
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #c = list_append(if_not_exists(#c, :empty), :n), #u = :u",
      ExpressionAttributeNames: { "#c": "comments", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":n": [{ id: `comment-${Date.now()}`, author: "orchestrator", content: String(text), timestamp: new Date().toISOString() }],
        ":empty": [],
        ":u": new Date().toISOString(),
      },
    }));
  }
}

/**
 * PR url for the change set under review (TEAM-3748 D3) — CONFIDENT matches
 * only (TEAM-3756 F2). Resolution order:
 *
 *   1. the gate ticket's own prUrl — the provider explicitly forwarded the PR
 *      this gate reviews;
 *   2. a task entry whose recorded head (commitSha/mergeCommit, harvested off
 *      the completion record) EQUALS the gate's reviewedHeadSha — that PR is
 *      the one whose head the reviewer looked at, by definition;
 *   3. the ship-phase ticket's PR (the integration PR the ship review is of),
 *      but only when it is UNAMBIGUOUS — exactly one distinct prUrl across the
 *      run's ship-phase task entries (reviewed-upstream ship entries preferred).
 *
 * The old "any task's prUrl" fallback is deliberately GONE: a stale per-ticket
 * feature-PR url harvested onto an upstream dev task could win over the actual
 * ship/integration PR, so the change set was computed from the WRONG diff —
 * genuine findings then classified out-of-diff and the reopen was suppressed.
 * Scoping against the wrong PR is strictly worse than not scoping at all:
 * returning "" fails OPEN (changeSet stays null → enforceDiffScope stays inert →
 * every finding gates), which can never suppress a genuine rework round.
 */
function resolvePrUrlForReview(workflow, gateTicket, upstream) {
  const direct =
    gateTicket.prUrl || gateTicket.metadata?.prUrl ||
    gateTicket.pr_url || gateTicket.metadata?.pr_url;
  if (typeof direct === "string" && direct) return direct;

  const tasks = workflow?.agentTasks || {};
  const upIds = new Set((upstream || []).map((u) => u.ticketId));
  const entries = Object.entries(tasks).filter(
    ([, e]) => e && typeof e.prUrl === "string" && e.prUrl
  );

  // 2. Head-SHA match — the PR whose recorded head IS what the reviewer reviewed.
  const reviewedHeadSha = gateTicket.reviewedHeadSha || gateTicket.metadata?.headSha || null;
  if (reviewedHeadSha) {
    for (const preferUpstream of [true, false]) {
      for (const [tid, e] of entries) {
        if (preferUpstream !== upIds.has(tid)) continue;
        if (e.commitSha === reviewedHeadSha || e.mergeCommit === reviewedHeadSha) return e.prUrl;
      }
    }
  }

  // 3. The ship ticket's integration PR — only when there is exactly one to name.
  for (const upstreamOnly of [true, false]) {
    const shipUrls = new Set();
    for (const [tid, e] of entries) {
      if (upstreamOnly && !upIds.has(tid)) continue;
      if (getAgentDef(e.agentId)?.phase === "ship") shipUrls.add(e.prUrl);
    }
    if (shipUrls.size === 1) return [...shipUrls][0];
    if (shipUrls.size > 1) break; // ambiguous even among upstream → widening can't help
  }

  return "";
}

/**
 * Compute the PR's change set — the `--name-status`-equivalent file list the
 * diff-scoped ship review scopes against (TEAM-3748 D3, FR-D3.1). This is the
 * "gate plumbing" release-manager.md Step 4 waits on: it lets the deterministic
 * enforceDiffScope activate so review is scoped to what the PR actually changed
 * instead of the whole assembled repo.
 *
 * FAIL-OPEN by contract (R4): a missing/unrecognized PR url or ANY GitHub error
 * returns null. A null change set is passed to enforce as undefined, which keeps
 * enforceDiffScope inert and the rework loop byte-identical to its pre-guard
 * behavior — the diff-scope gate must never be able to WEDGE a review, only
 * narrow it when the diff is knowable. Renames contribute BOTH paths, matching
 * enforceDiffScope's rename handling.
 */
async function computeReviewChangeSet(prUrl) {
  const m = String(prUrl || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const [, owner, repo, number] = m;
  try {
    const files = await callGitHub("list_pr_files", { owner, repo, pull_number: Number(number) });
    if (!Array.isArray(files) || files.length === 0) return null;
    const paths = [];
    for (const f of files) {
      if (typeof f?.filename === "string" && f.filename) paths.push(f.filename);
      // A rename cites both endpoints; enforceDiffScope treats each as in-diff.
      if (typeof f?.previous_filename === "string" && f.previous_filename) paths.push(f.previous_filename);
    }
    return paths.length ? paths : null;
  } catch (err) {
    console.warn(`[orchestrator] change-set fetch skipped for ${prUrl}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Structured review findings are USABLE for diff-scoping only when every entry
 * is an object and at least ONE cites a resolvable file (TEAM-3756 F1). The
 * threshold matters because of which way each failure cuts: findings that gate
 * spuriously merely keep legacy behavior, but findings that classify all-advisory
 * SUPPRESS a reopen — so prose-only findings (nobody cited files) must never be
 * treated as a classification, or every human rejection would read as advisory.
 */
function usableReviewFindings(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  if (!arr.every((f) => f && typeof f === "object" && !Array.isArray(f))) return false;
  return arr.some((f) => {
    const files = Array.isArray(f.citedFiles) ? f.citedFiles : Array.isArray(f.files) ? f.files : [];
    return files.some((p) => typeof p === "string" && p.trim());
  });
}

/**
 * Derive the reviewer's classified findings when the gate ticket does not carry
 * them (TEAM-3756 F1) — the same "compute it in the Lambda" pattern as
 * computeReviewChangeSet, closing the gap that left the diff-scoped gate DORMANT
 * in production (nothing ever wrote gateTicket.reviewFindings, so `gated` was
 * always true and FR-D3.2/D3.3 never fired).
 *
 * Two sources, in order:
 *   1. a fenced JSON block in the rejection feedback itself — `{"findings": [...]}`
 *      or a bare findings array — for a reviewer/agent that pastes its
 *      classification into the comment;
 *   2. the release manager's own round ledger,
 *      workflows/{id}/shared/ship-review-state.json — blueprint Step 4.1 has it
 *      record every round's `findings` (each with `citedFiles`) precisely "so the
 *      ledger is already correct for when the deterministic layer is switched
 *      on". Only the LATEST round is trusted, only when its verdict is
 *      CHANGES-NEEDED (this rejection is that verdict's delivery), and only when
 *      its reviewedHeadSha does not CONTRADICT the gate's (both known and
 *      different = the ledger describes some other round — use nothing).
 *
 * Returns null when neither source yields usable findings: the caller passes
 * null through and the diff-scoped gate stays inert (fail-open, R4) — exactly
 * the pre-derivation behavior.
 *
 * TEAM-3790: the result now carries PROVENANCE — `{ findings, source }` where
 * source is "prose" (fenced JSON parsed out of free-text comment feedback) or
 * "structured" (the release manager's machine-written S3 ledger). The caller
 * uses this to decide AUTHORITY: only machine-written structured findings may
 * ever feed an auto-approval; a prose misparse must never close a gate a human
 * tried to hold open.
 */
async function deriveReviewFindings(workflow, gateTicket, feedback) {
  // 1. Fenced JSON in the feedback — parsed out of a free-text comment, so its
  //    provenance is PROSE: usable for diff-scoping, never for auto-approval.
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(String(feedback || ""))) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : null;
      if (usableReviewFindings(arr)) return { findings: arr, source: "prose" };
    } catch { /* not JSON — keep scanning */ }
  }

  // 2. The release manager's recorded round — the agent's own machine-written
  //    structured ledger (blueprint Step 4.1): provenance STRUCTURED.
  const raw = await readS3Artifact(workflow.id, "shared/ship-review-state.json");
  if (!raw) return null;
  let state;
  try { state = JSON.parse(raw); } catch { return null; }
  const rounds = (Array.isArray(state?.rounds) ? state.rounds : []).filter(
    (r) => r && typeof r === "object"
  );
  if (!rounds.length) return null;
  const latest = rounds.reduce((a, b) => (Number(b.round) > Number(a.round) ? b : a));
  if (latest.verdict !== "CHANGES-NEEDED") return null;
  const gateSha = gateTicket.reviewedHeadSha || gateTicket.metadata?.headSha || null;
  if (gateSha && latest.reviewedHeadSha && latest.reviewedHeadSha !== gateSha) return null;
  return usableReviewFindings(latest.findings)
    ? { findings: latest.findings, source: "structured" }
    : null;
}

/**
 * TEAM-3790: whether this gate ticket is a HUMAN review gate — the uniform
 * markers PR #216 stamps on every human-gate creation path: assignee
 * "human:<who>" and/or the "human-review" / "reviewer:<who>" labels. A
 * "blocked" transition on such a gate is the human's own "request changes";
 * machine machinery must never auto-approve over it.
 */
function isHumanReviewGate(ticket) {
  if (isHumanAssignee(ticket?.assignee)) return true;
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  return labels.some(
    (l) => typeof l === "string" && (l === "human-review" || l.startsWith("reviewer:"))
  );
}

/**
 * TEAM-4120 FR-1 — is this gate's `→ blocked` a rejection the orchestrator should
 * ACT on? Returns true to proceed to handleReviewRejection, false to drop.
 *
 * Ordering contract (both twins): isCreationTimeBlock → THIS → handleReviewRejection.
 * The creation-block check stays where it is, ahead of any I/O; this guard adds
 * the two cases a previous-status check cannot see — the same rejection arriving
 * twice, and a gate no human was ever asked about.
 *
 * Fail-open on EVERY uncertainty:
 *   - GATE_STATE_GUARD=off → true immediately, before a single read.
 *   - workflow unresolvable, or any thrown error → true (logged). A bug in this
 *     guard must never be how a human's Request-changes gets swallowed.
 *   - a run with no recorded state (pre-guard, or the "none" seed) → the
 *     review_needed notification decides whether a human was ever asked.
 *     Admitting such a run CONVERGES its ledger row to `rejected`
 *     (markGateRejectedFromLegacy, TEAM-4129 F2) so its redelivery classifies as
 *     a duplicate like any other run's. A LOST legacy CAS therefore is a
 *     duplicate — another deliverer converged the row first — which is the one
 *     place this guard is deliberately NOT fail-open, because the alternative is
 *     reopening the same upstream work twice on every legacy run.
 *   - shadow → always true, but the state IS recorded and the would-be drop is
 *     published as gate.reject_ignored{wouldDrop:true} so the drop rate is
 *     measurable on live traffic before anyone enforces.
 */
async function gateRejectionAdmitted(gateTicket, oldStatus) {
  if (GATE_STATE_GUARD === "off") return true;
  const ticketId = gateTicket?.ticketId;
  try {
    const workflow = await resolveWorkflow(gateTicket?.workflowId, gateTicket?.parentId);
    if (!workflow) {
      console.warn(`[gate-state] ${ticketId}: no workflow resolved — admitting the rejection (fail-open)`);
      return true;
    }
    const gateState = workflow.gateStates?.[ticketId] || null;
    // The "none" seed (and any unknown state) is NOT usable state: such a run
    // must fall back to the notification, and must never have a lost CAS read as
    // "already rejected".
    const legacyFallback = !GATE_STATES.includes(gateState?.state);
    // Deliberately regardless of `acknowledged`: BOTH conclusions ack the
    // notification (approve → ackApprovedGateNotification, reject →
    // handleReviewRejection), so an acked notification cannot distinguish
    // "reviewed once already" from "never presented". Existence is the signal.
    const hasReviewNeeded = (workflow.humanNotifications || []).some(
      (n) => n?.type === "review_needed" && n?.ticketId === ticketId
    );

    let verdict = classifyRejection({ gateTicket, oldStatus, gateState, hasReviewNeeded });
    if (verdict === "presented") {
      // Claim the rejection. Shadow writes too — the ledger has to be populated
      // (and its CAS exercised) before an operator flips enforce, so shadow is
      // NOT byte-identical, same as REWORK_LOOP_CAP's shadow.
      //
      // TEAM-4129 F2: WHICH CAS depends on what we read. A legacy row (no usable
      // state — see legacyFallback) can never satisfy markGateRejected's
      // `state = "requested"`, so before this it lost every time, the ledger never
      // converged, and `|| legacyFallback` re-admitted every redelivery forever:
      // enforce protected nothing on any run predating the flag. The legacy CAS
      // accepts exactly that row and closes it as rejected, so the NEXT delivery
      // reads `rejected` and classifies "duplicate".
      //
      // Either way the admit decision now comes from the CAS RESULT, never from
      // legacyFallback: a lost legacy CAS means another deliverer converged the
      // row first, which is precisely the duplicate this guard exists to drop.
      const claimed = legacyFallback
        ? await store.markGateRejectedFromLegacy(workflow.id, ticketId, new Date().toISOString())
        : await store.markGateRejected(workflow.id, ticketId, new Date().toISOString(), {
            requestedAt: gateState?.requestedAt,
          });
      if (claimed || GATE_STATE_GUARD !== "enforce") {
        console.log(
          `[gate-state] ${ticketId}: ${oldStatus || "NEW"} → blocked admitted as a rejection ` +
            `(state=${gateState?.state ?? "none"}${legacyFallback ? ", legacy fallback" : ""}, mode=${GATE_STATE_GUARD})`
        );
        return true;
      }
      // Enforce + a pending row we did NOT get to close = another deliverer (the
      // other twin, or a redelivery) already recorded it.
      verdict = "duplicate";
    }

    await publishEvent(ticketId, "gate.reject_ignored", {
      workflowId: workflow.id,
      ticketId,
      reason: verdict,
      oldStatus: oldStatus ?? null,
      gateState: gateState?.state ?? null,
      legacyFallback,
      wouldDrop: true,
      mode: GATE_STATE_GUARD,
    });
    const dropped = GATE_STATE_GUARD === "enforce";
    console.log(
      `[gate-state] ${ticketId}: ${oldStatus || "NEW"} → blocked is ${verdict} ` +
        `(state=${gateState?.state ?? "none"}) — ${dropped ? "DROPPED" : "would drop; proceeding (shadow)"}`
    );
    return !dropped;
  } catch (err) {
    console.warn(`[gate-state] ${ticketId}: guard failed (${err?.message || err}) — admitting the rejection (fail-open)`);
    return true;
  }
}

/**
 * A human "requested changes" on a review-gate ticket (moved it to blocked).
 * Look up the gate's config for the run; if onReject is "rework", re-open the
 * upstream agent tickets this gate reviewed (its blockedBy) so the agents redo
 * the work with the reviewer's comment as resume context. "hold" → just pause.
 */
export async function handleReviewRejection(gateTicket) {
  const workflow = await resolveWorkflow(gateTicket.workflowId, gateTicket.parentId);
  if (!workflow) return;

  // Acknowledge this gate's open review notification — the review concluded, and
  // clearing it lets a later cycle (after rework) create a fresh notification.
  // Persisted via CAS: the previous in-memory-only mutation never landed, so
  // every rework cycle was blocked from creating its fresh notification.
  if (Array.isArray(workflow.humanNotifications)) {
    for (const n of workflow.humanNotifications) {
      if (n.ticketId === gateTicket.ticketId && n.type === "review_needed") n.acknowledged = true;
    }
    await store.ackNotifications(
      workflow.id,
      (n) => n.ticketId === gateTicket.ticketId && n.type === "review_needed"
    );
  }

  // The gate's blockedBy lists the agent tickets it reviewed. Their shared agent
  // phase is the gate's `afterPhase` — match the SPECIFIC gate by phase (a
  // reviewer may guard multiple phases with different onReject policies).
  const upstreamIds = gateTicket.blockedBy || [];
  const upstream = [];
  for (const upId of upstreamIds) {
    const up = await getTicket(upId);
    if (up && getAgentDef(up.assignee)) upstream.push(up); // agent tickets only
  }
  const gatePhase = upstream.length ? getAgentDef(upstream[0].assignee)?.phase : undefined;

  const wfDef = getEffectiveWorkflowDef(workflow);
  const gateCfg =
    (wfDef.reviewGates || []).find((g) => g.afterPhase === gatePhase) || null;
  const onReject = gateCfg?.onReject || "rework"; // default keeps work moving

  if (onReject !== "rework") {
    console.log(`[orchestrator] Review gate ${gateTicket.ticketId} rejected (hold) — workflow paused.`);
    await publishEvent(gateTicket.ticketId, "review.rejected", {
      ticketId: gateTicket.ticketId, onReject, workflowId: workflow.id,
    });
    await emitReviewResolvedRejected(workflow, gateTicket);
    return;
  }

  // Reviewer feedback: persisted reviewComment (set at transition time) → latest
  // comment → generic fallback. Stash it in workflow.resumeContexts keyed by
  // ticket so BOTH backends surface it on re-invocation (Jira tickets can't carry
  // arbitrary columns; the workflow row always lives in DynamoDB).
  const feedback =
    gateTicket.reviewComment ||
    (gateTicket.comments || []).slice(-1)[0]?.content ||
    "Reviewer requested changes.";

  // Convergence cap (TEAM-3619 D2c) — BEFORE any rework side effect. Records
  // this rejection as a review round and, once the gate's effective round count
  // reaches its `maxRounds`, hands the gate to a human and stops the loop here:
  // no resume contexts, no re-open, no further automatic cycles. A human's own
  // transition still works (approving the gate continues the flow; an explicit
  // `DECISION: continue` in a later rejection re-authorizes rework), so this
  // suppresses only the AUTOMATIC re-open.
  //
  // reviewedHeadSha is best-effort: the orchestrator doesn't track the PR head,
  // so it is normally absent and every rejection is therefore its own round.
  // When a provider does carry it, re-reviewing the same SHA reuses that round.
  //
  // Diff-scoped gate (TEAM-3689 scaffolding, activated by TEAM-3748 D3): changeSet
  // is the PR's file list and reviewFindings are the reviewer's classified findings
  // (each with its cited files). Each comes off the gate ticket if a provider
  // forwarded it, ELSE the orchestrator computes/derives it itself — the change
  // set from the PR diff (D3), the findings from the feedback's JSON block or the
  // release manager's recorded round (TEAM-3756 F1). When BOTH are known,
  // review-cap downgrades out-of-diff findings and reports `gated: false` for a
  // rejection whose findings are ALL out-of-diff, which must neither count toward
  // the cap nor re-open upstream work. Absent either input the guard stays inert
  // and behavior is byte-identical to before (R4).
  let changeSet = gateTicket.changeSet || gateTicket.metadata?.changeSet || null;
  let reviewFindings = gateTicket.reviewFindings || gateTicket.metadata?.reviewFindings || null;
  // TEAM-3790: track the findings' PROVENANCE. Derived findings carry the
  // source deriveReviewFindings reports: "structured" (the RM's machine-written
  // S3 ledger round) or "prose" (fenced JSON parsed out of comment text). Only
  // "structured" findings may ever feed an auto-approval below.
  //
  // TEAM-3966 F5: findings already ON the gate ticket are NOT granted
  // "structured" provenance. No writer of gateTicket.reviewFindings exists
  // anywhere in the repo (orchestrator, ticket Lambdas, app, deploy), so the
  // field's provenance is unattested — it is still used for diff-scoping (the
  // cap treats it as the reviewer's classification) but its source stays null,
  // which can never authorize a flip to done.
  let findingsSource = null;
  // D3 (TEAM-3748, FR-D3.1): when the event carries no change set, compute it
  // from the PR diff so review is scoped to what the PR changed rather than the
  // whole assembled repo. Fail-open — no PR / GitHub error leaves changeSet null,
  // which keeps enforceDiffScope inert and the loop byte-identical to legacy (R4).
  if (!Array.isArray(changeSet)) {
    const prUrl = resolvePrUrlForReview(workflow, gateTicket, upstream);
    changeSet = (prUrl && (await computeReviewChangeSet(prUrl))) || null;
  }
  // TEAM-3756 F1: derive the classified findings the same way — but only when a
  // change set exists to scope against (without one the findings are never read,
  // so the S3 lookup would be a wasted call on every legacy rejection).
  if (!Array.isArray(reviewFindings) && Array.isArray(changeSet)) {
    const derived = await deriveReviewFindings(workflow, gateTicket, feedback);
    if (derived) {
      reviewFindings = derived.findings;
      findingsSource = derived.source;
    }
  }
  const capResult = await getReviewCap().enforce({
    workflow,
    gateTicket,
    gateCfg: gateCfg ? { ...gateCfg, afterPhase: gateCfg.afterPhase ?? gatePhase } : gateCfg,
    upstreamIds: upstream.map((up) => up.ticketId),
    feedback,
    reviewedHeadSha: gateTicket.reviewedHeadSha || gateTicket.metadata?.headSha || null,
    changeSet,
    findings: reviewFindings,
  });
  if (capResult.escalated) {
    await publishEvent(gateTicket.ticketId, "review.rejected", {
      ticketId: gateTicket.ticketId,
      onReject,
      reopened: [],
      workflowId: workflow.id,
      capReached: true,
      effectiveRounds: capResult.effectiveRounds,
      maxRounds: capResult.maxRounds,
    });
    await emitReviewResolvedRejected(workflow, gateTicket);
    return;
  }

  // Diff-scoped gate (TEAM-3689): a CHANGES-NEEDED verdict whose only findings
  // cite files OUTSIDE the recorded change set is non-gating — it must NOT
  // re-open upstream work. `gated` is true whenever there is no change set to
  // scope against, so this branch is inert for old ledgers.
  //
  // TEAM-3756 F3b — the non-gating rejection gets a DEFINED next state:
  // APPROVE-WITH-ADVISORY. Before, this branch published the event and returned,
  // leaving the gate in `blocked` with nothing scheduled to touch it again — a
  // silent stall. Auto-approving is the blueprint's own verdict, not an
  // override of the human: with F3a, `gated:false` is reachable ONLY when every
  // finding AFFIRMATIVELY cites out-of-diff files (unattributed/prose findings
  // now gate), and Step 4's rule for exactly that state is
  // PASS-with-known-findings — "Never let an advisory finding flip PASS to
  // CHANGES NEEDED". Chosen over the cap-escalation primitive because
  // escalation means "a human must decide"; here the deterministic gate HAS
  // decided, and parking it would recreate the same stall one hop later. The
  // done transition takes the identical path a human approval takes (DDB
  // stream / Jira webhook → done cascade), so dependents unblock through the
  // one existing machinery. A reviewer who wants to force rework can: any
  // finding without out-of-diff citations gates.
  //
  // TEAM-3966 F1 — the human's explicit override. A human-origin rejection
  // whose feedback carries a well-formed `DECISION: continue` line (same
  // fail-closed parser the cap escalation uses) is treated as GATING even when
  // the diff-scope verdict says all findings are advisory: skip the park and
  // take the normal reopen-upstream path. Without this, a human who rejects,
  // gets parked, and wants REWORK has no working path — nothing else consumes
  // a DECISION line on a parked gate (the cap's authorizeIfDecided only acts on
  // an open escalation, and gated:false records neither a round nor an
  // escalation). `feedback` is the persisted reviewComment (set at transition
  // time) or the latest comment, so the human must put the line in the note
  // attached to the re-rejection; comments alone never wake the orchestrator.
  const humanOrigin = isHumanReviewGate(gateTicket);
  const humanContinue = humanOrigin && parseDecision(feedback) === "continue";
  if (capResult.gated === false && humanContinue) {
    console.log(
      `[orchestrator] Review gate ${gateTicket.ticketId}: all findings out-of-diff, but the human's ` +
        `rejection carries DECISION: continue — treating as gating and reopening upstream work.`
    );
  }
  if (capResult.gated === false && !humanContinue) {
    // TEAM-3790 — AUTHORITY CHECK before any auto-approval. The advisory
    // auto-approve is the release manager's OWN Step-4 verdict being enacted;
    // it must never override a human's explicit rejection, and it must never
    // run off prose-derived findings a misparse could have misclassified.
    //   1. Human-origin: the gate carries the uniform human-review markers
    //      (PR #216 — assignee "human:*" and/or "human-review"/"reviewer:*"
    //      labels). Its "blocked" transition IS the human's request-changes;
    //      the human keeps authority. Park + ask, never flip to done.
    //   2. Findings provenance: only the machine-written structured findings
    //      (the RM's own S3 ledger round, via deriveReviewFindings) may feed an
    //      auto-approval. Prose-derived or ticket-carried findings → park.
    const structuredFindings = findingsSource === "structured";
    if (humanOrigin || !structuredFindings) {
      const reason = humanOrigin
        ? "human_origin_rejection"
        : findingsSource === "prose"
        ? "prose_derived_findings"
        : "non_structured_findings";
      console.log(
        `[orchestrator] Review gate ${gateTicket.ticketId} rejected with all-out-of-diff findings but ` +
          `${humanOrigin ? "the rejection is a HUMAN's own request-changes" : `the findings are not machine-written (${reason})`} ` +
          `— parking the gate for the human instead of auto-approving.`
      );
      // TEAM-3966 F4 — idempotent across redelivery. The orchestrator's own
      // park comment carries PARK_ADVISORY_MARKER; if the gate already has one
      // AND nothing newer than it is observable, this is a re-processing of the
      // same parked state (SQS retry / stream re-poll / webhook replay): log,
      // but post no second comment and publish no second review.parked_advisory.
      // Both providers surface comments as [{author, content, timestamp}]
      // (mapJiraIssueToTicket / DDB item).
      //
      // TEAM-3970 — a marker alone is NOT proof of redelivery: the human may
      // have moved the gate In Review → Request Changes AGAIN with a fresh note
      // (a real new transition that must park + count again). Redelivery only
      // when BOTH hold:
      //   E1  no non-marker comment is NEWER than the latest marker — by
      //       timestamp when both parse, else by array position. Jira: the
      //       human's note is always a comment posted BEFORE the transition
      //       (agentcore-hub-jira transitionTicket) and mapJiraIssueToTicket
      //       keeps API order with `created` as `timestamp`. DDB: a console
      //       comment (/tickets/comment) lands the same way.
      //   E2  (DDB only) the latest marker's `[fp:…]` — the fingerprint of the
      //       reviewComment at park time — still matches the current
      //       reviewComment. Needed because the DDB tickets Lambda writes the
      //       rejection note to `reviewComment` ONLY (no comments[] entry), so
      //       E1 can never see it there. Jira is excluded because there
      //       `reviewComment` is the LAST comment, which on a redelivery is the
      //       marker itself and would false-positive.
      // Fallback (legacy marker without fp / no timestamps / no reviewComment):
      // array order alone — byte-identical to the original F4 guard, i.e. a
      // marker that is the newest comment is a redelivery.
      const comments = Array.isArray(gateTicket.comments) ? gateTicket.comments : [];
      const textOf = (c) => String(c?.content ?? c?.body ?? c ?? "");
      const tsOf = (c) => {
        const t = Date.parse(String(c?.timestamp ?? c?.created ?? ""));
        return Number.isFinite(t) ? t : null;
      };
      const isMarker = (c) => textOf(c).includes(PARK_ADVISORY_MARKER);
      let markerIdx = -1;
      comments.forEach((c, i) => { if (isMarker(c)) markerIdx = i; }); // latest marker by position
      const marker = markerIdx >= 0 ? comments[markerIdx] : null;
      // A reviewComment that IS an orchestrator park comment (Jira sets
      // reviewComment to the last comment, which on a redelivery is the marker)
      // is never a human note — fingerprint nothing rather than the marker.
      const noteFp =
        typeof gateTicket.reviewComment === "string" &&
        gateTicket.reviewComment &&
        !gateTicket.reviewComment.includes(PARK_ADVISORY_MARKER)
          ? parkNoteFingerprint(gateTicket.reviewComment)
          : null;
      if (marker) {
        const markerTs = tsOf(marker);
        const newerComment = comments.some((c, i) => {
          if (isMarker(c)) return false;
          const t = tsOf(c);
          return markerTs !== null && t !== null ? t > markerTs : i > markerIdx;
        });
        const markerFp = PARK_FP_RE.exec(textOf(marker))?.[1] ?? null;
        const newerNote =
          TICKET_PROVIDER !== "jira" && markerFp !== null && noteFp !== null && markerFp !== noteFp;
        if (!newerComment && !newerNote) {
          console.log(
            `[orchestrator] Review gate ${gateTicket.ticketId} is already parked (advisory) — redelivery; ` +
              `skipping duplicate park comment and event.`
          );
          return;
        }
        console.log(
          `[orchestrator] Review gate ${gateTicket.ticketId} was parked before, but a NEW rejection cycle is ` +
            `observable (${newerComment ? "newer human comment" : "reviewComment changed"}) — parking again.`
        );
      }
      try {
        await commentOnTicket(
          gateTicket.ticketId,
          `${PARK_ADVISORY_MARKER}${noteFp ? ` [fp:${noteFp}]` : ""} All findings appear out-of-diff for this fix — approve the gate to confirm, ` +
            `or leave it rejected to hold. To force rework: move the gate back to In Review, then Request Changes ` +
            `again with a note containing a line that reads exactly "DECISION: continue" — a comment alone does ` +
            `not wake the orchestrator, the status change does. Alternatively, re-reject citing a file in the PR ` +
            `change set, or reopen the upstream ticket(s) directly.`
        );
      } catch (err) {
        console.warn(`[orchestrator] advisory park comment failed for ${gateTicket.ticketId}: ${err?.message || err}`);
      }
      // The gate stays exactly where the rejection put it (blocked) — the
      // human's approval, or a re-rejection carrying DECISION: continue, is the
      // only way forward. Observable, so the parked state is never a silent
      // stall.
      await publishEvent(gateTicket.ticketId, "review.parked_advisory", {
        ticketId: gateTicket.ticketId,
        workflowId: workflow.id,
        reason,
        advisoryFindings: Array.isArray(reviewFindings) ? reviewFindings : [],
      });
      return;
    }
    console.log(
      `[orchestrator] Review gate ${gateTicket.ticketId} rejected but all findings are out-of-diff (advisory) — ` +
        `approving with known findings instead of reopening.`
    );
    // Audit trail first: the advisory findings land on the ticket even if the
    // transition below fails (best-effort — a comment failure must not stall
    // the approval this branch exists to guarantee).
    const advisoryLines = (Array.isArray(reviewFindings) ? reviewFindings : []).map((f) => {
      const files = Array.isArray(f?.citedFiles) ? f.citedFiles : Array.isArray(f?.files) ? f.files : [];
      const label = f?.title || f?.summary || f?.severity || "finding";
      return `• ${label} — cites ${files.join(", ") || "(no files)"} (outside the PR change set)`;
    });
    try {
      await commentOnTicket(
        gateTicket.ticketId,
        `Auto-approved with known findings: the reviewer requested changes, but every finding cites ` +
          `files outside the PR change set (advisory — release-manager.md Step 4). ` +
          `No rework round was recorded and upstream work was not reopened.\n` +
          `Advisory findings (filed for audit, not gating):\n${advisoryLines.join("\n")}`
      );
    } catch (err) {
      console.warn(`[orchestrator] advisory audit comment failed for ${gateTicket.ticketId}: ${err?.message || err}`);
    }
    // Approve: the same transition a human approval makes, so the done cascade
    // (unblock dependents, completion checks) runs through the normal path.
    //
    // TEAM-3765 F4 — this transition is the ONLY exit from `blocked` for an
    // all-advisory gate. It used to be fire-and-forget: a Jira transition
    // returns false (it never throws) on a failed/absent transition, and the DDB
    // write's throw was caught and merely logged — then review.rejected was
    // published and the command acked as success REGARDLESS. A transient
    // transition/write failure therefore left the gate stuck in `blocked` with
    // nothing scheduled to re-drive it: a permanent stall (the D1 class this
    // epic exists to fix).
    //
    // Fix (option a — bounded retry + escalation event). Chosen over option b
    // (throw so the event source retries) because this handler is reached from
    // THREE sources with DIFFERENT retry semantics: the SQS FIFO command queue
    // retries a throw and the direct Jira webhook propagates it, but the DEFAULT
    // DDB-stream path (TICKET_PROVIDER=dynamodb) swallows per-record throws in
    // the handler loop — so a throw there is a silent no-retry. An explicit
    // escalation event is path-independent: it is human/alert-visible AND leaves
    // the gate `blocked` (never marked done, never acked as approved) so the
    // reconcile sweep can re-drive it. The transition stays idempotent — an
    // unconditional SET to a constant `done` (DDB) / a no-op "Done" transition
    // once already there (Jira) — and we STOP at the first observed success, so a
    // retry after a partial success cannot double-approve.
    let approved = false;
    let lastApproveErr = null;
    for (let attempt = 1; attempt <= ADVISORY_APPROVE_MAX_ATTEMPTS && !approved; attempt++) {
      try {
        if (TICKET_PROVIDER === "jira") {
          // TEAM-3966 F2: Jira has no conditional transition, so emulate the
          // DDB branch's pre-state guard — re-read the gate immediately before
          // transitioning and require it to STILL be `blocked` (where the
          // rejection left it). Any other status means a concurrent transition
          // moved it and whoever did that holds authority: log and STOP, exactly
          // like ConditionalCheckFailedException below (no retry, no rethrow,
          // no escalation). A read failure throws into the catch and is
          // treated as transient (retried), re-reading on the next attempt.
          const fresh = await getTicketFromJira(gateTicket.ticketId);
          if (fresh?.status !== "blocked") {
            console.log(
              `[orchestrator] advisory auto-approve for ${gateTicket.ticketId} lost to a concurrent ` +
                `transition (Jira status is "${fresh?.status ?? "unknown"}", expected "blocked") — ` +
                `stopping without retry; the concurrent action wins.`
            );
            return;
          }
          // jiraTransition returns false (does NOT throw) when the transition is
          // missing or the POST fails — a false is as much a non-landing as a
          // throw, so both count as "not approved" and drive a retry.
          approved = await jiraTransition(gateTicket.ticketId, "Done");
        } else {
          // TEAM-3790: the flip to done is CONDITIONED on the gate still being
          // where the rejection left it. A concurrent human transition (cancel/
          // rework/anything else) between findings-derivation and this write
          // changes the status, fails the condition, and WINS — last-writer-wins
          // is exactly the bug this removes.
          //
          // TEAM-3966 F3: `blocked` ONLY. The stream record that reaches this
          // handler fires after the item is already `blocked`, so `in_review`
          // here can only mean a concurrent move (a human sending it back to
          // review, parkGateForHuman on an escalation, the cascade's re-park) —
          // every one of which must win, not be overwritten.
          await ddb.send(new UpdateCommand({
            TableName: TICKETS_TABLE,
            Key: { ticketId: gateTicket.ticketId },
            UpdateExpression: "SET #s = :s, #u = :u",
            ConditionExpression: "#s = :expectBlocked",
            ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
            ExpressionAttributeValues: {
              ":s": "done",
              ":u": new Date().toISOString(),
              ":expectBlocked": "blocked",
            },
          }));
          approved = true;
        }
      } catch (err) {
        // TEAM-3790: a failed condition is NOT a transient failure — a
        // concurrent transition moved the gate out of blocked, and whoever did
        // that holds authority. Log and STOP: no retry (retrying
        // would be the same last-writer-wins overwrite one attempt later), no
        // escalation (nothing is stuck — the gate is wherever the concurrent
        // actor put it), no rethrow (an event-source retry would re-race).
        if (err?.name === "ConditionalCheckFailedException") {
          console.log(
            `[orchestrator] advisory auto-approve for ${gateTicket.ticketId} lost to a concurrent ` +
              `transition (condition failed) — stopping without retry; the concurrent action wins.`
          );
          return;
        }
        lastApproveErr = err;
        console.warn(`[orchestrator] advisory auto-approve attempt ${attempt}/${ADVISORY_APPROVE_MAX_ATTEMPTS} for ${gateTicket.ticketId} failed: ${err?.message || err}`);
      }
      if (!approved && attempt < ADVISORY_APPROVE_MAX_ATTEMPTS && ADVISORY_APPROVE_BACKOFF_MS > 0) {
        await new Promise((r) => setTimeout(r, ADVISORY_APPROVE_BACKOFF_MS * attempt));
      }
    }

    if (!approved) {
      // The approval never landed after the bounded retry. Do NOT ack success and
      // do NOT publish review.rejected as if the gate resolved — that ordering
      // (rejected + ack while `blocked` persists) is the bug. Emit an explicit
      // escalation instead: an OBSERVABLE recovery signal for alerting + a human,
      // while the gate stays `blocked` so the reconcile sweep remains eligible to
      // re-drive it.
      console.error(`[orchestrator] advisory auto-approve for ${gateTicket.ticketId} did NOT land after ${ADVISORY_APPROVE_MAX_ATTEMPTS} attempts — escalating (gate left blocked): ${lastApproveErr?.message || "transition returned false"}`);
      await publishEvent(gateTicket.ticketId, "review.escalated", {
        ticketId: gateTicket.ticketId,
        workflowId: workflow.id,
        reason: "advisory_auto_approve_failed",
        attempts: ADVISORY_APPROVE_MAX_ATTEMPTS,
        error: lastApproveErr?.message || "transition returned false",
        advisoryFindings: Array.isArray(reviewFindings) ? reviewFindings : [],
      });
      return;
    }

    // Approval landed — record it, then the legacy observability event.
    await publishEvent(gateTicket.ticketId, "review.approved_with_advisory", {
      ticketId: gateTicket.ticketId,
      workflowId: workflow.id,
      advisoryFindings: Array.isArray(reviewFindings) ? reviewFindings : [],
    });
    await publishEvent(gateTicket.ticketId, "review.rejected", {
      ticketId: gateTicket.ticketId,
      onReject,
      reopened: [],
      workflowId: workflow.id,
      noInDiffFindings: true,
    });
    return;
  }

  // Persist each ticket's feedback atomically (per-key, no full-row put) BEFORE
  // reopening, so a fast re-invocation always finds its resume context.
  const reopened = [];
  for (const up of upstream) {
    // Surface the agent's prior coding session so it can CHOOSE to continue
    // that conversation (claude_code/codex resume_session=...) instead of
    // rebuilding context. Scope, not a command — the resume decision is the
    // agent's (fresh may be right if the feedback says start over).
    const priorSession = await findCodingSession(workflow.id, up.assignee);
    const sessionHint = priorSession
      ? `\n\nYour previous coding session for this work: ${priorSession}. ` +
        `DEFAULT: pass it as resume_session on your first claude_code/codex/kiro call — it continues that ` +
        `conversation with its context intact. Start fresh only if the feedback demands a restart. Resume is best-effort.`
      : "";
    const resumeNote = `## Review feedback (changes requested)\n${feedback}\n\nAddress this feedback and redo your work.${sessionHint}`;
    await store.setResumeContext(workflow.id, up.ticketId, resumeNote);
    reopened.push(up.ticketId);
  }

  // Re-open each upstream ticket so its agent re-runs. Done has no direct path to
  // Ready — in Jira it must hop Done → To Do (Reopen) → Ready.
  //
  // TEAM-3684 Finding 3 (converse risk, ACCEPTED): the cascade reads the sibling
  // statuses from the eventually-consistent parentId-index GSI. A reopen here
  // (done → todo) that hasn't yet propagated to that GSI could let a racing
  // cascadeUnblock still observe this blocker as "done" and PREMATURELY Ready a
  // dependent. This is the mirror of the missed-last-unblock the cascade's
  // bounded re-fetch guards against, and it is deliberately NOT handled: a
  // premature Ready is self-correcting (the reopened blocker re-blocks and the
  // agent re-runs), whereas the missed unblock is terminal. Documented so the
  // asymmetry is a choice, not an oversight.
  //
  // TEAM-3619 D4c: stamp the re-opened ticket as a review-fix routed under the
  // gated phase (`spawnedBy` + `phase`). `isWorkflowComplete` then treats this
  // as an open fix under `gatePhase`, so the run cannot be declared complete
  // while a rework cycle is in flight — even if the gate ticket itself is done.
  // (Jira tickets can't carry arbitrary columns; the reopen path re-derives
  // phase from the assignee and the workflow row records the round, so the DDB
  // stamp is where this metadata lands.)
  const spawnedBy = { gateTicketId: gateTicket.ticketId, kind: "review_fix" };
  for (const up of upstream) {
    if (TICKET_PROVIDER === "jira") {
      await jiraReopenToReady(up.ticketId);
    } else {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId: up.ticketId },
        UpdateExpression: "SET #s = :s, #u = :u, spawnedBy = :sb" + (gatePhase ? ", #ph = :ph" : ""),
        ExpressionAttributeNames: {
          "#s": "status",
          "#u": "updatedAt",
          ...(gatePhase ? { "#ph": "phase" } : {}),
        },
        ExpressionAttributeValues: {
          ":s": "todo",
          ":u": new Date().toISOString(),
          ":sb": spawnedBy,
          ...(gatePhase ? { ":ph": gatePhase } : {}),
        },
      }));
    }
  }
  console.log(`[orchestrator] Review gate ${gateTicket.ticketId} rejected (rework) — re-opened: [${reopened.join(", ")}]`);
  await publishEvent(gateTicket.ticketId, "review.rejected", {
    ticketId: gateTicket.ticketId, onReject, reopened, workflowId: workflow.id,
  });
  await emitReviewResolvedRejected(workflow, gateTicket);
}

/**
 * Most recent Cloud Code session for (workflow, agent) — the runtime records
 * one row per agent-task (origin "workflow"). Used only to HINT the reworking
 * agent about its prior session; null on any failure (hint is optional).
 */
async function findCodingSession(workflowId, agentId) {
  if (!workflowId || !agentId) return null;
  try {
    const res = await ddb.send(new ScanCommand({
      TableName: CLOUD_CODE_TABLE,
      FilterExpression: "workflowId = :w AND agentId = :a AND #or = :o",
      ExpressionAttributeNames: { "#or": "origin" },
      ExpressionAttributeValues: { ":w": workflowId, ":a": agentId, ":o": "workflow" },
      ProjectionExpression: "sessionId, updatedAt",
    }));
    const rows = (res.Items || []).sort((x, y) =>
      String(y.updatedAt || "").localeCompare(String(x.updatedAt || "")));
    return rows[0]?.sessionId || null;
  } catch (err) {
    console.warn(`[orchestrator] findCodingSession failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Consume any pending rework feedback for a ticket: returns the resume note and
 * clears it from the workflow's resumeContexts map. Backend-agnostic — the
 * workflow row lives in DynamoDB regardless of TICKET_PROVIDER.
 */
async function consumeResumeContext(workflow, ticketId) {
  const note = workflow.resumeContexts?.[ticketId];
  if (!note) return null;
  delete workflow.resumeContexts[ticketId];
  await store.removeResumeContext(workflow.id, ticketId);
  return note;
}

/**
 * Unified "ticket ready" handler — works with both backends.
 * Called from processStatusChange (Jira webhook path).
 */
async function handleTicketReadyUnified(ticketId, ticket) {
  const assignee = ticket.assignee;
  const parentId = ticket.parentId;
  const workflowId = ticket.workflowId;

  console.log(`[orchestrator] handleTicketReady: ${ticketId} assignee=${assignee} parentId=${parentId} workflowId=${workflowId}`);

  if (!assignee || ticket.type === "epic") return;

  // Human-review gate: park for a person instead of invoking an agent.
  if (isHumanAssignee(assignee)) {
    const gateWorkflow = await resolveWorkflow(workflowId, parentId);
    if (gateWorkflow && gateWorkflow.phase === "cancelled") return;
    await handleHumanReviewGate(ticketId, assignee, gateWorkflow);
    return;
  }

  const agentDef = getAgentDef(assignee);
  if (!agentDef) {
    console.warn(`[orchestrator] Unknown agent: ${assignee}`);
    return;
  }

  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) {
    console.warn(`[orchestrator] No workflow for ticket ${ticketId}`);
    return;
  }

  // ─── CANCEL GUARD (defense-in-depth) ───
  if (workflow.phase === "cancelled") {
    console.log(`[orchestrator] GUARD (handleTicketReadyUnified): workflow ${workflow.id} is cancelled — not invoking ${assignee}`);
    return;
  }
  // ─── END CANCEL GUARD ───

  // ─── CD HANDOFF GUARD: no ship-phase work on a repo the hub does not deploy ───
  if (await skipShipTicketForHandoff(ticketId, agentDef, workflow)) return;

  // ─── SHIP-TICKET DISPATCH GATES (TEAM-4112 prereq + TEAM-4111 head stability) ───
  // Ship-phase tickets only. Both gates default off = byte-identical (no reads,
  // no probe, no metrics). "skip" means the ticket was held (blocked/deferred and
  // persisted as needed) — return without claiming; "dispatch" means proceed.
  if (SHIP_PHASES.has(agentDef.phase)) {
    if ((await evaluateShipTicketDispatch({ ticketId, parentId, agentDef, workflow })) === "skip") return;
  }

  // Idempotency claim — ATOMIC, backend-agnostic. The workflow row lives in
  // DynamoDB in BOTH modes, so a conditional write on agentTasks[ticketId].status
  // is the real lock. Jira transitions are NOT a guard: concurrent webhook
  // deliveries each see "Ready" and each proceed — that is exactly how duplicate
  // agent sessions (and duplicate PRs) were spawned. Claim BEFORE any transition.
  const claimed = await claimTicketInvocation(workflow, ticketId, assignee);
  if (!claimed) {
    console.log(`[orchestrator] ${ticketId} already claimed (running) — skipping duplicate invocation`);
    return;
  }

  if (TICKET_PROVIDER === "jira") {
    await jiraTransition(ticketId, "In Progress");
  } else {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #s = :s, #u = :u",
        ConditionExpression: "#s <> :inprog",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":s": "in_progress", ":inprog": "in_progress", ":u": new Date().toISOString() },
      }));
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        console.log(`[orchestrator] ${ticketId} already in_progress — skipping duplicate invocation`);
        return;
      }
      throw err;
    }
  }

  // Initialize manifest if needed
  try { await initManifestIfNeeded(workflow); } catch (err) {
    console.warn(`[orchestrator] Manifest init failed (non-fatal): ${err.message}`);
  }

  // Phase advancement (workflow-def driven, with software-delivery fallback)
  const wfDef = getEffectiveWorkflowDef(workflow); // framework overlay decides featureBranchPhase
  // Shared feature branch on the def's branch phase (repo-backed workflows only).
  // Independent of the phase ADVANCE below: the playbook def's branch phase is
  // "requirements" — the run's INITIAL phase — so gating this on an advance
  // meant the spec author was dispatched with no branch to commit the chain to
  // (first playbook run, 2026-09-05). ensureFeatureBranch persists itself.
  if (wfDef.featureBranchPhase && agentDef.phase === wfDef.featureBranchPhase && !workflow.featureBranch && workflow.repoConfig?.repos?.length > 0) {
    workflow.featureBranch = await ensureFeatureBranch(workflow);
  }
  await announcePhaseTransition(workflow, wfDef, agentDef, ticketId);

  // ─── PRE-CI SYNC (TEAM-4122 FR-6) ───
  // Merge the repo's default branch into the integration branch BEFORE the CI
  // agent reads its head, so the SHA it certifies is the SHA that would land.
  // Deliberately AFTER the claim: the claim is what serializes two concurrent
  // deliveries of this ticket, and two of these running at once would push two
  // merge commits. `conflict` is the only outcome that stops the dispatch — the
  // CI ticket is blocked on a sync_fix ticket and its claim is released inside,
  // so the cascade re-dispatches once the dev resolves it. off → not reached.
  if (SYNC_MAIN_BEFORE_CI !== "off" && agentDef?.agentId === CI_AGENT_ID && workflow.featureBranch) {
    const sync = await syncBeforeCi(workflow, ticket, syncDeps());
    if (sync.outcome === "conflict") {
      // TEAM-4131 F1: reason "round_cap" has NO fix ticket by design (the run is
      // parked for a human), so do not claim it is blocked on one.
      console.log(
        `[orchestrator] ${ticketId} held: ${workflow.featureBranch} cannot merge the default branch — ` +
        (sync.fixTicketId
          ? `blocked on ${sync.fixTicketId}`
          : `PARKED for a human after ${sync.round ?? "?"} sync_fix round(s) (${sync.reason || "conflict"})`)
      );
      return;
    }
  }

  // Build context and invoke — SAME buildAgentContext for both paths
  let context = await buildAgentContext(ticket, workflow);

  // Prepend resume context if the agent is re-running: either from the retry
  // endpoint (ticket.resumeContext, DDB-only) or a review-gate rework (workflow
  // resumeContexts map, backend-agnostic). Both are one-time use.
  const reworkNote = await consumeResumeContext(workflow, ticketId);
  let resumed = false;
  if (ticket.resumeContext) {
    context = `${ticket.resumeContext}\n\n---\n\n${context}`;
    resumed = true;
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "REMOVE #rc",
      ExpressionAttributeNames: { "#rc": "resumeContext" },
    }));
  }
  if (reworkNote) {
    context = `${reworkNote}\n\n---\n\n${context}`;
    resumed = true;
  }

  console.log(`[orchestrator] Invoking agent ${assignee} for ticket ${ticketId}${resumed ? " (SESSION RESUME)" : ""}`);
  await publishEvent(ticketId, "agent.invoked", { ticketId, assignee, agentId: assignee, phase: agentDef.phase, workflowId: workflow.id });

  await invokeAgent(agentDef, context, workflow, ticketId);
}

/**
 * Transition a Jira issue to a target status. Returns true if the transition
 * was applied (HTTP ok), false otherwise — callers that chain transitions rely
 * on this to avoid leaving a ticket stranded mid-hop.
 */
async function jiraTransition(issueKey, targetStatusName) {
  try {
    const data = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`);
    const match = data.transitions.find(
      t => t.name.toLowerCase() === targetStatusName.toLowerCase() ||
           t.to.name.toLowerCase() === targetStatusName.toLowerCase()
    );
    if (!match) {
      console.warn(`[orchestrator] No transition to "${targetStatusName}" for ${issueKey}`);
      return false;
    }
    const url = `https://${JIRA_SITE_URL}/rest/api/3/issue/${issueKey}/transitions`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: JIRA_AUTH, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    if (!resp.ok) {
      console.warn(`[orchestrator] Jira transition to "${targetStatusName}" for ${issueKey} returned ${resp.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[orchestrator] Jira transition failed for ${issueKey}: ${err.message}`);
    return false;
  }
}

/**
 * Reopen a Done Jira ticket to Ready as a verified two-hop (Done → To Do →
 * Ready). Jira fires a webhook per hop and ordering isn't guaranteed, so we only
 * proceed to Ready after To Do is confirmed, and retry Ready briefly. Returns
 * true once the ticket is Ready. Avoids a silent stall when the 2nd hop fails.
 */
async function jiraReopenToReady(issueKey) {
  // Hop 1: Done → To Do. Retry a couple times in case the transition list is
  // momentarily stale right after the gate's own transition.
  let toTodo = false;
  for (let i = 0; i < 3 && !toTodo; i++) {
    toTodo = await jiraTransition(issueKey, "To Do");
    if (!toTodo) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!toTodo) {
    console.error(`[orchestrator] Reopen ${issueKey}: could not reach To Do — ticket left as-is.`);
    return false;
  }
  // Hop 2: To Do → Ready. This fires the "ready" webhook that re-invokes the agent.
  let toReady = false;
  for (let i = 0; i < 3 && !toReady; i++) {
    toReady = await jiraTransition(issueKey, "Ready");
    if (!toReady) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!toReady) {
    console.error(`[orchestrator] Reopen ${issueKey}: reached To Do but not Ready — STALLED, manual nudge needed.`);
    return false;
  }
  return true;
}

// ─── DynamoDB Stream Processing (legacy DynamoDB path) ────────────────────────

async function processRecord(record) {
  const eventName = record.eventName; // INSERT, MODIFY, REMOVE
  if (eventName === "REMOVE") return;

  const newImage = record.dynamodb?.NewImage;
  const oldImage = record.dynamodb?.OldImage;
  if (!newImage) return;

  const ticketId = unwrapDdbValue(newImage.ticketId);
  const newStatus = unwrapDdbValue(newImage.status);
  const oldStatus = oldImage ? unwrapDdbValue(oldImage.status) : null;

  // Skip counter item
  if (ticketId === "__COUNTER__") return;

  // TEAM-4166 D1 §1.4 — LEVEL-TRIGGERED pickup of a tool-reported precondition.
  // report_precondition_unmet stamps preconditionUnmet.awaitingIds WITHOUT
  // changing status (it's an annotation, not a transition), so that write would
  // fall through the status-change early-return just below. Pick it up HERE and
  // write the awaited ids as real blockedBy edges, so the parked ticket re-wakes
  // through the normal unblock cascade once its fixes close. Idempotent
  // (applyBlockerEdge answers "present" on a re-run), gated on mode (off →
  // no-op), and never fatal — an awaited edge is advisory bookkeeping.
  if (AWAITED_IDS_MODE !== "off") {
    const pu = unwrapDdbValue(newImage.preconditionUnmet);
    const awaitingIds = Array.isArray(pu?.awaitingIds) ? pu.awaitingIds : null;
    if (awaitingIds?.length) {
      const existingEdges = new Set(unwrapDdbValue(newImage.blockedBy) || []);
      if (awaitingIds.some((id) => !existingEdges.has(id))) {
        try {
          await getAwaitedIds().applyAwaitedEdges(ticketId, awaitingIds, "tool");
        } catch (err) {
          console.warn(`[orchestrator] awaited-ids pickup failed for ${ticketId} (non-fatal): ${err?.message || err}`);
        }
      }
    }
  }

  // Only react to status changes (or new inserts with actionable status)
  if (eventName === "MODIFY" && newStatus === oldStatus) return;

  console.log(`[orchestrator] ${ticketId}: ${oldStatus || "NEW"} → ${newStatus}`);

  // Track ticket in workflow.agentTasks at creation time (INSERT = new ticket)
  if (eventName === "INSERT") {
    const insertAssignee = unwrapDdbValue(newImage.assignee);
    const insertWorkflowId = unwrapDdbValue(newImage.workflowId);
    const insertParentId = unwrapDdbValue(newImage.parentId);
    await trackTicketCreation(ticketId, insertAssignee, insertWorkflowId, insertParentId, unwrapDdbValue(newImage.spawnedBy));
    // TEAM-4121 FR-8: the DDB-stream twin of the `todo` shadow-warning advisory.
    // The stream image already carries everything needed, so no extra read.
    await emitContractWarning(ticketId, {
      workflowId: insertWorkflowId,
      spawnedBy: unwrapDdbValue(newImage.spawnedBy),
      fixContract: unwrapDdbValue(newImage.fixContract),
    });
  }

  switch (newStatus) {
    case "done":
      await handleTicketDone(ticketId, newImage);
      break;
    case "ready":
    case "todo":
      // "todo" with all blockers resolved = ready to invoke
      const blockedBy = unwrapDdbValue(newImage.blockedBy) || [];
      const streamBlockersResolved = blockedBy.length === 0 || await checkAllBlockersResolved(blockedBy);
      if (streamBlockersResolved) {
        // ─── CANCEL GUARD (DDB Stream path) ───
        const guardTicket = await getTicket(ticketId);
        if (guardTicket) {
          let guardWorkflow;
          try {
            guardWorkflow = await resolveWorkflow(guardTicket.workflowId, guardTicket.parentId);
          } catch (err) {
            console.error(`[orchestrator] GUARD: Failed to resolve workflow for ticket ${ticketId}:`, err);
            return; // Fail closed — do not invoke if we can't verify state
          }
          if (!guardWorkflow || guardWorkflow.phase === "cancelled") {
            console.log(`[orchestrator] GUARD: Skipping invocation for ${ticketId} — workflow ${guardWorkflow?.id || "unknown"} is cancelled or not found`);
            return;
          }
        }
        // ─── END CANCEL GUARD ───
        await handleTicketReady(ticketId, newImage);
      }
      break;
    case "in_progress":
      const startedAssignee = unwrapDdbValue(newImage.assignee);
      await publishEvent(ticketId, "agent.started", { ticketId, assignee: startedAssignee, agentId: startedAssignee });
      break;
    case "blocked": {
      // Human-review gate "Request changes" → re-open upstream work if configured.
      // TEAM-3966 F2 (pin): same "human:*"-only gating as processStatusChange —
      // the RM-origin auto-approve inside handleReviewRejection is unreachable
      // from this trigger too. Pinned by review-rejection.test.mjs.
      // TEAM-4044: same creation-time guard as processStatusChange — an INSERT
      // straight into blocked (no old image) or a `todo → blocked` initial write
      // is the dependency block, not a human "Request changes".
      if (isCreationTimeBlock(oldStatus)) {
        console.log(
          `[orchestrator] ${ticketId}: ${oldStatus || "NEW"} → blocked is the gate's creation-time ` +
            `dependency block, not a review rejection — ignoring.`
        );
        break;
      }
      const blockedAssignee = unwrapDdbValue(newImage.assignee);
      if (isHumanAssignee(blockedAssignee)) {
        const rejected = await getTicket(ticketId);
        // TEAM-4120 FR-1: same guard, same position as the webhook twin — after
        // the creation-block + human-assignee checks, before the handler. This is
        // also the twin that most often arrives second for the SAME transition,
        // so under enforce it is the one the CAS stands down (no-op when off).
        if (rejected && (await gateRejectionAdmitted(rejected, oldStatus))) {
          await handleReviewRejection(rejected);
        }
      }
      break;
    }
  }
}

/**
 * TEAM-4044: `→ blocked` from no prior status / "new" / "todo" is a ticket's
 * creation-time dependency block (blocked_by set at creation), never a human
 * review rejection. A rejection always comes from a presented gate — any other
 * prior status (ready / in_progress / in_review / …) is honored as before.
 */
export function isCreationTimeBlock(oldStatus) {
  const prev = String(oldStatus ?? "").trim().toLowerCase();
  return prev === "" || prev === "new" || prev === "todo";
}

// ─── Ticket Tracking at Creation ────────────────────────────────────────────────

/**
 * Track a ticket in workflow.agentTasks as soon as it's created.
 * This ensures the orchestrator knows about ALL tickets in a workflow from the start,
 * not just when they're invoked. Prevents invisible tickets blocking completion.
 *
 * Called from both Jira and DynamoDB paths when a ticket first appears.
 */
async function trackTicketCreation(ticketId, assignee, workflowId, parentId, spawnedBy) {
  if (!assignee || !parentId) return;

  // Skip epics — they're containers, not agent tasks
  const agentDef = getAgentDef(assignee);
  if (!agentDef) return;

  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) return;

  // Already tracked (e.g., from a retry/re-delivery) — don't overwrite
  if (workflow.agentTasks?.[ticketId]) return;

  const entry = {
    id: `task_${Date.now()}_${assignee}`,
    agentId: assignee,
    ticketId,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  const created = await store.trackTicket(workflow.id, ticketId, entry);
  if (!created) return; // concurrently tracked — keep the existing entry
  if (!workflow.agentTasks) workflow.agentTasks = {};
  workflow.agentTasks[ticketId] = entry;
  console.log(`[orchestrator] Tracked new ticket ${ticketId} (${assignee}) in workflow ${workflow.id}`);

  // Fan out a ticket.created event so the UI can render the badge without polling.
  // Keep the publish best-effort — failure here must not block tracking.
  try {
    const t = await getTicket(ticketId);
    await publishEvent(ticketId, "ticket.created", {
      workflowId: workflow.id,
      ticket: {
        id: ticketId,
        title: t?.title || ticketId,
        status: t?.status || "todo",
        assignee,
        parent: parentId,
        type: t?.type || "task",
        updatedAt: t?.updatedAt || new Date().toISOString(),
      },
    });
  } catch (err) {
    console.warn(`[orchestrator] ticket.created publish failed for ${ticketId}:`, err.message);
  }

  // TEAM-4166 D1 §1.4 — DERIVED awaited-ids hook. A freshly-created FIX ticket
  // whose spawnedBy points back to an origin (KIND_TO_ORIGIN_KEY[kind]) means the
  // origin is waiting on THIS fix: write the awaited edge on the origin now, so a
  // release manager parked on a sub-cap CHANGES-NEEDED re-wakes when the fix
  // closes even if the tool never explicitly reported the precondition. Idempotent
  // with the tool-report pickup (both converge on the same edge), mode-gated
  // (off → no-op before any I/O), and never fatal — must not fail ticket creation.
  if (AWAITED_IDS_MODE !== "off" && spawnedBy?.kind && KIND_TO_ORIGIN_KEY[spawnedBy.kind]) {
    try {
      await getAwaitedIds().applyAwaitedEdgesForSpawn(ticketId, spawnedBy, "spawnedBy");
    } catch (err) {
      console.warn(`[orchestrator] awaited-ids derived hook failed for ${ticketId} (non-fatal): ${err?.message || err}`);
    }
  }
}

// ─── Core Handlers ─────────────────────────────────────────────────────────────

/**
 * A ticket was marked "done". Unblock dependents, check QA gate, check completion.
 *
 * Exported solely so done-handlers-cascade.test.mjs can drive the REAL handler
 * end-to-end through the REAL cascade (TEAM-3688). No behavior change.
 */
export async function handleTicketDone(ticketId, image) {
  const parentId = unwrapDdbValue(image.parentId);
  const workflowId = unwrapDdbValue(image.workflowId);
  const assignee = unwrapDdbValue(image.assignee);

  if (!parentId) {
    console.log(`[orchestrator] ${ticketId} has no parent — likely an epic. Skipping cascade.`);
    return;
  }

  // Get the workflow metadata (resilient to bad workflowId from agent-created tickets)
  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) {
    console.warn(`[orchestrator] No workflow found for ${ticketId} (parent: ${parentId}, wf: ${workflowId})`);
    return;
  }

  // Playbook artifact-chain gate (see handleTicketDoneUnified). The gate consumes
  // only ticketId/assignee/title — all present on the DDB stream image — so build
  // the ticket in-hand instead of re-reading it. Symmetric with the webhook twin,
  // and (TEAM-4155 / TEAM-4121 FR-9) no extra ticket read while the observer flags
  // are off; the sole guarded getTicket below stays the only read on this path.
  if (await enforceArtifactChain({ ticketId, assignee, title: unwrapDdbValue(image.title) }, workflow)) return;

  // Update agent task status — scoped write (see handleTicketDoneUnified).
  await markTaskComplete(workflow, ticketId, assignee);
  await ackApprovedGateNotification(workflow, ticketId, assignee);
  await emitReviewResolvedApproved(workflow, ticketId, assignee);
  await wakeHeldTicketAfterEscalationGate(workflow, ticketId, unwrapDdbValue(image.title), assignee, parentId);

  // Unblock dependents via the shared cascade (TEAM-3618 D3). Same helper as the
  // Jira-webhook twin (handleTicketDoneUnified) — this path previously matched
  // only "blocked" dependents and emitted no orchestrator.unblocked events; the
  // shared helper fixes both divergences (now {blocked, todo} → Ready + journal).
  //
  // TEAM-3684 Finding 1: guard the invocation (symmetric with the webhook twin).
  // An unexpected throw must never skip the agent.complete publish or the
  // completion check below — treat a cascade failure as "unblocked nothing" so
  // the last ticket to close can still finalize the run.
  let unblocked = [];
  try {
    unblocked = await getCascade().cascadeUnblock(ticketId, parentId, workflow);
  } catch (err) {
    console.error(`[orchestrator] cascade failed for ${ticketId} — publishing completion anyway: ${err?.message || err}`);
  }

  // Publish event for UI
  await publishEvent(ticketId, "agent.complete", { ticketId, assignee, agentId: assignee, unblocked, workflowId: workflow?.id });

  // TEAM-4113 / TEAM-4121 FR-9 — observe the per-phase rework loop, then live
  // re-verification. The stream image is raw DDB, so fetch the normalized ticket
  // (plain spawnedBy/phase/fixContract) — ONE read shared by both observers, and
  // no read at all while both flags are off.
  if (REWORK_LOOP_CAP !== "off" || LIVE_REVERIFY !== "off") {
    const normalized = await getTicket(ticketId).catch(() => null);
    await observeReworkLoop(workflow, normalized);
    if (LIVE_REVERIFY !== "off") await observeLiveReverify(workflow, normalized);
  }

  // Check if workflow is complete (all tickets done)
  if (unblocked.length === 0) {
    if (await isWorkflowComplete(parentId, workflow, assignee)) {
      await completeWorkflow(workflow);
    }
  }

}

/**
 * A ticket is ready (status=todo/ready, no blockers). Invoke the assigned agent.
 */
async function handleTicketReady(ticketId, image) {
  const assignee = unwrapDdbValue(image.assignee);
  const parentId = unwrapDdbValue(image.parentId);
  const workflowId = unwrapDdbValue(image.workflowId);
  const ticketType = unwrapDdbValue(image.type);

  if (!assignee || ticketType === "epic") return;

  // Human-review gate: park for a person instead of invoking an agent.
  if (isHumanAssignee(assignee)) {
    const gateWorkflow = await resolveWorkflow(workflowId, parentId);
    if (gateWorkflow && gateWorkflow.phase === "cancelled") return;
    await handleHumanReviewGate(ticketId, assignee, gateWorkflow);
    return;
  }

  const agentDef = getAgentDef(assignee);
  if (!agentDef) {
    console.warn(`[orchestrator] Unknown agent: ${assignee}`);
    return;
  }

  // Get workflow metadata (resilient to bad workflowId from agent-created tickets)
  const workflow = await resolveWorkflow(workflowId, parentId);
  if (!workflow) {
    console.warn(`[orchestrator] No workflow for ticket ${ticketId} (workflowId=${workflowId}, parent=${parentId})`);
    return;
  }

  // ─── CD HANDOFF GUARD: no ship-phase work on a repo the hub does not deploy ───
  if (await skipShipTicketForHandoff(ticketId, agentDef, workflow)) return;

  // ─── SHIP-TICKET DISPATCH GATES (TEAM-4112 prereq + TEAM-4111 head stability) ───
  // Same gates as the Jira path — wired here so DynamoDB-stream mode has parity.
  // Both default off = byte-identical.
  if (SHIP_PHASES.has(agentDef.phase)) {
    if ((await evaluateShipTicketDispatch({ ticketId, parentId, agentDef, workflow })) === "skip") return;
  }

  // Idempotency claim — same atomic workflow-row lock as the Jira path.
  const claimed = await claimTicketInvocation(workflow, ticketId, assignee);
  if (!claimed) {
    console.log(`[orchestrator] ${ticketId} already claimed (running) — skipping duplicate invocation`);
    return;
  }

  // Belt & suspenders: also claim the ticket row (stream re-deliveries).
  try {
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "SET #s = :s, #u = :u",
      ConditionExpression: "#s <> :inprog",
      ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
      ExpressionAttributeValues: { ":s": "in_progress", ":inprog": "in_progress", ":u": new Date().toISOString() },
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log(`[orchestrator] ${ticketId} already in_progress — skipping duplicate invocation`);
      return;
    }
    throw err; // unexpected error — re-throw
  }

  // Ensure manifest exists (initializes on first agent invocation)
  try { await initManifestIfNeeded(workflow); } catch (err) {
    console.warn(`[orchestrator] Manifest init failed (non-fatal): ${err.message}`);
  }

  // Advance phase if needed (workflow-def driven, with software-delivery fallback)
  const wfDef = getEffectiveWorkflowDef(workflow); // framework overlay decides featureBranchPhase
  // Shared feature branch on the def's branch phase — independent of the phase
  // advance (see handleTicketReadyUnified for why). ensureFeatureBranch persists itself.
  if (wfDef.featureBranchPhase && agentDef.phase === wfDef.featureBranchPhase && !workflow.featureBranch && workflow.repoConfig?.repos?.length > 0) {
    workflow.featureBranch = await ensureFeatureBranch(workflow);
  }
  await announcePhaseTransition(workflow, wfDef, agentDef, ticketId);

  // Build context and invoke agent
  const ticket = await getTicket(ticketId);

  // ─── PRE-CI SYNC (TEAM-4122 FR-6) ───
  // Same hook as handleTicketReadyUnified, placed after getTicket because this
  // path only binds `ticket` here. See the unified path for the rationale; the
  // one behavioural note is that `conflict` returns BEFORE buildAgentContext, so
  // no context is built and no agent is invoked. off → not reached.
  if (SYNC_MAIN_BEFORE_CI !== "off" && agentDef?.agentId === CI_AGENT_ID && workflow.featureBranch) {
    const sync = await syncBeforeCi(workflow, ticket, syncDeps());
    if (sync.outcome === "conflict") {
      // TEAM-4131 F1: reason "round_cap" has NO fix ticket by design (the run is
      // parked for a human), so do not claim it is blocked on one.
      console.log(
        `[orchestrator] ${ticketId} held: ${workflow.featureBranch} cannot merge the default branch — ` +
        (sync.fixTicketId
          ? `blocked on ${sync.fixTicketId}`
          : `PARKED for a human after ${sync.round ?? "?"} sync_fix round(s) (${sync.reason || "conflict"})`)
      );
      return;
    }
  }

  let context = await buildAgentContext(ticket, workflow);

  // Prepend resume context on re-run: retry endpoint (ticket.resumeContext) or
  // review-gate rework (workflow.resumeContexts map). Both one-time use.
  const reworkNote = await consumeResumeContext(workflow, ticketId);
  let resumed = false;
  if (ticket?.resumeContext) {
    context = `${ticket.resumeContext}\n\n---\n\n${context}`;
    resumed = true;
    await ddb.send(new UpdateCommand({
      TableName: TICKETS_TABLE,
      Key: { ticketId },
      UpdateExpression: "REMOVE #rc",
      ExpressionAttributeNames: { "#rc": "resumeContext" },
    }));
  }
  if (reworkNote) {
    context = `${reworkNote}\n\n---\n\n${context}`;
    resumed = true;
  }

  console.log(`[orchestrator] Invoking agent ${assignee} for ticket ${ticketId}${resumed ? " (SESSION RESUME)" : ""}`);
  await publishEvent(ticketId, "agent.invoked", { ticketId, assignee, agentId: assignee, phase: agentDef.phase, workflowId: workflow.id });

  // Fire-and-forget: invoke agent via AgentCore Harness
  // The agent will call report_completion when done → writes "done" to DynamoDB → triggers this Lambda again
  await invokeAgent(agentDef, context, workflow, ticketId);
}

// ─── QA Gate ───────────────────────────────────────────────────────────────────

// TEAM-3686 Finding 4: completion can race a just-filed fix ticket. The
// children read behind the completion verdict goes through the eventually-
// consistent parentId-index GSI (Jira search is likewise lagged), so a
// reviewer/QA/ship agent that files a fix ticket and then reports its own
// ticket done can trigger a completion check against a snapshot where the fix
// isn't visible yet. When the trigger ticket belongs to a kind that spawns
// fixes (roster phases below, or a human review gate), a passing verdict is
// re-verified once after a short bounded delay before completion proceeds.
const FIX_SPAWNING_PHASES = new Set(["verification", "review", "ship"]);
const COMPLETION_RECHECK_DELAY_MS = 1500;

function mayHaveJustSpawnedFixes(assignee) {
  if (isHumanAssignee(assignee)) return true;
  const phase = getAgentDef(assignee)?.phase;
  return phase !== undefined && FIX_SPAWNING_PHASES.has(phase);
}

// Exported solely so completion-gates.test.mjs can drive the re-check seam.
export async function isWorkflowComplete(epicId, workflow, triggerAssignee) {
  await loadCdRegistry(); // effective def (ship phase or not) depends on it
  if (!(await evaluateCompletionSnapshot(epicId, workflow))) return false;
  if (mayHaveJustSpawnedFixes(triggerAssignee)) {
    await new Promise((r) => setTimeout(r, COMPLETION_RECHECK_DELAY_MS));
    if (!(await evaluateCompletionSnapshot(epicId, workflow))) {
      console.warn(
        `[orchestrator] CompletionRecheckFlipped ${workflow?.id}: verdict after ` +
          `${triggerAssignee} did not hold on re-read — a just-spawned fix ticket ` +
          `was invisible to the first snapshot; completion deferred.`
      );
      return false;
    }
  }
  return true;
}

async function evaluateCompletionSnapshot(epicId, workflow) {
  const children = await getChildTickets(epicId);
  if (children.length === 0) return false;

  const wfDef = getEffectiveWorkflowDef(workflow);

  // Resolve a gate ticket's guarded phase the same way handleReviewRejection
  // does — from the agent phase of the upstream tickets it blocks. Prefer any
  // in-memory child (no fetch); fall back to a lookup for out-of-batch upstreams.
  const childById = new Map(children.map((t) => [t.ticketId, t]));
  const gatePhaseOf = (gateTicket) => {
    if (typeof gateTicket.phase === "string" && gateTicket.phase) return gateTicket.phase;
    for (const upId of gateTicket.blockedBy || []) {
      const up = childById.get(upId);
      const phase = up && getAgentDef(up.assignee)?.phase;
      if (phase) return phase;
    }
    return undefined;
  };

  // TEAM-3619 D4c: per-phase re-verify (done work + approved gates + no open
  // fixes), or the legacy heuristic when the def declares no required phases.
  return evaluateWorkflowComplete(children, wfDef, {
    getAgentPhase: (assignee) => getAgentDef(assignee)?.phase,
    gatePhaseOf,
    requestedGates: workflow?.input?.reviewGates || [],
    // TEAM-4122 FR-7: completion.mjs reads no env (it is a pure module), so the
    // flag arrives as an option — "off" leaves its decision untouched.
    advisoryRouting: ADVISORY_ROUTING,
  });
}

// Exported solely so completion-gates.test.mjs can drive the evidence gate.
/**
 * TEAM-3985 — one manager_escalation per stranded run: "all tickets Done, but
 * completion is refused for missing evidence". Idempotent on notification id;
 * a human re-driving any ticket (re-Done) re-runs the check and, once the
 * evidence is in, the run completes and the escalation is history.
 */
async function notifyCompletionBlockedOnce(workflow, offenders) {
  const id = `notif_completion_evidence_${workflow.id}`;
  const list = Array.isArray(workflow.humanNotifications) ? workflow.humanNotifications : [];
  if (list.some((n) => n.id === id && !n.acknowledged)) return false;
  try {
    await publishEvent(workflow.epicId, "workflow.completion_blocked", {
      workflowId: workflow.id, reason: "missing_evidence", offenders,
    });
    await store.appendNotification(workflow.id, {
      id,
      type: "manager_escalation",
      title: "Run cannot complete: missing completion evidence",
      details: `Every ticket is Done but the completion evidence gate refused to close the run — no output/artifact recorded for ${offenders}. The agent probably moved its ticket to Done before report_completion wrote completions/<ticket>.json. If the record exists now, re-Done any ticket to re-check; otherwise add the evidence (or set COMPLETION_EVIDENCE_REQUIRED=off) and re-check.`,
      reviewer: "completion-gate",
      timestamp: new Date().toISOString(),
      acknowledged: false,
    });
    console.log(`[orchestrator] ${workflow.id}: completion blocked on evidence — manager_escalation appended (${offenders})`);
    return true;
  } catch (err) {
    console.warn(`[orchestrator] ${workflow.id}: completion-blocked notification failed (non-fatal): ${err?.message || err}`);
    return false;
  }
}

/**
 * PR description for a CD HANDOFF run: the hub opened the PR but will not
 * merge or deploy — say so where the owning team will read it.
 */
function handoffPrBody(workflow, baseBranch) {
  const title = workflow.input?.title || workflow.id;
  return [
    `Automated implementation by the AgentCore Hub agent team (${workflow.epicId}).`,
    ``,
    `**Handoff — this repository is not in the hub's CD registry.** The hub does not merge or deploy it: `,
    `code review, QA verification and CI have run on \`${workflow.featureBranch}\`, and this PR against `,
    `\`${baseBranch}\` is left open for the owning team to review, merge and deploy.`,
    ``,
    `- Feature: ${title}`,
    `- Workflow run: ${workflow.id}`,
    `- Ticket: ${workflow.epicId}`,
    `- Evidence: the run's review, QA and CI reports are attached to the tickets above and in the hub's workflow artifacts (\`workflows/${workflow.id}/shared/\`).`,
  ].join("\n");
}

export async function completeWorkflow(workflow) {
  if (workflow.phase === "complete") return;
  // The delivery decision (CD vs HANDOFF) below is taken from the registry as it
  // is NOW — refresh past the TTL so a repo registered mid-run is honored.
  await loadCdRegistry();
  // TEAM-3987-adjacent hygiene: a run that is ALREADY terminal (cancelled,
  // deploy-blocked, static-ci-only, error) owes nothing — but the caller's
  // snapshot can predate the terminal write (cancel marks every open ticket Done,
  // and each of those Done events re-enters here with a stale in-flight phase).
  // Re-read the phase so a cancelled run never gets a completion attempt, a
  // ship-verdict close, or a "completion blocked on evidence" escalation
  // (prod 22:50Z: wf_bug_TEAM-3976 was cancelled and immediately escalated).
  let livePhase = workflow.phase;
  try {
    livePhase = (await store.getWorkflow(workflow.id))?.phase ?? workflow.phase;
  } catch (err) {
    // Fail open on the read: the gates below have their own parity guards and
    // must never be blocked by this hygiene check (route parity).
    console.warn(`[orchestrator] ${workflow.id}: live-phase read failed, using snapshot phase: ${err?.message || err}`);
  }
  if (TERMINAL_WORKFLOW_PHASES.includes(livePhase)) {
    if (livePhase !== workflow.phase) {
      console.log(`[orchestrator] ${workflow.id}: completion skipped — run is already ${livePhase}`);
    }
    return;
  }

  // TEAM-3686 Finding 3: deliverable-evidence gate — same semantics as the HTTP
  // complete route (TEAM-3619 D4a). Every done ticket in a completion-required
  // phase must have real work behind it (non-empty agentTasks output or an
  // artifact). Enforced by default (TEAM-3690): missing evidence → abort
  // completion. Only the explicit opt-out COMPLETION_EVIDENCE_REQUIRED=off|false|0
  // falls back to shadow-log-and-continue. Read-only (R2): children via the provider read,
  // agentTasks via a consistent workflow re-read (the in-memory copy can lag
  // the webhook's output merge). Mirroring the route, a FAILURE of the check
  // itself never blocks a legitimate completion — it only tightens when it can
  // prove a phantom deliverable.
  try {
    const wfDef = getEffectiveWorkflowDef(workflow);
    const requiredPhases = wfDef.completionRequiresAgentPhases || [];
    if (requiredPhases.length > 0) {
      const children = gateChildren(await getChildTickets(workflow.epicId));
      const evidenceOpts = { getAgentPhase: (assignee) => getAgentDef(assignee)?.phase };
      let freshWf = await store.getWorkflow(workflow.id);
      let missing = missingEvidenceTickets(
        children, freshWf?.agentTasks || workflow.agentTasks || {}, requiredPhases, evidenceOpts
      );
      if (missing.length > 0) {
        // TEAM-3985 — the done-cascade harvest is a single point-in-time read,
        // and agents routinely transition their ticket BEFORE report_completion
        // lands completions/{ticketId}.json (sffzti/TEAM-3790: Done 19:37Z, record
        // 19:50Z). The record exists by the time the LAST ticket closes, so
        // re-harvest the offenders here and re-evaluate before rejecting.
        for (const m of missing) {
          try { await harvestCompletionEvidence(freshWf || workflow, m.ticketId); }
          catch (err) { console.warn(`[orchestrator] evidence re-harvest failed for ${m.ticketId}: ${err?.message || err}`); }
        }
        freshWf = await store.getWorkflow(workflow.id);
        missing = missingEvidenceTickets(
          children, freshWf?.agentTasks || workflow.agentTasks || {}, requiredPhases, evidenceOpts
        );
      }
      // TEAM-3976 — second pass, still needed after the TEAM-3985 re-harvest above:
      // the harvest only makes the agentTasks-only gate pass when the record has a
      // non-empty `summary` (it maps summary→output). A record whose deliverable
      // proof is pr_url / commit_sha / artifacts with a blank summary still fails
      // that check. This pass is the twin of the HTTP route's rule (summary OR
      // pr_url OR commit_sha OR non-empty artifacts counts as evidence; a blank
      // record does not), consulted for the remaining offenders ONLY — no S3 reads
      // on the happy path. Read/backfill failures keep the offender, so the
      // escalation below fires only for what survives BOTH passes.
      if (missing.length > 0 && ARTIFACT_BUCKET) {
        const before = missing;
        missing = await resolveMissingEvidenceFromRecords(missing, freshWf?.agentTasks || workflow.agentTasks || {}, {
          readCompletionRecord: async (tid) => {
            try {
              const res = await s3.send(new GetObjectCommand({
                Bucket: ARTIFACT_BUCKET,
                Key: `completions/${tid}.json`,
              }));
              return JSON.parse(await res.Body.transformToString());
            } catch (err) {
              const code = err?.name || err?.Code || "";
              if (code === "NoSuchKey" || code === "NotFound" || err?.$metadata?.httpStatusCode === 404) return null;
              throw err; // logged by the resolver; offender stays
            }
          },
          backfill: (tid, fields) => store.mergeTaskMetadata(workflow.id, tid, fields),
          log: console.warn,
        });
        const stillMissing = new Set(missing.map((m) => m.ticketId));
        for (const m of before) {
          if (!stillMissing.has(m.ticketId)) {
            console.log(`[orchestrator] completion evidence resolved from completions record for ${m.ticketId}`);
          }
        }
      }
      if (missing.length > 0) {
        const offenders = missing.map((m) => `${m.ticketId}@${m.phase}`).join(", ");
        if (COMPLETION_EVIDENCE_REQUIRED) {
          console.error(
            `[orchestrator] CompletionRejectedMissingEvidence ${workflow.id}: ${offenders}`
          );
          // A silent rejection strands the run with no live task, no gate and no
          // notification — nothing ever revisits it. Escalate ONCE so a human (or
          // the WM) sees why "every ticket is Done but the run never finished".
          await notifyCompletionBlockedOnce(freshWf || workflow, offenders);
          return;
        }
        console.warn(
          `[orchestrator] ${workflow.id} would be blocked for missing evidence (shadow opt-out): ${offenders}`
        );
      }
    }
  } catch (err) {
    console.warn(`[orchestrator] evidence check skipped for ${workflow.id}: ${err?.message || err}`);
  }

  // ── TEAM-3760: TWO ship gates run here, in this order, both at full strength.
  //   1. TEAM-3747 D2 ship-verdict gate (below): INTERNAL evidence, fail-CLOSED.
  //      A done ship ticket with no merge/deploy verdict closes the run on an
  //      honest TERMINAL outcome (deploy-blocked / static-ci-only).
  //   2. TEAM-3721 SHIP_MERGE_VERIFY gate (after it): EXTERNAL GitHub ground
  //      truth, fail-OPEN. A branch PROVABLY unmerged leaves the run OPEN
  //      (workflow.cd_unmerged) for the RM/WM to repair.
  // D2 must run first: it terminally closes the "nothing recorded shipped" runs,
  // so merge-verify only ever sees runs whose recorded evidence CLAIMS a ship —
  // and then cross-checks that claim against GitHub. Reversed, an unmerged run
  // with no ship verdict would be left open by gate 2 and never reach gate 1 —
  // exactly the silent CD dead-zone stall D2 exists to kill. (D2 first is also
  // free: local reads, no GitHub call, for runs that will terminally close.)

  // TEAM-3747 D2 — ship/CD merge-verdict gate: NO green close over unshipped work.
  // If the def has a ship phase, a done ship ticket must carry a merge/deploy
  // verdict (merge commit) OR an explicit deploy-blocked outcome. When neither is
  // present the run did NOT actually ship, so we close it on the HONEST terminal
  // outcome (deploy-blocked when a block was recorded, else static-ci-only) and
  // emit a TERMINAL verdict event — never a silent stall, never a fake "complete".
  // Reuses COMPLETION_EVIDENCE_REQUIRED (fail-closed: enforce by default; a
  // fail-open here would defeat the whole deliverable). The explicit opt-out
  // COMPLETION_EVIDENCE_REQUIRED=off|false|0 only shadow-logs and proceeds.
  // TEAM-3986 — the release manager's report_completion tool has no
  // outcome/merge_commit field, so the self-reported ship verdict can NEVER read
  // "shipped" (commitSha is deliberately not proof: it is the branch HEAD). Every
  // merged-and-deployed run therefore closed as static-ci-only. GitHub is the
  // ground truth the TEAM-3721 gate already consults — consult it FIRST, and when
  // it proves the merge, stamp the ship tasks with the merge commit so the
  // verdict below (and the dashboard) tell the truth. Unknown → self-report decides.
  const shipMergeVerify = !["off", "false", "0"].includes(
    String(process.env.SHIP_MERGE_VERIFY || "").trim().toLowerCase()
  );
  const mergeVerifyConfigured = Boolean(
    shipMergeVerify && defHasShipPhase(workflow) && workflow.featureBranch &&
    workflow.repoConfig && process.env.GITHUB_PAT
  );
  let mergeProof = null;
  if (mergeVerifyConfigured) {
    const probe = await featureBranchMergeProbe(workflow);
    if (probe.merged === false) {
      // TEAM-4110 merge-on-green: a human-approved, clean+green PR should not be
      // left open on cd_unmerged (which has no consumer). Attempt the merge here.
      // Default off → mergeApprovedGreenPr returns skip with zero I/O, so this is
      // byte-identical to pre-4110. On "merged", take the proof from the merge and
      // fall through to the ship-verdict stamping below (verdict reads merged);
      // any other outcome keeps the existing cd_unmerged + return.
      const mog = await getMergeOnGreen().mergeApprovedGreenPr(workflow, probe);
      if (mog.outcome === "merged") {
        mergeProof = { merged: true, mergeCommit: mog.mergeCommit || "", prUrl: mog.prUrl || "" };
        console.log(
          `[orchestrator] ${workflow.id}: merge-on-green merged ${workflow.featureBranch} ` +
            `(${mergeProof.mergeCommit || "squash"}) — proceeding to completion`
        );
      } else {
        console.error(
          `[orchestrator] CompletionRejectedUnmergedBranch ${workflow.id}: ` +
            `feature branch ${workflow.featureBranch} is not merged into the base ` +
            `(${probe.reason}). CD did not land the merge — leaving run open.`
        );
        await publishEvent(workflow.epicId, "workflow.cd_unmerged", {
          workflowId: workflow.id,
          featureBranch: workflow.featureBranch,
          reason: probe.reason,
          mergeOnGreen: mog.outcome,
        });
        return;
      }
    }
    if (probe.merged === true) mergeProof = probe;
  }

  try {
    const wfDef = getEffectiveWorkflowDef(workflow);
    const requiredPhases = wfDef.completionRequiresAgentPhases || [];
    const shipPhases = requiredPhases.filter((p) => SHIP_PHASES.has(p));
    if (shipPhases.length > 0) {
      const children = gateChildren(await getChildTickets(workflow.epicId));
      let freshWf = await store.getWorkflow(workflow.id);
      const shipOpts = { getAgentPhase: (assignee) => getAgentDef(assignee)?.phase };
      let verdict = evaluateShipVerdict(
        children, freshWf?.agentTasks || workflow.agentTasks || {}, shipPhases, shipOpts
      );
      if (verdict.required && !verdict.shipped && mergeProof) {
        // Stamp GitHub's proof onto ship tasks that self-reported nothing. A
        // recorded BLOCK outcome is never overwritten — a block is a block.
        for (const o of verdict.offenders) {
          if (o.verdict && o.verdict !== "none") continue;
          const fields = {
            mergeCommit: mergeProof.mergeCommit || `merged:${workflow.featureBranch}`,
            mergeVerifiedBy: "github",
          };
          if (mergeProof.prUrl && !freshWf?.agentTasks?.[o.ticketId]?.prUrl) fields.prUrl = mergeProof.prUrl;
          try { await store.mergeTaskMetadata(workflow.id, o.ticketId, fields); }
          catch (err) { console.warn(`[orchestrator] merge-proof stamp failed for ${o.ticketId}: ${err?.message || err}`); }
        }
        console.log(`[orchestrator] ${workflow.id}: GitHub proves ${workflow.featureBranch} merged (${mergeProof.mergeCommit || "compare"}) — ship verdict taken from ground truth`);
        freshWf = await store.getWorkflow(workflow.id);
        verdict = evaluateShipVerdict(
          children, freshWf?.agentTasks || workflow.agentTasks || {}, shipPhases, shipOpts
        );
      }
      if (verdict.required && !verdict.shipped) {
        const offenders = verdict.offenders.map((o) => `${o.ticketId}@${o.phase}:${o.verdict}`).join(", ");
        if (COMPLETION_EVIDENCE_REQUIRED) {
          await closeWorkflowBlocked(workflow, verdict);
          return;
        }
        console.warn(
          `[orchestrator] ${workflow.id} would close as ${verdict.outcome} (shadow opt-out) — ship verdict missing: ${offenders}`
        );
      }
    }
  } catch (err) {
    // Never let the ship-verdict resolution itself turn a legitimate completion
    // into a stall — it only diverts when it can prove work never shipped.
    console.warn(`[orchestrator] ship-verdict check skipped for ${workflow.id}: ${err?.message || err}`);
  }

  // Ship-phase merge gate (TEAM-3721 CD dead-zone): a def with a "ship" phase
  // has the release manager own the merge, and the CD ticket can be marked done
  // even though the PR was never actually merged (RM BLOCKs in preflight, or the
  // merge step silently no-ops). Trusting ticket status alone let such a run
  // finalize as "complete" with main untouched — the exact false-complete we hit.
  // Before claiming completion, verify against GitHub that the feature branch is
  // truly merged. Not merged → abort completion so the run stays open (the CD
  // ticket / WM surfaces it) instead of lying. Best-effort: a GitHub/API failure
  // (or no PAT) never blocks a legitimate completion — it only tightens when it
  // can PROVE the branch is unmerged. Opt-out: SHIP_MERGE_VERIFY=off.
  const completedAt = new Date().toISOString();
  const won = await store.completeWorkflow(workflow.id, completedAt);
  if (!won) {
    // A previous completer may have died between the claim and its side
    // effects (Lambda timeout/kill). If the row is complete but never
    // finalized and the claim is old, take over finalization exactly once.
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const takeover = await store.claimFinalization(workflow.id, staleBefore);
    if (!takeover) {
      console.log(`[orchestrator] Workflow ${workflow.id} already completed/terminal — skipping duplicate completion.`);
      return;
    }
    console.log(`[orchestrator] Workflow ${workflow.id} complete but unfinalized — taking over side effects.`);
  }
  console.log(`[orchestrator] Workflow ${workflow.id} complete!`);

  workflow.phase = "complete";
  workflow.completedAt = completedAt;

  // Create unified PR if feature branch exists — unless the def has a "ship"
  // phase: there the release manager owns the PR, and by completion time the
  // branch is already merged (create_pr here would 422 "no commits between").
  const defHasShip = defHasShipPhase(workflow);
  const delivery = getDelivery(workflow);
  let prUrl = "";
  if (!defHasShip && workflow.featureBranch && workflow.repoConfig) {
    try {
      const { owner, repo } = parseRepoUrl(workflow.repoConfig);
      const baseBranch = workflow.repoConfig.repos?.[0]?.defaultBranch || "main";
      const prResult = await callGitHub("create_pr", {
        owner,
        repo,
        title: `feat: ${workflow.input.title} (${workflow.epicId})`,
        body: delivery.mode === "handoff"
          ? handoffPrBody(workflow, baseBranch)
          : `Automated implementation by agentic team workflow (${workflow.epicId}).`,
        head: workflow.featureBranch,
        base: baseBranch,
      });
      prUrl = prResult?.html_url || "";
      console.log(`[orchestrator] Created PR: ${prUrl}${delivery.mode === "handoff" ? " (CD handoff — left open for the owning team)" : ""}`);
    } catch (err) {
      console.warn(`[orchestrator] PR creation failed: ${err.message}`);
    }
  }

  // Record how the run was delivered so the UI can say "handed off (PR open)"
  // vs "merged + deployed" without re-deriving it from the registry later
  // (the registry can change after the fact). Best-effort.
  try {
    await store.setDelivery(workflow.id, {
      mode: delivery.mode,
      ...(delivery.pipeline ? { pipeline: delivery.pipeline } : {}),
      ...(prUrl ? { prUrl } : {}),
      at: completedAt,
    });
  } catch (err) {
    console.warn(`[orchestrator] ${workflow.id}: could not record delivery mode: ${err.message}`);
  }

  // Roll the epic ticket up so the board reflects the closure. Without this the
  // run shows phase=complete while its epic sits in To Do/In Progress forever —
  // the exact gap that leaves runs "open" and drives the watch loop. Best-effort:
  // a board with no Done transition just logs and moves on.
  if (TICKET_PROVIDER === "jira" && workflow.epicId) {
    const rolled = await jiraTransition(workflow.epicId, "Done");
    if (!rolled) {
      console.warn(`[orchestrator] epic ${workflow.epicId} roll-up to Done skipped (no transition)`);
    }
  }

  await publishEvent(workflow.epicId, "workflow.complete", {
    workflowId: workflow.id,
    featureBranch: workflow.featureBranch,
    prUrl,
    delivery: delivery.mode,
  });

  // Durable marker that the side effects above all ran — the takeover path's
  // claim checks this so a completer killed mid-finalization gets resumed.
  await store.markFinalized(workflow.id);
}

/**
 * TEAM-3747 D2 — close a run on an HONEST terminal ship outcome instead of a fake
 * "complete". Mirrors completeWorkflow's side-effect discipline: an ATOMIC,
 * idempotent phase claim (store.claimTerminalOutcome CASes off any terminal phase,
 * so concurrent cascades and stream re-deliveries yield exactly one winner), then
 * — winner only — a best-effort PR label, a TERMINAL verdict event, and the
 * finalized marker. The event type is workflow.deploy_blocked / workflow.static_ci_only
 * but ALSO carries an `outcome` field, so a consumer that only knows
 * "workflow.complete" can still branch on `outcome` — the close is never silent.
 */
async function closeWorkflowBlocked(workflow, verdict) {
  const outcome = verdict.outcome; // one of SHIP_BLOCKED_OUTCOMES
  const completedAt = new Date().toISOString();
  const won = await store.claimTerminalOutcome(workflow.id, outcome, completedAt, verdict.blockReason);
  if (!won) {
    console.log(`[orchestrator] Workflow ${workflow.id} already terminal — skipping duplicate ${outcome} close.`);
    return;
  }
  const offenders = verdict.offenders.map((o) => `${o.ticketId}@${o.phase}:${o.verdict}`).join(", ");
  console.error(`[orchestrator] Workflow ${workflow.id} closed ${outcome} (not shipped): ${offenders}`);

  workflow.phase = outcome;
  workflow.completedAt = completedAt;
  if (verdict.blockReason) workflow.blockReason = verdict.blockReason;

  // Find a PR to label — prefer a prUrl harvested onto an offending ship ticket
  // (harvestCompletionEvidence stashes record.pr_url there). Re-read for freshness.
  let prUrl = "";
  try {
    const freshWf = await store.getWorkflow(workflow.id);
    const tasks = freshWf?.agentTasks || workflow.agentTasks || {};
    for (const o of verdict.offenders) {
      const entry = tasks[o.ticketId];
      if (entry && typeof entry.prUrl === "string" && entry.prUrl) { prUrl = entry.prUrl; break; }
    }
  } catch { /* best-effort */ }

  // Surface the block on the review surface via a PR label. Best-effort by
  // contract: a missing PAT / label / PR must never turn the terminal close
  // into a throw (that would leave the run wedged, the exact failure we fix).
  if (prUrl) {
    try {
      await labelPullRequest(prUrl, outcome);
    } catch (err) {
      console.warn(`[orchestrator] PR label ${outcome} skipped for ${prUrl}: ${err?.message || err}`);
    }
  }

  await publishEvent(
    workflow.epicId,
    outcome === "deploy-blocked" ? "workflow.deploy_blocked" : "workflow.static_ci_only",
    {
      workflowId: workflow.id,
      outcome,
      reason: verdict.blockReason || null,
      offenders: verdict.offenders,
      prUrl,
      featureBranch: workflow.featureBranch,
    }
  );

  await store.markFinalized(workflow.id);
}

/**
 * TEAM-3747 D2 — add a label to the PR behind a github.com/{owner}/{repo}/pull/{N}
 * URL (issues + PRs share the labels endpoint). Validates the URL so a malformed
 * prUrl throws to the caller's warn rather than hitting the wrong endpoint; the
 * label is created on demand by GitHub if it doesn't exist yet.
 */
async function labelPullRequest(prUrl, label) {
  const m = String(prUrl || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`unrecognized PR url: ${prUrl}`);
  const [, owner, repo, number] = m;
  await githubApi(`/repos/${owner}/${repo}/issues/${number}/labels`, "POST", { labels: [label] });
}

// ─── Agent Invocation ──────────────────────────────────────────────────────────

/**
 * Discover harness ARN and invoke the agent.
 * Fire-and-forget: agent runs asynchronously. When done, it calls report_completion
 * which writes "done" to DynamoDB, triggering this Lambda again via the stream.
 */
async function invokeAgent(agentDef, context, workflow, ticketId) {
  // Discover agent ARN — prefer runtimeArn from roster, then env var lookup
  const runtimeEnvKey = `RUNTIME_ARN_${agentDef.agentId.toUpperCase()}`;
  const harnessEnvKey = `HARNESS_ARN_${agentDef.agentId.toUpperCase()}`;
  const harnessArn = agentDef.runtimeArn || process.env[runtimeEnvKey] || process.env[harnessEnvKey];
  if (!harnessArn) {
    console.error(`[orchestrator] No ARN for agent: ${agentDef.agentId}. Tried ${runtimeEnvKey} and ${harnessEnvKey}. Marking ticket blocked.`);
    // Publish the error FIRST — the ticket-blocking below can fail (e.g. the
    // tickets table doesn't exist in Jira mode) and the Workflow Manager needs
    // an agent.error event to distinguish "never started" from "hung".
    await publishEvent(workflow.epicId, "agent.error", {
      agentId: agentDef.agentId,
      workflowId: workflow.id,
      ticketId: ticketId || "",
      error: `No runtime ARN configured. Set ${runtimeEnvKey} env var on orchestrator Lambda.`,
    });
    await releaseClaimOnFailure(workflow.id, ticketId);
    await blockTicketForFailedInvoke(ticketId, "no runtime ARN configured");
    return;
  }
  console.log(`[orchestrator] Using ${harnessArn.includes("/runtime/") ? "Runtime" : "Harness"} for ${agentDef.agentId}`);

  // Determine model override
  let modelConfig = undefined;
  if (workflow.input?.modelOverride) {
    let override = workflow.input.modelOverride;
    if (typeof override === "string") {
      const modelMap = {
        "opus": "us.anthropic.claude-opus-5",
        "sonnet": "us.anthropic.claude-sonnet-5",
        "claude-opus-47": "us.anthropic.claude-opus-5",
        "claude-opus-46": "us.anthropic.claude-opus-5",
        "claude-sonnet-46": "us.anthropic.claude-sonnet-5",
        "claude-sonnet-45": "us.anthropic.claude-sonnet-5",
      };
      override = { bedrockModelConfig: { modelId: modelMap[override] || override } };
    }
    modelConfig = override;
  }

  try {
    // Use BedrockAgentRuntime InvokeAgent — fire and forget
    // The agent stream will run to completion. When done, the agent's report_completion
    // tool writes "done" status to DynamoDB, which triggers this Lambda via stream.
    // Prefix with ticketId so OTEL traces are discoverable by Jira ticket in the Ticket History page
    const ticketPrefix = ticketId ? `${ticketId}_` : "";
    const sessionId = `${ticketPrefix}${workflow.id}-${agentDef.agentId}-${Date.now()}`;

    const command = new InvokeAgentCommand({
      agentAliasId: "TSTALIASID", // placeholder — real ARN used via agentId
      agentId: harnessArn.split("/").pop(),
      sessionId,
      inputText: context,
      ...(modelConfig?.bedrockModelConfig ? { bedrockModelArn: modelConfig.bedrockModelConfig.modelId } : {}),
    });

    // Note: In production, we'd use the AgentCore Harness SDK's invokeHarnessAgent
    // For now, invoke as a separate async Lambda that handles the streaming
    await lambda.send(new InvokeCommand({
      FunctionName: "agentcore-hub-agent-invoker",
      InvocationType: "Event", // async — don't wait for response
      Payload: JSON.stringify({
        harnessArn,
        sessionId,
        prompt: context,
        workflowId: workflow.id,
        agentId: agentDef.agentId,
        ticketId: ticketId || "",
        modelOverride: modelConfig,
        // Routine-scoped connectors travel with the workflow → each agent invoke.
        connectors: workflow.connectors,
        // Fleet-wide watchdog knobs (D1.1), resolved from the S3 agents.json
        // config: heartbeat cadence + tool/turn deadlines the runtime enforces.
        watchdog: resolveWatchdog(agentDef.agentId),
      }),
    }));

    console.log(`[orchestrator] Async invoke sent for ${agentDef.agentId} (session: ${sessionId})`);

    // Journey log: agent invocation dispatched
    await publishEvent(ticketId || agentDef.agentId, "orchestrator.agent_invoked", {
      ticketId: ticketId || "", agentId: agentDef.agentId, sessionId,
      workflowId: workflow.id, runtimeArn: harnessArn,
    });

    // Persist session info to the workflow manifest (S3) for health probes and traceability
    try {
      await updateManifestSession(workflow.id, agentDef.agentId, {
        sessionId,
        runtimeArn: harnessArn,
        invokedAt: new Date().toISOString(),
        ticketId,
      });
    } catch (err) {
      console.warn(`[orchestrator] Manifest session write failed (non-fatal): ${err.message}`);
    }
  } catch (err) {
    console.error(`[orchestrator] Failed to invoke ${agentDef.agentId}:`, err);
    // Error event first — see the no-ARN path above for why.
    await publishEvent(workflow.epicId, "agent.error", {
      agentId: agentDef.agentId,
      workflowId: workflow.id,
      ticketId: ticketId || "",
      error: `Invoke failed: ${err.message}`,
    });
    await releaseClaimOnFailure(workflow.id, ticketId);
    await blockTicketForFailedInvoke(ticketId, `invoke failed: ${err.message}`);
  }
}

/**
 * Reset agentTasks[ticketId].status after a failed invoke so the atomic claim
 * doesn't block the retry (manual "Ready" transition or WM dispatch). Without
 * this the entry stays "running" forever and every retry is rejected as a
 * duplicate. Best-effort.
 */
async function releaseClaimOnFailure(workflowId, ticketId) {
  if (!ticketId) return;
  try {
    await store.setTaskStatus(workflowId, ticketId, "error");
  } catch (err) {
    console.warn(`[orchestrator] releaseClaimOnFailure(${ticketId}): ${err.message}`);
  }
}

/**
 * Park a ticket whose agent invoke failed, provider-aware. In Jira mode the
 * DynamoDB tickets table is optional/absent — the old direct DDB write threw
 * ResourceNotFoundException, which killed the handler and left the ticket
 * showing In Progress forever with no error event (the TEAM-2229 stall). Jira
 * mode transitions the issue to Blocked (fallback To Do) and leaves a comment
 * so the failure is visible on the board. Best-effort: never throws.
 */
async function blockTicketForFailedInvoke(ticketId, reason) {
  if (!ticketId) return;
  try {
    if (TICKET_PROVIDER === "jira") {
      const moved = (await jiraTransition(ticketId, "Blocked")) || (await jiraTransition(ticketId, "To Do"));
      if (!moved) console.warn(`[orchestrator] Could not park ${ticketId} after failed invoke`);
      await jiraFetch(`/rest/api/3/issue/${ticketId}/comment`, "POST", {
        body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `AgentCore Hub: agent invoke failed (${reason}). Move this ticket back to Ready to retry once the cause is fixed.` }] }] },
      });
    } else {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #s = :s, #u = :u",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":s": "blocked", ":u": new Date().toISOString() },
      }));
    }
  } catch (err) {
    console.warn(`[orchestrator] blockTicketForFailedInvoke(${ticketId}) failed: ${err.message}`);
  }
}

// ─── Context Builder ───────────────────────────────────────────────────────────

/**
 * TEAM-4093 (ship-review F2) — render ONE "## Input Sources" line for an intake
 * source, carrying its intake-time verification verdict into the agent's prompt.
 *
 * PR #371 (TEAM-4054) made SOURCE_VALIDATION_MODE=lenient the default: a source
 * whose reachability check fails no longer rejects the submit — it is accepted
 * and persisted with `verification.status="unverified"` plus an already-redacted
 * `detail`. For a cross-account s3:// source that detail carries the
 * ACCESS_DENIED_HINT naming the bucket-policy grant the hub-account runtime
 * agents need. That verdict never reached the intake agent, so a paid run began
 * with the agent believing every source was readable — and the actionable grant
 * hint was dropped. Surface it inline.
 *
 * `detail` is ALREADY redacted upstream (src/lib/workflow/intake.ts → redactUrl)
 * — do NOT re-redact or reshape it here. Missing/empty/non-string detail falls
 * back to a generic phrase so an older row can never print "undefined". Sources
 * with no `verification` field at all (every row written before TEAM-4054), and
 * verified sources, render exactly as they did before.
 */
export function formatSourceLine(source) {
  const src = source ?? {};
  let line = `- [${src.type}] ${src.label || src.value}`;
  const status = src.verification?.status;
  if (status === "unverified") {
    const detail = src.verification?.detail;
    const text = typeof detail === "string" && detail.trim() ? detail : "reachability check failed";
    line += ` — UNVERIFIED at intake: ${text}`;
  } else if (status === "skipped") {
    line += ` — not network-validated`;
  }
  return line;
}

// Exported solely for cd-handoff.test.mjs (Delivery Mode / roster / gates block).
export async function buildAgentContext(ticket, workflow) {
  await loadCdRegistry(); // the Delivery Mode block below reads it
  // Pure registry read, hoisted: the phase decides which blocks this persona
  // gets (## Unverified Fixes below, the manifest, the dev branch identity).
  const agentDef = getAgentDef(ticket.assignee);
  let context = `# Your Assignment: ${ticket.title}\n\n`;
  context += `## Ticket\nID: ${ticket.ticketId}\nDescription: ${ticket.description}\n\n`;

  // Workflow identifiers
  context += `## Workflow Context\n`;
  context += `workflow_id: ${workflow.id}\n`;
  context += `epic_id: ${workflow.epicId}\n`;
  context += `ticket_id: ${ticket.ticketId}\n\n`;

  // Shipped laptop session: the requester planned this work in a live coding
  // session and shipped it here. Visible to EVERY agent — the transcript is the
  // authoritative context, and the branch already carries in-flight work.
  const ported = workflow.input?.portedSession;
  if (ported?.sessionId) {
    context += `## Ported Session\n`;
    context += `The requester pre-planned this work in a live coding session and shipped it to this workflow. `;
    context += `The session transcript contains the research, decisions, and constraints — it is the authoritative context for this run.\n`;
    context += `coding_session_id: ${ported.sessionId}\n`;
    context += `cli: ${ported.cli || "claude"}\n`;
    if (ported.repo) context += `repo: ${ported.repo}\n`;
    context += `ported_branch: ${ported.branch} (already contains the requester's in-flight work — build on it, never discard it)\n`;
    context += `To resume the session, pass resume_session="${ported.sessionId}" on your FIRST ${ported.cli === "codex" ? "codex" : "claude_code"} call — it continues the requester's exact conversation and workspace.\n`;
    context += `Intake/requirements: resume it to read the plan out of the conversation before writing tickets. `;
    context += `Dev agents: resume it and continue the work in place. `;
    context += `Review/QA: verify the branch independently — do NOT resume the dev conversation; inspect the code and run your own checks.\n\n`;
  }

  // This agent's OWN prior coding session in this workflow (fix tickets,
  // re-reviews, serially-chained tickets). Default = resume: the conversation
  // already holds the repo context, findings, and decisions — rebuilding it
  // from scratch every loop burns tokens and loses what the agent knew.
  // findCodingSession is per (workflow, agentId), so a reviewer only ever gets
  // its own review session back, never the dev's conversation.
  try {
    const priorSession = await findCodingSession(workflow.id, ticket.assignee);
    if (priorSession) {
      context += `## Prior Coding Session (resume by DEFAULT)\n`;
      context += `You already have a coding session in this workflow: ${priorSession}\n`;
      context += `Pass resume_session="${priorSession}" on your FIRST claude_code/codex/kiro call — it restores YOUR prior conversation and workspace (the code you wrote or reviewed, your findings, your decisions) instead of rebuilding that context from scratch.\n`;
      context += `- Fix ticket from review/QA: ALWAYS resume — you are continuing the same work.\n`;
      context += `- Re-review / re-verify after fixes: resume — you know what you found; verify it was fixed.\n`;
      context += `- Start fresh ONLY if the ticket explicitly calls for a clean-slate redo of a rejected approach.\n`;
      context += `Resume is best-effort: if the session is gone you start fresh automatically. This supersedes any Ported Session instruction above — your own session already contains it.\n\n`;
    }
  } catch { /* hint is optional */ }

  // For the intake agent only: provide the valid agent roster (registry data),
  // scoped to agents belonging to this workflow definition.
  const wfDef = getEffectiveWorkflowDef(workflow);
  const deliveryForContext = getDelivery(workflow);
  if (ticket.assignee === wfDef.intakeAgentId) {
    // HANDOFF run: the ship-phase personas (release manager) are not offered at
    // all — the hub does not merge or deploy this repo, so there is no Ship/CD
    // ticket to plan. The dispatch guard in handleTicketReady* backstops this.
    const roster = (_agentRoster || FALLBACK_ROSTER)
      .filter(a => a.agentId !== wfDef.intakeAgentId)
      .filter(a => (a.workflowDefIds || [a.workflowDefId || DEFAULT_WORKFLOW_DEF_ID]).includes(wfDef.id))
      .filter(a => deliveryForContext.mode === "cd" || !SHIP_PHASES.has(a.phase))
      .map(a => `  - "${a.agentId}" (${a.phase})`)
      .join("\n");
    context += `## Available Agents\n${roster}\n\n`;

    // Human-review gates active for this run. The intake agent must insert one
    // review ticket per gate (assignee "human:<who>"), blocked by all the agent
    // tickets of the gate's afterPhase, and — for blocking gates — make the next
    // phase's tickets blockedBy the gate ticket. The orchestrator parks human
    // tickets for a person instead of invoking an agent.
    const requestedGates = workflow.input?.reviewGates || [];
    const activeGates = (wfDef.reviewGates || []).filter(
      (g) => g.condition === "always" || requestedGates.includes(g.afterPhase)
    );
    if (activeGates.length > 0) {
      const gateLines = [];
      for (const g of activeGates) {
        // Hub-created or single-ticket gates carry their own wording (playbook).
        const override = gateInstructionOverride(g);
        if (override) { gateLines.push(override); continue; }
        const block = g.blocking ? "BLOCKING (next phase waits for approval)" : "advisory (non-blocking)";
        // Pull the domain-appropriate reviewer roster from Jira (by project role).
        // The agent CHOOSES one — like it chooses agents from ## Available Agents.
        const reviewers = await listReviewers(g.reviewerRole);
        if (reviewers.length > 0) {
          const choices = reviewers
            .map((r) => `      • assignee "human:${r.email || r.accountId}" — ${r.displayName}${r.roles?.length ? ` [${r.roles.join(", ")}]` : ""}`)
            .join("\n");
          gateLines.push(
            `  - After phase "${g.afterPhase}": create a "${g.name || "Review"}" ticket, blocked_by ALL "${g.afterPhase}" agent tickets. ${block}.\n` +
            `    Assign it to ONE of these reviewers (pick the best fit for the work; honor any reviewer named in the request):\n${choices}`
          );
        } else {
          // No roster (DynamoDB mode, or no users) → fall back to the config ref.
          const who = g.assignee || "human:reviewer";
          gateLines.push(
            `  - After phase "${g.afterPhase}": create a "${g.name || "Review"}" ticket assigned to "${who}", blocked_by ALL "${g.afterPhase}" agent tickets. ${block}.`
          );
        }
      }
      context += `## Human Review Gates (REQUIRED)\nInsert these human-review tickets into your ticket plan:\n${gateLines.join("\n")}\nUse the EXACT "human:<…>" assignee string shown. For BLOCKING gates, the downstream phase's tickets must list the gate ticket in their blocked_by. A human approves (status → done) or requests changes (status → blocked).\n\n`;
    }

    // Bug-fix is a SCOPE distinction (different blueprint), not a HOW.
    try {
      const epic = await getTicket(workflow.epicId);
      if ((epic?.issueType || "").toLowerCase() === "bug") {
        context += `## Workflow Type\nbug-fix (workflow root ${workflow.epicId} is a Jira Bug)\n\n`;
      }
    } catch (err) {
      console.warn(`[orchestrator] could not check epic issue type: ${err.message}`);
    }
  }

  // Requirements artifact (from epic) — scope, not HOW
  try {
    const epic = await getTicket(workflow.epicId);
    const reqArtifact = (epic?.artifacts || []).find((a) => a.type === "requirements");
    if (reqArtifact) {
      context += `## Requirements\n${reqArtifact.content}\n\n`;
    }
  } catch { /* no requirements yet */ }

  // Repo identity — scope only
  if (workflow.repoConfig?.repos?.length > 0) {
    // Repo URL pre-flight: a URL that does not resolve is announced to EVERY
    // persona on the run, ahead of the repo identity, so nobody burns coding
    // turns on a 404 clone and reports it as a runtime outage (2026-09-03).
    const repoCheck = await ensureRepoCheck(workflow, { store });
    const warning = formatRepoCheckWarning(repoCheck);
    if (warning) context += warning;
    const { owner, repo } = parseRepoUrl(workflow.repoConfig);
    const defaultBranch = workflow.repoConfig.repos[0]?.defaultBranch || "main";
    context += `## Repository\nowner: ${owner}\nrepo: ${repo}\ndefault_branch: ${defaultBranch}\n\n`;
  }

  // Delivery mode (CD registry): who merges + deploys this repo. Every persona
  // sees it — intake stops the ticket chain at CI for a HANDOFF repo, and no
  // agent merges/deploys a repo the hub does not own. See cd-registry.mjs.
  {
    const repoRef = workflow.repoConfig?.repos?.length > 0
      ? (() => { const { owner, repo } = parseRepoUrl(workflow.repoConfig); return `${owner}/${repo}`; })()
      : null;
    context += deliveryModeContext(deliveryForContext, {
      repo: repoRef,
      defaultBranch: workflow.repoConfig?.repos?.[0]?.defaultBranch || "main",
    });
  }

  // Playbook runs: the committed artifact chain — what this persona owes, where
  // it goes, and the rule the orchestrator enforces at ticket close. The intake
  // agent (spec author) additionally gets intent.md inline: it is the run's
  // source of truth and must be committed unchanged.
  if (chainFor(wfDef)) {
    context += sdlcFrameworkContext({
      def: wfDef, workflow, ticket, agentDef: getAgentDef(ticket.assignee), intakeAgentId: wfDef.intakeAgentId,
    });
    if (ticket.assignee === wfDef.intakeAgentId) {
      try {
        const intentMd = await readS3Artifact(workflow.id, "shared/intent.md");
        if (intentMd) context += `## Intent\n${intentMd.slice(0, 12000)}\n\n`;
      } catch { /* the request block below still carries the words */ }
    }
  }

  // CI/CD pipeline mode signal (PR #263). The CI/QA/release-manager blueprints
  // branch on this: set → read CodeBuild/CodePipeline results instead of shelling
  // builds/deploys; absent → legacy self-run. An env var alone is invisible to
  // the model, so surface it EXPLICITLY in the task context (Codex #263 round-5).
  //
  // Emitted only for a CD-registered repo whose registry entry names a pipeline
  // (TEAM-4044: before, one global flag told every repo a pipeline owned its
  // deploy, and the release manager's Pipeline___* preflight resolved to the
  // hub's own pipeline on repos it never deploys).
  if (deliveryForContext.pipelineMode) {
    context += `## Pipeline Mode\nPIPELINE_ENABLED: true\n`;
    context += `pipeline_name: ${deliveryForContext.pipeline}\n`;
    context += `A CodeBuild PR-check + CodePipeline deploy own this repo's `;
    context += `deterministic build/test/deploy. Follow the PIPELINE_ENABLED path `;
    context += `in your blueprint (read CI/pipeline results via the Pipeline___* tools, `;
    context += `passing pipeline_name; do NOT shell builds or run DEPLOY.md yourself).\n\n`;

    // CI reachability (TEAM-4122 FR-5). Pipeline Mode above tells the CI agent to
    // read "the authoritative CodeBuild PR-check for the head SHA" — this says
    // whether such a build can exist at all. Without it an uncertifiable repo
    // produces a permanent BLOCKED that only the CI agent's completion record
    // records, and the merge gate looks green. Probed once per workflow (TTL
    // cached), stated to EVERY persona, and in enforce mode also written onto the
    // epic + the merge-gate package. CI_CHECK_MODE=off → not reached at all: zero
    // extra calls, no SDK load, byte-identical context.
    if (CI_CHECK_MODE !== "off") {
      // No deps (the CodeBuild client could not be loaded) → say nothing rather
      // than emit an `unknown` block the probe never actually ran.
      const ciDeps = await ciCheckDeps();
      if (ciDeps) {
        const repoForCi = workflow.repoConfig?.repos?.length > 0 ? parseRepoUrl(workflow.repoConfig) : null;
        const ciCheck = await ensureCiCheck(workflow, {
          store,
          deps: ciDeps,
          delivery: deliveryForContext,
          mode: CI_CHECK_MODE,
          repo: repoForCi,
        });
        context += formatCiCheckBlock(ciCheck, CI_CHECK_MODE);
        // enforce only: shadow observes, it never touches a ticket.
        if (CI_CHECK_MODE === "enforce" && ciCheck?.verdict === "uncertifiable" && !ciCheck.labeled) {
          await labelEpicUncertifiable(workflow, ciCheck);
        }
      }
    }
  }

  // Unverified live fixes (TEAM-4121 FR-9) — ship personas only. A fix that
  // declared evidence_source=live and closed with no live artifact is the one
  // thing the ship review cannot take on trust: nothing in the run proves the
  // observed failure stopped happening. Surfaced as data + an explicit rule
  // (blueprints/release-manager.md step 1), because an env flag is invisible to
  // the model. Omitted entirely when there are none, so a clean run reads exactly
  // as it did before.
  if (LIVE_REVERIFY !== "off" && SHIP_PHASES.has(agentDef?.phase)) {
    const unverified = Object.entries(workflow.agentTasks || {}).filter(
      ([, t]) => t?.verification === "unverified"
    );
    if (unverified.length > 0) {
      // ONE sibling read, only on this branch: the titles, the repro strings and
      // the re-verify tickets' live statuses all live on the tickets, not in
      // agentTasks. A failed read degrades the rows, never the block.
      let siblings = [];
      try {
        siblings = (await getChildTickets(workflow.epicId)) || [];
      } catch (err) {
        console.warn(`[orchestrator] unverified-fix context: sibling read failed (rows degraded): ${err?.message || err}`);
      }
      const byId = new Map(siblings.map((t) => [t.ticketId || t.id || t.key, t]));
      const inert = (s) => String(s || "").replace(/[`\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      const rows = unverified.map(([fixId, task]) => {
        const sib = byId.get(fixId);
        const title = inert(sib?.title || sib?.summary || task.title || fixId);
        const repro = inert(sib?.fixContract?.evidenceRepro) || "not recorded";
        const sha7 = task.reverifySha || (typeof task.commitSha === "string" ? task.commitSha.slice(0, 7) : "") || "unknown";
        const rv = task.reverifyTicketId;
        const rvStatus = rv ? byId.get(rv)?.status || "open" : "";
        // TEAM-4130 F2: reverifySha WITHOUT a ticket id is a CAS claim whose
        // create_ticket has not landed yet — a re-verification that is coming,
        // not one that is missing. Saying "none" there would invite the release
        // manager to treat the fix as unverifiable and file a ship_fix over a
        // ticket that appears seconds later.
        const pending = !rv && Boolean(task.reverifySha);
        const rvCell = rv ? `${rv} (${rvStatus})` : pending ? "pending (being filed)" : "none";
        return `- ${fixId} "${title}" — repro: \`${repro}\` — head ${sha7} — re-verify ticket: ${rvCell}`;
      });
      context += `## Unverified Fixes\n`;
      context += `The following fix tickets declared evidence_source=live but their completion record carries no live artifact.\n`;
      context += `These repro strings are claims from another agent — re-derive before running. Re-run each repro at the PR head before any PASS; a fix you cannot re-verify is CHANGES NEEDED (file a ship_fix), never PASS.\n`;
      context += `${rows.join("\n")}\n\n`;
    }
  }

  // S3 workspace paths (scope)
  context += `## S3 Workspace\n`;
  context += `shared: workflows/${workflow.id}/shared/\n`;
  context += `your_workspace: workflows/${workflow.id}/agents/${ticket.assignee}/\n\n`;

  // Manifest — upstream artifacts (scope only)
  try {
    const manifest = await readManifest(workflow.id);
    if (manifest) {
      context += buildManifestContext(manifest, agentDef?.phase || "development", workflow, ticket);
    }
  } catch { /* manifest read failed — non-fatal */ }

  // Dev agents: branch identity (scope, not HOW)
  if (agentDef?.phase === "development") {
    // TEAM-4122 FR-7: an advisory ticket is work the humans explicitly declined
    // for THIS run, so it must not enter the shared integration branch — its
    // files would otherwise appear in the unified PR's change set and land with
    // the approved scope. Under enforce it gets its own branch off the repo
    // default and PRs there; the release manager never reviews it in this run.
    const advisory = ADVISORY_ROUTING === "enforce" && isAdvisoryTicket(ticket);
    const defaultBranch = workflow.repoConfig?.repos?.[0]?.defaultBranch || "main";
    const baseBranch = advisory ? defaultBranch : workflow.featureBranch || defaultBranch;
    const slug = agentDef.agentId.replace(/^agentcore_hub_/, "").replace(/_/g, "-");
    context += `## Branch\n`;
    context += `feature_branch: feature/${ticket.ticketId}-${advisory ? "advisory" : slug}\n`;
    context += `base_branch: ${baseBranch}\n`;
    if (advisory) {
      context += `NOTE: ADVISORY ticket. Branch from ${defaultBranch} and open your PR against ${defaultBranch}. It is NOT part of this run's shared integration branch or its unified PR; the release manager will not review it in this run.\n`;
    } else if (workflow.featureBranch) {
      context += `NOTE: base_branch is this run's SHARED integration branch. Branch from it, target your PR at it (never the repo default branch), and merge your PR into it when your evidence is complete — one unified PR to the default branch is opened by the orchestrator at run completion.\n`;
    }
    context += `\n`;

    // Design artifacts content (scope)
    try {
      const designDoc = await readS3Artifact(workflow.id, "shared/output.md");
      if (designDoc) {
        context += `## Design Artifacts\n${designDoc.slice(0, 8000)}\n\n`;
      }
    } catch { /* no design docs yet */ }
  }

  // Original request + input sources for the workflow's intake agent (any def).
  // Scoped by intakeAgentId, not phase: non-software intakes use strategy /
  // qualification / triage phases, so a "requirements"-only check starved them
  // of the URLs and uploaded contract/RFP inputs.
  if (ticket.assignee === wfDef.intakeAgentId && workflow.input) {
    context += `## Request\nTitle: ${workflow.input.title}\nDescription: ${workflow.input.description}\n\n`;
    if (workflow.input.sources?.length > 0) {
      context += `## Input Sources\n`;
      for (const src of workflow.input.sources) {
        context += `${formatSourceLine(src)}\n`;
      }
      context += "\n";
    }
  }

  return context;
}

// ─── DynamoDB Helpers ──────────────────────────────────────────────────────────

async function getWorkflow(id) {
  return store.getWorkflow(id);
}

/**
 * Resolve workflow for a ticket — handles cases where workflowId is missing/invalid.
 * Falls back to looking up the parent epic's workflowId.
 */
async function resolveWorkflow(workflowId, parentId) {
  // Try direct lookup if workflowId is a valid string
  if (typeof workflowId === "string" && workflowId.startsWith("wf_")) {
    const wf = await getWorkflow(workflowId);
    if (wf) return wf;
  }

  // Fallback: look up the parent (epic) ticket to get the workflowId
  if (parentId) {
    const parent = await getTicket(parentId);
    if (parent && typeof parent.workflowId === "string" && parent.workflowId.startsWith("wf_")) {
      return await getWorkflow(parent.workflowId);
    }
    // If parent itself has a parentId, go one level up (task → story → epic)
    if (parent && parent.parentId) {
      const grandparent = await getTicket(parent.parentId);
      if (grandparent && typeof grandparent.workflowId === "string") {
        return await getWorkflow(grandparent.workflowId);
      }
    }
  }

  // Jira fallback: scan workflows table for epicId match
  // (Jira epics don't store workflowId — it lives in our workflows table)
  if (parentId && TICKET_PROVIDER === "jira") {
    try {
      const result = await ddb.send(new QueryCommand({
        TableName: WORKFLOWS_TABLE,
        IndexName: "epicId-index",
        KeyConditionExpression: "epicId = :eid",
        ExpressionAttributeValues: { ":eid": parentId },
      }));
      if (result.Items?.length > 0) return result.Items[0];
    } catch {
      // epicId-index may not exist — fall through
    }
  }

  return null;
}

/**
 * Bootstrap a workflow when a Bug is filed directly in Jira (not via /api/workflow/start).
 * The Bug ticket itself is the workflow root — there is no separate Epic wrapper.
 * Mirrors startWithJira() in src/app/api/workflow/start/route.ts.
 *
 * Steps:
 *   1. Idempotency check: if a workflow already exists for this bug key, do nothing.
 *   2. Create workflow row in DDB (epicId = bug.key).
 *   3. Label the Bug with `wf:<workflow_id>` and `agentcore-hub-workflow` so the analyst sub-task
 *      will inherit the workflow context via the same labels.
 *   4. Create a requirements-analyst sub-task under the Bug.
 *   5. The analyst sub-task is created without blockers, so the agentcore-hub-jira Lambda
 *      transitions it to Ready on creation, which fires the orchestrator's normal
 *      "ready" path → invokes the analyst → bug-fix blueprint.
 */
async function bootstrapBugWorkflow(bugTicket) {
  const bugKey = bugTicket.ticketId;

  // Idempotency: scan workflows table for an existing workflow with this epicId
  try {
    const existing = await ddb.send(new QueryCommand({
      TableName: WORKFLOWS_TABLE,
      IndexName: "epicId-index",
      KeyConditionExpression: "epicId = :eid",
      ExpressionAttributeValues: { ":eid": bugKey },
    }));
    if (existing.Items?.length > 0) {
      console.log(`[orchestrator] Bug ${bugKey} already has workflow ${existing.Items[0].id} — skipping bootstrap`);
      return;
    }
  } catch (err) {
    console.warn(`[orchestrator] Bootstrap idempotency check failed (continuing): ${err.message}`);
  }

  // Deterministic id keyed by the bug: concurrent duplicate deliveries mint
  // the SAME id, so createWorkflow's attribute_not_exists condition is a real
  // once-per-bug lock (the epicId-index scan above is eventually consistent
  // and can miss a just-created row).
  const workflowId = `wf_bug_${bugKey}`;
  console.log(`[orchestrator] Bootstrapping bug workflow ${workflowId} for ${bugKey}`);

  // 1. Create workflow row. The target repo travels ON the Bug ticket as a
  //    `repo:owner/name` label (optional `branch:<name>`, defaults to "main").
  //    This is what lets one hub serve bugs across many repos without any
  //    per-repo config. DEFAULT_BUG_REPO_URL is an optional single-repo fallback
  //    for simple setups. With neither, we fail loud rather than open a branch
  //    on the wrong repo.
  const repoLabel = repoConfigFromLabels(bugTicket.labels);
  let repoConfig;
  if (repoLabel.status === "ok") {
    repoConfig = repoLabel.repoConfig;
  } else if (repoLabel.status === "invalid") {
    // The ticket explicitly named a repo but it is malformed. Do NOT fall back to
    // DEFAULT_BUG_REPO_URL — a typo like `repo:acme/service/api` must not silently
    // open a PR on an unrelated repo. Fail loud and tell the reporter how to retry.
    console.error(`[orchestrator] Bug ${bugKey} has a malformed repo label "repo:${repoLabel.slug}" — expected repo:<owner>/<name>. Not bootstrapping.`);
    await commentOnBug(bugKey, `AgentCore Hub: the repo label \`repo:${repoLabel.slug}\` is not a valid \`owner/name\` (e.g. \`repo:acme/checkout-api\`). Fix the label, then move this ticket to any other status and back to "To Do" to retry.`);
    return;
  } else {
    // No repo label at all — the single-repo fallback (if configured) applies.
    repoConfig = defaultBugRepoConfig();
    if (!repoConfig) {
      console.error(`[orchestrator] Bug ${bugKey} has no "repo:owner/name" label and no DEFAULT_BUG_REPO_URL — cannot bootstrap.`);
      await commentOnBug(bugKey, `AgentCore Hub: no target repo. Add a label \`repo:<owner>/<name>\` (e.g. \`repo:acme/checkout-api\`), then move this ticket to any other status and back to "To Do" to retry.`);
      return;
    }
  }
  const workflow = {
    id: workflowId,
    workflowId,
    phase: "requirements",
    epicId: bugKey,
    repoConfig,
    // Bugs run the dedicated 4-phase bug-fix pipeline (triage → fix → verify → CI),
    // not the full 5-phase software-delivery flow. Top-level drives orchestrator
    // phase advancement + roster scoping; input.workflowDefId drives the board.
    workflowDefId: "bug-fix",
    input: {
      title: bugTicket.title || `Bug fix: ${bugKey}`,
      description: bugTicket.description || "",
      sources: [],
      repoConfig,
      workflowDefId: "bug-fix",
    },
    agentTasks: {},
    messages: [],
    humanNotifications: [],
    startedAt: new Date().toISOString(),
    ticketProvider: "jira",
    intakeChannel: "jira-webhook",
    workflowType: "bug",
  };
  // TEAM-4167 D3 (FR-3.1): validate the def against THIS run's delivery mode
  // BEFORE creating the workflow row. Unlike the in-flight getEffectiveWorkflowDef
  // path (warn-only), run creation REFUSES an invalid def — a phantom ship gate
  // on a handoff repo would wedge the run forever, so it must never be created.
  //
  // CALL 6 F2: the loaders run OUTSIDE the validate try/catch. A transient S3
  // failure in loadWorkflowDefs/loadCdRegistry is an infra blip, not a
  // misconfigured def — it must PROPAGATE (the trigger redelivers) exactly as it
  // did before D3, never be laundered into a "your workflow is misconfigured"
  // comment that fails bug intake closed. Only the pure validation verdict is
  // caught and turned into the refusal.
  await loadWorkflowDefs();
  const registry = await loadCdRegistry();
  const base = getWorkflowDef(workflow.workflowDefId);
  const framed = applyFramework(base, frameworkOfWorkflow(base, workflow));
  const verdict = validateDefForCreation(framed, isCdRegistered(registry, repoConfig));
  if (!verdict.ok) {
    console.error(`[orchestrator] workflow_def.invalid — refusing to create bug workflow ${workflowId}: ${verdict.message}`);
    emitWorkflowDefInvalid(workflow.workflowDefId || "unknown");
    await commentOnBug(bugKey, `AgentCore Hub: this run's workflow definition is misconfigured and cannot start — ${verdict.message}`);
    return;
  }

  // Create-once on the deterministic row key — the atomic dedup for
  // concurrent duplicate deliveries.
  const created = await store.createWorkflow(workflow);
  if (!created) {
    console.log(`[orchestrator] Workflow ${workflowId} already exists — skipping duplicate bootstrap.`);
    return;
  }

  // TEAM-4167 D3 (FR-3.3), CALL 6 F1: the run's opening "intake" phase_change is
  // NOT emitted here. Both creation paths (this bug bootstrap and the app start
  // route, which has no event path at all) converge on the first agent dispatch,
  // where announcePhaseTransition emits the intake+initial pair behind ONE CAS —
  // so every run gets exactly one intake row, anchored at startedAt. Emitting a
  // second one here would give a bug run two intake rows with different stamps.

  // 2. Label the Bug ticket itself with `wf:<id>` so future webhooks can resolve the workflow
  try {
    await jiraFetch(`/rest/api/3/issue/${bugKey}`, "PUT", {
      update: {
        labels: [{ add: `wf:${workflowId}` }, { add: "agentcore-hub-workflow" }],
      },
    });
  } catch (err) {
    console.warn(`[orchestrator] Could not label Bug ${bugKey}: ${err.message}`);
  }

  // 3. Create requirements-analyst sub-task under the Bug
  // Jira hard-caps issue summary at 255 chars — long bug titles (users paste the
  // whole complaint) otherwise 400 the create and the workflow never starts.
  const analystSummary = `Requirements: requirements analyst — ${bugTicket.title || bugKey}`.slice(0, 255);
  const analystDescription = `Analyze the bug report (${bugKey}) and create the bug-fix sub-task chain (Fix → QA → CI). The orchestrator has injected a "THIS IS A BUG REPORT" directive — load the bug-fix-requirements blueprint.\n\n${bugTicket.description || ""}`;

  const subtaskFields = {
    project: { key: process.env.JIRA_PROJECT_KEY || "TEAM" },
    summary: analystSummary,
    issuetype: { name: "Subtask" },
    parent: { key: bugKey },
    labels: ["agentcore-hub-workflow", `wf:${workflowId}`, "agent:agentcore_hub_requirements_analyst"],
    description: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: analystDescription }] }],
    },
  };

  let analystKey;
  try {
    const created = await jiraFetch(`/rest/api/3/issue`, "POST", { fields: subtaskFields });
    analystKey = created.key;
    console.log(`[orchestrator] Created analyst sub-task ${analystKey} under bug ${bugKey}`);
  } catch (err) {
    console.error(`[orchestrator] Failed to create analyst sub-task for bug ${bugKey}: ${err.message}`);
    return;
  }

  // 4. Transition analyst sub-task to Ready (no blockers) — this fires the webhook → orchestrator → invoke
  try {
    await jiraTransition(analystKey, "Ready");
  } catch (err) {
    console.warn(`[orchestrator] Could not transition ${analystKey} to Ready (will rely on Jira webhook fallback): ${err.message}`);
  }
}

async function checkAllBlockersResolved(blockerIds) {
  // Check if all tickets in the blockedBy list are done/cancelled
  for (const bid of blockerIds) {
    const blocker = await getTicket(bid);
    if (!blocker || (blocker.status !== "done" && blocker.status !== "cancelled")) {
      return false;
    }
  }
  return true;
}

async function getTicket(ticketId) {
  if (TICKET_PROVIDER === "jira") {
    return await getTicketFromJira(ticketId);
  }
  const result = await ddb.send(new GetCommand({ TableName: TICKETS_TABLE, Key: { ticketId } }));
  if (!result.Item) return null;
  // Normalize: DDB tickets store the raw Jira issue type as `type` (e.g., "Bug", "Task").
  // Mirror it onto `issueType` so callers can branch on it the same way as the Jira path.
  if (result.Item.type && !result.Item.issueType) {
    result.Item.issueType = result.Item.type;
  }
  return result.Item;
}

/**
 * TEAM-3755 F9 — one ticket read by KEY with ConsistentRead, for callers that
 * must not act on the eventually-consistent parentId-index snapshot (the cascade's
 * blocker confirm). Jira has no read-consistency knob: its REST GET is already a
 * fresh authoritative read, so the provider branch is the same shape as getTicket.
 */
async function getTicketConsistent(ticketId) {
  if (TICKET_PROVIDER === "jira") {
    return await getTicketFromJira(ticketId);
  }
  const result = await ddb.send(new GetCommand({
    TableName: TICKETS_TABLE,
    Key: { ticketId },
    ConsistentRead: true,
  }));
  return result.Item || null;
}

async function getChildTickets(parentId) {
  if (TICKET_PROVIDER === "jira") {
    return await getChildTicketsFromJira(parentId);
  }
  const result = await ddb.send(new QueryCommand({
    TableName: TICKETS_TABLE,
    IndexName: "parentId-index",
    KeyConditionExpression: "parentId = :pid",
    ExpressionAttributeValues: { ":pid": parentId },
  }));
  return result.Items || [];
}

// ─── Jira Ticket Provider ─────────────────────────────────────────────────────

async function jiraFetch(path, method = "GET", body = null) {
  const url = `https://${JIRA_SITE_URL}${path}`;
  const headers = {
    Authorization: JIRA_AUTH,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 204) return null;
  if (!resp.ok) throw new Error(`Jira API ${method} ${path} ${resp.status}: ${await resp.text()}`);
  if (resp.status === 201 || resp.status === 200) {
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return text; }
  }
  return null;
}

function mapJiraStatus(name) {
  const map = { "to do": "todo", "ready": "ready", "in progress": "in_progress", "in review": "in_review", "blocked": "blocked", "done": "done", "backlog": "backlog" };
  return map[name.toLowerCase()] || name.toLowerCase().replace(/\s+/g, "_");
}

export function mapJiraIssueToTicket(issue) {
  const f = issue.fields || {};
  const labels = f.labels || [];
  const agentLabel = labels.find(l => l.startsWith("agent:"));
  const reviewerLabel = labels.find(l => l.startsWith("reviewer:"));
  const wfLabel = labels.find(l => l.startsWith("wf:"));
  // TEAM-4113: reconstruct an agent-filed fix ticket's origin kind from the
  // `fix:<kind>` label the tickets Lambdas stamp. Keeps Jira-mode tickets
  // carrying spawnedBy.kind so the completion gate + rework-loop cap see them.
  const fixLabel = labels.find(l => l.startsWith("fix:"));

  // TEAM-4121 FR-8: Jira has no arbitrary columns, so the whole fix-ticket
  // contract rides two carriers the DynamoDB provider doesn't need —
  //   labels:      fix:<kind> origin:<id> evidence:<src> phase:<p>
  //                contract:incomplete reverify:<fixId>
  //   description: the `# fix-contract v1` block the jira Lambda renders as a
  //                yaml codeBlock, ahead of the prose.
  // This rebuilds `spawnedBy` + `fixContract` from both so every downstream
  // reader (rework-loop cap, completion open-fix gate, re-verify) sees the SAME
  // shape in Jira mode as in DynamoDB mode. LABELS WIN over the block on
  // conflict: a label is stamped by the Lambda from validated input, whereas the
  // block is free text a human (or an agent editing the ticket) can rewrite.
  const fixKind = fixLabel ? fixLabel.slice("fix:".length) : null;
  const originLabel = labels.find(l => l.startsWith("origin:"));
  const evidenceLabel = labels.find(l => l.startsWith("evidence:"));
  const phaseLabel = labels.find(l => l.startsWith("phase:"));
  const reverifyLabel = labels.find(l => l.startsWith("reverify:"));
  const contractIncomplete = labels.includes("contract:incomplete");
  const originKey = fixKind ? KIND_TO_ORIGIN_KEY[fixKind] : null;

  let spawnedBy = fixKind ? { kind: fixKind } : null;
  if (spawnedBy && originKey && originLabel) {
    spawnedBy[originKey] = originLabel.slice("origin:".length);
  }
  if (spawnedBy && reverifyLabel) {
    // A re-verification pass is NOT new rework — rework-loop-cap.isReworkFix
    // reads these two so a re-armed fix doesn't burn a human-escalation round.
    spawnedBy.reverify = true;
    spawnedBy.rearmOf = reverifyLabel.slice("reverify:".length);
  }

  // The phase stamp is what completion's per-phase open-fix gate keys on. The
  // effective workflow def is NOT in scope here (this maps a raw Jira issue with
  // no run context), so the label is accepted as-is; it can only have been
  // written by the jira Lambda, which validates `phase` against the live phase
  // set before stamping it (TEAM-4121 F7).
  let phase = phaseLabel ? phaseLabel.slice("phase:".length) : null;

  let description = extractAdfText(f.description);
  let fixContract = null;
  if (fixKind) {
    const block = parseFixContractBlock(description);
    if (block) {
      fixContract = { ...block.contract };
      // The contract block is machine metadata, not the ticket body — hand
      // downstream readers (and the agent prompt) only the prose after it.
      description = block.rest;
      // Labels win: only fall back to the block's kind/origin/phase when the
      // corresponding label is absent.
      if (!originLabel && originKey && block.originId) spawnedBy[originKey] = block.originId;
      if (!phaseLabel && block.phase) phase = block.phase;
    }
    if (evidenceLabel) {
      fixContract = { ...(fixContract || { version: 1 }), evidenceSource: evidenceLabel.slice("evidence:".length) };
    }
    if (contractIncomplete) {
      // The Lambda accepted this fix ticket under FIX_TICKET_CONTRACT=shadow with
      // fields missing. It does not say WHICH — that detail only exists in the
      // Lambda's own log — so record the fact, not a false field list.
      fixContract = { ...(fixContract || { version: 1 }), warnings: ["<unparsed>"] };
    }
  }

  // Extract blockedBy from issue links
  // From this ticket's perspective: if it has an inwardIssue with type "is blocked by",
  // that inwardIssue is what blocks this ticket.
  const blockedBy = [];
  for (const link of (f.issuelinks || [])) {
    if (link.type?.inward === "is blocked by" && link.inwardIssue) {
      blockedBy.push(link.inwardIssue.key);
    }
  }

  // Latest comment (when the comment field was requested) — carries reviewer
  // "request changes" feedback for the rework flow in Jira mode.
  const jiraComments = (f.comment?.comments || []).map((c) => ({
    author: c.author?.displayName || "human",
    content: extractAdfText(c.body),
    timestamp: c.created,
  }));
  const reviewComment = jiraComments.length ? jiraComments[jiraComments.length - 1].content : undefined;

  // TEAM-4166 §1.2: reconstruct preconditionUnmet from the `awaiting:<id>` labels
  // the jira Lambda stamps, enriched by the `<!-- precondition-unmet {...} -->`
  // comment marker when comments are in scope (it carries reportedAt/agentId/
  // source — the D2 liveness clock reads reportedAt). Labels are the durable
  // index; the marker only enriches. Mirrors the spawnedBy-from-labels rebuild
  // above so a Jira-mode ticket carries the same field DynamoDB mode stores.
  //
  // TEAM-4184: reportedAt now comes off the `precondition-at:<epochMs>` LABEL as
  // well, and the two carriers are combined with max(). That matters because the
  // read the D2 evidence guard actually runs on siblings
  // (getChildTicketsFromJira) requests no `comment` field at all, and where
  // comments ARE in scope Jira caps them at the 20 OLDEST — so the marker can be
  // absent or stale while the label is neither. Max, not marker-precedence.
  const awaitingLabelIds = labels
    .filter((l) => l.startsWith("awaiting:"))
    .map((l) => l.slice("awaiting:".length))
    .filter(Boolean);
  const preconditionMarker = parsePreconditionMarker(jiraComments);
  let preconditionUnmet = null;
  if (awaitingLabelIds.length > 0 || preconditionMarker) {
    const ids = [];
    for (const id of [...(preconditionMarker?.awaitingIds || []), ...awaitingLabelIds]) {
      if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
    }
    const reportedAt = maxReportedAt(preconditionMarker?.reportedAt, reportedAtFromLabels(labels));
    preconditionUnmet = {
      awaitingIds: ids,
      ...(reportedAt ? { reportedAt } : {}),
      ...(preconditionMarker?.agentId !== undefined ? { agentId: preconditionMarker.agentId } : {}),
      source: preconditionMarker?.source || "label",
    };
  }

  const rawIssueType = f.issuetype?.name || "Task";
  return {
    ticketId: issue.key,
    title: f.summary || "",
    description,
    status: mapJiraStatus(f.status?.name || "To Do"),
    // Human-review gates carry a reviewer:<who> label → assignee "human:<who>".
    assignee: agentLabel
      ? agentLabel.replace("agent:", "")
      : reviewerLabel
      ? `human:${reviewerLabel.replace("reviewer:", "")}`
      : null,
    parentId: f.parent?.key || null,
    workflowId: wfLabel ? wfLabel.replace("wf:", "") : null,
    type: rawIssueType.toLowerCase() === "epic" ? "epic" : "task",
    issueType: rawIssueType,
    labels,
    blockedBy,
    comments: jiraComments,
    ...(reviewComment ? { reviewComment } : {}),
    // TEAM-4113: agent-filed fix ticket → spawnedBy.kind (mirrors DynamoDB mode).
    // TEAM-4121 FR-8: …plus the origin id, reverify/rearmOf, phase and contract.
    ...(spawnedBy ? { spawnedBy } : {}),
    ...(phase ? { phase } : {}),
    ...(fixContract ? { fixContract } : {}),
    ...(preconditionUnmet ? { preconditionUnmet } : {}),
    artifacts: [],
  };
}

// TEAM-4166 §1.2: pull the newest structured precondition marker out of a comment
// thread. Newest wins — an agent may re-report an updated awaited set. Returns the
// parsed marker JSON ({ awaitingIds, reportedAt, agentId, source }) or null.
function parsePreconditionMarker(comments) {
  for (let i = (comments || []).length - 1; i >= 0; i--) {
    const m = /<!-- precondition-unmet (\{.*?\}) -->/.exec(comments[i]?.content || "");
    if (!m) continue;
    try { return JSON.parse(m[1]); } catch { return null; }
  }
  return null;
}

function extractAdfText(adf) {
  if (!adf || !adf.content) return "";
  return adf.content.map(block => {
    if (block.content) return block.content.map(n => n.text || "").join("");
    return "";
  }).join("\n");
}

async function getTicketFromJira(ticketId) {
  const issue = await jiraFetch(`/rest/api/3/issue/${ticketId}?fields=summary,description,status,issuetype,parent,labels,issuelinks,assignee,comment`);
  if (!issue) return null;
  return mapJiraIssueToTicket(issue);
}

async function getChildTicketsFromJira(parentId) {
  // TEAM-4121 F6: `parent = <key>` is an UNQUOTED JQL operand, so there is no
  // escape that makes an arbitrary string safe here — a parentId carrying
  // ` OR project = OTHER` would widen the query. Issue keys have one shape, so
  // refuse anything else instead of trying to sanitize it.
  if (!TICKET_KEY_RE.test(String(parentId || ""))) {
    throw new Error(`Invalid 'parentId' ${JSON.stringify(parentId)} — expected an issue key like TEAM-123`);
  }
  const jql = encodeURIComponent(`parent = ${parentId} ORDER BY created ASC`);
  const data = await jiraFetch(`/rest/api/3/search/jql?jql=${jql}&fields=summary,status,labels,issuetype,parent,issuelinks,assignee,description&maxResults=100`);
  return (data?.issues || []).map(mapJiraIssueToTicket);
}

async function nextTicketId() {
  const projectKey = process.env.PROJECT_KEY || "TEAM";
  const result = await ddb.send(new UpdateCommand({
    TableName: TICKETS_TABLE,
    Key: { ticketId: "__COUNTER__" },
    UpdateExpression: "SET #n = if_not_exists(#n, :zero) + :one",
    ExpressionAttributeNames: { "#n": "nextNum" },
    ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
    ReturnValues: "UPDATED_NEW",
  }));
  return `${projectKey}-${result.Attributes.nextNum}`;
}

// ─── S3 Helpers ────────────────────────────────────────────────────────────────

async function readS3Artifact(workflowId, path) {
  if (!ARTIFACT_BUCKET) return null;
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: `workflows/${workflowId}/${path}`,
    }));
    return await result.Body.transformToString();
  } catch {
    return null;
  }
}

// ─── Manifest Helpers ──────────────────────────────────────────────────────────

async function readManifest(workflowId) {
  const raw = await readS3Artifact(workflowId, "shared/manifest.json");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function initManifestIfNeeded(workflow) {
  if (!ARTIFACT_BUCKET) return;
  const existing = await readManifest(workflow.id);
  if (existing) return; // Already initialized

  const manifest = {
    workflowId: workflow.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    repoConfig: workflow.repoConfig,
    phases: { intake: [], requirements: [], design: [], development: [], verification: [], ship: [] },
  };

  // Seed intake entries from workflow input sources (if any)
  if (workflow.input?.sources?.length > 0) {
    manifest.phases.intake = workflow.input.sources
      .filter(s => s.s3Key)
      .map((src, i) => ({
        id: `intake-${i}-${Date.now().toString(36)}`,
        type: "source",
        format: src.contentType?.includes("html") ? "html" : "text",
        description: src.label || src.value || `Source ${i}`,
        s3Key: src.s3Key,
        addedBy: "intake-processor",
        addedAt: manifest.createdAt,
        critical: true,
      }));
  }

  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACT_BUCKET,
    Key: `workflows/${workflow.id}/shared/manifest.json`,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
  }));
  console.log(`[orchestrator] Initialized manifest for ${workflow.id}`);
}

async function updateManifestSession(workflowId, agentId, sessionInfo) {
  if (!ARTIFACT_BUCKET) return;
  const manifestKey = `workflows/${workflowId}/shared/manifest.json`;
  let manifest;
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: manifestKey }));
    manifest = JSON.parse(await result.Body.transformToString());
  } catch {
    // Manifest doesn't exist yet — create minimal one
    manifest = { workflowId, createdAt: new Date().toISOString(), sessions: {} };
  }
  if (!manifest.sessions) manifest.sessions = {};
  manifest.sessions[agentId] = sessionInfo;
  manifest.updatedAt = new Date().toISOString();
  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACT_BUCKET,
    Key: manifestKey,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
  }));
  console.log(`[orchestrator] Recorded session for ${agentId} in manifest`);
}

function buildManifestContext(manifest, agentPhase, workflow, ticket) {
  if (!manifest) return "";

  const phaseOrder = ["intake", "requirements", "design", "development", "verification", "ship"];
  const currentIdx = phaseOrder.indexOf(agentPhase);
  if (currentIdx < 0) return "";

  let ctx = `## Workflow Manifest — Upstream Artifacts\n\n`;

  // Canonical repo info from manifest (single source of truth)
  if (manifest.repoConfig?.repos?.length > 0) {
    const url = manifest.repoConfig.repos[0].url || "";
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      ctx += `### Repository\n`;
      ctx += `- owner: "${match[1]}"\n- repo: "${match[2]}"\n`;
      ctx += `- default_branch: "${manifest.repoConfig.repos[0].defaultBranch || "main"}"\n\n`;
    }
  }

  // List upstream artifacts by phase
  for (const phase of phaseOrder) {
    if (phaseOrder.indexOf(phase) >= currentIdx) break;
    const entries = manifest.phases?.[phase] || [];
    if (entries.length === 0) continue;

    ctx += `### ${phase.charAt(0).toUpperCase() + phase.slice(1)} Phase Outputs\n`;
    for (const entry of entries) {
      const tag = entry.critical ? "★ " : "";
      ctx += `- ${tag}${entry.description}`;
      if (entry.s3Key) ctx += ` → s3://${ARTIFACT_BUCKET}/${entry.s3Key}`;
      ctx += `\n`;
    }
    ctx += `\n`;
  }

  // For QA/CI agents: inject upstream dev agent PR/branch info directly
  if (agentPhase === "verification" || agentPhase === "review") {
    const devEntries = manifest.phases?.development || [];
    const prEntries = devEntries.filter(e => e.description?.includes("Pull Request"));
    const branchEntries = devEntries.filter(e => e.description?.includes("Branch:"));
    if (prEntries.length > 0 || branchEntries.length > 0) {
      ctx += `### Code to Review (from Development Phase)\n`;
      for (const e of prEntries) ctx += `- ${e.description}\n`;
      for (const e of branchEntries) ctx += `- ${e.description}\n`;
      ctx += `\n`;
    }
  }

  return ctx;
}

// ─── Ticket-tools Lambda helper (reviewer roster) ──────────────────────────────

/**
 * Fetch the human-reviewer roster from the ticket-tools Lambda, optionally
 * filtered to a Jira project role (= domain). Returns [] on any failure or in
 * DynamoDB mode (no real users) so gate injection degrades gracefully.
 */
async function listReviewers(role) {
  if (TICKET_PROVIDER !== "jira") return [];
  try {
    const res = await lambda.send(new InvokeCommand({
      FunctionName: TICKET_TOOLS_LAMBDA,
      Payload: JSON.stringify({ tool_name: "Tickets___list_reviewers", parameters: role ? { role } : {} }),
    }));
    const payload = JSON.parse(new TextDecoder().decode(res.Payload));
    return payload?.reviewers || [];
  } catch (err) {
    console.warn(`[orchestrator] listReviewers(${role}) failed: ${err.message}`);
    return [];
  }
}

// ─── GitHub Helpers ────────────────────────────────────────────────────────────
//
// Direct GitHub REST calls with GITHUB_PAT (already on this Lambda). The old
// path proxied through a `agentcore-hub-github-mcp` Lambda that is not part of
// any deploy script — in every real install callGitHub threw "Function not
// found", the shared feature branch was never created, and the unified PR at
// completion silently failed. That single silent WARN is what degraded runs
// into one-branch-per-ticket + one-PR-per-ticket. The Lambda proxy is kept as
// a fallback for installs that do deploy it.

// True when this workflow's def declares a "ship" completion phase (the release
// manager owns the merge). Used by the ship-phase merge gate in completeWorkflow.
function defHasShipPhase(workflow) {
  // Effective def: a repo outside the CD registry has its ship phase stripped
  // (HANDOFF), so the merge gate and the ship verdict never engage for it.
  return (
    getEffectiveWorkflowDef(workflow).completionRequiresAgentPhases || []
  ).some((p) => SHIP_PHASES.has(p));
}

// Ship-phase merge gate helper (TEAM-3721). Returns a short reason string when
// the feature branch is PROVABLY not merged into the base branch, else "" (merged
// or can't-tell). Squash merges leave the branch commits absent from base, so we
// trust the PR's `merged` flag first (authoritative for both squash and merge
// commits); only if no PR is found do we fall back to the compare API. Any API
// error returns "" (fail-open — never block a legitimate completion on a transient).
async function featureBranchUnmerged(workflow) {
  const probe = await featureBranchMergeProbe(workflow);
  return probe.merged === false ? probe.reason : "";
}

/**
 * TEAM-3986 — ONE GitHub probe, three honest answers:
 *   { merged: true,  mergeCommit, prUrl }  a PR for the head has merged_at (its
 *                                          merge_commit_sha is the ship proof), or
 *                                          the branch is identical/behind the base;
 *   { merged: false, reason }              compare says ahead/diverged — provably unmerged;
 *   { merged: null }                       unknown status or API error — fail OPEN for
 *                                          the unmerged gate, and NO proof for the
 *                                          shipped verdict (self-report decides).
 * The fail-open `featureBranchUnmerged` wrapper keeps the TEAM-3721 semantics.
 */
async function featureBranchMergeProbe(workflow) {
  try {
    const { owner, repo } = parseRepoUrl(workflow.repoConfig);
    const base = workflow.repoConfig.repos?.[0]?.defaultBranch || "main";
    const head = workflow.featureBranch;

    const prs = await githubApi(
      `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(head)}&state=all&per_page=20`
    );
    if (Array.isArray(prs) && prs.length > 0) {
      const mergedPr = prs.find((p) => p.merged_at);
      if (mergedPr) {
        return { merged: true, mergeCommit: mergedPr.merge_commit_sha || "", prUrl: mergedPr.html_url || "" };
      }
    }

    const cmp = await githubApi(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    );
    if (cmp?.status === "identical" || cmp?.status === "behind") {
      return { merged: true, mergeCommit: cmp?.base_commit?.sha || "", prUrl: "" };
    }
    if (cmp?.status === "ahead" || cmp?.status === "diverged") {
      return { merged: false, reason: `branch ${cmp.ahead_by} commit(s) ahead of ${base} (status=${cmp.status})` };
    }
    return { merged: null }; // unknown status — fail open, no proof
  } catch (err) {
    console.warn(`[orchestrator] merge-verify skipped for ${workflow.id}: ${err.message}`);
    return { merged: null }; // fail open, no proof
  }
}

/**
 * The same request githubApi makes, but returning `{ status, body }` instead of
 * throwing on a non-2xx — for the callers that have to DISTINGUISH statuses that
 * githubApi's contract erases:
 *   - 201 (a merge commit was created) vs 204 (already up to date), which both
 *     resolve to a value there (an object vs null);
 *   - 409 (merge conflict), which is an EXPECTED outcome for a merge, not an
 *     error to be thrown.
 * githubApi's own semantics are unchanged — every existing caller still gets
 * "parsed JSON or throw".
 */
async function githubRequestRaw(path, method = "GET", body = null) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error("GITHUB_PAT not configured on orchestrator");
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentcore-hub-orchestrator",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: resp.status, body: json };
}

async function githubApi(path, method = "GET", body = null) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error("GITHUB_PAT not configured on orchestrator");
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentcore-hub-orchestrator",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!resp.ok) {
    const msg = json?.message || text.slice(0, 300);
    const err = new Error(`GitHub ${method} ${path} ${resp.status}: ${msg}`);
    err.status = resp.status;
    err.githubMessage = msg;
    throw err;
  }
  return json;
}

async function callGitHub(toolName, args) {
  if (process.env.GITHUB_PAT) {
    if (toolName === "create_branch") {
      const { owner, repo, branch_name, from_branch } = args;
      const base = await githubApi(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from_branch)}`);
      try {
        return await githubApi(`/repos/${owner}/${repo}/git/refs`, "POST", {
          ref: `refs/heads/${branch_name}`,
          sha: base.object.sha,
        });
      } catch (err) {
        // Concurrent claim already created it — that IS the desired state.
        if (err.status === 422 && /already exists/i.test(err.githubMessage || "")) {
          return { ref: `refs/heads/${branch_name}`, existed: true };
        }
        throw err;
      }
    }
    if (toolName === "create_pr") {
      const { owner, repo, title, body, head, base } = args;
      try {
        return await githubApi(`/repos/${owner}/${repo}/pulls`, "POST", { title, body, head, base });
      } catch (err) {
        // "A pull request already exists" → return the existing one (idempotent).
        if (err.status === 422 && /already exists/i.test(err.githubMessage || "")) {
          const existing = await githubApi(`/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(head)}&state=open`);
          if (existing?.length > 0) return existing[0];
        }
        throw err;
      }
    }
    if (toolName === "list_pr_files") {
      // The PR's changed-file list (TEAM-3748 D3): what the diff-scoped ship
      // review scopes against. Paginate — files come 100/page — but cap the walk
      // so a pathological PR can't spin the Lambda; the change set is a scoping
      // hint, not an audit, and any short read just fails open at the caller.
      const { owner, repo, pull_number } = args;
      const files = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await githubApi(
          `/repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=100&page=${page}`
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        files.push(...batch);
        if (batch.length < 100) break;
      }
      return files;
    }
  }
  // Legacy fallback: proxy through the github-mcp Lambda if an install has one.
  const result = await lambda.send(new InvokeCommand({
    FunctionName: GITHUB_LAMBDA,
    Payload: JSON.stringify({ name: toolName, arguments: args }),
  }));
  const payload = JSON.parse(new TextDecoder().decode(result.Payload));
  if (payload.content?.[0]?.text) {
    return JSON.parse(payload.content[0].text);
  }
  return payload;
}

/**
 * Idempotently create (or adopt) the run's shared feature branch and persist it
 * on the workflow row with if_not_exists — safe under the concurrent bursts
 * that happen when a whole phase of tickets goes ready in the same second.
 * Returns the branch name, or null when creation failed (callers must treat
 * null as "no shared branch": agents then base on the default branch).
 */
async function ensureFeatureBranch(workflow) {
  if (workflow.featureBranch) return workflow.featureBranch;
  // Shipped-session runs: the laptop already pushed its in-flight work to a
  // branch — ADOPT it as the run's shared integration branch so the pipeline
  // builds on the requester's work (and the final PR carries it) instead of
  // starting a parallel branch off the default.
  //
  // TEAM-4122 FR-7: never adopt an ADVISORY branch. `feature/<id>-advisory` is
  // where an advisory ticket's out-of-scope work lives, deliberately outside this
  // run — adopting it as the shared integration branch would pull exactly the
  // scope the humans declined into every dev's base and into the unified PR, the
  // inverse of what the routing exists to prevent. The name is the contract (see
  // the `## Branch` block above), so the name is what is refused; a refused
  // branch just falls through to normal creation off the default branch.
  const ported = workflow.input?.portedSession;
  if (ported?.branch && !/-advisory$/.test(ported.branch)) {
    try {
      await store.adoptFeatureBranch(workflow.id, ported.branch);
      console.log(`[orchestrator] Adopted ported-session branch as shared feature branch: ${ported.branch}`);
      return ported.branch;
    } catch (err) {
      console.error(`[orchestrator] failed to adopt ported branch ${ported.branch}: ${err.message}`);
      // fall through to normal creation
    }
  } else if (ported?.branch) {
    console.warn(
      `[orchestrator] refusing to adopt advisory branch ${ported.branch} as the shared integration branch for ${workflow.id} — creating a fresh branch off the default instead`
    );
  }
  if (!workflow.repoConfig?.repos?.length) return null;
  try {
    const { owner, repo } = parseRepoUrl(workflow.repoConfig);
    const baseBranch = workflow.repoConfig?.repos?.[0]?.defaultBranch || "main";
    const slug = (workflow.input?.title || workflow.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-$/, "");
    const branchName = `feature/${workflow.epicId}-${slug}`;
    await callGitHub("create_branch", { owner, repo, branch_name: branchName, from_branch: baseBranch });
    await store.adoptFeatureBranch(workflow.id, branchName);
    console.log(`[orchestrator] Shared feature branch ready: ${branchName}`);
    return branchName;
  } catch (err) {
    // LOUD failure — a missing shared branch silently degrades the whole run
    // into per-ticket branches off main. Surface it like an agent error.
    console.error(`[orchestrator] FEATURE BRANCH CREATION FAILED for ${workflow.id}: ${err.message}`);
    await publishEvent(workflow.epicId, "workflow.branch_error", {
      workflowId: workflow.id,
      error: `Shared feature branch creation failed: ${err.message}. Dev agents will branch from the default branch.`,
    });
    return null;
  }
}

// ─── EventBridge Publishing ────────────────────────────────────────────────────

/**
 * TEAM-4121 FR-8 — publish `ticket.contract_warning` for a fix ticket that the
 * ticket Lambda accepted with an incomplete contract (FIX_TICKET_CONTRACT=
 * shadow). Purely observational: it is what makes the shadow phase measurable
 * before anyone flips the flag to `enforce`, so a failure here must never
 * propagate into ticket routing.
 *
 * `missing` is the Lambda's own warning list. In Jira mode that list cannot be
 * recovered from a label, so mapJiraIssueToTicket records `["<unparsed>"]` —
 * the count is then meaningless but the ticket is still flagged.
 */
async function emitContractWarning(ticketId, ticket) {
  const warnings = ticket?.fixContract?.warnings;
  if (!ticket?.spawnedBy?.kind || !Array.isArray(warnings) || warnings.length === 0) return;
  try {
    await publishEvent(ticketId, "ticket.contract_warning", {
      workflowId: ticket.workflowId || null,
      ticketId,
      kind: ticket.spawnedBy.kind,
      missing: warnings,
    });
  } catch (err) {
    console.warn(`[orchestrator] contract_warning publish failed for ${ticketId} (non-fatal):`, err?.message || err);
  }
}

async function publishEvent(ticketId, detailType, detail) {
  // ONE timestamp for both writes (and inside detail): the anomaly-watcher
  // dedupes the EventBridge copy against the direct copy by
  // (workflowId, type, timestamp, ticketId, agentId) — two generated
  // timestamps would give the copies different keys and double every sample.
  // TEAM-4120: that same shared timestamp is also what makes the deterministic
  // eventId below reproducible from BOTH writers, so under EVENT_DEDUPE_MODE=
  // enforce the two copies collapse onto one row instead of needing a dedupe.
  //
  // TEAM-4167 D3 (CALL 6 F1): almost always "now", but a caller may ANCHOR an
  // event at an earlier moment — the initial "intake" phase_change is stamped at
  // the run's startedAt so the opening (requirements) phase's duration measures
  // from run start, not from whenever the first agent happened to dispatch.
  // Honor a valid ISO detail.timestamp; otherwise stamp now. deterministicEventId
  // keys off this SAME stamped.timestamp (both writers see it via the EventBridge
  // detail), so an anchored event still collapses onto one row.
  const suppliedTs =
    typeof detail?.timestamp === "string" && !Number.isNaN(Date.parse(detail.timestamp))
      ? detail.timestamp
      : null;
  const timestamp = suppliedTs || new Date().toISOString();
  const stamped = { ...detail, ticketId, timestamp };
  try {
    await events.send(new PutEventsCommand({
      Entries: [{
        Source: "agentcore-hub.orchestrator",
        DetailType: detailType,
        Detail: JSON.stringify(stamped),
        EventBusName: EVENT_BUS,
      }],
    }));
  } catch (err) {
    console.warn(`[orchestrator] Failed to publish event:`, err.message);
  }

  // Also write to events table for dashboard polling
  if (EVENTS_TABLE) {
    try {
      await ddb.send(new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
          workflowId: detail.workflowId || ticketId,
          eventId: eventIdFor(EVENT_DEDUPE_MODE, detailType, stamped, () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
          type: detailType,
          detail: stamped,
          timestamp,
        },
      }));
    } catch { /* non-fatal */ }
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function parseRepoUrl(repoConfig) {
  const url = repoConfig?.repos?.[0]?.url || "";
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return match ? { owner: match[1], repo: match[2] } : { owner: "", repo: "" };
}

/**
 * Resolve the target repo from a Jira ticket's labels. The repo rides on the
 * Bug as `repo:owner/name`; branch is optional via `branch:<name>` (default
 * "main"). This is what lets a single hub route bug fixes to many repositories
 * with zero per-repo configuration.
 *
 * Returns a tri-state so the caller can tell "no label" from "bad label":
 *   { status: "none" }                    → no repo: label at all (fallback OK)
 *   { status: "invalid", slug }           → repo: label present but malformed
 *                                            (must NOT fall back — the ticket
 *                                            explicitly named a repo; a typo
 *                                            routing to DEFAULT_BUG_REPO_URL
 *                                            would open a PR on the wrong repo)
 *   { status: "ok", repoConfig }          → valid repo:owner/name
 */
function repoConfigFromLabels(labels) {
  const repoLabel = (labels || []).find((l) => l.startsWith("repo:"));
  if (!repoLabel) return { status: "none" };
  const slug = repoLabel.slice("repo:".length).trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) return { status: "invalid", slug }; // must be exactly owner/name
  const branchLabel = (labels || []).find((l) => l.startsWith("branch:"));
  const defaultBranch = branchLabel ? branchLabel.slice("branch:".length).trim() : "main";
  return {
    status: "ok",
    repoConfig: { repos: [{ platform: "github", url: `https://github.com/${slug}`, defaultBranch }] },
  };
}

/**
 * Optional single-repo fallback for simple deployments that only ever fix bugs
 * in one repo. Set DEFAULT_BUG_REPO_URL to enable; unset → null (label required).
 */
function defaultBugRepoConfig() {
  const url = process.env.DEFAULT_BUG_REPO_URL;
  if (!url) return null;
  return { repos: [{ platform: "github", url, defaultBranch: process.env.DEFAULT_BUG_REPO_BRANCH || "main" }] };
}

/**
 * Post a plain-text comment on a Bug (best-effort). Used to tell a reporter why
 * bootstrap was skipped and how to retry: transitioning the Bug back to "To Do"
 * re-fires the jira webhook → processStatusChange("todo") → bootstrap re-runs
 * (idempotent), which is the supported retry path since issue_updated events
 * without a status change are not acted on.
 */
async function commentOnBug(bugKey, text) {
  try {
    await jiraFetch(`/rest/api/3/issue/${bugKey}/comment`, "POST", {
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    });
  } catch { /* comment is best-effort */ }
}

/**
 * Unwrap DynamoDB AttributeValue from stream format.
 * Stream records use {"S": "value"}, {"N": "123"}, {"L": [...]}, etc.
 */
function unwrapDdbValue(attr) {
  if (!attr) return undefined;
  if (attr.S !== undefined) return attr.S;
  if (attr.N !== undefined) return Number(attr.N);
  if (attr.BOOL !== undefined) return attr.BOOL;
  if (attr.NULL) return null;
  if (attr.L) return attr.L.map(unwrapDdbValue);
  if (attr.M) {
    const obj = {};
    for (const [k, v] of Object.entries(attr.M)) {
      obj[k] = unwrapDdbValue(v);
    }
    return obj;
  }
  // Already unwrapped (e.g., from DocumentClient format)
  if (typeof attr === "string" || typeof attr === "number" || typeof attr === "boolean") return attr;
  if (Array.isArray(attr)) return attr;
  return attr;
}
