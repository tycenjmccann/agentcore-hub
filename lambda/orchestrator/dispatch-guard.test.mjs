import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { outageKey } from "./runtime-health.mjs";

/**
 * TEAM-3991 D1.5 — the PR-aware dispatch guard.
 *
 * The orchestrator used to dispatch an agent without ever asking GitHub whether
 * the work already existed. Two prod consequences:
 *   - TEAM-3790: the PR was MERGED and the completion report never landed, so the
 *     recovery paths kept re-dispatching the agent to re-investigate finished,
 *     shipped work. The right move is to harvest the evidence (D1.2), not to run
 *     the agent again.
 *   - an OPEN PR got a fresh agent with no idea a branch existed, which started
 *     over and opened a second PR.
 *
 * So: one list call before the claim CAS, at EVERY dispatch entry point. The
 * guard fails OPEN in every unknown case — no PR, no PAT, a GitHub 401, no
 * harvestable evidence — because a guard that can strand a dispatch is worse than
 * the duplicate work it prevents.
 *
 * Harness: the §3(a) shape (real index.mjs + real evidence.mjs, mocked I/O
 * seams). GitHub AND Jira both ride one stubbed global fetch, keyed by host.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    events: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    s3Puts: /** @type {any[]} */ ([]),
    ticketUpdates: /** @type {any[]} */ ([]),
    store: {
      claimInvocation: /** @type {any[]} */ ([]),
      setResumeContext: /** @type {any[]} */ ([]),
      mergeOrTrack: /** @type {any[]} */ ([]),
    },
    /** PRs the repo's base branch returns. */
    prs: /** @type {any[]} */ ([]),
    /** Branch probe answers for the synthesize step. */
    branchAhead: 3,
    ghStatus: 200,
    ghCalls: /** @type {string[]} */ ([]),
    // TEAM-3992 D4.2 runtime-health wiring: when set, S3 serves config/agents.json
    // (so an agent's `tools` decide whether the runtime probe runs) and the
    // per-arn outage object (so the guard refuses without any bedrock call).
    roster: /** @type {any[] | null} */ (null),
    runtimeOutage: /** @type {any} */ (null),
    runtimeOutageKey: "",
    s3Deletes: /** @type {any[]} */ ([]),
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
            if (cmd.input.TableName === "agentcore-hub-events") return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "UpdateCommand") { h.state.ticketUpdates.push(cmd.input); return {}; }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send(cmd) { h.state.lambdaInvokes.push(cmd.input); return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

// S3: every GetObject 404s (no completion record exists — the D1.2 precondition);
// PutObject is the synthesized record.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "PutObjectCommand") { h.state.s3Puts.push(cmd.input); return { ETag: '"etag-put"' }; }
      if (name === "DeleteObjectCommand") { h.state.s3Deletes.push(cmd.input); return {}; }
      if (name === "GetObjectCommand") {
        const key = cmd.input.Key;
        // config/agents.json — only served when a test opts in via h.state.roster;
        // otherwise the loader falls back exactly as before (D1.5 tests unaffected).
        if (key === "config/agents.json" && h.state.roster) {
          return { Body: { transformToString: async () => JSON.stringify({ agents: h.state.roster }) } };
        }
        // The per-arn outage object (runtime-health/<sha1>.json).
        if (h.state.runtimeOutage && key === h.state.runtimeOutageKey) {
          return { Body: { transformToString: async () => JSON.stringify(h.state.runtimeOutage) }, ETag: '"etag-outage"' };
        }
        const e = new Error("The specified key does not exist.");
        e.name = "NoSuchKey";
        throw e;
      }
      return {};
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  DeleteObjectCommand: class { constructor(i) { this.input = i; } },
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

vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
  claimInvocation: vi.fn(async (wfId, tid) => { h.state.store.claimInvocation.push({ wfId, tid }); return true; }),
  setResumeContext: vi.fn(async (wfId, tid, note) => { h.state.store.setResumeContext.push({ wfId, tid, note }); }),
  removeResumeContext: vi.fn(async () => {}),
  mergeTaskMetadataOrTrack: vi.fn(async (wfId, tid, fields) => { h.state.store.mergeOrTrack.push({ wfId, tid, fields }); }),
  mergeTaskMetadata: vi.fn(async () => {}),
  completeTaskEntry: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async () => {}),
  trackTask: vi.fn(async () => {}),
  appendNotification: vi.fn(async () => {}),
  appendNotificationOnce: vi.fn(async () => true),
  appendReviewNotificationOnce: vi.fn(async () => true),
  ackNotifications: vi.fn(async () => {}),
  resetDeadSessionRetry: vi.fn(async () => {}),
  incrementDeadSessionRetry: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async () => true),
  claimTerminalOutcome: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
  setProtectionCheck: vi.fn(async () => {}),
  advancePhase: vi.fn(async () => {}),
}));

