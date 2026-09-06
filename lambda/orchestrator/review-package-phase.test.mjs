import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4159 — which phase `loadReviewPackage` reads the gate's package from.
 *
 * PR #399 wrapped the title/zero-blocker fallbacks in a `chainFor(def)` guard so
 * they would apply to playbook defs only, but the SEED line
 * (`let phase = fallbackReviewPackagePhase(gateTicket)`) stayed unconditional.
 * `fallbackReviewPackagePhase` answers "plan" for any /plan approval/i title, so
 * software-delivery's opt-in "Plan Approval" gate (reviewGates afterPhase
 * "design", src/config/workflows.json) arrived at the blocker walk with phase
 * already "plan": the walk's `if (phase === undefined || phase === "intake")` was
 * false, the walk never ran, and the run listed
 * `shared/review-package-plan` — a prefix no software-delivery designer writes.
 * The gate then got a bare template ping instead of the merged designer packages.
 *
 * The invariant these pin: for a def WITHOUT an artifactChain the phase comes from
 * the blocker walk ONLY; `fallbackReviewPackagePhase` influences it ONLY when
 * `chainFor(getEffectiveWorkflowDef(workflow))` is truthy. Playbook behaviour is
 * unchanged, which is what cases 2 and 3 exist to hold down.
 *
 * index.mjs is imported for real; only its I/O seams are mocked. The S3 mock
 * RECORDS every ListObjectsV2 input, because the requested `Prefix` is the whole
 * observable: it is the difference between finding the designer packages and
 * listing an empty prefix. `loadReviewPackage` is exported solely so this test can
 * drive it (same convention as handleReviewRejection).
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    /** Every ListObjectsV2Command input, in order. */
    lists: /** @type {any[]} */ ([]),
    /** Keys the List mock reports for any prefix that matches. */
    listedKeys: /** @type {string[]} */ ([]),
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
          if (cmd.constructor.name === "GetCommand") {
            return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          }
          if (cmd.constructor.name === "ScanCommand" || cmd.constructor.name === "QueryCommand") {
            return { Items: [] };
          }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {},
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "GetObjectCommand") {
        const body = h.state.s3Objects[cmd.input.Key];
        if (body === undefined) throw new Error("NoSuchKey"); // readS3Artifact → null
        return { Body: { transformToString: async () => body } };
      }
      if (name === "ListObjectsV2Command") {
        // The assertion surface: record the input, then answer only for keys that
        // genuinely sit under the requested prefix (so a WRONG prefix lists empty,
        // exactly as S3 would).
        h.state.lists.push(cmd.input);
        const under = h.state.listedKeys.filter((k) => k.startsWith(cmd.input.Prefix));
        return { Contents: under.map((Key) => ({ Key })) };
      }
      return {};
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
  initWorkflowStore: vi.fn(() => {}), // called at index.mjs module load
  getWorkflow: vi.fn(async () => null),
  ackNotifications: vi.fn(async () => {}),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
}));

const WF = "wf_1";
const GATE_ID = "TEAM-900";
/** agentcore_hub_backend_designer is a "design"-phase agent in the fallback roster. */
const DESIGN_TICKET = { ticketId: "TEAM-10", assignee: "agentcore_hub_backend_designer", status: "done" };
/** agentcore_hub_api_dev is "development" — the playbook Plan Approval gate's blocker. */
const DEV_TICKET = { ticketId: "TEAM-11", assignee: "agentcore_hub_api_dev", status: "done" };

/**
 * The S3 workflows.json `loadWorkflowDefs()` reads. `software-delivery` is here
 * for completeness (its shape matches the built-in fallback def — no
 * artifactChain); `sdlc-playbook` carries the real chain from
 * src/config/workflows.json, whose Plan Approval gate is afterPhase
 * "development" while the package it reads is the PLAN one.
 */
