import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Replay: wf_1788582225496_yteqfl, the loop-6 shape (TEAM-4122 FR-6).
 *
 * That run really did hit this. `main` moved while three bug-fixer tickets were
 * pushing to `feature/TEAM-4054-submit-workflow-source-validation-reject`, and
 * the run's own CI agent eventually had to file TEAM-4106 by hand —
 * "Fix (CI): merge origin/main (≥ 10955cd0) into feature/TEAM-4054…" — which is
 * exactly the ticket SYNC_MAIN_BEFORE_CI=enforce now files BEFORE dispatching CI
 * instead of after a green-but-stale certification.
 *
 * index.mjs is REAL here: the fixture drives `handler` on the Jira-webhook entry
 * (the run's own provider — `ticketProvider: "jira"` in the dossier), which is
 * the real `handleTicketReadyUnified`, its real claim, its real `syncDeps()`,
 * the real `githubRequestRaw`/`githubApi` (through a `fetch` router) and the real
 * `invokeTickets`/`addBlockers`. Only the process boundaries are mocked: the AWS
 * SDK clients, `workflow-store.mjs` and `fetch`.
 *
 * sync-main.test.mjs owns the module's own matrix. What is only observable HERE:
 *
 *   1. a conflict files EXACTLY ONE `sync_fix` ticket, blocks the CI ticket on it
 *      and never reaches the agent-invoke seam — no CI run happens against a head
 *      that provably cannot merge, so no misleading certification can exist;
 *   2. a REDELIVERY of the same Ready webhook (Jira fires twins, and the conflict
 *      path deliberately releases the claim so the CAS cannot serialize them)
 *      files NO second ticket — the `already_ticketed` arm in sync-main.mjs;
 *   3. once the dev lands the merge, the very same ready event dispatches CI
 *      exactly once, against the synced head;
 *   4. shadow reads and says so but writes nothing; unset costs zero GitHub calls.
 */

const WF = "wf_1788582225496_yteqfl";
const EPIC = "TEAM-4054";
const CI = "TEAM-4065"; // "CI: Validate build and tests for submit_workflow source validation fix"
const FIX = "TEAM-4200"; // what the tickets Lambda answers create_ticket with
const BRANCH = "feature/TEAM-4054-submit-workflow-source-validation-reject";
const REPO_URL = "https://github.com/tycenjmccann/agentcore-hub.git";
const OWNER = "tycenjmccann";
const REPO = "agentcore-hub";
const CI_AGENT = "agentcore_hub_ci_agent";
const BUG_FIXER = "agentcore_hub_bug_fixer";
const JIRA_SITE = "acme.atlassian.net";

/** main as it stood when TEAM-4064 closed, and after the sibling merge landed. */
const MAIN_SHA_OLD = "10955cd0aa11ee22ff33445566778899aabbccdd";
const MAIN_SHA_NEW = "beef1234aa11ee22ff33445566778899aabbccdd";
const MERGE_SHA = "5ee0e0ffaa11ee22ff33445566778899aabbccdd";

const RP = `/repos/${OWNER}/${REPO}`;
const BRANCHES_MAIN = `${RP}/branches/main`;
const MERGES = `${RP}/merges`;
const CMP_BASE_HEAD = `${RP}/compare/${encodeURIComponent(BRANCH)}...main`;
const CMP_HEAD_BASE = `${RP}/compare/main...${encodeURIComponent(BRANCH)}`;

const h = vi.hoisted(() => ({
  state: {
    /** key: `METHOD path` (api.github.com-relative) → { status, body } or a fn. */
    ghRoutes: /** @type {Record<string, any>} */ ({}),
    githubCalls: /** @type {any[]} */ ([]),
    jiraCalls: /** @type {any[]} */ ([]),
    jiraIssues: /** @type {Record<string, any>} */ ({}),
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    updates: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    claims: /** @type {any[]} */ ([]),
    taskStatus: /** @type {any[]} */ ([]),
    syncMains: /** @type {any[]} */ ([]),
    createdFixKey: "TEAM-4200",
    /**
     * What the tickets/jira Lambda answers `Tickets___create_ticket` with
     * (TEAM-4156). A seam because the TWO providers answer differently and always
     * have — `{ key }` (dynamodb) vs `{ ticketId }` (jira) — and index.mjs's real
     * `invokeTickets` is what reconciles them. That reconciliation is only
     * observable here, where the Lambda boundary is the mock.
     */
    ticketsCreateReply: /** @type {(params:any) => any} */ (() => null),
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
          // Jira mode reads tickets over REST, so a DDB Get here is only the
          // odd internal lookup — answer "absent" rather than inventing a row.
          if (name === "GetCommand") return { Item: null };
          if (name === "QueryCommand" || name === "ScanCommand") return { Items: [] };
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

// One Lambda client serves both the ticket-tools invoke (create_ticket) and the
// agent dispatch (agentcore-hub-agent-invoker) — so this router is where "one
// fix ticket" and "CI was/wasn't invoked" are both observed.
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      h.state.lambdaInvokes.push(cmd.input);
      let payload = {};
      try { payload = JSON.parse(cmd.input.Payload); } catch { /* not json */ }
      const reply = (obj) => ({ Payload: new TextEncoder().encode(JSON.stringify(obj)) });
      if (payload.tool_name === "Tickets___create_ticket") {
        return reply(h.state.ticketsCreateReply(payload.parameters));
      }
      return reply({ statusCode: 200, body: "{}" });
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "ListObjectsV2Command") {
        const prefix = cmd.input.Prefix || "";
        return { Contents: Object.keys(h.state.s3Objects).filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })) };
      }
      if (name !== "GetObjectCommand") return {};
      const body = h.state.s3Objects[cmd.input.Key];
      if (body === undefined) { const e = new Error("The specified key does not exist."); e.name = "NoSuchKey"; throw e; }
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

vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
  claimInvocation: vi.fn(async (wfId, tid, entry) => {
    h.state.claims.push({ wfId, tid, entry });
    return true;
  }),
  putTaskEntry: vi.fn(async () => {}),
  trackTicket: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async (wfId, tid, status) => { h.state.taskStatus.push({ wfId, tid, status }); }),
  completeTaskEntry: vi.fn(async () => {}),
  mergeTaskMetadata: vi.fn(async () => {}),
  advancePhase: vi.fn(async () => {}),
  adoptFeatureBranch: vi.fn(async () => {}),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
  setRepoCheck: vi.fn(async () => {}),
  setCiCheck: vi.fn(async () => {}),
  // Writes through to the in-memory row the way the next dispatch would re-read
  // it from DynamoDB — that is what makes the redelivery test meaningful.
  setSyncMain: vi.fn(async (id, sm) => {
    h.state.syncMains.push({ id, sm });
    if (h.state.workflow) h.state.workflow.syncMain = sm;
  }),
  appendReviewNotificationOnce: vi.fn(async () => true),
  appendNotification: vi.fn(async () => {}),
  ackNotifications: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async () => true),
  claimTerminalOutcome: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
  setDelivery: vi.fn(async () => {}),
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.REPO_CHECK_MODE = "off";
process.env.TICKET_PROVIDER = "jira";
process.env.JIRA_SITE_URL = JIRA_SITE;
process.env.JIRA_EMAIL = "bot@example.com";
process.env.JIRA_API_TOKEN = "jira_test_token";
process.env.GITHUB_PAT = "ghp_test";
process.env[`RUNTIME_ARN_${CI_AGENT.toUpperCase()}`] =
  "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/ci-agent";

