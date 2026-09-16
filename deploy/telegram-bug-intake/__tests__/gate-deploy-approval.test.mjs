/**
 * TEAM-4706 — a `gate:deploy-approval` ticket IS the deploy decision.
 *
 * The bug: one production deploy produced TWO Telegram messages. The pipeline's
 * own 🚀 page really calls codepipeline:PutApprovalResult; the release manager's
 * "Deploy gate" Jira ticket looked identical but its ✅ only transitioned the
 * ticket, leaving CodePipeline parked. On 2026-09-14 a human tapped the inert
 * one and a release stalled 29 hours.
 *
 * The fix: a gate ticket LABELLED `gate:deploy-approval` (+ `pipeline:<name>`,
 * `exec:<uuid>`) pages with the 🚀 kicker and the same brief, and its ✅/❌ moves
 * the PIPELINE first — the ticket only follows a decision CodePipeline took.
 *
 * Invariants, one test each:
 *  (a) ✅ → PutApprovalResult(Approved) THEN the ticket transition, in that order.
 *  (b) PutApprovalResult throws → no transition at all; the message says why.
 *  (c) an OLDER execution parked at the gate is rejected first, then this
 *      execution is approved once it arrives.
 *  (d) a gate ticket WITHOUT the label behaves exactly as before — not one
 *      CodePipeline call.
 *  (e) a cross-account registry entry approves through the assumed trigger role.
 *  (f) the hyphen-mangled label shape (Jira's sanitizeUserLabels) classifies
 *      identically to the colon form — same ping, same approval.
 *  (g) an approval TOKEN never reaches a Telegram message, not even inside an
 *      AWS error string.
 *  (h) the legacy no-ticket path is untouched: a pending approval with no gate
 *      ticket still pages dok/dno and still approves.
 * ❌ has the same ordering discipline as ✅ and keeps the rework-note plumbing.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const CHAT = 555;
const WF = "wf-4706";
const GATE = "TEAM-9001";
const PIPELINE = "hub-widget-deploy";
const REPO = "acme/widget";
const REGION = "us-west-2";
const BUCKET = "test-artifact-bucket";
const CD_REGISTRY_KEY = "config/cd-registry.json";
const SHA = "abc1234def5678";

const EXEC = "11111111-2222-3333-4444-555555555555";
const EXEC_OLD = "99999999-8888-7777-6666-555555555555";
const TOKEN = "approval-token-4706-0123456789-way-too-long-for-a-callback-data-field";
const TOKEN_OLD = "approval-token-4706-older-build-9876543210-also-far-too-long-to-send";

// Placeholder account id (CLAUDE.md: never a real one) for the cross-account
// triple parseCdRegistry admits: 12 digits + the RESERVED trigger-role name.
const XACCT = "210987654321";
const XROLE = `arn:aws:iam::${XACCT}:role/hub-cd-trigger-widget`;
const XEXTID = "hub-cd-widget-external-id";

// ─── AWS SDK mocks ────────────────────────────────────────────────────────────

// ONE ordered log across the AWS and Telegram seams: "both happened" is not the
// invariant — "the pipeline moved FIRST" is.
const log = vi.hoisted(() => ({ entries: [] }));

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [] }));
vi.mock("@aws-sdk/client-dynamodb", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  class DynamoDBClient {
    async send(c) {
      if (c.op === "get") return { Item: db.items.get(c.input.Key.id.S) };
      if (c.op === "put") {
        const id = c.input.Item.id.S;
        if (c.input.ConditionExpression && db.items.has(id)) {
          const err = new Error("The conditional request failed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        db.items.set(id, c.input.Item);
        db.puts.push(c.input.Item);
        return {};
      }
      if (c.op === "del") { db.deletes.push(c.input.Key.id.S); db.items.delete(c.input.Key.id.S); return {}; }
      if (c.op === "scan") {
        const p = c.input.ExpressionAttributeValues[":p"].S;
        return { Items: [...db.items.values()].filter((i) => i.id.S.startsWith(p)) };
      }
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return {
    DynamoDBClient,
    GetItemCommand: cmd("get"), PutItemCommand: cmd("put"),
    DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan"),
  };
});

/**
 * CodePipeline, per pipeline NAME with a `"*"` wildcard (same shape as
 * deploy-approval.test.mjs). Two additions this suite needs:
 *   cp.onPut  — fires after a recorded PutApprovalResult, so a test can model
 *               "rejecting the older build frees the gate for the next one".
 *   inits     — records whether the client was built with a CREDENTIAL PROVIDER,
 *               and send() resolves it the way a signing client would, so a
 *               cross-account approval really performs its AssumeRole.
 */
