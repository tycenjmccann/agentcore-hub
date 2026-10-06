import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as out from "../../../lambda/workflow-output/index.mjs";
import { fingerprintFinding } from "../../../lambda/orchestrator/review-cap.mjs";
import * as shipReview from "../../../lambda/orchestrator/ship-review.mjs";

/**
 * TEAM-5323 (FR-1) — one findingId, two modules, and the rule that keeps an
 * accepted residual from coming back.
 *
 * workflow-output mints the findingId of every accepted residual
 * (`residualFindingId`); the orchestrator's review cap fingerprints findings with
 * `fingerprintFinding(ticketId, "file: title")`. Separate Lambda zips, so the
 * function is copied, and this file is what stops the copy drifting: a residual
 * whose id differs from the ledger's is one the RM re-files as new.
 *
 * The cap rule itself is blueprint prose (code-reviewer.md, release-manager.md).
 * `capDecision` / `filterAccepted` below are its executable form, run over the
 * synthetic round-3 ledgers, so the prose has a test to disagree with.
 */

const isRegressionOfFix = out.isRegressionOfFix as (v: unknown) => boolean;
const residualFindingId = out.residualFindingId as (ticketId: string, f: { file?: string; title?: string }) => string;
const validateCapResolution = out.validateCapResolution as (args: Record<string, unknown>) => {
  ok: boolean;
  reason?: string;
  residuals?: Array<{ findingId: string }>;
};

type Finding = { id: string; severity: string; file?: string; title?: string; findingId?: string; classification?: string };
type Round = { round: number; verdict: string; reviewedHeadSha: string; findings: Finding[] };
type Ledger = {
  synthetic: boolean;
  reviewTicket: string;
  gateConfig: { maxRounds: number };
  rounds: Round[];
  acceptedResiduals: Array<{ findingId: string }>;
};

const root = resolve(__dirname, "../../..");
const fixture = (name: string): Ledger =>
  JSON.parse(readFileSync(resolve(root, `lambda/workflow-output/fixtures/round3-${name}.synthetic.json`), "utf8"));

const ABOVE_FLOOR = new Set(["P0", "P1"]);

/** At the cap: pass with the residuals as follow-ups, or escalate. Below it: keep reviewing. */
function capDecision(ledger: Ledger, findings: Finding[]): "continue" | "escalate" | "pass_with_followups" {
  const latest = ledger.rounds[ledger.rounds.length - 1];
  if (latest.round < ledger.gateConfig.maxRounds) return "continue";
  // TEAM-5340 F3: the server's own prefix rule, so `REGRESSION-OF-FIX r2` blocks too.
  const blocking = findings.some((f) => ABOVE_FLOOR.has(f.severity) || isRegressionOfFix(f.classification));
  return blocking ? "escalate" : "pass_with_followups";
}

/** The RM's rule: a finding whose findingId is accepted is never re-filed. */
function filterAccepted(findings: Finding[], acceptedIds: Set<string>): Finding[] {
  return findings.filter((f) => !acceptedIds.has(f.findingId ?? ""));
}

const toResiduals = (findings: Finding[], round: number) =>
  findings.map((f) => ({
    file: f.file,
    title: f.title,
    severity: f.severity,
    rationale: `${f.id} at the round cap: auto-pass floor`,
    decidedBy: "auto-pass-floor",
    round,
  }));

const PASS_RUNS = ["TEAM-4711", "TEAM-4726", "TEAM-5038", "TEAM-5259"];

describe("accepted residuals — findingId parity", () => {
  it("residualFindingId equals fingerprintFinding(ticket, \"file: title\")", () => {
    let seed = 0x5323;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    const word = () => Math.random().toString(36).slice(2, 2 + (rnd() % 8) + 1);
    for (let i = 0; i < 20; i++) {
      const ticket = `TEAM-${rnd() % 9000 + 1000}`;
      const file = `src/${word()}/${word()}.ts`;
      const title = `${word()}  ${word().toUpperCase()}\t${word()} `;
      expect(residualFindingId(ticket, { file, title })).toBe(fingerprintFinding(ticket, `${file}: ${title}`));
    }
    expect(residualFindingId("", { file: "a", title: "b" })).toBe(fingerprintFinding("", "a: b"));
  });

  it("matches the fixture ids TEAM-4729:ca6a5663 and TEAM-4714:29701435", () => {
    for (const [name, id] of [["TEAM-4726", "TEAM-4729:ca6a5663"], ["TEAM-4711", "TEAM-4714:29701435"]] as const) {
      const ledger = fixture(`${name}.ship-review-state`);
      const f = ledger.rounds[ledger.rounds.length - 1].findings.find((x) => x.findingId === id)!;
      expect(residualFindingId(ledger.reviewTicket, f)).toBe(id);
    }
  });

  it("the handoff PR body's Known limitations caps equal the Lambda's (TEAM-5336 F9)", () => {
    expect(shipReview.RESIDUAL_MAX_ENTRIES).toBe(out.RESIDUAL_MAX_ENTRIES);
    expect(shipReview.RESIDUAL_RATIONALE_MAX).toBe(out.RESIDUAL_RATIONALE_MAX);
    // A residual the Lambda mints renders with its id and severity, not a placeholder.
    const [line] = shipReview.formatKnownLimitations(
      [{ findingId: residualFindingId("TEAM-1", { file: "a.ts", title: "t" }), severity: "P2", rationale: "r", decidedBy: "human:me", round: 3 }],
      "wf_1"
    );
    expect(line).not.toContain("(invalid id)");
    expect(line).toMatch(/^- \*\*P2\*\* TEAM-1:[0-9a-f]{8}: r \(decided by human:me, round 3\)$/);
  });
});