const AGENTS_CONFIG = JSON.stringify({
  agents: [
    { agentId: "agentcore_hub_requirements_analyst", phase: "requirements" },
    { agentId: BUG_FIXER, phase: "development" },
    { agentId: "agentcore_hub_code_reviewer", phase: "review" },
    { agentId: "agentcore_hub_qa_verifier", phase: "verification" },
    { agentId: CI_AGENT, phase: "review" },
    { agentId: "agentcore_hub_release_manager", phase: "ship" },
  ],
});

/** The run's own def (`bug-fix`), trimmed to the fields the dispatch path reads. */
const WORKFLOWS_CONFIG = JSON.stringify({
  workflows: [
    {
      id: "bug-fix",
      intakeAgentId: "agentcore_hub_requirements_analyst",
      featureBranchPhase: "development",
      createsPullRequest: true,
      completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
      reviewGates: [
        { afterPhase: "ship", name: "Merge Approval", blocking: true, condition: "always", assignee: "human:engineer" },
      ],
      phases: [
        { agentPhase: "requirements" },
        { agentPhase: "development" },
        { agentPhase: "verification", extraAgentPhases: ["review", "ship"] },
      ],
    },
  ],
});

/** tycenjmccann/agentcore-hub IS CD-registered with a pipeline (the real state). */
const CD_REGISTRY = JSON.stringify({
  version: 1,
  repos: [{ repo: `${OWNER}/${REPO}`, pipeline: "agentcore-hub-deploy", region: "us-east-1" }],
});

