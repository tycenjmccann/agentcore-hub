// scripts/si-reconcile-attempts.mjs (TEAM-5591).
//
// selectReconcilable is pure and tested offline. reconcile() is driven through
// the REAL analyzer stampSiAttempt and the REAL SiLedger over an in-memory
// table, with S3 serving the real cd-ledger / ship-record bodies from
// lambda/workflow-analyzer/fixtures — only the transport is fake.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

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
      // Copies, like the real service: a caller's view of a row never aliases the table.
      if (name === "GetCommand") {
        const item = structuredClone(items.get(cmd.input.Key.patternKey));
        this.afterGet?.(cmd.input.Key.patternKey);
        return { Item: item };
      }
      if (name === "PutCommand") {
        // TEAM-5770: honour the `#aN = :vN AND …` condition SiLedger.putIfUnchanged
        // builds, the way DynamoDB does — any attribute changed since the read fails it.
        const { ConditionExpression: cond, ExpressionAttributeNames: n, ExpressionAttributeValues: v } = cmd.input;
        if (cond) {
          const cur = items.get(cmd.input.Item.patternKey) || {};
          for (const clause of cond.split(" AND ")) {
            const [a, b] = clause.split(" = ");
            if (!isDeepStrictEqual(cur[n[a]], v[b])) {
              throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
            }
          }
        }
        this.puts++;
        items.set(cmd.input.Item.patternKey, cmd.input.Item);
        return {};
      }
      if (name === "ScanCommand") return { Items: structuredClone([...items.values()]) };
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

test("a newer attempt appended after the scan is re-read and refused — the row's status is never dragged back", async () => {
  // Reviewer repro: select wf-old's error attempt, then (before the write) a
  // newer run stamps `deployed`; wf-old's evidence resolves to `landed`
  // (ledger gone, ship record present). Without the re-read, applyAttempt
  // would re-stamp wf-old's attempt AND set the row status to `landed`.
  const w = await world();
  const fx = w.runs.find((r) => r.workflowId === "wf_1791496210944_17w716");
  const key = "metrics.card.time-blind-spot";
  const args = w.args({ apply: true, workflowId: fx.workflowId });
  args.s3 = {
    async send(cmd) {
      if (cmd.input.Key !== fx.shipRecord.key) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => fx.shipRecord.body } };
    },
  };
  const list = args.ledger.list.bind(args.ledger);
  args.ledger.list = async () => {
    const rows = await list();
    const row = w.ddb.items.get(key);
    row.attempts.push({ prdKey: "newer-prd", workflowId: "wf-new", outcome: "deployed", deployedAt: "2026-10-11T00:00:00.000Z", prNumbers: [900] });
    row.status = "deployed";
    return rows;
  };
  const [r] = await quiet(() => reconcile(args));
  assert.equal(r.outcome, "landed", "the evidence alone would have stamped landed");
  assert.deepEqual(r.stamped, []);
  assert.deepEqual(r.failed, [key]);
  assert.equal(w.ddb.puts, 0);
  const row = w.ddb.items.get(key);
  assert.equal(row.status, "deployed");
  assert.equal(row.attempts.at(-1).workflowId, "wf-new");
  assert.equal(row.attempts.find((a) => a.workflowId === fx.workflowId).outcome, "error");
});

test("movedOn: only this run's own newest error attempt is writable", async () => {
  const { movedOn } = await import("../si-reconcile-attempts.mjs");
  const row = (...attempts) => ({ attempts });
  const at = { workflowId: "wf1", prdKey: "p1" };
  assert.equal(movedOn(row({ ...at, outcome: "error" }), at), null);
  assert.match(movedOn(row({ ...at, outcome: "error" }, { workflowId: "wf2", prdKey: "p2", outcome: "deployed" }), at), /run wf2/);
  assert.match(movedOn(row({ ...at, outcome: "landed" }), at), /now landed/);
  assert.match(movedOn(row({ workflowId: "wf1", prdKey: "other", outcome: "error" }), at), /PRD other/);
  assert.match(movedOn(row(), at), /no attempt/);
});

// ── TEAM-5770: attempts stamped while ARTIFACT_BUCKET was unset ─────────────
//
// The live analyzer had no ARTIFACT_BUCKET, so its stamps were `error` with
// `s3://<ARTIFACT_BUCKET unset>/…` probes (and, after the fix, `unknown`). The
// two real cases: 38jt9p, where that attempt is still the row's newest, and
// vp1vlk, where a newer run has since appended an in-run attempt.

const BLIND_NOTE =
  "run reached complete with no merge evidence — nothing shipped, the ask is still owed (phase=complete, delivery=cd, PRs=#828; " +
  "probed: s3://<ARTIFACT_BUCKET unset>/workflows/wf_1791496207928_db9sx9/shared/cd-ledger.json (bucket-unset))";
const DB9 = "wf_1791496207928_db9sx9";
const DB9_KEY = "orchestrator.cascade-gap";