const cp = vi.hoisted(() => ({
  states: new Map(), stateErrors: new Map(), putErrors: new Map(),
  approvals: [], sends: [], inits: [], onPut: null,
}));
const pick = (map, name) => (map.has(name) ? map.get(name) : map.get("*"));
vi.mock("@aws-sdk/client-codepipeline", () => {
  const cmd = (op) => class { constructor(input) { this.input = input; this.op = op; } };
  const boom = (msg) => { const e = new Error(msg); e.name = "ValidationException"; throw e; };
  class CodePipelineClient {
    constructor(cfg) {
      this.region = cfg?.region;
      this.creds = typeof cfg?.credentials === "function" ? cfg.credentials : null;
      cp.inits.push({ region: cfg?.region, assumed: Boolean(this.creds) });
    }
    async send(c) {
      if (this.creds) await this.creds(); // a real client resolves creds before signing
      cp.sends.push({ op: c.op, region: this.region, input: c.input });
      if (c.op === "state") {
        const err = pick(cp.stateErrors, c.input?.name);
        if (err) boom(err);
        return pick(cp.states, c.input?.name) || { stageStates: [] };
      }
      if (c.op === "put") {
        const err = pick(cp.putErrors, c.input?.pipelineName);
        if (err) boom(err);
        cp.approvals.push(c.input);
        log.entries.push({ kind: "approval", status: c.input?.result?.status, token: c.input?.token });
        cp.onPut?.(c.input);
        return {};
      }
      if (c.op === "exec") return { pipelineExecution: { artifactRevisions: [] } };
      throw new Error(`unexpected cp op ${c.op}`);
    }
  }
  return {
    CodePipelineClient,
    GetPipelineStateCommand: cmd("state"),
    PutApprovalResultCommand: cmd("put"),
    GetPipelineExecutionCommand: cmd("exec"),
  };
});

const sts = vi.hoisted(() => ({ assumes: [] }));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    async send(c) {
      sts.assumes.push(c.input);
      return { Credentials: {
        AccessKeyId: "AKIAIOSFODNN7EXAMPLE", SecretAccessKey: "secret", SessionToken: "session",
        Expiration: new Date(Date.now() + 900_000),
      } };
    }
  },
  AssumeRoleCommand: class { constructor(input) { this.input = input; } },
}));

// The bridge reads exactly one S3 key: the CD registry.
const s3 = vi.hoisted(() => ({ calls: [], registry: null }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(c) {
      s3.calls.push(c.input);
      if (c.input?.Key === CD_REGISTRY_KEY && s3.registry) {
        const doc = s3.registry;
        return { Body: { transformToString: async () => (typeof doc === "string" ? doc : JSON.stringify(doc)) } };
      }
      const e = new Error("NoSuchKey");
      e.name = "NoSuchKey";
      throw e;
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(i) { this.input = i; } },
  TranscribeStreamingClient: class { async send() { return { TranscriptResultStream: (async function* () {})() }; } },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class { async send() { throw new Error("bedrock must not be called"); } },
  ConverseCommand: class { constructor(i) { this.input = i; } },
}));