// ─── fetch router: api.github.com by route table, Jira by shape ──────────────

const ORIGINAL_FETCH = global.fetch;

function resp(status, body) {
  const text = body === null || body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (text ? JSON.parse(text) : null),
  };
}

/** A Jira issue as the REST API returns it — mapJiraIssueToTicket reads this. */
function jiraIssue(t) {
  return {
    key: t.ticketId,
    fields: {
      summary: t.title || "",
      description: { content: [] },
      status: { name: t.jiraStatus || "Ready" },
      issuetype: { name: "Task" },
      parent: { key: t.parentId },
      labels: [`agent:${t.assignee}`, `wf:${WF}`],
      issuelinks: (t.blockedBy || []).map((k) => ({
        type: { inward: "is blocked by" }, inwardIssue: { key: k },
      })),
      comment: { comments: [] },
    },
  };
}

function installFetch() {
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body) : null;

    if (u.startsWith("https://api.github.com")) {
      const path = u.slice("https://api.github.com".length);
      h.state.githubCalls.push({ key: `${method} ${path}`, path, method, body });
      const route = h.state.ghRoutes[`${method} ${path}`];
      if (route === undefined) return resp(404, { message: "Not Found" });
      const r = typeof route === "function" ? await route() : route;
      return resp(r.status, r.body);
    }

    const path = u.replace(`https://${JIRA_SITE}`, "");
    h.state.jiraCalls.push({ key: `${method} ${path}`, path, method, body });
    if (/\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(path)) {
      if (method === "GET") {
        return resp(200, {
          transitions: ["To Do", "Ready", "In Progress", "In Review", "Blocked", "Done"]
            .map((name, i) => ({ id: String(i + 1), name, to: { name } })),
        });
      }
      return resp(204, null);
    }
    if (path === "/rest/api/3/issueLink") return resp(201, {});
    if (path.startsWith("/rest/api/3/search/jql")) {
      return resp(200, { issues: Object.values(h.state.jiraIssues).map(jiraIssue) });
    }
    const key = path.match(/^\/rest\/api\/3\/issue\/([A-Za-z]+-\d+)/)?.[1];
    if (key) {
      const t = h.state.jiraIssues[key];
      return t ? resp(200, jiraIssue(t)) : resp(404, { message: "Issue does not exist" });
    }
    return resp(200, {});
  });
}

let handler;

/**
 * index.mjs snapshots SYNC_MAIN_BEFORE_CI (and memoizes syncDeps) at module
 * load, so every mode needs its own resetModules + import. `undefined` DELETES
 * the var — the plain-install baseline.
 */
async function load(mode) {
  if (mode === undefined) delete process.env.SYNC_MAIN_BEFORE_CI;
  else process.env.SYNC_MAIN_BEFORE_CI = mode;
  h.state.s3Objects = {
    "config/agents.json": AGENTS_CONFIG,
    "config/workflows.json": WORKFLOWS_CONFIG,
    "config/cd-registry.json": CD_REGISTRY,
  };
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
  await handler({ source: "jira-webhook", ticketId: "__PRIME__", newStatus: "unknown" }); // primes the caches
}

