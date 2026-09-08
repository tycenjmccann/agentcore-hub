import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The ## Branch block reaches every persona, and the branch it names is real
 * (TEAM-4248 D3) — through the REAL buildAgentContext in index.mjs.
 *
 * Run c2uqki (dead-code-sweep on tycenjmccann/ember) is the whole test fixture.
 * All four downstream tickets told their persona to look at
 * `chore/dead-code-sweep-2026-09-07`, a name the analyst invented. The sweeper had
 * actually pushed `feature/TEAM-4230-code-sweeper`. The reviewer, QA and CI each
 * opened a session, discovered "Ticket-named branch does not exist", and
 * reconciled by hand — three sessions of friction and three chances to review the
 * wrong tree.
 *
 * The orchestrator has always known the right answer: it RENDERS the convention.
 * It just rendered it for development-phase personas only, so the four who had to
 * FIND the branch were the four never told it.
 *
 * Only the I/O seams are mocked (AWS SDK clients, workflow-store), so what these
 * cases assert is the prompt a persona is actually handed.
 */

const EPIC = "TEAM-4228";
const SWEEPER = "agentcore_hub_code_sweeper";
const REVIEWER = "agentcore_hub_code_reviewer";
const QA = "agentcore_hub_qa_verifier";
const INTAKE = "agentcore_hub_requirements_analyst";
const INVENTED = "chore/dead-code-sweep-2026-09-07";
const REAL = "feature/TEAM-4230-code-sweeper";