// ─── fetch fake ───────────────────────────────────────────────────────────────

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function makeNet(ctx, overrides = {}) {
  const net = {
    ctx, polls: 0, batches: [], afterPoll: [], workflows: [], tickets: null,
    sent: [], answered: [], edited: [], transitions: [], fetched: [], github: null,
    ...overrides,
  };
  net.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    net.fetched.push(u);
    if (u.startsWith("https://api.github.com/")) {
      if (u.includes("/pulls")) return jsonRes(net.github?.pulls ?? []);
      if (u.includes("/commits/")) return jsonRes(net.github?.commit ?? {});
      return jsonRes({});
    }
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: net.workflows });
    if (u.endsWith("/tickets/transition")) {
      net.transitions.push(body);
      log.entries.push({ kind: "transition", ticketId: body?.ticketId, targetStatus: body?.targetStatus });
      const row = (net.tickets || []).find((t) => t?.ticketId === body?.ticketId);
      if (row && body?.targetStatus) row.status = body.targetStatus;
      return jsonRes({ success: true });
    }
    if (/\/api\/workflow\/[^/]+\/tickets$/.test(u)) {
      return net.tickets ? jsonRes({ tickets: net.tickets }) : jsonRes({}, false, 404);
    }
    if (u.endsWith("/getUpdates")) {
      const i = net.polls++;
      net.ctx.remainingMs = net.afterPoll[i] ?? 20_000;
      return jsonRes({ ok: true, result: net.batches[i] || [] });
    }
    if (u.endsWith("/sendMessage")) { net.sent.push(body); return jsonRes({ ok: true, result: {} }); }
    if (u.endsWith("/answerCallbackQuery")) { net.answered.push(body); return jsonRes({ ok: true, result: true }); }
    if (u.endsWith("/editMessageText")) { net.edited.push(body); return jsonRes({ ok: true, result: {} }); }
    if (u.endsWith("/sendChatAction")) return jsonRes({ ok: true, result: true });
    throw new Error(`unexpected fetch: ${u}`);
  };
  return net;
}
const makeCtx = (startMs = 100_000) => ({ remainingMs: startMs, getRemainingTimeInMillis() { return this.remainingMs; } });

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEAM",
  GITHUB_TOKEN: "gh", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB,
  ALLOWED_CHAT_IDS: String(CHAT), AWS_REGION: "us-east-1", CHAT_SETTLE_MS: "0",
};

/** Fresh container. Returns the MODULE (the retry seam lives on it). */
async function loadModule({ bucket, registry, pipeline } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  if (bucket == null) delete process.env.ARTIFACT_BUCKET; else process.env.ARTIFACT_BUCKET = bucket;
  if (pipeline == null) delete process.env.DEPLOY_PIPELINE_NAME; else process.env.DEPLOY_PIPELINE_NAME = pipeline;
  s3.registry = registry ?? null;
  const mod = await import("../index.mjs");
  mod._setDeployGateRetryMsForTests(0); // no 10s sleeps in a unit test
  return mod;
}

function resetAll() {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0;
  cp.states.clear(); cp.stateErrors.clear(); cp.putErrors.clear();
  cp.approvals.length = 0; cp.sends.length = 0; cp.inits.length = 0; cp.onPut = null;
  s3.calls.length = 0; s3.registry = null;
  sts.assumes.length = 0;
  log.entries.length = 0;
  db.items.set(`chat#${CHAT}`, { id: { S: `chat#${CHAT}` }, chatId: { N: String(CHAT) } });
}

const realFetch = global.fetch;
beforeEach(resetAll);
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ARTIFACT_BUCKET", "DEPLOY_PIPELINE_NAME"]) delete process.env[k];
});

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Canonical labels an agent writes. */
const LABELS_COLON = [`gate:deploy-approval`, `pipeline:${PIPELINE}`, `exec:${EXEC}`, `wf:${WF}`];
/** The SAME labels after Jira's sanitizeUserLabels ([^a-z0-9._-] -> "-"). */
const LABELS_HYPHEN = [`gate-deploy-approval`, `pipeline-${PIPELINE}`, `exec-${EXEC}`, `wf-${WF}`];

const gateRow = (labels, extra = {}) => ({
  ticketId: GATE,
  title: "Deploy gate: approve prod deploy for the widget",
  status: "in review",
  labels,
  ...extra,
});

