/**
 * agentcore-hub-tickets — Ticket tools Lambda backed by DynamoDB.
 *
 * Deploy this when TICKET_PROVIDER=dynamodb.
 * Agents call this Lambda to create/update/transition tickets stored in DynamoDB.
 *
 * Tools (matching existing gateway schema):
 *   - create_ticket: Create a new issue (story/task/bug/epic)
 *   - get_issue: Read a single issue by key
 *   - edit_issue: Update issue fields
 *   - search_issues: Search by JQL-like query
 *   - transition_issue: Move issue to new status
 *   - get_transitions: Get available transitions for an issue
 *   - add_comment: Add a comment to an issue
 *   - labels_add: Additively append labels to an issue (idempotent)
 *   - list_projects: List projects (returns our single project)
 *   - get_project_issue_types: Get issue types for a project
 *   - lookup_user: Look up agents by name
 *
 * DynamoDB Table Schema:
 *   PK: ticketId (e.g., "TEAM-42")
 *   GSI1: parentId-index (for listing children of an epic)
 *   GSI2: assignee-index (for listing tickets by agent)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
// TEAM-4121 FR-8: the shared fix-ticket contract. Duplicated byte-for-byte into
// the jira Lambda + orchestrator (each ships as a self-contained zip, so they
// cannot share a file); CI byte-compares the copies. Edit one, `cp` the others.
import {
  sanitizeSpawnedBy,
  validateFixContract,
  normalizeContractMode,
  sanitizeUserLabels,
  gateKindsOf,
} from "./fix-contract.mjs";
// TEAM-4739: the shared GATE contract — the label grammar that binds a gate ticket
// to its evidence, the read-only probe, and the verdicts. Byte-identical copy in
// the jira Lambda (each ships as a self-contained zip); CI compares them.
import {
  GATE_AWAITING_CONSOLE_LABEL,
  GATE_AWAITING_CONSOLE_RE,
  GATE_CONDITION_UNMET,
  GATE_LOOP_BROKEN_LABEL,
  consoleApprovalUrl,
  descriptionCarriesConsoleLink,
  gateExecOf,
  gateHeadOf,
  gateLoopRefusal,
  gateLoopVerdict,
  gatePipelineOf,
  gateRefusal,
  gateVerificationLabel,
  invokeProbe,
  parseFixDecision,
  probedGateKindOf,
  publishJourneyEvent,
  verifyGateCondition,
} from "./gate-contract.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE_NAME = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const PROJECT_KEY = process.env.PROJECT_KEY || "TEAM";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
// TEAM-4739. Both are OPTIONAL and both fail SOFT when unset:
//   PIPELINE_TOOLS_LAMBDA — the read-only pipeline probe. Unset ⇒ every gate
//     verdict is `indeterminate`, i.e. every gate close is ADMITTED and stamped.
//     An install without the pipeline module keeps exactly today's behaviour.
//   EVENTS_TABLE — where `gate.repaged` / `workflow.blocked` journey events go.
//     Unset ⇒ no event is written; the refusal itself is unaffected.
const PIPELINE_TOOLS_LAMBDA = process.env.PIPELINE_TOOLS_LAMBDA || "";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: REGION });

const COUNTER_KEY = { ticketId: "__COUNTER__" };

// ─── Agent Roster (config-driven from S3, falls back to hardcoded) ────────────

const FALLBACK_AGENTS = new Set([
  "agentcore_hub_requirements_analyst",
  "agentcore_hub_ios_designer",
  "agentcore_hub_frontend_designer",
  "agentcore_hub_backend_designer",
  "agentcore_hub_android_designer",
  "agentcore_hub_security_reviewer",
  "agentcore_hub_legal_compliance",
  "agentcore_hub_localization",
  "agentcore_hub_analytics_designer",
  "agentcore_hub_backend_dev",
  "agentcore_hub_api_dev",
  "agentcore_hub_frontend_dev",
  "agentcore_hub_code_reviewer",
  "agentcore_hub_qa_verifier",
  "agentcore_hub_ci_agent",
  "agentcore_hub_release_manager",
]);

let VALID_AGENTS = null;

async function loadValidAgents() {
  if (VALID_AGENTS) return VALID_AGENTS;
  if (!ARTIFACT_BUCKET) {
    console.warn("[agentcore-hub-tickets] No ARTIFACT_BUCKET — using fallback roster");
    VALID_AGENTS = FALLBACK_AGENTS;
    return VALID_AGENTS;
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    VALID_AGENTS = new Set(config.agents.map((a) => a.agentId));
    console.log(`[agentcore-hub-tickets] Loaded ${VALID_AGENTS.size} agents from S3 config`);
  } catch (err) {
    console.warn(`[agentcore-hub-tickets] Failed to load roster from S3: ${err.message} — using fallback`);
    VALID_AGENTS = FALLBACK_AGENTS;
  }
  return VALID_AGENTS;
}

// TEAM-3686: known workflow phases, for validating the `phase` stamp on
// fix-kind tickets. completion.mjs's open-fix gate matches fix tickets
// per-phase (`phaseOf(t) === p` for each required phase p), so a fix ticket
// stamped with a phase outside the known set is invisible to EVERY required
// phase's check — the workflow could complete with the fix still open. The
// valid set is derived from the same S3 configs the orchestrator reads:
// roster phases from config/agents.json (what getAgentPhase resolves) and
// each workflow def's agentPhases + completionRequiresAgentPhases from
// config/workflows.json. Fallback mirrors the orchestrator's FALLBACK_ROSTER.
const FALLBACK_PHASES = new Set([
  "requirements",
  "design",
  "development",
  "verification",
  "review",
  "ship",
]);

let VALID_PHASES = null;

async function loadValidPhases() {
  if (VALID_PHASES) return VALID_PHASES;
  if (!ARTIFACT_BUCKET) {
    console.warn("[agentcore-hub-tickets] No ARTIFACT_BUCKET — using fallback phase set");
    VALID_PHASES = FALLBACK_PHASES;
    return VALID_PHASES;
  }
  const phases = new Set();
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    for (const a of config.agents || []) {
      if (typeof a.phase === "string" && a.phase) phases.add(a.phase);
    }
  } catch (err) {
    console.warn(`[agentcore-hub-tickets] Failed to load agent phases from S3: ${err.message}`);
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/workflows.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    for (const w of config.workflows || []) {
      for (const p of w.phases || []) {
        if (typeof p.agentPhase === "string" && p.agentPhase) phases.add(p.agentPhase);
      }
      for (const p of w.completionRequiresAgentPhases || []) {
        if (typeof p === "string" && p) phases.add(p);
      }
    }
  } catch (err) {
    console.warn(`[agentcore-hub-tickets] Failed to load workflow phases from S3: ${err.message}`);
  }
  if (phases.size === 0) {
    console.warn("[agentcore-hub-tickets] No phases loaded from S3 — using fallback phase set");
    VALID_PHASES = FALLBACK_PHASES;
  } else {
    VALID_PHASES = phases;
    console.log(`[agentcore-hub-tickets] Loaded ${phases.size} valid phases from S3 config`);
  }
  return VALID_PHASES;
}

// ─── Agent → phase map (TEAM-4706) ───────────────────────────────────────────
//
// VALID_PHASES above collapses the roster to a SET of phase names, which cannot
// answer the question the ship-phase gate asks: "is THIS ticket's assignee a
// ship-phase agent?" Same loader style, same S3 object (config/agents.json), so a
// roster edit still needs no redeploy — Lambdas pick it up on the next cold start.
// The fallback mirrors src/config/agents.json's pipeline roster, so an S3 read
// failure still recognizes the release manager as ship phase. Twin of the map in
// lambda/agentcore-hub-jira/index.mjs.
const FALLBACK_AGENT_PHASES = new Map([
  ["agentcore_hub_requirements_analyst", "requirements"],
  ["agentcore_hub_frontend_designer", "design"],
  ["agentcore_hub_ios_designer", "design"],
  ["agentcore_hub_backend_designer", "design"],
  ["agentcore_hub_android_designer", "design"],
  ["agentcore_hub_security_reviewer", "design"],
  ["agentcore_hub_legal_compliance", "design"],
  ["agentcore_hub_localization", "design"],
  ["agentcore_hub_analytics_designer", "design"],
  ["agentcore_hub_backend_dev", "development"],
  ["agentcore_hub_api_dev", "development"],
  ["agentcore_hub_frontend_dev", "development"],
  ["agentcore_hub_code_reviewer", "review"],
  ["agentcore_hub_qa_verifier", "verification"],
  ["agentcore_hub_ci_agent", "review"],
  ["agentcore_hub_release_manager", "ship"],
]);

let AGENT_PHASES = null;

async function loadAgentPhases() {
  if (AGENT_PHASES) return AGENT_PHASES;
  if (!ARTIFACT_BUCKET) {
    console.warn("[agentcore-hub-tickets] No ARTIFACT_BUCKET — using fallback agent-phase map");
    AGENT_PHASES = FALLBACK_AGENT_PHASES;
    return AGENT_PHASES;
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACT_BUCKET,
      Key: "config/agents.json",
    }));
    const config = JSON.parse(await res.Body.transformToString());
    const map = new Map();
    for (const a of config.agents || []) {
      if (typeof a.agentId === "string" && a.agentId && typeof a.phase === "string" && a.phase) {
        map.set(a.agentId, a.phase);
      }
    }
    if (map.size === 0) throw new Error("no agentId/phase pairs in config/agents.json");
    AGENT_PHASES = map;
    console.log(`[agentcore-hub-tickets] Loaded ${map.size} agent phases from S3 config`);
  } catch (err) {
    console.warn(`[agentcore-hub-tickets] Failed to load agent phases from S3: ${err.message} — using fallback agent-phase map`);
    AGENT_PHASES = FALLBACK_AGENT_PHASES;
  }
  return AGENT_PHASES;
}

// ─── Ship-phase completion-record gate (TEAM-4706, DL-030) ───────────────────
//
// A ship-phase ticket may not reach done unless the agent's own completion record
// exists at s3://$ARTIFACT_BUCKET/completions/<ticket_id>.json — the record
// lambda/workflow-output writes (reportCompletion) BEFORE it asks this Lambda for
// the transition, and the only durable statement of what actually shipped. Closing
// a ship ticket by hand leaves the run's completion gates, its KPIs and the deploy
// audit trail with nothing to read.
//
// Twin of the block in lambda/agentcore-hub-jira/index.mjs: both providers must
// refuse identically (the twins doctrine, TEAM-4131 F2), so edit both or neither.
// Not in fix-contract.mjs — that module is byte-compared across three copies by
// CI, and each provider expresses the refusal in its own idiom.
const SHIP_PHASE = "ship";

// The refusal payload, verbatim in both providers. `reason` is what an agent (and
// the orchestrator) match on; `hint` names the one call that does this correctly.
const COMPLETION_RECORD_REQUIRED = {
  ok: false,
  reason: "completion_record_required",
  hint: "call WorkflowOutput___report_completion(ticket_id=…) — it writes the record and transitions the ticket for you",
};

/**
 * Is this ticket a ship-phase AGENT ticket? Takes the row transitionIssue already
 * GOT, so the predicate costs no extra read, and the cheap checks come first: only
 * a ship-phase ticket ever pays for the S3 HeadObject.
 *
 * Human-review gates are EXEMPT, and that exemption comes first — the hub UI's
 * approve action (src/app/api/workflow/[id]/tickets/transition/route.ts) and the
 * Telegram bridge's ✅ both transition through this same tool without writing a
 * record, and a Merge Approval gate is itself a ship-phase ticket, so gating them
 * would deadlock every human gate in the pipeline.
 *
 * `phase` is this provider's native carrier (createTicket persists the stamp as a
 * top-level field); the `phase:ship` LABEL is checked too so the predicate reads
 * the same in either provider.
 */
