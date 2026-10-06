// READ-ONLY fixture export for replay-closeout.test.mjs (TEAM-5359, wf_1791311636588_rfq233).
// Modelled on export3.cjs / export4.cjs (s3://$ARTIFACT_BUCKET/workflows/wf_1791220686225_znl7a4/shared/fixtures/):
// GetItem on agentcore-hub-workflows, Query on agentcore-hub-events, GetObject on S3. No writes to any AWS resource.
// Same redaction as export3.cjs. Events are de-duplicated on type + detail.timestamp (lifecycle events are
// stored twice under two eventId shapes) and agent.streaming rows are dropped (no replay assertion reads them).
//
//   ARTIFACT_BUCKET=<bucket> node lambda/orchestrator/fixtures/export-closeout.cjs
//
// Writes workflow-<run>.json, events-<run>.json, <run>-completions.json next to this file for every run in
// RUNS, then (re)writes closeout-manifest.json summarising EVERY run present here (including the TEAM-5259
// files copied verbatim from the S3 staging export). `--summary-only` skips AWS and rewrites the manifest.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs"); const path = require("path");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1", maxAttempts: 2 }));
const s3 = new S3Client({ region: "us-east-1", maxAttempts: 2 });
const BUCKET = process.env.ARTIFACT_BUCKET;
const OUT = __dirname;
const RUNS = { "TEAM-5226": "wf_bug_TEAM-5226", "znl7a4": "wf_1791220686225_znl7a4", "o1l3to": "wf_1791197897608_o1l3to" };
const SUMMARY = ["TEAM-5259", ...Object.keys(RUNS)];
function redactStr(s) { return s
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "redacted@example.com")
  .replace(/\b\d{12}\b/g, "000000000000")
  .replace(/(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "$1_REDACTED")
  .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_REDACTED")
  .replace(/AKIA[0-9A-Z]{16}/g, "AKIAREDACTED00000000")
  .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "000000:TELEGRAM_TOKEN_REDACTED")
  .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer REDACTED")
  .replace(/https:\/\/[^\s"']*X-Amz-(Algorithm|Signature)[^\s"']*/g, "https://presigned.redacted.example/")
  .replace(/(?<![\w_-])\+\d{10,15}\b/g, "+10000000000")
  .replace(/\b(chat(?:[ _]?id)?|from(?:[ _]?id)?)([\s:=#"']{0,4})-?\d{6,}/gi, "$1$2REDACTED"); }
const CHAT_KEYS = /^(chatId|chat_id|telegramChatId|telegram_chat_id|fromId|from_id|telegramUserId|phone|phoneNumber|phone_number)$/i;
function redact(v) { if (v == null) return v; if (typeof v === "string") return redactStr(v); if (Array.isArray(v)) return v.map(redact);
  if (typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = CHAT_KEYS.test(k) ? "REDACTED" : redact(x); return o; } return v; }
const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(redact(obj), null, 2) + "\n");
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(OUT, name), "utf8")); } catch { return null; } };
async function body(Key) { const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key })); return await r.Body.transformToString(); }
const ts = (e) => e.detail?.timestamp || e.timestamp || "";
const tid = (e) => e.detail?.ticketId || e.detail?.ticket?.id || null;

