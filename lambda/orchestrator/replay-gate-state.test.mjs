import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contentKey } from "./event-id.mjs";

/**
 * TEAM-4120 FR-1 acceptance replay — real review-gate streams through the
 * guarded `→ blocked` twins.
 *
 * gate-state.test.mjs pins the truth table and gate-state-guard.test.mjs pins the
 * hooks against synthetic transitions. This file replays the gate history of
 * REAL runs and asserts the number that actually matters: with the guard on, the
 * orchestrator reopens upstream work exactly as often as a human really asked
 * for changes — which, across every run we have a dossier for, is ZERO times.
 *
 * Fixtures (reduced dossiers, committed for the FR-2 consumer work):
 *   - deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json
 *     s3://{ARTIFACT_BUCKET}/analysis/wf_1788582225496_yteqfl/dossier.json —
 *     slice: workflow row + 24 tickets + 332 events. Gate TEAM-4067 (Merge
 *     Approval, human:engineer): created 04:38:39.251Z, a `review.rejected`
 *     4.0s later (the TEAM-4044 creation-time `todo → blocked`, which #364's
 *     isCreationTimeBlock now short-circuits), first and only presentation
 *     11:20:07.009Z, approved 18:21:02.129Z. Real human rejections: 0.
 *   - deploy/workflow-manager/toolkit/fixtures/sffzti-dossier.json
 *     s3://{ARTIFACT_BUCKET}/analysis/wf_1788416098262_sffzti/dossier.json —
 *     slice: workflow row + 13 tickets + 255 events. Two human gates: TEAM-3800
 *     (Merge Approval — created 2026-09-03T06:19:27.647Z, creation-time
 *     `review.rejected` 4.3s later, presented 2026-09-04T21:54:01.908Z, approved
 *     ~22:03Z) and TEAM-3972 (Escalation #1 — presented 21:26:56.966Z, approved,
 *     never rejected). Real human rejections: 0.
 *   - TEAM4045_PATTERN below is RECONSTRUCTED, not a dossier: the three runs the
 *     isCreationTimeBlock comment cites (c5y8xg wf_1788579775507, bwastu
 *     wf_1788579725173, trf22q wf_1788579742292) have NO analysis dossier in S3.
 *
 * Every dossier event is present TWICE (the EventBridge/direct double-write FR-2
 * collapses), so the replay dedupes by the real `contentKey` first — the same key
 * the producer and the cost-report consumer use.
 */

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const fixturePath = (name) =>
  fileURLToPath(new URL(`../../deploy/workflow-manager/toolkit/fixtures/${name}-dossier.json`, import.meta.url));
const loadDossier = (name) => JSON.parse(readFileSync(fixturePath(name), "utf8"));

const YTEQFL = loadDossier("yteqfl");
const SFFZTI = loadDossier("sffzti");

/**
 * RECONSTRUCTED — "TEAM-4045 pattern, no dossier available".
 *
 * The three runs TEAM-4045 was filed from (c5y8xg / bwastu / trf22q, all
 * 2026-09-05) predate the analysis dossiers, so this encodes the pattern the
 * isCreationTimeBlock comment in index.mjs documents rather than a captured run:
 * the Merge Approval gate is created in `todo` with its blocked_by chain, the
 * ticket Lambda's routing write lands as `todo → blocked` seconds later, and the
 * orchestrator read THAT as "Request changes" — reopening the Ship ticket and
 * dispatching the release manager at requirements time, on every run. The gate is
 * then presented once, much later, and approved. Ticket ids are placeholders in
 * the observed numbering; the timings and event shapes are the real pattern.
 */
