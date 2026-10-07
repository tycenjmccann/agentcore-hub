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
 * ── THREE byte-identical copies ─────────────────────────────────────────────
 * Each ticket Lambda ships as a self-contained single-directory zip, so the two
 * cannot share a file; the module is duplicated byte-for-byte and CI compares the
 * copies (scripts/check-fix-kinds-parity.sh §1b, plus the behavioural matrix in
 * src/lib/workflow/gate-contract-parity.test.ts). TEAM-5340 added a third, in
 * lambda/workflow-output/, which only READS the gate-decision record below.
 * EDIT THE TICKETS COPY, THEN: cp lambda/agentcore-hub-tickets/gate-contract.mjs \
 *                                lambda/agentcore-hub-jira/gate-contract.mjs
 *                             cp lambda/agentcore-hub-tickets/gate-contract.mjs \
 *                                lambda/workflow-output/gate-contract.mjs
 * Unlike fix-contract.mjs this module is NOT import-free: it does I/O, so it
 * imports @aws-sdk/* (resolved from the nodejs20.x runtime — neither zip carries
 * node_modules), the gate-kind grammar from ./fix-contract.mjs and the human-gate
 * decision grammar + tokens from ./decision-contract.mjs (TEAM-5322), both of which
 * every zip packs. Nothing else.
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

import { createHash } from "node:crypto";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  DECISION_REQUIRED,
  DEFAULT_GATE_DECISION_SECRET_ID,
  RESERVED_STATE_LABEL_RE,
  parseDecisionOptions,
  parseDecisionAnswer,
  decisionRefusal,
  verifyDecisionToken,
  signVerifyRecord,
  verifyRecordSig,
  canonicalJson,
  redactForLog,
  UNIVERSAL_DECISION_OPTIONS,
  admittedOptions,
  FINDING_ID_RE,
  GATE_SCOPE_MAX_FINDINGS,
  parseGateScope,
  scopeHash,
} from "./decision-contract.mjs";
import {
  GATE_KINDS,
  gateKindsOf,
  MAX_LABEL,
  labelList,
  HEAD_LABEL_RE,
  EXEC_LABEL_RE,
  gateHeadOf,
  gateExecOf,
  sameGateBinding,
  isHumanGate,
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
//
// TEAM-5322 adds `unverified`: a human approved, but the gate's post-condition probe
// never confirmed the outcome inside VERIFY_WINDOW_MS (see the post-condition
// section below). Unlike the other two it is stamped on a gate that STAYS in_review.
export const GATE_VERIFICATIONS = ["verified", "indeterminate", "unverified"];
export const GATE_VERIFICATION_LABEL_RE = /^gateverify[:-](verified|indeterminate|unverified)$/;

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
// TEAM-5322: verify_postcondition is read-only by construction on the tools side
// (Describe/Get calls only, a fixed projection of what it read, never a write).
export const PROBE_TOOLS = [
  "Pipeline___get_state",
  "Pipeline___get_build_status",
  "Pipeline___capabilities",
  "Pipeline___verify_postcondition",
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
// epic", and that last clause is what made the guard wrong): sameGateBinding
// (fix-contract.mjs) is the ONE spelling of that rule, shared with the
// orchestrator's W3 re-file watch (TEAM-4989) so a create-time refusal and a
// re-file page can never disagree about what "the same gate" means. In short —
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

/**
 * The NEW ticket as a ROW `sameGateBinding` can read, so the create-time refusal and
 * the orchestrator's W3 re-file watch run the SAME predicate over the SAME shape.
 *
 * Back-compat is why this is not simply `{labels, blockedBy}`: the direct callers in
 * the parity tests (and every pre-TEAM-4989 caller) hand over `head` / `execId` as
 * BARE strings, already extracted with gateHeadOf / gateExecOf. Those are re-spelled
 * as the labels they came from and appended AFTER the ticket's own, so a real
 * `labels` still wins on the first-match rule those readers use.
 *
 * A value that is not a readable binding (not 40-hex, not a 36-char execution id)
 * synthesizes a label the readers do not match, and so reads as UNBOUND. That is the
 * honest answer — an unreadable binding names no target — and it is unreachable from
 * production: both twins pass exactly what gateHeadOf / gateExecOf just returned.
 */
function selfGateRow(opts) {
  const labels = labelList(opts.labels);
  const head = String(opts.head ?? "").trim();
  const execId = String(opts.execId ?? "").trim();
  if (head) labels.push(`head:${head}`);
  if (execId) labels.push(`exec:${execId}`);
  return { labels, blockedBy: opts.blockedBy };
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
 * The binding decision itself is NOT spelled here — sameGateBinding (fix-contract.mjs)
 * is the one spelling of that rule (TEAM-4989), shared with the orchestrator's W3
 * re-file watch. See the GATE_LOOP_THRESHOLD comment above for which binding each
 * kind is keyed on, and why the old parent + kind fallback had to go (TEAM-4986).
 *
 * @param {Array<{id?:string, key?:string, ticketId?:string, status?:string,
 *                labels?:string[]|string, blockedBy?:string[]|string}>} siblings
 *   the epic's other children. `status` is the INTERNAL form (see
 *   GATE_SETTLED_STATUSES); a settled sibling is skipped for every kind.
 * @param {{gateKind?:string, blockedBy?:string[]|string, labels?:string[]|string,
 *          head?:string, execId?:string}} opts  the NEW ticket's gate kind and
 *   BINDINGS. `labels` is the ticket's own labels; `head` / `execId` are a
 *   back-compat spelling for a caller that already ran gateHeadOf / gateExecOf
 *   itself. An absent binding matches NOTHING rather than everything — for a
 *   deploy-approval gate the loop seam runs before gateShapeRefusal, which is what
 *   refuses an unbound one a moment later.
 * @returns {{loop:boolean, priorCount:number, priors:string[], reason:string|null}}
 */