/** The run's row as it stood when TEAM-4064 closed and TEAM-4065 went Ready. */
function makeWorkflow(extra = {}) {
  return {
    id: WF,
    workflowId: WF,
    epicId: EPIC,
    workflowDefId: "bug-fix",
    workflowType: "bug",
    ticketProvider: "jira",
    phase: "verification",
    startedAt: "2026-09-05T04:23:46.587Z",
    input: { title: "submit_workflow source validation rejects valid S3 and presigned sources", description: "d" },
    repoConfig: { layout: "monorepo", repos: [{ platform: "backend", url: REPO_URL, defaultBranch: "main" }] },
    featureBranch: BRANCH,
    // The real completion records, verbatim on the fields sync-main reads. The
    // LATEST development-phase completion is TEAM-4079 (06:05:29.986Z) — later
    // than TEAM-4078 (05:44) and than the qa_verifier's 06:03 — so the conflict
    // belongs to the bug fixer, not to QA.
    agentTasks: {
      "TEAM-4061": { ticketId: "TEAM-4061", agentId: BUG_FIXER, status: "complete", completedAt: "2026-09-05T05:11:34.749Z" },
      "TEAM-4063": { ticketId: "TEAM-4063", agentId: "agentcore_hub_code_reviewer", status: "complete", completedAt: "2026-09-05T05:25:25.769Z" },
      "TEAM-4078": { ticketId: "TEAM-4078", agentId: BUG_FIXER, status: "complete", completedAt: "2026-09-05T05:44:45.727Z" },
      "TEAM-4079": { ticketId: "TEAM-4079", agentId: BUG_FIXER, status: "complete", completedAt: "2026-09-05T06:05:29.986Z" },
      "TEAM-4064": { ticketId: "TEAM-4064", agentId: "agentcore_hub_qa_verifier", status: "complete", completedAt: "2026-09-05T06:03:48.416Z" },
    },
    humanNotifications: [],
    ...extra,
  };
}

/** The Ready webhook Jira fires when TEAM-4065's last blocker (TEAM-4064) closes. */
const readyWebhook = () => ({ source: "jira-webhook", ticketId: CI, newStatus: "ready", oldStatus: "blocked" });

/** main advanced under the run: the branches GET answers a NEW sha. */
function mainMoved(sha = MAIN_SHA_NEW) {
  h.state.ghRoutes[`GET ${BRANCHES_MAIN}`] = { status: 200, body: { name: "main", commit: { sha } } };
}

/** Both compare directions, for the conflict-candidate intersection. */
function compareRoutes(oursFiles, theirsFiles, aheadBy = 7) {
  h.state.ghRoutes[`GET ${CMP_HEAD_BASE}`] = {
    status: 200, body: { status: "diverged", ahead_by: 3, files: oursFiles.map((filename) => ({ filename })) },
  };
  h.state.ghRoutes[`GET ${CMP_BASE_HEAD}`] = {
    status: 200, body: { status: "diverged", ahead_by: aheadBy, files: theirsFiles.map((filename) => ({ filename })) },
  };
}

const payloads = () =>
  h.state.lambdaInvokes.map((i) => { try { return JSON.parse(i.Payload); } catch { return {}; } });
const createTicketCalls = () => payloads().filter((p) => p.tool_name === "Tickets___create_ticket");
const agentInvokes = () =>
  h.state.lambdaInvokes.filter((i) => i.FunctionName === "agentcore-hub-agent-invoker");
const eventsOf = (type) => h.state.events.filter((e) => e.eventType === type || e.type === type);
const ghKeys = () => h.state.githubCalls.map((c) => c.key);
const blockerLinks = () =>
  h.state.jiraCalls.filter((c) => c.key === "POST /rest/api/3/issueLink");

beforeEach(() => {
  h.state.ghRoutes = {};
  h.state.githubCalls.length = 0;
  h.state.jiraCalls.length = 0;
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.claims.length = 0;
  h.state.taskStatus.length = 0;
  h.state.syncMains.length = 0;
  h.state.createdFixKey = FIX;
  // The dynamodb provider's shape, which is what this suite has always replayed.
  h.state.ticketsCreateReply = () => ({ key: h.state.createdFixKey, status: "created" });
  h.state.workflow = makeWorkflow();
  h.state.jiraIssues = {
    [CI]: {
      ticketId: CI, parentId: EPIC, assignee: CI_AGENT, blockedBy: [],
      title: "CI: Validate build and tests for submit_workflow source validation fix",
      jiraStatus: "Ready",
    },
  };
  installFetch();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.SYNC_MAIN_BEFORE_CI;
});

// ─── 1. enforce, conflict ────────────────────────────────────────────────────