const TEAM4045_PATTERN = {
  workflowId: "wf_1788579775507",
  epicId: "TEAM-4040",
  workflow: {
    id: "wf_1788579775507",
    workflowId: "wf_1788579775507",
    epicId: "TEAM-4040",
    workflowDefId: "software-delivery",
    phase: "ship",
    humanNotifications: [],
    agentTasks: {},
    repoConfig: { layout: "monorepo", repos: [{ platform: "backend", url: "https://github.com/tycenjmccann/agentcore-hub.git", defaultBranch: "main" }] },
  },
  tickets: [
    { ticketId: "TEAM-4040", title: "c5y8xg root", status: "done", assignee: null, type: "epic", parentId: null, workflowId: "wf_1788579775507", createdAt: "2026-09-05T03:42:55.507Z", updatedAt: "2026-09-05T09:12:00.000Z" },
    { ticketId: "TEAM-4047", title: "Ship: deploy the fix", status: "done", assignee: "agentcore_hub_release_manager", type: "task", parentId: "TEAM-4040", workflowId: "wf_1788579775507", blockedBy: [], createdAt: "2026-09-05T03:42:56.100Z", updatedAt: "2026-09-05T08:55:00.000Z" },
    { ticketId: "TEAM-4048", title: "Merge Approval: c5y8xg", status: "done", assignee: "human:engineer", type: "task", parentId: "TEAM-4040", workflowId: "wf_1788579775507", blockedBy: ["TEAM-4047"], createdAt: "2026-09-05T03:42:57.010Z", updatedAt: "2026-09-05T09:05:41.000Z" },
  ],
  // Double-written, exactly as the real dossiers carry them.
  events: [
    { type: "review.rejected", timestamp: "2026-09-05T03:43:01.240Z", eventId: "1788579781240-aaaa", detail: { ticketId: "TEAM-4048", timestamp: "2026-09-05T03:43:01.240Z", workflowId: "wf_1788579775507", onReject: "rework", reopened: ["TEAM-4047"] } },
    { type: "review.rejected", timestamp: "2026-09-05T03:43:01Z", eventId: "0mtnzzz01-0000", detail: { workflowId: "wf_1788579775507", ticketId: "TEAM-4048", onReject: "rework", reopened: ["TEAM-4047"], timestamp: "2026-09-05T03:43:01.240Z" } },
    { type: "review.needed", timestamp: "2026-09-05T08:58:12.400Z", eventId: "1788599892400-bbbb", detail: { ticketId: "TEAM-4048", timestamp: "2026-09-05T08:58:12.400Z", workflowId: "wf_1788579775507", reviewer: "engineer" } },
    { type: "review.needed", timestamp: "2026-09-05T08:58:12.400Z", eventId: "0mto1111-0000", detail: { reviewer: "engineer", ticketId: "TEAM-4048", workflowId: "wf_1788579775507", timestamp: "2026-09-05T08:58:12.400Z" } },
  ],
};

const FIXTURES = {
  yteqfl: YTEQFL,
  sffzti: SFFZTI,
  "TEAM-4045 pattern": TEAM4045_PATTERN,
};

// ─── Deriving the gate transition stream from a dossier ────────────────────────