const registry = (extra = {}) => ({
  version: 1,
  repos: [{ repo: REPO, pipeline: PIPELINE, region: REGION, ...extra }],
});

/** A pipeline whose Approval action is parked on `executionId`. */
const pendingState = (token, executionId, { revision } = {}) => ({
  stageStates: [
    { stageName: "Source", actionStates: [{
      actionName: "Source",
      latestExecution: { status: "Succeeded", pipelineExecutionId: executionId },
      ...(revision ? { currentRevision: { revisionId: revision } } : {}),
    }] },
    { stageName: "Approval", actionStates: [{
      actionName: "Approve_deploy",
      latestExecution: { status: "InProgress", token, pipelineExecutionId: executionId },
    }] },
    { stageName: "Deploy", actionStates: [{ actionName: "Deploy_prod", latestExecution: {} }] },
  ],
});

const workflow = (extra = {}) => ({
  workflowId: WF,
  phase: "ship",
  input: { title: "Sprocket cache for the widget" },
  humanNotifications: [{
    id: "n-4706", type: "review_needed", acknowledged: false,
    ticketId: GATE, reviewer: "release-manager",
    timestamp: new Date().toISOString(),
    summary: "Ship review passed; prod deploy is waiting on you.",
  }],
  ...extra,
});

const GITHUB = {
  commit: { commit: { message: "feat(widget): sprocket cache (TEAM-4706)" }, stats: { additions: 12, deletions: 3 }, files: [{}, {}] },
  pulls: [{
    number: 7, title: "feat(widget): sprocket cache (TEAM-4706)",
    html_url: `https://github.com/${REPO}/pull/7`,
    body: "## Summary\nCaches sprockets between builds.",
  }],
};

const cbUpdate = (id, data, chat = CHAT) => ({
  update_id: id,
  callback_query: {
    id: `cb-${id}`, data,
    message: { message_id: 42, chat: { id: chat }, text: "*🚀 PRODUCTION DEPLOY — approval needed*\nSprocket cache" },
  },
});

/** hashToken() from index.mjs (djb2) — the legacy poller's claim key shape. */
const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const targetKey = (pipeline, token) => `dp${djb2(`${pipeline} ${token}`)}`;
/**
 * Pretend the legacy poller already paged this wait, so its 🚀 page doesn't add
 * a second message to the assertions. PR 1 makes the ticket's ✅ work; which of
 * the two artefacts survives is a later unit's problem.
 */
const seedDeployClaim = (pipeline, token) => {
  const id = `dep#${targetKey(pipeline, token)}`;
  db.items.set(id, {
    id: { S: id }, pipelineName: { S: pipeline }, region: { S: REGION },
    stageName: { S: "Approval" }, actionName: { S: "Approve_deploy" }, token: { S: token },
  });
};

const kinds = () => log.entries.filter((e) => e.kind === "approval" || e.kind === "transition").map((e) => e.kind);
const bodies = (net) => [...net.sent, ...net.edited, ...net.answered].map((m) => JSON.stringify(m));

