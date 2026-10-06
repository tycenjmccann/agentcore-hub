import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The two copies of the gate contract (TEAM-4739). Only the ticket Lambdas carry
// it — it decides whether a gate ticket may CLOSE — and each ships as a
// self-contained zip, so they CANNOT share a file. The tickets copy is canonical.
import * as ticketsCopy from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";
import * as jiraCopy from "../../../lambda/agentcore-hub-jira/gate-contract.mjs";
// TEAM-5340: workflow-output carries a third copy, to verify the gate-decision record.
import * as workflowOutputCopy from "../../../lambda/workflow-output/gate-contract.mjs";
import { sameGateBinding } from "../../../lambda/agentcore-hub-tickets/fix-contract.mjs";
import { signVerifyRecord } from "../../../lambda/agentcore-hub-tickets/decision-contract.mjs";
import { mintDecisionToken } from "./decision-contract";
import { verifyGateDecisionRecord as tsVerifyGateDecisionRecord } from "./gate-decision-record";

/**
 * TEAM-4739 parity contract — same two-layer shape as fix-contract-parity.test.ts.
 *
 * A drift between these two copies is a split-brain about *whether a human
 * approved a production deploy*: an install on DynamoDB tickets would refuse a
 * gate close that the same install on Jira would admit (or worse, the reverse).
 * Both layers are deliberate:
 *   1. byte-equality of the files (what check-fix-kinds-parity.sh §1b also does,
 *      repeated here so `npm run test:unit` alone catches a stale `cp`);
 *   2. a behavioural matrix pushed through BOTH imports — so an edit that keeps
 *      the files equal but breaks a contract still fails on an assertion.
 */