function dedupe(events) {
  const seen = new Set(); const out = [];
  for (const e of events) {
    if (e.type === "agent.streaming") continue;
    const k = `${e.type}|${ts(e)}|${tid(e) || ""}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(e);
  }
  return out.sort((a, b) => ts(a).localeCompare(ts(b)));
}

/** Board at the moment the run was stopped. A ticket is done-at-stop only if its first agent.complete precedes
 *  the stop. The stop is the first workflow.cancelled (the burst after it is the cancel's Jira Done fallback);
 *  a run closed WITHOUT a cancel (operator force-close) stops at the start of the Done burst (consecutive
 *  agent.complete <= BURST_GAP_MS apart) that lies within BURST_NEAR_MS of its workflow.complete, on either
 *  side (the console may write the terminal row before or after it forces the children Done). */
const BURST_GAP_MS = 15_000, BURST_NEAR_MS = 60_000;
function forceCloseBurstStart(events) {
  const complete = events.find((e) => e.type === "workflow.complete");
  if (!complete) return null;
  const at = Date.parse(ts(complete));
  const done = events.filter((e) => e.type === "agent.complete").map(ts).sort();
  const chains = [];
  for (const t of done) {
    const last = chains[chains.length - 1];
    if (last && Date.parse(t) - Date.parse(last[last.length - 1]) <= BURST_GAP_MS) last.push(t); else chains.push([t]);
  }
  const near = chains.filter((c) => Date.parse(c[0]) - BURST_NEAR_MS <= at && at <= Date.parse(c[c.length - 1]) + BURST_NEAR_MS);
  return near.length ? near[near.length - 1][0] : null;
}

function summarise(run) {
  const wf = read(`workflow-${run}.json`); const ev = read(`events-${run}.json`); const recs = read(`${run}-completions.json`) || {};
  if (!wf || !ev) return { run, missing: true };
  const events = dedupe(ev);
  const created = new Map();
  for (const e of events) if (e.type === "ticket.created" && tid(e) && !created.has(tid(e))) created.set(tid(e), e.detail?.ticket || {});
  const ids = [...new Set([...created.keys(), ...Object.keys(wf.agentTasks || {})])].filter((id) => id !== wf.epicId).sort();
  const cancel = events.find((e) => e.type === "workflow.cancelled");
  const stopAt = cancel ? (cancel.detail?.cancelledAt || ts(cancel)) : forceCloseBurstStart(events);
  const doneAt = new Map();
  for (const e of events) if (e.type === "agent.complete" && tid(e) && !doneAt.has(tid(e))) doneAt.set(tid(e), ts(e));
  const invoked = new Set(events.filter((e) => e.type === "agent.invoked" || e.type === "orchestrator.agent_invoked").map(tid).filter(Boolean));
  const doneBeforeStop = ids.filter((id) => doneAt.has(id) && (!stopAt || doneAt.get(id) < stopAt));
  const nonDoneAtStop = ids.filter((id) => !doneBeforeStop.includes(id));
  // Materialized follow-up tickets (workflow-output followUpsMaterialized.created), with their origin record.
  const followUps = Object.entries(recs).flatMap(([origin, r]) => (r?.followUpsMaterialized?.created || [])
    .map((f) => ({ ticketId: f.ticketId, origin, kind: f.kind, assignee: f.assignee, blockedBy: f.blockedBy || [], openAtStop: nonDoneAtStop.includes(f.ticketId) })));
  return {
    run, workflowId: wf.workflowId || wf.id, epicId: wf.epicId, phase: wf.phase, stopAt, stopKind: cancel ? "workflow.cancelled" : "force-close-burst",
    ticketsCancelledReported: cancel?.detail?.ticketsCancelled ?? null,
    workflowCompleteEvents: events.filter((e) => e.type === "workflow.complete").length,
    tickets: ids.length, doneBeforeStop: doneBeforeStop.length, nonDoneAtStop,
    neverInvoked: ids.filter((id) => !invoked.has(id) && !recs[id]),
    nonDoneHumanGates: nonDoneAtStop.filter((id) => String(wf.agentTasks?.[id]?.agentId || created.get(id)?.assignee || "").startsWith("human:")),
    completionRecords: Object.keys(recs).length, followUps,
    humanNotifications: (wf.humanNotifications || []).map((n) => n.id),
  };
}

(async () => {
  const log = [`export-closeout started ${new Date().toISOString()} (read-only: GetItem/Query, S3 Get)`];
  const summaryOnly = process.argv.includes("--summary-only");
  if (!BUCKET && !summaryOnly) throw new Error("ARTIFACT_BUCKET unset");
  for (const [run, wfId] of summaryOnly ? [] : Object.entries(RUNS)) {
    const wf = (await ddb.send(new GetCommand({ TableName: "agentcore-hub-workflows", Key: { workflowId: wfId } }))).Item;
    if (!wf) { log.push(`${run}: no workflows row for ${wfId}`); continue; }
    write(`workflow-${run}.json`, wf);
    let ev = [], k; do { const r = await ddb.send(new QueryCommand({ TableName: "agentcore-hub-events", KeyConditionExpression: "workflowId = :w", ExpressionAttributeValues: { ":w": wfId }, ExclusiveStartKey: k })); ev = ev.concat(r.Items || []); k = r.LastEvaluatedKey; } while (k && ev.length < 50000);
    const kept = dedupe(ev);
    write(`events-${run}.json`, kept);
    const ids = [...new Set([wf.epicId, ...Object.keys(wf.agentTasks || {})])].filter(Boolean).sort();
    const recs = {}; const missing = [];
    for (const id of ids) {
      try { recs[id] = JSON.parse(await body(`completions/${id}.json`)); } catch (e) { missing.push(`${id}:${e.name}`); }
    }
    write(`${run}-completions.json`, recs);
    let override = "absent";
    try { await body(`workflows/${wfId}/shared/closeout-override.json`); override = "present"; } catch (e) { override = `absent (${e.name})`; }
    log.push(`${run} ${wfId}: phase=${wf.phase} agentTasks=${Object.keys(wf.agentTasks || {}).length} events raw=${ev.length} kept=${kept.length} completions=${Object.keys(recs).length}/${ids.length} closeout-override=${override}`);
  }
  const manifest = { generatedAt: new Date().toISOString(), runs: SUMMARY.map(summarise) };
  write("closeout-manifest.json", manifest);
  for (const r of manifest.runs) log.push(`${r.run}: stop=${r.stopKind}@${r.stopAt} tickets=${r.tickets} doneBeforeStop=${r.doneBeforeStop} nonDoneAtStop=${r.nonDoneAtStop?.length} (human gates ${r.nonDoneHumanGates?.length}) neverInvoked=${r.neverInvoked?.length} followUps=${r.followUps?.length} (open at stop ${r.followUps?.filter((f) => f.openAtStop).length}) workflow.complete=${r.workflowCompleteEvents}`);
  const text = log.map(redactStr).join("\n") + "\n";
  fs.appendFileSync(path.join(OUT, "EXPORT-LOG.txt"), "\n--- export-closeout.cjs ---\n" + text); console.log(text);
})().catch((e) => { console.error("FATAL", e.name, e.message); process.exit(1); });
