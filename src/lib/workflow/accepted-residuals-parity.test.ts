import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as out from "../../../lambda/workflow-output/index.mjs";
import { fingerprintFinding } from "../../../lambda/orchestrator/review-cap.mjs";

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
  const blocking = findings.some((f) => ABOVE_FLOOR.has(f.severity) || f.classification === "REGRESSION-OF-FIX");
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
