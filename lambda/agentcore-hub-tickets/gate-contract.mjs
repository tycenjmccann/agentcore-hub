/**
 * gate-contract.mjs — the shared GATE contract for the two ticket Lambdas
 * (TEAM-4739).
 *
 * A "gate ticket" is one whose close asserts something about the world OUTSIDE
 * the pipeline: a human approved a production deploy, CI has no build for a SHA,
 * a blocker is gone. Historically nothing checked the assertion — a persona could
 * transition such a ticket `→ done` from memory, and the cascade would dispatch
 * downstream work over a gate nobody had proven. This module is the read side of
 * that check: the label grammar that binds a gate ticket to its evidence, the
 * probe that fetches the evidence, and the pure verdicts computed from it.
 *
 * ── Scope: the TWINS only ───────────────────────────────────────────────────
 * This is NOT an orchestrator module. It lives in lambda/agentcore-hub-tickets/
 * and lambda/agentcore-hub-jira/ only, it is not on lambda/orchestrator/deploy.sh's
 * zip line, and it is not counted against the DL-009 orchestrator budgets
 * (scripts/check-orchestrator-surface.sh). The orchestrator's half of the gate
 * vocabulary — GATE_KINDS / GATE_LABEL_RE / gateKindsOf — lives in fix-contract.mjs,
 * which all three Lambdas already carry; this module imports it from there rather
 * than re-deriving the grammar, because two spellings of the gate-kind list is
 * exactly the silent drift the parity guards exist to prevent.
 *
 * ── TWO byte-identical copies ───────────────────────────────────────────────
 * Each ticket Lambda ships as a self-contained single-directory zip, so the two
 * cannot share a file; the module is duplicated byte-for-byte and CI compares the
 * copies (scripts/check-fix-kinds-parity.sh §1b, plus the behavioural matrix in
 * src/lib/workflow/gate-contract-parity.test.ts).
 * EDIT THE TICKETS COPY, THEN: cp lambda/agentcore-hub-tickets/gate-contract.mjs \
 *                                lambda/agentcore-hub-jira/gate-contract.mjs
 * Unlike fix-contract.mjs this module is NOT import-free: it does I/O, so it
 * imports @aws-sdk/* (resolved from the nodejs20.x runtime — neither zip carries
 * node_modules) and the gate-kind grammar from ./fix-contract.mjs, which both
 * zips already pack. Nothing else.
 *
 * ── The fail direction (do not "fix" this to be stricter) ───────────────────
 * Everything here answers ONE question: "may this gate ticket close?" Its
 * dangerous failure mode is an UNLIFTABLE STALL — there is no escalation rung
 * above the human, so a gate the system refuses to let anyone close wedges the run
 * forever. So a caller may refuse only on a DEFINITE NEGATIVE: a *successful*
 * probe read whose content contradicts the close. Anything indeterminate — the
 * invoke threw, the timeout fired, the payload did not parse, the tool was not on
 * the allow-list — must ADMIT and be recorded as `gateVerification:"indeterminate"`.
 * That is why invokeProbe NEVER throws and never returns a verdict of its own: it
 * returns `{ok:true, result}` or `{ok:false, indeterminate:true, error}`, and the
 * `ok:false` branch is always an admit.
 *
 * DL-028 is a DIFFERENT question — "may I deploy?" — where the dangerous failure
 * is an unapproved production change and positive evidence is mandatory. That rule
 * is untouched here, and nothing in this module can approve a deploy: PROBE_TOOLS
 * is a read-only allow-list and the pipeline-tools Lambda has no approval call at
 * all.
 *
 * ── Why journey events written here carry a ttl ─────────────────────────────
 * lambda/workflow-output/index.mjs writes journey events with NO ttl, so the rows
 * this module writes are the first expiring ones in agentcore-hub-events (the
 * table's TTL attribute is `ttl`, enabled at create time by
 * scripts/create-dynamodb-tables.sh). The window must outlive every consumer's
 * reporting horizon: cost-report reads a run's events at report time, and the
 * Workflow tab replays a finished run's journey. 90 days is comfortably past both
 * and keeps a gate's paging history auditable for a full quarter.
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  GATE_KINDS,
  gateKindsOf,
  MAX_LABEL,
  labelList,
  HEAD_LABEL_RE,
  EXEC_LABEL_RE,
  gateHeadOf,
  gateExecOf,
} from "./fix-contract.mjs";

// ── Label grammar ───────────────────────────────────────────────────────────
// Labels arrive in two spellings and must read identically: agents write the
// canonical colon form, and the twins' sanitizeUserLabels rewrites
// [^a-z0-9._-] → "-", so the SAME gate can be stored as `head-<sha>` /
// `exec-<uuid>` / `gate-merge-approval`. Same `[:-]` rule as the Telegram
// bridge's parseDeployApprovalLabels and fix-contract.mjs's GATE_LABEL_RE.
//
// The BINDING half of that grammar — HEAD_LABEL_RE / EXEC_LABEL_RE / gateHeadOf /
// gateExecOf, and the labelList normalization they share — now lives in
// fix-contract.mjs (TEAM-4987), the module all THREE Lambdas carry, because the
// orchestrator's W3 re-file watch has to read a binding too and cannot import this
// module. It is RE-EXPORTED here unchanged, so every importer of this module keeps
// working and the two halves still read as one vocabulary.
export { HEAD_LABEL_RE, EXEC_LABEL_RE, gateHeadOf, gateExecOf };
export const MERGE_GATE_LABEL_RE = /^gate[:-]merge-approval$/;

function firstCapture(labels, re) {
  for (const l of labelList(labels)) {
    const m = re.exec(l);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// The third binding: which pipeline the gate belongs to. The Telegram bridge's
// DEPLOY_PIPELINE_LABEL_RE captures `(.+)` — right for a reader that only echoes
// the value back to a human — but this capture is FORWARDED as a probe argument,
// so the charset is narrowed to what an AWS resource name can be. Nothing here
// derives the CI/build project names from it: pipelineProjects() (and its TS
// mirror) is the one place allowed to do that.
//
// The LENGTH is capped at what a label can actually carry (TEAM-4750 B3). A label
// is MAX_LABEL = 64 chars (fix-contract.mjs's sanitizeUserLabels truncates there,
// and normalizeSystemLabel rejects past it), the `pipeline:` prefix costs 9, and
// the first character is matched separately — so the tail is
// MAX_PIPELINE_NAME - 1 = 54. The regex literal cannot interpolate the constant;
// gate-label-readers.test.ts pins the two against each other instead.
export const PIPELINE_LABEL_PREFIX = "pipeline:";
export const MAX_PIPELINE_NAME = MAX_LABEL - PIPELINE_LABEL_PREFIX.length; // 55
export const PIPELINE_LABEL_RE = /^pipeline[:-]([a-z0-9][a-z0-9._-]{0,54})$/i;

/** The pipeline a gate ticket is bound to, from `pipeline:<name>`. */
export function gatePipelineOf(labels) {
  return firstCapture(labels, PIPELINE_LABEL_RE);
}