const COPIES = [
  "lambda/agentcore-hub-tickets/gate-contract.mjs",
  "lambda/agentcore-hub-jira/gate-contract.mjs",
  "lambda/workflow-output/gate-contract.mjs",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODULES: Array<[string, any]> = [
  ["tickets", ticketsCopy],
  ["jira", jiraCopy],
  ["workflow-output", workflowOutputCopy],
];

/** Run `fn` through both copies and assert the results are identical. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function agree(label: string, fn: (m: any) => unknown): unknown {
  const [[, first]] = MODULES;
  const expected = fn(first);
  for (const [name, mod] of MODULES.slice(1)) {
    expect(fn(mod), `${name} disagrees with tickets on: ${label}`).toEqual(expected);
  }
  return expected;
}

describe("gate-contract.mjs — the three copies are byte-identical", () => {
  it("the jira and workflow-output copies match the tickets copy, byte for byte", () => {
    const root = resolve(__dirname, "../../..");
    const [firstPath, ...rest] = COPIES;
    const first = readFileSync(resolve(root, firstPath));
    expect(first.length).toBeGreaterThan(0);
    for (const p of rest) {
      const other = readFileSync(resolve(root, p));
      expect(
        other.equals(first),
        `${p} has drifted from ${firstPath} — edit the TICKETS copy, then \`cp\` it over`
      ).toBe(true);
    }
  });

  it("carries no local import other than the shared gate-kind grammar", () => {
    // The module does I/O, so unlike fix-contract.mjs it is not import-free. What
    // it must NOT grow is a second local dependency: every extra ./x.mjs has to be
    // packed into EVERY zip that carries this module (and would need its own cmp pair).
    // decision-contract.mjs (TEAM-5322) is the one sanctioned addition: it is
    // import-free, packed into every such zip and cmp-checked by check-fix-kinds-parity.sh.
    const src = readFileSync(resolve(__dirname, "../../..", COPIES[0]), "utf8");
    const locals = [...new Set([...src.matchAll(/from\s+"(\.\/[\w.-]+\.mjs)"/g)].map((m) => m[1]))].sort();
    expect(locals).toEqual(["./decision-contract.mjs", "./fix-contract.mjs"]);
  });
});

describe("gateHeadOf / gateExecOf — one binding, both label spellings", () => {
  const SHA = "a".repeat(40);
  const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it.each([
    ["colon", [`head:${SHA}`, `exec:${UUID}`]],
    ["hyphen (post-sanitizeUserLabels)", [`head-${SHA}`, `exec-${UUID}`]],
    ["mixed", [`head-${SHA}`, `exec:${UUID}`]],
    ["upper case", [`HEAD:${SHA.toUpperCase()}`, `EXEC:${UUID.toUpperCase()}`]],
  ])("reads both bindings from %s labels", (label, labels) => {
    expect(agree(`head ${label}`, (m) => m.gateHeadOf(labels))).toBe(SHA);
    expect(agree(`exec ${label}`, (m) => m.gateExecOf(labels))).toBe(UUID);
  });

  it("is null when unbound, and never confuses one binding for the other", () => {
    expect(agree("no labels", (m) => m.gateHeadOf([]))).toBeNull();
    expect(agree("no labels exec", (m) => m.gateExecOf(undefined))).toBeNull();
    expect(agree("only exec", (m) => m.gateHeadOf([`exec:${UUID}`]))).toBeNull();
    expect(agree("only head", (m) => m.gateExecOf([`head:${SHA}`]))).toBeNull();
    // A short SHA is not a head binding: the guard must not "verify" a gate
    // against a SHA it cannot compare to CI's 40-hex commit id.
    expect(agree("short sha", (m) => m.gateHeadOf(["head:a1b2c3d"]))).toBeNull();
    expect(agree("not hex", (m) => m.gateHeadOf([`head:${"z".repeat(40)}`]))).toBeNull();
    expect(agree("truncated uuid", (m) => m.gateExecOf(["exec:0f8fad5b-d9cb"]))).toBeNull();
  });

  it("takes the FIRST binding when a ticket carries two (deterministic, not last)", () => {
    const b = "b".repeat(40);
    expect(agree("two heads", (m) => m.gateHeadOf([`head:${SHA}`, `head:${b}`]))).toBe(SHA);
  });

  it("tolerates a comma-joined label string, like the bridge's reader", () => {
    expect(agree("string form", (m) => m.gateHeadOf(`gate:deploy-approval, head:${SHA}`))).toBe(SHA);
  });

  it("MERGE_GATE_LABEL_RE matches both spellings and nothing adjacent", () => {
    const re = agree("merge gate re", (m) => m.MERGE_GATE_LABEL_RE) as RegExp;
    expect(re.test("gate:merge-approval")).toBe(true);
    expect(re.test("gate-merge-approval")).toBe(true);
    expect(re.test("gate:merge-approval-2")).toBe(false);
    expect(re.test("gate:deploy-approval")).toBe(false);
  });
});

describe("parseFixDecision — advisory, fail-closed, last-wins", () => {
  const CASES: Array<[string, unknown, string | null]> = [
    ["a bare decision line", "DECISION: repaired", "repaired"],
    ["lower case + trailing period", "decision: abort.", "abort"],
    ["a bulleted, bolded line", "- **DECISION: accept-proxy**", "accept-proxy"],
    ["last one wins", "DECISION: abort\nDECISION: repaired", "repaired"],
    ["an unknown option", "DECISION: ship-it-anyway", null],
    ["a review-cap option (a DIFFERENT vocabulary)", "DECISION: continue", null],
    ["buried in a sentence", "I think DECISION: abort is right", null],
    ["prose approval", "looks fine to me, go ahead", null],
    ["a QUOTED decision (the options echoed back)", "> DECISION: abort", null],
    ["a FENCED decision (syntax documentation)", "```\nDECISION: abort\n```", null],
    ["fenced with a language tag", "```text\nDECISION: abort\n```", null],
    ["tilde-fenced", "~~~\nDECISION: repaired\n~~~", null],
    ["a real line AFTER a fenced example", "```\nDECISION: abort\n```\nDECISION: repaired", "repaired"],
    ["a real line BEFORE a fenced example", "DECISION: repaired\n```\nDECISION: abort\n```", "repaired"],
    ["empty", "", null],
    ["nullish", null, null],
    ["non-string", 42, null],
  ];

  it.each(CASES)("agrees on %s", (label, input, expected) => {
    expect(agree(label, (m) => m.parseFixDecision(input))).toBe(expected);
  });

  it("the option vocabulary itself agrees", () => {
    expect(agree("FIX_DECISIONS", (m) => m.FIX_DECISIONS)).toEqual([
      "repaired",
      "accept-proxy",
      "abort",
    ]);
  });
});

describe("consoleApprovalUrl", () => {
  it("builds the same link in both copies", () => {
    expect(
      agree("bound", (m) =>
        m.consoleApprovalUrl({ pipeline: "hub-agentcore-hub-deploy", region: "us-east-1" })
      )
    ).toBe(
      "https://console.aws.amazon.com/codesuite/codepipeline/pipelines/hub-agentcore-hub-deploy/view?region=us-east-1"
    );
  });

  it("escapes the pipeline name and ignores stage/action", () => {
    const url = agree("odd name", (m) =>
      m.consoleApprovalUrl(
        { pipeline: "hub-a b-deploy", region: "eu-west-2" },
        { stage: "Deploy", action: "Approve Deploy" }
      )
    ) as string;
    expect(url).toContain("pipelines/hub-a%20b-deploy/view");
    expect(url).toContain("region=eu-west-2");
    expect(url).not.toContain("Approve");
  });

  it("is empty — not a broken link — when the gate is not bound to a pipeline", () => {
    expect(agree("unbound", (m) => m.consoleApprovalUrl({ region: "us-east-1" }))).toBe("");
    expect(agree("no args", (m) => m.consoleApprovalUrl())).toBe("");
    expect(agree("blank", (m) => m.consoleApprovalUrl({ pipeline: "  " }))).toBe("");
  });
});

describe("gateLoopVerdict — the second gate of a kind against one target", () => {
  const SHA = "c".repeat(40);
  const prior = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    labels: ["gate:ci-unavailable", `head:${SHA}`],
    ...extra,
  });

  it("admits the first, refuses the second (FR-2 — one prior IS the loop)", () => {
    const opts = { gateKind: "ci-unavailable", head: SHA };
    expect(agree("none", (m) => m.gateLoopVerdict([], opts))).toEqual({
      loop: false,
      priorCount: 0,
      priors: [],
      reason: null,
    });
    expect(agree("one prior", (m) => m.gateLoopVerdict([prior("T-1")], opts))).toEqual({
      loop: true,
      priorCount: 1,
      priors: ["T-1"],
      reason: "gate_loop_environmental",
    });
    expect(agree("two priors", (m) => m.gateLoopVerdict([prior("T-1"), prior("T-2")], opts))).toEqual(
      { loop: true, priorCount: 2, priors: ["T-1", "T-2"], reason: "gate_loop_environmental" }
    );
  });

  it("matches priors on a shared blocked_by target when there is no head", () => {
    const siblings = [
      { key: "T-1", labels: ["gate-blocker"], blockedBy: ["T-9"] },
      { key: "T-2", labels: ["gate:blocker"], blockedBy: "T-9, T-8" },
    ];
    expect(
      agree("shared blocker", (m) =>
        m.gateLoopVerdict(siblings, { gateKind: "blocker", blockedBy: ["T-9"] })
      )
    ).toEqual({ loop: true, priorCount: 2, priors: ["T-1", "T-2"], reason: "gate_loop_environmental" });
  });

  it("does not count a different kind, a different target, or a non-gate sibling", () => {
    const siblings = [
      prior("T-1", { labels: ["gate:deploy-approval", `head:${SHA}`] }), // other kind
      prior("T-2", { labels: ["gate:ci-unavailable", `head:${"d".repeat(40)}`] }), // other head
      { id: "T-3", labels: ["needs-docs"] }, // not a gate at all
      { id: "T-4" }, // no labels
      null,
    ];
    expect(
      agree("no match", (m) =>
        m.gateLoopVerdict(siblings, { gateKind: "ci-unavailable", head: SHA })
      )
    ).toEqual({ loop: false, priorCount: 0, priors: [], reason: null });
  });

  it("parent + kind alone is NEVER a loop (TEAM-4986)", () => {
    // This used to count as the loop: neither side carried a binding, so the kind
    // alone under one epic was the whole match. That is what refused a legitimate
    // deploy-approval gate for a SECOND pipeline execution under one Bug parent —
    // serial CD follow-ups are different targets, not a re-file of the same one.
    const untargeted = [{ id: "T-1", labels: ["gate:blocker"] }, { id: "T-2", labels: ["gate-blocker"] }];
    expect(agree("both unbound", (m) => m.gateLoopVerdict(untargeted, { gateKind: "blocker" })))
      .toMatchObject({ loop: false, priorCount: 0 });
    // The NEW ticket names a target, the priors do not: not the same gate.
    expect(
      agree("new one targeted", (m) =>
        m.gateLoopVerdict(untargeted, { gateKind: "blocker", blockedBy: ["T-9"] })
      )
    ).toMatchObject({ loop: false, priorCount: 0 });
  });

  it("is inert for a kind that is not a gate kind, and for junk input", () => {
    const siblings = [prior("T-1"), prior("T-2")];
    expect(agree("unknown kind", (m) => m.gateLoopVerdict(siblings, { gateKind: "nope" }))).toEqual({
      loop: false,
      priorCount: 0,
      priors: [],
      reason: null,
    });
    expect(agree("no opts", (m) => m.gateLoopVerdict(siblings))).toMatchObject({ loop: false });
    expect(agree("no siblings", (m) => m.gateLoopVerdict(undefined, { gateKind: "blocker" }))).toMatchObject({
      loop: false,
    });
  });

  it("the threshold itself agrees (the 2nd attempt refuses)", () => {
    expect(agree("GATE_LOOP_THRESHOLD", (m) => m.GATE_LOOP_THRESHOLD)).toBe(1);
  });
});

/**
 * TEAM-4986 — the binding that makes two deploy gates the SAME gate.
 *
 * A `gate:deploy-approval` ticket carries no `head:` and usually no `blocked_by`, so
 * under the old three-way match ("same head, or overlapping blocked_by, or — when
 * neither side carries either — the kind alone") every deploy gate under one epic
 * matched every other one. On run wf_bug_TEAM-4798 that refused the gate for
 * execution 7bb31573… against a DONE gate for execution c33ac06f…, and labelled the
 * epic `gate:loop-broken`. Serial CD follow-ups under one parent each legitimately
 * need their own deploy-approval gate.
 *
 * The rule: one OPEN sibling carrying the SAME `exec:<id>`, and nothing else.
 */
describe("gateLoopVerdict — a deploy gate is keyed on exec:<id> (TEAM-4986)", () => {
  const EXEC_A = "c33ac06f-b684-4d0a-b486-d8f812020022";
  const EXEC_B = "7bb31573-3917-49aa-898e-c132c9bc5ad6";
  const SHA = "e".repeat(40);
  /** A deploy gate as the row actually holds it (sanitizeUserLabels' hyphen form). */
  const gate = (id: string, exec: string, status: string, extra: string[] = []) => ({
    id,
    status,
    labels: ["gate-deploy-approval", "pipeline-hub-juno-deploy", `exec-${exec}`, ...extra],
  });
  const ask = (exec: string | undefined, extra: Record<string, unknown> = {}) => ({
    gateKind: "deploy-approval",
    ...(exec ? { execId: exec } : {}),
    ...extra,
  });

  it("a DONE gate for exec A is not the prior of a request for exec B", () => {
    expect(
      agree("done A vs new B", (m) => m.gateLoopVerdict([gate("TEAM-4979", EXEC_A, "done")], ask(EXEC_B)))
    ).toEqual({ loop: false, priorCount: 0, priors: [], reason: null });
  });

  it("an OPEN gate for exec A is not the prior of a request for exec B", () => {
    expect(
      agree("open A vs new B", (m) =>
        m.gateLoopVerdict([gate("TEAM-4979", EXEC_A, "in_review")], ask(EXEC_B))
      )
    ).toEqual({ loop: false, priorCount: 0, priors: [], reason: null });
  });

  it("an OPEN gate for exec A IS the prior of a request for exec A", () => {
    expect(
      agree("open A vs new A", (m) =>
        m.gateLoopVerdict([gate("TEAM-4979", EXEC_A, "in_review")], ask(EXEC_A))
      )
    ).toEqual({
      loop: true,
      priorCount: 1,
      priors: ["TEAM-4979"],
      reason: "gate_loop_environmental",
    });
  });

  it("a DONE gate for exec A is not a loop even for a request for exec A", () => {
    // A gate that has been ANSWERED is not a gate that is still being asked. The
    // remedy the refusal names ("work the existing ticket") does not exist for a
    // closed ticket, so refusing here can only wedge the run.
    expect(
      agree("done A vs new A", (m) =>
        m.gateLoopVerdict([gate("TEAM-4979", EXEC_A, "done")], ask(EXEC_A))
      )
    ).toEqual({ loop: false, priorCount: 0, priors: [], reason: null });
  });

  it("never head, never blocked_by, never kind alone", () => {
    const siblings = [
      // Same head AND an overlapping blocked_by, but a different execution.
      gate("TEAM-1", EXEC_A, "in_review", [`head-${SHA}`]),
      // No exec binding at all: unmatchable, not a wildcard.
      { id: "TEAM-2", status: "in_review", labels: ["gate-deploy-approval"], blockedBy: ["TEAM-500"] },
    ];
    expect(
      agree("other bindings are not the exec", (m) =>
        m.gateLoopVerdict(siblings, ask(EXEC_B, { head: SHA, blockedBy: ["TEAM-500"] }))
      )
    ).toEqual({ loop: false, priorCount: 0, priors: [], reason: null });
  });

  it("a request with NO exec binding counts nothing", () => {
    // The loop seam runs before gateShapeRefusal, which is what refuses an unbound
    // deploy gate a moment later. Until then there is no target to compare, so there
    // is no prior — an absent binding must not match everything.
    expect(
      agree("unbound request", (m) =>
        m.gateLoopVerdict([gate("TEAM-4979", EXEC_A, "in_review")], ask(undefined))
      )
    ).toEqual({ loop: false, priorCount: 0, priors: [], reason: null });
  });

  it("the exec binding is read in both label spellings and case-insensitively", () => {
    for (const label of [`exec:${EXEC_A}`, `exec-${EXEC_A}`, `EXEC:${EXEC_A.toUpperCase()}`]) {
      expect(
        agree(`spelling ${label}`, (m) =>
          m.gateLoopVerdict(
            [{ id: "TEAM-4979", status: "in_review", labels: ["gate:deploy-approval", label] }],
            ask(EXEC_A)
          )
        ),
        label
      ).toMatchObject({ loop: true, priors: ["TEAM-4979"] });
    }
  });
});

describe("gateLoopVerdict delegates the binding to sameGateBinding (TEAM-4989)", () => {
  const SHA_A = "1".repeat(40);
  const SHA_B = "2".repeat(40);
  const EXEC_A = "c33ac06f-b684-4d0a-b486-d8f812020022";
  const EXEC_B = "7bb31573-3917-49aa-898e-c132c9bc5ad6";

  // (kind, the NEW ticket's row, the OPEN sibling's bindings)
  const ROWS: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["deploy-approval", { labels: [`exec:${EXEC_A}`] }, { labels: [`exec-${EXEC_A}`] }],
    ["deploy-approval", { labels: [`exec:${EXEC_A}`] }, { labels: [`exec-${EXEC_B}`] }],
    ["deploy-approval", { labels: [] }, { labels: [`exec-${EXEC_A}`] }],
    // deploy-approval is keyed on the exec ALONE: a shared head + blocked_by is not it.
    [
      "deploy-approval",
      { labels: [`exec:${EXEC_A}`], blockedBy: ["T-9"] },
      { labels: [`exec-${EXEC_B}`, `head-${SHA_A}`], blockedBy: ["T-9"] },
    ],
    ["ci-unavailable", { labels: [`head:${SHA_A}`] }, { labels: [`head-${SHA_A}`] }],
    ["ci-unavailable", { labels: [`head:${SHA_A}`] }, { labels: [`head-${SHA_B}`] }],
    ["blocker", { blockedBy: ["T-9", "T-8"] }, { blockedBy: "T-8" }],
    ["blocker", { blockedBy: ["T-9"] }, { blockedBy: ["T-7"] }],
    ["blocker", {}, {}],
  ];

  it.each(ROWS)("%s — counts a prior exactly when sameGateBinding says bound", (kind, self, sib) => {
    const sibling = {
      id: "T-1",
      status: "in_review",
      labels: [`gate:${kind}`, ...((sib.labels as string[]) ?? [])],
      ...(sib.blockedBy ? { blockedBy: sib.blockedBy } : {}),
    };
    const bound = sameGateBinding(kind, self, sibling);
    // The point of the row: NOT a hand-copied expectation, but agreement with the
    // other half of the rule. A second spelling of the binding cannot pass this.
    const verdict = agree(`${kind} ${JSON.stringify(sib)}`, (m) =>
      m.gateLoopVerdict([sibling], { gateKind: kind, labels: self.labels, blockedBy: self.blockedBy })
    ) as { loop: boolean; priors: string[] };
    expect(verdict.loop, `delegation drifted for ${kind}`).toBe(bound);
    expect(verdict.priors).toEqual(bound ? ["T-1"] : []);
  });

  it("still reads bare head/execId opts as the bindings they were read from", () => {
    // Both twins passed these as strings before TEAM-4989 and the TEAM-4986 rows above
    // still do, so the back-compat spelling must hit the identical rule.
    const sib = { id: "T-1", status: "in_review", labels: ["gate-ci-unavailable", `head-${SHA_A}`] };
    expect(
      agree("bare head hit", (m) => m.gateLoopVerdict([sib], { gateKind: "ci-unavailable", head: SHA_A }))
    ).toMatchObject({ loop: true, priors: ["T-1"] });
    expect(
      agree("bare head miss", (m) => m.gateLoopVerdict([sib], { gateKind: "ci-unavailable", head: SHA_B }))
    ).toMatchObject({ loop: false, priorCount: 0 });
  });
});