/** Unique events by CONTENT (the double-write's two copies collapse to one). */
function dedupe(events) {
  const seen = new Set();
  return (events || []).filter((e) => {
    const k = contentKey(e.type, e.detail);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const humanGates = (d) => (d.tickets || []).filter((t) => String(t.assignee || "").startsWith("human:"));

const CREATION_WINDOW_MS = 60_000;

/**
 * The status transitions the orchestrator saw for every human gate in a run:
 *   review.rejected → `→ blocked` (oldStatus "todo" when it lands within 60s of
 *     the gate's creation — that IS the creation-time dependency block — else
 *     "in_review", a rejection off a presented gate)
 *   review.needed   → the presentation (`todo → ready`, the Ready path that
 *     parks the gate and pages the reviewer)
 *   status done     → `in_review → done` (the approval)
 * Returned in timestamp order, exactly as the trigger delivered them.
 */
function deriveGateTransitions(dossier) {
  const events = dedupe(dossier.events);
  const rows = [];
  for (const gate of humanGates(dossier)) {
    const createdAt = Date.parse(gate.createdAt);
    for (const e of events) {
      if (e.detail?.ticketId !== gate.ticketId) continue;
      const at = e.detail?.timestamp || e.timestamp;
      if (e.type === "review.rejected") {
        const creationTime = Number.isFinite(createdAt) && Date.parse(at) - createdAt < CREATION_WINDOW_MS;
        rows.push({ at, ticketId: gate.ticketId, kind: "reject", oldStatus: creationTime ? "todo" : "in_review", newStatus: "blocked", creationTime });
      }
      if (e.type === "review.needed") {
        rows.push({ at, ticketId: gate.ticketId, kind: "present", oldStatus: "todo", newStatus: "ready" });
      }
    }
    if (gate.status === "done") {
      rows.push({ at: new Date(gate.updatedAt).toISOString(), ticketId: gate.ticketId, kind: "approve", oldStatus: "in_review", newStatus: "done" });
    }
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The synthetic tail every fixture also gets: the two `→ blocked` shapes no real
 * run in our dossiers produced, so enforce's drop arms are exercised on real
 * state. 1s after the approval (gate `approved` → unrequested), then a fresh
 * presentation followed by the SAME rejection twice (admitted, then duplicate).
 */
function syntheticTail(rows, ticketId) {
  const lastAt = Date.parse(rows[rows.length - 1]?.at || "2026-09-05T12:00:00Z");
  const at = (offsetMs) => new Date(lastAt + offsetMs).toISOString();
  return [
    { at: at(1000), ticketId, kind: "reject", oldStatus: "in_review", newStatus: "blocked", synthetic: "post_approval" },
    { at: at(2000), ticketId, kind: "present", oldStatus: "todo", newStatus: "ready", synthetic: "re_present" },
    { at: at(3000), ticketId, kind: "reject", oldStatus: "in_review", newStatus: "blocked", synthetic: "first_real" },
    { at: at(4000), ticketId, kind: "reject", oldStatus: "in_review", newStatus: "blocked", synthetic: "redelivery" },
  ];
}

// ─── Harness (same mocked seams as gate-state-guard.test.mjs) ──────────────────

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflows: /** @type {Record<string, any>} */ ({}),
    events: /** @type {any[]} */ ([]),
    updates: /** @type {any[]} */ ([]),
    gateWrites: /** @type {any[]} */ ([]),
    workflowReads: 0,
    reopens: 0, // handleReviewRejection reached (observed via the review cap)
    s3Objects: /** @type {Record<string, string>} */ ({}),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand { constructor(input) { this.input = input; } }
  class PutCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const name = cmd.constructor.name;
          if (name === "GetCommand") return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          if (name === "QueryCommand") {
            if (String(cmd.input.TableName).includes("events")) return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "ScanCommand") return { Items: [] };
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  // Only the CD registry is served (these runs' repo WAS registered for
  // merge+deploy — yteqfl's delivery.mode is "cd"); every other artifact read
  // misses, which index.mjs treats as non-fatal.
  S3Client: class {
    async send(cmd) {
      const body = h.state.s3Objects[cmd.input?.Key];
      if (body === undefined) throw new Error("NoSuchKey");
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

/**
 * The store mock MUTATES the in-memory workflow row, with the same CAS semantics
 * the real conditional writes have — that is what makes a replay meaningful: a
 * transition classified late in the stream sees the state earlier transitions
 * left behind. Rows start with NO gateStates (a legacy run, exactly as both
 * dossiers show it) and are seeded on first touch like ensureGateState does.
 */
vi.mock("./workflow-store.mjs", () => {
  const row = (wfId, ticketId) => {
    const wf = h.state.workflows[wfId];
    if (!wf) return null;
    wf.gateStates = wf.gateStates || {};
    wf.gateStates[ticketId] = wf.gateStates[ticketId] || { state: "none", cycles: [] };
    return wf.gateStates[ticketId];
  };
  const inert = () => vi.fn(async () => {});
  return {
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => {
      h.state.workflowReads++;
      return h.state.workflows[id] || null;
    }),
    markGateRequested: vi.fn(async (wfId, ticketId, at) => {
      const r = row(wfId, ticketId);
      const claimed = !!r && r.state !== "requested";
      h.state.gateWrites.push({ op: "requested", wfId, ticketId, claimed });
      if (!claimed) return false;
      r.state = "requested";
      r.requestedAt = at;
      return true;
    }),
    markGateRejected: vi.fn(async (wfId, ticketId, at, { requestedAt } = {}) => {
      const r = row(wfId, ticketId);
      const claimed = !!r && r.state === "requested";
      h.state.gateWrites.push({ op: "rejected", wfId, ticketId, claimed });
      if (!claimed) return null;
      r.state = "rejected";
      r.resolvedAt = at;
      r.cycles.push({ requestedAt: requestedAt ?? null, resolvedAt: at, outcome: "rejected" });
      return { ...r };
    }),
    markGateApproved: vi.fn(async (wfId, ticketId, at, { requestedAt } = {}) => {
      const r = row(wfId, ticketId);
      const claimed = !!r && (r.state === "requested" || r.state === "rejected");
      h.state.gateWrites.push({ op: "approved", wfId, ticketId, claimed });
      if (!claimed) return null;
      r.state = "approved";
      r.resolvedAt = at;
      r.cycles.push({ requestedAt: requestedAt ?? null, resolvedAt: at, outcome: "approved" });
      return { ...r };
    }),
    // The park path: truthy = THIS call appended the reviewer's notification.
    appendReviewNotificationOnce: vi.fn(async () => true),
    // Everything else the replayed handlers touch, inert. claimFinalization /
    // claimTerminalOutcome return false ("another writer owns it") so a replayed
    // approval can never wander into the finalization machinery.
    ackNotifications: inert(),
    setResumeContext: inert(),
    removeResumeContext: inert(),
    completeTaskEntry: inert(),
    claimInvocation: vi.fn(async () => false),
    setTaskStatus: inert(),
    mergeTaskMetadata: inert(),
    trackTicket: inert(),
    advancePhase: inert(),
    appendNotification: inert(),
    adoptFeatureBranch: inert(),
    setDelivery: inert(),
    setShipHeadDeferrals: inert(),
    resetDeadSessionRetry: inert(),
    claimFinalization: vi.fn(async () => false),
    claimTerminalOutcome: vi.fn(async () => false),
    markFinalized: inert(),
    completeWorkflow: inert(),
    createWorkflow: inert(),
  };
});

vi.mock("./review-cap.mjs", async () => {
  const actual = await vi.importActual("./review-cap.mjs");
  return {
    parseDecision: actual.parseDecision,
    // escalated:true short-circuits handleReviewRejection before the re-open
    // loop — reaching the cap IS "the orchestrator acted on this rejection".
    createReviewCap: () => ({ enforce: async () => { h.state.reopens++; return { escalated: true, effectiveRounds: 3, maxRounds: 3 }; } }),
  };
});

let handler;

const CD_REGISTRY = JSON.stringify({ version: 1, repos: [{ repo: "tycenjmccann/agentcore-hub", pipeline: "agentcore-hub-deploy" }] });

/**
 * index.mjs snapshots GATE_STATE_GUARD + TICKET_PROVIDER at load, so each
 * (mode, provider) pair needs its own import — but only ONE: re-importing a
 * 4.9k-line module is by far the most expensive thing here, and seed() resets
 * every piece of state a replay touches. Consecutive tests sharing a pair share
 * the module (13 imports → 4, ~9s → ~3s).
 */
let loadedKey = null;
async function load(mode, provider) {
  if (mode === undefined) delete process.env.GATE_STATE_GUARD;
  else process.env.GATE_STATE_GUARD = mode;
  process.env.TICKET_PROVIDER = provider;
  const key = `${mode}|${provider}`;
  if (key === loadedKey && handler) return;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
  loadedKey = key;
}

// ─── Provider fixtures: the dossier's tickets, as each backend serves them ─────

const JIRA_STATUS = { done: "Done", todo: "To Do", ready: "Ready", blocked: "Blocked", in_review: "In Review", in_progress: "In Progress" };

const asJiraIssue = (t) => ({
  key: t.ticketId,
  fields: {
    summary: t.title || t.ticketId,
    status: { name: JIRA_STATUS[t.status] || "To Do" },
    labels: [
      ...(String(t.assignee || "").startsWith("human:")
        ? ["human-review", `reviewer:${String(t.assignee).slice("human:".length)}`]
        : t.assignee ? [`agent:${t.assignee}`] : []),
      ...(t.workflowId ? [`wf:${t.workflowId}`] : []),
    ],
    issuetype: { name: t.type === "epic" ? "Epic" : "Task" },
    ...(t.parentId ? { parent: { key: t.parentId } } : {}),
    issuelinks: (t.blockedBy || []).map((k) => ({ type: { inward: "is blocked by" }, inwardIssue: { key: k } })),
    comment: { comments: [] },
  },
});

const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj) });

/** Every Jira REST call the replayed handlers can make, served from the dossier. */
function jiraRouter(dossier) {
  const issues = Object.fromEntries((dossier.tickets || []).map((t) => [t.ticketId, asJiraIssue(t)]));
  return vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/search/jql")) return jsonResp({ issues: Object.values(issues) });
    const m = u.match(/\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?/);
    if (!m) return jsonResp({});
    const [, key, sub] = m;
    if (sub === "/transitions") {
      if ((init.method || "GET") === "GET") {
        return jsonResp({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }, { id: "21", name: "In Review", to: { name: "In Review" } }] });
      }
      return { ok: true, status: 204, text: async () => "" };
    }
    if (sub === "/comment") return jsonResp({}, 201);
    return issues[key] ? jsonResp(issues[key]) : { ok: false, status: 404, text: async () => "not found" };
  });
}