/**
 * The RAW caller label that cannot survive being stored, or null (TEAM-4750 B3).
 *
 * Capping PIPELINE_LABEL_RE is not enough on its own, and this is the subtle half of
 * the bug: `sanitizeUserLabels` truncates a label to MAX_LABEL, which leaves a
 * pipeline name of exactly MAX_PIPELINE_NAME chars — still a match, but a DIFFERENT
 * name than the caller asked for. validateGateTicketShape would then probe, and the
 * human would later be paged about, a pipeline nobody named. Truncation cannot be
 * detected after the fact, so it has to be refused before it happens.
 *
 * Deliberately runs on the caller's labels BEFORE sanitizeUserLabels, and matches
 * loosely (`/^pipeline[:-]/i`) rather than through PIPELINE_LABEL_RE: the label we
 * must catch is precisely the one that does not match once it is too long.
 *
 * @returns {string|null} the offending label as the caller wrote it
 */
export function pipelineLabelOverflow(labels) {
  const list = Array.isArray(labels) ? labels : typeof labels === "string" ? labels.split(",") : [];
  for (const raw of list) {
    const label = String(raw ?? "").trim();
    if (/^pipeline[:-]/i.test(label) && label.length > MAX_LABEL) return label;
  }
  return null;
}

/**
 * The refusal for the above, built HERE so both twins refuse in the same words —
 * each one only has to deliver it in its own idiom (textResult vs a thrown
 * err.toolResult). Names both limits, because "too long" without the number is not
 * something an agent can act on.
 */
export function pipelineLabelRefusal(label) {
  const name = String(label ?? "").replace(/^pipeline[:-]/i, "");
  return {
    ok: false,
    reason: GATE_CONDITION_UNMET,
    hint:
      `the \`pipeline:\` label is ${String(label ?? "").length} characters, over the ${MAX_LABEL}-character limit for a ` +
      `label — it would be silently TRUNCATED to a different pipeline name than you asked for, and this gate would ` +
      `then be verified against that wrong name. The pipeline name itself may be at most ${MAX_PIPELINE_NAME} ` +
      `characters (got ${name.length}): use the CD registry's \`pipeline\` value for this repo, which is the name the ` +
      `hub can actually reach.`,
  };
}

/**
 * The PURE half of the create-time gate shape check: everything decidable from the
 * labels alone, for every gate kind whose close is later PROVEN by a probe.
 *
 * Worded here for the same reason as pipelineLabelRefusal above — both twins must
 * refuse a malformed gate in identical words, and each one only delivers it in its
 * own idiom (textResult vs a thrown err.toolResult). The probe half stays in the
 * twins, because only `deploy-approval` has one.
 *
 * WHY create-time is the place (TEAM-4758). verifyGateCondition deliberately ADMITS
 * anything it cannot contradict: a ci-unavailable gate with no `pipeline:` label, or
 * a `head:` that is not 40 hex, resolves `indeterminate`/`gate_unbound` and closes
 * unproven. At create time the binding is cheap to demand — the agent has the SHA and
 * the pipeline name in hand — and refusing costs nothing but a retry. By close time
 * the information is gone and the only safe direction is to let the ticket through.
 * So a *definite* shape violation is refused HERE, before an id is minted.
 *
 * Each kind present is evaluated on its own — deliberately not probedGateKindOf,
 * which picks exactly ONE kind and would silently skip a second one on the same
 * ticket. deploy-approval is checked first, preserving its existing order and words.
 *
 * @returns {{hint: string}|null} null when the labels are acceptable
 */
export function gateShapeRefusal(labels) {
  const list = Array.isArray(labels) ? labels : [];
  const kinds = gateKindsOf(list);
  const lower = list.map((l) =>
    String(l ?? "")
      .trim()
      .toLowerCase()
  );
  const execLabels = lower.filter((l) => /^exec[:-]/.test(l));
  const pipeLabels = lower.filter((l) => /^pipeline[:-]/.test(l));
  const headLabels = lower.filter((l) => /^head[:-]/.test(l));

  if (kinds.includes("deploy-approval")) {
    if (execLabels.length !== 1 || !gateExecOf(list)) {
      return {
        hint:
          `a deploy-approval gate must carry exactly one \`exec:<execution-id>\` label (found ${execLabels.length}) — ` +
          `without it nobody can tell which pipeline execution the human is being asked about`,
      };
    }
    if (pipeLabels.length !== 1 || !gatePipelineOf(list)) {
      return {
        hint:
          `a deploy-approval gate must carry exactly one \`pipeline:<name>\` label (found ${pipeLabels.length}) — ` +
          `without it the gate cannot be verified or linked to a console`,
      };
    }
  }
  // A ci-unavailable gate asserts something a read CAN contradict — that CI is
  // genuinely unreachable for this commit — but only if it says which pipeline and
  // which commit. Both bindings, exactly one each. No probe: the claim is about CI
  // being down, so an unreachable probe is not evidence either way.
  if (kinds.includes("ci-unavailable")) {
    if (pipeLabels.length !== 1 || !gatePipelineOf(list)) {
      return {
        hint:
          `a ci-unavailable gate must carry exactly one \`pipeline:<name>\` label (found ${pipeLabels.length}) — ` +
          `without it the close guard has nothing to probe and admits the gate unproven (indeterminate/gate_unbound)`,
      };
    }
    if (headLabels.length !== 1 || !gateHeadOf(list)) {
      return {
        hint:
          `a ci-unavailable gate must carry exactly one \`head:<sha>\` label whose value is exactly 40 hex chars ` +
          `(found ${headLabels.length}) — without it the close guard has nothing to probe and admits the gate ` +
          `unproven (indeterminate/gate_unbound)`,
      };
    }
  }
  return null;
}