describe("isSettledGateStatus — an answered gate is never a prior (TEAM-4986)", () => {
  it("the settled set agrees, and is the four terminal spellings", () => {
    expect(agree("GATE_SETTLED_STATUSES", (m) => m.GATE_SETTLED_STATUSES)).toEqual([
      "done",
      "closed",
      "skipped",
      "cancelled",
    ]);
  });

  it.each(["done", "closed", "skipped", "cancelled", "Done", " done ", "CANCELLED"])(
    "%j is settled",
    (status) => {
      expect(agree(`settled ${status}`, (m) => m.isSettledGateStatus(status))).toBe(true);
    }
  );

  it.each(["", "todo", "ready", "in_progress", "in_review", "blocked", "doneish"])(
    "%j is NOT settled",
    (status) => {
      expect(agree(`open ${status}`, (m) => m.isSettledGateStatus(status))).toBe(false);
    }
  );

  it("junk is not settled (a status we cannot read is not an answered gate)", () => {
    for (const junk of [undefined, null, 0, {}, []]) {
      expect(agree(`junk ${JSON.stringify(junk)}`, (m) => m.isSettledGateStatus(junk))).toBe(false);
    }
  });

  it("excludes a settled sibling for EVERY kind, not just deploy-approval", () => {
    const head = "f".repeat(40);
    const done = [{ id: "T-1", status: "done", labels: ["gate-ci-unavailable", `head-${head}`] }];
    expect(
      agree("done ci sibling", (m) => m.gateLoopVerdict(done, { gateKind: "ci-unavailable", head }))
    ).toMatchObject({ loop: false, priorCount: 0 });
    const doneBlocker = [{ id: "T-1", status: "closed", labels: ["gate-blocker"], blockedBy: ["T-9"] }];
    expect(
      agree("closed blocker sibling", (m) =>
        m.gateLoopVerdict(doneBlocker, { gateKind: "blocker", blockedBy: ["T-9"] })
      )
    ).toMatchObject({ loop: false, priorCount: 0 });
  });
});

describe("gateVerificationSlots — which stamps a close replaces (TEAM-4750 B2)", () => {
  // Each twin removes the contradictory stamp in its own idiom (one conditional
  // UpdateCommand vs one transitions POST), so the DECISION has to be shared or the
  // two drift into disagreeing about what a closed gate carries.
  const BASE = ["gate:blocker", "pipeline:hub-x-deploy"];

  it("splits same from opposite, in either spelling", () => {
    expect(agree("slots: colon opposite", (m) => m.gateVerificationSlots([...BASE, "gateverify:indeterminate"], "verified"))).toEqual({
      stamp: "gateverify:verified",
      same: [],
      opposite: [2],
    });
    expect(agree("slots: hyphen opposite", (m) => m.gateVerificationSlots([...BASE, "gateverify-indeterminate"], "verified"))).toEqual({
      stamp: "gateverify:verified",
      same: [],
      opposite: [2],
    });
    expect(agree("slots: both present", (m) =>
      m.gateVerificationSlots(["gateverify:verified", ...BASE, "gateverify:indeterminate"], "verified")
    )).toEqual({ stamp: "gateverify:verified", same: [0], opposite: [3] });
  });

  it("classifies NOTHING when the caller has no verdict of its own", () => {
    // The fail-safe direction for a label mutation: no stamp to write ⇒ no stamp is
    // deleted. A caller with a junk result must not go pruning the audit trail.
    expect(agree("slots: junk result", (m) =>
      m.gateVerificationSlots([...BASE, "gateverify:verified", "gateverify:indeterminate"], "bogus")
    )).toEqual({ stamp: "", same: [], opposite: [] });
  });

  it("tolerates junk input the way every other reader here does", () => {
    expect(agree("slots: junk labels", (m) => m.gateVerificationSlots(null, "verified"))).toEqual({
      stamp: "gateverify:verified",
      same: [],
      opposite: [],
    });
    expect(agree("slots: sparse labels", (m) => m.gateVerificationSlots([null, undefined, " GATEVERIFY:VERIFIED "], "verified"))).toEqual({
      stamp: "gateverify:verified",
      same: [2],
      opposite: [],
    });
  });
});

describe("the pipeline label cap agrees (TEAM-4750 B3)", () => {
  const name = (len: number) => "h" + "u".repeat(len - 1);

  it("both copies cap the regex and the name at the same value", () => {
    expect(agree("MAX_PIPELINE_NAME", (m) => m.MAX_PIPELINE_NAME)).toBe(55);
    expect(agree("PIPELINE_LABEL_PREFIX", (m) => m.PIPELINE_LABEL_PREFIX)).toBe("pipeline:");
    expect(agree("PIPELINE_LABEL_RE source", (m) => m.PIPELINE_LABEL_RE.source)).toBe(
      "^pipeline[:-]([a-z0-9][a-z0-9._-]{0,54})$"
    );
  });

  it("finds the same offending RAW label, before any truncation", () => {
    const over = `pipeline:${name(56)}`;
    expect(agree("overflow: found", (m) => m.pipelineLabelOverflow(["gate:deploy-approval", over]))).toBe(
      over
    );
    expect(agree("overflow: hyphen spelling", (m) => m.pipelineLabelOverflow([`pipeline-${name(56)}`]))).toBe(
      `pipeline-${name(56)}`
    );
    // Exactly at the cap is fine — that is the whole point of naming the number.
    expect(agree("overflow: at the cap", (m) => m.pipelineLabelOverflow([`pipeline:${name(55)}`]))).toBeNull();
    expect(agree("overflow: none", (m) => m.pipelineLabelOverflow(["gate:blocker"]))).toBeNull();
    expect(agree("overflow: junk", (m) => m.pipelineLabelOverflow(null))).toBeNull();
    // A long label in another namespace is somebody else's problem (sanitizeUserLabels
    // truncates it and no reader forwards it to a probe).
    expect(agree("overflow: other namespace", (m) => m.pipelineLabelOverflow([`wf:${name(90)}`]))).toBeNull();
  });

  it("refuses in the same words, naming both limits", () => {
    const over = `pipeline:${name(56)}`;
    const refusal = agree("refusal", (m) => m.pipelineLabelRefusal(over)) as {
      ok: boolean;
      reason: string;
      hint: string;
    };
    expect(refusal.ok).toBe(false);
    expect(refusal.reason).toBe(agree("GATE_CONDITION_UNMET", (m) => m.GATE_CONDITION_UNMET));
    // Both numbers, so an agent can act on it instead of guessing at "too long".
    expect(refusal.hint).toContain("64");
    expect(refusal.hint).toContain("55");
    expect(refusal.hint).toContain("TRUNCATED");
  });
});