test("a newest bucket-unset error attempt is re-stamped deployed", async () => {
  const w = await world();
  w.ddb.items.get(DB9_KEY).attempts.at(-1).note = BLIND_NOTE;
  const [r] = await quiet(() => reconcile(w.args({ apply: true, workflowId: DB9 })));
  assert.deepEqual(r.stamped, [DB9_KEY]);
  const row = w.ddb.items.get(DB9_KEY);
  assert.equal(row.status, "deployed");
  assert.equal(row.attempts.at(-1).outcome, "deployed");
});

test("an OLDER blind error attempt (vp1vlk shape) is corrected in place; the newer run's status is kept", async () => {
  const w = await world();
  const row = w.ddb.items.get(DB9_KEY);
  row.attempts.at(-1).note = BLIND_NOTE;
  row.attempts.push({ prdKey: "newer-prd", workflowId: "wf-newer", outcome: "in-run", prNumbers: [] });
  row.status = "in-run";

  const selected = selectReconcilable([...w.ddb.items.values()], { workflowId: DB9 });
  assert.deepEqual(selected, [{ workflowId: DB9, keys: [DB9_KEY], historical: [DB9_KEY] }]);

  const [r] = await quiet(() => reconcile(w.args({ apply: true, workflowId: DB9 })));
  assert.equal(r.outcome, "deployed");
  assert.deepEqual(r.stamped, [DB9_KEY]);
  const after = w.ddb.items.get(DB9_KEY);
  assert.equal(after.status, "in-run", "a historical correction must not drag the newer run's status");
  assert.equal(after.attempts.length, 2);
  assert.equal(after.attempts.at(-1).workflowId, "wf-newer");
  const mine = after.attempts.find((a) => a.workflowId === DB9);
  assert.equal(mine.outcome, "deployed");
  assert.equal(mine.deployedAt, "2026-10-09T08:33:23.000Z");
  assert.match(renderReport([r], { apply: true }), /older attempt; row status kept/);
});

test("an older error attempt that was NOT stamped blind is left alone", async () => {
  const w = await world();
  const row = w.ddb.items.get(DB9_KEY);
  row.attempts.push({ prdKey: "newer-prd", workflowId: "wf-newer", outcome: "in-run", prNumbers: [] });
  assert.deepEqual(selectReconcilable([...w.ddb.items.values()], { workflowId: DB9 }), [{ workflowId: DB9, keys: [] }]);
});

test("a newest `unknown` attempt is re-processed", async () => {
  const w = await world();
  const a = w.ddb.items.get(DB9_KEY).attempts.at(-1);
  a.outcome = "unknown";
  w.ddb.items.get(DB9_KEY).status = "in-run";
  const [r] = await quiet(() => reconcile(w.args({ apply: true, workflowId: DB9 })));
  assert.deepEqual(r.stamped, [DB9_KEY]);
  assert.equal(w.ddb.items.get(DB9_KEY).attempts.at(-1).outcome, "deployed");
  assert.equal(w.ddb.items.get(DB9_KEY).status, "deployed");
});

test("no bucket: the dry run logs the ERROR, reports `unknown`, and writes nothing", async () => {
  const w = await world();
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  let report;
  try {
    report = await reconcile(w.args({ bucket: "", workflowId: DB9 }));
  } finally {
    console.error = real;
  }
  assert.equal(report[0].outcome, "unknown");
  assert.deepEqual(report[0].stamped, []);
  assert.equal(w.ddb.puts, 0);
  assert.ok(lines.some((l) => l.includes("si-reconcile: ARTIFACT_BUCKET unset — cannot probe evidence")), lines.join("\n"));
});

test("no bucket: --apply is refused before any AWS call", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const env = { ...process.env, AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "x", AWS_EC2_METADATA_DISABLED: "true" };
  delete env.ARTIFACT_BUCKET;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../si-reconcile-attempts.mjs", import.meta.url)), "--apply"], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--apply needs ARTIFACT_BUCKET/);
});

test("a newer run writing between the guard's read and its put is not overwritten (conditional put)", async () => {
  const w = await world();
  const row = w.ddb.items.get(DB9_KEY);
  row.attempts.at(-1).note = BLIND_NOTE;
  row.attempts.push({ prdKey: "newer-prd", workflowId: "wf-newer", outcome: "in-run", prNumbers: [] });
  row.status = "in-run";
  // The race: the newer run's stamp lands right after the guard re-reads the row.
  w.ddb.afterGet = (key) => {
    w.ddb.afterGet = null;
    const live = w.ddb.items.get(key);
    live.attempts.at(-1).outcome = "deployed";
    live.status = "deployed";
  };

  const [r] = await quiet(() => reconcile(w.args({ apply: true, workflowId: DB9 })));
  assert.deepEqual(r.stamped, []);
  assert.deepEqual(r.failed, [DB9_KEY]);
  assert.equal(w.ddb.puts, 0);
  const after = w.ddb.items.get(DB9_KEY);
  assert.equal(after.status, "deployed", "the newer run's write survives");
  assert.equal(after.attempts.at(-1).outcome, "deployed");
});
