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
    // S3 objects by key — readS3Artifact(workflowId, path) reads
    // workflows/{id}/{path}; used by the F1 findings-derivation tests.
    s3Objects: /** @type {Record<string, string>} */ ({}),
    // TEAM-3765 F4: transient-failure injection for the advisory auto-approval
    // transition. failGateDone = how many gate done-writes to throw before
    // letting one land; gateDoneAttempts = every attempt (thrown or not).
    failGateDone: 0,
    gateDoneAttempts: 0,
    // TEAM-3790: when true, the gate done-write throws
    // ConditionalCheckFailedException — a concurrent transition moved the gate
    // out of blocked/in_review, so the conditional write loses.
    conditionFailGateDone: false,
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
          if (name === "UpdateCommand") {
            // TEAM-3765 F4: let a test inject transient failures on the gate's
            // done-approval write (Key TEAM-900, :s === "done") to exercise the
            // bounded-retry / escalation path. Every attempt is counted; a
            // remaining `failGateDone` budget throws before the write records.
            const isGateDone =
              cmd.input.Key?.ticketId === "TEAM-900" &&
              cmd.input.ExpressionAttributeValues?.[":s"] === "done";
            if (isGateDone) {
              h.state.gateDoneAttempts++;
              // TEAM-3790: simulate a concurrent transition winning — DynamoDB
              // rejects the conditioned write.
              if (h.state.conditionFailGateDone) {
                const e = new Error("The conditional request failed");
                e.name = "ConditionalCheckFailedException";
                throw e;
              }
              if (h.state.failGateDone > 0) {
                h.state.failGateDone--;
                throw new Error("transient DDB failure");
              }
            }
            h.state.updates.push(cmd.input);
            return {};
          }
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
  // GetObject serves h.state.s3Objects by key (the F1 findings derivation reads
  // shared/ship-review-state.json through readS3Artifact); a missing key throws,
  // which readS3Artifact swallows into null — the real NoSuchKey shape.
  S3Client: class {
    async send(cmd) {
      if (cmd.constructor.name === "GetObjectCommand") {
        const body = h.state.s3Objects[cmd.input.Key];
        if (body === undefined) throw new Error("NoSuchKey");
        return { Body: { transformToString: async () => body } };
      }
      return {};
    }
  },
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

vi.mock("./review-cap.mjs", async () => {
  // TEAM-3966 F1: index.mjs imports the REAL parseDecision for the human's
  // DECISION: continue override — keep the genuine fail-closed parser.
  const actual = await vi.importActual("./review-cap.mjs");
  return {
    parseDecision: actual.parseDecision,
    // getReviewCap() calls createReviewCap({...}); we return a cap whose enforce is
    // per-test controllable. The real cap publishes review.cap_reached itself
    // (covered by review-cap.test.mjs) — here we only need the escalated verdict.
    createReviewCap: () => ({ enforce: (...args) => h.state.enforce(...args) }),
  };
});

let handleReviewRejection;
let handler;

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
  h.state.s3Objects = {};
  h.state.failGateDone = 0;
  h.state.gateDoneAttempts = 0;
  h.state.conditionFailGateDone = false;
  // TEAM-3765 F4: zero backoff so the bounded auto-approve retry is instant.
  process.env.ADVISORY_APPROVE_BACKOFF_MS = "0";
  // agentcore_hub_api_dev is a "development"-phase agent in the fallback roster.
  h.state.tickets = {
    "TEAM-10": { ticketId: "TEAM-10", assignee: "agentcore_hub_api_dev", type: "task", status: "done" },
  };
  h.state.workflow = { id: "wf_1", workflowDefId: "software-delivery", humanNotifications: [], resumeContexts: {} };
  // Set BEFORE the import — index.mjs snapshots it at module load. Needed so
  // readS3Artifact (the F1 ledger derivation) actually hits the S3 mock.
  process.env.ARTIFACT_BUCKET = "test-bucket";
  vi.resetModules();
  ({ handleReviewRejection, handler } = await import("./index.mjs"));
});

// The change-set threading tests below toggle GITHUB_PAT + global.fetch; restore
// both so the fetch-free suites above/around them are unaffected.
const ORIGINAL_FETCH = global.fetch;
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.GITHUB_PAT;
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.ADVISORY_APPROVE_BACKOFF_MS;
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

