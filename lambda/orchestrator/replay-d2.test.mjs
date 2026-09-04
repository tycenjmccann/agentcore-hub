import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-3747 D2 — AC-D2.1/2/3 replay fixtures.
 *
 * Three real production runs that closed GREEN over work that was never shipped:
 * the board said "complete", the branch was never merged, and a human only found
 * out later. Each run is captured as a small deterministic fixture (the children
 * snapshot + the harvested agentTasks the run actually had) and replayed through
 * the REAL completeWorkflow. The assertion for every run is the same shape:
 *
 *   - the run NEVER reaches "complete" (no store.completeWorkflow claim, no
 *     workflow.complete event), and
 *   - it does not silently stall either — it closes on an HONEST terminal outcome
 *     (deploy-blocked / static-ci-only) with the evidence a human needs: the PR
 *     url and/or the explicit block reason on a terminal verdict event.
 *
 *   - 29g73c   (AC-D2.1): the pipeline called complete over an UNMERGED PR. CI was
 *              green, the release manager wrote its summary, nothing merged. Must
 *              close static-ci-only with the PR url surfaced.
 *   - TEAM-3507 (AC-D2.2): the CD agent correctly BLOCKED pre-merge (a required
 *              deploy check was red). Historically the ship ticket flipped to done
 *              anyway and the run closed complete. Must close deploy-blocked and
 *              carry the block reason.
 *   - r30dhl   (AC-D2.3): CD failed closed on an IAM AccessDenied it could not
 *              evaluate. Must never reach complete; the AccessDenied reason must
 *              be surfaced, not swallowed.
 *
 * Plus the idempotency contract: two cascades (or a stream re-delivery) both
 * reaching the gate produce exactly ONE terminal event — the loser of the
 * claimTerminalOutcome CAS is a no-op.
 *
 * index.mjs is imported for real; only its I/O seams (AWS SDK clients,
 * workflow-store) are mocked — the same harness as completion-gates.test.mjs.
 */

const h = vi.hoisted(() => ({
  state: {
    children: /** @type {any[]} */ ([]),
    freshWorkflow: /** @type {any} */ (null),
    storeCompletions: /** @type {any[]} */ ([]),
    finalized: /** @type {any[]} */ ([]),
    // Real CAS semantics: the FIRST claim wins, every later one loses (the row is
    // already terminal). This is what makes the idempotency replay honest.
    terminalClaims: /** @type {any[]} */ ([]),
    ebEvents: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]), // events-table Put items
    updates: /** @type {any[]} */ ([]), // any ticket/workflow UpdateCommand
    s3AgentsConfig: {
      agents: [
        { agentId: "agentcore_hub_backend_dev", phase: "development" },
        { agentId: "agentcore_hub_qa_verifier", phase: "verification" },
        { agentId: "agentcore_hub_ci_agent", phase: "review" },
        { agentId: "agentcore_hub_release_manager", phase: "ship" },
      ],
    },
    s3WorkflowsConfig: {
      workflows: [
        {
          id: "software-delivery",
          intakeAgentId: "agentcore_hub_requirements_analyst",
          featureBranchPhase: "development",
          createsPullRequest: false, // on a ship def the release manager owns the PR
          completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
          reviewGates: [],
          phases: [
            { agentPhase: "development" },
            { agentPhase: "verification" },
            { agentPhase: "review" },
            { agentPhase: "ship" },
          ],
        },
      ],
    },
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
          // getChildTickets → the parentId-index query → the fixture's siblings.
          if (name === "QueryCommand") return { Items: h.state.children };
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: class {}, InvokeCommand: class { constructor(i) { this.input = i; } } }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const key = cmd?.input?.Key;
      const body = key === "config/agents.json" ? h.state.s3AgentsConfig
        : key === "config/workflows.json" ? h.state.s3WorkflowsConfig
        : null;
      if (!body) throw new Error("NoSuchKey");
      return { Body: { transformToString: async () => JSON.stringify(body) } };
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send(cmd) { h.state.ebEvents.push(cmd.input); return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async (id) => (h.state.freshWorkflow?.id === id ? h.state.freshWorkflow : null)),
  completeWorkflow: vi.fn(async (id, ts) => { h.state.storeCompletions.push({ id, ts }); return true; }),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async (id) => { h.state.finalized.push(id); }),
  claimTerminalOutcome: vi.fn(async (id, outcome, ts, reason) => {
    const first = h.state.terminalClaims.length === 0;
    h.state.terminalClaims.push({ id, outcome, ts, reason: reason ?? null });
    return first; // CAS: only the first claim flips a non-terminal row
  }),
  mergeTaskMetadata: vi.fn(async () => {}),
}));

