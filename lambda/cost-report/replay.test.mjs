// TEAM-5428 acceptance: four real runs, trimmed (fixtures/README.md), replayed
// through the production quality path — dedupeEvents → computeAgentTasks →
// deriveCiVerdict → completionRecordSet → assembleQuality → computeKpi — with
// the S3 completion reads served from the fixture. No AWS.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  KPI_CONFIG,
  assembleQuality,
  completionRecordSet,
  computeAgentTasks,
  computeKpi,
  dedupeEvents,
  deriveCiVerdict,
} from "./index.mjs";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/replay-${name}.json`, import.meta.url), "utf8"));

async function replay(name) {
  const fx = load(name);
  const getCompletion = async (id) => fx.completions[id] ?? null;
  const events = dedupeEvents(fx.events);
  const agentTasks = computeAgentTasks(fx.workflow, events);
  const aiTasks = agentTasks.filter((t) => !t.agentId.startsWith("human"));
  const ci = await deriveCiVerdict(fx.workflow, agentTasks, getCompletion, []);
  const hasRecord = await completionRecordSet(events, aiTasks, getCompletion, []);
  const { outcome, delivery, quality } = assembleQuality(fx.workflow, events, agentTasks, { hasRecord, ci });
  const card = {
    run: { phase: fx.workflow.phase, outcome },
    time: { humanGates: events.filter((e) => e.type === "review.needed").length },
    quality,
    dataQuality: { costMissing: false },
  };
  return { outcome, delivery, quality, kpi: computeKpi(card, KPI_CONFIG) };
}

describe("replay — real runs, trimmed", () => {
  test("rfq233 (cancelled, 63/D before): capped at 40/F; cascade closures and comments visible, not counted", async () => {
    const r = await replay("rfq233");
    assert.equal(r.outcome, "cancelled");
    assert.ok(r.kpi.score <= 40, `score ${r.kpi.score}`);
    assert.equal(r.kpi.grade, "F");
    assert.deepStrictEqual(r.kpi.capsApplied, [{ kind: "outcome", outcome: "cancelled", cap: 40 }]);
    assert.equal(r.quality.tasksClosedWithoutWork, 17); // DEVIATION D3: 19 closures − 2 human gates
    assert.equal(r.quality.interventions, 0); // DEVIATION D2
    assert.deepStrictEqual(r.quality.interventionsDetail.map((i) => [i.action, i.counted]),
      [["comment", false], ["comment", false], ["comment", false], ["comment", false]]);
    assert.equal(r.delivery.mergedSha, null);
    assert.ok(r.delivery.prNumbers.includes(807));
    assert.equal(r.delivery.deployed, false);
  });

  test("znl7a4 (operator close-out, no merge): stopped, capped at 40/F", async () => {
    const r = await replay("znl7a4");
    assert.equal(r.outcome, "stopped"); // DEVIATION D1
    assert.ok(r.kpi.score <= 40, `score ${r.kpi.score}`);
    assert.equal(r.kpi.grade, "F");
    assert.equal(r.delivery.mergedSha, null);
  });

  test("c3x6k1 (merged + deployed): complete, unchanged from its live card (68)", async () => {
    const r = await replay("c3x6k1");
    assert.equal(r.outcome, "complete");
    assert.ok(Math.abs(r.kpi.score - 68) <= 1, `score ${r.kpi.score}`);
    assert.deepStrictEqual(r.kpi.capsApplied, []);
    assert.equal(r.delivery.mergedSha, "1087ed9831c4cf90088e15cfca6a1fc099f76ffa");
    assert.equal(r.delivery.deployed, true);
    assert.equal(r.quality.tasksClosedWithoutWork, 0);
  });

  test("v51wtn (clean merged run): complete, unchanged from its live card (100)", async () => {
    const r = await replay("v51wtn"); // DEVIATION D4: baseline is the live card, not 91
    assert.equal(r.outcome, "complete");
    assert.ok(Math.abs(r.kpi.score - 100) <= 1, `score ${r.kpi.score}`);
    assert.equal(r.kpi.grade, "A");
    assert.equal(r.delivery.deployed, true);
  });
});
