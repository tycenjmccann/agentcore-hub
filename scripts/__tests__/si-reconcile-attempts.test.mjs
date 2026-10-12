// scripts/si-reconcile-attempts.mjs (TEAM-5591).
//
// selectReconcilable is pure and tested offline. reconcile() is driven through
// the REAL analyzer stampSiAttempt and the REAL SiLedger over an in-memory
// table, with S3 serving the real cd-ledger / ship-record bodies from
// lambda/workflow-analyzer/fixtures — only the transport is fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { selectReconcilable, reconcile, renderReport } from "../si-reconcile-attempts.mjs";

process.env.AWS_REGION ||= "us-east-1";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../../lambda/workflow-analyzer/fixtures/si-evidence-${name}.json`, import.meta.url), "utf8"));

const ERROR_NOTE = "run reached complete with no merge evidence — nothing shipped, the ask is still owed (phase=complete, delivery=cd, PRs=#826, cd-ledger=absent)";

function fakeDdb(rows) {
  const items = new Map(rows.map((r) => [r.patternKey, r]));
  return {
    items,
    puts: 0,
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "GetCommand") return { Item: items.get(cmd.input.Key.patternKey) };
      if (name === "PutCommand") {
        this.puts++;
        items.set(cmd.input.Item.patternKey, cmd.input.Item);
        return {};
      }
      if (name === "ScanCommand") return { Items: [...items.values()] };
      throw new Error(`fakeDdb: unexpected ${name}`);
    },
  };
}

/** Serves every fixture's cd-ledger + ship record at its real key; else 404. */
function fixtureS3(fixtures) {
  const objects = {};
  for (const fx of fixtures) {
    objects[fx.cdLedger.key] = { body: fx.cdLedger.body, lastModified: new Date(fx.cdLedger.lastModified) };
    if (fx.shipRecord) objects[fx.shipRecord.key] = { body: fx.shipRecord.body };
  }
  return {
    async send(cmd) {
      const o = objects[cmd.input.Key];
      if (!o) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return { LastModified: o.lastModified, Body: { transformToString: async () => o.body } };
    },
  };
}

async function world() {
  const { stampSiAttempt } = await import("../../lambda/workflow-analyzer/index.mjs");
  const { SiLedger, newRow, applyAttempt } = await import("../../lambda/workflow-analyzer/si-ledger.mjs");
  const runs = ["db9sx9", "nmc86c", "17w716", "j2cawv"].map(fixture);
  const rows = [];
  for (const fx of runs) {
    const si = fx.workflow.input?.si;
    for (const key of si?.patternKeys || []) {
      const seeded = applyAttempt(newRow({ patternKey: key, title: key, at: "2026-10-08T00:00:00.000Z" }), {
        prdKey: si.prdKey, workflowId: fx.workflowId, epicId: fx.workflow.epicId, outcome: "in-run",
      });
      rows.push(applyAttempt(seeded, { prdKey: si.prdKey, workflowId: fx.workflowId, outcome: "error", note: ERROR_NOTE }));
    }
  }
  const ddb = fakeDdb(rows);
  const workflows = new Map(runs.map((fx) => [fx.workflowId, fx.workflow]));
  return {
    ddb,
    runs,
    args: (extra = {}) => ({
      ledger: new SiLedger({ ddb, table: "test-si-ledger" }),
      getWorkflow: async (id) => structuredClone(workflows.get(id)),
      s3: fixtureS3(runs),
      bucket: "test-bucket",
      deps: { stampSiAttempt, applyAttempt },
      ...extra,
    }),
  };
}

const quiet = async (fn) => {
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, real);
  }
};

test("selectReconcilable: newest-attempt error rows, grouped by run", () => {
  const rows = [
    { patternKey: "a.b", attempts: [{ workflowId: "wf1", outcome: "error" }] },
    { patternKey: "c.d", attempts: [{ workflowId: "wf1", outcome: "error" }] },
    { patternKey: "e.f", attempts: [{ workflowId: "wf1", outcome: "error" }, { workflowId: "wf2", outcome: "deployed" }] },
    { patternKey: "g.h", attempts: [] },
  ];
  assert.deepEqual(selectReconcilable(rows), [{ workflowId: "wf1", keys: ["a.b", "c.d"] }]);
  assert.deepEqual(selectReconcilable(rows, { workflowId: "wf2" }), [{ workflowId: "wf2", keys: [] }]);
});

test("dry run: the four real runs resolve to deployed and nothing is written", async () => {
  const w = await world();
  const before = JSON.stringify([...w.ddb.items.values()]);
  const report = await quiet(() => reconcile(w.args()));
  assert.equal(w.ddb.puts, 0, "a dry run never writes");
  assert.equal(JSON.stringify([...w.ddb.items.values()]), before);

  const by = Object.fromEntries(report.map((r) => [r.workflowId, r]));
  assert.equal(by.wf_1791496207928_db9sx9.outcome, "deployed");
  assert.equal(by.wf_1791496207928_db9sx9.attempt.deployedAt, "2026-10-09T08:33:23.000Z");
  assert.deepEqual(by.wf_1791496207928_db9sx9.attempt.prNumbers, [828]);
  assert.deepEqual([...by.wf_1791496210209_nmc86c.stamped].sort(), ["intake.scope", "orchestrator.verdict-blind-flow"]);
  assert.equal(by.wf_1791496210944_17w716.outcome, "deployed");
  assert.equal(by.wf_1791571939518_j2cawv, undefined, "j2cawv carried no input.si — nothing on the ledger names it");
  assert.match(renderReport(report, { apply: false }), /DRY RUN/);
});

test("--apply flips the attempts to deployed, and a second apply changes nothing", async () => {
  const w = await world();
  await quiet(() => reconcile(w.args({ apply: true })));
  const a = w.ddb.items.get("orchestrator.cascade-gap");
  assert.equal(a.status, "deployed");
  assert.equal(a.attempts.length, 1, "the error attempt is re-stamped, not duplicated");
  assert.equal(a.attempts[0].outcome, "deployed");
  assert.equal(a.attempts[0].deployedAt, "2026-10-09T08:33:23.000Z");
  assert.deepEqual(a.attempts[0].prNumbers, [828]);
  for (const key of ["orchestrator.verdict-blind-flow", "intake.scope", "metrics.card.time-blind-spot"]) {
    assert.equal(w.ddb.items.get(key).attempts.at(-1).outcome, "deployed", key);
  }
  const after = JSON.stringify([...w.ddb.items.values()]);
  const second = await quiet(() => reconcile(w.args({ apply: true })));
  assert.deepEqual(second, [], "nothing is error any more, so nothing is selected");
  assert.equal(JSON.stringify([...w.ddb.items.values()]), after);
});

test("a key whose newest attempt moved on is refused, and a non-complete run is skipped", async () => {
  const w = await world();
  // intake.scope gets a newer, deployed attempt from another run: re-stamping nmc86c must not touch it.
  const row = w.ddb.items.get("intake.scope");
  row.attempts.push({ prdKey: "later", workflowId: "wf_later", outcome: "deployed", deployedAt: "2026-10-11T00:00:00.000Z" });
  row.status = "deployed";
  const report = await quiet(() => reconcile(w.args({ apply: true, workflowId: "wf_1791496210209_nmc86c" })));
  assert.deepEqual(report[0].stamped, ["orchestrator.verdict-blind-flow"]);
  assert.deepEqual(report[0].failed, ["intake.scope"]);
  assert.equal(w.ddb.items.get("intake.scope").attempts.at(-1).workflowId, "wf_later");

  const w2 = await world();
  const args = w2.args({ apply: true });
  const real = args.getWorkflow;
  args.getWorkflow = async (id) => ({ ...(await real(id)), phase: "deploy-blocked" });
  const skipped = await quiet(() => reconcile(args));
  assert.ok(skipped.every((r) => /not complete/.test(r.skipped)));
  assert.equal(w2.ddb.puts, 0);
});

test("a run whose evidence still resolves to error is not rewritten", async () => {
  const w = await world();
  const args = w.args({ apply: true, workflowId: "wf_1791496207928_db9sx9" });
  args.s3 = fixtureS3([]); // every probe 404s
  const [r] = await quiet(() => reconcile(args));
  assert.equal(r.outcome, "error");
  assert.deepEqual(r.stamped, []);
  assert.deepEqual(r.failed, ["orchestrator.cascade-gap"]);
  assert.equal(w.ddb.puts, 0);
  assert.equal(w.ddb.items.get("orchestrator.cascade-gap").attempts.at(-1).note, ERROR_NOTE);
});