// ── The labels the guard itself writes ──────────────────────────────────────
// Written through each provider's ADDITIVE label verb (the DynamoDB twin's
// conditional list_append, Jira's `update:{labels:[{add}]}`), never a whole-list
// SET. The canonical colon spelling is used because these are SYSTEM labels
// (normalizeSystemLabel keeps the colon); the matching readers accept both
// spellings anyway, since an agent may have hand-written the hyphen form.
export const GATE_AWAITING_CONSOLE_LABEL = "gate:awaiting-console";
export const GATE_LOOP_BROKEN_LABEL = "gate:loop-broken";
export const GATE_AWAITING_CONSOLE_RE = /^gate[:-]awaiting-console$/;
export const GATE_LOOP_BROKEN_RE = /^gate[:-]loop-broken$/;

// The verification stamp. A LABEL and not only a field because Jira has nowhere
// to put a structured map — the DynamoDB twin persists `gateVerification`
// {result, reason, evidence, gateKind, probedAt} as well, but the label is the
// part both providers write, in the SAME call as the status change, so a reader
// can never see a closed gate whose verification has not landed yet.
//
// Structurally forgery-safe (contradiction 9 of the plan): the guard only ever
// ADDS a verification and never READS one to admit a close, so an agent that
// hand-labels `gateverify:verified` buys itself nothing — its ticket is probed
// exactly the same way and the stamp is overwritten by the real verdict.
export const GATE_VERIFICATIONS = ["verified", "indeterminate"];
export const GATE_VERIFICATION_LABEL_RE = /^gateverify[:-](verified|indeterminate)$/;

export function gateVerificationLabel(result) {
  return GATE_VERIFICATIONS.includes(result) ? `gateverify:${result}` : "";
}

/**
 * Where a verification stamp already sits in a ticket's label list, split into the
 * one we are about to write and the CONTRADICTORY one(s) (TEAM-4750 B2).
 *
 * Both twins used to ask only "is my stamp already there?" and never looked for the
 * opposite, so done → reopen → done with a different verdict left BOTH
 * `gateverify:verified` and `gateverify:indeterminate` on the ticket and the label
 * record of why the gate closed became unreadable. Each twin removes/overwrites the
 * opposite slot in its own idiom (one conditional UpdateCommand, one transitions
 * POST), but which slots those are is decided HERE so the two cannot disagree.
 *
 * Matches both spellings via GATE_VERIFICATION_LABEL_RE: an agent may have written
 * `gateverify-verified` by hand, and sanitizeUserLabels rewrites the colon anyway.
 *
 * When `result` is not one of GATE_VERIFICATIONS the stamp is "" and both index
 * lists come back EMPTY — a caller with no verdict of its own must not go deleting
 * stamps it cannot classify, which also keeps the pre-B2 behaviour byte-identical.
 *
 * @returns {{stamp: string, same: number[], opposite: number[]}} indices into `labels`
 */
export function gateVerificationSlots(labels, result) {
  const stamp = gateVerificationLabel(result);
  const same = [];
  const opposite = [];
  if (!stamp) return { stamp, same, opposite };
  const want = stamp.slice("gateverify:".length);
  const list = Array.isArray(labels) ? labels : [];
  list.forEach((l, i) => {
    const m = GATE_VERIFICATION_LABEL_RE.exec(String(l ?? "").trim().toLowerCase());
    if (!m) return;
    (m[1] === want ? same : opposite).push(i);
  });
  return { stamp, same, opposite };
}

// ── Which gate kinds are actually PROBED ────────────────────────────────────
// GATE_KINDS (fix-contract.mjs) is the label vocabulary; this is the subset whose
// close asserts something a read can contradict. `approval` is deliberately out:
// a plain human escalation gate is answered by a person, is deliberately RE-FILED
// when a round cap trips, and has no external system to ask — probing it would
// only add a way to stall it. `awaiting-console` and `loop-broken` are the
// guard's own bookkeeping labels, never a ticket's kind.
export const PROBED_GATE_KINDS = ["deploy-approval", "ci-unavailable", "blocker"];

/** The one probed gate kind a ticket carries (PROBED_GATE_KINDS order), or null. */
export function probedGateKindOf(labels) {
  const kinds = gateKindsOf(labels);
  for (const kind of PROBED_GATE_KINDS) if (kinds.includes(kind)) return kind;
  return null;
}

// The two refusal reasons this contract can produce. Agents and the orchestrator
// match on these strings, so they are exported rather than inlined twice.
export const GATE_CONDITION_UNMET = "gate_condition_unmet";
export const GATE_LOOP_ENVIRONMENTAL = "gate_loop_environmental";

// ── DECISION lines ──────────────────────────────────────────────────────────
// The options a human (or an agent acting on a human's instruction) can record on
// a gate ticket to lift an environmental stall. A DECISION is ADVISORY: it can
// admit a close that would otherwise stall, and it can NEVER manufacture
// "verified" — the caller records `indeterminate` with sub-reason
// `decision_advisory`.
export const FIX_DECISIONS = ["repaired", "accept-proxy", "abort"];

