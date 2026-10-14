import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The two copies of the gate contract (TEAM-4739). Only the ticket Lambdas carry
// it — it decides whether a gate ticket may CLOSE — and each ships as a
// self-contained zip, so they CANNOT share a file. The tickets copy is canonical.
import * as ticketsCopy from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";
import * as jiraCopy from "../../../lambda/agentcore-hub-jira/gate-contract.mjs";
import { sameGateBinding } from "../../../lambda/agentcore-hub-tickets/fix-contract.mjs";
import { isTerminalStatus, terminalMoveRefusal } from "./types";
import agentsConfig from "@/config/agents.json";

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
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODULES: Array<[string, any]> = [
  ["tickets", ticketsCopy],
  ["jira", jiraCopy],
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

describe("gate-contract.mjs — the two copies are byte-identical", () => {
  it("the jira copy matches the tickets copy, byte for byte", () => {
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
    // packed into BOTH ticket zips (and would need its own cmp pair).
    const src = readFileSync(resolve(__dirname, "../../..", COPIES[0]), "utf8");
    const locals = [...src.matchAll(/from\s+"(\.\/[\w.-]+\.mjs)"/g)].map((m) => m[1]);
    expect(locals).toEqual(["./fix-contract.mjs"]);
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
  it("PROBE_TOOLS is the same read-only allow-list in both copies", () => {
    expect(agree("PROBE_TOOLS", (m) => m.PROBE_TOOLS)).toEqual([
      "Pipeline___get_state",
      "Pipeline___get_build_status",
      "Pipeline___capabilities",
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

  it("TEAM-6140 (DL-039): a PROVISIONAL securityReview admission is refused by both copies; the finalized stamp admits", () => {
    const sec = (body: unknown) => agree(`judgeCompletionRecord(${JSON.stringify(body)}, securityReview)`,
      (m) => m.judgeCompletionRecord(KEY, JSON.stringify(body), { securityReview: true })) as { proven: boolean; why: string };
    const provisional = sec({ securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1", provisional: true } });
    expect(provisional.proven).toBe(false);
    expect(provisional.why).toContain(`${KEY} carries a PROVISIONAL securityReview admission on amendment TEAM-1`);
    expect(provisional.why).toContain("re-run WorkflowOutput___report_completion");
    // whatever the verdict says: a provisional stamp is never trusted
    expect(sec({ securityReview: { verdict: "PASS", provisional: true } }).proven).toBe(false);
    expect(sec({ securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1" } })).toMatchObject({ proven: true });
    expect(sec({ securityReview: { verdict: "PASS" } })).toMatchObject({ proven: true });
    const why = agree("securityReviewRecordRefusal(provisional)", (m) => m.securityReviewRecordRefusal(KEY, { securityReview: { verdict: "FAIL", amendmentTicketId: "TEAM-1", provisional: true } })) as string;
    expect(why).toMatch(/PROVISIONAL/);
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

/**
 * TEAM-5805 — the merge-brief hold. The ticket-replay drain stamps `briefPending:true`
 * when it could not put the merge brief on the Merge Approval gate; both twins' Done
 * guard must refuse on it (strict `=== true`, the same rule as followUpsPending), in
 * the same words, and a delivery to the gate restamps it `false`, which admits.
 */
describe("judgeCompletionRecord / judgeBriefHold — the TEAM-5805 brief hold", () => {
  const KEY = "completions/TEAM-4066.json";
  const judge = (body: unknown) => agree(`judgeCompletionRecord(${JSON.stringify(body)})`,
    (m) => m.judgeCompletionRecord(KEY, body)) as { proven: boolean; why: string };
  const hold = (body: unknown) => agree(`judgeBriefHold(${JSON.stringify(body)})`,
    (m) => m.judgeBriefHold(KEY, body)) as { proven: boolean; why: string } | null;
  const HELD_WHY = (delivered: string) =>
    `${KEY} has briefPending:true (brief ${delivered}) — the merge brief has not reached ` +
    `the Merge Approval gate; re-run WorkflowOutput___report_completion with the same ` +
    `arguments to deliver the brief (it clears briefPending once the brief is on the gate)`;

  it("refuses briefPending:true, naming where the brief went (or `unstated`)", () => {
    for (const [body, delivered] of [
      [{ briefPending: true, briefDelivered: "off_gate", followUpsPending: false, status: "complete" }, "off_gate"],
      [{ briefPending: true, briefDelivered: "undelivered", status: "complete" }, "undelivered"],
      [{ briefPending: true, followUpsPending: false, status: "complete" }, "unstated"],
      [{ briefPending: true, briefDelivered: "  ", status: "complete_transition_failed" }, "unstated"],
    ] as const) {
      const v = judge(JSON.stringify(body));
      expect(v, JSON.stringify(body)).toEqual({ proven: false, why: HELD_WHY(delivered) });
      expect(hold(JSON.stringify(body))).toEqual({ proven: false, why: HELD_WHY(delivered) });
    }
  });

  it("admits `briefPending !== true` — false (delivered), absent, a string, 1, null", () => {
    for (const body of [
      { briefPending: false, briefDelivered: "gate", followUpsPending: false, status: "complete" },
      { followUpsPending: false, status: "complete" },
      { evidence_kind: "skipped", skipped: true, reason: "empty_sweep_no_siblings" },
      { followUpsPending: false, status: "complete_transition_failed" },
      { briefPending: "true" },
      { briefPending: 1 },
      { briefPending: null },
    ]) {
      expect(judge(JSON.stringify(body)), `${JSON.stringify(body)} must be admitted`).toEqual({ proven: true, why: `${KEY} exists` });
      expect(hold(JSON.stringify(body)), `${JSON.stringify(body)} must not hold`).toBeNull();
    }
  });

  it("follow-ups AND brief pending ⇒ the follow-ups refusal comes first", () => {
    const v = judge(JSON.stringify({ followUpsPending: true, status: "complete_pending_follow_ups", briefPending: true }));
    expect(v.proven).toBe(false);
    expect(v.why).toContain("has followUpsPending:true (status complete_pending_follow_ups)");
    expect(v.why).not.toContain("briefPending");
  });

  it("judgeBriefHold fails CLOSED on a body it cannot judge — UNKNOWN, never a proven hold (TEAM-5832)", () => {
    for (const body of [undefined, null, "", "   ", "not json", "[]", "null", '"s"', "42"]) {
      const v = hold(body) as { proven: boolean; unknown?: boolean; why: string } | null;
      expect(v, `${JSON.stringify(body)} must refuse`).not.toBeNull();
      expect(v?.proven).toBe(false);
      expect(v?.unknown).toBe(true);
      expect(v?.why).toContain(`could not judge ${KEY} (`);
      expect(v?.why).toContain("whether briefPending is set is UNKNOWN");
      // workflow-output's isBriefHoldRefusal must not read this as a proven hold (drop vs retry).
      expect(v?.why).not.toMatch(/has briefPending:true \(brief /);
    }
  });

  it("briefHoldUnknown is BYTE-identical across the two copies", () => {
    const cause = `could not read ${KEY} (AccessDenied 403)`;
    const [ticketsWhy, jiraWhy] = MODULES.map(([, m]) => Buffer.from(m.briefHoldUnknown(KEY, cause).why, "utf8"));
    expect(jiraWhy.equals(ticketsWhy), "the two copies phrase the unknown-hold refusal differently").toBe(true);
    expect(ticketsWhy.toString("utf8").startsWith(`${cause} — whether briefPending is set is UNKNOWN`)).toBe(true);
  });

  it("the brief-hold refusal is BYTE-identical across the two copies", () => {
    const body = JSON.stringify({ briefPending: true, briefDelivered: "off_gate" });
    const [ticketsWhy, jiraWhy] = MODULES.map(([, m]) => Buffer.from(m.judgeCompletionRecord(KEY, body).why, "utf8"));
    expect(jiraWhy.equals(ticketsWhy), "the two copies phrase the brief-hold refusal differently").toBe(true);
  });

  it("MERGE_BRIEF_AUTHOR_AGENT is the operator in both copies, and the operator is NOT ship-phase", () => {
    // Not ship-phase is why this guard exists separately: a ship-phase ticket already
    // reads its whole record through judgeCompletionRecord.
    const author = agree("MERGE_BRIEF_AUTHOR_AGENT", (m) => m.MERGE_BRIEF_AUTHOR_AGENT);
    expect(author).toBe("agentcore_hub_operator");
    const row = (agentsConfig as { agents: { agentId: string; phase?: string }[] }).agents.find((a) => a.agentId === author);
    expect(row, `${author} is not in src/config/agents.json`).toBeTruthy();
    expect(row?.phase).not.toBe("ship");
  });
});

// TEAM-5421 — the cancelled-status matrix. Both ticket twins and the TS mirror in
// types.ts must agree on every (from, to) pair, or one provider would let a
// cancelled ticket back onto the board while the other refuses it.
describe("terminalMoveRefusal / isTerminalStatus — twins + TS mirror agree", () => {
  const STATUSES = ["todo", "ready", "in_progress", "in_review", "blocked", "done", "cancelled", "", " Cancelled "];

  it.each(STATUSES)("isTerminalStatus(%j) agrees across all three copies", (s) => {
    const v = agree(`isTerminalStatus(${s})`, (m) => m.isTerminalStatus(s));
    expect(isTerminalStatus(s)).toBe(v);
    expect(v).toBe(s.trim().toLowerCase() === "cancelled");
  });

  it("every (from, to) pair agrees across all three copies", () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const v = agree(`terminalMoveRefusal(${from}, ${to})`, (m) => m.terminalMoveRefusal(from, to));
        expect(terminalMoveRefusal(from, to), `TS mirror disagrees on ${from} -> ${to}`).toBe(v);
        const f = from.trim().toLowerCase();
        const refused = f === "cancelled" || (f === "done" && to.trim().toLowerCase() === "cancelled");
        expect(v !== null, `${from} -> ${to}`).toBe(refused);
      }
    }
  });

  it("only reopen-style moves leave done; cancelled is never left", () => {
    expect(terminalMoveRefusal("done", "todo")).toBeNull();
    expect(terminalMoveRefusal("done", "cancelled")).toMatch(/never cancelled/);
    expect(terminalMoveRefusal("cancelled", "todo")).toMatch(/terminal/);
    expect(terminalMoveRefusal("cancelled", "done")).toMatch(/terminal/);
  });
});

/**
 * TEAM-5941 — the Done-intent fence. The twins write `doneIntent` onto the completion
 * record (IfMatch) as the last step before their commit; the replay drain backs off a
 * hold stamp while a FRESH intent is on the record. workflow-output cannot import
 * gate-contract.mjs (its zip), so it carries a THIRD copy of the TTL and the freshness
 * rule (`DONE_INTENT_TTL_MS`, `doneIntentFresh`). A drift there is a drain that stamps a
 * hold the twin is about to walk past, or one that waits forever on a dead twin — so the
 * value is pinned here off the file, the way check-fix-kinds-parity.sh pins literals.
 */
describe("doneIntentOf / DONE_INTENT_TTL_MS — the Done-intent fence (TEAM-5941)", () => {
  const NOW = Date.parse("2026-10-14T12:00:00.000Z");
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it("the TTL agrees across the two copies, and is 10 minutes", () => {
    expect(agree("DONE_INTENT_TTL_MS", (m) => m.DONE_INTENT_TTL_MS)).toBe(10 * 60_000);
    expect(agree("DONE_INTENT_FENCE_ATTEMPTS", (m) => m.DONE_INTENT_FENCE_ATTEMPTS)).toBe(3);
  });

  it("workflow-output's mirror carries the SAME TTL value", () => {
    const src = readFileSync(resolve(__dirname, "../../..", "lambda/workflow-output/index.mjs"), "utf8");
    const m = /export const DONE_INTENT_TTL_MS = ([^;]+);/.exec(src);
    expect(m, "lambda/workflow-output/index.mjs no longer exports DONE_INTENT_TTL_MS").not.toBeNull();
    // eslint-disable-next-line no-new-func
    const mirrored = Function(`"use strict"; return (${m![1]});`)();
    expect(mirrored).toBe(agree("DONE_INTENT_TTL_MS (mirror)", (m2) => m2.DONE_INTENT_TTL_MS));
  });

  it.each([
    ["absent", {}, { present: false, fresh: false }],
    ["no record", null, { present: false, fresh: false }],
    ["a non-object intent", { doneIntent: "soon" }, { present: false, fresh: false }],
    ["fresh (1 s old)", { doneIntent: { at: at(1000), provider: "jira", nonce: "n" } }, { present: true, fresh: true }],
    ["fresh (1 ms under the TTL)", { doneIntent: { at: at(10 * 60_000 - 1) } }, { present: true, fresh: true }],
    ["future `at` (clock skew) is fresh", { doneIntent: { at: at(-60_000) } }, { present: true, fresh: true }],
    ["exactly the TTL is stale", { doneIntent: { at: at(10 * 60_000) } }, { present: true, fresh: false }],
    ["stale (an hour)", { doneIntent: { at: at(3_600_000) } }, { present: true, fresh: false }],
    ["an unparseable `at` is stale", { doneIntent: { at: "yesterday" } }, { present: true, fresh: false }],
    ["no `at` is stale", { doneIntent: { provider: "jira" } }, { present: true, fresh: false }],
  ])("doneIntentOf agrees on %s", (label, record, expected) => {
    const v = agree(`doneIntentOf ${label}`, (m) => m.doneIntentOf(record, NOW)) as { present: boolean; fresh: boolean };
    expect({ present: v.present, fresh: v.fresh }).toEqual(expected);
  });

  it("withDoneIntent / withoutDoneIntent never mutate and round-trip", () => {
    const record = { ticketId: "T", briefPending: false };
    const fenced = agree("withDoneIntent", (m) => m.withDoneIntent(record, { provider: "dynamodb", at: at(0), nonce: "n1" })) as Record<string, unknown>;
    expect(fenced.doneIntent).toEqual({ at: at(0), provider: "dynamodb", nonce: "n1" });
    expect(record).not.toHaveProperty("doneIntent");
    expect(agree("withoutDoneIntent", (m) => m.withoutDoneIntent(fenced))).toEqual(record);
    expect(fenced).toHaveProperty("doneIntent");
  });

  it("classifyS3WriteError: 412 ⇒ precondition, 409 ⇒ conflict, 404 ⇒ gone, else other", () => {
    const e = (name: string, status?: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
    for (const [err, kind] of [
      [e("PreconditionFailed", 412), "precondition"],
      [e("Weird", 412), "precondition"],
      [e("ConditionalRequestConflict", 409), "conflict"],
      [e("NoSuchKey", 404), "gone"],
      [e("NotFound"), "gone"],
      [e("AccessDenied", 403), "other"],
      [e("InternalError", 500), "other"],
      [null, "other"],
    ] as const) {
      expect(agree(`classify ${err?.name}`, (m) => m.classifyS3WriteError(err))).toBe(kind);
    }
  });

  it("rejudgeAdmitted uses the guard's own judge, and its refusal texts are the guard's", () => {
    const KEY = "completions/TEAM-4066.json";
    const held = JSON.stringify({ briefPending: true, briefDelivered: "off_gate" });
    const pending = JSON.stringify({ followUpsPending: true, status: "complete_pending_follow_ups" });
    const clean = JSON.stringify({ status: "complete", followUpsPending: false });
    // brief-only guard (every non-ship ticket)
    expect(agree("brief: clean", (m) => m.rejudgeAdmitted(KEY, clean, {}))).toBeNull();
    expect(agree("brief: held", (m) => m.rejudgeAdmitted(KEY, held, {}))).toMatchObject({
      what: "a ticket whose merge brief is held", unknown: false,
      why: agree("brief why", (m) => m.judgeBriefHold(KEY, held).why),
    });
    expect(agree("brief: followUps ignored", (m) => m.rejudgeAdmitted(KEY, pending, {}))).toBeNull();
    expect(agree("brief: unjudgeable", (m) => m.rejudgeAdmitted(KEY, "{nope", {}))).toMatchObject({ unknown: true, what: "a ticket whose merge-brief hold cannot be read" });
    // record-gated guard (ship / security)
    expect(agree("gated: pending", (m) => m.rejudgeAdmitted(KEY, pending, { recordGated: true }))).toMatchObject({
      what: "a ship-phase ticket", why: agree("gated why", (m) => m.judgeCompletionRecord(KEY, pending).why),
    });
    expect(agree("gated: security stamp missing", (m) => m.rejudgeAdmitted(KEY, clean, { recordGated: true, securityReview: true }))).toMatchObject({ what: "a security-review ticket" });
    expect(agree("gated: clean", (m) => m.rejudgeAdmitted(KEY, clean, { recordGated: true }))).toBeNull();
  });

  it("the fence refusals never read as a proven brief hold to workflow-output", () => {
    for (const text of [
      agree("contended", (m) => m.doneIntentContendedRefusal("completions/X.json", 3)),
      agree("unfenced", (m) => m.doneIntentUnfencedRefusal("completions/X.json", "PutObject AccessDenied 403")),
      agree("brief warning", (m) => m.DONE_OVER_BRIEF_HOLD_WARNING),
    ] as string[]) {
      expect(text).not.toMatch(/has briefPending:true \(brief /);
    }
    // TEAM-5941: the post-commit warning no longer advises a report_completion re-run,
    // which cannot close or converge a Done ticket.
    expect(agree("brief warning text", (m) => m.DONE_OVER_BRIEF_HOLD_WARNING)).not.toMatch(/re-run WorkflowOutput___report_completion/);
  });
});

/**
 * TEAM-5959 (TEAM-5799 F5) — the Done-intent RESERVATION. On a 404 admission each twin
 * reserves completions/<id>.json create-only with an intent-only body; every reader treats
 * it exactly as a 404. The marker literals are mirrored where this file cannot be imported
 * (src/lib/workflow/completion-evidence.ts, lambda/cost-report/index.mjs); a drift there
 * is a reader that counts a reservation as a record (or a record as a reservation), so the
 * literals are pinned here off the files. The orchestrator carries no mirror (DL-009 line
 * budget; its completionRecordHasEvidence field rule needs none — completion-evidence-
 * parity.test.ts asserts a reservation is no evidence there).
 */
describe("Done-intent reservation — doneIntentReservation / isIntentOnlyReservation (TEAM-5959)", () => {
  const intent = { provider: "jira", at: "2026-10-14T06:00:00.000Z", nonce: "n1" };

  it("the marker literals agree across the two copies", () => {
    expect(agree("RESERVATION_FIELD", (m) => m.RESERVATION_FIELD)).toBe("reservation");
    expect(agree("DONE_INTENT_RESERVATION", (m) => m.DONE_INTENT_RESERVATION)).toBe("done-intent");
  });

  it.each([
    ["src/lib/workflow/completion-evidence.ts", /export const RESERVATION_FIELD = "([^"]+)";/, /export const DONE_INTENT_RESERVATION = "([^"]+)";/, /const RESERVATION_KEYS = new Set\(\[RESERVATION_FIELD, "ticketId", "doneIntent"\]\);/],
    ["lambda/cost-report/index.mjs", /if \(record\.(reservation) !== "done-intent"\) return false;/, /if \(record\.reservation !== "([^"]+)"\) return false;/, /const RESERVATION_KEYS = new Set\(\["reservation", "ticketId", "doneIntent"\]\);/],
  ])("the mirror in %s carries the SAME marker field, value and key set", (file, fieldRe, valueRe, keysRe) => {
    const src = readFileSync(resolve(__dirname, "../../..", file), "utf8");
    const field = fieldRe.exec(src);
    const value = valueRe.exec(src);
    expect(field, `${file} no longer carries the reservation field literal`).not.toBeNull();
    expect(value, `${file} no longer carries the reservation value literal`).not.toBeNull();
    expect(field![1]).toBe(agree("RESERVATION_FIELD (mirror)", (m) => m.RESERVATION_FIELD));
    expect(value![1]).toBe(agree("DONE_INTENT_RESERVATION (mirror)", (m) => m.DONE_INTENT_RESERVATION));
    expect(keysRe.test(src), `${file} no longer carries the intent-only key set`).toBe(true);
  });

  it("doneIntentReservation is marker + ticketId + intent and nothing else", () => {
    const body = agree("doneIntentReservation", (m) => m.doneIntentReservation("TEAM-1", intent)) as Record<string, unknown>;
    expect(body).toEqual({ reservation: "done-intent", ticketId: "TEAM-1", doneIntent: { at: intent.at, provider: "jira", nonce: "n1" } });
    expect(agree("isIntentOnlyReservation(own body)", (m) => m.isIntentOnlyReservation(m.doneIntentReservation("TEAM-1", intent)))).toBe(true);
    expect(agree("doneIntentOf(reservation).fresh", (m) => m.doneIntentOf(m.doneIntentReservation("TEAM-1", intent), Date.parse(intent.at) + 1000).fresh)).toBe(true);
  });

  it.each([
    ["bare reservation", { reservation: "done-intent", ticketId: "T", doneIntent: intent }, true],
    ["intent cleared (a failed commit's clear)", { reservation: "done-intent", ticketId: "T" }, true],
    ["+ briefPending (a hold)", { reservation: "done-intent", ticketId: "T", briefPending: true }, false],
    ["+ followUpsPending (a hold)", { reservation: "done-intent", ticketId: "T", followUpsPending: true }, false],
    ["+ summary (a real writer)", { reservation: "done-intent", ticketId: "T", summary: "s", doneIntent: intent }, false],
    ["+ ticketWrites (the drain)", { reservation: "done-intent", ticketId: "T", ticketWrites: "dropped" }, false],
    ["wrong marker value", { reservation: "something-else", ticketId: "T" }, false],
    ["intent with no marker", { ticketId: "T", doneIntent: intent }, false],
    ["blank record", {}, false],
    ["null", null, false],
    ["array", [], false],
  ])("isIntentOnlyReservation agrees on %s", (label, record, expected) => {
    expect(agree(`isIntentOnlyReservation ${label}`, (m) => m.isIntentOnlyReservation(record))).toBe(expected);
  });

  it("judgeCompletionRecord refuses a reservation as 'no record' (ship and security), BYTE-identical, after the hold checks", () => {
    const key = "completions/TEAM-1.json";
    const body = JSON.stringify({ reservation: "done-intent", ticketId: "TEAM-1", doneIntent: intent });
    const plain = agree("judgeCompletionRecord(reservation)", (m) => m.judgeCompletionRecord(key, body)) as { proven: boolean; why: string };
    expect(plain.proven).toBe(false);
    expect(plain.why).toBe("no completions/TEAM-1.json in the artifact bucket (only a Done-intent reservation, not a completion record)");
    expect(plain.why.startsWith("no completions/TEAM-1.json in the artifact bucket")).toBe(true); // the 404 text family
    expect(plain.why).not.toMatch(/\bhas briefPending:true \(brief /);
    const sec = agree("judgeCompletionRecord(reservation, securityReview)", (m) => m.judgeCompletionRecord(key, body, { securityReview: true })) as { proven: boolean; why: string };
    expect(sec).toEqual(plain);
    expect(agree("reservationNotARecord", (m) => m.reservationNotARecord(key))).toBe(plain.why);
    // Holds first: a reservation a hold was stamped onto is refused as the HOLD, never as a reservation.
    const cleared = JSON.stringify({ reservation: "done-intent", ticketId: "TEAM-1" });
    expect((agree("judgeCompletionRecord(cleared reservation)", (m) => m.judgeCompletionRecord(key, cleared)) as { proven: boolean }).proven).toBe(false);
    const heldBrief = JSON.stringify({ reservation: "done-intent", ticketId: "TEAM-1", briefPending: true, briefDelivered: "off_gate" });
    expect((agree("judgeCompletionRecord(reservation+brief hold)", (m) => m.judgeCompletionRecord(key, heldBrief)) as { why: string }).why).toMatch(/\bhas briefPending:true \(brief off_gate\)/);
    const heldFollowUps = JSON.stringify({ reservation: "done-intent", ticketId: "TEAM-1", followUpsPending: true, status: "complete_pending_follow_ups" });
    expect((agree("judgeCompletionRecord(reservation+follow-ups hold)", (m) => m.judgeCompletionRecord(key, heldFollowUps)) as { why: string }).why).toMatch(/has followUpsPending:true/);
  });

  it("judgeBriefHold ADMITS a hold-free reservation (a non-gated ticket treats it as a 404) and refuses one with a hold", () => {
    const key = "completions/TEAM-1.json";
    expect(agree("judgeBriefHold(reservation)", (m) => m.judgeBriefHold(key, JSON.stringify({ reservation: "done-intent", ticketId: "TEAM-1", doneIntent: intent })))).toBeNull();
    expect(agree("judgeBriefHold(cleared reservation)", (m) => m.judgeBriefHold(key, JSON.stringify({ reservation: "done-intent", ticketId: "TEAM-1" })))).toBeNull();
    expect((agree("judgeBriefHold(reservation+hold)", (m) => m.judgeBriefHold(key, JSON.stringify({ reservation: "done-intent", ticketId: "TEAM-1", briefPending: true }))) as { proven: boolean }).proven).toBe(false);
    // rejudgeAdmitted on the non-gated path (no recordGated) admits a rival twin's reservation ⇒ CAS again.
    expect(agree("rejudgeAdmitted(reservation, non-gated)", (m) => m.rejudgeAdmitted(key, JSON.stringify({ reservation: "done-intent", ticketId: "TEAM-1", doneIntent: intent }), {}))).toBeNull();
    // ... and on the gated path refuses it as "no record".
    expect((agree("rejudgeAdmitted(reservation, gated)", (m) => m.rejudgeAdmitted(key, JSON.stringify({ reservation: "done-intent", ticketId: "TEAM-1", doneIntent: intent }), { recordGated: true })) as { what: string }).what).toBe("a ship-phase ticket");
  });

  it("the hub and orchestrator mirrors agree with the canonical predicate on every row", async () => {
    const ts = await import("./completion-evidence");
    const orch = await import("../../../lambda/orchestrator/completion.mjs"); // TEAM-5996
    for (const record of [
      { reservation: "done-intent", ticketId: "T", doneIntent: intent }, { reservation: "done-intent", ticketId: "T" }, { reservation: "done-intent", ticketId: "T", briefPending: true },
      { reservation: "done-intent", ticketId: "T", summary: "s" }, { reservation: "x" }, {}, null,
    ]) {
      const canonical = agree("isIntentOnlyReservation (canonical)", (m) => m.isIntentOnlyReservation(record));
      expect(ts.isIntentOnlyReservation(record), `completion-evidence.ts on ${JSON.stringify(record)}`).toBe(canonical);
      expect(orch.isIntentOnlyReservation(record), `orchestrator completion.mjs on ${JSON.stringify(record)}`).toBe(canonical);
    }
  });
});