async function isShipPhaseTicket(item) {
  const assignee = String(item?.assignee || "");
  if (assignee.startsWith("human:")) return false;
  const labels = (Array.isArray(item?.labels) ? item.labels : []).map((l) => String(l));
  if (labels.some((l) => l === "human-review" || l.startsWith("reviewer:"))) return false;
  if (item?.phase === SHIP_PHASE || labels.includes(`phase:${SHIP_PHASE}`)) return true;
  if (!assignee) return false;
  const phases = await loadAgentPhases();
  return phases.get(assignee) === SHIP_PHASE;
}

/**
 * POSITIVE proof that completions/<ticketId>.json exists. Fails CLOSED on an
 * indeterminate answer (AccessDenied, throttle, timeout, ARTIFACT_BUCKET unset):
 * "we could not find a record" is not "there is no record", the same
 * positive-evidence rule as DL-028's deploy gate. `why` is log/message text only
 * — never a credential, never the raw AWS error body.
 */
async function completionRecordProven(ticketId) {
  const key = `completions/${ticketId}.json`;
  if (!ARTIFACT_BUCKET) {
    return { proven: false, why: `ARTIFACT_BUCKET is unset, so ${key} cannot be read` };
  }
  try {
    await s3.send(new HeadObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
    return { proven: true, why: `${key} exists` };
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (err?.name === "NotFound" || err?.name === "NoSuchKey" || status === 404) {
      return { proven: false, why: `no ${key} in the artifact bucket` };
    }
    return { proven: false, why: `could not read ${key} (${err?.name || "S3Error"}${status ? ` ${status}` : ""})` };
  }
}

/**
 * The refusal, in this Lambda's idiom: transitionIssue RETURNS its refusals, and
 * the caller-facing text goes in `content` (textResult) — which is also what the
 * hub UI's rejectedDetails() reads as "the ticket did not move". The structured
 * `ok`/`reason`/`hint` keys ride alongside so an agent can match on the reason
 * instead of parsing prose, identically to the jira Lambda.
 */
function completionRecordRequired(issueKey, why) {
  return {
    ...COMPLETION_RECORD_REQUIRED,
    ...textResult(
      `Cannot move ${issueKey} to done: a ship-phase ticket needs its completion record first — ` +
      `${COMPLETION_RECORD_REQUIRED.hint} (${why})`
    ),
  };
}

// ─── TEAM-4739: the typed gate guard ─────────────────────────────────────────
//
// A GATE ticket asserts something about the world outside the pipeline — a human
// approved a production deploy, CI has no build for a SHA, a blocker is gone — and
// until now nothing checked the assertion: a persona could close one from memory
// and the cascade would dispatch downstream work over an unproven gate.
//
// Composed with the ship-phase completion gate above, not instead of it:
// gateConditionCleared runs the completion-record check FIRST (byte-unchanged),
// then the typed-gate check. Only a `→ done` transition is guarded, and only a
// ticket carrying a `gate:<kind>` label pays anything at all.
//
// THE FAIL DIRECTION (gate-contract.mjs's header has the full argument): this
// answers "may this gate CLOSE?", whose dangerous failure is an unliftable stall —
// there is no escalation rung above the human. So it refuses only on a DEFINITE
// NEGATIVE (a successful probe read that contradicts the close) and ADMITS
// everything indeterminate, stamping `gateVerification` so the close is auditable.
// DL-028's positive-evidence rule answers a DIFFERENT question ("may I deploy?")
// and is untouched: nothing here can trigger or approve a deploy.
//
// Twin of the block in lambda/agentcore-hub-jira/index.mjs — both providers must
// refuse with byte-identical strings, which is why every string comes from
// gate-contract.mjs and only the storage idiom differs.

/**
 * The ship-phase completion gate, then the typed-gate check.
 * @returns {Promise<{refusal?:object, verification?:object}>} `refusal` ⇒ return it
 *   verbatim and write NOTHING; `verification` ⇒ fold it into the status update.
 */
async function gateConditionCleared(issueKey, item) {
  // TEAM-4706 (DL-030), unchanged: a ship-phase ticket cannot reach done without
  // its completion record.
  if (await isShipPhaseTicket(item)) {
    const proof = await completionRecordProven(issueKey);
    if (!proof.proven) {
      console.warn(
        `[agentcore-hub-tickets] ${issueKey}: refusing done on a ship-phase ticket — ${proof.why}`
      );
      return { refusal: completionRecordRequired(issueKey, proof.why) };
    }
  }
  return verifyTypedGate(issueKey, item);
}

/**
 * Probe the condition a gate ticket asserts. Returns `{}` — no probe, no stamp, no
 * extra read, byte-identical to the pre-TEAM-4739 path — for any ticket that is not
 * a PROBED gate: a plain ticket, and deliberately also a `gate:approval` human
 * escalation gate (see PROBED_GATE_KINDS).
 */
async function verifyTypedGate(issueKey, item) {
  const labels = Array.isArray(item?.labels) ? item.labels : [];
  if (gateKindsOf(labels).length === 0) return {};
  const gateKind = probedGateKindOf(labels);
  if (!gateKind) return {};

  const verdict = await verifyGateCondition(PIPELINE_TOOLS_LAMBDA, {
    gateKind,
    pipeline: gatePipelineOf(labels),
    execId: gateExecOf(labels),
    head: gateHeadOf(labels),
    // ADVISORY only: a DECISION line can lift an environmental stall, it can never
    // manufacture a `verified`.
    decision: parseFixDecision(item?.description),
    region: REGION,
  });

  if (!verdict.refuse) return { verification: verdict.verification };

  const refusal = gateRefusal({ ticketId: issueKey, gateKind, verdict });
  await repageGate(issueKey, item, gateKind, verdict, refusal);
  return { refusal: { ...refusal.payload, ...textResult(refusal.message) } };
}

/**
 * The refusal's side effects. The ticket STAYS WHERE IT IS — there is no
 * `awaiting_console` status — so all this does is make the stall visible: the
 * `gate:awaiting-console` label (which the Telegram bridge re-pages on), one
 * `gate.repaged` journey event, and one comment carrying the console deep link.
 *
 * It NEVER dispatches, and it never creates a ticket: a gate that cannot be closed
 * is answered by verifying the condition, not by filing a second gate.
 *
 * The conditional `list_append` inside addLabels is the EVENT DEDUPE: the label
 * lands once, so the first refusal pages and every later refusal on the same stall
 * repeats the payload in silence. Every side effect is best-effort — a correct
 * refusal must not turn into a tool error because the events table throttled.
 */
async function repageGate(issueKey, item, gateKind, verdict, refusal) {
  let newlyLabelled = false;
  try {
    const res = await addLabels({ ticket_id: issueKey, labels: [GATE_AWAITING_CONSOLE_LABEL] });
    newlyLabelled = Array.isArray(res?.added) && res.added.includes(GATE_AWAITING_CONSOLE_LABEL);
  } catch (err) {
    console.warn(`[agentcore-hub-tickets] ${issueKey}: could not label the parked gate — ${err?.name}`);
  }

  if (newlyLabelled) {
    // SEC-16: the run id comes from the ROW, never from a caller argument.
    await publishJourneyEvent(ddb, EVENTS_TABLE, item?.workflowId, "gate.repaged", {
      ticketId: issueKey,
      gateKind,
      consoleUrl: verdict.consoleUrl,
      attempt: 1,
    });
  }

  try {
    await addComment({ ticket_id: issueKey, body: refusal.comment, author: "gate-guard" });
  } catch (err) {
    console.warn(`[agentcore-hub-tickets] ${issueKey}: could not comment the refusal — ${err?.name}`);
  }
}

/**
 * How the verification stamp is written into the SAME UpdateCommand as the status.
 *
 * `gate:awaiting-console` must come off in that same call, and DynamoDB rejects an
 * expression that touches both `labels` and `labels[i]`, so the slot the parked
 * label occupies is OVERWRITTEN with the verification label rather than removed and
 * re-appended. One document path, no whole-list SET (which would clobber a
 * concurrent writer's labels — see addLabels), and the `labels[i] = :awaiting`
 * condition makes the write safe against a racing label edit.
 *
 * @returns {null|{set?:string, remove?:string, condition?:string, names:object, values:object}}
 */
function planGateLabelWrite(item, verification) {
  const stamp = gateVerificationLabel(verification?.result);
  const labels = Array.isArray(item?.labels) ? item.labels : [];
  const lower = labels.map((l) => String(l ?? "").trim().toLowerCase());
  const idx = lower.findIndex((l) => GATE_AWAITING_CONSOLE_RE.test(l));
  const hasStamp = Boolean(stamp) && lower.includes(stamp);

  if (idx < 0) {
    if (!stamp || hasStamp) return null;
    return {
      set: "#l = list_append(if_not_exists(#l, :emptyl), :stampl)",
      names: { "#l": "labels" },
      values: { ":emptyl": [], ":stampl": [stamp] },
    };
  }
  const names = { "#l": "labels" };
  const condition = `#l[${idx}] = :awaiting`;
  const values = { ":awaiting": labels[idx] };
  if (!stamp || hasStamp) return { remove: `#l[${idx}]`, condition, names, values };
  return {
    set: `#l[${idx}] = :stampl`,
    condition,
    names,
    values: { ...values, ":stampl": stamp },
  };
}

/**
 * Refuse a THIRD gate ticket of the same kind against the same target under one
 * epic — the environmental loop that has an agent re-filing "CI is unavailable"
 * forever instead of starting a build.
 *
 * Narrowed to PROBED_GATE_KINDS: a `gate:approval` human escalation is deliberately
 * RE-FILED when a round cap trips, so counting those as a loop would break the one
 * escalation path the system has.
 *
 * FAILS OPEN in every direction — an unreadable epic, an unlabelable epic, an
 * unwritable event — because a loop breaker that blocks ticket creation whenever it
 * cannot read is a wedge, not a guard. It NEVER writes the workflows table.
 *
 * @returns {Promise<object|null>} the refusal to return from createTicket, or null
 */
async function refuseGateLoop({ labels, blockedBy, parentId }) {
  const gateKind = probedGateKindOf(labels);
  if (!gateKind || !parentId) return null;

  let siblings = [];
  let epic = null;
  try {
    const [kids, parent] = await Promise.all([
      ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "parentId-index",
          KeyConditionExpression: "parentId = :pid",
          ExpressionAttributeValues: { ":pid": parentId },
        })
      ),
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { ticketId: parentId } })),
    ]);
    siblings = (kids.Items || [])
      .filter((i) => i.ticketId !== "__COUNTER__")
      .map((i) => ({ id: i.ticketId, labels: i.labels, blockedBy: i.blockedBy }));
    epic = parent.Item || null;
  } catch (err) {
    console.warn(
      `[agentcore-hub-tickets] could not scan ${parentId} for a gate loop, creating normally — ${err?.name}`
    );
    return null;
  }

  const head = gateHeadOf(labels);
  const verdict = gateLoopVerdict(siblings, { gateKind, blockedBy, head });
  if (!verdict.loop) return null;

  // The epic carries the marker, and the conditional add's outcome is the EVENT
  // dedupe — exactly as with gate:awaiting-console. The 3rd attempt pages; the 4th
  // and every later one refuses with the same payload and emits nothing.
  let newlyBroken = false;
  try {
    const res = await addLabels({ ticket_id: parentId, labels: [GATE_LOOP_BROKEN_LABEL] });
    newlyBroken = Array.isArray(res?.added) && res.added.includes(GATE_LOOP_BROKEN_LABEL);
  } catch (err) {
    console.warn(`[agentcore-hub-tickets] could not label epic ${parentId} — ${err?.name}`);
  }

  const refusal = gateLoopRefusal({ gateKind, verdict, epicId: parentId });
  if (newlyBroken) {
    // SEC-16 again: workflowId off the EPIC row. `attempt` is how many of these
    // already exist (2 at GATE_LOOP_THRESHOLD), not a counter of our own.
    await publishJourneyEvent(ddb, EVENTS_TABLE, epic?.workflowId, "workflow.blocked", {
      reason: "environmental",
      gateKind,
      blockedByTicketId: refusal.payload.existingTicketId,
      head: head || "",
      attempt: verdict.priorCount,
    });
  }
  return { ...refusal.payload, ...textResult(refusal.message) };
}