// Same grammar as lambda/orchestrator/review-cap.mjs parseDecision (the LAST line
// that is nothing but `DECISION: <option>`, markdown noise tolerated), with two
// deliberate divergences:
//   - review-cap's leading class is `[\s>*-]*`, which tolerates a BLOCKQUOTED
//     decision on purpose (a human replying inline in Jira). Here a quoted line is
//     usually the OPTIONS being repeated back, or text quoted from somewhere else,
//     so `>` is not in the class and a quoted DECISION does not count;
//   - lines inside a fenced ``` / ~~~ block are skipped entirely, for the same
//     reason: a fenced DECISION is documentation of the syntax, not a use of it.
const DECISION_LINE_RE = /^[\s*-]*(?:\*\*)?\s*decision\s*:\s*([a-z][a-z-]*)\s*(?:\*\*)?\s*\.?\s*$/i;
const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * The DECISION recorded in a gate ticket's description, or null.
 * Fail-closed: only an explicit, well-formed, unquoted, unfenced line counts.
 * @returns {"repaired"|"accept-proxy"|"abort"|null}
 */
export function parseFixDecision(text) {
  let fenced = false;
  let found = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (FENCE_RE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = DECISION_LINE_RE.exec(raw);
    if (!m) continue;
    const candidate = m[1].toLowerCase();
    if (FIX_DECISIONS.includes(candidate)) found = candidate; // last one wins
  }
  return found;
}

// ── Journey events ──────────────────────────────────────────────────────────
export const JOURNEY_EVENT_TTL_SEC = 90 * 24 * 60 * 60; // 90 days — see header

/**
 * Append one event to a run's journey. Port of lambda/workflow-output/index.mjs's
 * publishJourneyEvent, plus the `ttl` the header explains.
 *
 * Best-effort exactly like its model: it NEVER throws into the caller, because a
 * gate refusal that is correct must not become a tool error just because the
 * events table was unavailable. Returns whether the row was written, so a caller
 * can log the miss.
 *
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} table  EVENTS_TABLE (absent env ⇒ no-op)
 * @param {string} workflowId  MUST come from the ticket/epic row, never from a
 *   caller-supplied argument (SEC-16): a persona must not choose which run's
 *   journey its event lands in.
 */
export async function publishJourneyEvent(ddb, table, workflowId, type, detail) {
  if (!ddb || !table || !workflowId || !type) return false;
  try {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          workflowId,
          eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type,
          detail,
          timestamp: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + JOURNEY_EVENT_TTL_SEC,
        },
      })
    );
    return true;
  } catch {
    return false; /* non-fatal */
  }
}

// ── The console deep link ───────────────────────────────────────────────────
/**
 * The CodePipeline console URL a refusal points the human at.
 *
 * `stage`/`action` are accepted so a caller can pass the probe's `waitingOn`
 * straight through, but they do not appear in the URL: the console has no
 * per-action deep link. Name them in the comment body instead.
 *
 * @returns {string} the URL, or "" when the ticket is not bound to a pipeline.
 */
export function consoleApprovalUrl({ pipeline, region } = {}, _waitingOn = {}) {
  const name = String(pipeline || "").trim();
  if (!name) return "";
  const r = String(region || process.env.AWS_REGION || "us-east-1").trim();
  return (
    "https://console.aws.amazon.com/codesuite/codepipeline/pipelines/" +
    `${encodeURIComponent(name)}/view?region=${encodeURIComponent(r)}`
  );
}

// ── The probe ───────────────────────────────────────────────────────────────
// A READ-ONLY allow-list, enforced before an InvokeCommand is even constructed
// (SEC-3). The twins forward a tool name that came from a gate ticket's labels;
// without this, the same seam would be a general-purpose "invoke any tool on the
// pipeline Lambda" primitive reachable from ticket data. Deliberately no
// deploy/approve tool: nothing in the ticket path may trigger or approve CD.
export const PROBE_TOOLS = [
  "Pipeline___get_state",
  "Pipeline___get_build_status",
  "Pipeline___capabilities",
];

export const PROBE_TIMEOUT_MS = 4000;

let probeLambda = null;

/**
 * Invoke one read-only pipeline tool and return its parsed result.
 *
 * NEVER THROWS and never retries: the whole body is inside one try/catch, so an
 * SDK throw, the 4s abort, a Lambda FunctionError, a non-JSON payload and a
 * disallowed tool all come back as `{ok:false, indeterminate:true, error}`. That
 * totality is what makes the callers' admit-on-indeterminate rule total (header).
 *
 * The tools Lambda answers with the MCP envelope
 * `{content:[{type:"text", text: JSON.stringify(obj)}]}`, so the payload needs a
 * DOUBLE parse; a shape that does not double-parse is indeterminate, never a
 * verdict.
 *
 * @param {string} fnName  PIPELINE_TOOLS_LAMBDA (absent env ⇒ indeterminate)
 * @param {string} tool  one of PROBE_TOOLS
 * @param {Record<string, unknown>} args  the tool's parameters
 * @returns {Promise<{ok:true, result:any}|{ok:false, indeterminate:true, error:string}>}
 */
export async function invokeProbe(fnName, tool, args) {
  if (!PROBE_TOOLS.includes(tool)) {
    return { ok: false, indeterminate: true, error: "tool_not_allowed" };
  }
  if (!fnName) return { ok: false, indeterminate: true, error: "probe_not_configured" };
  try {
    if (!probeLambda) {
      // maxAttempts: 1 == one attempt, zero retries. A gate close must not sit
      // behind the SDK's default backoff; an unreachable probe is an admit.
      probeLambda = new LambdaClient({
        region: process.env.AWS_REGION || "us-east-1",
        maxAttempts: 1,
      });
    }
    const res = await probeLambda.send(
      new InvokeCommand({
        FunctionName: fnName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify({ tool_name: tool, parameters: args || {} })),
      }),
      { abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }
    );
    if (res.FunctionError) {
      return { ok: false, indeterminate: true, error: `function_error:${res.FunctionError}` };
    }
    const raw = res.Payload ? Buffer.from(res.Payload).toString("utf8") : "";
    const envelope = JSON.parse(raw);
    const text = envelope?.content?.[0]?.text;
    if (typeof text !== "string") {
      return { ok: false, indeterminate: true, error: "probe_payload_shape" };
    }
    return { ok: true, result: JSON.parse(text) };
  } catch (err) {
    const name = err?.name || err?.code || "";
    return { ok: false, indeterminate: true, error: String(name || err?.message || err) };
  }
}