/** A DDB-stream MODIFY for one derived transition (plain values pass unwrapDdbValue). */
const streamRecord = (dossier, row) => {
  const t = (dossier.tickets || []).find((x) => x.ticketId === row.ticketId) || {};
  return {
    Records: [{
      eventName: "MODIFY",
      eventSource: "aws:dynamodb",
      dynamodb: {
        NewImage: {
          ticketId: { S: row.ticketId }, status: { S: row.newStatus }, assignee: { S: t.assignee },
          workflowId: { S: t.workflowId }, parentId: { S: t.parentId }, type: { S: "task" },
          title: { S: t.title || row.ticketId },
        },
        OldImage: { ticketId: { S: row.ticketId }, status: { S: row.oldStatus }, assignee: { S: t.assignee } },
      },
    }],
  };
};

/** Reset the world to the run as it was BEFORE the guard existed (no gateStates). */
function seed(dossier) {
  h.state.tickets = Object.fromEntries((dossier.tickets || []).map((t) => [t.ticketId, { ...t }]));
  h.state.children = (dossier.tickets || []).map((t) => ({ ...t }));
  const wf = structuredClone(dossier.workflow);
  delete wf.gateStates; // legacy row — the ledger starts empty on every replay
  h.state.workflows = { [wf.id]: wf };
  h.state.events.length = 0;
  h.state.updates.length = 0;
  h.state.gateWrites.length = 0;
  h.state.workflowReads = 0;
  h.state.reopens = 0;
  h.state.s3Objects = { "config/cd-registry.json": CD_REGISTRY };
}