describe("accepted residuals — the cap rule over the round-3 ledgers", () => {
  it("round3 ledger → pass_with_followups, and the Lambda accepts those residuals", () => {
    for (const run of PASS_RUNS) {
      const ledger = fixture(`${run}.ship-review-state`);
      expect(ledger.synthetic).toBe(true);
      const latest = ledger.rounds[ledger.rounds.length - 1];
      expect(capDecision(ledger, latest.findings), run).toBe("pass_with_followups");
      const v = validateCapResolution({
        review_verdict: "PASS-with-follow-ups",
        review_round: latest.round,
        accepted_residuals: toResiduals(latest.findings, latest.round),
        ticket_id: ledger.reviewTicket,
      });
      expect(v.ok, run).toBe(true);
      expect(v.residuals!.map((r) => r.findingId).sort()).toEqual(ledger.acceptedResiduals.map((r) => r.findingId).sort());
    }
  });

  it("p1 ledger → capDecision === \"escalate\", and the floor refuses it server-side", () => {
    const ledger = fixture("TEAM-4711-p1.ship-review-state");
    const latest = ledger.rounds[ledger.rounds.length - 1];
    expect(capDecision(ledger, latest.findings)).toBe("escalate");
    const v = validateCapResolution({
      review_verdict: "PASS-with-follow-ups",
      review_round: latest.round,
      accepted_residuals: latest.findings.map((f) => ({ findingId: f.findingId, severity: f.severity, rationale: "floor", decidedBy: "auto-pass-floor", round: latest.round })),
      ticket_id: ledger.reviewTicket,
    });
    expect(v).toMatchObject({ ok: false, reason: "residual_above_floor" });
  });

  it("a P2 classified \"REGRESSION-OF-FIX r2\" (the RM's spelling) escalates in capDecision and is refused server-side (TEAM-5340 F3)", () => {
    const ledger = fixture("TEAM-4726.ship-review-state");
    const latest = ledger.rounds[ledger.rounds.length - 1];
    const findings = latest.findings.map((f, i) => (i === 0 ? { ...f, severity: "P2", classification: "REGRESSION-OF-FIX r2" } : f));
    expect(capDecision(ledger, findings)).toBe("escalate");
    const v = validateCapResolution({
      review_verdict: "PASS-with-follow-ups",
      review_round: latest.round,
      accepted_residuals: toResiduals(findings, latest.round).map((r, i) => ({ ...r, classification: findings[i].classification })),
      ticket_id: ledger.reviewTicket,
    });
    expect(v).toMatchObject({ ok: false, reason: "residual_above_floor" });
  });

  it("an accepted residual never appears in a CHANGES-NEEDED round read by deriveReviewFindings", () => {
    // deriveReviewFindings (orchestrator) only ever reads the LATEST round, and only
    // a CHANGES-NEEDED one — pinned as source text, the orchestrator is not imported.
    const orch = readFileSync(resolve(root, "lambda/orchestrator/index.mjs"), "utf8");
    const body = orch.slice(orch.indexOf("async function deriveReviewFindings"), orch.indexOf("function isHumanReviewGate"));
    expect(body).toMatch(/if \(latest\.verdict !== "CHANGES-NEEDED"\) return null;/);

    for (const run of PASS_RUNS) {
      const ledger = fixture(`${run}.ship-review-state`);
      const latest = ledger.rounds[ledger.rounds.length - 1];
      // The pass round itself is not CHANGES-NEEDED, so it feeds the orchestrator nothing.
      expect(latest.verdict).not.toBe("CHANGES-NEEDED");
      // A later re-review on the same lineage that saw the same findings again files
      // none of them: nothing is left to make a CHANGES-NEEDED round out of.
      const accepted = new Set(ledger.acceptedResiduals.map((r) => r.findingId));
      expect(filterAccepted(latest.findings, accepted), run).toEqual([]);
    }
  });
});