export function gateLoopVerdict(siblings, opts = {}) {
  const gateKind = String(opts.gateKind || "")
    .trim()
    .toLowerCase();
  const out = { loop: false, priorCount: 0, priors: [], reason: null };
  if (!GATE_KINDS.includes(gateKind)) return out;

  const self = selfGateRow(opts);

  for (const s of Array.isArray(siblings) ? siblings : []) {
    if (!s) continue;
    if (!gateKindsOf(s.labels).includes(gateKind)) continue;
    // An ANSWERED gate is not a gate still being asked, whatever it is bound to.
    if (isSettledGateStatus(s.status)) continue;
    // The ONLY binding decision, and it is not spelled here: one predicate, shared
    // with the orchestrator's W3 re-file watch (TEAM-4989), so a create-time refusal
    // and a re-file page can never disagree about what "the same gate" means.
    if (!sameGateBinding(gateKind, self, s)) continue;
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
// outcome into the body: `followUpsPending` plus a `status` from COMPLETION_STATUS
// below. A record in a pending state exists exactly like a finished one, so an
// existence-only guard admitted it — the R3-2 defect. The writer's invariant is: a
// record that exists with `followUpsPending !== true` means every retryable
// follow-up is materialized, AND (TEAM-5348 F3) a record whose `status` is one of
// COMPLETION_RECORD_FINAL_STATUSES has nothing else owed — no undelivered
// review.cap_resolved event, no sibling the empty sweep still has to skip.
//
// TEAM-5348 F3 — THE STATUS IS AN ALLOW-LIST, NOT A DENY-LIST. Before this the
// reader refused only `followUpsPending === true`, and the two statuses TEAM-5340
// added (`complete_pending_event`, `complete_pending_sweep`) leave that flag false,
// so a direct Tickets___transition_ticket(done) closed a ship ticket whose Done the
// writer had deliberately withheld. Now any `status` string that is not final
// refuses — including one this file has never heard of, so a status added on the
// writer side reads as OPEN here until this table learns it (the same direction
// the runtime's _CompletionGate._reports_done takes with `not in`).
//
// `followUpsPending !== true` AND NEVER `=== false`, and an ABSENT status is still
// admitted — both the writer and this reader depend on it:
//   · a pre-TEAM-4756 record carries NEITHER field (the invariant held for it too:
//     it was written before follow-ups existed at all);
//   · sweepSkipRecord (workflow-output) and the orchestrator's skip record /
//     retraction marker deliberately omit both — a skip marker is not a completion
//     report and can carry no pending follow-ups; every writer of a status-less
//     record is a hub role, never an agent (completions/ is agent-unwritable);
//   · the `complete_transition_failed` restamp deliberately leaves
//     `followUpsPending` false, because the follow-ups ARE filed and only the Done
//     write failed; closing that ticket directly is a legitimate recovery this
//     reader must not refuse — so it is in the FINAL list.

/**
 * TEAM-5348 F3: the ONE table of statuses WorkflowOutput___report_completion stamps
 * into completions/<t>.json and answers in its response. Three readers derive from
 * it and must never spell a status themselves:
 *   · workflow-output (the writer) imports it;
 *   · judgeCompletionRecord below admits only COMPLETION_RECORD_FINAL_STATUSES;
 *   · the runtime's _CompletionGate._reports_done (deploy/runtime-agent/main.py)
 *     treats only COMPLETION_DONE_STATUSES as done — a Python mirror pinned to this
 *     table by src/lib/workflow/tool-signature-parity.test.ts.
 * DONE is the bare string "complete" and must stay exactly that (the Python side
 * cannot import this file).
 */
export const COMPLETION_STATUS = Object.freeze({
  /** The ticket reached Done. Final on the record; done in the response. */
  DONE: "complete",
  /** TEAM-4756: follow-ups filed, the Done write failed. Final on the record (a direct Done is the recovery); OPEN in the response. */
  TRANSITION_FAILED: "complete_transition_failed",
  /** N2: a retryable follow-up is not materialized yet. */
  PENDING_FOLLOW_UPS: "complete_pending_follow_ups",
  /** TEAM-5340 F6: the empty sweep could not skip every sibling it admitted. */
  PENDING_SWEEP: "complete_pending_sweep",
  /** TEAM-5340 F4: the review.cap_resolved event this report owes is not provably written. */
  PENDING_EVENT: "complete_pending_event",
});
/** What the runtime reads as "the ticket is Done" in the tool RESPONSE. */
export const COMPLETION_DONE_STATUSES = Object.freeze([COMPLETION_STATUS.DONE]);
/** What the twins' Done guard admits on the RECORD: nothing is still owed. */
export const COMPLETION_RECORD_FINAL_STATUSES = Object.freeze([COMPLETION_STATUS.DONE, COMPLETION_STATUS.TRANSITION_FAILED]);

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

  // TEAM-5348 F3: a stated status must be a FINAL one. `complete_pending_event` and
  // `complete_pending_sweep` leave followUpsPending false, so the test above alone
  // admitted a record whose Done the writer withheld; an unknown status is open too.
  if (typeof record.status === "string") {
    const status = record.status.trim();
    if (!COMPLETION_RECORD_FINAL_STATUSES.includes(status)) {
      return {
        proven: false,
        why:
          `${k} is still ${status || "(blank status)"} — Done is withheld until ` +
          `WorkflowOutput___report_completion is re-run with the same arguments and answers ${COMPLETION_STATUS.DONE}`,
      };
    }
  }

  return { proven: true, why: `${k} exists` };
}

// ═══ TEAM-5322 — the human-gate decision contract and post-conditions ═══════
//
// THE FAIL DIRECTION IS DELIBERATELY THE OPPOSITE OF THE PROBED-GATE GUARD ABOVE.
// That guard answers "does the world contradict this close?" and admits anything
// indeterminate, because a gate nobody can close is an unliftable stall. This one
// answers "did a HUMAN choose this?" (FR-9, TEAM-5318 F1) and "did the approved
// thing actually happen?" (FR-10), and there an unknown is not a yes:
//   - no valid decision token ⇒ refuse `decision_required`. The stall is liftable:
//     the refusal carries the options, and the hub console / Telegram picker mints
//     the token in one click.
//   - an unmet or unreadable post-condition ⇒ HOLD the gate in_review with
//     `gate:verifying` for VERIFY_WINDOW_MS, then mark it `gate:approved-unverified`
//     and re-page. A later human close with a fresh token admits as `unverified` —
//     the human always has the last word, the system just never calls it `verified`.
// Only DECISION-BOUND gates (a `human:*` assignee whose description declares
// `DECISION OPTIONS:`) and tickets carrying a `postCondition` pay any of this.

export {
  DECISION_REQUIRED,
  DEFAULT_GATE_DECISION_SECRET_ID,
  RESERVED_STATE_LABEL_RE,
  parseDecisionOptions,
  parseDecisionAnswer,
  decisionRefusal,
  verifyDecisionToken,
  canonicalJson,
  redactForLog,
  UNIVERSAL_DECISION_OPTIONS,
  admittedOptions,
  FINDING_ID_RE,
  GATE_SCOPE_MAX_FINDINGS,
  parseGateScope,
  scopeHash,
};

export const GATE_VERIFYING_LABEL = "gate:verifying";
export const GATE_APPROVED_UNVERIFIED_LABEL = "gate:approved-unverified";
export const GATE_VERIFYING_RE = /^gate[:-]verifying$/;
export const GATE_APPROVED_UNVERIFIED_RE = /^gate[:-]approved-unverified$/;
export const VERIFY_WINDOW_MS = 10 * 60 * 1000;
export const LABEL_RESERVED = "label_reserved";
export const HEAD_LABEL_CONFLICT = "head_label_conflict";
export const POST_CONDITION_INVALID = "post_condition_invalid";
export const POST_CONDITION_IMMUTABLE = "post_condition_immutable";
export const DECISION_CHANNEL_UNAVAILABLE = "decision_channel_unavailable";
// TEAM-5338 F3: a token whose single-use id the twin has already acted on.
export const DECISION_TOKEN_CONSUMED = "decision_token_consumed";
// TEAM-5347 F3: the gate moved (a human reopened or re-closed it) between a twin's
// last read and its write; the write was undone or compensated and the close refused.
export const GATE_MOVED = "gate_moved";
// TEAM-5347 F7: the DynamoDB twin's row moved (status or decision cycle) between its
// read and its conditional write; nothing was written and the close is refused.
export const TICKET_MOVED = "ticket_moved";
// TEAM-5338 F2: a decision-bound gate's human assignee cannot be edited away.
export const ASSIGNEE_IMMUTABLE = "assignee_immutable";
// TEAM-5338 F3: where the Jira twin records the token ids it has acted on (the
// DynamoDB twin keeps them in the row's `decisionJtisUsed` string set).
export const DECISION_JTIS_PROPERTY = "agentcore-hub-gate-decision-jtis";
export const DECISION_JTIS_ATTR = "decisionJtisUsed";

/**
 * TEAM-5347 F2: the ONE spelling of "this status move starts a new decision cycle",
 * shared by the DynamoDB twin's cycleResetPlan, the Jira twin's transition path and
 * gateCycleFromChangelog below. A human gate leaving In Review, or reopened out of
 * Done, for anything but Done ends the cycle: every earlier token and DECISION
 * comment is stale after it. Internal status names (`in_review`, `done`, ...).
 */
export function isCycleResetMove(fromInternal, toInternal) {
  const from = String(fromInternal ?? "").trim().toLowerCase();
  const to = String(toInternal ?? "").trim().toLowerCase();
  if (to === "done") return false;
  return from === "in_review" || from === "done";
}
// TEAM-5338 F6: the gateVerify record version whose sig covers every field the
// reprobe acts on. Anything else is not authentic.
export const GATE_VERIFY_VERSION = 2;

/** True for the state labels only the twins may write (TEAM-5318 F4). */
export function isReservedStateLabel(label) {
  return RESERVED_STATE_LABEL_RE.test(String(label ?? "").trim().toLowerCase());
}

/**
 * TEAM-5322 FR-11: a gate is bound to ONE head. gateHeadOf takes the first match,
 * so a second, different `head:` label would either be ignored or shadow the head
 * the human decided on. The `labels_add` TOOL refuses it instead: returns
 * `{existing, requested}` (40-hex strings) when the caller's head: label(s) would
 * leave the ticket carrying more than one distinct head, else null. Re-adding the
 * same head is idempotent. A moved head means a fresh gate, never a relabel.
 */
export function headLabelConflict(existingLabels, requestedLabels) {
  const heads = (labels) => [...new Set(labelList(labels).map((l) => HEAD_LABEL_RE.exec(l)?.[1]?.toLowerCase()).filter(Boolean))];
  const requested = heads(requestedLabels);
  if (requested.length === 0) return null;
  const existing = heads(existingLabels);
  return new Set([...existing, ...requested]).size > 1 ? { existing, requested } : null;
}

/** A gate is decision-bound when it is a human gate (isHumanGate) AND its description declares options. */
export function decisionOptionsOf(ticket) {
  if (!isHumanGate(ticket)) return null;
  return parseDecisionOptions(ticket?.description);
}

// ── B2/F3: the frozen lines of a human gate ─────────────────────────────────
// TEAM-5358: what a human decides is the gate's `gate-scope:` and `DECISION
// OPTIONS:` lines. Once either is declared it is frozen, so an agent cannot widen
// the scope under a pending decision (the token's `s` would refuse the close, but
// the row would still be wrong). Once the gate is decided (done or cancelled),
// neither line may change at all, even to add one: the decision record signed the
// lines as read, so the row must keep saying what was decided. The title and any
// other text stay editable.
export const GATE_FROZEN = "gate_frozen";
const GATE_SCOPE_PRESENT_RE = /^\s*gate-scope:/m;
const DECIDED_STATUSES = new Set(["done", "cancelled"]);

/** The two frozen lines as comparable strings ("" when absent). PURE. */
function frozenLinesOf(description) {
  const text = String(description ?? "");
  const options = parseDecisionOptions(text);
  let scope = "";
  if (GATE_SCOPE_PRESENT_RE.test(text)) {
    const parsed = parseGateScope(text);
    // A malformed line is still a declared line: compare it as written.
    const raw = text.split(/\r?\n/).filter((l) => /^\s*gate-scope:/.test(l)).at(-1).trim();
    scope = parsed ? canonicalJson(parsed) : `raw:${raw}`;
  }
  return { "decision-options": options ? options.join("|") : "", "gate-scope": scope };
}

/** True when `ticket` is a human gate, so its frozen lines apply. PURE. */
export function gateFreezeApplies(ticket) {
  return isHumanGate(ticket);
}

/**
 * The refusal for an edit that would change a frozen line of a human gate, or null.
 * `before` is the gate as read: `{assignee, labels, status, description}` — a gate is
 * human by isHumanGate (`human:*` assignee, or a `human-review` / `reviewer:*` label).
 * `afterDescription` is the description the edit would write. PURE.
 * @returns {{ok:false, reason:string, field:"gate-scope"|"decision-options", decided:boolean, message:string}|null}
 */
export function gateFreezeRefusal(before, afterDescription) {
  if (!gateFreezeApplies(before)) return null;
  const decided = DECIDED_STATUSES.has(String(before?.status || ""));
  const was = frozenLinesOf(before?.description);
  const now = frozenLinesOf(afterDescription);
  for (const field of ["gate-scope", "decision-options"]) {
    if ((was[field] || decided) && was[field] !== now[field]) {
      const label = field === "gate-scope" ? "gate-scope:" : "DECISION OPTIONS:";
      return {
        ok: false,
        reason: GATE_FROZEN,
        field,
        decided,
        message: decided
          ? `this human gate is decided (${before.status}); its ${label} line cannot be added, changed or removed`
          : `this human gate declares ${label} and that line cannot be changed or removed - open a new gate for a new scope`,
      };
    }
  }
  return null;
}

// ── The decision key ────────────────────────────────────────────────────────
// Held in Secrets Manager, never in env: the runtime role cannot read the secret,
// and an env literal on a twin would be readable by anything holding
// lambda:GetFunctionConfiguration. The secret id DEFAULTS to the hub-owned name so a
// code-only CD deploy works as soon as the secret + IAM grant exist.
// GATE_DECISION_KEY is a dev/test seam only — never set it in production.
export const DECISION_KEY_CACHE_MS = 5 * 60 * 1000;
let decisionKeyCache = null; // {keys, at}
let secretsClient = null;

async function readSecretStage(id, stage) {
  if (!secretsClient) {
    secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1", maxAttempts: 2 });
  }
  const res = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: id, VersionStage: stage }),
    { abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }
  );
  return typeof res?.SecretString === "string" && res.SecretString !== "" ? res.SecretString : null;
}