describe("enforce — main moved and the merge conflicts (the TEAM-4106 case)", () => {
  beforeEach(() => {
    mainMoved();
    compareRoutes(
      ["src/lib/workflow/intake.ts", "src/components/WorkflowBoard.tsx", "README.md"],
      ["src/lib/workflow/intake.ts", "src/components/WorkflowBoard.tsx", "docs/MODULES.md"],
    );
    h.state.ghRoutes[`POST ${MERGES}`] = { status: 409, body: { message: "Merge conflict" } };
  });

  it("files EXACTLY ONE sync_fix ticket, blocks CI on it, and never invokes the CI agent", async () => {
    await load("enforce");
    await handler(readyWebhook());

    const created = createTicketCalls();
    expect(created).toHaveLength(1);
    const p = created[0].parameters;
    expect(p.summary.startsWith("Fix (sync-main):")).toBe(true);
    expect(p.summary).toBe("Fix (sync-main): merge conflict with main in 2 file(s)");
    expect(p.spawned_by).toEqual({ kind: "sync_fix", ciTicketId: CI });
    expect(p.phase).toBe("development");
    expect(p.parent_key).toBe(EPIC);
    expect(p.workflow_id).toBe(WF);
    // The branch's own last dev agent owns the conflict (TEAM-4079, 06:05:29Z).
    expect(p.assignee).toBe(BUG_FIXER);
    expect(p.blocked_by).toEqual([]);

    // CI is blocked on the fix, in Jira via a "Blocks" issue link.
    expect(blockerLinks()).toHaveLength(1);
    expect(blockerLinks()[0].body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: FIX },
      outwardIssue: { key: CI },
    });

    // THE point of the feature: no CI run against a head that cannot merge, so
    // no green certification of a SHA that would not land.
    expect(agentInvokes()).toHaveLength(0);
    expect(eventsOf("agent.invoked")).toHaveLength(0);

    const conflict = eventsOf("workflow.sync_conflict");
    expect(conflict).toHaveLength(1);
    expect(conflict[0].detail?.fixTicketId ?? conflict[0].fixTicketId).toBe(FIX);
    expect(eventsOf("workflow.branch_synced")).toHaveLength(0);

    // The claim was taken and then RELEASED as "ready" — the cascade re-dispatches
    // CI when the fix closes, which an "error" verdict would refuse to do.
    expect(h.state.claims.map((c) => c.tid)).toEqual([CI]);
    expect(h.state.taskStatus).toEqual([{ wfId: WF, tid: CI, status: "ready" }]);

    // And the run remembers the conflict against THIS main head.
    expect(h.state.syncMains).toHaveLength(1);
    expect(h.state.syncMains[0].sm).toMatchObject({
      status: "conflict", ciTicketId: CI, fixTicketId: FIX, baseHeadSha: MAIN_SHA_NEW,
    });
  });

  it("REDELIVERY of the same Ready webhook files no second ticket and no second link", async () => {
    await load("enforce");
    await handler(readyWebhook());
    expect(createTicketCalls()).toHaveLength(1);

    // The webhook twin: the claim cannot serialize it (the first pass released
    // the claim on purpose), so the guard has to be sync-main's own idempotency
    // key — same ciTicketId + same baseHeadSha + a recorded fixTicketId.
    h.state.lambdaInvokes.length = 0;
    await handler(readyWebhook());

    expect(createTicketCalls()).toHaveLength(0);
    expect(agentInvokes()).toHaveLength(0);
    // The merge IS re-attempted (that is how the branch gets un-wedged once the
    // dev resolves it) — but it stops there: no compares, no second ticket.
    expect(ghKeys().filter((k) => k === `POST ${MERGES}`)).toHaveLength(2);
    expect(ghKeys().filter((k) => k === `GET ${CMP_BASE_HEAD}`)).toHaveLength(1);
    // The blocker + claim release ARE re-applied (both idempotent), so a first
    // pass that filed the ticket and then failed to block still converges.
    expect(blockerLinks()).toHaveLength(2);
    expect(h.state.taskStatus).toHaveLength(2);
    // Same record, same fix ticket — the run's memory does not drift.
    expect(h.state.syncMains).toHaveLength(2);
    expect(h.state.syncMains[1].sm).toMatchObject({ status: "conflict", fixTicketId: FIX, baseHeadSha: MAIN_SHA_NEW });
  });

  it("main moving AGAIN is a new question: the merge is re-attempted", async () => {
    await load("enforce");
    await handler(readyWebhook());
    expect(createTicketCalls()).toHaveLength(1);

    h.state.lambdaInvokes.length = 0;
    mainMoved("cafe9999aa11ee22ff33445566778899aabbccdd");
    await handler(readyWebhook());

    expect(ghKeys().filter((k) => k === `POST ${MERGES}`)).toHaveLength(2);
    expect(createTicketCalls()).toHaveLength(1); // the second conflict tickets too
  });

  it("the dev lands the merge → 201 → branch_synced and CI dispatched exactly once", async () => {
    await load("enforce");
    await handler(readyWebhook());
    expect(agentInvokes()).toHaveLength(0);

    // TEAM-4200 closes: the branch now takes main cleanly. The cascade re-Readies
    // the CI ticket and the SAME ready event runs again.
    h.state.lambdaInvokes.length = 0;
    h.state.events.length = 0;
    h.state.taskStatus.length = 0;
    h.state.syncMains.length = 0;
    h.state.ghRoutes[`POST ${MERGES}`] = { status: 201, body: { sha: MERGE_SHA, merged: true } };
    await handler(readyWebhook());

    const synced = eventsOf("workflow.branch_synced");
    expect(synced).toHaveLength(1);
    expect(synced[0].detail?.sha ?? synced[0].sha).toBe(MERGE_SHA);
    expect(createTicketCalls()).toHaveLength(0);

    const dispatched = agentInvokes();
    expect(dispatched).toHaveLength(1);
    const dp = JSON.parse(dispatched[0].Payload);
    expect(dp.ticketId).toBe(CI);
    expect(dp.agentId).toBe(CI_AGENT);
    expect(h.state.syncMains[0].sm).toMatchObject({ status: "synced", sha: MERGE_SHA, ciTicketId: CI });
    // The claim stays taken — the agent IS running now.
    expect(h.state.taskStatus).toHaveLength(0);
  });

  // ── TEAM-4156: the answer the tickets Lambda actually gives ────────────────
  //
  // This run is `ticketProvider: "jira"` — the real one, and what .env.example and
  // the Dockerfile ship — so the create_ticket reply is `{ ticketId }`, NOT the
  // `{ key }` this suite replayed. Reading `key` alone meant the id came back null
  // for a ticket the Lambda really minted, and sync-main then took its
  // `conflict_unticketed` fail-open branch: no blocker, no hold, and CI dispatched
  // against a head that provably cannot merge — the exact regression FR-6 exists to
  // prevent, in the ONLY provider mode we run in production.
  //
  // These live here rather than in sync-main.test.mjs because index.mjs's real
  // `invokeTickets` is the thing under test: the module-level tests mock that seam
  // out, so a normalization bug in it is invisible to them.

  /** The end state a filed-and-held conflict must reach, whatever the reply shape. */
  function expectHeldOnFix() {
    expect(createTicketCalls()).toHaveLength(1);
    expect(blockerLinks()).toHaveLength(1);
    expect(blockerLinks()[0].body).toEqual({
      type: { name: "Blocks" }, inwardIssue: { key: FIX }, outwardIssue: { key: CI },
    });
    expect(agentInvokes()).toHaveLength(0);
    const conflict = eventsOf("workflow.sync_conflict");
    expect(conflict).toHaveLength(1);
    expect(conflict[0].detail?.fixTicketId ?? conflict[0].fixTicketId).toBe(FIX);
    expect(eventsOf("workflow.sync_skipped")).toHaveLength(0);
    expect(h.state.taskStatus).toEqual([{ wfId: WF, tid: CI, status: "ready" }]);
    expect(h.state.syncMains).toHaveLength(1);
    expect(h.state.syncMains[0].sm).toMatchObject({
      status: "conflict", ciTicketId: CI, fixTicketId: FIX, baseHeadSha: MAIN_SHA_NEW,
    });
  }

  it("JIRA's fresh-create reply ({ ticketId, status, message }) reaches the identical end state", async () => {
    // Byte-for-byte what lambda/agentcore-hub-jira/index.mjs returns on a create.
    h.state.ticketsCreateReply = (params) => ({
      ticketId: FIX, status: "todo", message: `Created ${FIX}: ${params.summary}`,
    });
    await load("enforce");
    await handler(readyWebhook());
    expectHeldOnFix();
  });

  it("JIRA's summary-dedupe reply ({ ticketId, deduplicated }) holds CI on the EXISTING ticket", async () => {
    // The jira Lambda answers a create for an already-present summary with
    // mapIssue(dup) + deduplicated:true. That IS the ticket CI must wait on — a
    // redelivery whose record was lost lands here, and refusing it would fail open
    // on a conflict that is already ticketed.
    h.state.ticketsCreateReply = (params) => ({
      ticketId: FIX, title: params.summary, status: "in_progress",
      assignee: BUG_FIXER, issueType: "Task", parentKey: EPIC, workflowId: WF,
      labels: ["fix:sync_fix", `origin:${CI}`], deduplicated: true,
    });
    await load("enforce");
    await handler(readyWebhook());
    expectHeldOnFix();
  });

  it("a bare { error } reply is a FAILURE: invokeTickets throws, sync-main fails open, and the text is logged", async () => {
    // The jira Lambda's handler catch-all answers `{ error: msg }` with no `content`
    // envelope, so the old textResult check could not see it: a 400 from Jira came
    // back as a truthy "ticket" whose id read null. Indistinguishable from "the
    // Lambda is down" at the call site, and silent in the log.
    const warns = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...a) => { warns.push(a.join(" ")); });
    try {
      h.state.ticketsCreateReply = () => ({ error: "Jira 400: Field 'parent' cannot be set" });
      await load("enforce");
      await handler(readyWebhook());
    } finally {
      warnSpy.mockRestore();
    }

    // The create was attempted and produced no ticket, so fail open: CI is NOT
    // held (there is nothing to block on and nobody assigned) and the event says so.
    expect(createTicketCalls()).toHaveLength(1);
    expect(blockerLinks()).toHaveLength(0);
    expect(eventsOf("workflow.sync_conflict")).toHaveLength(0);
    const skipped = eventsOf("workflow.sync_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].detail?.reason ?? skipped[0].reason).toBe("conflict_unticketed");
    expect(h.state.syncMains[0].sm).toMatchObject({ status: "conflict", fixTicketId: null });
    // Fail-open means CI still runs against the un-synced head (pre-FR-6 behaviour).
    expect(agentInvokes()).toHaveLength(1);

    // …and the reason is in the log rather than swallowed. This is the whole value
    // of throwing at the seam: without it the warn line does not exist at all.
    const line = warns.find((w) => w.includes("could not file the sync_fix ticket"));
    expect(line).toBeTruthy();
    expect(line).toContain("Tickets___create_ticket");
    expect(line).toContain("Jira 400: Field 'parent' cannot be set");
  });
});