describe("gateShapeRefusal — the create-time bindings both twins demand (TEAM-4764)", () => {
  const SHA = "a".repeat(40);
  const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const PIPE = "hub-x-deploy";
  const hintOf = (label: string, labels: unknown) =>
    (agree(label, (m) => m.gateShapeRefusal(labels)) as { hint: string } | null)?.hint ?? null;

  // A ci-unavailable gate whose close nobody can probe is admitted unproven by
  // verifyGateCondition (indeterminate/gate_unbound) — so the bindings are demanded
  // at create time, in the same words from both copies.
  it("demands exactly one pipeline: label on a ci-unavailable gate", () => {
    expect(hintOf("ci: no pipeline", ["gate:ci-unavailable", `head:${SHA}`])).toBe(
      "a ci-unavailable gate must carry exactly one `pipeline:<name>` label (found 0) — " +
        "without it the close guard has nothing to probe and admits the gate unproven (indeterminate/gate_unbound)"
    );
    expect(hintOf("ci: two pipelines", ["gate:ci-unavailable", `pipeline:${PIPE}`, "pipeline:hub-y-deploy", `head:${SHA}`]))
      .toContain("`pipeline:<name>` label (found 2)");
  });

  it("demands exactly one 40-hex head: label on a ci-unavailable gate", () => {
    const expected =
      "a ci-unavailable gate must carry exactly one `head:<sha>` label whose value is exactly 40 hex chars " +
      "(found 1) — without it the close guard has nothing to probe and admits the gate " +
      "unproven (indeterminate/gate_unbound)";
    // 41 hex is the LIVE disarm: HEAD_LABEL_RE is anchored, so gateHeadOf is null
    // while the label still looks like a binding to a human reading the ticket.
    expect(hintOf("ci: 41 hex", ["gate:ci-unavailable", `pipeline:${PIPE}`, `head:${"a".repeat(41)}`])).toBe(expected);
    expect(hintOf("ci: no head", ["gate:ci-unavailable", `pipeline:${PIPE}`])).toContain("(found 0)");
    expect(hintOf("ci: two heads", ["gate:ci-unavailable", `pipeline:${PIPE}`, `head:${SHA}`, `head:${"c".repeat(40)}`]))
      .toContain("(found 2)");
  });

  it("accepts a bound ci-unavailable gate in either spelling or case", () => {
    expect(hintOf("ci: bound", ["gate:ci-unavailable", `pipeline:${PIPE}`, `head:${SHA}`])).toBeNull();
    // Post-sanitizeUserLabels hyphen spelling, and upper-case hex, read the same.
    expect(hintOf("ci: hyphen", ["gate-ci-unavailable", `pipeline-${PIPE}`, `head-${SHA}`])).toBeNull();
    expect(hintOf("ci: upper hex", ["gate:ci-unavailable", `pipeline:${PIPE}`, `HEAD:${SHA.toUpperCase()}`])).toBeNull();
  });

  it("keeps the deploy-approval words and order unchanged", () => {
    expect(hintOf("deploy: no exec", ["gate:deploy-approval", `pipeline:${PIPE}`])).toBe(
      "a deploy-approval gate must carry exactly one `exec:<execution-id>` label (found 0) — " +
        "without it nobody can tell which pipeline execution the human is being asked about"
    );
    expect(hintOf("deploy: no pipeline", ["gate:deploy-approval", `exec:${UUID}`])).toBe(
      "a deploy-approval gate must carry exactly one `pipeline:<name>` label (found 0) — " +
        "without it the gate cannot be verified or linked to a console"
    );
    // exec is reported first when BOTH are missing — the order agents have learned.
    expect(hintOf("deploy: neither", ["gate:deploy-approval"])).toContain("`exec:<execution-id>`");
    expect(hintOf("deploy: bound", ["gate:deploy-approval", `pipeline:${PIPE}`, `exec:${UUID}`])).toBeNull();
  });

  it("says nothing about a kind with no create-time binding, or a non-gate", () => {
    for (const labels of [["gate:approval"], ["gate:blocker"], ["gate:merge-approval"], ["needs-docs"], [], null]) {
      expect(hintOf(`inert: ${JSON.stringify(labels)}`, labels)).toBeNull();
    }
  });

  it("evaluates BOTH kinds on a ticket that carries two, deploy-approval first", () => {
    // probedGateKindOf picks exactly one kind; this check deliberately does not use
    // it, so a second kind on the same ticket cannot slip past unbound.
    expect(hintOf("both: deploy wins", ["gate:deploy-approval", "gate:ci-unavailable", `head:${SHA}`]))
      .toContain("`exec:<execution-id>`");
    expect(
      hintOf("both: ci still checked", [
        "gate:deploy-approval",
        "gate:ci-unavailable",
        `pipeline:${PIPE}`,
        `exec:${UUID}`,
      ])
    ).toContain("`head:<sha>`");
  });
});

describe("the probe's shape agrees", () => {
  it("PROBE_TOOLS contains exactly four read-only tools, the same in both copies", () => {
    // verify_postcondition (TEAM-5322 FR-10) is read-only by construction: it
    // projects a fixed set of observed fields and never writes (pipeline-tools).
    expect(agree("PROBE_TOOLS", (m) => m.PROBE_TOOLS)).toEqual([
      "Pipeline___get_state",
      "Pipeline___get_build_status",
      "Pipeline___capabilities",
      "Pipeline___verify_postcondition",
    ]);
    // Nothing that could trigger or approve CD may be reachable from ticket data.
    for (const [name, mod] of MODULES) {
      for (const tool of mod.PROBE_TOOLS) {
        expect(tool, `${name} allows a write tool`).not.toMatch(/deploy|approve|build_start|start_/i);
      }
    }
  });

  it("the timeout and the journey-event ttl agree", () => {
    expect(agree("PROBE_TIMEOUT_MS", (m) => m.PROBE_TIMEOUT_MS)).toBe(4000);
    expect(agree("JOURNEY_EVENT_TTL_SEC", (m) => m.JOURNEY_EVENT_TTL_SEC)).toBe(90 * 24 * 60 * 60);
  });

  it("a disallowed tool is refused identically, with no probe attempted", async () => {
    for (const [name, mod] of MODULES) {
      const res = await mod.invokeProbe("some-fn", "Pipeline___start_deploy", {});
      expect(res, `${name} did not refuse a disallowed tool`).toEqual({
        ok: false,
        indeterminate: true,
        error: "tool_not_allowed",
      });
    }
  });

  it("an unconfigured probe is indeterminate, never a verdict", async () => {
    for (const [name, mod] of MODULES) {
      const res = await mod.invokeProbe("", "Pipeline___get_state", { pipeline_name: "p" });
      expect(res, `${name} on an unset PIPELINE_TOOLS_LAMBDA`).toEqual({
        ok: false,
        indeterminate: true,
        error: "probe_not_configured",
      });
    }
  });
});

describe("publishJourneyEvent — best effort, ttl'd, never throws", () => {
  it("writes one row with the 90-day ttl and the events-table key shape", async () => {
    for (const [name, mod] of MODULES) {
      const sent: Array<Record<string, unknown>> = [];
      const ddb = { send: async (cmd: { input: Record<string, unknown> }) => sent.push(cmd.input) };
      const before = Math.floor(Date.now() / 1000);
      const ok = await mod.publishJourneyEvent(ddb, "events-table", "wf_1", "gate.repaged", {
        ticketId: "T-1",
      });
      expect(ok, name).toBe(true);
      expect(sent).toHaveLength(1);
      const item = sent[0].Item as Record<string, unknown>;
      expect(sent[0].TableName).toBe("events-table");
      expect(item.workflowId).toBe("wf_1");
      expect(item.type).toBe("gate.repaged");
      expect(item.detail).toEqual({ ticketId: "T-1" });
      expect(typeof item.eventId).toBe("string");
      expect(String(item.eventId)).toMatch(/^\d+-[a-z0-9]{1,4}$/);
      expect(Date.parse(String(item.timestamp))).not.toBeNaN();
      expect(item.ttl as number).toBeGreaterThanOrEqual(before + 90 * 24 * 60 * 60);
    }
  });

  it("swallows a write failure — a correct refusal must not become a tool error", async () => {
    for (const [name, mod] of MODULES) {
      const ddb = {
        send: async () => {
          throw new Error("ProvisionedThroughputExceeded");
        },
      };
      await expect(
        mod.publishJourneyEvent(ddb, "events-table", "wf_1", "gate.repaged", {}),
        name
      ).resolves.toBe(false);
    }
  });

  it("is a no-op without a table, a workflow id or a type (SEC-16: no caller-chosen run)", async () => {
    for (const [, mod] of MODULES) {
      const ddb = {
        send: async () => {
          throw new Error("should not be called");
        },
      };
      expect(await mod.publishJourneyEvent(ddb, "", "wf_1", "gate.repaged", {})).toBe(false);
      expect(await mod.publishJourneyEvent(ddb, "t", "", "gate.repaged", {})).toBe(false);
      expect(await mod.publishJourneyEvent(ddb, "t", "wf_1", "", {})).toBe(false);
      expect(await mod.publishJourneyEvent(null, "t", "wf_1", "gate.repaged", {})).toBe(false);
    }
  });
});

/**
 * TEAM-4757 R3-2 — judgeCompletionRecord, the DL-030 body verdict.
 *
 * This is the one helper in the module that FAILS CLOSED (DL-030/DL-028 positive
 * evidence), the opposite band from every gate-close verdict around it, so its
 * matrix is worth stating explicitly. What a drift here costs: one provider would
 * close a ship ticket over follow-ups the other refuses to close over, and the run
 * that closed would cascade and complete its epic over work that was never filed.
 *
 * Both twins call this through their own `completionRecordProven`, which is NOT
 * exported (it owns a per-twin S3 client) — the pure judgement is exported precisely
 * so the refusal STRINGS can be pinned from one place, here.
 */