/**
 * The accepted keys, newest first: [AWSCURRENT, AWSPREVIOUS?]. NEVER THROWS.
 * A failed read is not cached, so the next close retries it.
 * @returns {Promise<{ok:true, keys:string[]}|{ok:false, detail:"decision_channel_unavailable"}>}
 */
export async function loadDecisionKeys({ now = Date.now() } = {}) {
  const literal = process.env.GATE_DECISION_KEY;
  if (literal) return { ok: true, keys: [literal] };
  if (decisionKeyCache && now - decisionKeyCache.at < DECISION_KEY_CACHE_MS) {
    return { ok: true, keys: decisionKeyCache.keys };
  }
  const id = process.env.GATE_DECISION_SECRET_ID || DEFAULT_GATE_DECISION_SECRET_ID;
  try {
    const current = await readSecretStage(id, "AWSCURRENT");
    if (!current) return { ok: false, detail: DECISION_CHANNEL_UNAVAILABLE };
    let previous = null;
    try {
      previous = await readSecretStage(id, "AWSPREVIOUS");
    } catch {
      // No AWSPREVIOUS until the first rotation — that is not a failure.
    }
    const keys = previous && previous !== current ? [current, previous] : [current];
    decisionKeyCache = { keys, at: now };
    return { ok: true, keys };
  } catch (err) {
    console.warn(`[gate-contract] decision key unreadable (${err?.name || "Error"}) - bound gates fail closed`);
    return { ok: false, detail: DECISION_CHANNEL_UNAVAILABLE };
  }
}