// ── The gate-loop verdict ───────────────────────────────────────────────────
// Priors needed before a re-file is a loop: ONE. FR-2 defines the loop as the
// SECOND gate of a kind against the same BINDING — one prior already proves the
// agent is re-filing the same environmental gate rather than doing new work, and
// the prior is still the ticket to work. The third and later attempts are refused
// SILENTLY: the `gate:loop-broken` epic marker dedupes the event, so the run is
// paged exactly once.
//
// WHICH BINDING, per kind (TEAM-4986 — this used to be one rule for all of them,
// ending in "…or, when neither side carries a binding, the kind alone under one
// epic", and that last clause is what made the guard wrong):
//
//   deploy-approval  the `exec:<id>` label, and NOTHING else. A deploy gate carries
//                    no `head:` and usually no `blocked_by`, so the kind-alone
//                    fallback matched every deploy gate under an epic to every
//                    other one. On run wf_bug_TEAM-4798 that refused the gate for
//                    execution 7bb31573… against a DONE gate for c33ac06f… — an
//                    earlier follow-up PR under the same Bug parent — and labelled
//                    the epic `gate:loop-broken`. Serial CD follow-ups under one
//                    parent are DIFFERENT deploy decisions; the execution is the
//                    only thing that says two of them are the same decision.
//   blocker /        the `head:` SHA when BOTH sides carry one, otherwise an
//   ci-unavailable   overlapping `blocked_by` set. Never merely the same parent
//                    and kind.
//
// And for every kind: a SETTLED sibling is never a prior. The refusal's whole
// remedy is "work the existing ticket", which does not exist on a closed one, so
// counting an answered gate can only wedge the run.
export const GATE_LOOP_THRESHOLD = 1;

/**
 * The statuses that mean a gate has been ANSWERED (TEAM-4986). In the INTERNAL
 * spelling both twins' `scanSiblingTickets` already hand over: the DynamoDB twin
 * copies the row's `status` verbatim, and the jira twin maps Jira's display name
 * through `mapStatusToInternal` ("Done" → `done`; "Closed" / "Cancelled" reach
 * `closed` / `cancelled` through its lowercase fallback).
 *
 * Deliberately a SUPERSET of each twin's private `isSettled` (done|closed), which
 * answers a different question — "does this CD ticket still freeze new work?" —
 * and stays where it is. This one lives in the shared contract because both twins
 * must reach the same verdict about the same sibling.
 */
export const GATE_SETTLED_STATUSES = ["done", "closed", "skipped", "cancelled"];

/** Has this gate been answered? Unreadable/absent status ⇒ treated as still open. */
export function isSettledGateStatus(status) {
  return GATE_SETTLED_STATUSES.includes(
    String(status ?? "")
      .trim()
      .toLowerCase()
  );
}

function idList(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return list.map((x) => String(x ?? "").trim()).filter(Boolean);
}

/**
 * Is this new gate ticket the second of its kind against the same binding?
 *
 * PURE, and the reason the verdict lives here rather than in either twin: the two
 * providers cannot gather siblings the same way (the DynamoDB twin queries
 * parentId-index; the jira twin must ask for `issuelinks` explicitly, since
 * listTickets does not request that field and so returns no `blockedBy` at all),
 * but they MUST refuse identically. Each twin gathers in its own idiom and hands
 * the rows here.
 *
 * See the GATE_LOOP_THRESHOLD comment above for which binding each kind is keyed
 * on, and why the old parent + kind fallback had to go (TEAM-4986).
 *
 * @param {Array<{id?:string, key?:string, ticketId?:string, status?:string,
 *                labels?:string[]|string, blockedBy?:string[]|string}>} siblings
 *   the epic's other children. `status` is the INTERNAL form (see
 *   GATE_SETTLED_STATUSES); a settled sibling is skipped for every kind.
 * @param {{gateKind?:string, blockedBy?:string[]|string, head?:string,
 *          execId?:string}} opts  the NEW ticket's gate kind and BINDINGS, read
 *   from its own labels by the caller (gateHeadOf / gateExecOf). An absent binding
 *   matches NOTHING rather than everything — for a deploy-approval gate the loop
 *   seam runs before gateShapeRefusal, which is what refuses an unbound one a
 *   moment later.
 * @returns {{loop:boolean, priorCount:number, priors:string[], reason:string|null}}
 */
export function gateLoopVerdict(siblings, opts = {}) {
  const gateKind = String(opts.gateKind || "")
    .trim()
    .toLowerCase();
  const blockedBy = idList(opts.blockedBy);
  const head = String(opts.head || "")
    .trim()
    .toLowerCase();
  const execId = String(opts.execId || "")
    .trim()
    .toLowerCase();
  const out = { loop: false, priorCount: 0, priors: [], reason: null };
  if (!GATE_KINDS.includes(gateKind)) return out;

  for (const s of Array.isArray(siblings) ? siblings : []) {
    if (!s) continue;
    if (!gateKindsOf(s.labels).includes(gateKind)) continue;
    // An ANSWERED gate is not a gate still being asked, whatever it is bound to.
    if (isSettledGateStatus(s.status)) continue;

    if (gateKind === "deploy-approval") {
      // The pipeline execution, and only it: not the head, not the blocked_by
      // target, and never the kind alone.
      if (!execId || gateExecOf(s.labels) !== execId) continue;
    } else {
      const sibHead = gateHeadOf(s.labels);
      if (head && sibHead) {
        // Both sides name a commit, so the commit decides.
        if (sibHead !== head) continue;
      } else if (!blockedBy.length || !idList(s.blockedBy).some((b) => blockedBy.includes(b))) {
        continue;
      }
    }
    out.priors.push(String(s.id || s.key || s.ticketId || ""));
  }

  out.priorCount = out.priors.length;
  out.loop = out.priorCount >= GATE_LOOP_THRESHOLD;
  out.reason = out.loop ? GATE_LOOP_ENVIRONMENTAL : null;
  return out;
}

