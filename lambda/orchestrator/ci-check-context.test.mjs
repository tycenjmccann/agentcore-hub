import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * CI reachability wiring (TEAM-4122 FR-5) — index.mjs REAL, only its I/O seams
 * mocked (AWS SDK clients + workflow-store), same harness shape as
 * cd-handoff.test.mjs / unverified-fixes-context.test.mjs.
 *
 * ci-check.test.mjs owns the module's own logic. What is only observable HERE is
 * whether the orchestrator wires it correctly:
 *
 *   1. the `## CI Certification` block reaches every persona's prompt on a
 *      pipeline-mode run, and ONLY on a pipeline-mode run (a handoff repo has no
 *      CodeBuild PR check to be uncertifiable about);
 *   2. CI_CHECK_MODE unset costs NOTHING — asserted as zero calls on the
 *      CodeBuild client (not even constructed: the SDK import is dynamic), zero
 *      Lambda invokes and zero store writes, i.e. byte-identical to pre-4122;
 *   3. enforce labels the run's epic `ci:uncertifiable` exactly ONCE per
 *      workflow — a warm container dispatching ticket after ticket must not
 *      label the epic once per ticket — while shadow never touches a ticket;
 *   4. the human merge gate's ping, its mirrored comment and its attached
 *      package all lead with `⚠ CI UNCERTIFIABLE:` under enforce, and are
 *      untouched under shadow/off or on a certifiable run.
 */