// ─── 2. enforce, no conflict ─────────────────────────────────────────────────

describe("enforce — the ordinary case", () => {
  it("204 (already up to date) is a noop that still dispatches CI", async () => {
    mainMoved(MAIN_SHA_OLD);
    h.state.ghRoutes[`POST ${MERGES}`] = { status: 204, body: null };
    await load("enforce");
    await handler(readyWebhook());

    const synced = eventsOf("workflow.branch_synced");
    expect(synced).toHaveLength(1);
    expect(synced[0].detail?.noop ?? synced[0].noop).toBe(true);
    expect(createTicketCalls()).toHaveLength(0);
    expect(agentInvokes()).toHaveLength(1);
  });

  it("an unreadable main (5xx) fails OPEN: CI dispatches un-synced, nothing is ticketed", async () => {
    h.state.ghRoutes[`GET ${BRANCHES_MAIN}`] = { status: 500, body: { message: "server error" } };
    await load("enforce");
    await handler(readyWebhook());

    expect(eventsOf("workflow.sync_skipped")).toHaveLength(1);
    expect(ghKeys()).not.toContain(`POST ${MERGES}`);
    expect(createTicketCalls()).toHaveLength(0);
    expect(agentInvokes()).toHaveLength(1);
  });
});

// ─── 3. shadow ───────────────────────────────────────────────────────────────

