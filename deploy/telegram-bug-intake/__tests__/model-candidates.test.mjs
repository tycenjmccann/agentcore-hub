/**
 * Model registry on the bridge (TEAM-4995, DL-033). Two surfaces, one document:
 *
 *  A. INTAKE MODEL — the vision/classify Converse call's modelId comes from
 *     config/models.json (agents["telegram_intake"], else defaults.persona),
 *     with BEDROCK_MODEL_ID and then the literal as the tail. An unreadable or
 *     invalid registry must never stop intake, so every failure falls through
 *     that tail instead of raising.
 *
 *  B. CANDIDATE PINGS — the nightly reconcile leaves a discovered row as
 *     `status: "candidate"` and stamps notify.requestedAt to ask for a human
 *     decision. The bridge pings the allowlisted chats ONCE per such row.
 *     Invariants, all of them security-relevant (finding 12):
 *       1. status + notify.requestedAt + MODEL_ID_RE — all three required. A
 *          row failing any one of them is neither pinged nor claimed.
 *       2. The claim (model#<modelId>) is written BEFORE the send and carries
 *          NO ttl: one ping per model, forever. A 30-day TTL would re-page the
 *          candidate a human already declined.
 *       3. A failed send RELEASES the claim, so the next scan retries.
 *       4. At most MAX_MODEL_PINGS (5) per scan.
 *       5. Plain text, no parse_mode: a model id is full of dots and dashes
 *          that legacy Markdown reads as entities, and a rejected send is a
 *          missed ping.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TG_TOKEN = "111111:test-bot-token";
const HUB = "https://hub.example.invalid";
const CHAT = 555;
const CHAT2 = 556;
const BUCKET = "test-artifact-bucket";
const MODELS_KEY = "config/models.json";

// ─── AWS SDK mocks ────────────────────────────────────────────────────────────

const db = vi.hoisted(() => ({ items: new Map(), puts: [], deletes: [], updates: [] }));
vi.mock("@aws-sdk/client-dynamodb", async () => {
  const { applyUpdate } = await import("./helpers/ddb-fake.mjs");
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
      if (c.op === "update") return applyUpdate(db, c.input);
      throw new Error(`unexpected ddb op ${c.op}`);
    }
  }
  return {
    DynamoDBClient,
    GetItemCommand: cmd("get"), PutItemCommand: cmd("put"), UpdateItemCommand: cmd("update"),
    DeleteItemCommand: cmd("del"), ScanCommand: cmd("scan"),
  };
});

// One S3 key matters here. `doc` is served verbatim when it is a string, so a
// malformed body is testable; `gets` records every read so the 60s cache is too.
const s3 = vi.hoisted(() => ({ gets: [], doc: null, error: null }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(c) {
      s3.gets.push(c.input?.Key);
      if (s3.error) { const e = new Error(s3.error); e.name = s3.error; throw e; }
      if (c.input?.Key === MODELS_KEY && s3.doc != null) {
        const doc = s3.doc;
        return { Body: { transformToString: async () => (typeof doc === "string" ? doc : JSON.stringify(doc)) } };
      }
      const e = new Error("NoSuchKey");
      e.name = "NoSuchKey";
      throw e;
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; this.op = "put"; } },
}));

const bedrock = vi.hoisted(() => ({ calls: [], reply: null }));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    async send(c) {
      bedrock.calls.push(c.input);
      return bedrock.reply ?? {
        output: { message: { content: [{ toolUse: { input: {
          title: "Button is dead", description: "d", intent: "bug",
          repo: "test-user/agentcore-hub", confidence: 0.99, severity: "medium",
        } } }] } },
      };
    }
  },
  ConverseCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return { FailedEntryCount: 0 }; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  StartStreamTranscriptionCommand: class { constructor(i) { this.input = i; } },
  TranscribeStreamingClient: class { async send() { return { TranscriptResultStream: (async function* () {})() }; } },
}));
vi.mock("@aws-sdk/client-codepipeline", () => ({
  CodePipelineClient: class { async send() { throw new Error("codepipeline must not be called"); } },
  GetPipelineStateCommand: class { constructor(i) { this.input = i; } },
  GetPipelineExecutionCommand: class { constructor(i) { this.input = i; } },
  PutApprovalResultCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class { async send() { throw new Error("sts must not be called"); } },
  AssumeRoleCommand: class { constructor(i) { this.input = i; } },
}));

// ─── fetch fake ───────────────────────────────────────────────────────────────

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function makeNet(ctx, opts = {}) {
  const net = { ctx, polls: 0, batches: [], sent: [], sendFails: 0, ...opts };
  net.fetch = async (url, o) => {
    const u = String(url);
    const body = o?.body ? JSON.parse(o.body) : null;
    if (u.startsWith("https://api.github.com/")) {
      return jsonRes([{ full_name: "test-user/agentcore-hub", private: false, language: "TypeScript", description: "hub" }]);
    }
    if (u === `${HUB}/api/workflow/list`) return jsonRes({ workflows: [] });
    if (u.endsWith("/getUpdates")) {
      const i = net.polls++;
      // Stay above FLUSH_MIN_MS for the round AFTER the one that delivered the
      // update — that is the iteration whose flushSettledBuffers() classifies it —
      // then drop below POLL_RESERVE_MS so the loop ends.
      net.ctx.remainingMs = i === 0 ? 200_000 : 1_000;
      return jsonRes({ ok: true, result: net.batches[i] || [] });
    }
    if (u.endsWith("/sendMessage")) {
      net.sent.push(body);
      if (net.sendFails > 0) { net.sendFails -= 1; throw new Error("Telegram 502"); }
      return jsonRes({ ok: true, result: {} });
    }
    if (u.endsWith("/sendChatAction")) return jsonRes({ ok: true, result: true });
    if (u.endsWith("/editMessageText")) return jsonRes({ ok: true, result: {} });
    if (u.endsWith("/answerCallbackQuery")) return jsonRes({ ok: true, result: true });
    if (u.includes("/rest/api/3/")) return jsonRes({ key: "TEAM-1" });
    if (u.startsWith(HUB)) return jsonRes({});
    throw new Error(`unexpected fetch: ${u}`);
  };
  return net;
}
const makeCtx = (startMs = 900_000) => ({ remainingMs: startMs, getRemainingTimeInMillis() { return this.remainingMs; } });

const ENV = {
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com",
  JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEAM",
  GITHUB_TOKEN: "gh", GITHUB_USER: "test-user",
  PENDING_TABLE: "test-pending-table", HUB_API_URL: HUB,
  ALLOWED_CHAT_IDS: `${CHAT},${CHAT2}`, AWS_REGION: "us-east-1", CHAT_SETTLE_MS: "0",
};

// Priced by default: validateRegistry refuses a document whose agents/defaults
// point at an UNPRICED row, the same read-time verdict the hub reaches, so a row
// something routes at has to carry a rate or the bridge falls back to env.
const row = (over = {}) => ({
  modelId: "us.anthropic.claude-opus-6", label: "Opus 6", vendor: "anthropic",
  family: "claude-opus", endpoint: "bedrock-runtime", region: "us-east-1",
  api: "converse", status: "candidate", price: { input: 3, output: 15 },
  notify: { requestedAt: "2026-09-24T03:00:00Z" },
  ...over,
});

// Rows go under `catalog` and nowhere else — the one document key the registry
// twin reads (TEAM-5022). `loadModule({ models })` names the S3 BODY, not the key.
const doc = (catalog, over = {}) => ({ version: 3, updatedAt: "2026-09-24T03:00:00Z", catalog, ...over });

/** Fresh container: module-level registry cache and _loggedIntakeModel reset. */
async function loadModule({ bucket = BUCKET, models = null, bedrockModelId } = {}) {
  vi.resetModules();
  Object.assign(process.env, ENV);
  if (bucket == null) delete process.env.ARTIFACT_BUCKET; else process.env.ARTIFACT_BUCKET = bucket;
  if (bedrockModelId == null) delete process.env.BEDROCK_MODEL_ID;
  else process.env.BEDROCK_MODEL_ID = bedrockModelId;
  s3.doc = models;
  return import("../index.mjs");
}