// ─── TEAM-5323 (d): the blueprint cap rule, replayed (Acceptance 4–5) ─────────
//
// code-reviewer.md Step 4b and release-manager.md's acceptedResiduals paragraph,
// as executable steps over the four real-shaped round-3 runs and the P1 twin. The
// source-text pins at the end keep this encoding and the prose from drifting.

type Expected = {
  runs: Array<{ run: string; reviewTicket: string; expected: { escalationTicketsCreated: number; reviewVerdict: string; reviewRound: number; followUps: number } }>;
  totals: { escalationTickets: number; passCompletionsWithFollowUps: number };
};
type Completion = { params: { ticket_id: string; review_verdict: string; review_round: number; accepted_residuals: unknown[]; follow_ups: Array<{ kind: string }> } };
type Residual = { findingId: string; headSha?: string; file?: string; title?: string; decidedBy?: string };

const readJson = <T,>(rel: string): T => JSON.parse(readFileSync(resolve(root, rel), "utf8")) as T;
const blueprint = (name: string) => readFileSync(resolve(root, `blueprints/${name}.md`), "utf8");

/**
 * One reviewer turn at the round the ledger is on. `gates` is the run's open
 * tickets by exact title (the blueprint's adopt-don't-duplicate check).
 */
function reviewerTurn(ledger: Ledger, gates: Set<string>) {
  const latest = ledger.rounds[ledger.rounds.length - 1];
  const decision = capDecision(ledger, latest.findings);
  if (decision === "escalate") {
    const title = `Escalation: code review not converging (${ledger.reviewTicket}, round ${ledger.gateConfig.maxRounds})`;
    const created = gates.has(title) ? 0 : 1;
    gates.add(title);
    return { decision, escalationsCreated: created, completion: null };
  }
  const residuals = toResiduals(latest.findings, latest.round).map((r) => ({ ...r, headSha: latest.reviewedHeadSha }));
  const v = validateCapResolution({ review_verdict: "PASS-with-follow-ups", review_round: latest.round, accepted_residuals: residuals, ticket_id: ledger.reviewTicket });
  return {
    decision,
    escalationsCreated: 0,
    completion: { verdict: "PASS-with-follow-ups", round: latest.round, residuals: (v.residuals ?? []) as Residual[], followUps: residuals.map(() => ({ kind: "fix" })) },
  };
}

/**
 * The RM's ship-review filter: a finding matching an accepted residual (findingId,
 * or file + title) whose headSha is on the reviewed head's lineage is not filed.
 */
function shipReviewFixes(findings: Finding[], accepted: Residual[], lineage: Set<string>): Finding[] {
  const live = accepted.filter((a) => a.headSha && lineage.has(a.headSha));
  return findings.filter((f) => !live.some((a) =>
    (f.findingId && a.findingId === f.findingId) || (a.file && a.title && a.file === f.file && a.title === f.title)));
}