describe("judgeCompletionRecord — the DL-030 completion-record verdict", () => {
  const KEY = "completions/TEAM-4066.json";
  const judge = (body: unknown) => agree(`judgeCompletionRecord(${JSON.stringify(body)})`,
    (m) => m.judgeCompletionRecord(KEY, body)) as { proven: boolean; why: string };

  it("refuses a record whose follow-ups are still pending, and names the re-run", () => {
    const v = judge(JSON.stringify({ followUpsPending: true, status: "complete_pending_follow_ups" }));
    expect(v.proven).toBe(false);
    expect(v.why).toBe(
      `${KEY} has followUpsPending:true (status complete_pending_follow_ups) — re-run ` +
        `WorkflowOutput___report_completion with the same arguments to materialize the follow-ups`
    );
  });

  it("names the status `unstated` when the record carries followUpsPending but no status", () => {
    const v = judge(JSON.stringify({ followUpsPending: true }));
    expect(v.proven).toBe(false);
    expect(v.why).toContain("(status unstated)");
  });

  it("admits `followUpsPending !== true` — false, absent, a skip-record, a string", () => {
    // `!== true` and never `=== false`: a pre-TEAM-4756 record carries neither field,
    // sweepSkipRecord deliberately omits both, and the complete_transition_failed
    // restamp deliberately leaves followUpsPending false (the follow-ups ARE filed
    // there; only the Done write failed). Each of these must still close.
    for (const body of [
      { followUpsPending: false, status: "complete" },
      { ticketId: "TEAM-4066", summary: "shipped", pr_url: "https://example.test/pr/1" },
      { evidence_kind: "skipped", skipped: true, reason: "empty_sweep_no_siblings" },
      { evidence_kind: "skip_not_applied", skipped: false, reason: "done_transition_failed" },
      { followUpsPending: false, status: "complete_transition_failed" },
      { followUpsPending: "true" },
      { followUpsPending: 1 },
      { followUpsPending: null },
    ]) {
      const v = judge(JSON.stringify(body));
      expect(v.proven, `${JSON.stringify(body)} must be admitted`).toBe(true);
      expect(v.why).toBe(`${KEY} exists`);
    }
  });

  // ── TEAM-5348 F3: the status is an allow-list ──────────────────────────────
  // The reviewer's probe: complete_pending_event and complete_pending_sweep records
  // leave followUpsPending:false, so the `=== true` test alone admitted a record whose
  // Done the writer withheld, and a direct Tickets___transition_ticket(done) closed
  // the ship ticket over an undelivered event / an unskipped sibling.

  it("COMPLETION_STATUS, the DONE and the FINAL lists are one table in every copy (TEAM-5348 F3)", () => {
    const table = agree("COMPLETION_STATUS", (m) => m.COMPLETION_STATUS) as Record<string, string>;
    expect(table).toEqual({
      DONE: "complete",
      TRANSITION_FAILED: "complete_transition_failed",
      PENDING_FOLLOW_UPS: "complete_pending_follow_ups",
      PENDING_SWEEP: "complete_pending_sweep",
      PENDING_EVENT: "complete_pending_event",
    });
    expect(agree("DONE", (m) => [...m.COMPLETION_DONE_STATUSES])).toEqual(["complete"]);
    expect(agree("FINAL", (m) => [...m.COMPLETION_RECORD_FINAL_STATUSES])).toEqual(["complete", "complete_transition_failed"]);
    // Every pending status is neither done nor final; every value is unique.
    const values = Object.values(table);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values.filter((s) => !["complete", "complete_transition_failed"].includes(s))) {
      expect(ticketsCopy.COMPLETION_DONE_STATUSES).not.toContain(v);
      expect(ticketsCopy.COMPLETION_RECORD_FINAL_STATUSES).not.toContain(v);
    }
  });

  it("complete_pending_event and complete_pending_sweep with followUpsPending:false are REFUSED, naming the status (TEAM-5348 F3)", () => {
    for (const status of ["complete_pending_event", "complete_pending_sweep", "complete_pending_follow_ups"]) {
      const v = judge(JSON.stringify({ followUpsPending: false, status, ticketId: "TEAM-4066" }));
      expect(v.proven, `${status} must be refused`).toBe(false);
      expect(v.why).toBe(
        `${KEY} is still ${status} — Done is withheld until ` +
          `WorkflowOutput___report_completion is re-run with the same arguments and answers complete`
      );
    }
    // Every non-final status in the table, derived rather than listed, refuses.
    for (const status of Object.values(ticketsCopy.COMPLETION_STATUS as Record<string, string>)) {
      const final = (ticketsCopy.COMPLETION_RECORD_FINAL_STATUSES as readonly string[]).includes(status);
      expect(judge(JSON.stringify({ status })).proven, status).toBe(final);
    }
  });

  it("an unknown or blank status string is refused (fail closed); an absent status is still admitted (TEAM-5348 F3)", () => {
    expect(judge(JSON.stringify({ status: "complete_pending_something_new" })).proven).toBe(false);
    expect(judge(JSON.stringify({ status: "Complete" })).proven).toBe(false); // case is part of the literal
    const blank = judge(JSON.stringify({ status: "   " }));
    expect(blank.proven).toBe(false);
    expect(blank.why).toContain("is still (blank status)");
    // A status that is not a string at all is "unstated", like a pre-4756 record.
    expect(judge(JSON.stringify({ status: 7 })).proven).toBe(true);
    expect(judge(JSON.stringify({ status: null })).proven).toBe(true);
    expect(judge(JSON.stringify({ ticketId: "TEAM-4066" })).proven).toBe(true);
  });

  it("followUpsPending:true wins over a final status (both refusals name the re-run)", () => {
    const v = judge(JSON.stringify({ followUpsPending: true, status: "complete" }));
    expect(v.proven).toBe(false);
    expect(v.why).toContain("has followUpsPending:true (status complete)");
  });

  it("the pending-status refusal is BYTE-identical across the three copies (TEAM-5348 F3)", () => {
    const body = JSON.stringify({ followUpsPending: false, status: "complete_pending_event" });
    const whys = MODULES.map(([, m]) => Buffer.from(m.judgeCompletionRecord(KEY, body).why, "utf8"));
    expect(whys[0].length).toBeGreaterThan(0);
    for (const w of whys.slice(1)) expect(w.equals(whys[0]), "a copy phrases the pending-status refusal differently").toBe(true);
  });

  it("fails CLOSED on a body it cannot read as a JSON object", () => {
    for (const [body, detail] of [
      ["not json at all", "unparseable JSON"],
      ["", "an empty body"],
      ["   ", "an empty body"],
      ["[]", "parsed to an array, not an object"],
      ["null", "parsed to null, not an object"],
      ['"a string"', "parsed to string, not an object"],
      ["42", "parsed to number, not an object"],
    ] as const) {
      const v = judge(body);
      expect(v.proven, `${JSON.stringify(body)} must fail closed`).toBe(false);
      expect(v.why).toContain(`${KEY} could not be read as a completion record (${detail}`);
      expect(v.why).toContain("Re-run WorkflowOutput___report_completion");
    }
    // A non-string body (no body at all on the S3 response) is the same class.
    for (const body of [undefined, null]) {
      const v = judge(body);
      expect(v.proven).toBe(false);
      expect(v.why).toContain("(no body)");
    }
  });

  it("the pending refusal is BYTE-identical across the two copies", () => {
    // `agree` compares with toEqual; a refusal an agent reads differently on Jira
    // than on DynamoDB makes it take a different next action, so pin the bytes.
    const body = JSON.stringify({ followUpsPending: true, status: "complete_pending_follow_ups" });
    const [ticketsWhy, jiraWhy] = MODULES.map(([, m]) =>
      Buffer.from(m.judgeCompletionRecord(KEY, body).why, "utf8")
    );
    expect(ticketsWhy.length).toBeGreaterThan(0);
    expect(jiraWhy.equals(ticketsWhy), "the two copies phrase the DL-030 refusal differently").toBe(true);
  });
});

// ── TEAM-5338: decisions are single-use, workflow-bound and cycle-scoped ───────

const DKEY = "gate-contract-parity-key";
const DNOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const DOPTS = ["continue", "cancel"];
const mint = (over: Record<string, unknown> = {}) =>
  mintDecisionToken(
    { ticketId: "TEAM-G", option: "continue", channel: "hub", by: "eng@example.com", workflowId: "wf_1", now: DNOW, ...over },
    DKEY
  );
const resolveBoth = (label: string, p: Record<string, unknown>) =>
  agree(label, (m) => m.resolveDecision({ ticketId: "TEAM-G", options: DOPTS, keys: [DKEY], now: DNOW + 1000, ...p }));

describe("resolveDecision — TEAM-5338 F3/F4 bindings", () => {
  it("resolveDecision refuses a consumed nonce (the token's jti is in usedJtis)", () => {
    const token = mint({ jti: "consumed-jti-00000001" });
    const ok = resolveBoth("fresh", { args: { decision_token: token } }) as { ok: boolean; decision: { jti: string } };
    expect(ok.ok).toBe(true);
    expect(ok.decision.jti).toBe("consumed-jti-00000001");
    expect(resolveBoth("consumed", { args: { decision_token: token }, usedJtis: ["consumed-jti-00000001"] })).toEqual({
      ok: false,
      detail: "decision_token_consumed",
    });
  });

  it("a token for another workflow, or any token when the gate's workflow is unknown, is refused", () => {
    const token = mint();
    expect(resolveBoth("other wf", { args: { decision_token: token }, workflowId: "wf_2" })).toEqual({
      ok: false,
      detail: "decision_token_workflow_mismatch",
    });
    expect(resolveBoth("unknown wf", { args: { decision_token: token }, workflowId: undefined })).toEqual({
      ok: false,
      detail: "decision_token_workflow_mismatch",
    });
    expect((resolveBoth("same wf", { args: { decision_token: token }, workflowId: "wf_1" }) as { ok: boolean }).ok).toBe(true);
  });

  it("a token minted before the cycle began is stale; ignoreExpiry lets the reprobe re-resolve an old one", () => {
    const token = mint();
    expect(resolveBoth("stale", { args: { decision_token: token }, notBeforeMs: DNOW + 60_000 })).toEqual({
      ok: false,
      detail: "decision_token_stale",
    });
    const late = { args: { decision_token: token }, now: DNOW + 901_000 };
    expect(resolveBoth("expired", late)).toEqual({ ok: false, detail: "decision_token_expired" });
    expect((resolveBoth("reprobe", { ...late, ignoreExpiry: true }) as { ok: boolean }).ok).toBe(true);
  });

  it("TEAM-5347 F8: a token minted in the same second as the reset is stale (a sub-second reopen cannot keep the click)", () => {
    const token = mint(); // iat = DNOW/1000, DNOW on a second boundary
    expect(resolveBoth("reset 1 ms after the mint", { args: { decision_token: token }, notBeforeMs: DNOW + 1 })).toEqual({
      ok: false,
      detail: "decision_token_stale",
    });
    expect(resolveBoth("reset in the same ms", { args: { decision_token: token }, notBeforeMs: DNOW })).toEqual({
      ok: false,
      detail: "decision_token_stale",
    });
    expect((resolveBoth("reset the second before", { args: { decision_token: token }, notBeforeMs: DNOW - 1 }) as { ok: boolean }).ok).toBe(true);
  });

  it("a human Jira DECISION comment from before the cycle cut-off (or undated) is not an answer", () => {
    const humans = { humanAccountIds: ["acc-human"], serviceAccountId: "acc-svc" };
    const approve = { body: "DECISION: continue", authorAccountId: "acc-human", created: new Date(DNOW).toISOString() };
    const reopen = DNOW + 60_000;
    expect(resolveBoth("no cut-off", { ...humans, comments: [approve] })).toMatchObject({ ok: true, decision: { option: "continue", channel: "jira" } });
    expect(resolveBoth("before cut-off", { ...humans, comments: [approve], notBeforeMs: reopen })).toEqual({
      ok: false,
      detail: "unsigned_decision_ignored",
    });
    const undated = { body: "DECISION: cancel", authorAccountId: "acc-human" };
    expect(resolveBoth("undated", { ...humans, comments: [undated], notBeforeMs: reopen })).toEqual({
      ok: false,
      detail: "unsigned_decision_ignored",
    });
    const after = { ...approve, body: "DECISION: cancel", created: new Date(reopen + 1).toISOString() };
    expect(resolveBoth("after cut-off", { ...humans, comments: [approve, after], notBeforeMs: reopen })).toMatchObject({
      ok: true,
      decision: { option: "cancel", jti: null },
    });
    // TEAM-5347 F8: a comment created at the very millisecond of the reset is not an answer either.
    const atCutoff = { ...approve, body: "DECISION: cancel", created: new Date(reopen).toISOString() };
    expect(resolveBoth("at cut-off", { ...humans, comments: [approve, atCutoff], notBeforeMs: reopen })).toEqual({
      ok: false,
      detail: "unsigned_decision_ignored",
    });
  });
});