// The ship-phase def only exists in the S3 config (the hardcoded fallback def has
// no ship phase), and the loaders skip S3 entirely without a bucket.
process.env.ARTIFACT_BUCKET = "test-bucket";
// No PAT → labelPullRequest's githubApi throws before any network call, which is
// the best-effort path closeWorkflowBlocked must swallow. Keeps these hermetic.
delete process.env.GITHUB_PAT;

let completeWorkflow;
let handler;

/** Load index.mjs and prime the roster/def caches (only handler() fills them). */
async function load() {
  vi.resetModules();
  ({ completeWorkflow, handler } = await import("./index.mjs"));
  await handler({ Records: [] }); // no records → no side effects, just the config load
}

const ebOfType = (type) =>
  h.state.ebEvents
    .flatMap((i) => i.Entries || [])
    .filter((e) => e.DetailType === type)
    .map((e) => JSON.parse(e.Detail));
const tableEventsOfType = (type) => h.state.events.filter((e) => e.type === type);

/** Assertions every replay shares: no green close, exactly one honest terminal one. */
function expectHonestTerminalClose(wf, outcome) {
  // 1. NEVER complete.
  expect(h.state.storeCompletions).toHaveLength(0);
  expect(ebOfType("workflow.complete")).toHaveLength(0);
  expect(tableEventsOfType("workflow.complete")).toHaveLength(0);
  expect(wf.phase).toBe(outcome);
  // 2. Not a silent stall either: one atomic terminal claim + one verdict event…
  expect(h.state.terminalClaims).toHaveLength(1);
  expect(h.state.terminalClaims[0].outcome).toBe(outcome);
  const type = outcome === "deploy-blocked" ? "workflow.deploy_blocked" : "workflow.static_ci_only";
  const events = ebOfType(type);
  expect(events).toHaveLength(1);
  // …which carries `outcome` so a consumer that only knows workflow.complete can
  // still tell this run apart from a shipped one.
  expect(events[0].outcome).toBe(outcome);
  expect(events[0].workflowId).toBe(wf.id);
  // 3. …and the run is finalized, so a retry cannot re-close it.
  expect(h.state.finalized).toEqual([wf.id]);
  return events[0];
}

// The non-ship half of the run: every phase done WITH deliverable evidence, so the
// TEAM-3686 evidence gate is satisfied and only the ship verdict is under test.
const UPSTREAM_CHILDREN = [
  { ticketId: "T-1", assignee: "agentcore_hub_backend_dev", type: "task", status: "done" },
  { ticketId: "T-2", assignee: "agentcore_hub_qa_verifier", type: "task", status: "done" },
  { ticketId: "T-3", assignee: "agentcore_hub_ci_agent", type: "task", status: "done" },
];
const UPSTREAM_TASKS = {
  "T-1": { ticketId: "T-1", output: "endpoints implemented", commitSha: "aa11bb2" },
  "T-2": { ticketId: "T-2", output: "12 tests added, all green" },
  "T-3": { ticketId: "T-3", output: "ci: build + lint + unit green" },
};

/** Build a fixture run: upstream done + one ship ticket carrying `shipEntry`. */
function fixture(id, shipEntry, { shipTicketId = "SHIP-1" } = {}) {
  h.state.children = [
    ...UPSTREAM_CHILDREN,
    { ticketId: shipTicketId, assignee: "agentcore_hub_release_manager", type: "task", status: "done" },
  ];
  h.state.freshWorkflow = {
    id,
    agentTasks: { ...UPSTREAM_TASKS, [shipTicketId]: { ticketId: shipTicketId, ...shipEntry } },
  };
  return {
    id,
    phase: "ship",
    workflowDefId: "software-delivery",
    epicId: `EPIC-${id}`,
    featureBranch: `feature/${id}`,
    input: { title: `replay ${id}` },
  };
}