/**
 * Who chose what, for a decision-bound gate. PURE: keys and comments are passed in.
 *
 * Answer sources, in order — and these are the ONLY ones:
 *   1. `args.decision_token`, verified against `keys`. A bad token REFUSES (it never
 *      falls through to a weaker source).
 *   2. (Jira twin only) the newest comment carrying a DECISION line whose author is
 *      in `humanAccountIds` and is not the service account. Empty list ⇒ disabled.
 * `args.reason`, a plain `args.decision` and every other comment are agent-writable
 * text; they only sharpen `detail` ("unsigned_decision_ignored").
 *
 * TEAM-5338 F3/F4 — a decision answers ONE cycle of ONE gate, once:
 *   - `workflowId` (binds when the key is present, even as null/undefined, which
 *     then refuses every token) must equal the token's signed workflow;
 *   - `notBeforeMs` is when the gate's current cycle began (it last entered review,
 *     or was marked approved-unverified): an older token is `decision_token_stale`
 *     and an older (or undated) Jira comment is not an answer;
 *   - `usedJtis` are the token ids the twin already acted on.
 * `ignoreExpiry` is the reprobe's: it re-resolves the token it held on.
 *
 * TEAM-5358: `options` are the DECLARED ones; every source admits them plus
 * UNIVERSAL_DECISION_OPTIONS (`stopped`) — a twin decides what `stopped` may close.
 * `description` is the gate's description NOW: a token whose signed scope (`s`)
 * is not its scopeHash answered a different scope and is `decision_scope_changed`
 * (F3). Comment decisions carry no scope; they answer the cycle they are in.
 *
 * @param {{ticketId:string, args?:object, options:string[], keys:string[]|null,
 *          comments?:Array<{body:string, authorAccountId?:string, created?:string}>,
 *          humanAccountIds?:string[], serviceAccountId?:string|null, now?:number,
 *          workflowId?:string|null, notBeforeMs?:number, usedJtis?:string[], ignoreExpiry?:boolean}} p
 * @returns {{ok:true, decision:{option:string, override:boolean, channel:string, by:string, workflowId:string|null, token:string|null, jti:string|null}}
 *          |{ok:false, detail:string}}
 */
export const DECISION_SCOPE_CHANGED = "decision_scope_changed";

export function resolveDecision({ ticketId, args = {}, options: declared, keys, comments = [], humanAccountIds = [], serviceAccountId = null, now, notBeforeMs, usedJtis = [], ignoreExpiry = false, description, ...bind } = {}) {
  const options = admittedOptions(declared);
  const token = typeof args.decision_token === "string" ? args.decision_token.trim() : "";
  if (token) {
    if (!Array.isArray(keys) || keys.length === 0) return { ok: false, detail: DECISION_CHANNEL_UNAVAILABLE };
    const v = verifyDecisionToken(token, {
      ticketId,
      keys,
      now,
      ignoreExpiry,
      notBeforeMs,
      ...("workflowId" in bind ? { workflowId: bind.workflowId } : {}),
    });
    if (!v.ok) return { ok: false, detail: `decision_${v.reason}` };
    if (!options.includes(v.option)) return { ok: false, detail: "decision_token_option_undeclared" };
    if (v.s !== scopeHash(description)) return { ok: false, detail: DECISION_SCOPE_CHANGED };
    if ((Array.isArray(usedJtis) ? usedJtis : []).includes(v.jti)) return { ok: false, detail: DECISION_TOKEN_CONSUMED };
    return {
      ok: true,
      decision: { option: v.option, override: true, channel: v.channel, by: v.by, workflowId: v.workflowId, token, jti: v.jti },
    };
  }

  const humans = (Array.isArray(humanAccountIds) ? humanAccountIds : []).filter(Boolean);
  const cutoff = Number.isFinite(notBeforeMs) ? notBeforeMs : null;
  if (humans.length > 0) {
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i] || {};
      const author = c.authorAccountId || "";
      if (!author || author === serviceAccountId || !humans.includes(author)) continue;
      // TEAM-5347 F8: strictly after the cut-off — a comment created at the very
      // millisecond the cycle reset is not an answer to the new cycle.
      if (cutoff !== null && !(Date.parse(c.created) > cutoff)) continue;
      const answer = parseDecisionAnswer(c.body, options);
      if (answer) {
        return {
          ok: true,
          // TEAM-5347 F1: the comment's id rides along so the Jira twin can derive ONE
          // single-use id per comment (commentDecisionJti) instead of minting a random
          // one per close — two closes on one comment must collide in the ledger.
          decision: { option: answer.option, override: answer.override, channel: "jira", by: `jira:${author}`, workflowId: null, token: null, jti: null, commentId: c.id != null ? String(c.id) : null },
        };
      }
    }
  }

  const unsigned =
    (typeof args.decision === "string" && options.includes(args.decision.trim().toLowerCase())) ||
    parseDecisionAnswer(args.reason || args.skip_reason, options) !== null ||
    comments.some((c) => parseDecisionAnswer(c?.body, options) !== null);
  return { ok: false, detail: unsigned ? "unsigned_decision_ignored" : "no_decision" };
}

/**
 * The text a twin persists as the decision comment (qa-verifier reads the last one).
 * The DECISION line stands alone: every reader of it is whole-line anchored, so the
 * attribution goes on the next line.
 */
export function decisionCommentBody(decision, note) {
  const line = `DECISION: ${decision?.override ? "override:" : ""}${decision?.option}`;
  const body = decision?.channel ? `${line}\nvia ${decision.channel}${decision.by ? ` (${decision.by})` : ""}` : line;
  // TEAM-5358: the human's note, every line quoted so none of it can read as a
  // DECISION line (DECISION_ANSWER_RE does not admit a leading `>`).
  const clean = sanitizeDecisionNote(note);
  return clean ? `${body}\n${clean.split(/\r?\n/).map((l) => `> ${l}`).join("\n")}` : body;
}

export const DECISION_NOTE_MAX = 1000;
const NOTE_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** The human's decision note, control chars stripped and clamped, or null. PURE. */
export function sanitizeDecisionNote(note) {
  if (typeof note !== "string") return null;
  const clean = note.replace(NOTE_CONTROL_RE, "").slice(0, DECISION_NOTE_MAX).trim();
  return clean || null;
}

/**
 * TEAM-5338 F4 / TEAM-5347 F2: where the gate's current decision cycle starts, read
 * from a Jira issue changelog (`histories`, any order). PURE.
 *   cycleStartMs          the newest of (a) a status change INTO one of
 *                         `inReviewNames` and (b) a status change that
 *                         isCycleResetMove says ends a cycle — OUT of In Review or
 *                         Done to anything but Done (`doneNames`). Null when there
 *                         is neither. (b) is what the DynamoDB twin stamps as
 *                         gateCycleResetAt; without it a reopen that never re-enters
 *                         In Review (In Review → Done → Blocked, then a skip) kept
 *                         the old cut-off and a pre-reopen approval still answered.
 *   approvedUnverifiedAtMs the newest change that ADDED a label matching
 *                         `approvedUnverifiedRe`, only when it is at or after
 *                         cycleStartMs (a label left from an earlier cycle is stale).
 * A history with an unparseable `created` is ignored.
 *
 * @param {Array<{created:string, items?:Array<{field?:string, fieldId?:string, fromString?:string|null, toString?:string|null}>}>} histories
 * @returns {{cycleStartMs:number|null, approvedUnverifiedAtMs:number|null}}
 */