describe("blueprint cap replay — Acceptance 4–5", () => {
  const expected = readJson<Expected>("lambda/workflow-output/fixtures/round3-expected.synthetic.json");

  it("round-3 states of TEAM-4711/4726/5038/5259 → 0 escalations, 4 PASS with follow-ups", () => {
    expect(expected.runs.map((r) => r.run)).toEqual(PASS_RUNS);
    let escalations = 0;
    let passWithFollowUps = 0;
    for (const { run, reviewTicket, expected: want } of expected.runs) {
      const ledger = fixture(`${run}.ship-review-state`);
      expect(ledger.reviewTicket).toBe(reviewTicket);
      const turn = reviewerTurn(ledger, new Set());
      escalations += turn.escalationsCreated;
      expect(turn.decision, run).toBe("pass_with_followups");
      expect(turn.completion!.verdict).toBe(want.reviewVerdict);
      expect(turn.completion!.round).toBe(want.reviewRound);
      expect(turn.completion!.followUps, run).toHaveLength(want.followUps);
      if (turn.completion!.followUps.length > 0) passWithFollowUps++;
      // The ids the turn would write are the ledger's, and the committed
      // completion fixture carries the same verdict, round and follow-up count.
      expect(turn.completion!.residuals.map((r) => r.findingId).sort()).toEqual(ledger.acceptedResiduals.map((r) => r.findingId).sort());
      const fx = readJson<Completion>(`lambda/workflow-output/fixtures/round3-${run}.completion.synthetic.json`);
      expect(fx.params).toMatchObject({ ticket_id: reviewTicket, review_verdict: want.reviewVerdict, review_round: want.reviewRound });
      expect(fx.params.follow_ups.filter((f) => f.kind === "fix")).toHaveLength(want.followUps);
      expect(fx.params.accepted_residuals).toHaveLength(want.followUps);
    }
    expect(escalations).toBe(expected.totals.escalationTickets);
    expect(escalations).toBe(0);
    expect(passWithFollowUps).toBe(expected.totals.passCompletionsWithFollowUps);
  });

  it("the P1 twin escalates exactly once, even when the turn is redelivered", () => {
    const ledger = fixture("TEAM-4711-p1.ship-review-state");
    const gates = new Set<string>();
    const first = reviewerTurn(ledger, gates);
    const again = reviewerTurn(ledger, gates);
    expect(first).toMatchObject({ decision: "escalate", escalationsCreated: 1, completion: null });
    expect(again).toMatchObject({ decision: "escalate", escalationsCreated: 0 });
    expect(gates.size).toBe(1);
  });

  it("ship-review r1 on the same head files no fix for an accepted finding (TEAM-5038 → TEAM-5142)", () => {
    const ledger = fixture("TEAM-5038.ship-review-state");
    const latest = ledger.rounds[ledger.rounds.length - 1];
    const accepted = reviewerTurn(ledger, new Set()).completion!.residuals;
    expect(accepted.every((a) => a.file && a.title && a.headSha === latest.reviewedHeadSha)).toBe(true);
    // The RM's own r1 sees the same defects under its own ticket, so it has no
    // reviewer findingId: file + title is the match.
    const r1 = latest.findings.map(({ id, severity, file, title }) => ({ id, severity, file, title }));
    const newOne = { id: "S1", severity: "P2", file: "src/x.ts", title: "a defect nobody accepted" };
    const sameHead = new Set([latest.reviewedHeadSha]);
    expect(shipReviewFixes([...r1, newOne], accepted, sameHead)).toEqual([newOne]);
    // By findingId too, on a descendant head of the same lineage.
    expect(shipReviewFixes(latest.findings, ledger.acceptedResiduals, new Set(["c0ffee", latest.reviewedHeadSha]))).toEqual([]);
    // A rewritten history (accepted headSha not an ancestor) has lapsed: re-review.
    expect(shipReviewFixes(r1, accepted, new Set(["c0ffee"]))).toEqual(r1);
  });
});