describe("shadow — one read, one event, zero writes", () => {
  it("reports how far behind the branch is and dispatches CI anyway", async () => {
    mainMoved();
    compareRoutes([], ["src/lib/workflow/intake.ts"], 7);
    await load("shadow");
    await handler(readyWebhook());

    const dry = eventsOf("workflow.sync_dry_run");
    expect(dry).toHaveLength(1);
    const d = dry[0].detail ?? dry[0];
    expect(d.behindBy).toBe(7);
    expect(d.wouldSync).toBe(true);
    expect(d.conflictKnown).toBe(false);
    expect(d.shadow).toBe(true);

    // Read-only: the compare, and nothing that writes.
    expect(ghKeys()).toEqual([`GET ${BRANCHES_MAIN}`, `GET ${CMP_BASE_HEAD}`]);
    expect(createTicketCalls()).toHaveLength(0);
    expect(blockerLinks()).toHaveLength(0);
    expect(h.state.syncMains).toHaveLength(0);
    expect(h.state.taskStatus).toHaveLength(0);
    expect(agentInvokes()).toHaveLength(1);
  });
});

// ─── 4. off, and the plain install (TEAM-4188) ───────────────────────────────

/**
 * TEAM-4188 (TEAM-4169 D1 FR-1.6). This describe used to assert that an UNSET
 * SYNC_MAIN_BEFORE_CI was byte-identical to pre-4122 — which was true, and was
 * the defect: every install that never exported the var ran with the pre-CI sync
 * OFF while the blueprints told the CI agent the orchestrator had already merged
 * main for it. The default is now enforce, so the same setup (var DELETED, main
 * moved, the merge 409s) has to produce the enforce outcome. This is the
 * behavioural half of the FR-1.6 assertion — `load(undefined)` re-imports the
 * real index.mjs after resetModules, so the real guard at the real dispatch site
 * executes; the surface/source half lives in sync-main-effective-flag.test.mjs.
 */