// ── The gate-condition verdict ──────────────────────────────────────────────
// One function, both twins, so "may this gate close?" cannot be answered two ways
// by two installs. It does the probe and returns a verdict; it writes nothing, and
// it does not know what a ticket is.

/** "Deploy / ApproveDeploy" for a hint, from a probe row. Never empty. */
function stageAction(row) {
  const parts = [row?.stage, row?.action].map((p) => String(p || "").trim()).filter(Boolean);
  return parts.join(" / ") || "the approval action";
}

/**
 * Verify the condition a gate ticket asserts, by reading the system that owns it.
 *
 * @param {string} fnName  PIPELINE_TOOLS_LAMBDA. Unset ⇒ every probe is
 *   indeterminate, i.e. every gate close is ADMITTED and stamped. That is the
 *   deliberate default for an install that has not deployed the pipeline module:
 *   the guard is inert rather than a wall.
 * @param {{gateKind:string, pipeline?:string, execId?:string, head?:string,
 *          decision?:string|null, region?:string}} opts  the gate's BINDINGS, read
 *   from its labels by the caller (gatePipelineOf / gateExecOf / gateHeadOf) and
 *   its DECISION, read from its description by parseFixDecision.
 * @returns {Promise<{refuse:boolean,
 *   verification:{result:string, reason:string, evidence:any, gateKind:string, probedAt:string}|null,
 *   hint:string, stage:string, action:string, consoleUrl:string}>}
 *   `refuse:true` ⇒ a definite negative; `verification` is then null (nothing is
 *   stamped on a refusal, because nothing was proven). Otherwise the close is
 *   ADMITTED and `verification` is what the caller writes in the same update.
 */
export async function verifyGateCondition(fnName, opts = {}) {
  const gateKind = String(opts.gateKind || "")
    .trim()
    .toLowerCase();
  const pipeline = String(opts.pipeline || "").trim();
  const execId = String(opts.execId || "").trim();
  const head = String(opts.head || "").trim();
  const decision = opts.decision || null;
  const region = opts.region || process.env.AWS_REGION || "us-east-1";
  const consoleUrl = consoleApprovalUrl({ pipeline, region });
  const probedAt = new Date().toISOString();

  const admit = (result, reason, evidence = null) => ({
    refuse: false,
    verification: { result, reason, evidence, gateKind, probedAt },
    hint: "",
    stage: "",
    action: "",
    consoleUrl,
  });
  const refuse = (hint, row = {}) => ({
    refuse: true,
    verification: null,
    hint,
    stage: String(row.stage || ""),
    action: String(row.action || ""),
    consoleUrl,
  });

  // `blocker`: nothing to ask. Whether the tickets a blocker gate names are done
  // is the CASCADE's business (it is what dispatches on blockedBy), not this
  // guard's, and there is no external system that knows "the blocker is gone".
  // Recorded as indeterminate so the close is still auditable.
  if (gateKind === "blocker") return admit("indeterminate", "no_probe_available");

  if (gateKind === "deploy-approval") {
    // SEC-7: an unbound gate is not a provably-open gate. Refusing here would make
    // a mislabelled ticket uncloseable by anyone.
    if (!pipeline || !execId) return admit("indeterminate", "gate_unbound");

    const probe = await invokeProbe(fnName, "Pipeline___get_state", {
      pipeline_name: pipeline,
      execution_id: execId,
    });
    if (!probe.ok) return admit("indeterminate", "probe_failed", probe.error);
    const state = probe.result || {};
    // A SUCCESSFUL invoke of a tool that then declined to answer (the pipeline is
    // not in the CD registry, the module is not configured) is not a read of the
    // world — it is a read of our own configuration.
    if (state.ok === false || state.configured === false) {
      return admit("indeterminate", "probe_unanswerable", state.reason || "unanswerable");
    }

    // (1) The most definite negative there is: the approval action is recorded as
    // Failed. Two things produce that row and CodePipeline does not distinguish
    // them — a human rejected the approval, or the ManualApproval timed out after
    // its 7 days (TEAM-4750 B4) — so the hint must not accuse a reviewer of a
    // decision they may never have made. Either way THIS run's approval did not
    // pass, which is what makes it a refusal at all. actionDetails is
    // execution-scoped (ListActionExecutions filtered by pipelineExecutionId), so a
    // Failed approval row here belongs to this run and not to a neighbouring one.
    const rejected = (Array.isArray(state.actionDetails) ? state.actionDetails : []).find(
      (a) => a && /approv/i.test(String(a.action || "")) && String(a.status) === "Failed"
    );
    if (rejected) {
      return refuse(
        `the deploy approval at ${stageAction(rejected)} is recorded as Failed — it was REJECTED by a human, or CodePipeline TIMED OUT the approval after 7 days. Either way this run's approval did not pass, and closing this ticket as done would record one that never happened. Transition it \`block\` instead: file the work the reviewer asked for if there was a rejection, or re-run the deploy to page for the approval again if it timed out.`,
        rejected
      );
    }

    const waitingOn = state.waitingOn || null;

    // (2) Our execution lost the pipeline to a newer one, so nobody will ever be
    // asked to approve it: the gate is genuinely closed, just not by approval.
    // Checked BEFORE holdsGate because supersededBy is only ever populated when it
    // is OUR execution that was superseded, which makes it the more specific read.
    if (waitingOn && waitingOn.supersededBy) {
      return admit("verified", "execution_superseded", waitingOn.supersededBy);
    }

    // (3) No pending human approval anywhere on the pipeline.
    if (!waitingOn) return admit("verified", "no_open_approval");

    // (4) The gate is open on THIS execution: the human has not answered yet.
    if (waitingOn.holdsGate === "this") {
      return refuse(
        `the deploy approval for execution ${execId} is still OPEN at ${stageAction(waitingOn)} and has not been answered — a human approves it through the bridge. Wait for the approval, then retry this transition; do not file another gate ticket.`,
        waitingOn
      );
    }

    // (5) An earlier execution is parked on the gate, so ours has not reached it.
    if (waitingOn.holdsGate === "older") {
      const blocker = String(waitingOn.queuedBehind || "").trim();
      return refuse(
        `execution ${execId} has not reached ${stageAction(waitingOn)} yet — the approval is currently held by ${blocker ? `execution ${blocker}` : "an earlier, unnamed execution"}. Wait for that one to be answered, then retry this transition.`,
        waitingOn
      );
    }

    // (6) Terminal, and the probe confirmed the stages are on OUR execution.
    // matchesExecution:false means terminal describes some other run, which proves
    // nothing about this gate — that falls through to indeterminate below.
    if (state.terminal === true && state.matchesExecution !== false) {
      return admit("verified", "execution_terminal");
    }

    // holdsGate:"unknown" — a pending approval exists but the probe could not
    // attribute it to an execution. Not a negative; not a proof either.
    return admit("indeterminate", "gate_holder_unknown", waitingOn.holdsGate || "unknown");
  }

  if (gateKind === "ci-unavailable") {
    if (!pipeline || !head) return admit("indeterminate", "gate_unbound");

    const probe = await invokeProbe(fnName, "Pipeline___get_build_status", {
      pipeline_name: pipeline,
      commit_sha: head,
    });
    if (!probe.ok) return admit("indeterminate", "probe_failed", probe.error);
    const status = probe.result || {};
    if (status.ok === false || status.configured === false) {
      return admit("indeterminate", "probe_unanswerable", status.reason || "unanswerable");
    }

    // The claim is "CI is UNAVAILABLE for this SHA". A build that exists disproves
    // it whatever its verdict says — IN_PROGRESS, FAILED and SUCCEEDED are all CI
    // being available. Whether the build PASSED is the CI ticket's question, not
    // this gate's.
    if (status.match) {
      return admit("verified", "build_exists", {
        buildId: status.match.buildId,
        buildStatus: status.match.buildStatus,
      });
    }

    // A DECISION is ADVISORY (SEC-2a): a human may lift an environmental stall,
    // but no human statement can turn "no build exists" into `verified`.
    if (decision) return admit("indeterminate", "decision_advisory", decision);

    return refuse(
      `CI has a build history for ${status.project || pipeline} but NONE for commit ${head}, so "CI is unavailable" is not what happened — the build was never started. Remedies, in order: (1) \`Pipeline___start_ci_build(commit_sha="${head}")\` and wait for it; (2) if the SHA is stale, re-read the branch head and correct this ticket's \`head:\` label; (3) if CI genuinely cannot run, record a \`DECISION: accept-proxy\` (or \`abort\`) line in this ticket's description and retry. Filing another CI ticket is NOT a remedy and will be refused.`
    );
  }

  // `approval`, `merge-approval`, an unknown kind: nothing is probed. `approval`
  // deliberately never reaches here (PROBED_GATE_KINDS), so this is the
  // belt-and-braces arm for a kind added to GATE_KINDS without a probe.
  return admit("indeterminate", "no_probe_available");
}