export function gateCycleFromChangelog(histories, { inReviewNames = ["In Review"], doneNames = ["Done"], approvedUnverifiedRe = GATE_APPROVED_UNVERIFIED_RE } = {}) {
  const norm = (n) => String(n ?? "").trim().toLowerCase();
  const names = new Set((Array.isArray(inReviewNames) ? inReviewNames : [inReviewNames]).map(norm));
  const dones = new Set((Array.isArray(doneNames) ? doneNames : [doneNames]).map(norm));
  // Jira status name → the internal name isCycleResetMove speaks.
  const internal = (n) => (names.has(norm(n)) ? "in_review" : dones.has(norm(n)) ? "done" : norm(n) || null);
  const words = (s) => String(s ?? "").split(/\s+/).filter(Boolean);
  let cycleStartMs = null;
  const labelGains = [];
  for (const h of Array.isArray(histories) ? histories : []) {
    const at = Date.parse(h?.created);
    if (!Number.isFinite(at)) continue;
    for (const it of Array.isArray(h?.items) ? h.items : []) {
      const field = String(it?.fieldId || it?.field || "").toLowerCase();
      if (field === "status") {
        const entry = names.has(norm(it?.toString));
        const exit = it?.fromString != null && isCycleResetMove(internal(it.fromString), internal(it.toString));
        if ((entry || exit) && (cycleStartMs === null || at > cycleStartMs)) cycleStartMs = at;
      } else if (field === "labels") {
        const before = words(it?.fromString).some((l) => approvedUnverifiedRe.test(l));
        const after = words(it?.toString).some((l) => approvedUnverifiedRe.test(l));
        if (after && !before) labelGains.push(at);
      }
    }
  }
  let approvedUnverifiedAtMs = null;
  for (const at of labelGains) {
    if (cycleStartMs !== null && at < cycleStartMs) continue;
    if (approvedUnverifiedAtMs === null || at > approvedUnverifiedAtMs) approvedUnverifiedAtMs = at;
  }
  return { cycleStartMs, approvedUnverifiedAtMs };
}

// ── F2: the skip exemption ──────────────────────────────────────────────────
// Only the sweep's own skip of a sibling is exempt from the decision check, and
// only when the record proves it: a `skipped` record for THIS run naming a sweeper
// that is a same-parent sibling of the gate and has done real work. The sweeper is
// usually still in_progress at skip time (it skips its siblings before its own
// Done), so its own non-skipped completion record is the positive proof.
const SWEEPER_IN_SUMMARY_RE = /\bby ([A-Z][A-Z0-9]*-\d+)\b/;

/**
 * @returns {{ok:true, sweeperTicketId:string}|{ok:false, why:string}}
 */
export function judgeSkipRecord(record, { ticketId, workflowId } = {}) {
  if (!record || typeof record !== "object") return { ok: false, why: "no skip record" };
  if (record.evidence_kind !== "skipped" || record.skipped !== true) return { ok: false, why: "record is not a skip record" };
  if (record.ticketId && record.ticketId !== ticketId) return { ok: false, why: "record names another ticket" };
  if (!workflowId || record.workflowId !== workflowId) return { ok: false, why: "record belongs to another run" };
  const sweeper =
    (typeof record.sweeperTicketId === "string" && record.sweeperTicketId) ||
    SWEEPER_IN_SUMMARY_RE.exec(String(record.summary || ""))?.[1] ||
    null;
  if (!sweeper || sweeper === ticketId) return { ok: false, why: "record names no sweeper" };
  return { ok: true, sweeperTicketId: sweeper };
}

/** The sweeper side of the proof. `sweeperRecord` is its own completion record (or null). */
export function sweeperProvesSkip(sweeper, sweeperRecord, { parentId, workflowId } = {}) {
  if (!sweeper || !parentId || sweeper.parentId !== parentId) return false;
  if (sweeper.workflowId && sweeper.workflowId !== workflowId) return false;
  if (sweeper.status === "done") return true;
  if (sweeper.status !== "in_progress") return false;
  return Boolean(
    sweeperRecord && typeof sweeperRecord === "object" &&
    sweeperRecord.workflowId === workflowId &&
    sweeperRecord.evidence_kind !== "skipped" && sweeperRecord.skipped !== true
  );
}

// ── Post-conditions (FR-10) ─────────────────────────────────────────────────
// `{kind, target, expect}` on a gate ticket: what must be observably true once the
// approved action ran. Validated at create time and immutable after, so the probe
// can only ever ask the question the gate was filed with.
export const POST_CONDITION_KINDS = ["lambda_version", "cfn_stack", "pr_merged", "pipeline_execution"];
const MAX_POST_CONDITION_JSON = 1024;
const CFN_EXPECT_STATUSES = ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"];
const POST_CONDITION_RULES = {
  // codeSha256 binds image functions too (ResolvedImageUri is only on GetFunction,
  // which the probe deliberately does not have).
  lambda_version: {
    target: /^[A-Za-z0-9_-]{1,64}$/,
    expect: (e) => {
      const keys = Object.keys(e);
      if (keys.length !== 1) return "expect needs exactly one of codeSha256 | version";
      if (keys[0] === "codeSha256") return /^[A-Za-z0-9+/]{43}=$/.test(e.codeSha256) ? null : "codeSha256 must be a base64 sha256";
      if (keys[0] === "version") return /^(\$LATEST|[1-9]\d{0,9})$/.test(e.version) ? null : "version must be $LATEST or a number";
      return "expect needs exactly one of codeSha256 | version";
    },
  },
  cfn_stack: {
    target: /^[A-Za-z][A-Za-z0-9-]{0,127}$/,
    expect: (e) =>
      Object.keys(e).length === 1 && CFN_EXPECT_STATUSES.includes(e.stackStatus)
        ? null
        : `expect must be {stackStatus: ${CFN_EXPECT_STATUSES.join(" | ")}}`,
  },
  pr_merged: {
    target: /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#[1-9]\d{0,9}$/,
    expect: (e) => {
      const keys = Object.keys(e);
      if (keys.length === 0) return null;
      if (keys.length === 1 && /^[0-9a-f]{40}$/.test(e.headSha)) return null;
      return "expect must be {} or {headSha: <40 hex>}";
    },
  },
  pipeline_execution: {
    target: /^[A-Za-z0-9._-]{1,100}#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    expect: (e) => (Object.keys(e).length === 1 && e.status === "Succeeded" ? null : 'expect must be {status: "Succeeded"}'),
  },
};

/**
 * `labels` are the ticket's own labels at create time. A `pipeline_execution`
 * post-condition probes exactly the execution the gate is ABOUT: its target must be
 * `<pipeline:>#<exec:>` of those labels, or a gate for execution A could be
 * finished by execution B succeeding. The binding is a create-time check:
 * a re-validation of an already-stored post-condition omits `labels` and checks shape only.
 * @returns {{ok:true, postCondition:{kind:string, target:string, expect:object}}|{ok:false, error:string}}
 */
export function validatePostCondition(pc, { labels } = {}) {
  let value = pc;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: "post_condition is not JSON" };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "post_condition must be an object" };
  const extra = Object.keys(value).filter((k) => !["kind", "target", "expect"].includes(k));
  if (extra.length) return { ok: false, error: `unknown post_condition keys: ${extra.join(", ")}` };
  const rule = POST_CONDITION_RULES[value.kind];
  if (!rule) return { ok: false, error: `kind must be one of ${POST_CONDITION_KINDS.join(", ")}` };
  if (typeof value.target !== "string" || !rule.target.test(value.target)) return { ok: false, error: `invalid target for ${value.kind}` };
  let expect = value.expect === undefined ? {} : value.expect;
  if (typeof expect === "string") {
    try {
      expect = JSON.parse(expect);
    } catch {
      return { ok: false, error: "expect is not JSON" };
    }
  }
  if (!expect || typeof expect !== "object" || Array.isArray(expect)) return { ok: false, error: "expect must be an object" };
  const bad = rule.expect(expect);
  if (bad) return { ok: false, error: bad };
  if (value.kind === "pipeline_execution" && labels !== undefined) {
    const [pipeline, execId] = value.target.toLowerCase().split("#");
    const execLabel = gateExecOf(labels);
    const pipelineLabel = gatePipelineOf(labels);
    if (!execLabel || execLabel !== execId) return { ok: false, error: "pipeline_execution target must name the gate's exec: label" };
    if (pipelineLabel && pipelineLabel !== pipeline) return { ok: false, error: "pipeline_execution target must name the gate's pipeline: label" };
  }
  const postCondition = { kind: value.kind, target: value.target, expect };
  if (JSON.stringify(postCondition).length > MAX_POST_CONDITION_JSON) return { ok: false, error: "post_condition is too large" };
  return { ok: true, postCondition };
}

