import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// TEAM-5371: THE human-gate rule is fix-contract.mjs isHumanGate (4 byte copies).
// Every tier that asks "is this ticket a human gate?" is run over one shared fixture
// (human-gate-cases.json; pytest reads the same file for compute_metrics.is_human_gate).
import * as orchFix from "../../../lambda/orchestrator/fix-contract.mjs";
import * as ticketsFix from "../../../lambda/agentcore-hub-tickets/fix-contract.mjs";
import * as jiraFix from "../../../lambda/agentcore-hub-jira/fix-contract.mjs";
import * as workflowOutputFix from "../../../lambda/workflow-output/fix-contract.mjs";
import * as completion from "../../../lambda/orchestrator/completion.mjs";
import * as ticketsGate from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";
import * as jiraGate from "../../../lambda/agentcore-hub-jira/gate-contract.mjs";
import * as workflowOutputGate from "../../../lambda/workflow-output/gate-contract.mjs";
import { isHumanGateTicket, owesNoDeliverable } from "./completion-evidence";
import { isDecisionBound } from "./decision-grammar";
import fixture from "./human-gate-cases.json";

type Case = { name: string; ticket: Record<string, unknown> | null; isHumanGate: boolean; owesNoDeliverable: boolean };
const CASES = fixture.cases as Case[];
const OPTIONS = "Merge brief\nDECISION OPTIONS: approve | reject";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pred = (t: any) => unknown;
const GATE_SITES: Record<string, Pred> = {
  "orchestrator/fix-contract isHumanGate": orchFix.isHumanGate,
  "agentcore-hub-tickets/fix-contract isHumanGate": ticketsFix.isHumanGate,
  "agentcore-hub-jira/fix-contract isHumanGate": jiraFix.isHumanGate,
  "workflow-output/fix-contract isHumanGate": workflowOutputFix.isHumanGate,
  "orchestrator/completion isHumanGateTicket": completion.isHumanGateTicket,
  "agentcore-hub-tickets/gate-contract gateFreezeApplies": ticketsGate.gateFreezeApplies,
  "agentcore-hub-jira/gate-contract gateFreezeApplies": jiraGate.gateFreezeApplies,
  "workflow-output/gate-contract gateFreezeApplies": workflowOutputGate.gateFreezeApplies,
  "completion-evidence.ts isHumanGateTicket": isHumanGateTicket,
};
// A declared gate: non-null options exactly when the ticket is a gate.
const withOptions = (t: Case["ticket"]) => (t === null ? null : { ...t, description: OPTIONS });
const BOUND_SITES: Record<string, Pred> = {
  "agentcore-hub-tickets/gate-contract decisionOptionsOf": (t) => ticketsGate.decisionOptionsOf(withOptions(t)) !== null,
  "agentcore-hub-jira/gate-contract decisionOptionsOf": (t) => jiraGate.decisionOptionsOf(withOptions(t)) !== null,
  "workflow-output/gate-contract decisionOptionsOf": (t) => workflowOutputGate.decisionOptionsOf(withOptions(t)) !== null,
  "decision-grammar.ts isDecisionBound": (t) => (t === null ? false : isDecisionBound(withOptions(t)!)),
};
const EXEMPT_SITES: Record<string, Pred> = {
  "orchestrator/completion owesNoDeliverable": completion.owesNoDeliverable,
  "completion-evidence.ts owesNoDeliverable": owesNoDeliverable,
};

describe("TEAM-5371: one human-gate rule, every tier (shared fixture)", () => {
  it("the fixture covers each marker on its own and the near misses", () => {
    expect(CASES.filter((c) => c.isHumanGate).length).toBeGreaterThan(4);
    expect(CASES.some((c) => c.isHumanGate && !c.owesNoDeliverable)).toBe(true); // reviewer:-only (R1)
    expect(CASES.some((c) => c.ticket === null)).toBe(true);
  });

  for (const [site, pred] of Object.entries({ ...GATE_SITES, ...BOUND_SITES })) {
    it(`${site} agrees with every case`, () => {
      for (const c of CASES) expect([c.name, pred(c.ticket)]).toEqual([c.name, c.isHumanGate]);
    });
  }

  for (const [site, pred] of Object.entries(EXEMPT_SITES)) {
    it(`${site} is the pre-5371 exempt set, a subset of the gates (R1)`, () => {
      for (const c of CASES) {
        expect([c.name, pred(c.ticket)]).toEqual([c.name, c.owesNoDeliverable]);
        if (c.owesNoDeliverable) expect([c.name, c.isHumanGate]).toEqual([c.name, true]);
      }
    });
  }
});