describe("handleReviewRejection — diff-scoped non-gating rejection (TEAM-3689 + TEAM-3756 F3b)", () => {
  it("does NOT reopen; auto-approves the gate with known findings so the run has a defined next state", async () => {
    // A rejection whose findings are all out-of-diff: the cap downgraded it, so
    // enforce returns escalated:false but gated:false — the caller must skip the
    // re-open loop AND (F3b) resolve the gate. Before, it published the event
    // and returned, leaving the gate parked in `blocked` with nothing scheduled
    // to touch it again — a silent stall.
    h.state.enforce = vi.fn(async () => ({ escalated: false, gated: false, effectiveRounds: 0, maxRounds: 3 }));
    // TEAM-3966 F5: the auto-approve path requires STRUCTURED findings, and the
    // only structured source is the release manager's S3 ledger round (read via
    // deriveReviewFindings, which runs when the gate has a change set).
    h.state.s3Objects["workflows/wf_1/shared/ship-review-state.json"] = JSON.stringify({
      rounds: [{ round: 1, verdict: "CHANGES-NEEDED", findings: [{ severity: "P2", citedFiles: ["vendor/untouched.ts"] }] }],
    });

    await handleReviewRejection({ ...GATE, changeSet: ["src/parser.ts"] });

    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    // No write touches the upstream ticket — the reopen stays suppressed.
    expect(h.state.updates.filter((u) => u.Key.ticketId === "TEAM-10")).toHaveLength(0);
    // F3b: the gate itself is transitioned done (approval-with-known-findings),
    // the same path a human approval takes, so the done cascade continues the run.
    const gateDone = h.state.updates.filter(
      (u) => u.Key.ticketId === "TEAM-900" && u.ExpressionAttributeValues?.[":s"] === "done"
    );
    expect(gateDone).toHaveLength(1);
    // The advisory findings land on the ticket as an audit comment...
    const comments = h.state.updates.filter(
      (u) => u.Key.ticketId === "TEAM-900" && String(u.UpdateExpression).includes("list_append")
    );
    expect(comments).toHaveLength(1);
    expect(comments[0].ExpressionAttributeValues[":n"][0].content).toContain("vendor/untouched.ts");
    // ...and the distinct approval event carries them too.
    const approved = h.state.events.find((e) => e.type === "review.approved_with_advisory");
    expect(approved).toBeTruthy();
    expect(approved.detail.advisoryFindings).toEqual([{ severity: "P2", citedFiles: ["vendor/untouched.ts"] }]);
    // The legacy observability event is preserved unchanged.
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

/**
 * TEAM-3765 F4 — a failed advisory auto-approval must NOT be swallowed. The
 * transition (DDB done-write / Jira "Done") is the only exit from `blocked` for
 * an all-advisory gate; before this fix a transient failure was logged, then
 * review.rejected was published and the command acked as success anyway —
 * leaving the gate stuck in `blocked` forever. The fix bounds-retries the
 * transition and, on exhaustion, emits an OBSERVABLE escalation event instead of
 * the silent success+rejected path, leaving the gate blocked for the reconcile
 * sweep / a human to recover. The transition stays idempotent — we stop at the
 * first observed success, so a retry after a partial failure cannot double-approve.
 *
 * These tests drive the DDB path (TICKET_PROVIDER defaults to dynamodb), where
 * the transition is the gate's status→done UpdateCommand.
 */
describe("handleReviewRejection — advisory auto-approval failure is not swallowed (TEAM-3765 F4)", () => {
  // The all-advisory verdict: escalated:false + gated:false → the auto-approve branch.
  const advisoryEnforce = () => vi.fn(async () => ({ escalated: false, gated: false }));
  // TEAM-3966 F5: structured findings come ONLY from the RM's S3 ledger round;
  // the change set on the gate makes deriveReviewFindings read it.
  const ADVISORY_GATE = { ...GATE, changeSet: ["src/parser.ts"] };
  beforeEach(() => {
    h.state.s3Objects["workflows/wf_1/shared/ship-review-state.json"] = JSON.stringify({
      rounds: [{ round: 1, verdict: "CHANGES-NEEDED", findings: [{ severity: "P2", citedFiles: ["vendor/untouched.ts"] }] }],
    });
  });
  const gateDoneWrites = () =>
    h.state.updates.filter(
      (u) => u.Key.ticketId === "TEAM-900" && u.ExpressionAttributeValues?.[":s"] === "done"
    );

  it("transition keeps failing → escalates observably, NOT the silent success+review.rejected path", async () => {
    h.state.enforce = advisoryEnforce();
    h.state.failGateDone = 99; // every done-write throws → retry is exhausted

    await handleReviewRejection(ADVISORY_GATE);

    // Bounded retry was actually attempted (3 attempts, no infinite spin).
    expect(h.state.gateDoneAttempts).toBe(3);
    // The gate was NEVER marked done — no successful transition landed.
    expect(gateDoneWrites()).toHaveLength(0);
    // The observable recovery signal fired...
    const escalated = h.state.events.find((e) => e.type === "review.escalated");
    expect(escalated).toBeTruthy();
    expect(escalated.detail.reason).toBe("advisory_auto_approve_failed");
    expect(escalated.detail.attempts).toBe(3);
    // ...and it is NOT the buggy silent success path: no approval, no
    // review.rejected acking the gate as resolved.
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeUndefined();
    expect(h.state.events.find((e) => e.type === "review.rejected")).toBeUndefined();
  });

  it("happy path unchanged: transition lands first try → approve+advisory events, no escalation", async () => {
    h.state.enforce = advisoryEnforce();
    // failGateDone stays 0 → the first attempt succeeds.

    await handleReviewRejection(ADVISORY_GATE);

    expect(h.state.gateDoneAttempts).toBe(1);       // single attempt, byte-identical
    expect(gateDoneWrites()).toHaveLength(1);        // approved once
    const approved = h.state.events.find((e) => e.type === "review.approved_with_advisory");
    expect(approved).toBeTruthy();
    expect(approved.detail.advisoryFindings).toEqual([{ severity: "P2", citedFiles: ["vendor/untouched.ts"] }]);
    const rejected = h.state.events.find((e) => e.type === "review.rejected");
    expect(rejected.detail.noInDiffFindings).toBe(true);
    expect(h.state.events.find((e) => e.type === "review.escalated")).toBeUndefined();
  });

  it("retry stays CAS-idempotent: fails twice then succeeds → exactly one approval, no double-approve", async () => {
    h.state.enforce = advisoryEnforce();
    h.state.failGateDone = 2; // two transient failures, then the write lands

    await handleReviewRejection(ADVISORY_GATE);

    expect(h.state.gateDoneAttempts).toBe(3);        // 2 failures + 1 success
    // Idempotency: only ONE done-write landed — the retry after partial failure
    // did not double-approve the gate.
    expect(gateDoneWrites()).toHaveLength(1);
    const approvals = h.state.events.filter((e) => e.type === "review.approved_with_advisory");
    expect(approvals).toHaveLength(1);
    expect(h.state.events.filter((e) => e.type === "review.rejected")).toHaveLength(1);
    expect(h.state.events.find((e) => e.type === "review.escalated")).toBeUndefined();
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

/**
 * TEAM-3756 F2 — resolvePrUrlForReview only names a PR it can be CONFIDENT is
 * the one under review: the gate's own field, a head-SHA match, or the (single)
 * ship-phase ticket's integration PR. The old "any task's prUrl" guess is gone —
 * a stale feature-PR url on a dev task must never pick the diff a ship review is
 * scoped against (wrong diff → genuine findings classify out-of-diff → reopen
 * suppressed). No confident match FAILS OPEN: null changeSet, gate inert.
 */
describe("resolvePrUrlForReview — confident matches only (TEAM-3756 F2)", () => {
  const enforceArg = () => h.state.enforce.mock.calls[0][0];
  const fetchedUrls = (fetchSpy) => fetchSpy.mock.calls.map((c) => String(c[0]));
  const prFilesPage = (files) => async (url) => ({
    ok: true, status: 200, text: async () => JSON.stringify(files),
  });

  beforeEach(() => {
    h.state.enforce = vi.fn(async () => ({ escalated: false }));
    process.env.GITHUB_PAT = "test-pat";
  });

  it("a dev task's stale prUrl is NOT used (the removed any-task guess) — fail-open, legacy reopen", async () => {
    // The upstream dev task carries a leftover per-ticket feature-PR url. Old
    // behavior fetched it and scoped the ship review against the WRONG diff.
    h.state.workflow.agentTasks = {
      "TEAM-10": { agentId: "agentcore_hub_api_dev", prUrl: "https://github.com/acme/widgets/pull/7" },
    };
    const fetchSpy = vi.fn(async () => { throw new Error("must not fetch the stale dev PR"); });
    global.fetch = fetchSpy;

    await handleReviewRejection(GATE);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(enforceArg().changeSet).toBeNull(); // fail-open: unscoped, everything gates
    expect(h.state.updates.length).toBe(1);    // legacy reopen proceeds
  });

  it("a task entry whose commitSha matches the gate's reviewedHeadSha wins — that PR IS what was reviewed", async () => {
    h.state.workflow.agentTasks = {
      "TEAM-10": { agentId: "agentcore_hub_api_dev", prUrl: "https://github.com/acme/widgets/pull/7", commitSha: "stale000" },
      "TEAM-20": { agentId: "agentcore_hub_api_dev", prUrl: "https://github.com/acme/widgets/pull/42", commitSha: "abc123" },
    };
    const fetchSpy = vi.fn(prFilesPage([{ filename: "src/a.ts" }]));
    global.fetch = fetchSpy;

    await handleReviewRejection({ ...GATE, reviewedHeadSha: "abc123" });

    expect(fetchedUrls(fetchSpy)[0]).toContain("/repos/acme/widgets/pulls/42/files");
    expect(enforceArg().changeSet).toEqual(["src/a.ts"]);
  });

  it("the ship-phase ticket's integration PR wins over a dev task's PR when no SHA is known", async () => {
    h.state.workflow.agentTasks = {
      "TEAM-10": { agentId: "agentcore_hub_api_dev", prUrl: "https://github.com/acme/widgets/pull/7" },
      "TEAM-30": { agentId: "agentcore_hub_release_manager", prUrl: "https://github.com/acme/widgets/pull/99" },
    };
    const fetchSpy = vi.fn(prFilesPage([{ filename: "src/b.ts" }]));
    global.fetch = fetchSpy;

    await handleReviewRejection(GATE);

    expect(fetchedUrls(fetchSpy)[0]).toContain("/repos/acme/widgets/pulls/99/files");
    expect(enforceArg().changeSet).toEqual(["src/b.ts"]);
  });

  it("TWO distinct ship-phase PRs and no SHA → ambiguous → no fetch, fail-open", async () => {
    h.state.workflow.agentTasks = {
      "TEAM-30": { agentId: "agentcore_hub_release_manager", prUrl: "https://github.com/acme/widgets/pull/99" },
      "TEAM-31": { agentId: "agentcore_hub_release_manager", prUrl: "https://github.com/acme/widgets/pull/100" },
    };
    const fetchSpy = vi.fn(async () => { throw new Error("ambiguous — must not guess"); });
    global.fetch = fetchSpy;

    await handleReviewRejection(GATE);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(enforceArg().changeSet).toBeNull();
    expect(h.state.updates.length).toBe(1); // still fail-open: legacy reopen
  });

  it("the gate ticket's own prUrl still beats everything", async () => {
    h.state.workflow.agentTasks = {
      "TEAM-30": { agentId: "agentcore_hub_release_manager", prUrl: "https://github.com/acme/widgets/pull/99" },
    };
    const fetchSpy = vi.fn(prFilesPage([{ filename: "src/c.ts" }]));
    global.fetch = fetchSpy;

    await handleReviewRejection({ ...GATE, prUrl: "https://github.com/acme/widgets/pull/42" });

    expect(fetchedUrls(fetchSpy)[0]).toContain("/repos/acme/widgets/pulls/42/files");
  });
});

/**
 * TEAM-3756 F1 — the classified findings are DERIVED in the Lambda when the gate
 * ticket does not carry them (nothing in production ever wrote
 * gateTicket.reviewFindings, so `gated` was always true and the diff-scoped gate
 * was inert). Sources: a JSON block in the rejection feedback, then the release
 * manager's recorded round in shared/ship-review-state.json. These pin what
 * index.mjs hands enforce as `findings`; the cap's use of them is
 * review-cap.test.mjs's job.
 */
describe("handleReviewRejection — findings derivation (TEAM-3756 F1)", () => {
  const enforceArg = () => h.state.enforce.mock.calls[0][0];
  // Derivation only runs when a change set exists to scope against; carry one on
  // the gate so no PR fetch is involved.
  const GATE_WITH_DIFF = { ...GATE, changeSet: ["src/parser.ts"] };
  const LEDGER_KEY = "workflows/wf_1/shared/ship-review-state.json";

  beforeEach(() => {
    h.state.enforce = vi.fn(async () => ({ escalated: false }));
  });

  it("parses a ```json findings block out of the rejection feedback", async () => {
    await handleReviewRejection({
      ...GATE_WITH_DIFF,
      reviewComment:
        "Round 2: the parser seam is still broken.\n" +
        '```json\n{"findings":[{"severity":"P1","citedFiles":["src/parser.ts"]}]}\n```',
    });

    expect(enforceArg().findings).toEqual([{ severity: "P1", citedFiles: ["src/parser.ts"] }]);
  });

  it("falls back to the release manager's recorded round (ship-review-state.json)", async () => {
    h.state.s3Objects[LEDGER_KEY] = JSON.stringify({
      rounds: [
        { round: 1, verdict: "CHANGES-NEEDED", findings: [{ citedFiles: ["old/round1.ts"] }] },
        { round: 2, verdict: "CHANGES-NEEDED", findings: [{ citedFiles: ["src/parser.ts"] }] },
      ],
    });

    await handleReviewRejection(GATE_WITH_DIFF);

    // The LATEST round's findings, not round 1's.
    expect(enforceArg().findings).toEqual([{ citedFiles: ["src/parser.ts"] }]);
  });

  it("a ledger whose latest round SHA contradicts the gate's reviewedHeadSha is NOT trusted", async () => {
    h.state.s3Objects[LEDGER_KEY] = JSON.stringify({
      rounds: [{ round: 1, verdict: "CHANGES-NEEDED", reviewedHeadSha: "other999", findings: [{ citedFiles: ["src/parser.ts"] }] }],
    });

    await handleReviewRejection({ ...GATE_WITH_DIFF, reviewedHeadSha: "abc123" });

    expect(enforceArg().findings).toBeNull(); // stale ledger → derive nothing → gate inert
  });

  it("prose-only findings (nobody cited a file) are NOT usable — deriving them would suppress every reopen", async () => {
    h.state.s3Objects[LEDGER_KEY] = JSON.stringify({
      rounds: [{ round: 1, verdict: "CHANGES-NEEDED", findings: [{ note: "please be better" }] }],
    });

    await handleReviewRejection(GATE_WITH_DIFF);

    expect(enforceArg().findings).toBeNull();
  });

  it("no structured source at all → findings null, byte-identical legacy behavior", async () => {
    await handleReviewRejection(GATE_WITH_DIFF);

    expect(enforceArg().findings).toBeNull();
    expect(h.state.updates.length).toBe(1); // reopen exactly as before
  });

  it("gate-ticket reviewFindings still win over derivation", async () => {
    h.state.s3Objects[LEDGER_KEY] = JSON.stringify({
      rounds: [{ round: 1, verdict: "CHANGES-NEEDED", findings: [{ citedFiles: ["from/ledger.ts"] }] }],
    });

    await handleReviewRejection({
      ...GATE_WITH_DIFF,
      reviewFindings: [{ citedFiles: ["from/ticket.ts"] }],
    });

    expect(enforceArg().findings).toEqual([{ citedFiles: ["from/ticket.ts"] }]);
  });

  it("no change set → derivation is skipped entirely (the findings would never be read)", async () => {
    h.state.s3Objects[LEDGER_KEY] = JSON.stringify({
      rounds: [{ round: 1, verdict: "CHANGES-NEEDED", findings: [{ citedFiles: ["src/parser.ts"] }] }],
    });

    await handleReviewRejection(GATE); // no changeSet anywhere, no PR url

    expect(enforceArg().findings).toBeNull();
  });
});

/**
 * TEAM-3790 — gate integrity: the advisory auto-approve must never override a
 * human's rejection, must never run off prose-derived findings, and must never
 * blind-write over a concurrent transition.
 *
 *   (a) HUMAN-ORIGIN rejection (the gate carries the uniform human-review
 *       markers from PR #216 — assignee "human:*" and/or "human-review"/
 *       "reviewer:*" labels) → NEVER auto-approve: the gate is parked where the
 *       rejection left it and a comment asks the human to confirm or reply
 *       DECISION: continue. The human keeps authority.
 *   (b) RM-origin rejection carrying the machine-written STRUCTURED
 *       reviewFindings payload → auto-approve still works, and the done-flip is
 *       now CONDITIONED on the gate still being in blocked/in_review.
 *       Prose-derived findings (fenced JSON parsed out of comment text) are
 *       not usable for auto-approval → park.
 *   (c) The conditional write LOSES to a concurrent transition
 *       (ConditionalCheckFailedException) → no overwrite, exactly one attempt,
 *       handled (logged) — never retried, never rethrown, never escalated.
 */
describe("handleReviewRejection — human authority over advisory auto-approve (TEAM-3790)", () => {
  const advisoryEnforce = () => vi.fn(async () => ({ escalated: false, gated: false }));
  const STRUCTURED_FINDINGS = [{ severity: "P2", citedFiles: ["vendor/untouched.ts"] }];
  const gateDoneWrites = () =>
    h.state.updates.filter(
      (u) => u.Key.ticketId === "TEAM-900" && u.ExpressionAttributeValues?.[":s"] === "done"
    );
  const gateComments = () =>
    h.state.updates.filter(
      (u) => u.Key.ticketId === "TEAM-900" && String(u.UpdateExpression).includes("list_append")
    );

  it("(a) human-origin rejection (human:* assignee) with all-advisory findings → parked + confirm comment, NOT done", async () => {
    h.state.enforce = advisoryEnforce();

    await handleReviewRejection({
      ...GATE,
      assignee: "human:engineer",
      reviewFindings: STRUCTURED_FINDINGS,
    });

    // The gate is NEVER transitioned — it stays blocked, the human keeps authority.
    expect(gateDoneWrites()).toHaveLength(0);
    expect(h.state.gateDoneAttempts).toBe(0);
    // Upstream work is not reopened either (the findings are all out-of-diff).
    expect(h.state.updates.filter((u) => u.Key.ticketId === "TEAM-10")).toHaveLength(0);
    // The human is asked to confirm — with the exact way forward.
    const comments = gateComments();
    expect(comments).toHaveLength(1);
    expect(comments[0].ExpressionAttributeValues[":n"][0].content).toContain(
      "approve the gate to confirm"
    );
    // Observable park, not a silent stall — and NOT any of the resolution events.
    const parked = h.state.events.find((e) => e.type === "review.parked_advisory");
    expect(parked).toBeTruthy();
    expect(parked.detail.reason).toBe("human_origin_rejection");
    expect(parked.detail.advisoryFindings).toEqual(STRUCTURED_FINDINGS);
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeUndefined();
    expect(h.state.events.find((e) => e.type === "review.rejected")).toBeUndefined();
  });

  it("(a) human-origin via the PR #216 labels alone (human-review / reviewer:*) is parked the same way", async () => {
    h.state.enforce = advisoryEnforce();

    await handleReviewRejection({
      ...GATE,
      labels: ["human-review", "reviewer:qa-lead"],
      reviewFindings: STRUCTURED_FINDINGS,
    });

    expect(gateDoneWrites()).toHaveLength(0);
    expect(h.state.events.find((e) => e.type === "review.parked_advisory")?.detail.reason).toBe(
      "human_origin_rejection"
    );
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeUndefined();
  });

  // TEAM-3966 F5: the ONLY structured source is the release manager's S3 ledger
  // round, read through deriveReviewFindings. These helpers feed it that way.
  const LEDGER_KEY = "workflows/wf_1/shared/ship-review-state.json";
  const structuredLedger = () => {
    h.state.s3Objects[LEDGER_KEY] = JSON.stringify({
      rounds: [{ round: 1, verdict: "CHANGES-NEEDED", findings: STRUCTURED_FINDINGS }],
    });
  };
  // A change set on the gate makes derivation run without a PR fetch.
  const RM_GATE = { ...GATE, changeSet: ["src/parser.ts"] };

  it("(b) RM-origin with the machine-written structured payload still auto-approves — via a CONDITIONED write", async () => {
    h.state.enforce = advisoryEnforce();
    structuredLedger();

    // No human-review markers: this rejection is the release manager's own
    // verdict delivery; the structured findings come from its S3 ledger round.
    await handleReviewRejection(RM_GATE);

    const done = gateDoneWrites();
    expect(done).toHaveLength(1);
    // TEAM-3790 + TEAM-3966 F3: the flip to done only lands when the gate is
    // still exactly where the rejection left it — `blocked`, nothing else.
    expect(done[0].ConditionExpression).toBe("#s = :expectBlocked");
    expect(done[0].ExpressionAttributeValues[":expectBlocked"]).toBe("blocked");
    expect(done[0].ExpressionAttributeValues[":expectInReview"]).toBeUndefined();
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeTruthy();
    expect(h.state.events.find((e) => e.type === "review.parked_advisory")).toBeUndefined();
  });

  it("(b) prose-derived findings (fenced JSON in the comment) are NOT usable for auto-approval → parked", async () => {
    h.state.enforce = advisoryEnforce();

    // No findings on the gate ticket — they get DERIVED from the rejection
    // comment's fenced JSON, i.e. prose provenance. A misparse here must never
    // close the gate.
    await handleReviewRejection({
      ...GATE,
      changeSet: ["src/parser.ts"],
      reviewComment:
        "Concerns about legacy helpers.\n" +
        '```json\n{"findings":[{"severity":"P2","citedFiles":["vendor/untouched.ts"]}]}\n```',
    });

    expect(gateDoneWrites()).toHaveLength(0);
    const parked = h.state.events.find((e) => e.type === "review.parked_advisory");
    expect(parked).toBeTruthy();
    expect(parked.detail.reason).toBe("prose_derived_findings");
    expect(gateComments().some((c) =>
      String(c.ExpressionAttributeValues[":n"][0].content).includes("approve the gate to confirm")
    )).toBe(true);
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeUndefined();
  });

  it("(c) conditional write loses to a concurrent transition → no overwrite, ONE attempt, no retry, no rethrow, no escalation", async () => {
    h.state.enforce = advisoryEnforce();
    h.state.conditionFailGateDone = true; // a concurrent human transition won the race
    structuredLedger();

    // Must resolve, not throw — a rethrow would trigger event-source retries
    // that re-race the human.
    await expect(handleReviewRejection(RM_GATE)).resolves.toBeUndefined();

    // Exactly ONE attempt: a failed condition is authority, not a transient error.
    expect(h.state.gateDoneAttempts).toBe(1);
    // Nothing landed: the concurrent transition's state stands.
    expect(gateDoneWrites()).toHaveLength(0);
    // And none of the resolution/escalation events fired — the gate is wherever
    // the concurrent actor put it; there is nothing to approve or escalate.
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeUndefined();
    expect(h.state.events.find((e) => e.type === "review.escalated")).toBeUndefined();
    expect(h.state.events.find((e) => e.type === "review.rejected")).toBeUndefined();
  });
});

/**
 * TEAM-3966 — adversarial-review follow-ups on the TEAM-3790 gate-integrity fix.
 *
 *   F1  A human-origin rejection whose feedback carries a well-formed
 *       `DECISION: continue` line is GATING even when every finding is
 *       out-of-diff: the normal reopen-upstream path runs, no park. Any other
 *       (or malformed) DECISION is not an override — fail closed.
 *   F4  The park is idempotent across redelivery: a gate that already carries
 *       the orchestrator's marked park comment gets no second comment and no
 *       second review.parked_advisory.
 *   F5  Findings already on the gate ticket (a field nothing in the repo
 *       writes) are NOT structured provenance — an RM-origin rejection that
 *       relies on them parks instead of flipping the gate.
 */
describe("handleReviewRejection — human DECISION: continue overrides the advisory park (TEAM-3966 F1)", () => {
  const advisoryEnforce = () => vi.fn(async () => ({ escalated: false, gated: false }));
  const ADVISORY = [{ severity: "P2", citedFiles: ["vendor/untouched.ts"] }];
  const HUMAN_GATE = { ...GATE, assignee: "human:engineer", reviewFindings: ADVISORY };
  const reopens = () =>
    h.state.updates.filter((u) => u.Key.ticketId === "TEAM-10" && u.ExpressionAttributeValues?.[":s"] === "todo");
  const gateWrites = () => h.state.updates.filter((u) => u.Key.ticketId === "TEAM-900");

  it("human-origin + all-advisory + feedback with DECISION: continue → upstream reopened, NO park comment, NO parked event", async () => {
    h.state.enforce = advisoryEnforce();

    await handleReviewRejection({
      ...HUMAN_GATE,
      reviewComment: "I still want this reworked despite the diff scope.\nDECISION: continue",
    });

    // The normal rework path ran: the upstream dev ticket is reopened with the
    // human's feedback as resume context.
    expect(reopens()).toHaveLength(1);
    expect(reopens()[0].ExpressionAttributeValues[":sb"]).toMatchObject({ gateTicketId: "TEAM-900", kind: "review_fix" });
    // Nothing touched the gate itself: no park comment, no done flip.
    expect(gateWrites()).toHaveLength(0);
    expect(h.state.events.find((e) => e.type === "review.parked_advisory")).toBeUndefined();
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeUndefined();
    const rejected = h.state.events.find((e) => e.type === "review.rejected");
    expect(rejected).toBeTruthy();
    expect(rejected.detail.reopened).toEqual(["TEAM-10"]);
  });

  it("the DECISION line is read from the latest comment when no reviewComment is persisted", async () => {
    h.state.enforce = advisoryEnforce();
    const { reviewComment: _drop, ...noReviewComment } = HUMAN_GATE;

    await handleReviewRejection({
      ...noReviewComment,
      comments: [
        { author: "orchestrator", content: "[orchestrator:parked-advisory] earlier park" },
        { author: "engineer", content: "Re-rejecting.\n\nDECISION: continue" },
      ],
    });

    expect(reopens()).toHaveLength(1);
    expect(h.state.events.find((e) => e.type === "review.parked_advisory")).toBeUndefined();
  });

  it("a DECISION other than continue (merge-with-known-findings) is NOT an override → still parked", async () => {
    h.state.enforce = advisoryEnforce();

    await handleReviewRejection({
      ...HUMAN_GATE,
      reviewComment: "Fine, ship it.\nDECISION: merge-with-known-findings",
    });

    expect(reopens()).toHaveLength(0);
    const parked = h.state.events.find((e) => e.type === "review.parked_advisory");
    expect(parked).toBeTruthy();
    expect(parked.detail.reason).toBe("human_origin_rejection");
  });

  it("a DECISION buried mid-sentence is not well-formed → fail closed, still parked", async () => {
    h.state.enforce = advisoryEnforce();

    await handleReviewRejection({
      ...HUMAN_GATE,
      reviewComment: "I guess DECISION: continue would be the thing to say here, but I'm unsure.",
    });

    expect(reopens()).toHaveLength(0);
    expect(h.state.events.find((e) => e.type === "review.parked_advisory")).toBeTruthy();
  });
});

describe("handleReviewRejection — advisory park is idempotent across redelivery (TEAM-3966 F4)", () => {
  const advisoryEnforce = () => vi.fn(async () => ({ escalated: false, gated: false }));
  const ADVISORY = [{ severity: "P2", citedFiles: ["vendor/untouched.ts"] }];
  const HUMAN_GATE = { ...GATE, assignee: "human:engineer", reviewFindings: ADVISORY };
  const gateComments = () =>
    h.state.updates.filter(
      (u) => u.Key.ticketId === "TEAM-900" && String(u.UpdateExpression).includes("list_append")
    );

  it("first delivery: the park comment carries the stable marker", async () => {
    h.state.enforce = advisoryEnforce();

    await handleReviewRejection(HUMAN_GATE);

    const comments = gateComments();
    expect(comments).toHaveLength(1);
    expect(comments[0].ExpressionAttributeValues[":n"][0].content).toContain("[orchestrator:parked-advisory]");
    expect(h.state.events.filter((e) => e.type === "review.parked_advisory")).toHaveLength(1);
  });

  it("redelivery: the gate already carries the orchestrator's park comment → zero new comments, zero events", async () => {
    h.state.enforce = advisoryEnforce();

    await handleReviewRejection({
      ...HUMAN_GATE,
      comments: [
        { author: "engineer", content: "please fix the null check" },
        {
          author: "orchestrator",
          content: "[orchestrator:parked-advisory] All findings appear out-of-diff for this fix — approve the gate to confirm ...",
        },
      ],
    });

    expect(gateComments()).toHaveLength(0);
    expect(h.state.events).toHaveLength(0);
    expect(h.state.ebEvents).toHaveLength(0);
    // And still nothing else moved: no reopen, no flip.
    expect(h.state.updates).toHaveLength(0);
  });
});

describe("handleReviewRejection — ticket-carried reviewFindings are NOT structured provenance (TEAM-3966 F5)", () => {
  const advisoryEnforce = () => vi.fn(async () => ({ escalated: false, gated: false }));
  const FINDINGS = [{ severity: "P2", citedFiles: ["vendor/untouched.ts"] }];
  const gateDoneWrites = () =>
    h.state.updates.filter(
      (u) => u.Key.ticketId === "TEAM-900" && u.ExpressionAttributeValues?.[":s"] === "done"
    );

  it("RM-origin gate with gateTicket.reviewFindings set (no writer exists) → parked as non_structured_findings, no flip", async () => {
    h.state.enforce = advisoryEnforce();

    // No human markers, no S3 ledger — the ONLY findings are on the ticket.
    await handleReviewRejection({ ...GATE, reviewFindings: FINDINGS });

    // Still fed to the cap for diff-scoping (that is what decided gated:false)...
    expect(h.state.enforce.mock.calls[0][0].findings).toEqual(FINDINGS);
    // ...but never authority for a flip.
    expect(gateDoneWrites()).toHaveLength(0);
    expect(h.state.gateDoneAttempts).toBe(0);
    const parked = h.state.events.find((e) => e.type === "review.parked_advisory");
    expect(parked).toBeTruthy();
    expect(parked.detail.reason).toBe("non_structured_findings");
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeUndefined();
  });
});

/**
 * TEAM-3966 F2 — the Jira-provider done-flip has the same pre-state guard as the
 * DDB ConditionExpression: re-read the gate right before transitioning and stop
 * (no retry / rethrow / escalation) unless it is still `blocked`.
 *
 * index.mjs snapshots TICKET_PROVIDER at module load, so this suite re-imports
 * in Jira mode and routes jiraFetch's global.fetch by URL.
 */
describe("handleReviewRejection — Jira-provider pre-state guard on the done-flip (TEAM-3966 F2)", () => {
  const advisoryEnforce = () => vi.fn(async () => ({ escalated: false, gated: false }));
  const STRUCTURED_FINDINGS = [{ severity: "P2", citedFiles: ["vendor/untouched.ts"] }];
  const LEDGER_KEY = "workflows/wf_1/shared/ship-review-state.json";
  const RM_GATE = { ...GATE, changeSet: ["src/parser.ts"] };

  const jiraIssue = (key, { status = "Blocked", labels = [], blockedBy = [], comments = [] } = {}) => ({
    key,
    fields: {
      summary: key,
      status: { name: status },
      labels,
      issuetype: { name: "Task" },
      parent: { key: "TEAM-1" },
      issuelinks: blockedBy.map((k) => ({ type: { inward: "is blocked by" }, inwardIssue: { key: k } })),
      comment: {
        comments: comments.map((c) => ({
          author: { displayName: "human" },
          body: { content: [{ content: [{ text: c }] }] },
          created: "2026-09-04T00:00:00Z",
        })),
      },
    },
  });
  const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj) });
  /** Routes every Jira REST call the handler can make; records them for assertions. */
  const jiraRouter = (issues) =>
    vi.fn(async (url, init = {}) => {
      const u = String(url);
      const m = u.match(/\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?/);
      if (!m) return jsonResp({});
      const [, key, sub] = m;
      if (sub === "/transitions") {
        if ((init.method || "GET") === "GET") {
          return jsonResp({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
        }
        return { ok: true, status: 204, text: async () => "" };
      }
      if (sub === "/comment") return jsonResp({}, 201);
      return issues[key] ? jsonResp(issues[key]) : { ok: false, status: 404, text: async () => "not found" };
    });
  const calls = (fetchSpy, pred) =>
    fetchSpy.mock.calls.filter(([u, init]) => pred(String(u), (init && init.method) || "GET"));

  beforeEach(async () => {
    process.env.TICKET_PROVIDER = "jira";
    process.env.JIRA_SITE_URL = "jira.test";
    process.env.JIRA_EMAIL = "bot@test";
    process.env.JIRA_API_TOKEN = "t";
    vi.resetModules();
    ({ handleReviewRejection, handler } = await import("./index.mjs"));
    h.state.s3Objects[LEDGER_KEY] = JSON.stringify({
      rounds: [{ round: 1, verdict: "CHANGES-NEEDED", findings: STRUCTURED_FINDINGS }],
    });
    h.state.enforce = advisoryEnforce();
  });
  afterEach(() => {
    delete process.env.TICKET_PROVIDER;
    delete process.env.JIRA_SITE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
  });

  const upstream = () => jiraIssue("TEAM-10", { status: "Done", labels: ["agent:agentcore_hub_api_dev"] });

  it("re-read shows the gate moved (In Review) → NO transition, ONE read, no retry, no rethrow, no escalation", async () => {
    const fetchSpy = jiraRouter({ "TEAM-10": upstream(), "TEAM-900": jiraIssue("TEAM-900", { status: "In Review" }) });
    global.fetch = fetchSpy;

    await expect(handleReviewRejection(RM_GATE)).resolves.toBeUndefined();

    expect(calls(fetchSpy, (u) => u.includes("/TEAM-900/transitions"))).toHaveLength(0);
    expect(calls(fetchSpy, (u) => u.includes("/issue/TEAM-900?fields"))).toHaveLength(1);
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeUndefined();
    expect(h.state.events.find((e) => e.type === "review.escalated")).toBeUndefined();
    expect(h.state.events.find((e) => e.type === "review.rejected")).toBeUndefined();
  });

  it("re-read shows the gate moved (Done) → same stop", async () => {
    const fetchSpy = jiraRouter({ "TEAM-10": upstream(), "TEAM-900": jiraIssue("TEAM-900", { status: "Done" }) });
    global.fetch = fetchSpy;

    await handleReviewRejection(RM_GATE);

    expect(calls(fetchSpy, (u) => u.includes("/TEAM-900/transitions"))).toHaveLength(0);
    expect(calls(fetchSpy, (u) => u.includes("/issue/TEAM-900?fields"))).toHaveLength(1);
    expect(h.state.events.find((e) => e.type === "review.escalated")).toBeUndefined();
  });

  it("re-read shows the gate still Blocked → the Done transition proceeds and approved_with_advisory fires", async () => {
    const fetchSpy = jiraRouter({ "TEAM-10": upstream(), "TEAM-900": jiraIssue("TEAM-900", { status: "Blocked" }) });
    global.fetch = fetchSpy;

    await handleReviewRejection(RM_GATE);

    expect(calls(fetchSpy, (u, m) => u.includes("/TEAM-900/transitions") && m === "GET")).toHaveLength(1);
    expect(calls(fetchSpy, (u, m) => u.includes("/TEAM-900/transitions") && m === "POST")).toHaveLength(1);
    expect(h.state.events.find((e) => e.type === "review.approved_with_advisory")).toBeTruthy();
  });

  /**
   * F2 pin — the production trigger only invokes handleReviewRejection for a
   * "human:*" gate, so the RM-origin auto-approve above is intentionally
   * unreachable from the Jira webhook entry point.
   */
  it("PIN: the Jira webhook trigger invokes handleReviewRejection ONLY for a human-assigned gate", async () => {
    const rmGate = jiraIssue("TEAM-900", { status: "Blocked", labels: ["agent:agentcore_hub_release_manager", "wf:wf_1"], blockedBy: ["TEAM-10"] });
    const humanGate = jiraIssue("TEAM-900", { status: "Blocked", labels: ["human-review", "reviewer:engineer", "wf:wf_1"], blockedBy: ["TEAM-10"] });
    // Short-circuit before the (Jira-hopping) reopen loop — we only need to know
    // whether the handler was reached.
    h.state.enforce = vi.fn(async () => ({ escalated: true, effectiveRounds: 3, maxRounds: 3 }));
    const webhook = { source: "jira-webhook", ticketId: "TEAM-900", newStatus: "blocked", oldStatus: "in_review" };

    global.fetch = jiraRouter({ "TEAM-10": upstream(), "TEAM-900": rmGate });
    await handler(webhook);
    expect(h.state.enforce).not.toHaveBeenCalled();

    global.fetch = jiraRouter({ "TEAM-10": upstream(), "TEAM-900": humanGate });
    await handler(webhook);
    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(h.state.enforce.mock.calls[0][0].gateTicket.assignee).toBe("human:engineer");
  });
});

/**
 * TEAM-3966 F2 pin (DDB-stream twin): processRecord gates on the stream image's
 * assignee the same way.
 */
describe("processRecord — DDB-stream trigger invokes handleReviewRejection ONLY for a human-assigned gate (TEAM-3966 F2 pin)", () => {
  const streamEvent = (assignee) => ({
    Records: [{
      eventName: "MODIFY",
      eventSource: "aws:dynamodb",
      dynamodb: {
        NewImage: { ticketId: { S: "TEAM-900" }, status: { S: "blocked" }, assignee: { S: assignee } },
        OldImage: { ticketId: { S: "TEAM-900" }, status: { S: "in_review" }, assignee: { S: assignee } },
      },
    }],
  });

  it("agent-assigned gate → handler never reached; human-assigned gate → reached once", async () => {
    h.state.enforce = vi.fn(async () => ({ escalated: true, effectiveRounds: 3, maxRounds: 3 }));
    h.state.tickets["TEAM-900"] = { ...GATE, assignee: "human:engineer", status: "blocked" };

    await handler(streamEvent("agentcore_hub_release_manager"));
    expect(h.state.enforce).not.toHaveBeenCalled();

    await handler(streamEvent("human:engineer"));
    expect(h.state.enforce).toHaveBeenCalledTimes(1);
    expect(h.state.enforce.mock.calls[0][0].gateTicket.ticketId).toBe("TEAM-900");
  });
});
