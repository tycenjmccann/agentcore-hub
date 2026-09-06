import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * ADVISORY_ROUTING wiring (TEAM-4122 FR-7) — index.mjs REAL, only its I/O seams
 * mocked (AWS SDK clients + workflow-store + the review-cap factory), the same
 * harness shape as ci-check-context.test.mjs / unverified-fixes-context.test.mjs.
 *
 * completion.test.mjs owns the pure decision (isAdvisoryTicket / nonAdvisory /
 * the gate filter). What is only observable HERE is the wiring:
 *
 *   1. the `## Branch` block an advisory ticket's dev is actually handed —
 *      `feature/<id>-advisory` based on the repo DEFAULT branch, with the
 *      advisory NOTE and WITHOUT the shared-integration NOTE — and, just as
 *      importantly, that the non-advisory block is BYTE-IDENTICAL to what it was
 *      before FR-7 (asserted by comparing the enforce and off strings, not by
 *      re-describing the expected text);
 *   2. that a `-advisory` branch is never adopted as a run's shared integration
 *      branch by the ported-session path — the one place a branch name arrives
 *      from OUTSIDE the orchestrator, where adopting it would pull the declined
 *      scope into every dev's base and into the unified PR;
 *   3. that the ship review's change set is scoped to the PR under review, so
 *      files that live only on an advisory branch cannot enter it.
 */

const EPIC = "EPIC-1";
const DEV = "agentcore_hub_backend_dev";
const QA = "agentcore_hub_qa_verifier";
const RM = "agentcore_hub_release_manager";
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
    adopted: /** @type {any[]} */ ([]),
    advanced: /** @type {any[]} */ ([]),
    // "METHOD /path" → { status, body } for the GitHub REST seam.
    ghRoutes: /** @type {Record<string, any>} */ ({}),
    ghCalls: /** @type {string[]} */ ([]),
    enforce: /** @type {any} */ (null),
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
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      h.state.lambdaInvokes.push(cmd.input);
      return { Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: "{}" })) };
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
  claimInvocation: vi.fn(async () => true),
  putTaskEntry: vi.fn(async () => {}),
  trackTicket: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async () => {}),
  completeTaskEntry: vi.fn(async () => {}),
  mergeTaskMetadata: vi.fn(async () => {}),
  advancePhase: vi.fn(async (id, phase, branch) => { h.state.advanced.push({ id, phase, branch }); }),
  adoptFeatureBranch: vi.fn(async (id, branch) => {
    h.state.adopted.push({ id, branch });
    if (h.state.workflow?.id === id) h.state.workflow.featureBranch = branch;
  }),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
  setRepoCheck: vi.fn(async () => {}),
  setCiCheck: vi.fn(async () => {}),
  appendReviewNotificationOnce: vi.fn(async () => true),
  appendNotification: vi.fn(async () => {}),
  ackNotifications: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async () => true),
  claimTerminalOutcome: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
  setDelivery: vi.fn(async () => {}),
}));

vi.mock("./review-cap.mjs", async () => {
  const actual = await vi.importActual("./review-cap.mjs");
  return {
    ...actual,
    // The cap's own diff-scoping is review-cap.test.mjs's job; here the cap is a
    // recorder so the change set index.mjs COMPUTED is observable.
    createReviewCap: () => ({ enforce: (...args) => h.state.enforce(...args) }),
  };
});

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.REPO_CHECK_MODE = "off";

const AGENTS_CONFIG = JSON.stringify({
  agents: [
    { agentId: "agentcore_hub_requirements_analyst", phase: "requirements" },
    { agentId: DEV, phase: "development" },
    { agentId: QA, phase: "verification" },
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
      completionRequiresAgentPhases: ["development", "verification", "ship"],
      reviewGates: [
        { afterPhase: "ship", name: "Merge Approval", blocking: true, condition: "always", assignee: "human:engineer" },
      ],
      phases: [
        { agentPhase: "requirements" },
        { agentPhase: "development" },
        { agentPhase: "verification", extraAgentPhases: ["ship"] },
      ],
    },
  ],
});