/**
 * A `gate:deploy-approval` ticket must be USABLE by the human it will page: bound
 * to exactly one execution and one pipeline, and carrying the console deep link.
 *
 * Scoped to that one kind — every other gate has nothing to bind and nothing to
 * link. `capabilities().approveDeploy` is a hardcoded `false` (DL-028: the deploy
 * gate is human-only, and no tool may approve it), so the link requirement always
 * applies; the probe earns its keep as the only read that can tell us the
 * `pipeline:` label names a pipeline the hub is actually allowed to reach.
 *
 * FAIL DIRECTION, again: an UNREACHABLE probe creates the ticket. Only a successful
 * read that reports the pipeline unregistered refuses.
 *
 * @returns {Promise<object|null>}
 */
async function validateGateTicketShape({ labels, description }) {
  const list = Array.isArray(labels) ? labels : [];
  if (!gateKindsOf(list).includes("deploy-approval")) return null;

  const refuse = (hint) => ({ ok: false, reason: GATE_CONDITION_UNMET, hint, ...textResult(hint) });
  const lower = list.map((l) => String(l ?? "").trim().toLowerCase());
  const execLabels = lower.filter((l) => /^exec[:-]/.test(l));
  const pipeLabels = lower.filter((l) => /^pipeline[:-]/.test(l));
  const execId = gateExecOf(list);
  const pipeline = gatePipelineOf(list);

  if (execLabels.length !== 1 || !execId) {
    return refuse(
      `a deploy-approval gate must carry exactly one \`exec:<execution-id>\` label (found ${execLabels.length}) — ` +
        `without it nobody can tell which pipeline execution the human is being asked about`
    );
  }
  if (pipeLabels.length !== 1 || !pipeline) {
    return refuse(
      `a deploy-approval gate must carry exactly one \`pipeline:<name>\` label (found ${pipeLabels.length}) — ` +
        `without it the gate cannot be verified or linked to a console`
    );
  }

  const probe = await invokeProbe(PIPELINE_TOOLS_LAMBDA, "Pipeline___capabilities", {
    pipeline_name: pipeline,
  });
  if (!probe.ok) return null; // unreachable ⇒ create; never a wall
  const caps = probe.result || {};
  if (caps.ok === false) {
    return refuse(
      `pipeline "${pipeline}" is not one the hub may reach (${caps.reason || "pipeline_not_registered"}) — ` +
        `use a \`pipeline:\` label naming an entry in the CD registry`
    );
  }
  if (caps.approveDeploy === false && !descriptionCarriesConsoleLink(description, { pipeline, region: REGION })) {
    return refuse(
      `a deploy-approval gate with no approve capability must carry the console link: ` +
        consoleApprovalUrl({ pipeline, region: REGION })
    );
  }
  return null;
}