// ── Refusal payloads (the byte-identical strings) ───────────────────────────
/**
 * The refusal a gate guard returns, its tool message, and the ONE comment it
 * leaves on the ticket. Built here so the two twins cannot phrase a refusal
 * differently — an agent that reads a different remedy on Jira than on DynamoDB
 * takes a different next action, which is the split-brain the parity tests exist
 * to catch.
 *
 * @returns {{payload:{ok:false, reason:string, hint:string, consoleUrl:string,
 *   stage:string, action:string}, message:string, comment:string}}
 */
export function gateRefusal({ ticketId, gateKind, verdict } = {}) {
  const v = verdict || {};
  const id = String(ticketId || "").trim();
  const kind = String(gateKind || "")
    .trim()
    .toLowerCase();
  const hint = String(v.hint || "");
  const consoleUrl = String(v.consoleUrl || "");
  const stage = String(v.stage || "");
  const action = String(v.action || "");

  const where = [stage, action].filter(Boolean).join(" / ");
  const message =
    `Refusing to close ${id}: its \`gate:${kind}\` condition is not met. ${hint}` +
    (consoleUrl ? ` Console: ${consoleUrl}` : "");
  const comment =
    `**Gate not verified — this ticket stays open.**\n\n` +
    `A \`gate:${kind}\` ticket may only close once the condition it represents is verified, ` +
    `and the check found evidence to the contrary.\n\n` +
    `${hint}\n\n` +
    (where ? `Waiting at: ${where}\n` : "") +
    (consoleUrl ? `Console: ${consoleUrl}\n` : "") +
    `\nThis ticket now carries \`${GATE_AWAITING_CONSOLE_LABEL}\`. Retry the transition once the ` +
    `condition holds — do not file a replacement gate ticket.`;

  return {
    payload: { ok: false, reason: GATE_CONDITION_UNMET, hint, consoleUrl, stage, action },
    message,
    comment,
  };
}

/**
 * The refusal `refuseGateLoop` returns. `existingTicketId` is the FIRST prior of
 * the same kind against the same target — the ticket the caller should work on
 * instead of filing another.
 *
 * Phrased singular-safe: at the threshold there is exactly ONE prior (FR-2 — the
 * second gate is the loop), so "1 already exists" has to read correctly.
 */