// evidence.mjs / cascade.mjs deliberately NOT mocked — the guard's whole value is
// that it reaches the REAL synthesize on a merged PR.
process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.GITHUB_PAT = "test-pat";
process.env.JIRA_SITE_URL = "example.atlassian.net";
process.env.RUNTIME_ARN_AGENTCORE_HUB_BACKEND_DEV =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/backend-dev";

const TICKET = "TEAM-3790";
const PARENT = "EPIC-1";
const DEV = "agentcore_hub_backend_dev";
const BRANCH = `feature/${TICKET}-backend-dev`;

let handler;

async function load(provider = "dynamodb") {
  process.env.TICKET_PROVIDER = provider;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
}

const eventsOfType = (type) => h.state.events.filter((e) => e.type === type);

const pr = (over = {}) => ({
  number: 327,
  state: "open",
  merged_at: null,
  html_url: "https://github.com/o/r/pull/327",
  head: { ref: BRANCH, sha: "headsha" },
  ...over,
});
const mergedPr = () => pr({ state: "closed", merged_at: "2026-09-01T10:00:00Z" });

function makeWorkflow() {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    epicId: PARENT,
    workflowDefId: "software-delivery",
    input: { title: "t" },
    featureBranch: "feature/EPIC-1-widget",
    repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
    humanNotifications: [],
    agentTasks: { [TICKET]: { id: "t1", agentId: DEV, ticketId: TICKET, status: "ready" } },
  };
}

/** The ready ticket, as a plain stream image (unwrapDdbValue passes it through). */
const readyRecord = () => ({
  eventName: "MODIFY",
  dynamodb: {
    NewImage: { ticketId: TICKET, status: "ready", assignee: DEV, parentId: PARENT, workflowId: "wf_1", type: "task", blockedBy: [] },
    OldImage: { ticketId: TICKET, status: "todo" },
  },
});