const REGISTRY = JSON.stringify({ version: 1, repos: [] }); // handoff: no pipeline noise

let handler, buildAgentContext, handleReviewRejection;

/**
 * mode === undefined → ADVISORY_ROUTING is DELETED (a plain install), the
 * baseline every "byte-identical" comparison is made against. index.mjs
 * snapshots the flag at module load, so each mode needs its own resetModules.
 */
async function load(mode) {
  if (mode === undefined) delete process.env.ADVISORY_ROUTING;
  else process.env.ADVISORY_ROUTING = mode;
  h.state.s3Objects = {
    "config/agents.json": AGENTS_CONFIG,
    "config/workflows.json": WORKFLOWS_CONFIG,
    "config/cd-registry.json": REGISTRY,
  };
  vi.resetModules();
  ({ handler, buildAgentContext, handleReviewRejection } = await import("./index.mjs"));
  await handler({ Records: [] }); // primes roster / defs / registry caches
}

function makeWorkflow(extra = {}) {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    phase: "development",
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

/** A dev ticket, optionally advisory-labelled. */
const devTicket = (ticketId, labels) => ({
  ticketId,
  parentId: EPIC,
  workflowId: "wf_1",
  assignee: DEV,
  type: "task",
  status: "ready",
  title: "Rename the legacy helpers",
  blockedBy: [],
  ...(labels ? { labels } : {}),
});

/** The DDB stream MODIFY that says "this ticket's last blocker just closed". */
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

/** The `## Branch` section only (through the blank line that ends it). */
function branchBlock(ctx) {
  const start = ctx.indexOf("## Branch\n");
  if (start === -1) return null;
  const end = ctx.indexOf("\n\n", start);
  return ctx.slice(start, end === -1 ? undefined : end + 2);
}

const ORIGINAL_FETCH = global.fetch;

/** Routes api.github.com through h.state.ghRoutes; anything unrouted 404s. */
function installFetch() {
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    const key = `${method} ${u.replace("https://api.github.com", "")}`;
    h.state.ghCalls.push(key);
    const route = h.state.ghRoutes[key];
    if (!route) return { ok: false, status: 404, text: async () => JSON.stringify({ message: `no route: ${key}` }) };
    const status = route.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(route.body ?? {}) };
  });
}

beforeEach(() => {
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.adopted.length = 0;
  h.state.advanced.length = 0;
  h.state.ghCalls.length = 0;
  h.state.ghRoutes = {};
  h.state.children = [];
  h.state.enforce = vi.fn(async () => ({ escalated: false, gated: true }));
  h.state.workflow = makeWorkflow();
  h.state.tickets = {
    "TEAM-1": devTicket("TEAM-1", ["advisory"]),
    "TEAM-2": devTicket("TEAM-2"),
  };
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.ADVISORY_ROUTING;
  delete process.env.GITHUB_PAT;
});

// ─── 1. the `## Branch` block ────────────────────────────────────────────────