function resetAll() {
  db.items.clear(); db.puts.length = 0; db.deletes.length = 0; db.updates.length = 0;
  s3.gets.length = 0; s3.doc = null; s3.error = null;
  bedrock.calls.length = 0; bedrock.reply = null;
  db.items.set(`chat#${CHAT}`, { id: { S: `chat#${CHAT}` }, chatId: { N: String(CHAT) } });
}

const realFetch = global.fetch;
beforeEach(resetAll);
afterAll(() => {
  global.fetch = realFetch;
  for (const k of [...Object.keys(ENV), "ARTIFACT_BUCKET", "BEDROCK_MODEL_ID"]) delete process.env[k];
});

/** One handler invocation with no Telegram updates: the scans and nothing else. */
async function runScan(mod, net) {
  global.fetch = net.fetch;
  return mod.handler({}, net.ctx);
}

const pings = (net) => net.sent.filter((m) => String(m.text || "").startsWith("New model candidate:"));
const claims = () => [...db.items.keys()].filter((k) => k.startsWith("model#"));

// ─── A. intake model ─────────────────────────────────────────────────────────

describe("intake model comes from the registry", () => {
  const textUpdate = { update_id: 1, message: { message_id: 1, chat: { id: CHAT }, text: "the save button does nothing" } };

  /** Drive one real intake so the assertion is on the ACTUAL Converse call. */
  async function classifyWith(models, extra = {}) {
    const mod = await loadModule({ models, ...extra });
    const net = makeNet(makeCtx(), { batches: [[textUpdate]] });
    await runScan(mod, net);
    return bedrock.calls.at(-1)?.modelId;
  }

  it("uses the agents[telegram_intake] pin", async () => {
    expect(await classifyWith(doc(
      [row({ modelId: "us.anthropic.claude-sonnet-6", status: "active", notify: undefined })],
      { agents: { telegram_intake: "us.anthropic.claude-sonnet-6" } },
    ))).toBe("us.anthropic.claude-sonnet-6");
  });

  it("falls back to defaults.persona when the agent has no pin", async () => {
    expect(await classifyWith(doc(
      [row({ modelId: "us.anthropic.claude-fable-6", status: "active", notify: undefined })],
      { defaults: { persona: "us.anthropic.claude-fable-6" } },
    ))).toBe("us.anthropic.claude-fable-6");
  });

  it("resolves an alias through the catalog, so the row owns the id", async () => {
    expect(await classifyWith(doc(
      [row({ modelId: "us.anthropic.claude-haiku-6", aliases: ["intake-classifier"], status: "active", notify: undefined })],
      { agents: { telegram_intake: "intake-classifier" } },
    ))).toBe("us.anthropic.claude-haiku-6");
  });

  it("serves a routed candidate whose re-probe failed — reported, not refused (TEAM-5016 F1)", async () => {
    // `unprobed` is a point-in-time verdict: refusing the document would move
    // intake back onto the literal for a whole TTL. validateRegistry still names
    // the field; the loader serves the document.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await classifyWith(doc(
      [row({ modelId: "us.anthropic.claude-sonnet-6", status: "candidate", notify: undefined,
             probe: { api: { ok: true }, cli: { ok: false, error: "turn failed" } } })],
      { agents: { telegram_intake: "us.anthropic.claude-sonnet-6" } },
    ))).toBe("us.anthropic.claude-sonnet-6");
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("registry.tolerated agents.telegram_intake=unprobed"))).toBe(true);
    warn.mockRestore();
  });

  it("never resolves onto a retired row — it falls through to the tail", async () => {
    expect(await classifyWith(
      doc([row({ modelId: "us.anthropic.claude-opus-old", status: "retired", notify: undefined })],
        { agents: { telegram_intake: "us.anthropic.claude-opus-old" } }),
      { bedrockModelId: "us.anthropic.claude-sonnet-5" },
    )).toBe("us.anthropic.claude-sonnet-5");
  });

  it("uses BEDROCK_MODEL_ID when there is no registry at all", async () => {
    expect(await classifyWith(null, { bedrockModelId: "us.anthropic.claude-sonnet-5" }))
      .toBe("us.anthropic.claude-sonnet-5");
  });

  it("uses the literal when neither the registry nor the env names one", async () => {
    expect(await classifyWith(null)).toBe("us.anthropic.claude-sonnet-5");
  });

  it("constructs no S3 client when ARTIFACT_BUCKET is unset", async () => {
    expect(await classifyWith(null, { bucket: null })).toBe("us.anthropic.claude-sonnet-5");
    expect(s3.gets).toEqual([]);
  });

  it("a malformed document does not stop intake", async () => {
    expect(await classifyWith("{not json", { bedrockModelId: "us.anthropic.claude-sonnet-5" }))
      .toBe("us.anthropic.claude-sonnet-5");
  });

  it("an invalid document (catalog[] missing) does not stop intake", async () => {
    expect(await classifyWith({ version: 1, agents: { telegram_intake: "x.y" } }))
      .toBe("us.anthropic.claude-sonnet-5");
  });

  it("reads config/models.json once per container, not once per scan", async () => {
    const mod = await loadModule({ models: doc([row({ status: "active", notify: undefined })]) });
    const net = makeNet(makeCtx(), { batches: [[]] });
    await runScan(mod, net);
    await runScan(mod, net);
    expect(s3.gets.filter((k) => k === MODELS_KEY)).toHaveLength(1);
  });
});