describe("gateCycleFromChangelog — where the current Jira decision cycle starts (TEAM-5338 F4)", () => {
  const at = (min: number) => new Date(DNOW + min * 60_000).toISOString();
  const status = (min: number, from: string, to: string) => ({ created: at(min), items: [{ field: "status", fromString: from, toString: to }] });
  const labels = (min: number, from: string, to: string) => ({ created: at(min), items: [{ field: "labels", fromString: from, toString: to }] });

  it("gateCycleFromChangelog picks the last In Review entry; label gained before it is ignored", () => {
    const histories = [
      status(0, "To Do", "In Review"),
      labels(12, "human-review gate:verifying", "human-review gate:approved-unverified"),
      status(20, "In Review", "Blocked"),
      status(25, "Blocked", "in review"),
    ];
    expect(agree("reopened", (m) => m.gateCycleFromChangelog(histories))).toEqual({
      cycleStartMs: DNOW + 25 * 60_000,
      approvedUnverifiedAtMs: null,
    });
    expect(agree("same cycle", (m) => m.gateCycleFromChangelog(histories.slice(0, 2)))).toEqual({
      cycleStartMs: DNOW,
      approvedUnverifiedAtMs: DNOW + 12 * 60_000,
    });
  });

  it("TEAM-5347 F2: a reset EXIT (out of In Review/Done to anything but Done) starts the cycle too, like the DynamoDB twin's cycleResetPlan", () => {
    // (a) In Review → Done → Blocked, never re-entering In Review: the cut-off is the
    // Done → Blocked move, so a token minted before it is stale.
    expect(agree("done→blocked", (m) => m.gateCycleFromChangelog([status(0, "To Do", "In Review"), status(10, "In Review", "Done"), status(20, "Done", "Blocked")]))).toEqual({
      cycleStartMs: DNOW + 20 * 60_000,
      approvedUnverifiedAtMs: null,
    });
    // (b) In Review → Blocked → In Review: the re-entry is newest and wins.
    expect(agree("exit then re-entry", (m) => m.gateCycleFromChangelog([status(0, "To Do", "In Review"), status(5, "In Review", "Blocked"), status(9, "Blocked", "In Review")]))).toEqual({
      cycleStartMs: DNOW + 9 * 60_000,
      approvedUnverifiedAtMs: null,
    });
    // (c) Done → In Review (reopened straight into review): one move, both an exit and an entry.
    expect(agree("done→in review", (m) => m.gateCycleFromChangelog([status(0, "To Do", "In Review"), status(10, "In Review", "Done"), status(30, "Done", "In Review")]))).toEqual({
      cycleStartMs: DNOW + 30 * 60_000,
      approvedUnverifiedAtMs: null,
    });
    // In Review → Done is a close, not a reset; a label gained after it is still this cycle's.
    expect(agree("close is not a reset", (m) => m.gateCycleFromChangelog([status(0, "To Do", "In Review"), status(10, "In Review", "Done"), labels(12, "", "gate:approved-unverified")]))).toEqual({
      cycleStartMs: DNOW,
      approvedUnverifiedAtMs: DNOW + 12 * 60_000,
    });
    // Custom status names flow through `doneNames`; a status item with no fromString (an issue created straight into a status) is only an entry.
    expect(agree("custom done name", (m) => m.gateCycleFromChangelog([status(0, "To Do", "In Review"), status(10, "In Review", "Shipped"), status(20, "Shipped", "Blocked")], { doneNames: ["Shipped"] }))).toEqual({
      cycleStartMs: DNOW + 20 * 60_000,
      approvedUnverifiedAtMs: null,
    });
    expect(agree("no fromString", (m) => m.gateCycleFromChangelog([{ created: at(3), items: [{ field: "status", toString: "Blocked" }] }]))).toEqual({
      cycleStartMs: null,
      approvedUnverifiedAtMs: null,
    });
  });

  it("TEAM-5347 F2: isCycleResetMove is the one reset predicate (the 5x5 status matrix agrees in every copy)", () => {
    const statuses = ["todo", "ready", "in_progress", "in_review", "blocked", "done"];
    const matrix = agree("matrix", (m) => statuses.map((from) => statuses.map((to) => m.isCycleResetMove(from, to))));
    const resets = (matrix as boolean[][]).flatMap((row, i) => row.map((v, j) => (v ? `${statuses[i]}→${statuses[j]}` : null)).filter(Boolean));
    expect(resets.sort()).toEqual([
      "done→blocked", "done→in_progress", "done→in_review", "done→ready", "done→todo",
      "in_review→blocked", "in_review→in_progress", "in_review→in_review", "in_review→ready", "in_review→todo",
    ].sort());
    expect(agree("case/space", (m) => m.isCycleResetMove(" In_Review ", "BLOCKED"))).toBe(true);
    expect(agree("nullish", (m) => [m.isCycleResetMove(undefined, "blocked"), m.isCycleResetMove("done", undefined)])).toEqual([false, true]);
  });

  it("no In Review entry → null start; unparseable dates and unrelated fields are ignored", () => {
    expect(
      agree("none", (m) =>
        m.gateCycleFromChangelog([
          { created: "not a date", items: [{ field: "status", toString: "In Review" }] },
          { created: at(1), items: [{ field: "summary", fromString: "a", toString: "In Review" }] },
          labels(2, "", "gate-approved-unverified"),
        ])
      )
    ).toEqual({ cycleStartMs: null, approvedUnverifiedAtMs: DNOW + 2 * 60_000 });
    expect(agree("empty", (m) => m.gateCycleFromChangelog(undefined))).toEqual({ cycleStartMs: null, approvedUnverifiedAtMs: null });
  });
});

describe("gateVerify v2 — the sig covers everything the reprobe acts on (TEAM-5338 F6)", () => {
  const PC = { kind: "lambda_version", target: "agentcore-hub-x", expect: { version: "5" } };
  const build = (m: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const token = mint({ option: "continue" });
    return m.buildGateVerify(
      { ticketId: "TEAM-G", workflowId: "wf_1", decision: { option: "continue", override: true, channel: "hub", by: "eng@example.com", token }, postCondition: PC, probe: null, now: DNOW },
      DKEY
    );
  };

  it("an untouched v2 record is authentic in both copies", () => {
    expect(agree("v2", (m) => [build(m).v, m.gateVerifyAuthentic(build(m), { ticketId: "TEAM-G", keys: [DKEY] })])).toEqual([2, true]);
  });

  it("tampering postCondition / decision.by / channel / override breaks gateVerifyAuthentic", () => {
    const tampers: Array<[string, (gv: any) => void]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["postCondition.target", (gv) => { gv.postCondition = { ...gv.postCondition, target: "agentcore-hub-y" }; }],
      ["postCondition.expect", (gv) => { gv.postCondition = { ...gv.postCondition, expect: { version: "$LATEST" } }; }],
      ["decision.by", (gv) => { gv.decision.by = "someone-else@example.com"; }],
      ["decision.channel", (gv) => { gv.decision.channel = "telegram"; }],
      ["decision.override", (gv) => { gv.decision.override = false; }],
      ["decision.option", (gv) => { gv.decision.option = "cancel"; }],
      ["workflowId", (gv) => { gv.workflowId = "wf_2"; }],
      ["verifyUntil", (gv) => { gv.verifyUntil = new Date(DNOW + 86_400_000).toISOString(); }],
    ];
    for (const [label, tamper] of tampers) {
      expect(
        agree(label, (m) => {
          const gv = build(m);
          tamper(gv);
          return m.gateVerifyAuthentic(gv, { ticketId: "TEAM-G", keys: [DKEY] });
        }),
        label
      ).toBe(false);
    }
  });

  it("key order of postCondition does not matter (canonical JSON)", () => {
    expect(
      agree("reordered", (m) => {
        const gv = build(m);
        gv.postCondition = { expect: { version: "5" }, target: "agentcore-hub-x", kind: "lambda_version" };
        return [m.gateVerifyAuthentic(gv, { ticketId: "TEAM-G", keys: [DKEY] }), m.samePostCondition(gv.postCondition, PC)];
      })
    ).toEqual([true, true]);
  });

  it("v1 record is not authentic (it fails closed; the human decides again)", () => {
    expect(
      agree("v1", (m) => {
        const gv = build(m);
        gv.v = 1;
        return m.gateVerifyAuthentic(gv, { ticketId: "TEAM-G", keys: [DKEY] });
      })
    ).toBe(false);
  });

  it("a record whose token names another actor than the record claims is not authentic", () => {
    expect(
      agree("token actor", (m) => {
        const token = mint({ by: "chat:42", channel: "telegram" });
        const gv = m.buildGateVerify(
          { ticketId: "TEAM-G", workflowId: "wf_1", decision: { option: "continue", override: true, channel: "hub", by: "eng@example.com", token }, postCondition: PC, probe: null, now: DNOW },
          DKEY
        );
        return m.gateVerifyAuthentic(gv, { ticketId: "TEAM-G", keys: [DKEY] });
      })
    ).toBe(false);
  });

  it("redactForLog is re-exported from the decision contract", () => {
    expect(agree("redact", (m) => m.redactForLog({ decision_token: mint() }))).toEqual({ decision_token: "[redacted]" });
  });
});