describe("1. ## Branch for an advisory ticket (FR-7 §9.2)", () => {
  it("enforce + advisory: its OWN branch off the default branch, and told to PR there", async () => {
    await load("enforce");

    const block = branchBlock(await buildAgentContext(h.state.tickets["TEAM-1"], h.state.workflow));

    expect(block).toBe(
      "## Branch\n" +
        "feature_branch: feature/TEAM-1-advisory\n" +
        "base_branch: main\n" +
        "NOTE: ADVISORY ticket. Branch from main and open your PR against main. " +
        "It is NOT part of this run's shared integration branch or its unified PR; " +
        "the release manager will not review it in this run.\n\n"
    );
    // The run's integration branch is nowhere in the block — that is the point.
    expect(block).not.toContain("feature/EPIC-1-highlight-reel");
    expect(block).not.toContain("SHARED integration branch");
  });

  it("enforce + an UNLABELLED ticket: byte-identical to the same ticket with the flag off", async () => {
    await load("enforce");
    const enforced = await buildAgentContext(h.state.tickets["TEAM-2"], h.state.workflow);
    await load(undefined);
    const off = await buildAgentContext(h.state.tickets["TEAM-2"], h.state.workflow);

    expect(enforced).toBe(off);
    expect(branchBlock(off)).toBe(
      "## Branch\n" +
        "feature_branch: feature/TEAM-2-backend-dev\n" +
        "base_branch: feature/EPIC-1-highlight-reel\n" +
        "NOTE: base_branch is this run's SHARED integration branch. Branch from it, " +
        "target your PR at it (never the repo default branch), and merge your PR into it " +
        "when your evidence is complete — one unified PR to the default branch is opened " +
        "by the orchestrator at run completion.\n\n"
    );
  });

  it("off + advisory: byte-identical to today — the label is inert without the flag", async () => {
    await load(undefined);
    const off = await buildAgentContext(h.state.tickets["TEAM-1"], h.state.workflow);

    // Same shape as the unlabelled ticket above: persona slug, base = the run's
    // integration branch, the shared-integration NOTE.
    expect(branchBlock(off)).toBe(
      "## Branch\n" +
        "feature_branch: feature/TEAM-1-backend-dev\n" +
        "base_branch: feature/EPIC-1-highlight-reel\n" +
        "NOTE: base_branch is this run's SHARED integration branch. Branch from it, " +
        "target your PR at it (never the repo default branch), and merge your PR into it " +
        "when your evidence is complete — one unified PR to the default branch is opened " +
        "by the orchestrator at run completion.\n\n"
    );
    expect(off).not.toContain("ADVISORY ticket");
  });

  it("garbage in ADVISORY_ROUTING is off, not enforce", async () => {
    await load("enfroce");
    const garbage = await buildAgentContext(h.state.tickets["TEAM-1"], h.state.workflow);
    await load("off");
    const off = await buildAgentContext(h.state.tickets["TEAM-1"], h.state.workflow);
    expect(garbage).toBe(off);
    expect(garbage).not.toContain("ADVISORY ticket");
  });

  it("enforce with no integration branch yet: advisory and non-advisory agree on main", async () => {
    // The advisory branch is derived from repoConfig, never from featureBranch,
    // so a run that has not created its shared branch yet behaves the same.
    await load("enforce");
    h.state.workflow = makeWorkflow({ featureBranch: null });

    const advisory = branchBlock(await buildAgentContext(h.state.tickets["TEAM-1"], h.state.workflow));
    const plain = branchBlock(await buildAgentContext(h.state.tickets["TEAM-2"], h.state.workflow));

    expect(advisory).toContain("base_branch: main\n");
    expect(plain).toContain("base_branch: main\n");
    // With no shared branch there is no shared-integration NOTE to print...
    expect(plain).not.toContain("NOTE:");
    // ...but the advisory instruction is not conditional on one.
    expect(advisory).toContain("open your PR against main");
  });
});

// ─── 2. the ported-session adoption guard ────────────────────────────────────