describe("gate:deploy-approval — the ticket IS the deploy decision", () => {
  it("(a) ✅ records PutApprovalResult(Approved) BEFORE the ticket transition", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));
    seedDeployClaim(PIPELINE, TOKEN);
    const net = makeNet(makeCtx(), {
      tickets: [gateRow(LABELS_COLON)],
      batches: [[cbUpdate(1, `gok|${GATE}|${WF}`)]],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(cp.approvals.length, "exactly one approval result").toBe(1);
    expect(cp.approvals[0]).toMatchObject({
      pipelineName: PIPELINE, stageName: "Approval", actionName: "Approve_deploy", token: TOKEN,
    });
    expect(cp.approvals[0].result.status).toBe("Approved");
    expect(cp.approvals[0].result.summary).toContain(GATE);
    expect(cp.approvals[0].result.summary).toContain(String(CHAT));
    // The pipeline's own region, from the registry entry.
    expect(cp.sends.find((s) => s.op === "put").region).toBe(REGION);
    expect(net.transitions).toEqual([
      { ticketId: GATE, targetStatus: "done", comment: expect.stringContaining("Approved via Telegram") },
    ]);
    // The ORDER is the invariant: a ticket may only move behind a real approval.
    expect(kinds()).toEqual(["approval", "transition"]);
    expect(net.answered.at(-1).text).toContain(`Approved ${GATE}`);
  });

  it("(b) PutApprovalResult failure leaves the ticket untouched and says why", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));
    cp.putErrors.set(PIPELINE, "Approval action Approve_deploy is not in InProgress state");
    seedDeployClaim(PIPELINE, TOKEN);
    const net = makeNet(makeCtx(), {
      tickets: [gateRow(LABELS_COLON)],
      batches: [[cbUpdate(2, `gok|${GATE}|${WF}`)]],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(net.transitions, "a failed approval must not move the ticket").toEqual([]);
    expect(net.answered.at(-1).text).toMatch(/could not approve the deploy/i);
    const edit = net.edited.at(-1).text;
    expect(edit).toContain("ValidationException");
    expect(edit).toContain("not in InProgress state");
    expect(edit).toMatch(new RegExp(`${GATE} is untouched`));
    expect(edit).toMatch(/tap again to retry/);
    // Nothing about the ticket half ran: no rework marker, no rework note.
    expect(db.puts.some((i) => i.id.S.startsWith("rej#") || i.id.S.startsWith("gaterework#"))).toBe(false);
  });

  it("(c) an older execution parked at the gate is rejected first, then this one is approved", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    // The gate holds a build the human is NOT looking at.
    cp.states.set(PIPELINE, pendingState(TOKEN_OLD, EXEC_OLD));
    seedDeployClaim(PIPELINE, TOKEN_OLD);
    // Rejecting it frees the gate; this execution arrives on the next read.
    cp.onPut = (input) => {
      if (input?.result?.status === "Rejected") cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));
    };
    const net = makeNet(makeCtx(), {
      tickets: [gateRow(LABELS_COLON)],
      batches: [[cbUpdate(3, `gok|${GATE}|${WF}`)]],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(cp.approvals.length).toBe(2);
    expect(cp.approvals[0]).toMatchObject({ token: TOKEN_OLD });
    expect(cp.approvals[0].result.status).toBe("Rejected");
    expect(cp.approvals[0].result.summary).toContain(EXEC);   // superseded BY this execution
    expect(cp.approvals[1]).toMatchObject({ token: TOKEN });
    expect(cp.approvals[1].result.status).toBe("Approved");
    expect(kinds()).toEqual(["approval", "approval", "transition"]);
    // The human is told what happened, by execution id, before the wait.
    expect(net.answered.some((a) => new RegExp(`older build \\(${EXEC_OLD}\\) holds the gate; rejecting it first`, "i").test(a.text))).toBe(true);
    expect(net.transitions).toHaveLength(1);
  });

  it("(d) a gate ticket WITHOUT the label behaves exactly as before — zero CodePipeline calls", async () => {
    const mod = await loadModule(); // no registry, no pipeline: the deploy paths are inert
    const net = makeNet(makeCtx(), {
      tickets: [gateRow(["deploy-gate", `wf:${WF}`])], // an ordinary release-manager gate
      batches: [[cbUpdate(4, `gok|${GATE}|${WF}`)]],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(cp.sends, "an unlabelled gate must reach no CodePipeline call").toEqual([]);
    expect(cp.inits, "…not even a client").toEqual([]);
    expect(net.transitions).toEqual([
      { ticketId: GATE, targetStatus: "done", comment: expect.stringContaining("Approved via Telegram") },
    ]);
    expect(net.answered.at(-1).text).toContain(`Approved ${GATE}`);
    expect(net.edited.at(-1).text).toContain("✅ Approved — pipeline resuming.");
  });

  it("(d2) the LABEL is what decides: the same tap on a labelled gate needs the pipeline", async () => {
    const mod = await loadModule(); // registry unreachable → the target can't resolve
    const net = makeNet(makeCtx(), {
      tickets: [gateRow(LABELS_COLON)],
      batches: [[cbUpdate(5, `gok|${GATE}|${WF}`)]],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(net.transitions, "an unapprovable deploy gate must not report success").toEqual([]);
    expect(net.edited.at(-1).text).toContain(PIPELINE);
    expect(net.edited.at(-1).text).toMatch(/not watched by any CD-registry entry/);
  });

  it("(e) a cross-account entry approves through the assumed trigger role", async () => {
    const mod = await loadModule({
      bucket: BUCKET,
      registry: registry({ account: XACCT, roleArn: XROLE, externalId: XEXTID }),
    });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));
    seedDeployClaim(PIPELINE, TOKEN);
    const net = makeNet(makeCtx(), {
      tickets: [gateRow(LABELS_COLON)],
      batches: [[cbUpdate(6, `gok|${GATE}|${WF}`)]],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(cp.approvals.length).toBe(1);
    expect(cp.approvals[0].result.status).toBe("Approved");
    // The client for that region was built WITH a credential provider, and the
    // provider assumed the registry's role with its external id.
    expect(cp.inits.filter((i) => i.region === REGION)).toEqual([{ region: REGION, assumed: true }]);
    expect(sts.assumes.length).toBeGreaterThan(0);
    expect(sts.assumes[0]).toMatchObject({ RoleArn: XROLE, ExternalId: XEXTID });
    expect(net.transitions).toHaveLength(1);
  });

  it("(f) hyphen-mangled labels classify identically to the colon form", async () => {
    const rendered = [];
    for (const labels of [LABELS_COLON, LABELS_HYPHEN]) {
      resetAll();
      const mod = await loadModule({ bucket: BUCKET, registry: registry() });
      cp.states.set(PIPELINE, pendingState(TOKEN, EXEC, { revision: SHA }));
      seedDeployClaim(PIPELINE, TOKEN);
      const net = makeNet(makeCtx(), {
        workflows: [workflow()],                 // the scan pages the gate…
        tickets: [gateRow(labels)],
        github: GITHUB,
        batches: [[cbUpdate(7, `gok|${GATE}|${WF}`)]], // …and the tap approves it
      });
      global.fetch = net.fetch;
      await mod.handler({}, net.ctx);

      expect(net.sent, "one gate page").toHaveLength(1);
      const ping = net.sent[0];
      // Classified by LABEL: the production-deploy kicker, not the title's kind.
      expect(ping.text.startsWith("*🚀 PRODUCTION DEPLOY — approval needed*")).toBe(true);
      // …enriched with the same brief the pipeline's own page carries.
      expect(ping.text).toMatch(/Caches sprockets between builds/);
      expect(ping.text).toMatch(/Workflow: TEAM-4706/);
      expect(ping.text).toMatch(/Scope: 2 files \(\+12\/-3\)/);
      expect(ping.text).toContain(PIPELINE);
      expect(ping.text).toContain(REPO);
      expect(ping.reply_markup.inline_keyboard.flat().some((b) => b.url === `https://github.com/${REPO}/pull/7`)).toBe(true);
      // The brief was resolved against THIS execution's commit.
      expect(net.fetched.some((u) => u.includes(`/repos/${REPO}/commits/${SHA}`))).toBe(true);
      // …and the tap really approved the pipeline, in order.
      expect(cp.approvals.map((a) => a.result.status)).toEqual(["Approved"]);
      expect(kinds()).toEqual(["approval", "transition"]);
      rendered.push(ping.text);
    }
    expect(rendered[0], "both label shapes render the SAME page").toBe(rendered[1]);
  });

  it("(g) an approval token never reaches a Telegram message, not even via an AWS error", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC, { revision: SHA }));
    // The kind of error that echoes the offending input back at you.
    cp.putErrors.set(PIPELINE, `Invalid approval token ${TOKEN} for action Approve_deploy`);
    const net = makeNet(makeCtx(), {
      workflows: [workflow()],
      tickets: [gateRow(LABELS_COLON)],
      github: GITHUB,
      batches: [[cbUpdate(8, `gok|${GATE}|${WF}`)]],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    const all = bodies(net);
    expect(all.length, "there were messages to inspect").toBeGreaterThan(0);
    for (const b of all) expect(b, "no approval token in any Telegram payload").not.toContain(TOKEN);
    // esc() escapes the brackets, so match the marker itself: presence only,
    // never the value.
    expect(net.edited.at(-1).text, "the token is reported as redacted").toContain("REDACTED");
    expect(net.transitions).toEqual([]);
  });

  it("(h) legacy path unchanged: a pending approval with no gate ticket still pages and approves", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));
    const net = makeNet(makeCtx(), { batches: [[]] }); // no workflows, no tickets
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(net.sent, "the pipeline's own page still goes out").toHaveLength(1);
    const dok = net.sent[0].reply_markup.inline_keyboard.flat().find((b) => b.callback_data?.startsWith("dok|"));
    expect(dok, "dok/dno buttons unchanged").toBeTruthy();
    const key = dok.callback_data.split("|")[1];
    expect(`dep#${key}`).toBe(`dep#${targetKey(PIPELINE, TOKEN)}`);

    const net2 = makeNet(makeCtx(), { batches: [[cbUpdate(9, `dok|${key}`)]] });
    global.fetch = net2.fetch;
    cp.states.clear(); // the wait is gone; only the callback matters
    await mod.handler({}, net2.ctx);

    expect(cp.approvals.map((a) => a.result.status)).toEqual(["Approved"]);
    expect(cp.approvals[0]).toMatchObject({ pipelineName: PIPELINE, token: TOKEN });
    expect(db.deletes).toContain(`dep#${key}`);
    expect(net2.transitions, "the legacy path never touches a ticket").toEqual([]);
  });

  // ─── ❌ has the same ordering discipline ─────────────────────────────────────

  it("❌ rejects the pipeline first, then parks the ticket for a rework note", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));
    seedDeployClaim(PIPELINE, TOKEN);
    const net = makeNet(makeCtx(), {
      tickets: [gateRow(LABELS_COLON)],
      batches: [[cbUpdate(10, `gno|${GATE}|${WF}`)]],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(cp.approvals.length).toBe(1);
    expect(cp.approvals[0]).toMatchObject({ token: TOKEN });
    expect(cp.approvals[0].result.status).toBe("Rejected");
    // The rework plumbing is untouched: the ❌ marker and the placeholder reason.
    expect(db.items.has(`rej#${CHAT}`)).toBe(true);
    expect(db.items.has(`gaterework#${GATE}`)).toBe(true);
    expect(net.answered.at(-1).text).toMatch(/reply with what needs to change/i);
    // Order: the pipeline stopped before any ticket-side state was written.
    const firstMarker = db.puts.findIndex((i) => i.id.S.startsWith("rej#"));
    expect(firstMarker).toBeGreaterThanOrEqual(0);
    expect(kinds()[0]).toBe("approval");
  });

  it("❌ whose rejection fails leaves the ticket and the rework plumbing untouched", async () => {
    const mod = await loadModule({ bucket: BUCKET, registry: registry() });
    cp.states.set(PIPELINE, pendingState(TOKEN, EXEC));
    cp.putErrors.set(PIPELINE, "Approval action Approve_deploy is not in InProgress state");
    seedDeployClaim(PIPELINE, TOKEN);
    const net = makeNet(makeCtx(), {
      tickets: [gateRow(LABELS_COLON)],
      batches: [[cbUpdate(11, `gno|${GATE}|${WF}`)]],
    });
    global.fetch = net.fetch;
    await mod.handler({}, net.ctx);

    expect(db.items.has(`rej#${CHAT}`), "no pending-rejection marker on a failed reject").toBe(false);
    expect(db.items.has(`gaterework#${GATE}`)).toBe(false);
    expect(net.transitions).toEqual([]);
    expect(net.edited.at(-1).text).toMatch(/NOT rejected/);
  });
});