const h = vi.hoisted(() => ({
  state: {
    children: /** @type {any[]} */ ([]),
    childQueries: /** @type {any[]} */ ([]),
    childReadFails: false,
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    s3Gets: /** @type {string[]} */ ([]),
    events: /** @type {any[]} */ ([]),
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
          if (name === "QueryCommand") {
            if (cmd.input.TableName === "agentcore-hub-events") return { Items: [] };
            // The epic's children — the ONE read the branch block and the
            // unverified-fix block now share.
            h.state.childQueries.push(cmd.input);
            if (h.state.childReadFails) throw new Error("ProvisionedThroughputExceededException");
            return { Items: h.state.children };
          }
          if (name === "GetCommand") return { Item: null };
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send() {
      return { Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: "{}" })) };
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.constructor.name !== "GetObjectCommand") return {};
      h.state.s3Gets.push(cmd.input.Key);
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
process.env.GITHUB_PAT = "ghp_test";

const AGENTS_CONFIG = JSON.stringify({
  agents: [
    { agentId: INTAKE, phase: "requirements" },
    // The sweeper's ROSTER phase is development even though the sweep def calls
    // its phase "detection" — that is what makes it the branch's producer.
    { agentId: SWEEPER, phase: "development" },
    { agentId: REVIEWER, phase: "review" },
    { agentId: QA, phase: "verification" },
  ],
});

const WORKFLOWS_CONFIG = JSON.stringify({
  workflows: [
    {
      id: "dead-code-sweep",
      intakeAgentId: INTAKE,
      featureBranchPhase: "development",
      createsPullRequest: true,
      completionRequiresAgentPhases: ["development", "review", "verification"],
      reviewGates: [],
      phases: [{ agentPhase: "requirements" }, { agentPhase: "development" }, { agentPhase: "review" }],
    },
  ],
});

/** c2uqki's board: one sweeper (the producer) plus the three consumers. */
const BOARD = [
  { ticketId: "TEAM-4230", assignee: SWEEPER, parentId: EPIC, status: "done", title: "Sweep ember", blockedBy: [] },
  { ticketId: "TEAM-4231", assignee: REVIEWER, parentId: EPIC, status: "ready", title: "Review the sweep", blockedBy: ["TEAM-4230"] },
  { ticketId: "TEAM-4232", assignee: QA, parentId: EPIC, status: "blocked", title: "Verify the sweep", blockedBy: ["TEAM-4231"] },
];

/** The description as the analyst really wrote it, backticked branch and all. */
const REVIEW_TICKET = {
  ticketId: "TEAM-4231",
  assignee: REVIEWER,
  parentId: EPIC,
  title: "Review the dead-code removal",
  description: `Review the removals on branch \`${INVENTED}\` -> main. Confirm no live caller was deleted.`,
};

const DEV_TICKET = {
  ticketId: "TEAM-4230",
  assignee: SWEEPER,
  parentId: EPIC,
  title: "Sweep tycenjmccann/ember for dead code",
  description: `Remove verified-dead modules. Push to \`${INVENTED}\`.`,
};

function makeWorkflow(extra = {}) {
  return {
    id: "wf_c2uqki",
    workflowId: "wf_c2uqki",
    phase: "review",
    epicId: EPIC,
    workflowDefId: "dead-code-sweep",
    input: { title: "Sweep ember", description: "d" },
    repoConfig: { layout: "single-repo", repos: [{ platform: "shared", url: "https://github.com/tycenjmccann/ember", defaultBranch: "main" }] },
    featureBranch: "feature/TEAM-4228-sweep",
    agentTasks: {},
    humanNotifications: [],
    ...extra,
  };
}

let buildAgentContext;

async function load(mode) {
  if (mode === undefined) delete process.env.TICKET_PLAN_VALIDATOR;
  else process.env.TICKET_PLAN_VALIDATOR = mode;
  h.state.s3Objects = {
    "config/agents.json": AGENTS_CONFIG,
    "config/workflows.json": WORKFLOWS_CONFIG,
  };
  vi.resetModules();
  const mod = await import("./index.mjs");
  ({ buildAgentContext } = mod);
  await mod.handler({ Records: [] }); // primes roster / defs / registry caches
  h.state.childQueries.length = 0;
  h.state.s3Gets.length = 0;
  h.state.events.length = 0;
  return mod;
}

const eventsOf = (type) => h.state.events.filter((e) => e.type === type);
const branchBlock = (ctx) => {
  const m = /## Branch\n([\s\S]*?)\n\n/.exec(ctx);
  return m ? m[1] : null;
};

beforeEach(() => {
  h.state.children = BOARD.map((t) => ({ ...t }));
  h.state.childQueries.length = 0;
  h.state.childReadFails = false;
  h.state.s3Gets.length = 0;
  h.state.events.length = 0;
  h.state.workflow = makeWorkflow();
});

describe("TICKET_PLAN_VALIDATOR=off — today, byte for byte", () => {
  it("a reviewer gets NO ## Branch block, no sibling read and the invented name intact", async () => {
    await load("off");
    const ctx = await buildAgentContext(REVIEW_TICKET, h.state.workflow);
    expect(ctx).not.toContain("## Branch");
    // The defect, reproduced: the only branch name the reviewer can see is the
    // one that does not exist.
    expect(ctx).toContain(INVENTED);
    expect(ctx).not.toContain(REAL);
    expect(h.state.childQueries, "off must not read the board").toHaveLength(0);
    expect(h.state.events).toHaveLength(0);
  });

  it("the sweeper's own block is exactly the pre-D3 one", async () => {
    await load("off");
    const ctx = await buildAgentContext(DEV_TICKET, h.state.workflow);
    expect(branchBlock(ctx)).toBe(
      `feature_branch: ${REAL}\n` +
        `base_branch: feature/TEAM-4228-sweep\n` +
        `NOTE: base_branch is this run's SHARED integration branch. Branch from it, target your PR at it (never the repo default branch), and merge your PR into it when your evidence is complete — one unified PR to the default branch is opened by the orchestrator at run completion.`,
    );
    // A producer needs no sibling lookup: its branch is its own ticket's.
    expect(h.state.childQueries).toHaveLength(0);
  });
});

describe("TICKET_PLAN_VALIDATOR=shadow — every persona is told, nothing is changed", () => {
  it("the reviewer gets the producer's real branch and the read-only NOTE", async () => {
    await load("shadow");
    const ctx = await buildAgentContext(REVIEW_TICKET, h.state.workflow);
    const block = branchBlock(ctx);
    expect(block).toContain(`feature_branch: ${REAL}`);
    expect(block).toContain("base_branch: feature/TEAM-4228-sweep");
    expect(block).toContain("you do not push to this branch; check it out to verify");
  });

  it("QA gets it too — the consumers are the whole point", async () => {
    await load("shadow");
    const ctx = await buildAgentContext(
      { ...REVIEW_TICKET, ticketId: "TEAM-4232", assignee: QA },
      h.state.workflow,
    );
    expect(branchBlock(ctx)).toContain(`feature_branch: ${REAL}`);
  });

  it("the description reaches the model byte-identical, and ONE observed event records what would have changed", async () => {
    await load("shadow");
    const ctx = await buildAgentContext(REVIEW_TICKET, h.state.workflow);
    expect(ctx).toContain(`Description: ${REVIEW_TICKET.description}`);
    expect(ctx).toContain(INVENTED); // untouched prose

    const observed = eventsOf("ticket_plan.branch_rewritten_observed");
    expect(observed).toHaveLength(1);
    expect(eventsOf("ticket_plan.branch_rewritten")).toHaveLength(0);
    const detail = typeof observed[0].detail === "string" ? JSON.parse(observed[0].detail) : observed[0].detail;
    expect(detail.rewrites).toEqual([{ from: INVENTED, to: REAL }]);
    expect(detail.ticketId).toBe("TEAM-4231");
  });

  it("a ticket that names no branch emits no event at all", async () => {
    await load("shadow");
    await buildAgentContext(
      { ...REVIEW_TICKET, description: "Review the removals. Confirm no live caller was deleted." },
      h.state.workflow,
    );
    expect(h.state.events.filter((e) => String(e.type).startsWith("ticket_plan."))).toHaveLength(0);
  });

  it("a ticket that names the REAL branch is not treated as an invention", async () => {
    await load("shadow");
    await buildAgentContext(
      { ...REVIEW_TICKET, description: `Review the removals on \`${REAL}\`.` },
      h.state.workflow,
    );
    expect(h.state.events.filter((e) => String(e.type).startsWith("ticket_plan."))).toHaveLength(0);
  });
});

describe("TICKET_PLAN_VALIDATOR=enforce — the invented name never reaches the model", () => {
  it("the reviewer's prompt has feature/TEAM-4230-code-sweeper and NOT chore/dead-code-sweep-2026-09-07", async () => {
    await load("enforce");
    const ctx = await buildAgentContext(REVIEW_TICKET, h.state.workflow);
    expect(ctx).toContain(REAL);
    expect(ctx, "the invented branch is what cost c2uqki three sessions").not.toContain(INVENTED);
    // …in the prose, not only in the block: the rewrite is what the model reads.
    expect(ctx).toContain(`Review the removals on branch \`${REAL}\` -> main.`);
    expect(eventsOf("ticket_plan.branch_rewritten")).toHaveLength(1);
    expect(eventsOf("ticket_plan.branch_rewritten_observed")).toHaveLength(0);
  });

  it("nothing is persisted — the rewrite is context-only", async () => {
    await load("enforce");
    await buildAgentContext(REVIEW_TICKET, h.state.workflow);
    // The one writer of a description is Tickets___update_ticket, which the
    // orchestrator never calls; the ticket object it was handed is untouched too.
    expect(REVIEW_TICKET.description).toContain(INVENTED);
  });
});

describe("the dev-phase prompt is unchanged in all three modes", () => {
  it("byte-identical across off / shadow / enforce", async () => {
    const built = [];
    for (const mode of ["off", "shadow", "enforce"]) {
      await load(mode);
      built.push(await buildAgentContext(DEV_TICKET, h.state.workflow));
    }
    expect(built[1]).toBe(built[0]);
    expect(built[2]).toBe(built[0]);
    // Including the invented name still in its own description: a producer is
    // told the branch to push in the block, which it has always had and always
    // followed — c2uqki's sweeper pushed the convention while its own ticket
    // named the invention. Rewriting its prose would change the prompt of the one
    // persona that was never confused.
    expect(built[2]).toContain(INVENTED);
  });
});

describe("degradation and I/O budget", () => {
  it("a failed sibling read degrades to the feature branch and still renders the block", async () => {
    await load("enforce");
    h.state.childReadFails = true;
    const ctx = await buildAgentContext(REVIEW_TICKET, h.state.workflow);
    // Never dropped: dropping this block is what produced the defect.
    expect(branchBlock(ctx)).toContain("feature_branch: feature/TEAM-4228-sweep");
    expect(ctx).not.toContain(INVENTED); // rewritten to the shared branch
  });

  it("several producers → the shared integration branch, not a guess", async () => {
    await load("shadow");
    h.state.children.push({
      ticketId: "TEAM-4235", assignee: SWEEPER, parentId: EPIC, status: "done", title: "Second sweep", blockedBy: [],
    });
    const ctx = await buildAgentContext(REVIEW_TICKET, h.state.workflow);
    expect(branchBlock(ctx)).toContain("feature_branch: feature/TEAM-4228-sweep");
  });

  it("the board is read at most ONCE per context build", async () => {
    await load("shadow");
    await buildAgentContext(REVIEW_TICKET, h.state.workflow);
    expect(h.state.childQueries).toHaveLength(1);
  });

  it("shared/output.md is read for development only, in every mode", async () => {
    const key = "workflows/wf_c2uqki/shared/output.md";
    for (const mode of ["off", "shadow", "enforce"]) {
      await load(mode);
      await buildAgentContext(REVIEW_TICKET, h.state.workflow);
      expect(h.state.s3Gets, `reviewer under ${mode}`).not.toContain(key);
      h.state.s3Gets.length = 0;
      await buildAgentContext(DEV_TICKET, h.state.workflow);
      expect(h.state.s3Gets, `sweeper under ${mode}`).toContain(key);
    }
  });
});