export function gateLoopRefusal({ gateKind, verdict, epicId } = {}) {
  const v = verdict || {};
  const kind = String(gateKind || "")
    .trim()
    .toLowerCase();
  const priors = Array.isArray(v.priors) ? v.priors.filter(Boolean) : [];
  const existingTicketId = priors[0] || "";
  const exist = priors.length === 1 ? "already exists" : "already exist";
  const message =
    `Refusing to create another \`gate:${kind}\` ticket: ${priors.length} ${exist} for the same target ` +
    `(${priors.join(", ")}). This is an environmental loop, not new work. Work the existing ticket ` +
    `${existingTicketId} — verify the condition, or record a DECISION line in its description — and ` +
    `escalate on it rather than filing another.` +
    (epicId ? ` The epic ${epicId} is now labelled \`${GATE_LOOP_BROKEN_LABEL}\`.` : "");
  return {
    payload: { ok: false, reason: GATE_LOOP_ENVIRONMENTAL, existingTicketId },
    message,
  };
}

/**
 * Does a gate ticket's description carry the console deep link a human needs?
 *
 * Matches on the PATH (`pipelines/<name>/view`) rather than the whole URL, so a
 * link written with a different region query, extra params, or markdown wrapping
 * still counts. The point is that a human reading the ticket can reach the gate —
 * not that the string was produced by consoleApprovalUrl.
 */
export function descriptionCarriesConsoleLink(description, { pipeline, region } = {}) {
  const url = consoleApprovalUrl({ pipeline, region });
  if (!url) return false;
  const text = String(description || "");
  if (!text) return false;
  const path = `pipelines/${encodeURIComponent(String(pipeline).trim())}/view`;
  return text.includes(url) || text.includes(path);
}

// ── The DL-030 completion record (TEAM-4757 R3-2) ────────────────────────────
//
// THIS SECTION IS IN THE OPPOSITE FAIL BAND FROM THE REST OF THE FILE. Everything
// above answers "may this GATE ticket close?" and admits on indeterminate, because
// an unliftable stall is its dangerous failure. This answers DL-030's question —
// "has the agent's completion record proven this ship-phase ticket's work is
// actually finished?" — whose dangerous failure is the opposite: a ship ticket
// closing over work that was never filed, cascading into an epic that completes
// over nothing. So it FAILS CLOSED, the same positive-evidence rule as DL-028's
// deploy gate. Do not "harmonise" it with the admit-on-indeterminate argument in
// the header; the two bands are deliberate and the header says so.
//
// WHY THE BODY AND NOT JUST EXISTENCE. lambda/workflow-output/index.mjs
// (reportCompletion, TEAM-4756) writes completions/<ticket_id>.json AFTER
// materializing follow-up tickets and BEFORE the Done transition, and stamps the
// outcome into the body: `followUpsPending` plus a `status` of "complete",
// "complete_pending_follow_ups" or "complete_transition_failed". A record in the
// pending state exists exactly like a finished one, so an existence-only guard
// admitted it — the R3-2 defect. The writer's invariant, stated at index.mjs:865,
// is: a record that exists with `followUpsPending !== true` means every retryable
// follow-up is materialized.
//
// `!== true` AND NEVER `=== false` — both the writer and this reader depend on it:
//   · a pre-TEAM-4756 record carries NEITHER field (the invariant held for it too:
//     it was written before follow-ups existed at all);
//   · sweepSkipRecord (index.mjs:1714) deliberately omits both — a skip marker is
//     not a completion report and can carry no pending follow-ups;
//   · the `complete_transition_failed` restamp (index.mjs:920) deliberately leaves
//     `followUpsPending` false, because the follow-ups ARE filed and only the Done
//     write failed; closing that ticket directly is a legitimate recovery this
//     reader must not refuse.

/**
 * Anything that is not a readable JSON object. Fails CLOSED: an unreadable record
 * cannot tell us whether its follow-ups are pending, and "we could not tell" is not
 * "they are filed" (the same three-outcome discipline as workflow-output's
 * readCdLedger — read / provably absent / could-not-tell).
 */
function completionRecordUnreadable(key, detail) {
  return {
    proven: false,
    why:
      `${key} could not be read as a completion record (${detail}) — so whether its ` +
      `follow-ups are still pending is UNKNOWN. Re-run WorkflowOutput___report_completion ` +
      `with the same arguments to rewrite it`,
  };
}

/**
 * Judge a completion record's BODY — the pure half of both twins'
 * `completionRecordProven`. Every refusal STRING lives here so the two providers
 * cannot phrase this differently; each twin keeps its own GetObject and its own
 * missing/indeterminate error mapping, because the S3 client is per-twin.
 *
 * @param {string} key      completions/<ticketId>.json — quoted verbatim in `why`
 * @param {string} bodyText the object body, already streamed to a string
 * @returns {{proven: boolean, why: string}} `why` is log/message text only — never a
 *   credential, never a raw AWS error body, and never the record's own contents.
 */
export function judgeCompletionRecord(key, bodyText) {
  const k = String(key || "");
  const text = typeof bodyText === "string" ? bodyText : "";
  if (!text.trim()) {
    return completionRecordUnreadable(
      k,
      bodyText === undefined || bodyText === null ? "no body" : "an empty body"
    );
  }

  let record;
  try {
    record = JSON.parse(text);
  } catch (err) {
    return completionRecordUnreadable(k, `unparseable JSON (${err?.message || "no message"})`);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    const shape = record === null ? "null" : Array.isArray(record) ? "an array" : typeof record;
    return completionRecordUnreadable(k, `parsed to ${shape}, not an object`);
  }

  if (record.followUpsPending === true) {
    const status =
      typeof record.status === "string" && record.status.trim() ? record.status.trim() : "unstated";
    return {
      proven: false,
      why:
        `${k} has followUpsPending:true (status ${status}) — re-run ` +
        `WorkflowOutput___report_completion with the same arguments to materialize the follow-ups`,
    };
  }

  return { proven: true, why: `${k} exists` };
}
