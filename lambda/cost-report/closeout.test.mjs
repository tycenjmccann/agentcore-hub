// TEAM-5359 FR-4 — the card counts only tasks an agent ran, and a run closed out
// over un-evidenced tickets scores as "cancelled".
//
// The znl7a4 case reads the committed close-out fixtures under
// lambda/orchestrator/fixtures/ (exported read-only from the real run; see that
// README). Its stop left Ship/CD/QA tickets that no agent ever ran, which the
// operator close then force-Done'd: v10 counted them as completed first-pass work.
//
// Importing index.mjs evaluates its top-level `@aws-sdk/*` imports; see
// pricing.test.mjs's header for why that is safe offline and never ships.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

import {
  KPI_CONFIG,
  cardOutcome,
  closeoutOverrideOf,
  computeAgentTasks,
  computeKpi,
  dedupeEvents,
  invokedTaskCounts,
  wasInvoked,
} from "./index.mjs";
import { canonicalJson, offenderSetHash } from "./proof-record-verify.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../orchestrator/fixtures/${name}`, import.meta.url), "utf8"));
const isHuman = (a) => !a || /^human/i.test(String(a));

describe("znl7a4: never-invoked tickets are excluded, not counted", () => {
  const workflow = fixture("workflow-znl7a4.json");
  const events = dedupeEvents(fixture("events-znl7a4.json"));
  const completions = fixture("znl7a4-completions.json");
  const aiTasks = computeAgentTasks(workflow, events).filter((t) => !isHuman(t.agentId));
  const counts = invokedTaskCounts(aiTasks, new Set(Object.keys(completions)));

  // The ticket's five, plus the six open follow-ups the operator close also
  // force-Done'd. Every one has zero invoke instants and no completion record.
  const NAMED = ["TEAM-5326", "TEAM-5327", "TEAM-5328", "TEAM-5330", "TEAM-5331"];
  const FOLLOW_UPS = ["TEAM-5334", "TEAM-5341", "TEAM-5342", "TEAM-5344", "TEAM-5349", "TEAM-5351"];

  test("the fixture really has no invoke and no record for the named tickets", () => {
    for (const id of NAMED) {
      const t = aiTasks.find((x) => x.ticketId === id);
      assert.ok(t, `${id} is an agent task on the row`);
      assert.equal(t.invokeEvents, 0, `${id} invokeEvents`);
      assert.equal(completions[id], undefined, `${id} has no completion record`);
      assert.equal(t.status, "complete", `${id} was force-Done on the row`);
    }
  });

  test("excluded.neverInvoked lists them; tasksCompleted and firstPass leave them out", () => {
    assert.deepEqual(counts.neverInvoked, [...NAMED, ...FOLLOW_UPS].sort());
    assert.equal(aiTasks.length, 29);
    assert.equal(counts.invoked, 18);
    assert.equal(counts.tasksCompleted, 18, "v10 counted all 29");
    const invoked = aiTasks.filter((t) => !counts.neverInvoked.includes(t.ticketId));
    const firstPass = invoked.filter((t) => t.reworkRounds === 0).length;
    assert.equal(counts.firstPass, firstPass);
    // Denominator = invoked tasks only.
    assert.equal(counts.firstPassYield, Math.round((firstPass / 18) * 10000) / 10000);
    for (const id of NAMED) assert.ok(!invoked.some((t) => t.ticketId === id));
  });

  test("TEAM-5325 (8 invokes, no record: live at the stop) still counts as invoked", () => {
    const t = aiTasks.find((x) => x.ticketId === "TEAM-5325");
    assert.ok(t.invokeEvents > 0);
    assert.ok(!counts.neverInvoked.includes("TEAM-5325"));
  });
});

describe("wasInvoked", () => {
  const task = (over) => ({ ticketId: "T-1", agentId: "agentcore_hub_x", status: "complete", reworkRounds: 0, invokeEvents: 0, ...over });

  test("a stamped startedAt is not an invoke: the display fallback never counts", () => {
    const [t] = computeAgentTasks({ agentTasks: { "T-1": { agentId: "a", status: "complete", startedAt: "2026-10-05T00:00:00Z" } } }, []);
    assert.equal(t.invocations, 1, "display fallback kept");
    assert.equal(t.invokeEvents, 0);
    assert.equal(wasInvoked(t, new Set()), false);
  });

  test("one invoke instant, or a completion record alone, makes it invoked", () => {
    assert.equal(wasInvoked(task({ invokeEvents: 1 }), new Set()), true);
    assert.equal(wasInvoked(task(), new Set(["T-1"])), true);
    assert.equal(wasInvoked(task(), new Set(["T-2"])), false);
  });

  test("no invoked tasks → firstPassYield null, not 0", () => {
    const c = invokedTaskCounts([task(), task({ ticketId: "T-2" })]);
    assert.deepEqual(c, { invoked: 0, tasksCompleted: 0, firstPass: 0, firstPassYield: null, neverInvoked: ["T-1", "T-2"] });
  });
});