const ignoredEvents = () => h.state.events.filter((e) => e.type === "gate.reject_ignored").map((e) => e.detail);

/**
 * Replay one derived transition and record what the orchestrator did with it.
 * Deltas (not totals) so each row of the observed table stands alone.
 */
async function step(dossier, row, { twin }) {
  const before = { reopens: h.state.reopens, reads: h.state.workflowReads, writes: h.state.gateWrites.length, ignored: ignoredEvents().length };
  if (twin === "stream") await handler(streamRecord(dossier, row));
  else await handler({ source: "jira-webhook", ticketId: row.ticketId, newStatus: row.newStatus, oldStatus: row.oldStatus });
  const drops = ignoredEvents().slice(before.ignored);
  return {
    ...row,
    admitted: h.state.reopens - before.reopens,
    reads: h.state.workflowReads - before.reads,
    writes: h.state.gateWrites.slice(before.writes),
    dropReason: drops[0]?.reason ?? null,
    dropState: drops[0]?.gateState ?? null,
    wouldDrop: drops[0]?.wouldDrop ?? null,
  };
}

/** The whole stream (real + synthetic tail), in order, through one twin. */
async function replay(dossier, { mode, twin = "webhook", withSynthetic = true }) {
  await load(mode, twin === "stream" ? "dynamodb" : "jira");
  if (twin === "webhook") global.fetch = jiraRouter(dossier);
  seed(dossier);
  const real = deriveGateTransitions(dossier);
  const gate = humanGates(dossier)[0].ticketId;
  const rows = withSynthetic ? [...real, ...syntheticTail(real, gate)] : real;
  const observed = [];
  for (const row of rows) observed.push(await step(dossier, row, { twin }));
  return observed;
}