describe("the Jira twin's create-once ledgers — keys, error classes, comment-derived jti (TEAM-5347 F1)", () => {
  it("gateJtiLedgerKey / gateHoldActedKey live under the gate-decisions/ prefix only the twins write", () => {
    expect(agree("jti key", (m) => m.gateJtiLedgerKey("wf_1", "TEAM-G", "abcDEF0123456789"))).toBe(
      "pipeline-artifacts/gate-decisions/wf_1/jti/TEAM-G/abcDEF0123456789.json"
    );
    const acted = agree("acted key", (m) => m.gateHoldActedKey("wf_1", "TEAM-G", "sig/with+slash=")) as string;
    expect(acted).toMatch(/^pipeline-artifacts\/gate-decisions\/wf_1\/holds\/TEAM-G\/[0-9a-f]{64}\.acted\.json$/);
    expect(agree("acted key differs per sig", (m) => m.gateHoldActedKey("wf_1", "TEAM-G", "other"))).not.toBe(acted);
  });

  it("classifyConditionalPutError: 412 is lost, 409 is conflict, anything else is error", () => {
    const cases: Array<[string, unknown]> = [
      ["by name 412", { name: "PreconditionFailed" }],
      ["by status 412", { $metadata: { httpStatusCode: 412 } }],
      ["by Code 409", { Code: "ConditionalRequestConflict" }],
      ["by status 409", { $metadata: { httpStatusCode: 409 } }],
      ["access denied", { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }],
      ["nothing", undefined],
    ];
    expect(cases.map(([label, err]) => agree(label, (m) => m.classifyConditionalPutError(err)))).toEqual([
      "lost", "lost", "conflict", "conflict", "error", "error",
    ]);
  });

  it("commentDecisionJti is a pure function of (ticket, comment id, author) and satisfies DECISION_TOKEN_JTI_RE", () => {
    const a = agree("a", (m) => m.commentDecisionJti("TEAM-G", "10001", "jira:acc-1")) as string;
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(agree("same again", (m) => m.commentDecisionJti("TEAM-G", "10001", "jira:acc-1"))).toBe(a);
    expect(agree("other comment", (m) => m.commentDecisionJti("TEAM-G", "10002", "jira:acc-1"))).not.toBe(a);
    expect(agree("other ticket", (m) => m.commentDecisionJti("TEAM-H", "10001", "jira:acc-1"))).not.toBe(a);
    // The token minted from it round-trips through the verifier.
    const token = mintDecisionToken({ ticketId: "TEAM-G", option: "continue", channel: "jira", by: "jira:acc-1", workflowId: "wf_1", jti: a }, DKEY);
    expect(agree("round-trip", (m) => m.resolveDecision({ ticketId: "TEAM-G", args: { decision_token: token }, options: ["continue"], keys: [DKEY], workflowId: "wf_1" }))).toMatchObject({
      ok: true,
      decision: { jti: a },
    });
  });

  it("a comment decision carries the comment id so the twin can derive that jti", () => {
    const humans = { humanAccountIds: ["acc-human"], serviceAccountId: "acc-svc" };
    const approve = { id: "777", body: "DECISION: continue", authorAccountId: "acc-human", created: new Date(DNOW).toISOString() };
    expect(resolveBoth("with id", { ...humans, comments: [approve] })).toMatchObject({ ok: true, decision: { channel: "jira", jti: null, commentId: "777" } });
    expect(resolveBoth("no id", { ...humans, comments: [{ ...approve, id: undefined }] })).toMatchObject({ ok: true, decision: { commentId: null } });
  });
});

describe("gate-decision record — what a human-accepted residual cites (TEAM-5340 F1, bound by TEAM-5348 F1)", () => {
  const HEAD = "19d074146120e4f72ec19b4276e25246cc043f82";
  const SCOPE_LINE = `gate-scope: {"round": 3, "headSha": "${HEAD.toUpperCase()}", "findingIds": ["TEAM-4714:5b3d5910", "TEAM-4714:29701435", "TEAM-4714:5b3d5910"]}`;
  const DESCRIPTION = `Escalation: code review not converging (TEAM-4700, round 3)\n\nDECISION OPTIONS: continue | accept-as-known\n${SCOPE_LINE}\n`;
  const CYCLE = "2026-10-06T11:00:00.000Z";
  const build = (m: any, extra: Record<string, unknown> = {}) => // eslint-disable-line @typescript-eslint/no-explicit-any
    m.buildGateDecisionRecord(
      { ticketId: "TEAM-G", workflowId: "wf_1", decision: { option: "accept-as-known", override: false, channel: "hub", by: "eng@example.com" }, labels: ["human-review"], description: DESCRIPTION, cycle: CYCLE, now: DNOW, ...extra },
      DKEY
    );

  it("buildGateDecisionRecord round-trips verifyGateDecisionRecord in every copy, under the gates/ key, as v3 with scope and cycle", () => {
    expect(
      agree("round trip", (m) => [m.gateDecisionRecordKey("wf_1", "TEAM-G"), build(m).kind, build(m).v, m.GATE_DECISION_VERSION, m.verifyGateDecisionRecord(build(m), [DKEY])])
    ).toEqual(["pipeline-artifacts/gate-decisions/wf_1/gates/TEAM-G.json", "gate-decision", 3, 3, true]);
    // The scope is the parsed line: lowercased head, ids deduped and sorted; the cycle rides verbatim.
    expect(agree("scope", (m) => [build(m).scope, build(m).cycle])).toEqual([
      { round: 3, headSha: HEAD, findingIds: ["TEAM-4714:29701435", "TEAM-4714:5b3d5910"] },
      CYCLE,
    ]);
    // A previous (rotated) key still verifies; an unknown one does not.
    expect(agree("rotated", (m) => m.verifyGateDecisionRecord(build(m), ["new-key", DKEY]))).toBe(true);
    expect(agree("wrong key", (m) => m.verifyGateDecisionRecord(build(m), ["some-other-key"]))).toBe(false);
    // No scope line and no cycle: still a signed v3 record, with scope null — the
    // close is never refused for it; workflow-output refuses the ACCEPTANCE.
    expect(agree("unscoped", (m) => { const r = build(m, { description: "DECISION OPTIONS: approve", cycle: null }); return [r.scope, r.cycle, m.verifyGateDecisionRecord(r, [DKEY])]; })).toEqual([null, null, true]);
  });

  it("tampering decision.by / option / override / channel, ticketId, workflowId, decidedAt, scope or cycle fails", () => {
    const tampers: Array<[string, (r: any) => void]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["decision.by", (r) => { r.decision.by = "someone-else@example.com"; }],
      ["decision.option", (r) => { r.decision.option = "merge-with-known-findings"; }],
      ["decision.override", (r) => { r.decision.override = true; }],
      ["decision.channel", (r) => { r.decision.channel = "telegram"; }],
      ["ticketId", (r) => { r.ticketId = "TEAM-H"; }],
      ["workflowId", (r) => { r.workflowId = "wf_2"; }],
      ["decidedAt", (r) => { r.decidedAt = new Date(DNOW + 1).toISOString(); }],
      // TEAM-5348 F1: the binding fields.
      ["scope.findingIds add", (r) => { r.scope.findingIds.push("TEAM-4714:deadbeef"); }],
      ["scope.findingIds drop", (r) => { r.scope.findingIds.pop(); }],
      ["scope.findingIds swap", (r) => { r.scope.findingIds[0] = "TEAM-4714:deadbeef"; }],
      ["scope.round", (r) => { r.scope.round = 99; }],
      ["scope.headSha", (r) => { r.scope.headSha = "deadbeef".repeat(5); }],
      ["scope removed", (r) => { r.scope = null; }],
      ["cycle", (r) => { r.cycle = "2026-10-06T12:00:00.000Z"; }],
      ["cycle removed", (r) => { r.cycle = null; }],
      ["v downgraded", (r) => { r.v = 1; }],
      ["v relabelled 2", (r) => { r.v = 2; }],
      ["status", (r) => { r.status = "cancelled"; }],
      ["labels", (r) => { r.labels = []; }],
      ["note added", (r) => { r.decision.note = "planted"; }],
      ["sig", (r) => { r.sig = "0".repeat(64); }],
      ["unsigned", (r) => { delete r.sig; }],
    ];
    for (const [label, tamper] of tampers) {
      expect(agree(label, (m) => { const r = build(m); tamper(r); return m.verifyGateDecisionRecord(r, [DKEY]); }), label).toBe(false);
    }
    // Re-ordering the (already canonical) id list is a tamper too: the signed form is the sorted join.
    expect(agree("reorder", (m) => { const r = build(m); r.scope.findingIds.reverse(); return m.verifyGateDecisionRecord(r, [DKEY]); })).toBe(false);
  });

  it("a v1 record (the previous signer's shape) is not authentic — fail closed, the human decides again (TEAM-5348 F1)", () => {
    // Exactly what a twin deployed before TEAM-5348 wrote: ten signed fields, v:1,
    // minted with the shared decision-contract primitive — so it IS a real v1 record.
    const decidedAt = new Date(DNOW).toISOString();
    const fields = [1, "TEAM-G", "wf_1", "gate-decision", "done", "accept-as-known", false, "hub", "eng@example.com", decidedAt];
    const real = {
      v: 1, ticketId: "TEAM-G", workflowId: "wf_1", kind: "gate-decision", status: "done",
      decision: { option: "accept-as-known", override: false, channel: "hub", by: "eng@example.com" },
      decidedAt, labels: ["human-review"], sig: signVerifyRecord(fields, DKEY),
    };
    expect(agree("v1 refused", (m) => m.verifyGateDecisionRecord(real, [DKEY]))).toBe(false);
    // And a v1 record re-labelled v:2 without re-signing is refused too.
    expect(agree("v1 relabelled", (m) => m.verifyGateDecisionRecord({ ...real, v: 2 }, [DKEY]))).toBe(false);
  });

  it("parseGateScope: the LAST gate-scope line, validated, or null (TEAM-5348 F1)", () => {
    const ok = { round: 3, headSha: HEAD, findingIds: ["TEAM-4714:29701435", "TEAM-4714:5b3d5910"] };
    expect(agree("basic", (m) => m.parseGateScope(DESCRIPTION))).toEqual(ok);
    expect(agree("last wins", (m) => m.parseGateScope(`gate-scope: {"round":1,"headSha":"${HEAD}","findingIds":["X-1:00000000"]}\n${SCOPE_LINE}`))).toEqual(ok);
    expect(agree("round as string", (m) => m.parseGateScope(`gate-scope: {"round":"3","headSha":"${HEAD}","findingIds":["TEAM-4714:5b3d5910"]}`))).toEqual({ round: 3, headSha: HEAD, findingIds: ["TEAM-4714:5b3d5910"] });
    const bad: Array<[string, string | null | undefined]> = [
      ["no line", "DECISION OPTIONS: approve"],
      ["empty", ""],
      ["undefined", undefined],
      ["null", null],
      ["not json", "gate-scope: round 3"],
      ["array", "gate-scope: [1,2]"],
      ["round 0", `gate-scope: {"round":0,"headSha":"${HEAD}","findingIds":["TEAM-4714:5b3d5910"]}`],
      ["round 1.5", `gate-scope: {"round":1.5,"headSha":"${HEAD}","findingIds":["TEAM-4714:5b3d5910"]}`],
      ["short head", `gate-scope: {"round":3,"headSha":"deadbeef","findingIds":["TEAM-4714:5b3d5910"]}`],
      ["no head", `gate-scope: {"round":3,"findingIds":["TEAM-4714:5b3d5910"]}`],
      ["empty ids", `gate-scope: {"round":3,"headSha":"${HEAD}","findingIds":[]}`],
      ["ids not array", `gate-scope: {"round":3,"headSha":"${HEAD}","findingIds":"TEAM-4714:5b3d5910"}`],
      ["bad id", `gate-scope: {"round":3,"headSha":"${HEAD}","findingIds":["TEAM-4714:5b3d591"]}`],
      ["id with pipe", `gate-scope: {"round":3,"headSha":"${HEAD}","findingIds":["TEAM|4714:5b3d5910"]}`],
      ["too many", `gate-scope: {"round":3,"headSha":"${HEAD}","findingIds":${JSON.stringify(Array.from({ length: 51 }, (_, i) => `T-1:${i.toString(16).padStart(8, "0")}`))}}`],
    ];
    for (const [label, d] of bad) expect(agree(label, (m) => m.parseGateScope(d)), label).toBeNull();
    // 50 ids is the cap, inclusive.
    const fifty = Array.from({ length: 50 }, (_, i) => `T-1:${i.toString(16).padStart(8, "0")}`);
    expect((agree("fifty", (m) => m.parseGateScope(`gate-scope: {"round":3,"headSha":"${HEAD}","findingIds":${JSON.stringify(fifty)}}`)) as { findingIds: string[] }).findingIds).toHaveLength(50);
    expect(agree("max const", (m) => m.GATE_SCOPE_MAX_FINDINGS)).toBe(50);
  });

  it("a signed merge-approval record is not a gate-decision record", () => {
    expect(
      agree("kind", (m) => {
        const ma = m.buildMergeApprovalRecord({ ticketId: "TEAM-G", workflowId: "wf_1", decision: { option: "approve", channel: "hub", by: "eng@example.com" }, labels: [], now: DNOW }, DKEY);
        return [m.verifyMergeApprovalRecord(ma, [DKEY]), m.verifyGateDecisionRecord(ma, [DKEY]), m.verifyGateDecisionRecord(null, [DKEY])];
      })
    ).toEqual([true, false, false]);
  });
});