const WORKFLOWS_JSON = JSON.stringify({
  defaultWorkflowDefId: "software-delivery",
  workflows: [
    {
      id: "software-delivery",
      intakeAgentId: "agentcore_hub_requirements_analyst",
      featureBranchPhase: "development",
      createsPullRequest: true,
      completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
      reviewGates: [
        { afterPhase: "design", name: "Plan Approval", blocking: true, condition: "flagged", onReject: "rework", assignee: "human:engineer" },
      ],
      phases: [
        { id: "design", name: "Design", agentPhase: "design" },
        { id: "build", name: "Build", agentPhase: "development" },
      ],
    },
    {
      id: "sdlc-playbook",
      intakeAgentId: "agentcore_hub_requirements_analyst",
      featureBranchPhase: "requirements",
      createsPullRequest: true,
      sdlcFramework: "playbook",
      artifactChain: {
        dir: ".sdlc/{workflowId}",
        artifacts: [
          { name: "intent.md", owner: "intake", gate: "Intent Acceptance" },
          { name: "spec.md", owner: "requirements", gate: "Spec Approval" },
          { name: "plan.md", owner: "plan", gate: "Plan Approval" },
          { name: "findings.md", owner: "review" },
        ],
      },
      completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
      reviewGates: [
        { afterPhase: "intake", name: "Intent Acceptance", blocking: true, condition: "always", onReject: "hold", assignee: "human:product-owner" },
        { afterPhase: "development", scope: "plan", name: "Plan Approval", blocking: true, condition: "always", onReject: "rework", assignee: "human:engineer" },
      ],
    },
  ],
});

let loadReviewPackage;
let loadWorkflowDefs;

const workflow = (workflowDefId) => ({
  id: WF,
  workflowId: WF,
  workflowDefId,
  // No CD registry is loaded, so this run is a HANDOFF and the def gets its ship
  // phase stripped. stripShipPhases spreads the def, so artifactChain survives —
  // which is exactly the def `loadReviewPackage` must branch on.
  repoConfig: { repos: [{ url: "https://github.com/tycenjmccann/agentcore-hub" }] },
});

/** The one recorded ListObjectsV2 prefix (fails loudly if there wasn't exactly one). */
const soleListPrefix = () => {
  expect(h.state.lists).toHaveLength(1);
  return h.state.lists[0].Prefix;
};

beforeEach(async () => {
  h.state.tickets = {};
  h.state.s3Objects = { "config/workflows.json": WORKFLOWS_JSON };
  h.state.lists = [];
  h.state.listedKeys = [];
  // Set BEFORE the import — index.mjs snapshots ARTIFACT_BUCKET at module load,
  // and loadReviewPackage returns null outright without it.
  process.env.ARTIFACT_BUCKET = "test-bucket";
  vi.resetModules();
  ({ loadReviewPackage, loadWorkflowDefs } = await import("./index.mjs"));
});

afterEach(() => {
  delete process.env.ARTIFACT_BUCKET;
});

describe("loadReviewPackage — non-chain defs resolve the phase from the blocker walk (TEAM-4159)", () => {
  it("software-delivery's 'Plan Approval' gate reads the DESIGN package, not review-package-plan", async () => {
    // The regression, stated as data: the gate's TITLE says Plan Approval (the
    // def's own gate name) but its blocker is a design agent, and design is where
    // the packages are. Before the fix the title won and the prefix was …-plan.
    await loadWorkflowDefs();
    h.state.tickets = {
      [GATE_ID]: { ticketId: GATE_ID, workflowId: WF, title: "Plan Approval: Widget", blockedBy: [DESIGN_TICKET.ticketId] },
      [DESIGN_TICKET.ticketId]: DESIGN_TICKET,
    };
    h.state.listedKeys = [`workflows/${WF}/shared/review-package-design.agentcore_hub_backend_designer.json`];
    h.state.s3Objects[`workflows/${WF}/shared/review-package-design.agentcore_hub_backend_designer.json`] =
      JSON.stringify({ summary: "designer summary", bullets: [], links: [] });

    const pkg = await loadReviewPackage(workflow("software-delivery"), GATE_ID);

    expect(soleListPrefix()).toBe(`workflows/${WF}/shared/review-package-design`);
    // …and the merged package really is the designer's, so the gate ping carries
    // content instead of falling back to the bare template.
    expect(pkg).toMatchObject({ gate: "design", summary: "designer summary" });
  });

  it("works off the built-in fallback def too (no workflows.json in S3)", async () => {
    // getWorkflowDef falls back to FALLBACK_WORKFLOW_DEF for an unknown/absent
    // def id, and that def has no artifactChain either — same invariant, no S3.
    delete h.state.s3Objects["config/workflows.json"];
    h.state.tickets = {
      [GATE_ID]: { ticketId: GATE_ID, workflowId: WF, title: "Plan Approval: Widget", blockedBy: [DESIGN_TICKET.ticketId] },
      [DESIGN_TICKET.ticketId]: DESIGN_TICKET,
    };

    await loadReviewPackage(workflow("software-delivery"), GATE_ID);

    expect(soleListPrefix()).toBe(`workflows/${WF}/shared/review-package-design`);
  });

  it("an unresolvable phase lists NOTHING and returns null", async () => {
    // No agent blockers and a title that matches neither fallback. Before the fix
    // the zero-blocker rule seeded "intake" and the run listed a review-package
    // -intake prefix for a def that has no intake package concept.
    await loadWorkflowDefs();
    h.state.tickets = {
      [GATE_ID]: { ticketId: GATE_ID, workflowId: WF, title: "Merge Approval: Widget", blockedBy: [] },
    };

    const pkg = await loadReviewPackage(workflow("software-delivery"), GATE_ID);

    expect(pkg).toBeNull();
    expect(h.state.lists).toEqual([]); // phase unresolved → no S3 call at all
  });

  it("a human blocker is not an agent blocker — still unresolved, still no list", async () => {
    await loadWorkflowDefs();
    h.state.tickets = {
      [GATE_ID]: { ticketId: GATE_ID, workflowId: WF, title: "Merge Approval: Widget", blockedBy: ["TEAM-12"] },
      "TEAM-12": { ticketId: "TEAM-12", assignee: "human:engineer", status: "todo" },
    };

    expect(await loadReviewPackage(workflow("software-delivery"), GATE_ID)).toBeNull();
    expect(h.state.lists).toEqual([]);
  });
});

