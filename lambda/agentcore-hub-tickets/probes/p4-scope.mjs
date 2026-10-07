#!/usr/bin/env node
/**
 * p4-scope probe (TEAM-5358 B2/F3): the security review's round-3 repro, run
 * against the REAL tickets-twin handler with the @aws-sdk/* modules swapped for
 * an in-memory emulator (./aws-sdk-stub.mjs) that actually applies writes and
 * evaluates ConditionExpressions.
 *
 *   node lambda/agentcore-hub-tickets/probes/p4-scope.mjs
 *
 * Round 3 before the fix: a gate opened with scope [CR-9:11111111], the human
 * approved, the agent's update_ticket appended CR-9:22222222, and the row (and
 * any record signed from it later) said both were decided:
 *   unseen P0 CR-9:22222222 => ADMITTED
 * Exits 1 if any step admits the unseen finding.
 */
import { register } from "node:module";

const STUB = new URL("./aws-sdk-stub.mjs", import.meta.url).href;
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(s, c, next) { return s.startsWith("@aws-sdk/") ? { url: ${JSON.stringify(STUB)}, shortCircuit: true } : next(s, c); }`,
    ),
);

Object.assign(process.env, {
  AWS_REGION: "us-east-1",
  TICKETS_TABLE: "probe-tickets",
  EVENTS_TABLE: "probe-events",
  ARTIFACT_BUCKET: "probe-artifacts",
  PIPELINE_TOOLS_LAMBDA: "probe-pipeline-tools",
  GATE_DECISION_KEY: "probe-gate-decision-key-0123456789abcdef",
});

const aws = (globalThis.__probeAws = { items: {}, s3: {}, invoke: null, log: [] });
const { handler } = await import("../index.mjs");
const dc = await import("../decision-contract.mjs");
const gc = await import("../gate-contract.mjs");

const WF = "wf_probe_p4_scope";
const GATE = "PROBE-1";
const HEAD = "19d074146120e4f72ec19b4276e25246cc043f82";
const OPTIONS = "Approve the CR-9 review findings for PR #1.\nDECISION OPTIONS: approve | reject";
const scopeLine = (ids) => `gate-scope: {"round": 3, "headSha": "${HEAD}", "findingIds": ${JSON.stringify(ids)}}`;
const SEEN = `${OPTIONS}\n${scopeLine(["CR-9:11111111"])}`;
const WIDENED = `${OPTIONS}\n${scopeLine(["CR-9:11111111", "CR-9:22222222"])}`;

let failed = false;
const line = (s) => console.log(s);
const check = (label, ok, detail) => {
  if (!ok) failed = true;
  line(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  [${detail}]` : ""}`);
};
const call = (name, args) => handler({ name, arguments: args });
const seed = (description, over = {}) => {
  aws.items[GATE] = {
    ticketId: GATE,
    title: "Review Approval: CR-9",
    assignee: "human:engineer",
    status: "in_review",
    workflowId: WF,
    description,
    comments: [],
    labels: [],
    ...over,
  };
  aws.s3 = {};
};
const mint = (description) =>
  dc.mintDecisionToken({ ticketId: GATE, option: "approve", channel: "hub", by: "eng@example.com", workflowId: WF, description }, process.env.GATE_DECISION_KEY);
const signedRecord = () => {
  const key = Object.keys(aws.s3).find((k) => k.includes(GATE));
  return key ? JSON.parse(aws.s3[key]) : null;
};
const verdict = (scope) => (scope?.findingIds || []).includes("CR-9:22222222") ? "ADMITTED" : "REFUSED";

// ── 1. round-3 repro: approve, then widen ───────────────────────────────────
line("== p4-scope round 3: scope [CR-9:11111111] -> human approves -> agent appends CR-9:22222222");
seed(SEEN);
const closed = await call("Tickets___transition_ticket", { ticket_id: GATE, transition_id: "done", decision_token: mint(SEEN) });
const record = signedRecord();
check("human approve closes the gate", aws.items[GATE].status === "done", `status=${aws.items[GATE].status} result=${closed.status || closed.reason}`);
check("decision record signs the scope the human saw", JSON.stringify(record?.scope?.findingIds) === '["CR-9:11111111"]', `v=${record?.v} findingIds=${JSON.stringify(record?.scope?.findingIds)}`);

const widened = await call("Tickets___update_ticket", { ticket_id: GATE, description: WIDENED });
check("agent update_ticket widening a decided gate is refused", widened.ok === false && widened.reason === gc.GATE_FROZEN, `reason=${widened.reason} field=${widened.field} decided=${widened.decided}`);
check("row description unchanged", aws.items[GATE].description === SEEN);
const rowScope = gc.parseGateScope(aws.items[GATE].description);
line(`unseen P0 CR-9:22222222 => ${verdict(rowScope)} (row findingIds=${JSON.stringify(rowScope?.findingIds)}, record findingIds=${JSON.stringify(record?.scope?.findingIds)})`);
if (verdict(rowScope) === "ADMITTED") failed = true;

// ── 2. the same widening before the decision ────────────────────────────────
line("\n== p4-scope pre-decision: agent widens an open gate");
seed(SEEN);
const early = await call("Tickets___update_ticket", { ticket_id: GATE, description: WIDENED });
check("widening an open gate is refused", early.reason === gc.GATE_FROZEN && early.decided === false, `reason=${early.reason} field=${early.field} decided=${early.decided}`);
check("row description unchanged", aws.items[GATE].description === SEEN);

// ── 3. scope edited between view and click ──────────────────────────────────
line("\n== p4-scope view/click: human views a gate with no scope line, agent adds one, click lands");
seed(OPTIONS);
const clicked = mint(OPTIONS);
const added = await call("Tickets___update_ticket", { ticket_id: GATE, description: WIDENED });
check("adding an undeclared scope line to an open gate is allowed", added.status === "updated", `status=${added.status || added.reason}`);
const stale = await call("Tickets___transition_ticket", { ticket_id: GATE, transition_id: "done", decision_token: clicked });
check("the click for the unscoped gate is refused", stale.ok === false && stale.detail === "decision_scope_changed", `reason=${stale.reason} detail=${stale.detail}`);
check("no decision record, gate still open", !signedRecord() && aws.items[GATE].status === "in_review", `status=${aws.items[GATE].status}`);
line(`unseen P0 CR-9:22222222 => ${signedRecord() ? verdict(signedRecord().scope) : "REFUSED"} (close refused: ${stale.detail})`);

line(`\n${failed ? "PROBE FAILED" : "PROBE PASSED"}  (ddb ops=${aws.log.filter((e) => e.service === "ddb").length}, s3 ops=${aws.log.filter((e) => e.service === "s3").length})`);
process.exit(failed ? 1 : 0);