// Valid status transitions
// Simplified flow: todo → ready → in_progress → done  (+blocked as escape hatch)
const TRANSITIONS = {
  todo: [
    { id: "ready", name: "Mark Ready", to: "ready" },
    { id: "block", name: "Block", to: "blocked" },
  ],
  ready: [
    { id: "start", name: "Start Progress", to: "in_progress" },
    { id: "block", name: "Block", to: "blocked" },
  ],
  in_progress: [
    { id: "done", name: "Done", to: "done" },
    { id: "in_review", name: "Send to Review", to: "in_review" },
    { id: "block", name: "Block", to: "blocked" },
  ],
  // Human-review gate states: approve (→done) or request changes (→blocked).
  in_review: [
    { id: "done", name: "Approve", to: "done" },
    { id: "block", name: "Request Changes", to: "blocked" },
  ],
  blocked: [
    { id: "unblock", name: "Unblock", to: "todo" },
    { id: "ready", name: "Mark Ready", to: "ready" },
    { id: "start", name: "Start Progress", to: "in_progress" },
    { id: "in_review", name: "Send to Review", to: "in_review" },
    { id: "skip", name: "Skip", to: "done" },
  ],
  done: [
    { id: "reopen", name: "Reopen", to: "todo" },
  ],
};

export const handler = async (event) => {
  console.log("Jira MCP invoked:", JSON.stringify(event));

  // Load roster from S3 on first invocation (cached for warm starts)
  await loadValidAgents();

  // Gateway sends tool name via different field patterns
  let toolName = event._tool_name || event.tool_name || event.name || detectTool(event);
  // Strip prefix (agents call as "Tickets___create_ticket" → "create_ticket")
  if (toolName && toolName.includes("___")) {
    toolName = toolName.split("___").pop();
  }
  // Arguments may come nested under "arguments" or "input" or "parameters" or at top level
  const args = event.parameters || event.arguments || event.input || event;

  try {
    switch (toolName) {
      case "create_ticket":
        return await createTicket(args);
      case "get_issue":
        return await getIssue(args);
      case "edit_issue":
        return await editIssue(args);
      case "search_issues":
        return await searchIssues(args);
      case "list_tickets":
        return await listTickets(args);
      case "transition_issue":
      case "transition_ticket":
        return await transitionIssue(args);
      case "get_transitions":
        return await getTransitions(args);
      case "add_comment":
        return await addComment(args);
      case "labels_add":
        return await addLabels(args);
      case "list_projects":
        return await listProjects();
      case "get_project_issue_types":
        return await getProjectIssueTypes(args);
      case "lookup_user":
        return await lookupUser(args);
      default: {
        // Return an `error` field so callers (e.g. workflow-output) can tell a
        // no-op from a real result. Without this, an unrecognized tool name
        // looked like success and silently stalled the pipeline.
        const message = `Unknown tool: "${toolName}". Available: create_ticket, get_issue, edit_issue, search_issues, list_tickets, transition_issue (alias: transition_ticket), get_transitions, add_comment, labels_add, list_projects, get_project_issue_types, lookup_user`;
        return { error: message, content: [{ text: message }] };
      }
    }
  } catch (err) {
    console.error("Tool execution error:", err);
    return textResult(`Error: ${err.message}`);
  }
};

// ─── Tool Implementations ──────────────────────────────────────────────────