// ── Grep pin ────────────────────────────────────────────────────────────────
// No new gate classification outside the helpers: every remaining `startsWith("human:")`
// / `startswith("human:")` / `includes("human-review")` in shipped source is listed here
// with why it is a different question. `count` = lines in that file containing `contains`.
const REPO = resolve(__dirname, "../../..");
const ROOTS = ["src", "lambda", "deploy"];
const SKIP_DIRS = new Set(["node_modules", ".next", "cdk.out", "dist", "__pycache__", "fixtures", ".venv"]);
const PIN_RE = /startsWith\(\s*["']human:|startswith\(\s*["']human:|startswith\(\s*HUMAN_PREFIX|includes\(\s*["']human-review/;

type Allow = { file: string; contains: string; count?: number; reason: string };
const HELPER = "helper definition";
const EXEMPTION = "privilege (R1): evidence/completion exemption keeps the pre-5371 assignee-only set";
const FINDER = "privilege (R2): root/CD sibling finder stays assignee-only so a ticket cannot escape the CD freeze/root wait";
const CREATE_ARG = "classifies the caller's assignee ARGUMENT being written (create/reassign), not a stored ticket";
const ALLOW: Allow[] = [
  ...["orchestrator", "agentcore-hub-tickets", "agentcore-hub-jira", "workflow-output"].map((d) => ({
    file: `lambda/${d}/fix-contract.mjs`, contains: 'String(ticket?.assignee || "").startsWith("human:")', reason: `${HELPER}: isHumanGate`,
  })),
  { file: "src/lib/workflow/completion-evidence.ts", contains: 't.assignee.startsWith("human:")) return true;', count: 2, reason: `${HELPER}: isHumanGateTicket + owesNoDeliverable` },
  { file: "src/lib/workflow/completion-evidence.ts", contains: 'labelList(t.labels).includes("human-review")', reason: `${HELPER}: owesNoDeliverable (R1)` },
  { file: "lambda/orchestrator/completion.mjs", contains: 't.assignee.startsWith("human:")) return true;', reason: `${HELPER}: owesNoDeliverable (R1)` },
  { file: "lambda/orchestrator/completion.mjs", contains: 'labelList(t.labels).includes("human-review")', reason: `${HELPER}: owesNoDeliverable (R1)` },
  { file: "deploy/workflow-manager/toolkit/compute_metrics.py", contains: 'str(ticket.get("assignee") or "").startswith(HUMAN_PREFIX)', reason: `${HELPER}: is_human_gate` },
  { file: "deploy/workflow-manager/toolkit/compute_metrics.py", contains: 'str(assignee or "").startswith(HUMAN_PREFIX)', reason: "gate_reviewer: names WHO a gate waits on (callers already filtered by is_human_gate)" },
  { file: "lambda/orchestrator/completion.mjs", contains: "const isHuman = (a)", reason: EXEMPTION },
  { file: "src/app/api/workflow/[id]/complete/route.ts", contains: "const isHuman = (a: unknown)", count: 2, reason: `${EXEMPTION} (TS twin of completion.mjs)` },
  { file: "lambda/orchestrator/index.mjs", contains: 'assignee.startsWith("human:")', reason: "isHumanAssignee: routing (page a human vs invoke an agent), not gate classification" },
  { file: "lambda/agentcore-hub-tickets/index.mjs", contains: 'if (row.assignee.startsWith("human:")) continue;', reason: FINDER },
  { file: "lambda/agentcore-hub-tickets/index.mjs", contains: '!s.assignee.startsWith("human:")', reason: FINDER },
  { file: "lambda/agentcore-hub-jira/index.mjs", contains: 'if (row.assignee.startsWith("human:")) continue;', reason: FINDER },
  { file: "lambda/agentcore-hub-jira/index.mjs", contains: '!s.assignee.startsWith("human:")', reason: FINDER },
  { file: "lambda/workflow-output/index.mjs", contains: "const isHumanAssignee = (a)", reason: `${FINDER} (findRootTicket, plan autowire, findCdTicket)` },
  { file: "src/lib/workflow/cancel-run.ts", contains: '!String(s.assignee || "").startsWith("human:")', reason: `${FINDER} (findCdTicket port)` },
  { file: "lambda/agentcore-hub-tickets/index.mjs", contains: 'assignee.startsWith("human:")) return untouched;', count: 2, reason: `${CREATE_ARG}: autowire` },
  { file: "lambda/agentcore-hub-tickets/index.mjs", contains: "const isHumanReviewer = typeof assignee", reason: `${CREATE_ARG}: roster validation` },
  { file: "lambda/agentcore-hub-tickets/index.mjs", contains: 'String(args.assignee || "").startsWith("human:")', reason: `${CREATE_ARG}: reassign target` },
  { file: "lambda/agentcore-hub-jira/index.mjs", contains: 'assignee.startsWith("human:")) return untouched;', count: 2, reason: `${CREATE_ARG}: autowire` },
  { file: "lambda/agentcore-hub-jira/index.mjs", contains: "const isHumanReviewer = typeof assignee", reason: `${CREATE_ARG}: roster validation` },
  { file: "lambda/agentcore-hub-jira/index.mjs", contains: 'const human = typeof assignee === "string" && assignee.startsWith("human:")', reason: `${CREATE_ARG}: edit reassign` },
  { file: "lambda/agentcore-hub-jira/index.mjs", contains: '!assignee.startsWith("human:")', reason: `${CREATE_ARG}: decision-bound reassign guard on the target` },
  { file: "lambda/agentcore-hub-jira/index.mjs", contains: 'const want = assignee.startsWith("human:")', reason: `${CREATE_ARG}: assignee -> label swap on write` },
  { file: "lambda/agentcore-hub-jira/index.mjs", contains: '!assignee || assignee.startsWith("human:")) return false;', reason: "defensive check on the value sliced from an `agent:` label" },
  { file: "src/lib/workflow/intake-materialize.ts", contains: 'const isHuman = assignee.startsWith("human:")', reason: `${CREATE_ARG}: stamps the gate labels at materialize` },
  { file: "src/lib/workflow/ticket-provider-jira.ts", contains: 'input.assignee.startsWith("human:")', reason: `${CREATE_ARG}: stamps the gate labels on create` },
  { file: "src/components/workflow/WorkflowBoard.tsx", contains: '(t.assignee || "").startsWith("human:")', reason: "names WHO a gate waits on (already filtered by isHumanGateTicket)" },
];

function walk(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (/\.(m?js|tsx?|py)$/.test(e.name) && !/\.(test|spec)\.|^test_|_test\.py$/.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
}

describe("TEAM-5371: grep pin - no human-gate classification outside the helpers", () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(join(REPO, r), files);
  const hits: { file: string; line: number; text: string }[] = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((text, i) => {
      if (PIN_RE.test(text)) hits.push({ file: relative(REPO, f), line: i + 1, text: text.trim() });
    });
  }

  it("every hit is a listed helper or allowlisted site", () => {
    const unlisted = hits.filter((h) => !ALLOW.some((a) => a.file === h.file && h.text.includes(a.contains)));
    expect(unlisted, "classify through isHumanGate / isHumanGateTicket / is_human_gate, or allowlist with a reason").toEqual([]);
  });

  it("no allowlist entry is stale (each matches exactly `count` lines)", () => {
    const wrong = ALLOW.map((a) => ({ ...a, found: hits.filter((h) => h.file === a.file && h.text.includes(a.contains)).length }))
      .filter((a) => a.found !== (a.count ?? 1));
    expect(wrong).toEqual([]);
    for (const a of ALLOW) expect(a.reason.length).toBeGreaterThan(10);
  });
});
