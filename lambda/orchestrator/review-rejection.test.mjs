import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-3619 D2c + D4c — the orchestrator side of handleReviewRejection.
 *
 * review-cap.test.mjs pins the cap module's own contract (it publishes
 * review.cap_reached and returns `escalated`). These tests pin the CALLER: that
 * index.mjs actually honors that flag —
 *   1. escalated → short-circuit BEFORE the re-open loop: no ticket is reopened,
 *      and the caller's own review.rejected(capReached:true) fires.
 *   2. not escalated → the re-open path stamps each upstream ticket as a
 *      review_fix routed under the gated phase, so completion re-verify keeps the
 *      run open while the rework is in flight.
 *
 * index.mjs is imported for real; only its I/O seams (AWS SDK, workflow-store,
 * the review-cap factory) are mocked. handleReviewRejection is exported solely
 * so this integration test can drive it.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    workflow: /** @type {any} */ (null),
    updates: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    ebEvents: /** @type {any[]} */ ([]),
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
          if (name === "GetCommand") {
            return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          }
          if (name === "ScanCommand") return { Items: [] }; // findCodingSession → none
          if (name === "UpdateCommand") { h.state.updates.push(cmd.input); return {}; }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          if (name === "QueryCommand") return { Items: [] };
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({ LambdaClient: class {}, InvokeCommand: class { constructor(i) { this.input = i; } } }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  // index.mjs also imports ListObjectsV2Command (loadReviewPackage). Native-ESM
  // strict-linking requires every imported name on the mock; harmless in vitest.
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
  initWorkflowStore: vi.fn(() => {}), // called at index.mjs module load
  getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
  ackNotifications: vi.fn(async () => {}),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
}));

vi.mock("./review-cap.mjs", () => ({
  // getReviewCap() calls createReviewCap({...}); we return a cap whose enforce is
  // per-test controllable. The real cap publishes review.cap_reached itself
  // (covered by review-cap.test.mjs) — here we only need the escalated verdict.
  createReviewCap: () => ({ enforce: (...args) => h.state.enforce(...args) }),
}));

let handleReviewRejection;

const GATE = {
  ticketId: "TEAM-900",
  workflowId: "wf_1",
  parentId: "TEAM-1",
  blockedBy: ["TEAM-10"],
  reviewComment: "please fix the null check",
};

beforeEach(async () => {
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.ebEvents.length = 0;
  // agentcore_hub_api_dev is a "development"-phase agent in the fallback roster.
  h.state.tickets = {
    "TEAM-10": { ticketId: "TEAM-10", assignee: "agentcore_hub_api_dev", type: "task", status: "done" },
  };
  h.state.workflow = { id: "wf_1", workflowDefId: "software-delivery", humanNotifications: [], resumeContexts: {} };
  vi.resetModules();
  ({ handleReviewRejection } = await import("./index.mjs"));
});

// The change-set threading tests below toggle GITHUB_PAT + global.fetch; restore
// both so the fetch-free suites above/around them are unaffected.
const ORIGINAL_FETCH = global.fetch;
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.GITHUB_PAT;
});

describe("handleReviewRejection — cap escalation short-circuit (D2c)", () => {
  it("does NOT reopen any ticket and fires review.rejected(capReached) when the cap escalates", async () => {
    h.state.enforce = vi.fn(async () => ({ escalated: true, effectiveRounds: 3, maxRounds: 3 }));

    await handleReviewRejection(GATE);

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    // Short-circuit BEFORE the re-open loop: no UpdateCommand to any ticket.
    expect(h.state.updates.length).toBe(0);
    const rejected = h.state.events.find((e) => e.type === "review.rejected");
    expect(rejected).toBeTruthy();
    expect(rejected.detail.capReached).toBe(true);
    expect(rejected.detail.reopened).toEqual([]);
  });
});

describe("handleReviewRejection — diff-scoped non-gating rejection (TEAM-3689)", () => {
  it("does NOT reopen and fires review.rejected(noInDiffFindings) when the cap reports gated:false", async () => {
    // A rejection whose findings are all out-of-diff: the cap downgraded it, so
    // enforce returns escalated:false but gated:false — the caller must treat it
    // like the escalation short-circuit and skip the re-open loop.
    h.state.enforce = vi.fn(async () => ({ escalated: false, gated: false, effectiveRounds: 0, maxRounds: 3 }));

    await handleReviewRejection(GATE);

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    // No UpdateCommand → no upstream ticket reopened.
    expect(h.state.updates.length).toBe(0);
    const rejected = h.state.events.find((e) => e.type === "review.rejected");
    expect(rejected).toBeTruthy();
    expect(rejected.detail.noInDiffFindings).toBe(true);
    expect(rejected.detail.reopened).toEqual([]);
    expect(rejected.detail.capReached).toBeUndefined();
  });

  it("still reopens when gated is true (the default the cap returns without change-set data)", async () => {
    h.state.enforce = vi.fn(async () => ({ escalated: false, gated: true }));

    await handleReviewRejection(GATE);

    expect(h.state.updates.length).toBe(1);
    const rejected = h.state.events.find((e) => e.type === "review.rejected");
    expect(rejected.detail.reopened).toEqual(["TEAM-10"]);
    expect(rejected.detail.noInDiffFindings).toBeUndefined();
  });
});