// Lifecycle table: the override file as the card reads it → outcome → cap. Only a
// signed override for THIS run counts (DL-036); anything else is a gap note.
describe("closeout override → outcome → cap", () => {
  const KEY = "test-gate-key";
  const WF = "wf_1";
  const keys = async () => ({ ok: true, keys: [KEY] });
  const signed = (offenders, { key = KEY, ...extra } = {}) => {
    const rec = { by: "human:ops", reason: "closed out after stop", offenders, at: "2026-10-05T21:40:00Z", v: 1, kind: "closeout-override", workflowId: WF, offenderSetHash: offenderSetHash(offenders), ...extra };
    return JSON.stringify({ ...rec, sig: createHmac("sha256", key).update(canonicalJson(rec)).digest("base64url") });
  };
  const unsigned = JSON.stringify({ by: "human:ops", reason: "closed out after stop", offenders: ["TEAM-5326"], at: "2026-10-05T21:40:00Z" });
  // clean-run's inputs (scores 100 uncapped), so the cap is the only variable.
  const cleanCard = (outcome) => ({
    generatedAt: "2026-10-05T22:00:00.000Z", run: { outcome }, cost: { totalUsd: 1 },
    time: { humanGates: 2 },
    quality: {
      tasks: 10, reworkRounds: 0, firstPassYield: 1, loops: 0, errors: 0, nudges: 0, interventions: 0,
      gateRounds: 2, ci: { verdict: "pass", source: "completion:certified", ticketId: "T" },
    },
    dataQuality: { costMissing: false },
  });
  const CAP = { kind: "outcome", outcome: "cancelled", cap: KPI_CONFIG.outcomeCaps.cancelled };

  // [label, phase, file, keys, outcome, gap?]
  const ROWS = [
    ["absent (no file)", "complete", null, keys, "complete", false],
    ["unparseable JSON", "complete", "{not json", keys, "complete", true],
    ["a JSON array", "complete", "[]", keys, "complete", true],
    ["unsigned (the TEAM-5359 shape)", "complete", unsigned, keys, "complete", true],
    ["sig \"invalid\"", "complete", JSON.stringify({ ...JSON.parse(signed(["TEAM-5326"])), sig: "invalid" }), keys, "complete", true],
    ["forged (another key)", "complete", signed(["TEAM-5326"], { key: "other" }), keys, "complete", true],
    ["workflowId \"wrong\"", "complete", signed(["TEAM-5326"], { workflowId: "wrong" }), keys, "complete", true],
    ["offenders edited after signing", "complete", JSON.stringify({ ...JSON.parse(signed([])), offenders: ["TEAM-5326"] }), keys, "complete", true],
    ["signed, no key to verify it", "complete", signed(["TEAM-5326"]), async () => ({ ok: false, why: "decision_key_unavailable" }), "complete", true],
    ["signed, offenders []", "complete", signed([]), keys, "complete", false],
    ["signed, offenders > 0", "complete", signed(["TEAM-5326"]), keys, "cancelled", false],
    ["phase cancelled, no file", "cancelled", null, keys, "cancelled", false],
  ];
  for (const [label, phase, file, loadKeys, want, gap] of ROWS) {
    test(`${label} → ${want}${want === "cancelled" ? ` (cap ${CAP.cap})` : " (no cap)"}${gap ? " + gap note" : ""}`, async () => {
      const gaps = [];
      const outcome = cardOutcome(phase, await closeoutOverrideOf(file, loadKeys, WF, gaps));
      assert.equal(outcome, want);
      assert.equal(gaps.length, gap ? 1 : 0);
      if (gap) assert.match(gaps[0], /closeout-override\.json present but unverifiable .* outcome taken from phase alone/);
      const kpi = computeKpi(cleanCard(outcome), KPI_CONFIG);
      assert.equal(kpi.score, want === "cancelled" ? CAP.cap : 100);
      assert.deepEqual(kpi.capsApplied, want === "cancelled" ? [CAP] : []);
    });
  }

  test("absent file → no key load", async () => {
    let loads = 0;
    assert.equal(await closeoutOverrideOf(null, async () => { loads++; return { ok: true, keys: [KEY] }; }, WF, []), null);
    assert.equal(loads, 0);
  });

  test("a verified override carries the shared fields, offenders as strings", async () => {
    const o = await closeoutOverrideOf(signed(["TEAM-5326"]), keys, WF, []);
    assert.deepEqual(o, { by: "human:ops", reason: "closed out after stop", offenders: ["TEAM-5326"], at: "2026-10-05T21:40:00Z", offenderSetHash: offenderSetHash(["TEAM-5326"]) });
  });

  test("the cap is kpi.json's, not a literal here", () => {
    assert.equal(CAP.cap, 69);
  });
});