// ─── B. candidate pings ──────────────────────────────────────────────────────

describe("scanModelCandidates", () => {
  it("pings every allowlisted chat once and claims the model with NO ttl", async () => {
    const mod = await loadModule({ models: doc([row()]) });
    const net = makeNet(makeCtx(), { batches: [[]] });
    await runScan(mod, net);

    const sent = pings(net);
    expect(sent).toHaveLength(2);
    // ALLOWED_CHAT_IDS, verbatim: the ping goes to the ALLOWLIST, not to every
    // chat that ever messaged the bot (listChats) — a model decision is an
    // operator decision.
    expect(sent.map((m) => m.chat_id)).toEqual([String(CHAT), String(CHAT2)]);
    expect(sent[0].text).toBe(
      "New model candidate: us.anthropic.claude-opus-6 (Opus 6, anthropic, bedrock-runtime us-east-1). Review on /models.",
    );
    // Plain text: no parse_mode, so no model id can be read as an entity.
    expect(sent[0].parse_mode).toBeUndefined();

    const claim = db.items.get("model#us.anthropic.claude-opus-6");
    expect(claim).toBeDefined();
    expect(claim.ttl).toBeUndefined();
    expect(Number(claim.claimedAt.N)).toBeGreaterThan(0);
  });

  it("never pings the same model twice, on a later scan or a later container", async () => {
    const models = doc([row()]);
    const mod = await loadModule({ models });
    await runScan(mod, makeNet(makeCtx(), { batches: [[]] }));

    const second = makeNet(makeCtx(), { batches: [[]] });
    await runScan(mod, second);
    expect(pings(second)).toEqual([]);

    const cold = await loadModule({ models });
    const third = makeNet(makeCtx(), { batches: [[]] });
    await runScan(cold, third);
    expect(pings(third)).toEqual([]);
    expect(claims()).toHaveLength(1);
  });

  it("requires all three conditions: candidate status, notify.requestedAt, a valid model id", async () => {
    const mod = await loadModule({ models: doc([
      row({ modelId: "us.anthropic.claude-active-6", status: "active" }),
      row({ modelId: "us.anthropic.claude-retired-6", status: "retired" }),
      row({ modelId: "us.anthropic.claude-quarantined-6", status: "quarantined" }),
      row({ modelId: "us.anthropic.claude-unasked-6", notify: undefined }),
      row({ modelId: "us.anthropic.claude-empty-notify-6", notify: {} }),
    ]) });
    const net = makeNet(makeCtx(), { batches: [[]] });
    await runScan(mod, net);
    expect(pings(net)).toEqual([]);
    expect(claims()).toEqual([]);
  });

  it("drops a hostile model id instead of putting it in a message or a DDB key", async () => {
    // validateRegistry drops rows whose id fails MODEL_ID_RE, and the scan
    // re-checks anyway: this row must reach neither Telegram nor PENDING_TABLE.
    const mod = await loadModule({ models: doc([
      { ...row({ modelId: "; rm -rf /" }) },
      { ...row({ modelId: "../../etc/passwd" }) },
      { ...row({ modelId: "ok.model-1" }) },
    ]) });
    const net = makeNet(makeCtx(), { batches: [[]] });
    await runScan(mod, net);
    expect(pings(net).map((m) => m.text)).toEqual([
      "New model candidate: ok.model-1 (Opus 6, anthropic, bedrock-runtime us-east-1). Review on /models.",
      "New model candidate: ok.model-1 (Opus 6, anthropic, bedrock-runtime us-east-1). Review on /models.",
    ]);
    expect(claims()).toEqual(["model#ok.model-1"]);
  });

  it("caps one scan at 5 pings and leaves the rest unclaimed for the next scan", async () => {
    const mod = await loadModule({ models: doc(
      Array.from({ length: 8 }, (_, i) => row({ modelId: `us.openai.gpt-6-v${i}` })),
    ) });
    const net = makeNet(makeCtx(), { batches: [[]] });
    await runScan(mod, net);
    expect(claims()).toHaveLength(5);
    expect(pings(net)).toHaveLength(10); // 5 models x 2 chats
    expect(claims()).not.toContain("model#us.openai.gpt-6-v5");
  });

  it("releases the claim when the send fails, so the next scan retries", async () => {
    const mod = await loadModule({ models: doc([row()]) });
    const net = makeNet(makeCtx(), { batches: [[]], sendFails: 1 });
    await runScan(mod, net);
    expect(db.deletes).toContain("model#us.anthropic.claude-opus-6");
    expect(claims()).toEqual([]);

    const retry = makeNet(makeCtx(), { batches: [[]] });
    await runScan(mod, retry);
    expect(pings(retry)).toHaveLength(2);
    expect(claims()).toEqual(["model#us.anthropic.claude-opus-6"]);
  });

  it("is a total no-op with no registry, and a scan failure never fails the invocation", async () => {
    const mod = await loadModule({ models: null });
    const net = makeNet(makeCtx(), { batches: [[]] });
    await expect(runScan(mod, net)).resolves.toBeDefined();
    expect(pings(net)).toEqual([]);

    s3.error = "AccessDenied";
    const denied = await loadModule({ models: null });
    const net2 = makeNet(makeCtx(), { batches: [[]] });
    await expect(runScan(denied, net2)).resolves.toBeDefined();
    expect(pings(net2)).toEqual([]);
  });

  it("names the model even when the row carries no label, vendor or region", async () => {
    const mod = await loadModule({ models: doc([
      { modelId: "bare.model-1", status: "candidate", notify: { requestedAt: "2026-09-24T03:00:00Z" } },
    ]) });
    const net = makeNet(makeCtx(), { batches: [[]] });
    await runScan(mod, net);
    expect(pings(net)[0].text).toBe("New model candidate: bare.model-1. Review on /models.");
  });
});