const ORIGINAL_FETCH = global.fetch;
// Production PACING, collapsed: an approved gate's done path sleeps
// COMPLETION_RECHECK_DELAY_MS (1500ms) before re-reading the completion snapshot,
// and the Jira reopen hops retry on a 1s backoff. Both are real and irrelevant to
// what is under test, so every delay is clamped to 0 — the ORDER of awaits (which
// is what a replay pins) is untouched.
const REAL_SET_TIMEOUT = global.setTimeout;
beforeEach(() => {
  global.setTimeout = ((fn, _ms, ...args) => REAL_SET_TIMEOUT(fn, 0, ...args));
  process.env.ARTIFACT_BUCKET = "test-bucket";
  process.env.JIRA_SITE_URL = "jira.test";
  process.env.JIRA_EMAIL = "bot@test";
  process.env.JIRA_API_TOKEN = "t";
});
afterEach(() => {
  global.setTimeout = REAL_SET_TIMEOUT;
  global.fetch = ORIGINAL_FETCH;
  delete process.env.GATE_STATE_GUARD;
  delete process.env.TICKET_PROVIDER;
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.JIRA_SITE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
});

// ─── FR-0: the double-write the replay has to collapse first ───────────────────

describe("dossier events are double-written — the replay dedupes by content (FR-0/FR-2)", () => {
  it("yteqfl carries TEAM-4067's review.rejected and review.needed twice, one of each by content", () => {
    const forGate = (events, type) => events.filter((e) => e.type === type && e.detail?.ticketId === "TEAM-4067");
    expect(forGate(YTEQFL.events, "review.rejected")).toHaveLength(2);
    expect(forGate(YTEQFL.events, "review.needed")).toHaveLength(2);
    expect(forGate(dedupe(YTEQFL.events), "review.rejected")).toHaveLength(1);
    expect(forGate(dedupe(YTEQFL.events), "review.needed")).toHaveLength(1);
    // The two copies carry different eventIds and even different ROW timestamps
    // — only detail.timestamp is shared, which is what contentKey keys on.
    expect(new Set(forGate(YTEQFL.events, "review.rejected").map((e) => e.eventId)).size).toBe(2);
  });

  it("sffzti's two gates dedupe to one review.needed each and one creation-time rejection", () => {
    const u = dedupe(SFFZTI.events);
    expect(u.filter((e) => e.type === "review.needed" && e.detail?.ticketId === "TEAM-3800")).toHaveLength(1);
    expect(u.filter((e) => e.type === "review.needed" && e.detail?.ticketId === "TEAM-3972")).toHaveLength(1);
    expect(u.filter((e) => e.type === "review.rejected")).toHaveLength(1);
    // sffzti's copies disagree on the row timestamp (…:31Z vs …:31.905Z), so a
    // timestamp-keyed dedupe would keep both. contentKey uses detail.timestamp.
    expect(new Set(SFFZTI.events.filter((e) => e.type === "review.rejected").map((e) => e.timestamp)).size).toBe(2);
  });
});

// ─── The derived transition tables (the replay's input, pinned) ────────────────