export function postConditionRefusal(reason, error) {
  return {
    payload: { ok: false, reason, error: error || null },
    message:
      reason === POST_CONDITION_IMMUTABLE
        ? "post_condition cannot be changed once a ticket carries one; file a new gate instead."
        : `post_condition rejected: ${error}`,
  };
}

const MAX_OBSERVED_JSON = 2048;

/**
 * Ask the tools Lambda whether a post-condition holds. NEVER THROWS. Indeterminate
 * (probe unreachable, unparseable, `met` not literally true) is UNMET — see the
 * section header for why this fail direction differs from verifyGateCondition's.
 * @returns {Promise<{met:boolean, observed:object|null, detail:string, probeAt:string}>}
 */
export async function probePostCondition(fnName, pc) {
  const probeAt = new Date().toISOString();
  const r = await invokeProbe(fnName, "Pipeline___verify_postcondition", {
    kind: pc?.kind,
    target: pc?.target,
    expect: pc?.expect || {},
  });
  if (!r.ok) return { met: false, observed: null, detail: `indeterminate:${r.error}`, probeAt };
  const res = r.result || {};
  let observed = res.observed && typeof res.observed === "object" && !Array.isArray(res.observed) ? res.observed : null;
  if (observed && JSON.stringify(observed).length > MAX_OBSERVED_JSON) observed = null;
  const met = res.met === true;
  const detail = met ? "met" : String(res.error || res.detail || "unmet").slice(0, 200);
  return { met, observed, detail, probeAt };
}

// ── Signed twin records ─────────────────────────────────────────────────────
// The verification state (DynamoDB row map / Jira entity property) and the merge
// approval record live where the runtime role can also write, so a reader acts on
// one only when its sig verifies AND its decision token re-verifies.

// TEAM-5338 F6: v2 signs every field the reprobe acts on — the post-condition it
// probes (canonical JSON) and the actor it writes into the merge-approval record —
// so editing any of them on the row breaks the sig.
function gateVerifyFields(gv) {
  const d = gv?.decision;
  return [
    gv?.v, gv?.ticketId, gv?.workflowId, gv?.requestedAt, gv?.verifyUntil,
    d?.option, d?.override, d?.channel, d?.by, d?.token,
    canonicalJson(gv?.postCondition ?? null),
  ];
}