beforeEach(async () => {
  h.state.children = [];
  h.state.freshWorkflow = null;
  h.state.storeCompletions.length = 0;
  h.state.finalized.length = 0;
  h.state.terminalClaims.length = 0;
  h.state.ebEvents.length = 0;
  h.state.events.length = 0;
  h.state.updates.length = 0;
  delete process.env.COMPLETION_EVIDENCE_REQUIRED;
  await load();
});

describe("AC-D2.1 replay — 29g73c (complete attempted over an UNMERGED PR)", () => {
  it("closes static-ci-only with the PR url surfaced — never complete", async () => {
    // What the run actually had: green static CI, a release-manager summary, a PR
    // that was opened and never merged. No mergeCommit anywhere.
    const wf = fixture("29g73c", {
      output: "Release summary: 3 commits, CI green, PR opened for review.",
      artifactKey: "workflows/29g73c/shared/release-notes.md",
      prUrl: "https://github.com/acme/agentcore-hub/pull/412",
      ciStatus: "success",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await completeWorkflow(wf);

    const event = expectHonestTerminalClose(wf, "static-ci-only");
    // The human-actionable evidence: WHICH PR is unmerged, and which ticket lied.
    expect(event.prUrl).toBe("https://github.com/acme/agentcore-hub/pull/412");
    expect(event.featureBranch).toBe("feature/29g73c");
    expect(event.offenders).toEqual([{ ticketId: "SHIP-1", phase: "ship", verdict: "none" }]);
    // No block was declared by the agent, so there is no reason to invent one —
    // the PR url is the evidence instead (never both empty).
    expect(event.reason).toBeNull();
    expect(event.prUrl || event.reason).toBeTruthy();
    expect(error.mock.calls.some((c) => String(c[0]).includes("closed static-ci-only (not shipped)"))).toBe(true);
    error.mockRestore();
  });

  it("a merge commit on the SAME fixture completes — the gate reads the merge, not the mood", async () => {
    // Control: identical run, except the PR actually merged. Without this the test
    // above would also pass on a gate that simply never completes anything.
    const wf = fixture("29g73c", {
      output: "Release summary: 3 commits, CI green, PR merged.",
      prUrl: "https://github.com/acme/agentcore-hub/pull/412",
      mergeCommit: "7d3e91f",
    });

    await completeWorkflow(wf);

    expect(h.state.terminalClaims).toHaveLength(0);
    expect(h.state.storeCompletions).toHaveLength(1);
    expect(wf.phase).toBe("complete");
    expect(ebOfType("workflow.complete")).toHaveLength(1);
  });
});

describe("AC-D2.2 replay — TEAM-3507 (CD correctly BLOCKS pre-merge)", () => {
  const REASON =
    "pre-merge preflight: required check cd/deploy-staging is failing — refusing to merge";

  it("the run closes deploy-blocked carrying the block reason — the ship ticket never buys a green close", async () => {
    const wf = fixture("TEAM-3507", {
      output: "Pre-merge preflight run. BLOCKED.",
      outcome: "deploy-blocked",
      blockReason: REASON,
      prUrl: "https://github.com/acme/agentcore-hub/pull/507",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await completeWorkflow(wf);

    const event = expectHonestTerminalClose(wf, "deploy-blocked");
    // deploy-blocked outranks a bare missing verdict: the agent DID attempt and
    // report, so the specific reason is what a human sees.
    expect(event.reason).toBe(REASON);
    expect(event.offenders).toEqual([{ ticketId: "SHIP-1", phase: "ship", verdict: "deploy-blocked" }]);
    // The reason is durable on the record, not just on the event.
    expect(h.state.terminalClaims[0].reason).toBe(REASON);
    expect(wf.blockReason).toBe(REASON);
    // A blocked close writes NO board transition — nothing gets flipped to done
    // behind the block (the regression this fixture is named for).
    expect(h.state.updates).toHaveLength(0);
    error.mockRestore();
  });
});

describe("AC-D2.3 replay — r30dhl (CD fails closed on an IAM AccessDenied)", () => {
  const REASON =
    "AccessDenied: User is not authorized to perform cloudformation:DescribeStacks — cannot verify deploy, failing closed";

  it("an unevaluatable deploy never reaches complete; the AccessDenied is surfaced", async () => {
    const wf = fixture("r30dhl", {
      output: "Deploy verification attempted.",
      outcome: "deploy-blocked", // fail-closed: could not prove success ⇒ blocked
      blockReason: REASON,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await completeWorkflow(wf);

    const event = expectHonestTerminalClose(wf, "deploy-blocked");
    expect(event.reason).toContain("AccessDenied");
    expect(event.reason).toBe(REASON);
    // No PR was harvested onto the ship ticket — the close still happens, and the
    // reason carries the whole story (prUrl empty, never undefined).
    expect(event.prUrl).toBe("");
    expect(h.state.terminalClaims[0].reason).toContain("AccessDenied");
    error.mockRestore();
  });

  it("an infra failure the gate itself cannot resolve does NOT invent a block", async () => {
    // Contrast with the above: when the VERDICT LOOKUP explodes (not the deploy),
    // the gate must fail open — a broken read is not evidence of an unshipped run.
    // The ship entry here has NO merge verdict, so a gate that did not fail open
    // would divert; the run completing is what proves it did.
    const wf = fixture("r30dhl", { output: "release summary" });
    const store = await import("./workflow-store.mjs");
    // Three reads now reach the store: the terminal-phase hygiene check (fails
    // open), the evidence gate, the ship-verdict gate — each must swallow AccessDenied.
    store.getWorkflow.mockImplementationOnce(async () => { throw new Error("AccessDeniedException: dynamodb:GetItem"); })
      .mockImplementationOnce(async () => { throw new Error("AccessDeniedException: dynamodb:GetItem"); })
      .mockImplementationOnce(async () => { throw new Error("AccessDeniedException: dynamodb:GetItem"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await completeWorkflow(wf);

    expect(h.state.terminalClaims).toHaveLength(0);
    expect(h.state.storeCompletions).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("ship-verdict check skipped"))).toBe(true);
    warn.mockRestore();
  });
});

describe("idempotency — a raced/redelivered close is a no-op (TEAM-3747 D2)", () => {
  it("two cascades reaching the gate produce exactly ONE terminal event", async () => {
    // Both callers see the same unshipped run (a stream re-delivery, or two
    // concurrent last-ticket-done cascades). claimTerminalOutcome is the single
    // serialization point: the first flips the row, the second loses the CAS.
    const wf = fixture("29g73c", { output: "summary only", prUrl: "https://github.com/acme/x/pull/1" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await completeWorkflow(wf);
    // Second delivery: a fresh workflow object, same row (the loser must not rely
    // on in-memory phase state to notice it lost).
    const wf2 = { ...wf, phase: "ship" };
    delete wf2.completedAt;
    await completeWorkflow(wf2);

    expect(h.state.terminalClaims).toHaveLength(2); // both attempted…
    expect(h.state.terminalClaims.map((c) => c.outcome)).toEqual(["static-ci-only", "static-ci-only"]);
    // …but only the winner emitted a terminal verdict and finalized.
    expect(ebOfType("workflow.static_ci_only")).toHaveLength(1);
    expect(tableEventsOfType("workflow.static_ci_only")).toHaveLength(1);
    expect(h.state.finalized).toEqual(["29g73c"]);
    // And neither call ever fell through to a green close.
    expect(h.state.storeCompletions).toHaveLength(0);
    expect(ebOfType("workflow.complete")).toHaveLength(0);
    // The loser says so out loud rather than throwing or double-writing.
    expect(log.mock.calls.some((c) => String(c[0]).includes("already terminal — skipping duplicate static-ci-only close"))).toBe(true);
    expect(wf2.phase).toBe("ship"); // untouched — the winner owns the record
    error.mockRestore();
    log.mockRestore();
  });
});