describe("derived transition streams", () => {
  it("yteqfl: one creation-time block, one presentation, one approval — in that order", () => {
    expect(deriveGateTransitions(YTEQFL)).toEqual([
      { at: "2026-09-05T04:38:43.243Z", ticketId: "TEAM-4067", kind: "reject", oldStatus: "todo", newStatus: "blocked", creationTime: true },
      { at: "2026-09-05T11:20:07.009Z", ticketId: "TEAM-4067", kind: "present", oldStatus: "todo", newStatus: "ready" },
      { at: "2026-09-05T18:21:02.129Z", ticketId: "TEAM-4067", kind: "approve", oldStatus: "in_review", newStatus: "done" },
    ]);
    // 4.0s after the gate was created — inside the creation window by 56s.
    expect(Date.parse("2026-09-05T04:38:43.243Z") - Date.parse(YTEQFL.tickets.find((t) => t.ticketId === "TEAM-4067").createdAt)).toBe(3992);
  });

  it("sffzti: two gates interleaved — TEAM-3800's creation block, then TEAM-3972's cycle, then TEAM-3800's", () => {
    expect(deriveGateTransitions(SFFZTI).map((r) => `${r.at} ${r.ticketId} ${r.kind}`)).toEqual([
      "2026-09-03T06:19:31.905Z TEAM-3800 reject",
      "2026-09-04T21:26:56.966Z TEAM-3972 present",
      "2026-09-04T21:53:27.635Z TEAM-3972 approve",
      "2026-09-04T21:54:01.908Z TEAM-3800 present",
      "2026-09-04T22:03:36.644Z TEAM-3800 approve",
    ]);
  });

  it("TEAM-4045 pattern: the reconstructed creation block, presentation and approval", () => {
    expect(deriveGateTransitions(TEAM4045_PATTERN).map((r) => `${r.kind}:${r.oldStatus}`)).toEqual([
      "reject:todo", "present:todo", "approve:in_review",
    ]);
  });
});

// ─── enforce ──────────────────────────────────────────────────────────────────

describe("GATE_STATE_GUARD=enforce — replayed runs reopen work exactly as often as a human asked", () => {
  for (const [name, dossier] of Object.entries(FIXTURES)) {
    it(`${name}: zero admitted rejections across the real stream (real human rejections: 0)`, async () => {
      const observed = await replay(dossier, { mode: "enforce", withSynthetic: false });

      // THE acceptance number: no upstream work is reopened anywhere in the run.
      expect(observed.reduce((n, r) => n + r.admitted, 0)).toBe(0);
      expect(h.state.reopens).toBe(0);
      expect(h.state.events.filter((e) => e.type === "review.rejected")).toHaveLength(0);

      // …and nothing was reopened BEFORE the gate was first presented, either.
      const firstPresent = observed.findIndex((r) => r.kind === "present");
      expect(firstPresent).toBeGreaterThanOrEqual(0);
      expect(observed.slice(0, firstPresent).every((r) => r.admitted === 0)).toBe(true);

      // The creation-time `todo → blocked` never reaches the classifier: the
      // TEAM-4044 check is ahead of ALL I/O, so it costs zero workflow reads and
      // writes nothing to the ledger.
      for (const r of observed.filter((x) => x.kind === "reject" && x.creationTime)) {
        expect(r.reads).toBe(0);
        expect(r.writes).toEqual([]);
        expect(r.dropReason).toBeNull();
      }
      expect(ignoredEvents()).toEqual([]);

      // Each presentation opened a cycle; each approval closed one.
      for (const r of observed.filter((x) => x.kind === "present")) {
        expect(r.writes.filter((w) => w.op === "requested" && w.claimed)).toHaveLength(1);
      }
      for (const r of observed.filter((x) => x.kind === "approve")) {
        expect(r.writes.filter((w) => w.op === "approved" && w.claimed)).toHaveLength(1);
      }
      for (const gate of humanGates(dossier)) {
        const row = h.state.workflows[dossier.workflow.id].gateStates[gate.ticketId];
        expect(row.state).toBe("approved");
        expect(row.cycles.map((c) => c.outcome)).toEqual(["approved"]);
      }
    });

    it(`${name}: the synthetic tail — post-approval blocked is unrequested, the redelivery is a duplicate`, async () => {
      const observed = await replay(dossier, { mode: "enforce" });
      const synth = (tag) => observed.find((r) => r.synthetic === tag);

      // A `→ blocked` on a gate the human already approved: nothing is pending.
      expect(synth("post_approval")).toMatchObject({ admitted: 0, dropReason: "unrequested", dropState: "approved" });
      // Re-presented (a human re-opened the gate), then rejected for real…
      expect(synth("re_present").writes.filter((w) => w.op === "requested" && w.claimed)).toHaveLength(1);
      expect(synth("first_real")).toMatchObject({ admitted: 1, dropReason: null });
      // …and the SAME rejection delivered again is dropped as a duplicate.
      expect(synth("redelivery")).toMatchObject({ admitted: 0, dropReason: "duplicate" });

      // One admitted rejection in total, for the one real "Request changes".
      expect(h.state.reopens).toBe(1);
      expect(ignoredEvents().map((d) => d.reason)).toEqual(["unrequested", "duplicate"]);
      expect(ignoredEvents().every((d) => d.wouldDrop === true && d.mode === "enforce")).toBe(true);
    });
  }

  it("yteqfl through the DDB-stream twin behaves identically to the webhook twin", async () => {
    const observed = await replay(YTEQFL, { mode: "enforce", twin: "stream" });
    const synth = (tag) => observed.find((r) => r.synthetic === tag);

    expect(observed.filter((r) => !r.synthetic).reduce((n, r) => n + r.admitted, 0)).toBe(0);
    const creation = observed.find((r) => r.creationTime);
    expect(creation).toMatchObject({ reads: 0, dropReason: null });
    expect(synth("post_approval")).toMatchObject({ admitted: 0, dropReason: "unrequested", dropState: "approved" });
    expect(synth("first_real")).toMatchObject({ admitted: 1 });
    expect(synth("redelivery")).toMatchObject({ admitted: 0, dropReason: "duplicate" });
    expect(h.state.reopens).toBe(1);
  });
});