describe("unset — the plain install now ENFORCES (TEAM-4188 / FR-1.6)", () => {
  it("no env var set: main is merged in and the 409 files the sync_fix ticket", async () => {
    mainMoved();
    compareRoutes(
      ["src/lib/workflow/intake.ts", "src/components/WorkflowBoard.tsx", "README.md"],
      ["src/lib/workflow/intake.ts", "src/components/WorkflowBoard.tsx", "docs/MODULES.md"],
    );
    h.state.ghRoutes[`POST ${MERGES}`] = { status: 409, body: { message: "Merge conflict" } };
    await load(undefined);
    await handler(readyWebhook());

    // The merge WAS attempted — nobody opted in, and the guarantee is on.
    expect(ghKeys()).toContain(`POST ${MERGES}`);

    // …and the conflict is ticketed exactly as an explicit enforce would.
    const created = createTicketCalls();
    expect(created).toHaveLength(1);
    expect(created[0].parameters.spawned_by).toEqual({ kind: "sync_fix", ciTicketId: CI });
    expect(blockerLinks()).toHaveLength(1);
    expect(eventsOf("workflow.sync_conflict")).toHaveLength(1);
    expect(h.state.syncMains[0].sm).toMatchObject({ status: "conflict", fixTicketId: FIX });

    // THE point: no CI run against a head that provably cannot merge.
    expect(agentInvokes()).toHaveLength(0);
  });
});

describe("explicit off — byte-identical to pre-4122", () => {
  it("not one GitHub call, and CI dispatches exactly once", async () => {
    mainMoved();
    h.state.ghRoutes[`POST ${MERGES}`] = { status: 409, body: { message: "Merge conflict" } };
    // TEAM-4188: the rollback path keeps its byte-identical guarantee, now pinned
    // to the EXPLICIT value rather than to the absence of one.
    await load("off");
    await handler(readyWebhook());

    expect(h.state.githubCalls).toHaveLength(0);
    expect(createTicketCalls()).toHaveLength(0);
    expect(h.state.syncMains).toHaveLength(0);
    expect(eventsOf("workflow.sync_skipped")).toHaveLength(0);
    expect(agentInvokes()).toHaveLength(1);
  });

  it("garbage is off too — a typo cannot start merging branches", async () => {
    mainMoved();
    h.state.ghRoutes[`POST ${MERGES}`] = { status: 409, body: { message: "Merge conflict" } };
    await load("enfroce");
    await handler(readyWebhook());

    expect(h.state.githubCalls).toHaveLength(0);
    expect(createTicketCalls()).toHaveLength(0);
    expect(agentInvokes()).toHaveLength(1);
  });
});