beforeEach(() => {
  h.state.tickets = {
    [TICKET]: { ticketId: TICKET, status: "ready", assignee: DEV, parentId: PARENT, workflowId: "wf_1", type: "task", blockedBy: [] },
  };
  h.state.children = [];
  h.state.workflow = makeWorkflow();
  h.state.events.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.s3Puts.length = 0;
  h.state.ticketUpdates.length = 0;
  h.state.store.claimInvocation.length = 0;
  h.state.store.setResumeContext.length = 0;
  h.state.store.mergeOrTrack.length = 0;
  h.state.prs = [];
  h.state.branchAhead = 3;
  h.state.ghStatus = 200;
  h.state.ghCalls.length = 0;
  h.state.roster = null;
  h.state.runtimeOutage = null;
  h.state.runtimeOutageKey = "";
  h.state.s3Deletes.length = 0;
  delete process.env.CODING_AGENT_RUNTIME_ARN;

  vi.stubGlobal("fetch", async (url) => {
    const u = String(url);
    // Jira (only reached in provider=jira mode) — the ready ticket.
    if (u.includes("atlassian.net")) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          key: TICKET,
          fields: {
            summary: "Backend work", status: { name: "Ready" }, issuetype: { name: "Task" },
            parent: { key: PARENT }, labels: [`agent:${DEV}`, "wf:wf_1"],
          },
        }),
      };
    }
    h.state.ghCalls.push(u);
    if (h.state.ghStatus >= 400) {
      return { ok: false, status: h.state.ghStatus, text: async () => JSON.stringify({ message: "Bad credentials" }) };
    }
    let body = null;
    if (u.includes("/pulls?")) {
      // Both the guard's base-branch list and synthesize's head-scoped list.
      body = h.state.prs;
    } else if (u.includes("/branches/")) {
      body = { name: BRANCH, commit: { sha: "headsha" } };
    } else if (u.includes("/compare/")) {
      body = { ahead_by: h.state.branchAhead };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("preDispatchGuards (D1.5) — DDB-stream ready path", () => {
  it("MERGED PR + no completion → synthesize instead of dispatch, and the refusal is journaled", async () => {
    await load();
    h.state.prs = [mergedPr()];

    await handler({ Records: [readyRecord()] });

    // The dispatch never happened: no claim, no agent invoke.
    expect(h.state.store.claimInvocation).toHaveLength(0);
    expect(h.state.lambdaInvokes).toHaveLength(0);

    const refused = eventsOfType("orchestrator.dispatch_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].detail).toMatchObject({ workflowId: "wf_1", ticketId: TICKET, refused: "pr_merged" });
    expect(refused[0].detail.detail).toMatch(/PR #327 is merged/);

    // …because the REAL D1.2 harvest ran and wrote honest, sourced evidence.
    const synth = eventsOfType("agent.completion_synthesized");
    expect(synth).toHaveLength(1);
    expect(synth[0].detail).toMatchObject({ ticketId: TICKET, aheadBy: 3 });
    expect(h.state.store.mergeOrTrack[0].fields).toMatchObject({ evidenceSource: "synthesized" });
    // The SAME key harvestCompletionEvidence / the completion gate read.
    expect(h.state.s3Puts[0].Key).toBe(`completions/${TICKET}.json`);
  });

  it("MERGED PR but NOTHING harvestable → dispatch proceeds (never refuse on a hunch)", async () => {
    await load();
    h.state.prs = [mergedPr()];
    h.state.branchAhead = 0;
    // No branch either: the probe finds no evidence at all.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url) => {
      const u = String(url);
      if (u.includes("/branches/")) return { ok: false, status: 404, text: async () => "{}" };
      return realFetch(url);
    });

    await handler({ Records: [readyRecord()] });

    expect(eventsOfType("orchestrator.dispatch_refused")).toHaveLength(0);
    expect(h.state.store.claimInvocation).toContainEqual({ wfId: "wf_1", tid: TICKET });
  });

  it("OPEN PR → resume context set, then the dispatch PROCEEDS", async () => {
    await load();
    h.state.prs = [pr()];

    await handler({ Records: [readyRecord()] });

    expect(h.state.store.setResumeContext).toHaveLength(1);
    const { wfId, tid, note } = h.state.store.setResumeContext[0];
    expect({ wfId, tid }).toEqual({ wfId: "wf_1", tid: TICKET });
    expect(note).toContain("PR #327 exists");
    expect(note).toContain(BRANCH);
    expect(note).toContain("resume, don't re-investigate");

    const set = eventsOfType("orchestrator.resume_context_set");
    expect(set).toHaveLength(1);
    expect(set[0].detail).toMatchObject({ ticketId: TICKET, prNumber: 327, state: "open" });

    // An open PR is not a refusal — the agent still runs, just informed.
    expect(eventsOfType("orchestrator.dispatch_refused")).toHaveLength(0);
    expect(h.state.store.claimInvocation).toContainEqual({ wfId: "wf_1", tid: TICKET });
  });

  it("NO PR for this ticket → proceeds, no resume context (someone else's PR is not ours)", async () => {
    await load();
    h.state.prs = [pr({ number: 99, head: { ref: "feature/TEAM-9999-other", sha: "x" } })];

    await handler({ Records: [readyRecord()] });

    expect(h.state.store.setResumeContext).toHaveLength(0);
    expect(eventsOfType("orchestrator.dispatch_refused")).toHaveLength(0);
    expect(h.state.store.claimInvocation).toContainEqual({ wfId: "wf_1", tid: TICKET });
  });

  it("GitHub unreachable → FAIL OPEN: the dispatch proceeds", async () => {
    await load();
    h.state.ghStatus = 401;

    await handler({ Records: [readyRecord()] });

    expect(h.state.ghCalls.length).toBeGreaterThan(0);
    expect(eventsOfType("orchestrator.dispatch_refused")).toHaveLength(0);
    expect(h.state.store.claimInvocation).toContainEqual({ wfId: "wf_1", tid: TICKET });
  });

  it("no repo config → not even a GitHub call", async () => {
    await load();
    h.state.prs = [mergedPr()];
    h.state.workflow = { ...makeWorkflow(), repoConfig: null };

    await handler({ Records: [readyRecord()] });

    expect(h.state.ghCalls).toHaveLength(0);
    expect(h.state.store.claimInvocation).toContainEqual({ wfId: "wf_1", tid: TICKET });
  });
});

describe("preDispatchGuards (D1.5) — the Jira-webhook ready twin", () => {
  it("the SAME guard runs on the webhook path (both ready handlers, not one)", async () => {
    await load("jira");
    h.state.prs = [mergedPr()];

    await handler({ source: "jira-webhook", ticketId: TICKET, newStatus: "ready", oldStatus: "todo" });

    expect(h.state.store.claimInvocation).toHaveLength(0);
    const refused = eventsOfType("orchestrator.dispatch_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].detail.refused).toBe("pr_merged");
  });

  it("open PR on the webhook path → resume context, dispatch proceeds", async () => {
    await load("jira");
    h.state.prs = [pr()];

    await handler({ source: "jira-webhook", ticketId: TICKET, newStatus: "ready", oldStatus: "todo" });

    expect(h.state.store.setResumeContext[0].note).toContain("PR #327 exists");
    expect(h.state.store.claimInvocation).toContainEqual({ wfId: "wf_1", tid: TICKET });
  });
});

// TEAM-3992 D4.2 — the runtime-health gate WIRED into the same pre-dispatch path.
// The pure gate logic is exhaustively covered in runtime-health.test.mjs; these
// prove the CALL exists at the ready dispatch boundary (same rationale as
// gate-bypass-wiring: a correct module nobody invokes fixes nothing) and that it
// gates ONLY coding-tooled agents. A pre-seeded outage object makes the refusal
// deterministic with zero bedrock calls.
describe("preDispatchGuards (D4.2) — coding-runtime health gate wiring", () => {
  const CODING_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/coding-xyz";
  const roster = (devTools) => [
    { agentId: DEV, phase: "development", tools: devTools },
    { agentId: "agentcore_hub_requirements_analyst", phase: "requirements", tools: [] },
  ];
  const outageObject = () => ({
    runtimeArn: CODING_ARN, state: "outage", since: "2026-09-05T11:00:00Z",
    probes: 2, backoffIdx: 0, nextProbeAt: "2026-09-05T11:05:00Z",
    lastError: "probe failed", blockedTickets: [], outageEventId: "outage-x",
  });

  it("coding-tooled agent + open outage → refused runtime_outage, parked, NOT dispatched", async () => {
    process.env.CODING_AGENT_RUNTIME_ARN = CODING_ARN;
    await load();
    h.state.roster = roster(["claude_code"]);
    h.state.runtimeOutageKey = outageKey(CODING_ARN);
    h.state.runtimeOutage = outageObject();

    await handler({ Records: [readyRecord()] });

    // No dispatch: the ticket was parked, not invoked.
    expect(h.state.store.claimInvocation).toHaveLength(0);
    expect(h.state.lambdaInvokes).toHaveLength(0);

    const refused = eventsOfType("orchestrator.dispatch_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].detail.refused).toBe("runtime_outage");

    // Parked blocked:runtime in DynamoDB…
    const parked = h.state.ticketUpdates.find((u) => u.ExpressionAttributeValues?.[":br"] === "runtime");
    expect(parked).toBeTruthy();
    expect(parked.ExpressionAttributeValues[":s"]).toBe("blocked");
    // …and recorded in the outage object via a CAS (PutObject IfMatch), no bedrock call.
    const put = h.state.s3Puts.find((p) => p.Key === h.state.runtimeOutageKey);
    expect(put?.IfMatch).toBe('"etag-outage"');
  });

  it("non-coding agent bypasses the probe entirely even during an open outage", async () => {
    process.env.CODING_AGENT_RUNTIME_ARN = CODING_ARN;
    await load();
    h.state.roster = roster([]); // the dev agent shells no coding CLI here
    h.state.runtimeOutageKey = outageKey(CODING_ARN);
    h.state.runtimeOutage = outageObject();
    h.state.prs = []; // the repo/PR guard finds nothing → dispatch proceeds

    await handler({ Records: [readyRecord()] });

    // The gate never consulted the outage object: no refusal, no runtime park.
    expect(eventsOfType("orchestrator.dispatch_refused")).toHaveLength(0);
    expect(h.state.ticketUpdates.find((u) => u.ExpressionAttributeValues?.[":br"] === "runtime")).toBeUndefined();
    expect(h.state.store.claimInvocation).toContainEqual({ wfId: "wf_1", tid: TICKET });
  });

  it("no CODING_AGENT_RUNTIME_ARN → gate dark, coding agent dispatches normally", async () => {
    // Env deliberately unset (beforeEach clears it).
    await load();
    h.state.roster = roster(["claude_code"]);
    h.state.runtimeOutageKey = outageKey(CODING_ARN);
    h.state.runtimeOutage = outageObject();
    h.state.prs = [];

    await handler({ Records: [readyRecord()] });

    expect(eventsOfType("orchestrator.dispatch_refused")).toHaveLength(0);
    expect(h.state.store.claimInvocation).toContainEqual({ wfId: "wf_1", tid: TICKET });
  });
});