describe("handleReviewRejection — review-fix stamp on reopen (D4c)", () => {
  it("stamps spawnedBy={kind:review_fix,gateTicketId} + phase on the reopened ticket", async () => {
    h.state.enforce = vi.fn(async () => ({ escalated: false }));

    await handleReviewRejection(GATE);

    expect(h.state.updates.length).toBe(1);
    const upd = h.state.updates[0];
    expect(upd.Key.ticketId).toBe("TEAM-10");
    expect(upd.ExpressionAttributeValues[":s"]).toBe("todo");
    expect(upd.ExpressionAttributeValues[":sb"]).toEqual({
      kind: "review_fix",
      gateTicketId: "TEAM-900",
    });
    // gatePhase derived from the upstream agent's roster phase.
    expect(upd.ExpressionAttributeValues[":ph"]).toBe("development");
    // And it advertises the reopen on review.rejected.
    const rejected = h.state.events.find((e) => e.type === "review.rejected");
    expect(rejected.detail.reopened).toEqual(["TEAM-10"]);
  });
});

/**
 * TEAM-3748 D3 (FR-D3.1) — the caller now RESOLVES the change set before calling
 * enforce: the gate's own field wins, else it computes one from the PR's file
 * list, else it passes none (fail-open, byte-identical to the pre-D3 loop). The
 * cap's diff-scoping of that change set is review-cap.test.mjs's job; these pin
 * only what index.mjs hands enforce as `changeSet`.
 */
describe("handleReviewRejection — changeSet threading to the cap (TEAM-3748 D3)", () => {
  const enforceArg = () => h.state.enforce.mock.calls[0][0];

  it("(a) forwards a changeSet carried on the gate ticket straight to enforce — no PR fetch", async () => {
    h.state.enforce = vi.fn(async () => ({ escalated: false }));
    process.env.GITHUB_PAT = "test-pat";
    const fetchSpy = vi.fn(async () => { throw new Error("PR fetch should not run when the gate carries a change set"); });
    global.fetch = fetchSpy;

    await handleReviewRejection({ ...GATE, changeSet: ["src/a.ts", "src/b.ts"] });

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(enforceArg().changeSet).toEqual(["src/a.ts", "src/b.ts"]);
    expect(fetchSpy).not.toHaveBeenCalled(); // the gate field short-circuits the diff computation
  });

  it("(b) computes the changeSet from the PR's files when the gate carries none — a rename contributes BOTH paths", async () => {
    h.state.enforce = vi.fn(async () => ({ escalated: false }));
    process.env.GITHUB_PAT = "test-pat";
    // list_pr_files shape: one added file + one rename carrying previous_filename.
    const files = [
      { filename: "src/new-feature.ts", status: "added" },
      { filename: "src/renamed-new.ts", previous_filename: "src/renamed-old.ts", status: "renamed" },
    ];
    const fetchSpy = vi.fn(async (url) => {
      // GitHub REST for the PR's files, paginated (this PR fits in one page).
      expect(String(url)).toContain("/repos/acme/widgets/pulls/42/files");
      return { ok: true, status: 200, text: async () => JSON.stringify(files) };
    });
    global.fetch = fetchSpy;

    await handleReviewRejection({ ...GATE, prUrl: "https://github.com/acme/widgets/pull/42" });

    expect(fetchSpy).toHaveBeenCalledTimes(1); // 2 files (<100) → a single page
    // The rename's new AND previous path are both in-diff, matching
    // enforceDiffScope's rename handling.
    expect(enforceArg().changeSet).toEqual([
      "src/new-feature.ts",
      "src/renamed-new.ts",
      "src/renamed-old.ts",
    ]);
  });

  it("(c) fails open on a GitHub error — enforce is called with changeSet absent, reopen proceeds as legacy", async () => {
    h.state.enforce = vi.fn(async () => ({ escalated: false }));
    process.env.GITHUB_PAT = "test-pat";
    global.fetch = vi.fn(async () => ({ ok: false, status: 502, text: async () => "bad gateway" }));

    await handleReviewRejection({ ...GATE, prUrl: "https://github.com/acme/widgets/pull/42" });

    // computeReviewChangeSet swallowed the error and returned null → the diff-scoped
    // gate stays inert and the rejection re-opens exactly as before it existed.
    expect(enforceArg().changeSet).toBeNull();
    expect(h.state.updates.length).toBe(1);
    expect(h.state.events.find((e) => e.type === "review.rejected").detail.reopened).toEqual(["TEAM-10"]);
  });

  it("(c) fails open when no PR url is resolvable — no fetch, changeSet absent, reopen proceeds", async () => {
    h.state.enforce = vi.fn(async () => ({ escalated: false }));
    process.env.GITHUB_PAT = "test-pat";
    const fetchSpy = vi.fn(async () => { throw new Error("no PR to fetch"); });
    global.fetch = fetchSpy;

    await handleReviewRejection(GATE); // no prUrl on the gate, no task-entry PRs

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(enforceArg().changeSet).toBeNull();
    expect(h.state.updates.length).toBe(1); // legacy reopen
  });
});