// ─── shadow ───────────────────────────────────────────────────────────────────

describe("GATE_STATE_GUARD=shadow — the same replay drops nothing but reports every would-be drop", () => {
  for (const [name, dossier] of Object.entries(FIXTURES)) {
    it(`${name}: every non-creation blocked still reaches the rework path, with wouldDrop:true reported`, async () => {
      const observed = await replay(dossier, { mode: "shadow" });
      const blocked = observed.filter((r) => r.kind === "reject" && !r.creationTime);

      // Not one of them is dropped — shadow is measurement, not enforcement.
      expect(blocked.every((r) => r.admitted === 1)).toBe(true);
      expect(h.state.reopens).toBe(blocked.length);
      expect(blocked.length).toBe(3); // the synthetic tail's three
      // The two enforce WOULD have dropped are reported anyway.
      expect(ignoredEvents().map((d) => d.reason)).toEqual(["unrequested", "duplicate"]);
      expect(ignoredEvents().every((d) => d.wouldDrop === true && d.mode === "shadow")).toBe(true);
      // The creation-time block is still invisible to the guard in shadow too.
      expect(observed.filter((r) => r.creationTime).every((r) => r.reads === 0 && r.dropReason === null)).toBe(true);
    });
  }
});

// ─── off ──────────────────────────────────────────────────────────────────────

describe("GATE_STATE_GUARD unset — the replay reproduces main's behavior exactly", () => {
  for (const [name, dossier] of Object.entries(FIXTURES)) {
    it(`${name}: no ledger writes, no reports, and no extra workflow read`, async () => {
      const observed = await replay(dossier, { mode: undefined });
      const blocked = observed.filter((r) => r.kind === "reject" && !r.creationTime);

      // Same behavior as before the guard: every presented rejection acted on…
      expect(blocked.every((r) => r.admitted === 1)).toBe(true);
      // …every creation-time block still ignored ahead of all I/O…
      expect(observed.filter((r) => r.creationTime).every((r) => r.reads === 0)).toBe(true);
      // …and nothing the guard adds ever happens.
      expect(h.state.gateWrites).toEqual([]);
      expect(ignoredEvents()).toEqual([]);
      expect(h.state.workflows[dossier.workflow.id].gateStates).toBeUndefined();
      // One workflow read per acted-on rejection (handleReviewRejection's own);
      // the guard's extra resolveWorkflow never runs.
      expect(blocked.every((r) => r.reads === 1)).toBe(true);
    });
  }
});