describe("loadReviewPackage — playbook defs keep the title/zero-blocker fallbacks (TEAM-4159 regression pins)", () => {
  it("Plan Approval blocked by a DEVELOPMENT ticket still reads the PLAN package", async () => {
    // The playbook's Plan Approval gate is afterPhase "development" by design:
    // the plan.md author is a dev, but the package to show the human is the plan
    // one. Here the title MUST outrank the blocker walk.
    await loadWorkflowDefs();
    h.state.tickets = {
      [GATE_ID]: { ticketId: GATE_ID, workflowId: WF, title: "Plan Approval: Widget", blockedBy: [DEV_TICKET.ticketId] },
      [DEV_TICKET.ticketId]: DEV_TICKET,
    };

    await loadReviewPackage(workflow("sdlc-playbook"), GATE_ID);

    expect(soleListPrefix()).toBe(`workflows/${WF}/shared/review-package-plan`);
  });

  it("Intent Acceptance with no blockers reads the INTAKE package", async () => {
    await loadWorkflowDefs();
    h.state.tickets = {
      [GATE_ID]: { ticketId: GATE_ID, workflowId: WF, title: "Intent Acceptance: Widget", blockedBy: [] },
    };

    await loadReviewPackage(workflow("sdlc-playbook"), GATE_ID);

    expect(soleListPrefix()).toBe(`workflows/${WF}/shared/review-package-intake`);
  });

  it("an Intent Acceptance gate that DOES have an agent blocker prefers the walk", async () => {
    // `fallbackReviewPackagePhase` answers "intake" here, which the post-walk
    // re-assertion only restores when the walk found nothing. Pinned so the
    // fix's seed+walk ordering cannot silently start overriding a real phase.
    await loadWorkflowDefs();
    h.state.tickets = {
      [GATE_ID]: { ticketId: GATE_ID, workflowId: WF, title: "Intent Acceptance: Widget", blockedBy: [DESIGN_TICKET.ticketId] },
      [DESIGN_TICKET.ticketId]: DESIGN_TICKET,
    };

    await loadReviewPackage(workflow("sdlc-playbook"), GATE_ID);

    expect(soleListPrefix()).toBe(`workflows/${WF}/shared/review-package-design`);
  });

  it("a zero-blocker gate with a non-matching title still reads INTAKE under a chain def", async () => {
    // The third fallback rule (no blockers at all → "intake"). It is a playbook
    // concept only, which is why case 3 of the non-chain suite is its mirror.
    await loadWorkflowDefs();
    h.state.tickets = {
      [GATE_ID]: { ticketId: GATE_ID, workflowId: WF, title: "Spec Approval: Widget", blockedBy: [] },
    };

    await loadReviewPackage(workflow("sdlc-playbook"), GATE_ID);

    expect(soleListPrefix()).toBe(`workflows/${WF}/shared/review-package-intake`);
  });
});