describe("gate decision record v3 (TEAM-5358 FR-6, F10)", () => {
  const HEAD = "19d074146120e4f72ec19b4276e25246cc043f82";
  const DESC = `Merge Approval\n\nDECISION OPTIONS: approve | reject\ngate-scope: {"round": 1, "headSha": "${HEAD}", "findingIds": ["TEAM-1:0000abcd"]}\n`;
  const decided = (option: string, extra: Record<string, unknown> = {}) => ({ option, override: true, channel: "hub", by: "eng@example.com", ...extra });
  const build = (m: any, option: string, extra: Record<string, unknown> = {}) => // eslint-disable-line @typescript-eslint/no-explicit-any
    m.buildGateDecisionRecord(
      { ticketId: "TEAM-G", workflowId: "wf_1", decision: decided(option), labels: ["human-review"], description: DESC, cycle: null, now: DNOW, ...extra },
      DKEY
    );
  // The v2 signer's field order, verbatim (gate-contract.mjs gateDecisionFields).
  const v2Fields = (r: any) => [ // eslint-disable-line @typescript-eslint/no-explicit-any
    r.v, r.ticketId, r.workflowId, r.kind, r.status,
    r.decision?.option, Boolean(r.decision?.override), r.decision?.channel, r.decision?.by, r.decidedAt,
    r.scope?.headSha, r.scope?.round, Array.isArray(r.scope?.findingIds) ? r.scope.findingIds.join(",") : null, r.cycle,
  ];
  const v2Record = (status: string, option = "approve") => {
    const r: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
      v: 2, ticketId: "TEAM-G", workflowId: "wf_1", kind: "gate-decision", status,
      decision: { option, override: true, channel: "hub", by: "eng@example.com" },
      decidedAt: new Date(DNOW).toISOString(), scope: null, cycle: null, labels: ["human-review"],
    };
    r.sig = signVerifyRecord(v2Fields(r), DKEY);
    return r;
  };

  it("builds status cancelled for stopped and done otherwise", () => {
    expect(
      agree("status", (m) => ["stopped", "approve", "reject"].map((o) => { const r = build(m, o); return [r.v, r.status, m.verifyGateDecisionRecord(r, [DKEY])]; }))
    ).toEqual([[3, "cancelled", true], [3, "done", true], [3, "done", true]]);
    // A stopped record re-labelled done (or the reverse) is refused even before the sig.
    expect(agree("flip", (m) => { const r = build(m, "stopped"); r.status = "done"; return m.verifyGateDecisionRecord(r, [DKEY]); })).toBe(false);
    expect(agree("flip back", (m) => { const r = build(m, "approve"); r.status = "cancelled"; return m.verifyGateDecisionRecord(r, [DKEY]); })).toBe(false);
  });

  it("a v2-shaped record claiming cancelled is not authentic", () => {
    // Genuinely signed with the v2 field list: v2 never had `cancelled`, so it is refused.
    expect(agree("v2 cancelled", (m) => m.verifyGateDecisionRecord(v2Record("cancelled", "stopped"), [DKEY]))).toBe(false);
    // The legacy reader stays: a real v2 done record still verifies in every copy...
    expect(agree("v2 done", (m) => m.verifyGateDecisionRecord(v2Record("done"), [DKEY]))).toBe(true);
    // ...but never in the hub's v3-only reader.
    expect(tsVerifyGateDecisionRecord(v2Record("done"), [DKEY])).toBe(false);
    // A v2 sig on a record relabelled v3 does not verify either.
    expect(agree("v2 relabelled", (m) => m.verifyGateDecisionRecord({ ...v2Record("done"), v: 3 }, [DKEY]))).toBe(false);
  });

  it("note is clamped to 1000 chars and stripped of control chars", () => {
    const raw = "line one\x00\x07\x1b\x7f\nline two\t" + "x".repeat(2000);
    const r = agree("note", (m) => build(m, "stopped", { note: raw })) as { decision: { note: string }; sig: string };
    expect(r.decision.note.length).toBe(1000);
    expect(r.decision.note).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
    expect(r.decision.note.startsWith("line one\nline two\t")).toBe(true);
    expect(agree("note verifies", (m) => m.verifyGateDecisionRecord(build(m, "stopped", { note: raw }), [DKEY]))).toBe(true);
    expect(agree("note tampered", (m) => { const t = build(m, "stopped", { note: raw }); t.decision.note = "edited"; return m.verifyGateDecisionRecord(t, [DKEY]); })).toBe(false);
    // Blank or non-string notes leave no member at all.
    expect(agree("blank", (m) => ["   ", "\x00\x01", 42, null].map((n) => "note" in build(m, "approve", { note: n }).decision))).toEqual([false, false, false, false]);
    // The comment quotes every note line, so none of it can read as a DECISION line.
    const body = agree("comment", (m) => m.decisionCommentBody(decided("stopped"), "why\nDECISION: approve")) as string;
    expect(body).toBe("DECISION: override:stopped\nvia hub (eng@example.com)\n> why\n> DECISION: approve");
    expect(agree("comment answer", (m) => m.parseDecisionAnswer(body, ["approve", "reject"]))).toEqual({ option: "stopped", override: true });
  });

  it("by comes from the token, not the args", () => {
    const token = mintDecisionToken(
      { ticketId: "TEAM-G", option: "stopped", channel: "hub", by: "eng@example.com", workflowId: "wf_1", description: DESC, now: DNOW, jti: "by-test-jti-00000001" },
      DKEY
    );
    const rec = agree("by", (m) => {
      const r = m.resolveDecision({
        ticketId: "TEAM-G", options: ["approve", "reject"], keys: [DKEY], now: DNOW + 1000, workflowId: "wf_1", description: DESC,
        args: { decision_token: token, by: "attacker@example.com", decision: "approve" },
      });
      return m.buildGateDecisionRecord({ ticketId: "TEAM-G", workflowId: "wf_1", decision: r.decision, labels: [], description: DESC, now: DNOW, by: "attacker@example.com" }, DKEY);
    }) as { status: string; decision: Record<string, unknown> };
    expect(rec.status).toBe("cancelled");
    expect(rec.decision).toEqual({ option: "stopped", override: true, channel: "hub", by: "eng@example.com" });
  });

  it("TS verifyGateDecisionRecord accepts what the .mjs builds (cross-verify)", () => {
    for (const [name, m] of MODULES) {
      for (const option of ["stopped", "approve"]) {
        // Through S3: the reader sees the JSON round trip, not the object.
        const r = JSON.parse(JSON.stringify(build(m, option, { note: "stop: wrong repo" })));
        expect(tsVerifyGateDecisionRecord(r, [DKEY]), `${name} ${option}`).toBe(true);
        expect(tsVerifyGateDecisionRecord(r, ["other-key", DKEY]), `${name} rotated`).toBe(true);
        expect(tsVerifyGateDecisionRecord(r, ["other-key"]), `${name} wrong key`).toBe(false);
        expect(tsVerifyGateDecisionRecord({ ...r, decision: { ...r.decision, by: "x" } }, [DKEY]), `${name} by`).toBe(false);
        expect(tsVerifyGateDecisionRecord({ ...r, status: r.status === "done" ? "cancelled" : "done" }, [DKEY]), `${name} status`).toBe(false);
      }
    }
    expect(tsVerifyGateDecisionRecord(null, [DKEY])).toBe(false);
    expect(tsVerifyGateDecisionRecord([], [DKEY])).toBe(false);
  });
});