describe("2. an -advisory branch is never adopted as the integration branch", () => {
  /** A run that has NOT created its shared branch yet, carrying a ported branch. */
  const portedRun = (branch) =>
    makeWorkflow({
      phase: "requirements",
      featureBranch: null,
      input: { title: "Highlight reel", description: "d", portedSession: { branch } },
    });

  beforeEach(() => {
    process.env.GITHUB_PAT = "ghp_test";
    installFetch();
    h.state.ghRoutes = {
      "GET /repos/acme/juno/git/ref/heads/main": { body: { object: { sha: "basesha" } } },
      "POST /repos/acme/juno/git/refs": { status: 201, body: { ref: "refs/heads/feature/EPIC-1-highlight-reel" } },
    };
  });

  it("refuses `feature/TEAM-9-advisory` and creates a fresh branch off the default instead", async () => {
    await load("enforce");
    h.state.workflow = portedRun("feature/TEAM-9-advisory");

    await handler(readyRecord("TEAM-2"));

    // Adoption happened exactly once — with the ORCHESTRATOR's own branch name.
    expect(h.state.adopted).toEqual([{ id: "wf_1", branch: "feature/EPIC-1-highlight-reel" }]);
    expect(h.state.adopted.some((a) => /-advisory$/.test(a.branch))).toBe(false);
    // …created off the default branch, not off the advisory branch.
    expect(h.state.ghCalls).toEqual([
      "GET /repos/acme/juno/git/ref/heads/main",
      "POST /repos/acme/juno/git/refs",
    ]);
    expect(h.state.advanced.at(-1)).toEqual({ id: "wf_1", phase: "development", branch: "feature/EPIC-1-highlight-reel" });
  });

  it("the guard is unconditional — it holds with ADVISORY_ROUTING off too", async () => {
    // The refusal is a data-integrity guard on a branch NAME that arrives from
    // outside the orchestrator, not a routing behaviour: an advisory branch is
    // the wrong base for a run whatever the flag says.
    await load(undefined);
    h.state.workflow = portedRun("feature/TEAM-9-advisory");

    await handler(readyRecord("TEAM-2"));

    expect(h.state.adopted).toEqual([{ id: "wf_1", branch: "feature/EPIC-1-highlight-reel" }]);
  });

  it("an ORDINARY ported branch is still adopted, with no branch creation at all", async () => {
    await load("enforce");
    h.state.workflow = portedRun("laptop/tycen-session-1");

    await handler(readyRecord("TEAM-2"));

    expect(h.state.adopted).toEqual([{ id: "wf_1", branch: "laptop/tycen-session-1" }]);
    expect(h.state.ghCalls).toEqual([]); // adoption short-circuits creation
  });

  it("a branch merely CONTAINING advisory is not refused — only the -advisory suffix is", async () => {
    await load("enforce");
    h.state.workflow = portedRun("feature/TEAM-9-advisory-panel");

    await handler(readyRecord("TEAM-2"));

    expect(h.state.adopted).toEqual([{ id: "wf_1", branch: "feature/TEAM-9-advisory-panel" }]);
  });
});

// ─── 3. the ship review's change set ────────────────────────────────────────

describe("3. the ship review change set only ever enumerates its own PR", () => {
  /**
   * The advisory branch's files can only enter the review if something walked a
   * branch instead of the PR — so the honest assertion is about what
   * computeReviewChangeSet ENUMERATES: the PR's own file list, from
   * `GET /repos/{o}/{r}/pulls/{n}/files`, and nothing else. `adv.ts` is absent by
   * construction (no call exists that could have found it), which is exactly the
   * property FR-7 needs: an advisory ticket PRs against the default branch, so
   * its files are in a different PR that this review never reads.
   */
  it("returns the unified PR's files only — advisory-branch files are unreachable", async () => {
    await load("enforce");
    process.env.GITHUB_PAT = "ghp_test";
    installFetch();
    h.state.ghRoutes = {
      // The shared integration PR: only the approved scope. (list_pr_files
      // paginates, so the page-1 query string is part of the route key.)
      "GET /repos/acme/juno/pulls/42/files?per_page=100&page=1": { body: [{ filename: "x.ts", status: "modified" }] },
      // Present in the fake, on the advisory ticket's OWN pr — nothing in the
      // review path is allowed to reach for it.
      "GET /repos/acme/juno/pulls/77/files?per_page=100&page=1": { body: [{ filename: "adv.ts", status: "added" }] },
      // …and neither may it walk the advisory BRANCH.
      "GET /repos/acme/juno/compare/main...feature/TEAM-1-advisory": { body: { files: [{ filename: "adv.ts" }] } },
    };

    await handleReviewRejection({
      ticketId: "TEAM-8",
      workflowId: "wf_1",
      parentId: EPIC,
      blockedBy: ["TEAM-2"],
      reviewComment: "please fix the null check",
      prUrl: "https://github.com/acme/juno/pull/42",
    });

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    const { changeSet } = h.state.enforce.mock.calls[0][0];
    expect(changeSet).toEqual(["x.ts"]);
    expect(changeSet).not.toContain("adv.ts");
    // One call, and it is the PR's file list — not a branch compare.
    expect(h.state.ghCalls).toEqual(["GET /repos/acme/juno/pulls/42/files?per_page=100&page=1"]);
  });
});