const EPIC = "EPIC-1";
const RM = "agentcore_hub_release_manager";
const DEV = "agentcore_hub_backend_dev";
const QA = "agentcore_hub_qa_verifier";
const REPO_URL = "https://github.com/acme/juno";

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    updates: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    notifications: /** @type {any[]} */ ([]),
    ciChecks: /** @type {any[]} */ ([]),
    // CodeBuild seam: how many clients were CONSTRUCTED (the SDK is a dynamic
    // import, so 0 proves mode=off never even loads it) and every call made.
    codebuildClients: 0,
    codebuildCalls: /** @type {any[]} */ ([]),
    projects: /** @type {any[]} */ ([]),
    // What the pipeline-tools Lambda answers Pipeline___capabilities with.
    startCiBuild: false,
    // What the ticket-tools Lambda answers Tickets___labels_add with. (vi.hoisted
    // is lifted above the consts below, so the epic id is spelled out here.)
    labelsAddReply: /** @type {any} */ ({ key: "EPIC-1", status: "labels_added", added: ["ci:uncertifiable"] }),
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
          if (name === "ScanCommand") return { Items: [] };
          if (name === "UpdateCommand") {
            h.state.updates.push(cmd.input);
            const t = h.state.tickets[cmd.input.Key?.ticketId];
            const s = cmd.input.ExpressionAttributeValues?.[":s"];
            if (t && s && String(cmd.input.UpdateExpression).includes("#s = :s")) t.status = s;
            return {};
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

// The ONE Lambda client the orchestrator owns is shared by the ticket-tools
// invoke and ci-check's pipeline-tools capabilities probe, so this router is
// where both seams are observed.
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      h.state.lambdaInvokes.push(cmd.input);
      let payload = {};
      try { payload = JSON.parse(cmd.input.Payload); } catch { /* not json */ }
      const reply = (obj) => ({ Payload: new TextEncoder().encode(JSON.stringify(obj)) });
      if (payload.tool_name === "Pipeline___capabilities") {
        return reply({ content: [{ type: "text", text: JSON.stringify({ startCiBuild: h.state.startCiBuild, version: 2 }) }] });
      }
      if (payload.tool_name === "Tickets___labels_add") {
        return reply(h.state.labelsAddReply);
      }
      return reply({ statusCode: 200, body: "{}" });
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

// Dynamic import in index.mjs's ciCheckDeps() — vi.mock still intercepts it.
vi.mock("@aws-sdk/client-codebuild", () => ({
  CodeBuildClient: class {
    constructor() { h.state.codebuildClients++; }
    async send(cmd) {
      h.state.codebuildCalls.push(cmd.input);
      return { projects: h.state.projects };
    }
  },
  BatchGetProjectsCommand: class { constructor(i) { this.input = i; } },
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
  claimInvocation: vi.fn(async () => true),
  putTaskEntry: vi.fn(async () => {}),
  trackTicket: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async () => {}),
  completeTaskEntry: vi.fn(async () => {}),
  mergeTaskMetadata: vi.fn(async () => {}),
  advancePhase: vi.fn(async () => {}),
  adoptFeatureBranch: vi.fn(async () => {}),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
  setRepoCheck: vi.fn(async () => {}),
  // The seam FR-5 adds. It also writes through to the in-memory workflow, the
  // way the next dispatch would re-read it from DynamoDB — that write-through is
  // what makes "label once per workflow" observable across two calls.
  setCiCheck: vi.fn(async (id, cc) => {
    h.state.ciChecks.push({ id, cc });
    if (h.state.workflow) h.state.workflow.ciCheck = cc;
  }),
  appendReviewNotificationOnce: vi.fn(async (wfId, tid, n) => { h.state.notifications.push(n); return true; }),
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

const AGENTS_CONFIG = JSON.stringify({
  agents: [
    { agentId: "agentcore_hub_requirements_analyst", phase: "requirements" },
    { agentId: DEV, phase: "development" },
    { agentId: QA, phase: "verification" },
    { agentId: "agentcore_hub_ci_agent", phase: "review" },
    { agentId: RM, phase: "ship" },
  ],
});

const WORKFLOWS_CONFIG = JSON.stringify({
  workflows: [
    {
      id: "software-delivery",
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

/** acme/juno is CD-registered WITH a pipeline → pipelineMode once PIPELINE_ENABLED is set. */
const REGISTERED = JSON.stringify({ version: 1, repos: [{ repo: "acme/juno", pipeline: "juno-deploy", region: "us-west-2" }] });
const HANDOFF = JSON.stringify({ version: 1, repos: [] });

/** A project whose webhook fires on PRs → certifiable. */
const PR_WEBHOOK_PROJECT = {
  name: "agentcore-hub-ci",
  webhook: {
    url: "https://codebuild.us-east-1.amazonaws.com/webhooks?t=abc",
    secret: "whsec_super_secret",
    filterGroups: [[{ type: "EVENT", pattern: "PULL_REQUEST_UPDATED" }]],
  },
  environment: { environmentVariables: [{ name: "SECRET", value: "hunter2" }] },
};

let handler, buildAgentContext;

/**
 * mode === undefined → CI_CHECK_MODE is DELETED (a plain install), which is the
 * baseline the "costs nothing" assertions compare against. index.mjs snapshots
 * the flag at module load, so every mode needs its own resetModules + import.
 */
async function load(mode, registry = REGISTERED) {
  if (mode === undefined) delete process.env.CI_CHECK_MODE;
  else process.env.CI_CHECK_MODE = mode;
  process.env.PIPELINE_ENABLED = "1";
  h.state.s3Objects = {
    "config/agents.json": AGENTS_CONFIG,
    "config/workflows.json": WORKFLOWS_CONFIG,
    "config/cd-registry.json": registry,
  };
  vi.resetModules();
  ({ handler, buildAgentContext } = await import("./index.mjs"));
  await handler({ Records: [] }); // primes roster / defs / registry caches
}

function makeWorkflow(extra = {}) {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    phase: "verification",
    epicId: EPIC,
    workflowDefId: "software-delivery",
    input: { title: "Highlight reel", description: "d" },
    repoConfig: { layout: "multi-repo", repos: [{ platform: "shared", url: REPO_URL, defaultBranch: "main" }] },
    featureBranch: "feature/EPIC-1-highlight-reel",
    agentTasks: {},
    humanNotifications: [],
    ...extra,
  };
}

/** A ticket whose last blocker just closed → the DDB stream's MODIFY to ready. */
function readyRecord(ticketId) {
  const t = h.state.tickets[ticketId];
  return {
    Records: [{
      eventName: "MODIFY",
      dynamodb: {
        NewImage: { ticketId, status: "ready", assignee: t.assignee, parentId: t.parentId, workflowId: t.workflowId, type: "task", blockedBy: [] },
        OldImage: { ticketId, status: "blocked" },
      },
    }],
  };
}

const labelInvokes = () =>
  h.state.lambdaInvokes
    .map((i) => { try { return JSON.parse(i.Payload); } catch { return {}; } })
    .filter((p) => p.tool_name === "Tickets___labels_add");
const commentInvokes = () =>
  h.state.lambdaInvokes
    .map((i) => { try { return JSON.parse(i.Payload); } catch { return {}; } })
    .filter((p) => p.tool_name === "Tickets___add_comment");
const comments = (ticketId) =>
  h.state.updates
    .filter((u) => u.Key?.ticketId === ticketId && String(u.UpdateExpression).includes("list_append"))
    .map((u) => u.ExpressionAttributeValues[":n"][0].content);

beforeEach(() => {
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.notifications.length = 0;
  h.state.ciChecks.length = 0;
  h.state.codebuildCalls.length = 0;
  h.state.codebuildClients = 0;
  h.state.children = [];
  h.state.projects = []; // no project found → unknown, unless a test says otherwise
  h.state.startCiBuild = false;
  h.state.labelsAddReply = { key: EPIC, status: "labels_added", added: ["ci:uncertifiable"] };
  h.state.workflow = makeWorkflow();
  h.state.tickets = {
    "TEAM-3": { ticketId: "TEAM-3", parentId: EPIC, workflowId: "wf_1", assignee: DEV, type: "task", status: "ready", title: "Backend", blockedBy: [] },
    "TEAM-4": { ticketId: "TEAM-4", parentId: EPIC, workflowId: "wf_1", assignee: QA, type: "task", status: "ready", title: "Verify", blockedBy: [] },
    "TEAM-7": { ticketId: "TEAM-7", parentId: EPIC, workflowId: "wf_1", assignee: RM, type: "task", status: "done", title: "Ship: Highlight reel", blockedBy: [] },
    "TEAM-8": { ticketId: "TEAM-8", parentId: EPIC, workflowId: "wf_1", assignee: "human:engineer", type: "task", status: "ready", title: "Merge Approval", labels: ["human-review"], blockedBy: ["TEAM-7"] },
  };
});

afterEach(() => {
  delete process.env.CI_CHECK_MODE;
  delete process.env.PIPELINE_ENABLED;
});

/** The uncertifiable setup: a project with NO PR webhook and a Lambda that cannot StartBuild. */
function uncertifiable() {
  h.state.projects = [{
    name: "agentcore-hub-ci",
    webhook: { url: "https://codebuild.us-east-1.amazonaws.com/webhooks?t=abc", filterGroups: [[{ type: "EVENT", pattern: "PUSH" }]] },
  }];
  h.state.startCiBuild = false;
}

// ─── 1. the context block ────────────────────────────────────────────────────

describe("1. ## CI Certification in the agent prompt", () => {
  it("enforce + pipeline-mode delivery: the block states the verdict, project and consequence", async () => {
    await load("enforce");
    uncertifiable();

    const ctx = await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    expect(ctx).toContain("## Pipeline Mode\nPIPELINE_ENABLED: true");
    expect(ctx).toContain("## CI Certification");
    expect(ctx).toContain("verdict: uncertifiable");
    expect(ctx).toContain("ci_project: agentcore-hub-ci");
    expect(ctx).toContain("Consequence: no CodeBuild build can exist for ANY head SHA");
    expect(ctx).toContain("ci_status=unverified");
    expect(ctx).not.toContain("mode: shadow");
    // One probe pair, and the project is read by name (the scoped IAM grant).
    expect(h.state.codebuildCalls).toEqual([{ names: ["agentcore-hub-ci"] }]);
  });

  it("F10: no webhook url, webhook secret or project env-var value reaches the prompt or the persisted record", async () => {
    await load("shadow");
    h.state.projects = [PR_WEBHOOK_PROJECT];

    const ctx = await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    for (const secret of ["hunter2", "whsec_super_secret", "codebuild.us-east-1.amazonaws.com/webhooks"]) {
      expect(ctx).not.toContain(secret);
      expect(JSON.stringify(h.state.ciChecks)).not.toContain(secret);
    }
    expect(ctx).toContain("verdict: certifiable");
  });

  it("shadow: the same verdict, plus the observe-only note — and NOT ONE ticket write", async () => {
    await load("shadow");
    uncertifiable();

    const ctx = await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    expect(ctx).toContain("## CI Certification");
    expect(ctx).toContain("verdict: uncertifiable");
    expect(ctx).toContain("mode: shadow (observe-only — no label, no gate prefix)");
    expect(labelInvokes()).toHaveLength(0);
    expect(commentInvokes()).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
    // shadow DOES persist the probe (that is the point — the ledger before enforce).
    expect(h.state.ciChecks).toHaveLength(1);
    expect(h.state.ciChecks[0].cc.mode).toBe("shadow");
  });

  it("CI_CHECK_MODE unset: no block, and ZERO calls on every seam — byte-identical to pre-4122", async () => {
    await load(undefined);
    uncertifiable(); // the repo IS uncertifiable; off must still say nothing

    const ctx = await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    expect(ctx).not.toContain("## CI Certification");
    expect(ctx).toContain("## Pipeline Mode"); // everything else is unchanged
    // The CodeBuild client is a DYNAMIC import: off must not even construct it.
    expect(h.state.codebuildClients).toBe(0);
    expect(h.state.codebuildCalls).toHaveLength(0);
    expect(h.state.lambdaInvokes).toHaveLength(0);
    expect(h.state.ciChecks).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("garbage in CI_CHECK_MODE is off, not shadow — same zero-call baseline", async () => {
    await load("enfroce");
    uncertifiable();
    const ctx = await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);
    expect(ctx).not.toContain("## CI Certification");
    expect(h.state.codebuildClients).toBe(0);
    expect(h.state.ciChecks).toHaveLength(0);
  });

  it("a HANDOFF (non-pipeline) run gets no block even under enforce — there is no PR check to certify", async () => {
    await load("enforce", HANDOFF);
    uncertifiable();

    const ctx = await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    expect(ctx).toContain("CD_REGISTERED: false");
    expect(ctx).not.toContain("## Pipeline Mode");
    expect(ctx).not.toContain("## CI Certification");
    expect(h.state.codebuildCalls).toHaveLength(0);
    expect(h.state.ciChecks).toHaveLength(0);
  });

  it("a CD entry's ciProject is the project probed (not its pipeline name)", async () => {
    await load(
      "shadow",
      JSON.stringify({ version: 1, repos: [{ repo: "acme/juno", pipeline: "juno-deploy", ciProject: "juno-pr-check" }] })
    );
    await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);
    expect(h.state.codebuildCalls).toEqual([{ names: ["juno-pr-check"] }]);
  });
});

// ─── 2. the epic label (enforce only, once per workflow) ─────────────────────

describe("2. ci:uncertifiable epic label", () => {
  it("enforce + uncertifiable: labels the EPIC once, with the no-space label, and persists labeled:true", async () => {
    await load("enforce");
    uncertifiable();

    await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    const labels = labelInvokes();
    expect(labels).toHaveLength(1);
    // Both param spellings are sent so either provider Lambda reads it.
    expect(labels[0].parameters).toEqual({ ticket_id: EPIC, issue_key: EPIC, labels: ["ci:uncertifiable"] });
    // Jira rejects whitespace in labels outright — the prose form is not legal.
    expect(labels[0].parameters.labels[0]).not.toContain(" ");
    // Persisted so a re-probe (or another container) never labels twice.
    expect(h.state.ciChecks.at(-1).cc.labeled).toBe(true);
    expect(h.state.ciChecks.at(-1).id).toBe("wf_1");
  });

  it("a second dispatch on the same run re-uses the cached verdict: no second label, no second probe", async () => {
    await load("enforce");
    uncertifiable();

    await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);
    const afterFirst = { labels: labelInvokes().length, probes: h.state.codebuildCalls.length };
    const ctx2 = await buildAgentContext(h.state.tickets["TEAM-4"], h.state.workflow);

    expect(afterFirst).toEqual({ labels: 1, probes: 1 });
    expect(labelInvokes()).toHaveLength(1);
    expect(h.state.codebuildCalls).toHaveLength(1);
    // …and the second persona is still TOLD (the cache silences the API calls,
    // not the prompt).
    expect(ctx2).toContain("## CI Certification");
    expect(ctx2).toContain("verdict: uncertifiable");
  });

  it("certifiable: the block is emitted and NOTHING is labelled", async () => {
    await load("enforce");
    h.state.projects = [PR_WEBHOOK_PROJECT];

    const ctx = await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    expect(ctx).toContain("verdict: certifiable");
    expect(labelInvokes()).toHaveLength(0);
    expect(h.state.ciChecks[0].cc.labeled).toBeUndefined();
  });

  it("unknown (the probe could not answer): block, but no label — a warning is never manufactured", async () => {
    await load("enforce");
    h.state.projects = []; // project_not_found → webhook unknown

    const ctx = await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    expect(ctx).toContain("verdict: unknown");
    expect(ctx).not.toContain("Consequence:");
    expect(labelInvokes()).toHaveLength(0);
  });

  it("a workflow with no epic is skipped rather than labelling something else", async () => {
    await load("enforce");
    uncertifiable();
    h.state.workflow = makeWorkflow({ epicId: undefined });

    await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);
    expect(labelInvokes()).toHaveLength(0);
  });

  /**
   * The jira tools Lambda's failure envelope is a BARE `{ error }` — no
   * `content` field — so invokeTickets' textResult check cannot see it and
   * returns normally. Recording that as a successful label would persist
   * labeled:true and permanently suppress both the fallback and every retry, on
   * exactly the runs where the board warning matters most.
   */
  it("a provider that answers {error} is a FAILURE: labeled is not persisted, and the next dispatch retries", async () => {
    await load("enforce");
    uncertifiable();
    h.state.labelsAddReply = { error: "Jira 400: label 'ci:uncertifiable' is not valid" };

    await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    expect(labelInvokes()).toHaveLength(1);
    // The probe itself is persisted; the "stop trying" flag is NOT. (The comment
    // fallback is jira-only — addTicketComment short-circuits on the dynamodb
    // provider — so on this path nothing reached the board and labeled stays off.)
    expect(h.state.ciChecks).toHaveLength(1);
    expect(h.state.ciChecks[0].cc.labeled).toBeUndefined();

    // Next ticket on the warm container: the verdict is cached, but the label is
    // attempted again — and lands this time.
    h.state.labelsAddReply = { key: EPIC, status: "labels_added", added: ["ci:uncertifiable"] };
    await buildAgentContext(h.state.tickets["TEAM-4"], h.state.workflow);

    expect(labelInvokes()).toHaveLength(2);
    expect(h.state.codebuildCalls).toHaveLength(1); // still one probe
    expect(h.state.ciChecks.at(-1).cc.labeled).toBe(true);
  });

  it("a throwing tickets Lambda never breaks the dispatch it was building context for", async () => {
    await load("enforce");
    uncertifiable();
    h.state.labelsAddReply = { content: [{ text: "AccessDeniedException" }] }; // invokeTickets throws on this

    const ctx = await buildAgentContext(h.state.tickets["TEAM-3"], h.state.workflow);

    expect(ctx).toContain("## CI Certification"); // the context was still produced
    expect(labelInvokes()).toHaveLength(1);
    expect(h.state.ciChecks[0].cc.labeled).toBeUndefined();
  });
});

// ─── 3. the human merge gate ─────────────────────────────────────────────────

describe("3. merge-gate package prefix", () => {
  const PACKAGE_KEY = "workflows/wf_1/shared/review-package-ship.json";
  const seedPackage = () => {
    h.state.s3Objects[PACKAGE_KEY] = JSON.stringify({
      summary: "All 12 tickets done; review clean.",
      bullets: ["3 files changed", "unit tests green"],
      links: [{ label: "PR", url: "https://github.com/acme/juno/pull/42" }],
    });
  };
  const UNCERTIFIABLE_CHECK = {
    checkedAt: new Date().toISOString(),
    projectName: "agentcore-hub-ci",
    webhook: false, startBuild: false, githubHook: "unknown",
    certifiable: false, verdict: "uncertifiable",
    reason: "CodeBuild project agentcore-hub-ci has no PR webhook and the pipeline-tools Lambda cannot start a build.",
    mode: "enforce",
  };

  it("enforce: the ping details, the mirrored comment and the package all lead with the warning", async () => {
    await load("enforce");
    h.state.workflow = makeWorkflow({ ciCheck: UNCERTIFIABLE_CHECK });
    seedPackage();

    await handler(readyRecord("TEAM-8"));

    expect(h.state.notifications).toHaveLength(1);
    const n = h.state.notifications[0];
    expect(n.type).toBe("review_needed");
    // `details` is what reaches the phone.
    expect(n.details.startsWith("⚠ CI UNCERTIFIABLE: ")).toBe(true);
    expect(n.details).toContain("has no PR webhook");
    expect(n.summary).toBe(n.details);
    // The real package survives behind the warning.
    expect(n.details).toContain("All 12 tickets done");
    expect(n.bullets[0]).toBe("CI: no CodeBuild build can exist for this head (agentcore-hub-ci)");
    expect(n.bullets).toContain("unit tests green");
    expect(n.links).toEqual([{ label: "PR", url: "https://github.com/acme/juno/pull/42" }]);
    // …and the same text is mirrored onto the gate ticket the reviewer opens.
    expect(comments("TEAM-8").join("\n")).toContain("⚠ CI UNCERTIFIABLE: ");
    // The gate still parks + pages exactly as before.
    expect(h.state.updates.some((u) => u.Key?.ticketId === "TEAM-8" && u.ExpressionAttributeValues?.[":s"] === "in_review")).toBe(true);
    expect(h.state.events.filter((e) => e.type === "review.needed")).toHaveLength(1);
    // No probe happens on the gate path — the verdict was decided at dispatch.
    expect(h.state.codebuildCalls).toHaveLength(0);
  });

  it("enforce with NO review package at all: the gate ping still carries the warning", async () => {
    await load("enforce");
    h.state.workflow = makeWorkflow({ ciCheck: UNCERTIFIABLE_CHECK });

    await handler(readyRecord("TEAM-8"));

    const n = h.state.notifications[0];
    expect(n.details).toBe(`⚠ CI UNCERTIFIABLE: ${UNCERTIFIABLE_CHECK.reason}`);
    expect(n.bullets).toEqual(["CI: no CodeBuild build can exist for this head (agentcore-hub-ci)"]);
  });

  it("shadow: identical to off — the approver's ping is untouched", async () => {
    await load("shadow");
    h.state.workflow = makeWorkflow({ ciCheck: { ...UNCERTIFIABLE_CHECK, mode: "shadow" } });
    seedPackage();

    await handler(readyRecord("TEAM-8"));

    const n = h.state.notifications[0];
    expect(n.details).toBe("All 12 tickets done; review clean.");
    expect(n.bullets).toEqual(["3 files changed", "unit tests green"]);
    expect(comments("TEAM-8").join("\n")).not.toContain("CI UNCERTIFIABLE");
  });

  it("mode unset: untouched (and the stored verdict is ignored entirely)", async () => {
    await load(undefined);
    h.state.workflow = makeWorkflow({ ciCheck: UNCERTIFIABLE_CHECK });
    seedPackage();

    await handler(readyRecord("TEAM-8"));

    expect(h.state.notifications[0].details).toBe("All 12 tickets done; review clean.");
  });

  it("enforce + a certifiable (or unknown) verdict: no prefix", async () => {
    await load("enforce");
    seedPackage();
    for (const verdict of ["certifiable", "unknown"]) {
      h.state.notifications.length = 0;
      h.state.tickets["TEAM-8"].status = "ready";
      h.state.workflow = makeWorkflow({ ciCheck: { ...UNCERTIFIABLE_CHECK, verdict } });
      await handler(readyRecord("TEAM-8"));
      expect(h.state.notifications[0].details).toBe("All 12 tickets done; review clean.");
    }
  });

  it("enforce + a run that was never probed (no ciCheck at all): untouched", async () => {
    await load("enforce");
    seedPackage();
    await handler(readyRecord("TEAM-8"));
    expect(h.state.notifications[0].details).toBe("All 12 tickets done; review clean.");
  });
});