/** True when two post-conditions are the same value (key order ignored). */
export function samePostCondition(a, b) {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

export function buildGateVerify({ ticketId, workflowId, decision, postCondition, probe, now = Date.now() }, key) {
  const requestedAt = new Date(now).toISOString();
  const gv = {
    v: GATE_VERIFY_VERSION,
    ticketId,
    workflowId: workflowId || null,
    requestedAt,
    verifyUntil: new Date(now + VERIFY_WINDOW_MS).toISOString(),
    decision: {
      option: decision.option,
      override: Boolean(decision.override),
      channel: decision.channel,
      by: decision.by,
      token: decision.token || null,
    },
    postCondition: postCondition ?? null,
    lastProbe: probe ? { probeAt: probe.probeAt, met: probe.met, observed: probe.observed, detail: probe.detail } : null,
    attempts: 1,
    result: null,
  };
  gv.sig = signVerifyRecord(gateVerifyFields(gv), key);
  return gv;
}

/**
 * The reprobe's trust check: a v2 record, sig over every field it acts on, the row
 * names this ticket, and the stored decision token re-verifies (expiry ignored —
 * the bound is verifyUntil) for the same option, channel, actor and workflow the
 * record claims. A v1 record (sig without postCondition/actor) is never authentic:
 * it fails closed and the human decides again. @returns {boolean}
 */
export function gateVerifyAuthentic(gv, { ticketId, keys } = {}) {
  if (!gv || typeof gv !== "object" || gv.v !== GATE_VERIFY_VERSION || gv.ticketId !== ticketId) return false;
  if (!verifyRecordSig(gateVerifyFields(gv), gv.sig, keys)) return false;
  if (!gv.decision?.token) return false;
  const v = verifyDecisionToken(gv.decision.token, { ticketId, keys, ignoreExpiry: true, workflowId: gv.workflowId });
  return v.ok && v.option === gv.decision.option && v.channel === gv.decision.channel && v.by === gv.decision.by;
}

export function isMergeApprovalGate({ title, summary, labels } = {}) {
  const t = String(title ?? summary ?? "");
  return /^Merge Approval:/i.test(t.trim()) || labelList(labels).some((l) => MERGE_GATE_LABEL_RE.test(l));
}

export function mergeApprovalRecordKey(workflowId) {
  return `pipeline-artifacts/gate-decisions/${workflowId}/merge-approval.json`;
}

function mergeApprovalFields(r) {
  return [r.v, r.ticketId, r.workflowId, r.kind, r.status, r.decision?.option, r.decision?.channel, r.decision?.by, r.decidedAt, r.headSha];
}

/** The FR-11 record recordShipApproval reads (pipeline-tools, chunk B). */
export function buildMergeApprovalRecord({ ticketId, workflowId, decision, labels, now = Date.now() }, key) {
  const record = {
    v: 1,
    ticketId,
    workflowId,
    kind: "merge-approval",
    status: "done",
    decision: { option: decision.option, override: Boolean(decision.override), channel: decision.channel, by: decision.by },
    decidedAt: new Date(now).toISOString(),
    headSha: gateHeadOf(labels) || null,
    labels: labelList(labels),
  };
  record.sig = signVerifyRecord(mergeApprovalFields(record), key);
  return record;
}

export function verifyMergeApprovalRecord(record, keys) {
  return Boolean(record && typeof record === "object" && verifyRecordSig(mergeApprovalFields(record), record.sig, keys));
}

// ─── TEAM-5340 finding 1: the per-gate decision record ───────────────────────
//
// The merge-approval record above generalized to EVERY decided human gate: the
// twins write it wherever a verified decision token takes a gate to done or
// cancelled. TEAM-5372: unlike the merge-approval record it is written BEFORE the
// status moves, create-once (judgeGateDecisionClaim below), and a failed write
// refuses the close — a closed gate without its record is indistinguishable from a
// bypassed one.
// workflow-output reads it to admit a `human:<id>` accepted residual: the key sits
// under the gate-decisions/ prefix no agent can write, and the HMAC is what rules
// out the hub principals that hold bucket-wide PutObject. A DECISION comment is
// not a substitute — add_comment takes any body.

export function gateDecisionRecordKey(workflowId, ticketId) {
  return `pipeline-artifacts/gate-decisions/${workflowId}/gates/${ticketId}.json`;
}

// ─── TEAM-5347 F1/F3: the Jira twin's create-once ledgers ───────────────────
//
// Jira issue properties have no conditional write, so the Jira twin cannot spend a
// decision token (or claim a hold it is about to act on) atomically in Jira. It does
// it in S3 instead: one PutObject with `IfNoneMatch:"*"` per single-use id, under the
// gate-decisions/ prefix both twins may already write and no agent can. S3 answers
// 412 PreconditionFailed to every writer but the first, which is the same guarantee
// the DynamoDB twin gets from `NOT contains(#jti, :jti)` in its row write. These are
// the PURE halves (keys + error classification); the I/O lives in the twin, which
// owns the S3 client. The record body must never carry the token itself.

/** Where the Jira twin records that decision token id `jti` was spent on `ticketId`. */
export function gateJtiLedgerKey(workflowId, ticketId, jti) {
  return `pipeline-artifacts/gate-decisions/${workflowId}/jti/${ticketId}/${jti}.json`;
}

/** Where the Jira twin claims a gateVerify hold (by its signature) before acting on it. */
export function gateHoldActedKey(workflowId, ticketId, sig) {
  const h = createHash("sha256").update(String(sig ?? "")).digest("hex");
  return `pipeline-artifacts/gate-decisions/${workflowId}/holds/${ticketId}/${h}.acted.json`;
}

/**
 * What a conditional PutObject's failure means:
 *   lost      412 PreconditionFailed — another writer already holds the key;
 *   conflict  409 ConditionalRequestConflict — two conditional writes raced; retry;
 *   error     anything else.
 */
export function classifyConditionalPutError(err) {
  const name = String(err?.name || err?.Code || err?.code || "");
  const status = err?.$metadata?.httpStatusCode;
  if (name === "PreconditionFailed" || status === 412) return "lost";
  if (name === "ConditionalRequestConflict" || status === 409) return "conflict";
  return "error";
}

/**
 * The single-use id of a decision made as a Jira comment: a function of the comment,
 * never random, so two closes resolving the same DECISION comment spend the SAME id
 * and exactly one wins the ledger. Shaped to satisfy DECISION_TOKEN_JTI_RE.
 */
export function commentDecisionJti(ticketId, commentId, authorAccountId) {
  const digest = createHash("sha256")
    .update(`${ticketId}|${commentId}|${authorAccountId ?? ""}`)
    .digest("base64url");
  return digest.slice(0, 32);
}

// ─── TEAM-5348 F1: the record is bound to WHAT it accepts ─────────────────────
//
// v1 signed the gate, the run and the human, and nothing else — so an authentic
// record from any Done acceptance gate in the epic admitted any finding at any
// round on any head, and survived a reopen. v2 signs two more things:
//
//   scope   the `gate-scope:` line the gate's description carried when it was
//           decided — {round, headSha, findingIds}: the findings the human saw and
//           accepted, at which round, on which head. Written by the persona that
//           opens the gate (code-reviewer / release-manager escalation template,
//           operator on the Merge Approval gate), parsed by the twin at close with
//           parseGateScope and signed as read. A gate without the line gets
//           `scope: null`, which the reader refuses: the close is never refused for
//           it (an unliftable stall), the ACCEPTANCE is.
//   cycle   the gate's decision cycle at the close (DynamoDB: `gateCycleResetAt`;
//           Jira: the changelog's cycleStartMs), as an ISO string or null. The
//           reader compares it with the cycle `get_issue` reports NOW, so a record
//           from before a reopen is stale even when the gate is Done again — a
//           skip-close writes no record and would otherwise leave this one standing.
//           Read-time, not a tombstone: the Jira webhook reopens through JiraClient
//           directly and a human can reopen in the Jira UI, so no twin write site
//           sees every reopen.
//
// A v1 record is NOT authentic (fail closed, like GATE_VERIFY_VERSION): the human
// decides again on a scoped gate.
//
// v3 (TEAM-5358 FR-6/F10): `status` is "cancelled" for `stopped` and "done"
// otherwise, `decision.note` is the human's sanitized note, and the sig is the HMAC
// of canonicalJson(record minus sig) — every member signed, none by position. v2
// still verifies (its `|`-joined fields, status "done" only) so records written
// before v3 keep backing their acceptances; v1 and anything else do not.
export const GATE_DECISION_VERSION = 3;
const GATE_DECISION_V2 = 2;

// FINDING_ID_RE, GATE_SCOPE_MAX_FINDINGS and parseGateScope moved to
// decision-contract.mjs (TEAM-5358 F3, the token's scope binding) and are
// re-exported above unchanged.

function gateDecisionFields(r) {
  return [
    r.v, r.ticketId, r.workflowId, r.kind, r.status,
    r.decision?.option, Boolean(r.decision?.override), r.decision?.channel, r.decision?.by, r.decidedAt,
    // v2: ids cannot contain "," or "|" (FINDING_ID_RE), so the join is unambiguous.
    r.scope?.headSha, r.scope?.round, Array.isArray(r.scope?.findingIds) ? r.scope.findingIds.join(",") : null, r.cycle,
  ];
}

/**
 * @param {{ticketId:string, workflowId:string, decision:object, labels?:any,
 *          description?:string, cycle?:string|null, now?:number}} p
 *   `description` is the gate's description AS READ at the close (its gate-scope
 *   line is what gets signed); `cycle` the gate's decision-cycle mark at the close.
 */
export function buildGateDecisionRecord({ ticketId, workflowId, decision, labels, description, cycle = null, note, now = Date.now() }, key) {
  const clean = sanitizeDecisionNote(note);
  const record = {
    v: GATE_DECISION_VERSION,
    ticketId,
    workflowId,
    kind: "gate-decision",
    status: gateDecisionStatusOf(decision.option),
    // `by` is the resolved decision's (the verified token's signer, or the Jira
    // comment's author) — never a caller argument.
    decision: {
      option: decision.option,
      override: Boolean(decision.override),
      channel: decision.channel,
      by: decision.by,
      ...(clean ? { note: clean } : {}),
    },
    decidedAt: new Date(now).toISOString(),
    scope: parseGateScope(description),
    cycle: typeof cycle === "string" && cycle ? cycle : null,
    labels: labelList(labels),
  };
  record.sig = signVerifyRecord([canonicalJson(record)], key);
  return record;
}

/** The status a decided gate ends in: `stopped` cancels, every other option is done. */
export function gateDecisionStatusOf(option) {
  return option === "stopped" ? "cancelled" : "done";
}

/**
 * Authentic iff it is a v3 gate-decision record whose sig verifies over
 * canonicalJson(record minus sig) and whose status is the one its option implies,
 * or a legacy v2 record (status "done") whose `|`-joined sig verifies.
 */
export function verifyGateDecisionRecord(record, keys) {
  if (!record || typeof record !== "object" || record.kind !== "gate-decision") return false;
  if (record.v === GATE_DECISION_VERSION) {
    if (!record.decision || typeof record.decision !== "object") return false;
    if (record.status !== gateDecisionStatusOf(record.decision.option)) return false;
    const { sig, ...rest } = record;
    return verifyRecordSig([canonicalJson(rest)], sig, keys);
  }
  if (record.v === GATE_DECISION_V2) {
    return record.status === "done" && verifyRecordSig(gateDecisionFields(record), record.sig, keys);
  }
  return false;
}

// ─── TEAM-5372: the record is claimed before the status moves ─────────────────
//
// One key per gate, but a gate can be reopened into a new decision cycle, so the
// twin's create-once write (`IfNoneMatch:"*"`) that finds an object already there
// asks this what it found:
//   same      an authentic record of THIS decision (same gate, run, cycle, status,
//             option, override, channel, human) — a retry; reuse it, write nothing;
//   replace   a record from a strictly older cycle, or anything that does not
//             verify — overwrite it with `IfMatch:<etag>`;
//   stale     an authentic record from a NEWER cycle — the gate was reopened after
//             this close read it; refuse (GATE_MOVED), never overwrite;
//   conflict  an authentic record of a DIFFERENT decision in this cycle — refuse.
// decidedAt, note, scope and sig are not compared: a retry rebuilds them, and the
// record already there stands as written.
export const GATE_DECISION_UNRECORDED = "gate_decision_unrecorded";
export const GATE_DECISION_CONFLICT = "gate_decision_conflict";

/** A record's cycle as epoch ms; -Infinity for null (the first cycle is the oldest). */
function cycleMsOf(cycle) {
  if (typeof cycle !== "string" || !cycle) return -Infinity;
  const ms = Date.parse(cycle);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** @returns {"same"|"replace"|"stale"|"conflict"} */
export function judgeGateDecisionClaim(existing, fresh, keys) {
  if (!verifyGateDecisionRecord(existing, keys)) return "replace";
  if (existing.ticketId !== fresh?.ticketId || existing.workflowId !== fresh?.workflowId) return "replace";
  const was = cycleMsOf(existing.cycle);
  const now = cycleMsOf(fresh.cycle);
  if (was < now) return "replace";
  if (was > now) return "stale";
  const a = existing.decision || {};
  const b = fresh.decision || {};
  const same =
    existing.status === fresh.status &&
    a.option === b.option &&
    Boolean(a.override) === Boolean(b.override) &&
    a.channel === b.channel &&
    a.by === b.by;
  return same ? "same" : "conflict";
}

// ─── TEAM-5387: the claim itself, once, for both twins — and it never deletes ──
//
// TEAM-5372 had each twin "compensate" a close whose status write failed by
// deleting the record it had just written (DeleteObject, IfMatch on its own ETag).
// That was wrong: `same` above carries no jti, so a SECOND legitimate close of the
// same decision (another token for the same human, option and cycle) adopts the
// first close's record and closes the gate on it. The first close then lost its
// status CAS as `ticket_moved`, not as its own token consumed, and deleted the very
// record the winner's close depends on — the ETag fence cannot tell (same bytes).
//
// The invariant now: the object at gates/<ticket>.json is created once per decision
// cycle by a close that verified a human decision token, is replaced only by a close
// in a strictly newer cycle (or over an unverifiable squatter), and is NEVER
// deleted. A verifying record is therefore always the signed record of a real human
// decision in the cycle it names; the ticket's status and cycle, not the record, say
// whether that decision landed. A record whose close did not land ("orphan") is
// harmless to every reader: the close-out readers judge records only for tickets
// already done; cancel-run acts on a `cancelled` orphan for an open gate, which
// completes the stop that human signed in this cycle — and no DIFFERENT decision
// can have landed instead, because it would have found this record and been refused
// `conflict` before any row or ledger write. That refusal stands until a cycle-reset
// move (the gate leaves review) — fail closed, never open.
//
// The I/O is injected so this module stays zero-import:
//   io.put({ Key, Body, IfNoneMatch? | IfMatch? }) -> { etag }   (throws SDK errors)
//   io.get({ Key })                                -> { text, etag }  (throws SDK errors)
// There is deliberately no io.delete.
export const GATE_DECISION_STORE_UNAUTHORIZED = "gate_decision_store_unauthorized";

/** The one grant a twin role needs for the gate-decision store (human-applied, TEAM-5377). */
export function gateDecisionStoreGrant(bucket) {
  return `s3:PutObject on arn:aws:s3:::${bucket}/pipeline-artifacts/gate-decisions/*`;
}

/**
 * classifyConditionalPutError, plus `unauthorized` for an AccessDenied / 403 on the
 * PUT (S3 authorizes before it evaluates the precondition, so a 403 is never a lost
 * race). The twin fails CLOSED on it and names the missing grant.
 * @returns {"lost"|"conflict"|"unauthorized"|"error"}
 */
export function classifyGateDecisionPutError(err) {
  const kind = classifyConditionalPutError(err);
  if (kind !== "error") return kind;
  const name = String(err?.name || err?.Code || err?.code || "");
  if (name === "AccessDenied" || err?.$metadata?.httpStatusCode === 403) return "unauthorized";
  return "error";
}

/** A GetObject failure that means "no object there" (no s3:ListBucket, so a missing key is a 403 too). */
function isMissingGateObject(err) {
  return ["NoSuchKey", "NotFound", "AccessDenied"].includes(err?.name) || [403, 404].includes(err?.$metadata?.httpStatusCode);
}

/**
 * Claim the gate-decision record for ONE decided close. Never throws, never deletes.
 *   created   this call wrote the record (`IfNoneMatch:"*"`);
 *   replaced  this call overwrote an older-cycle or unverifiable record (`IfMatch`);
 *   same      an authentic record of this decision was already there — reused.
 * Refusals: GATE_MOVED (a newer cycle's record), GATE_DECISION_CONFLICT (another
 * decision in this cycle), GATE_DECISION_STORE_UNAUTHORIZED (the role may not write
 * the prefix; `missingGrant` names it), GATE_DECISION_UNRECORDED (anything else).
 *
 * @param {{put:Function, get:Function}} io
 * @param {{bucket:string, key:string, record:object, keys:string[], attempts?:number, wait?:Function, log?:{warn:Function,error:Function}, tag?:string}} args
 * @returns {Promise<{ok:true, outcome:"created"|"replaced"|"same", key:string}|{ok:false, detail:string, missingGrant?:string}>}
 */
export async function putGateDecisionClaim(io, { bucket, key, record, keys, attempts = 3, wait = async () => {}, log = console, tag = "" }) {
  const body = JSON.stringify(record, null, 2);
  const prefix = tag ? `${tag}: ` : "";
  try {
    let ifMatch = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await io.put({ Key: key, Body: body, ...(ifMatch ? { IfMatch: ifMatch } : { IfNoneMatch: "*" }) });
        return { ok: true, outcome: ifMatch ? "replaced" : "created", key };
      } catch (err) {
        const kind = classifyGateDecisionPutError(err);
        if (kind === "conflict") {
          await wait();
          continue;
        }
        if (kind === "unauthorized") {
          const missingGrant = gateDecisionStoreGrant(bucket);
          log.error(`${prefix}gate-decision record refused - ${GATE_DECISION_STORE_UNAUTHORIZED}; missing grant: ${missingGrant} (TEAM-5377)`);
          return { ok: false, detail: GATE_DECISION_STORE_UNAUTHORIZED, missingGrant };
        }
        if (kind !== "lost") throw err;
      }
      let existing;
      try {
        const res = await io.get({ Key: key });
        let parsed = null;
        try { parsed = res?.text ? JSON.parse(res.text) : null; } catch { parsed = null; }
        existing = { body: parsed, etag: res?.etag ?? null };
      } catch (err) {
        // Gone between the put and the read: create again.
        if (!isMissingGateObject(err)) throw err;
        ifMatch = null;
        continue;
      }
      const verdict = judgeGateDecisionClaim(existing.body, record, keys);
      if (verdict === "same") return { ok: true, outcome: "same", key };
      if (verdict === "stale" || verdict === "conflict") {
        const detail = verdict === "stale" ? GATE_MOVED : GATE_DECISION_CONFLICT;
        log.warn(`${prefix}gate-decision record refused - ${detail}`);
        return { ok: false, detail };
      }
      if (!existing.etag) throw Object.assign(new Error("existing record has no ETag"), { name: "NoETag" });
      ifMatch = existing.etag;
    }
    log.warn(`${prefix}gate-decision record not claimed after ${attempts} attempts`);
    return { ok: false, detail: GATE_DECISION_UNRECORDED };
  } catch (err) {
    log.warn(`${prefix}gate-decision record not written - ${err?.name}`);
    return { ok: false, detail: GATE_DECISION_UNRECORDED };
  }
}