describe("blueprint cap rule — the prose carries what the replay encodes", () => {
  const reviewer = blueprint("code-reviewer");
  const rm = blueprint("release-manager");
  const operator = blueprint("operator");

  it("code-reviewer: maxRounds + reviewerCap from gate-meta with the hub's defaults, residuals before the report", async () => {
    const { REVIEW_GATE_CAP_DEFAULTS } = await import("./workflow-defs");
    expect(reviewer).toMatch(/`gate-meta: \{…\}` JSON line/);
    expect(reviewer).toContain("Take `maxRounds` and\n`reviewerCap` `{floor, action}` from it.");
    expect(reviewer).toContain(`\`maxRounds\` ${REVIEW_GATE_CAP_DEFAULTS.maxRounds}, \`reviewerCap\`\n\`{floor: "P2", action: "pass_with_followups"}\``);
    expect(reviewer).toContain('review_verdict="PASS-with-follow-ups"');
    expect(reviewer).toContain('decidedBy: "auto-pass-floor"');
    expect(reviewer).toContain("Write `acceptedResiduals[]` into `shared/ship-review-state.json` FIRST");
    expect(reviewer).toContain("`## Accepted (not re-filed)`");
    expect(reviewer).toContain("git merge-base --is-ancestor");
    expect(reviewer).toContain("DECISION OPTIONS: continue | accept-as-known");
    // The hardcoded third round is gone.
    expect(reviewer).not.toMatch(/THIRD CHANGES NEEDED round|after 3 rounds|, round 3\)/);
  });

  it("release-manager: reads/writes acceptedResiduals, human accept is human:<who>, never re-files on the lineage", () => {
    expect(rm).toContain("**Accepted residuals (`acceptedResiduals[]` in the ledger).**");
    expect(rm).toContain("`{findingId, severity, rationale, decidedBy, decidedAt, round, headSha}`");
    expect(rm).toContain('decidedBy: "human:<who>"');
    expect(rm).toContain("**Never file a fix for it**, in any round\nincluding ship-review r1");
    expect(rm).toContain("re-filed them as TEAM-5142");
    expect(rm).toContain('review_verdict="PASS-with-known-findings"');
  });

  it("operator: B5 rounds from gate-meta, accepted residuals are not NEEDS YOUR ATTENTION", () => {
    expect(operator).toContain("### B5. RESPONSE + RE-CHECK (rounds from gate-meta)");
    expect(operator).not.toMatch(/max 2 rounds|after round 2/);
    // The operator keeps its OWN prior default (2) when gate-meta carries no
    // maxRounds — unlike the code reviewer, whose default is 3 (REVIEW_GATE_CAP_DEFAULTS).
    expect(operator).toContain("use `maxRounds` 2");
    expect(operator).toContain('decidedBy: "auto-pass-floor"');
    expect(operator).toContain('`decidedBy: "human:<who>"`');
  });

  it("every human acceptance cites its gate and its recorded decider (TEAM-5340 F1)", () => {
    expect(reviewer).toContain('`gateTicketId: "<the escalation\n     gate>"`');
    expect(reviewer).toContain(`\`decidedBy: "human:<the gate's recorded decider>"\``);
    expect(reviewer).toContain("`residual_decision_unverified`");
    expect(rm).toContain("and `gateTicketId` on every `human:` entry");
    expect(rm).toContain("gateTicketId: <the escalation gate>");
    expect(rm).toContain("`<who>` is the gate's recorded decider");
    expect(rm).toContain("(`residual_decision_unverified`)");
    expect(operator).toContain('`gateTicketId: "<the Merge Approval gate>"`');
    expect(operator).toContain("`<who>` is the gate's recorded decider");
    // The decider is read off the twin's decision comment, whose shape is fixed.
    for (const bp of [reviewer, rm, operator]) expect(bp).toContain("`via <channel> (<by>)`");
  });

  it("each blueprint's accept option is one RESIDUAL_ACCEPT_OPTIONS admits, and only accept options are (TEAM-5340 F1)", () => {
    const accepts = [
      [reviewer, "DECISION OPTIONS: continue | accept-as-known", "accept-as-known"],
      [rm, "DECISION OPTIONS: continue | merge-with-known-findings | cancel", "merge-with-known-findings"],
      [operator, "DECISION OPTIONS: approve | approve-with-known-findings", "approve-with-known-findings"],
    ] as const;
    for (const [bp, line, option] of accepts) {
      expect(bp).toContain(line);
      expect(out.RESIDUAL_ACCEPT_OPTIONS).toContain(option);
    }
    expect([...out.RESIDUAL_ACCEPT_OPTIONS].sort()).toEqual(accepts.map(([, , o]) => o).sort());
    for (const notAccept of ["continue", "cancel", "approve"]) expect(out.RESIDUAL_ACCEPT_OPTIONS).not.toContain(notAccept);
  });

  it("the blocked record matches dead-session-detector's reader: key and fields", () => {
    const detector = readFileSync(resolve(root, "lambda/orchestrator/dead-session-detector.mjs"), "utf8");
    expect(detector).toContain("readArtifactJson(`workflows/${workflow.id}/agents/${agentId}/${ticketId}-blocked.json`)");
    expect(detector).toMatch(/record\.ticketId === ticketId/);
    expect(detector).toMatch(/record\?\.blockedAt/);
    for (const [name, agent] of [
      ["release-manager", "agentcore_hub_release_manager"],
      ["ci-agent", "agentcore_hub_ci_agent"],
      ["qa-verifier", "agentcore_hub_qa_verifier"],
      ["operator", "agentcore_hub_operator"],
    ] as const) {
      const text = blueprint(name);
      expect(text, name).toContain(`\`workflows/{workflow_id}/agents/${agent}/{ticket_id}-blocked.json\``);
      expect(text, name).not.toMatch(/shared\/[^\s`]*BLOCKED-/);
      if (name === "operator") {
        expect(text).toContain("`{ticketId, agentId: \"agentcore_hub_operator\", workflowId, reason,\n   blockedAt, evidence[]}`");
        continue;
      }
      const example = /`(\{"ticketId":[^`]*\})`/.exec(text)?.[1];
      expect(example, name).toBeDefined();
      const record = JSON.parse(example!);
      expect(Object.keys(record).sort(), name).toEqual(["agentId", "blockedAt", "evidence", "reason", "ticketId", "workflowId"]);
      expect(record.agentId).toBe(agent);
      expect(Array.isArray(record.evidence)).toBe(true);
    }
  });
});
