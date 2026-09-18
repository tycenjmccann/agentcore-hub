import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The two copies of the gate contract (TEAM-4739). Only the ticket Lambdas carry
// it — it decides whether a gate ticket may CLOSE — and each ships as a
// self-contained zip, so they CANNOT share a file. The tickets copy is canonical.
import * as ticketsCopy from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";
import * as jiraCopy from "../../../lambda/agentcore-hub-jira/gate-contract.mjs";

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

  it("counts untargeted siblings only when neither side carries a binding", () => {
    const untargeted = [{ id: "T-1", labels: ["gate:blocker"] }, { id: "T-2", labels: ["gate-blocker"] }];
    expect(agree("both unbound", (m) => m.gateLoopVerdict(untargeted, { gateKind: "blocker" })))
      .toMatchObject({ loop: true, priorCount: 2 });
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