// TEAM-3619 D4c: the fix-ticket kinds the completion re-verify (completion.mjs
// condition iii) recognizes, the origin-id keys each may carry, and the
// spawned_by sanitizer all moved to fix-contract.mjs (TEAM-4121 FR-8) so the
// jira Lambda and the orchestrator validate against the SAME definitions
// instead of three drifting copies.

// TEAM-4121 FR-8: off = fix-contract fields are ignored (byte-identical to
// pre-feature behavior); shadow = validate + accept + warn; enforce = reject an
// incomplete contract. Read once at module load — a mode change is a deploy.
const FIX_TICKET_CONTRACT = normalizeContractMode(process.env.FIX_TICKET_CONTRACT);

/**
 * TEAM-4537: DynamoDB has no summary-length limit, but create_ticket/edit_issue
 * must return the same `summary`/`title` under either ticket backend — parity
 * at the tool interface is the contract (TEAM-4131 F2's twins doctrine), so a
 * title that would 400 in Jira mode is clamped identically here. Byte-identical
 * to the copy in lambda/agentcore-hub-jira/index.mjs.
 *
 * Trims to a word boundary when that keeps at least 200 chars, so a title with
 * no whitespace near the cut still clamps instead of growing unbounded. The
 * full text always survives separately in the description — this only shortens
 * what's stored/returned as the summary.
 *
 * Kept local rather than added to fix-contract.mjs — that module is byte-compared
 * across three copies by CI, and this clamp needs no cross-Lambda contract.
 */
export function clampSummary(s) {
  if (typeof s !== "string" || s.length <= 255) return s;
  let cut = s.slice(0, 254);
  // Slicing by UTF-16 code units can land inside a surrogate pair (emoji, astral
  // CJK) and leave a lone high surrogate — a visibly corrupted summary. Back up
  // one code unit so the cut always falls on a whole code point.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace >= 200 ? cut.slice(0, lastSpace) : cut;
  return trimmed.trimEnd() + "…";
}

async function createTicket(args) {
  const { summary: rawSummary, project_key, issue_type, description, assignee, priority, parent_key, blocked_by, workflow_id, spawned_by, phase, fix_contract, labels } = args;
  if (!rawSummary) return textResult("Error: 'summary' is required");
  const summary = clampSummary(rawSummary);

  // TEAM-3619 D4c: optional fix-ticket provenance. Validate before minting so a
  // bad marker is a clear error, not a silently-dropped/garbage field.
  const spawn = sanitizeSpawnedBy(spawned_by);
  if (spawn.error) return textResult(`Error: ${spawn.error}`);
  const phaseStamp = typeof phase === "string" && phase.trim() ? phase.trim() : undefined;

  // TEAM-3686: a fix-kind ticket's `phase` stamp is trusted FIRST by
  // completion.mjs's phaseOf(), and its open-fix gate only blocks completion
  // when the stamp matches a required phase exactly. An unknown phase (e.g.
  // "zz_nonexistent") therefore bypasses the gate entirely — the run can be
  // declared complete while the fix is still open. Reject rather than
  // normalize so the caller learns immediately which phases are legal.
  if (spawn.value && phaseStamp) {
    const validPhases = await loadValidPhases();
    if (!validPhases.has(phaseStamp)) {
      return textResult(
        `Error: 'phase' "${phaseStamp}" is not a known workflow phase — a fix ticket ` +
        `with an unknown phase would be invisible to the completion open-fix gate. ` +
        `Valid phases: ${[...validPhases].sort().join(", ")}`
      );
    }
  }

  // TEAM-4121 FR-8: the fix contract. Evaluated only for fix tickets (a plain
  // ticket is never subject to it) and only when the flag is on, so mode=off is
  // byte-identical to before: nothing validated, nothing stored, the
  // fix_contract arg ignored entirely.
  let contract = null;          // what gets persisted as item.fixContract
  let contractWarning = null;   // shadow-mode advisory returned to the caller
  if (spawn.value && FIX_TICKET_CONTRACT !== "off") {
    const fc = validateFixContract({ spawnedBy: spawn.value, ...(fix_contract || {}) });
    const detail = [
      fc.missing.length ? `missing: ${fc.missing.join(", ")}` : null,
      fc.invalid.length ? `invalid: ${fc.invalid.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    if (!fc.ok && FIX_TICKET_CONTRACT === "enforce") {
      // Mint NOTHING — the ticket id counter is not even touched. An agent that
      // gets this back has everything it needs to retry correctly, which is the
      // whole point of rejecting instead of filing an unactionable fix.
      const firstProblem = fc.missing[0] || fc.invalid[0];
      return textResult(`Error: '${firstProblem}' is required on a fix ticket (${detail})`);
    }
    if (!fc.ok) {
      // shadow — accept, but persist the warnings alongside whatever parsed so
      // the incomplete fix tickets are findable before enforce is switched on.
      const warnings = [...fc.missing, ...fc.invalid];
      contract = fc.contract ? { ...fc.contract, warnings } : { version: 1, warnings };
      contractWarning = `WARNING: fix contract incomplete (${detail})`;
      console.warn(`[agentcore-hub-tickets] fix contract incomplete (shadow, accepting): ${detail}`);
    } else {
      contract = fc.contract;
    }
  }

  // Caller-supplied labels are sanitized independently of the contract flag —
  // dropping a label that squats a system namespace (fix:/wf:/agent:/…) is a
  // provenance-forgery guard, not a contract rule.
  //
  // TEAM-4131 F2: the ticket's SHAPE goes in too, so `advisory` is refused on a
  // fix ticket or a human gate — on those, the label is a completion-gate bypass
  // (see RESERVED_ADVISORY_LABEL), not a routing hint. `spawn.value` is the
  // already-sanitized marker, so a junk kind cannot buy the exemption.
  const userLabels = sanitizeUserLabels(labels, { spawnedBy: spawn.value, assignee });

  // Validate assignee against known agent roster. "human:<who>" assignees are
  // human-review gates — not agents — and are always allowed (the orchestrator
  // parks them for a person instead of invoking an agent).
  const isHumanReviewer = typeof assignee === "string" && assignee.startsWith("human:");
  if (assignee && !isHumanReviewer && !VALID_AGENTS.has(assignee)) {
    return textResult(
      `Error: Invalid assignee "${assignee}". Valid agents are: ${[...VALID_AGENTS].join(", ")}. ` +
      `Note: There is NO "agentcore_hub_ios_dev" agent. iOS/SwiftUI development goes to "agentcore_hub_frontend_dev".`
    );
  }

  // TEAM-4739: the two GATE seams. Both run on the sanitized label list, after the
  // roster check and BEFORE the id counter is touched, so a refusal costs no ticket
  // number — the same rule the fix-contract enforce path follows above. Both fail
  // OPEN: an unreadable epic or an unreachable probe files the ticket.
  const loopRefusal = await refuseGateLoop({
    labels: userLabels.labels,
    blockedBy: blocked_by,
    parentId: parent_key,
  });
  if (loopRefusal) return loopRefusal;

  const shapeRefusal = await validateGateTicketShape({ labels: userLabels.labels, description });
  if (shapeRefusal) return shapeRefusal;

  const ticketId = await nextTicketId(project_key);
  const now = new Date().toISOString();
  const type = (issue_type || "Task").toLowerCase();
  const blockers = Array.isArray(blocked_by) ? blocked_by : blocked_by ? [blocked_by] : [];
  const status = blockers.length > 0 ? "blocked" : "todo";

  // DynamoDB GSI keys cannot be null — omit fields entirely if empty
  const item = {
    ticketId,
    type,
    title: summary,
    description: description || "",
    status,
    ...(assignee ? { assignee } : {}),
    ...(parent_key ? { parentId: parent_key } : {}),
    workflowId: workflow_id || null,
    priority: priority || "Medium",
    comments: [],
    artifacts: [],
    blockedBy: blockers,
    createdAt: now,
    updatedAt: now,
    // TEAM-3619 D4c: fix-ticket provenance, persisted in the exact shape the
    // orchestrator's completion re-verify reads (completion.mjs condition iii)
    // and index.mjs handleReviewRejection writes. Omitted entirely when absent,
    // so a plain ticket is byte-for-byte what it was before.
    ...(spawn.value ? { spawnedBy: spawn.value } : {}),
    ...(phaseStamp ? { phase: phaseStamp } : {}),
    // TEAM-4121 FR-8: the fix contract (absent entirely under mode=off, or on a
    // plain ticket) and the caller's sanitized labels.
    ...(contract ? { fixContract: contract } : {}),
    ...(userLabels.labels.length > 0 ? { labels: userLabels.labels } : {}),
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return {
    key: ticketId,
    self: `https://your-domain.atlassian.net/browse/${ticketId}`,
    status: "created",
    // TEAM-4121 FR-8: the caller learns what was refused. `warning` says the
    // ticket was FILED with an incomplete contract (shadow only — enforce
    // returns an error instead); `droppedLabels` says a label was refused, so
    // an agent isn't left wondering why its own filter finds nothing.
    ...(contractWarning ? { warning: contractWarning } : {}),
    ...(userLabels.dropped.length > 0 ? { droppedLabels: userLabels.dropped } : {}),
    ticket: {
      key: ticketId,
      summary,
      description: description || "",
      type: issue_type || "Task",
      status,
      assignee: assignee || "unassigned",
      priority: priority || "Medium",
      parent: parent_key || null,
      blocked_by: blockers,
      created: now,
      ...(spawn.value ? { spawned_by: spawn.value } : {}),
      ...(phaseStamp ? { phase: phaseStamp } : {}),
      ...(contract ? { fix_contract: contract } : {}),
      ...(userLabels.labels.length > 0 ? { labels: userLabels.labels } : {}),
    },
  };
}

async function getIssue(args) {
  const issueKey = args.issue_key || args.ticket_id;
  if (!issueKey) return textResult("Error: 'issue_key' is required");

  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { ticketId: issueKey } })
  );

  if (!result.Item) return textResult(`Issue ${issueKey} not found.`);

  const t = result.Item;
  return {
    key: t.ticketId,
    self: `https://your-domain.atlassian.net/browse/${t.ticketId}`,
    fields: {
      summary: t.title,
      description: t.description || "",
      issuetype: { name: t.type },
      status: { name: t.status },
      assignee: t.assignee ? { displayName: t.assignee } : null,
      priority: { name: t.priority || "Medium" },
      parent: t.parentId ? { key: t.parentId } : null,
      created: t.createdAt,
      updated: t.updatedAt,
      comment: {
        total: (t.comments || []).length,
        comments: (t.comments || []).map((c) => ({
          author: { displayName: c.author },
          body: c.content,
          created: c.timestamp,
        })),
      },
    },
    blockedBy: t.blockedBy || [],
  };
}

async function editIssue(args) {
  const issueKey = args.issue_key || args.ticket_id;
  if (!issueKey) return textResult("Error: 'issue_key' is required");

  const updates = [];
  const names = {};
  const values = {};

  if (args.summary !== undefined) {
    updates.push("#t = :t");
    names["#t"] = "title";
    values[":t"] = clampSummary(args.summary);
  }
  if (args.description !== undefined) {
    updates.push("#d = :d");
    names["#d"] = "description";
    values[":d"] = args.description;
  }
  if (args.assignee !== undefined) {
    updates.push("#a = :a");
    names["#a"] = "assignee";
    values[":a"] = args.assignee;
  }
  if (args.priority !== undefined) {
    updates.push("#p = :p");
    names["#p"] = "priority";
    values[":p"] = args.priority;
  }
  if (args.blocked_by !== undefined) {
    const blockers = Array.isArray(args.blocked_by) ? args.blocked_by : args.blocked_by ? [args.blocked_by] : [];
    updates.push("#bb = :bb");
    names["#bb"] = "blockedBy";
    values[":bb"] = blockers;
    // If adding blockers, also set status to blocked
    if (blockers.length > 0) {
      updates.push("#s = :s");
      names["#s"] = "status";
      values[":s"] = "blocked";
    }
  }

  if (updates.length === 0) return textResult("Error: no fields to update");

  updates.push("#u = :u");
  names["#u"] = "updatedAt";
  values[":u"] = new Date().toISOString();

  const result = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { ticketId: issueKey },
      UpdateExpression: `SET ${updates.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );

  const ticket = result.Attributes;
  return {
    key: issueKey,
    status: "updated",
    fields: {
      summary: ticket.title,
      status: { name: ticket.status },
      assignee: ticket.assignee ? { displayName: ticket.assignee } : null,
      priority: { name: ticket.priority },
      updated: ticket.updatedAt,
    },
  };
}

/**
 * Normalize a SYSTEM label (TEAM-4122 FR-5). Deliberately NOT sanitizeUserLabels:
 * that one maps ":" → "-" and refuses the reserved namespaces, which is exactly
 * right for an agent-supplied label and exactly wrong for `ci:uncertifiable`,
 * which the orchestrator owns. The one hard rule both providers share is
 * Jira's: a label may not contain whitespace. Returns "" for anything unusable.
 *
 * Kept local to each ticket Lambda rather than added to fix-contract.mjs — that
 * module is byte-compared across three copies by CI, and `labels_add` needs no
 * cross-Lambda contract, only the same behaviour.
 */
function normalizeSystemLabel(label) {
  if (typeof label !== "string") return "";
  const lowered = label.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(lowered)) return "";
  return lowered;
}

/**
 * Additively append labels to a ticket — the DynamoDB twin of Jira's
 * `update: { labels: [{ add }] }`. ADDITIVE and IDEMPOTENT by construction: one
 * conditional `list_append` per label, guarded by `NOT contains(labels, :l)`, so
 * a redelivered call (stream re-poll, retried invocation) cannot duplicate an
 * entry and a concurrent writer's labels are never clobbered. Never a full-list
 * SET — that would silently drop a label another writer added.
 */
async function addLabels(args) {
  const issueKey = args.issue_key || args.ticket_id;
  if (!issueKey) return textResult("Error: 'issue_key' is required");

  const raw = Array.isArray(args.labels)
    ? args.labels
    : typeof args.labels === "string"
      ? args.labels.split(",")
      : args.labels
        ? [args.labels]
        : [];
  const wanted = [];
  const dropped = [];
  for (const item of raw) {
    const norm = normalizeSystemLabel(item);
    if (!norm) {
      if (item !== undefined && item !== null && String(item).trim() !== "") dropped.push(String(item));
      continue;
    }
    if (!wanted.includes(norm)) wanted.push(norm);
  }
  if (wanted.length === 0) return textResult("Error: no valid labels to add");

  const added = [];
  const alreadyPresent = [];
  for (const label of wanted) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { ticketId: issueKey },
          UpdateExpression: "SET #l = list_append(if_not_exists(#l, :empty), :one), #u = :u",
          // attribute_exists(ticketId) keeps this from CREATING a row for a
          // typo'd key (an Update with no condition is an upsert).
          ConditionExpression:
            "attribute_exists(ticketId) AND (attribute_not_exists(#l) OR NOT contains(#l, :label))",
          ExpressionAttributeNames: { "#l": "labels", "#u": "updatedAt" },
          ExpressionAttributeValues: {
            ":empty": [],
            ":one": [label],
            ":label": label,
            ":u": new Date().toISOString(),
          },
        })
      );
      added.push(label);
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        // Either the label is already there (the idempotent case) or the ticket
        // does not exist. Distinguish, so a bad key is not reported as success.
        const existing = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { ticketId: issueKey } }));
        if (!existing.Item) return textResult(`Error: ticket ${issueKey} not found`);
        alreadyPresent.push(label);
        continue;
      }
      throw err;
    }
  }

  return {
    key: issueKey,
    status: "labels_added",
    added,
    alreadyPresent,
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}

async function searchIssues(args) {
  // The runtime tool sends `query`; accept `jql` too so both providers match.
  const { query, jql: jqlArg, max_results } = args;
  const jql = query || jqlArg;
  const limit = max_results || 50;

  // Simple JQL parsing — supports common patterns:
  // "project = TEAM", "assignee = agentcore_hub_frontend_dev", "parent = TEAM-42", "status = todo"
  let filterExpression = null;
  let exprNames = {};
  let exprValues = {};

  if (jql) {
    const lower = jql.toLowerCase();

    if (lower.includes("parent =") || lower.includes("parent=")) {
      const parentMatch = jql.match(/parent\s*=\s*["']?([^"'\s,]+)/i);
      if (parentMatch) {
        // Use GSI query for parent
        const result = await ddb.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: "parentId-index",
            KeyConditionExpression: "parentId = :pid",
            ExpressionAttributeValues: { ":pid": parentMatch[1] },
            Limit: limit,
          })
        );
        const items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
        return formatSearchResults(items);
      }
    }

    if (lower.includes("assignee =") || lower.includes("assignee=")) {
      const assigneeMatch = jql.match(/assignee\s*=\s*["']?([^"'\s,]+)/i);
      if (assigneeMatch) {
        const result = await ddb.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: "assignee-index",
            KeyConditionExpression: "assignee = :a",
            ExpressionAttributeValues: { ":a": assigneeMatch[1] },
            Limit: limit,
          })
        );
        const items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
        return formatSearchResults(items);
      }
    }

    if (lower.includes("status =") || lower.includes("status=")) {
      const statusMatch = jql.match(/status\s*=\s*["']?([^"'\s,]+)/i);
      if (statusMatch) {
        filterExpression = "#s = :s";
        exprNames["#s"] = "status";
        exprValues[":s"] = statusMatch[1].toLowerCase();
      }
    }
  }

  // Fallback: scan with optional filter
  const scanParams = { TableName: TABLE_NAME, Limit: limit };
  if (filterExpression) {
    scanParams.FilterExpression = filterExpression;
    scanParams.ExpressionAttributeNames = exprNames;
    scanParams.ExpressionAttributeValues = exprValues;
  }

  const result = await ddb.send(new ScanCommand(scanParams));
  const items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
  return formatSearchResults(items);
}

async function listTickets(args) {
  const { parent_id, assignee, workflow_id, status } = args;

  let items = [];

  if (parent_id) {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "parentId-index",
        KeyConditionExpression: "parentId = :pid",
        ExpressionAttributeValues: { ":pid": parent_id },
      })
    );
    items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
  } else if (assignee) {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "assignee-index",
        KeyConditionExpression: "assignee = :a",
        ExpressionAttributeValues: { ":a": assignee },
      })
    );
    items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
  } else {
    const result = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, Limit: 50 }));
    items = (result.Items || []).filter((i) => i.ticketId !== "__COUNTER__");
  }

  // Apply optional filters
  if (workflow_id) items = items.filter((i) => i.workflowId === workflow_id);
  if (status) items = items.filter((i) => i.status === status);

  return formatSearchResults(items);
}

async function transitionIssue(args) {
  const issueKey = args.issue_key || args.ticket_id;
  const transitionId = args.transition_id || args.to_status;
  if (!issueKey) return textResult("Error: 'issue_key' is required");
  if (!transitionId) return textResult("Error: 'transition_id' is required");

  // Get current ticket to determine valid transitions
  const current = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { ticketId: issueKey } })
  );
  if (!current.Item) return textResult(`Issue ${issueKey} not found.`);

  const currentStatus = current.Item.status || "todo";
  const available = TRANSITIONS[currentStatus] || [];

  // Find the transition by ID or by target status name
  const transition = available.find(
    (t) => t.id === transitionId || t.to === transitionId || t.name.toLowerCase() === transitionId.toLowerCase()
  );

  if (!transition) {
    return textResult(
      `Invalid transition "${transitionId}" from status "${currentStatus}". ` +
      `Available: ${available.map((t) => `${t.id} (→ ${t.to})`).join(", ")}`
    );
  }

  // "in_review" is a human-review-gate state. Only tickets assigned to a human
  // reviewer (assignee "human:*") may enter it — an agent ticket parked there
  // would never be invoked and would stall forever.
  if (transition.to === "in_review" && !String(current.Item.assignee || "").startsWith("human:")) {
    return textResult(
      `Cannot move ${issueKey} to in_review: only human-review tickets (assignee "human:*") can be sent to review.`
    );
  }

  // TEAM-4706 (DL-030) + TEAM-4739: a ship-phase ticket cannot reach done without
  // its completion record, and a typed GATE ticket cannot reach done against
  // evidence that contradicts the close. Placed before the update is built so a
  // refused transition writes nothing at all. The RESOLVED target is what is tested,
  // not the requested transition id, so the `skip` row — which is how a blocked
  // ticket reaches done (TEAM-4130 F1) — cannot walk around either gate. The row is
  // already in hand, so a non-ship, non-gate ticket costs no extra read, no S3 call
  // and no probe.
  let gateVerification = null;
  if (transition.to === "done") {
    const gate = await gateConditionCleared(issueKey, current.Item);
    if (gate.refusal) return gate.refusal;
    gateVerification = gate.verification || null;
  }

  // Build update expression — include skipReason if "skip" transition with a reason
  const now = new Date().toISOString();
  const reason = args.reason || args.skip_reason;
  let updateExpr = "SET #s = :s, #u = :u";
  let exprNames = { "#s": "status", "#u": "updatedAt" };
  let exprValues = { ":s": transition.to, ":u": now };

  if (transition.id === "skip" && reason) {
    updateExpr += ", #sr = :sr";
    exprNames["#sr"] = "skipReason";
    exprValues[":sr"] = reason;
  }

  // Persist the reason as reviewComment when leaving a review gate, so the
  // orchestrator can feed "request changes" feedback back to the reworked agent.
  if (currentStatus === "in_review" && reason) {
    updateExpr += ", #rvc = :rvc";
    exprNames["#rvc"] = "reviewComment";
    exprValues[":rvc"] = reason;
  }

  // DL-024: an agent parks ITS OWN ticket behind the tickets it just filed.
  // ADDITIVE — union with the row's existing blockers (the row is already in
  // hand), matching the Jira Lambda where each blocked_by entry becomes one more
  // "Blocks" link. edit_issue keeps the explicit whole-array "set" semantics.
  const blockers = args.blocked_by;
  let blockedByAdded = [];
  if (blockers) {
    const requested = (Array.isArray(blockers) ? blockers : String(blockers).split(","))
      .map((b) => String(b).trim())
      .filter(Boolean);
    const existing = Array.isArray(current.Item.blockedBy) ? current.Item.blockedBy : [];
    blockedByAdded = requested.filter((b) => !existing.includes(b));
    if (blockedByAdded.length > 0) {
      updateExpr += ", #bb = :bb";
      exprNames["#bb"] = "blockedBy";
      exprValues[":bb"] = [...existing, ...new Set(blockedByAdded)];
    }
  }

  // TEAM-4739: the gate verification rides in the SAME write as the status, and the
  // `gate:awaiting-console` label comes off in it too — so no reader can ever see a
  // closed gate whose verification has not landed yet, and a re-page cannot survive
  // the close it was paging about. Both are absent for a non-gate ticket, which
  // makes this command byte-identical to the pre-TEAM-4739 one.
  const labelPlan = gateVerification ? planGateLabelWrite(current.Item, gateVerification) : null;
  const sendTransition = async (withLabelPlan) => {
    const names = { ...exprNames };
    const values = { ...exprValues };
    const removes = [];
    let expr = updateExpr;
    let condition = null;
    if (gateVerification) {
      expr += ", #gv = :gv";
      names["#gv"] = "gateVerification";
      values[":gv"] = gateVerification;
    }
    if (withLabelPlan && labelPlan) {
      Object.assign(names, labelPlan.names);
      Object.assign(values, labelPlan.values);
      if (labelPlan.set) expr += `, ${labelPlan.set}`;
      if (labelPlan.remove) removes.push(labelPlan.remove);
      condition = labelPlan.condition || null;
    }
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { ticketId: issueKey },
        UpdateExpression: expr + (removes.length ? ` REMOVE ${removes.join(", ")}` : ""),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...(condition ? { ConditionExpression: condition } : {}),
      })
    );
  };

  try {
    await sendTransition(true);
  } catch (err) {
    if (err?.name !== "ConditionalCheckFailedException" || !labelPlan?.condition) throw err;
    // A concurrent writer moved the label list under us. The label bookkeeping is
    // cosmetic; the status and the verification are not — retry without the label
    // clause rather than wedge a verified transition on a label race.
    console.warn(
      `[agentcore-hub-tickets] ${issueKey}: gate label write lost a race, transitioning without it`
    );
    await sendTransition(false);
  }

  return {
    key: issueKey,
    status: "transitioned",
    from: currentStatus,
    to: transition.to,
    transition: transition.name,
    ...(reason ? { skipReason: reason } : {}),
    ...(blockedByAdded.length ? { blockedByAdded } : {}),
    ...(gateVerification ? { gateVerification } : {}),
  };
}

async function getTransitions(args) {
  const issueKey = args.issue_key || args.ticket_id;
  if (!issueKey) return textResult("Error: 'issue_key' is required");

  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { ticketId: issueKey } })
  );
  if (!result.Item) return textResult(`Issue ${issueKey} not found.`);

  const currentStatus = result.Item.status || "todo";
  const available = TRANSITIONS[currentStatus] || [];

  return {
    key: issueKey,
    currentStatus,
    transitions: available.map((t) => ({
      id: t.id,
      name: t.name,
      to: t.to,
    })),
  };
}

async function addComment(args) {
  const issueKey = args.issue_key || args.ticket_id;
  const body = args.body || args.content;
  if (!issueKey) return textResult("Error: 'issue_key' is required");
  if (!body) return textResult("Error: 'body' is required");

  const comment = {
    id: `comment-${Date.now()}`,
    author: args.author || "agent",
    content: body,
    timestamp: new Date().toISOString(),
  };

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { ticketId: issueKey },
      UpdateExpression: "SET #c = list_append(if_not_exists(#c, :empty), :comment), #u = :now",
      ExpressionAttributeNames: { "#c": "comments", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":comment": [comment],
        ":empty": [],
        ":now": new Date().toISOString(),
      },
    })
  );

  return {
    key: issueKey,
    status: "comment_added",
    comment: {
      id: comment.id,
      author: comment.author,
      body: comment.content,
      created: comment.timestamp,
    },
  };
}

async function listProjects() {
  return {
    projects: [
      {
        key: PROJECT_KEY,
        name: "AgentCore Hub Team",
        description: "Agentic development pipeline project",
        issueTypes: ["Epic", "Story", "Task", "Bug"],
      },
    ],
  };
}

async function getProjectIssueTypes(args) {
  return {
    project_key: args.project_key || PROJECT_KEY,
    issueTypes: [
      { id: "epic", name: "Epic", description: "Feature container" },
      { id: "story", name: "Story", description: "User story" },
      { id: "task", name: "Task", description: "Development task" },
      { id: "bug", name: "Bug", description: "Defect" },
    ],
  };
}

async function lookupUser(args) {
  const query = (args.query || "").toLowerCase();

  // Return matching agents from roster
  const agents = [
    { id: "agentcore_hub_requirements_analyst", name: "Requirements Analyst", role: "requirements" },
    { id: "agentcore_hub_ios_designer", name: "iOS Designer", role: "design" },
    { id: "agentcore_hub_backend_designer", name: "Backend Designer", role: "design" },
    { id: "agentcore_hub_android_designer", name: "Android Designer", role: "design" },
    { id: "agentcore_hub_security_reviewer", name: "Security Reviewer", role: "design" },
    { id: "agentcore_hub_legal_compliance", name: "Legal & Compliance", role: "design" },
    { id: "agentcore_hub_localization", name: "Localization", role: "design" },
    { id: "agentcore_hub_analytics_designer", name: "Analytics Designer", role: "design" },
    { id: "agentcore_hub_backend_dev", name: "Backend Developer", role: "development" },
    { id: "agentcore_hub_api_dev", name: "API Developer", role: "development" },
    { id: "agentcore_hub_frontend_dev", name: "Frontend Developer", role: "development" },
    { id: "agentcore_hub_code_reviewer", name: "Code Reviewer", role: "review" },
    { id: "agentcore_hub_qa_verifier", name: "QA Verifier", role: "verification" },
    { id: "agentcore_hub_ci_agent", name: "CI Agent", role: "review" },
    { id: "agentcore_hub_release_manager", name: "Release Manager", role: "ship" },
  ];

  const matches = agents.filter(
    (a) => a.id.includes(query) || a.name.toLowerCase().includes(query) || a.role.includes(query)
  );

  return {
    users: matches.map((a) => ({
      accountId: a.id,
      displayName: a.name,
      emailAddress: `${a.id}@agentcore-hub.example.com`,
      active: true,
    })),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function nextTicketId(projectKey) {
  const prefix = projectKey || PROJECT_KEY;
  const result = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: COUNTER_KEY,
      UpdateExpression: "SET #n = if_not_exists(#n, :zero) + :one",
      ExpressionAttributeNames: { "#n": "nextNum" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    })
  );
  return `${prefix}-${result.Attributes.nextNum}`;
}

function formatSearchResults(items) {
  return {
    total: items.length,
    issues: items.map((t) => ({
      key: t.ticketId,
      self: `https://your-domain.atlassian.net/browse/${t.ticketId}`,
      fields: {
        summary: t.title,
        status: { name: t.status },
        assignee: t.assignee ? { displayName: t.assignee } : null,
        issuetype: { name: t.type },
        priority: { name: t.priority || "Medium" },
        parent: t.parentId ? { key: t.parentId } : null,
        created: t.createdAt,
      },
    })),
  };
}

function detectTool(event) {
  const key = event.issue_key || event.ticket_id;
  if (key && event.body) return "add_comment";
  if (key && (event.transition_id || event.to_status)) return "transition_issue";
  if (key && (event.summary || event.description || event.assignee)) return "edit_issue";
  if (key && !event.parent_id) return "get_issue";
  if (event.jql) return "search_issues";
  if (event.parent_id || (event.assignee && !key && !event.summary)) return "list_tickets";
  if (event.summary) return "create_ticket";
  if (event.query) return "lookup_user";
  if (event.project_key && !event.summary) return "get_project_issue_types";
  return "list_projects";
}

function textResult(text) {
  return { content: [{ text }] };
}
