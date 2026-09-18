import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4740 FR-13/FR-5 replay — four real runs whose delivery work went missing.
 *
 * The other replay-*.test.mjs files replay a run through the orchestrator's own
 * router. This one replays the SEAM the router is deliberately not part of: DL-009
 * forbids the orchestrator from deciding what work happens next, so a follow-up is
 * minted by workflow-output's report_completion and it gates the epic through
 * completion.mjs's EXISTING rule (iii). Those are therefore the two real modules
 * under test — the workflow-output handler and completion.mjs, both unmocked below
 * the AWS seam — and the assertion each fixture makes is end to end: the report
 * mints the ticket, and the gate then refuses to call the run complete.
 *
 * It lives in lambda/orchestrator/ because that is where the replay corpus lives
 * and because the property it pins is a RUN-level one; *.test.mjs files are
 * excluded from check-orchestrator-surface.sh's module list and LOC budget, so it
 * costs the thin-router budget nothing.
 *
 * The fixtures, and what each one lost:
 *
 *   TEAM-4660 — a fix ticket was created while the Merge Approval gate was open, so
 *     it was worked and pushed onto a branch the imminent merge superseded. The
 *     work had to WAIT for the CD ticket, and nothing said so.
 *   15x8ql — the run shipped and a post-deploy re-check was recorded in prose. The
 *     epic closed green; nobody re-checked.
 *   syq0p9 — the cd-ledger carried three console/IAM steps only a human could do.
 *     Three separate asks in one person's queue for one sitting at one console.
 *   hirhfw — the REGRESSION: an ordinary completion that carries no follow-ups at
 *     all must produce the pre-change record plus exactly one key (`delivery`).
 */

const h = vi.hoisted(() => ({
  puts: [], objects: new Map(), created: [], calls: [], siblings: [], issue: null, logs: [],
}));

const asString = (b) => (typeof b === "string" ? b : Buffer.from(b).toString("utf8"));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd?.constructor?.name;
      const input = cmd?.input || {};
      if (name === "PutObjectCommand") { h.puts.push(input); h.objects.set(input.Key, asString(input.Body)); return {}; }
      if (name === "GetObjectCommand") {
        if (!h.objects.has(input.Key)) { const e = new Error("no such key"); e.name = "NoSuchKey"; throw e; }
        const body = h.objects.get(input.Key);
        return { Body: { transformToString: async () => body } };
      }
      if (name === "HeadObjectCommand") {
        if (h.objects.has(input.Key)) return { ContentLength: h.objects.get(input.Key).length };
        const e = new Error("not found");
        e.name = "NotFound";
        e.$metadata = { httpStatusCode: 404 };
        throw e;
      }
      return {};
    }
  },
  PutObjectCommand: class { constructor(input) { this.input = input; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
  HeadObjectCommand: class { constructor(input) { this.input = input; } },
  ListObjectsV2Command: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      const call = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      const tool = call.tool_name;
      const params = call.parameters || {};
      h.calls.push({ tool, params });
      const reply = (obj) => ({ Payload: new TextEncoder().encode(JSON.stringify(obj)) });
      if (tool === "Tickets___get_issue") return reply(h.issue);
      if (tool === "Tickets___list_tickets") return reply({ total: h.siblings.length, issues: h.siblings });
      if (tool === "Tickets___create_ticket") {
        const key = params.__key || `TEAM-99${String(h.created.length + 1).padStart(2, "0")}`;
        h.created.push({ key, params });
        return reply({ key, status: "created", ticket: { key, summary: params.summary } });
      }
      return reply({ ok: true });
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  PutCommand: class { constructor(input) { this.input = input; } },
}));

process.env.ARTIFACT_BUCKET = "replay-bucket";
const { handler } = await import("../workflow-output/index.mjs");
const { isWorkflowComplete, deliveryRollUp, FOLLOWUP_TITLE_RE } = await import("./completion.mjs");

/** A DynamoDB-twin ticket row, the shape report_completion's reads normalize. */
const row = ({ key, summary = "Work", assignee, status = "todo", parent, created, description = "" }) => ({
  key,
  fields: { summary, description, status: { name: status }, assignee: { displayName: assignee }, parent: parent ? { key: parent } : undefined, created },
  blockedBy: [],
});

/** The same row as the orchestrator's completion gate sees it (workflows table). */
const gateTicket = ({ key, title, assignee, status, phase, spawnedBy, labels = [] }) => ({
  ticketId: key, title, assignee, status, phase, spawnedBy, labels,
});

const report = (args) => handler({ tool_name: "WorkflowOutput___report_completion", arguments: args });
const result = (res) => JSON.parse(res.content[0].text);
const record = (ticketId) => JSON.parse(h.objects.get(`completions/${ticketId}.json`));
/** The def every fixture below runs under: the ship phase is a required phase. */
const DEF = { completionRequiresAgentPhases: ["development", "verification", "ship"] };
const PHASES = { agentcore_hub_api_dev: "development", agentcore_hub_bug_fixer: "development", agentcore_hub_qa_verifier: "verification", agentcore_hub_release_manager: "ship" };
const complete = (tickets) => isWorkflowComplete(tickets, DEF, { getAgentPhase: (a) => PHASES[a] });

beforeEach(() => {
  h.puts.length = 0;
  h.created.length = 0;
  h.calls.length = 0;
  h.siblings.length = 0;
  h.issue = null;
  h.objects.clear();
  vi.spyOn(console, "warn").mockImplementation((...a) => h.logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => h.logs.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a) => h.logs.push(a.join(" ")));
});

describe("TEAM-4660 — a fix created while the Merge Approval gate is open waits for CD", () => {
  // The run: TEAM-4668 is the open Merge Approval gate, TEAM-4669 the CD ticket it
  // guards. TEAM-4677 is the fix the QA verifier hands on mid-run. In the real run
  // it was created unblocked, dispatched immediately, and pushed onto a branch the
  // merge then superseded.
  beforeEach(() => {
    h.issue = row({ key: "TEAM-4670", summary: "Verify the expired-token path", assignee: "agentcore_hub_qa_verifier", parent: "TEAM-4660", created: "2026-09-14T09:00:00.000Z" });
    h.siblings.push(
      row({ key: "TEAM-4668", summary: "Merge Approval", assignee: "human:engineer", status: "in_review", parent: "TEAM-4660", created: "2026-09-14T10:00:00.000Z" }),
      row({ key: "TEAM-4669", summary: "Ship + deploy", assignee: "agentcore_hub_release_manager", status: "todo", parent: "TEAM-4660", created: "2026-09-14T10:05:00.000Z" }),
    );
  });

  it("materializes TEAM-4677 blocked_by the CD ticket, not the human gate", async () => {
    const res = result(await report({
      ticket_id: "TEAM-4670", summary: "Repro confirmed at HEAD.", workflow_id: "wf_4660", agent_id: "agentcore_hub_qa_verifier",
      follow_ups: JSON.stringify([{ kind: "fix", owner: "agent", assignee: "agentcore_hub_bug_fixer", title: "Expired token returns 500 instead of 401" }]),
    }));
    expect(res.status).toBe("complete");
    expect(h.created).toHaveLength(1);
    const p = h.created[0].params;
    // The CD ticket, because that is what the delivery ORDER depends on. Blocking on
    // the human gate instead would free the fix the instant a human clicked
    // approve — i.e. exactly when the merge is about to land.
    expect(p.blocked_by).toEqual(["TEAM-4669"]);
    expect(p.parent_key).toBe("TEAM-4660");
    expect(p.assignee).toBe("agentcore_hub_bug_fixer");
    // A ship_fix in the ship phase: that pairing is what makes rule (iii) bite.
    expect(p.spawned_by).toEqual({ kind: "ship_fix", shipTicketId: "TEAM-4669" });
    expect(p.phase).toBe("ship");
  });

  it("files the fix BEFORE it transitions itself Done — the cascade must not outrun it (TEAM-4752 D2)", async () => {
    await report({
      ticket_id: "TEAM-4670", summary: "Repro confirmed at HEAD.", workflow_id: "wf_4660", agent_id: "agentcore_hub_qa_verifier",
      follow_ups: JSON.stringify([{ kind: "fix", owner: "agent", assignee: "agentcore_hub_bug_fixer", title: "Expired token returns 500 instead of 401" }]),
    });
    // The ORDER of the invokes, not just their presence. The Done transition is what
    // cascades: the orchestrator unblocks the dependents and re-evaluates whether the
    // epic is complete, and completion.mjs rule (iii) can only be gated by a fix
    // ticket that already EXISTS. Materializing after the transition left a window in
    // which the run could roll to `complete` past the very follow-up it was handed.
    const tools = h.calls.map((c) => c.tool);
    const transitionAt = tools.findIndex(
      (t, i) => t === "Tickets___transition_ticket" && h.calls[i].params.ticket_id === "TEAM-4670"
    );
    const lastCreateAt = tools.lastIndexOf("Tickets___create_ticket");
    expect(lastCreateAt).toBeGreaterThanOrEqual(0);
    expect(transitionAt).toBeGreaterThan(lastCreateAt);
    // …and the transition really is the sweeper's own, to `done`.
    expect(h.calls[transitionAt].params.transition_id).toBe("done");
  });

  it("and the run is NOT complete while that fix is open — no new gate logic", async () => {
    await report({
      ticket_id: "TEAM-4670", summary: "Repro confirmed at HEAD.", workflow_id: "wf_4660", agent_id: "agentcore_hub_qa_verifier",
      follow_ups: JSON.stringify([{ kind: "fix", owner: "agent", assignee: "agentcore_hub_bug_fixer", title: "Expired token returns 500 instead of 401" }]),
    });
    const p = h.created[0].params;
    // Every other ticket of the run is done; only the follow-up is open.
    const tickets = [
      gateTicket({ key: "TEAM-4661", title: "Build it", assignee: "agentcore_hub_api_dev", status: "done", phase: "development" }),
      gateTicket({ key: "TEAM-4670", title: "Verify it", assignee: "agentcore_hub_qa_verifier", status: "done", phase: "verification" }),
      gateTicket({ key: "TEAM-4669", title: "Ship + deploy", assignee: "agentcore_hub_release_manager", status: "done", phase: "ship" }),
      gateTicket({ key: "TEAM-4677", title: p.summary, assignee: p.assignee, status: "blocked", phase: p.phase, spawnedBy: { kind: p.spawned_by.kind, shipTicketId: p.spawned_by.shipTicketId }, labels: p.labels }),
    ];
    expect(complete(tickets)).toBe(false);
    // …and it completes the moment the follow-up does. The point of materializing a
    // follow-up as a fix ticket is that this needed ZERO new completion logic.
    expect(complete(tickets.map((t) => ({ ...t, status: "done" })))).toBe(true);
  });
});

describe("15x8ql — a post-deploy re-check that used to live only in prose", () => {
  beforeEach(() => {
    h.issue = row({ key: "TEAM-4705", summary: "Ship + deploy", assignee: "agentcore_hub_release_manager", parent: "TEAM-4700", created: "2026-09-15T11:00:00.000Z" });
    h.siblings.push(row({ key: "TEAM-4703", summary: "Ship + deploy", assignee: "agentcore_hub_release_manager", status: "in_progress", parent: "TEAM-4700", created: "2026-09-15T10:00:00.000Z" }));
  });

  it("becomes a qa_verifier ticket in the verification phase, blocked on TEAM-4703", async () => {
    const MERGE = "0ef5892abc";
    const EXEC = "b3a1c0de-1234-4f56-89ab-cdef01234567";
    const res = result(await report({
      ticket_id: "TEAM-4705", summary: "Merged and deployed.", workflow_id: "wf_15x8ql", agent_id: "agentcore_hub_release_manager",
      outcome: "shipped", merge_commit: MERGE, pipeline_execution_id: EXEC, pipeline_name: "hub-agentcore-hub-deploy",
      follow_ups: JSON.stringify([{ kind: "post_deploy_verification", owner: "agent", title: "Re-check /api/health and the token refresh path in prod" }]),
    }));
    expect(res.status).toBe("complete");
    const p = h.created[0].params;
    expect(p.blocked_by).toEqual(["TEAM-4703"]);
    expect(p.assignee).toBe("agentcore_hub_qa_verifier");
    // The phase has to be one the def REQUIRES, or rule (iii) looks at a phase the
    // gate never checks and the ticket silently fails to hold the run open.
    expect(p.phase).toBe("verification");
    expect(DEF.completionRequiresAgentPhases).toContain(p.phase);
    expect(p.spawned_by).toEqual({ kind: "qa_fix", qaTicketId: "TEAM-4703" });
    // And the record says the PR landed, so a reader knows WHAT is being re-checked.
    expect(record("TEAM-4705").delivery.prState).toBe("merged");
  });

  it("holds the run open, and rolls up as merged rather than as a handoff", async () => {
    await report({
      ticket_id: "TEAM-4705", summary: "Merged and deployed.", workflow_id: "wf_15x8ql", agent_id: "agentcore_hub_release_manager",
      outcome: "shipped", merge_commit: "0ef5892abc", pipeline_execution_id: "b3a1c0de-1234-4f56-89ab-cdef01234567", pipeline_name: "hub-agentcore-hub-deploy",
      follow_ups: JSON.stringify([{ kind: "post_deploy_verification", owner: "agent", title: "Re-check /api/health and the token refresh path in prod" }]),
    });
    const p = h.created[0].params;
    const followUp = gateTicket({ key: "TEAM-4712", title: p.summary, assignee: p.assignee, status: "blocked", phase: p.phase, spawnedBy: { kind: "qa_fix", qaTicketId: "TEAM-4703" }, labels: p.labels });
    const tickets = [
      gateTicket({ key: "TEAM-4701", title: "Build", assignee: "agentcore_hub_api_dev", status: "done", phase: "development" }),
      gateTicket({ key: "TEAM-4702", title: "Verify", assignee: "agentcore_hub_qa_verifier", status: "done", phase: "verification" }),
      gateTicket({ key: "TEAM-4703", title: "Ship", assignee: "agentcore_hub_release_manager", status: "done", phase: "ship" }),
      followUp,
    ];
    expect(complete(tickets)).toBe(false);
    // An open AGENT follow-up is a fix ticket, so rule (iii) already holds the run
    // open — there is nothing for the roll-up to describe as a handoff yet.
    const agentTasks = { agentcore_hub_release_manager: { outcome: "shipped", mergeCommit: "0ef5892abc", pipelineExecutionId: "b3a1c0de-1234-4f56-89ab-cdef01234567" } };
    expect(deliveryRollUp(tickets, agentTasks)).toEqual({ prState: "merged" });
  });
});

describe("syq0p9 — three console/IAM steps become ONE human ticket", () => {
  it("collapses the cd-ledger handoff[] and rolls up as complete-with-handoff", async () => {
    h.objects.set("workflows/wf_syq0p9/shared/cd-ledger.json", JSON.stringify({
      execution_id: "b3a1c0de-1234-4f56-89ab-cdef01234567",
      handoff: [
        "Enable the AGENTCORE_HUB_ROUTINES flag in the console",
        { step: "Attach AccessAnalyzerReadOnly to the hub task role" },
        "Re-run the smoke test against the prod endpoint",
      ],
    }));
    h.issue = row({ key: "TEAM-4805", summary: "Ship + deploy", assignee: "agentcore_hub_release_manager", parent: "TEAM-4800", created: "2026-09-16T12:00:00.000Z" });
    h.siblings.push(row({ key: "TEAM-4804", summary: "Ship + deploy", assignee: "agentcore_hub_release_manager", status: "in_progress", parent: "TEAM-4800", created: "2026-09-16T11:00:00.000Z" }));

    const res = result(await report({
      ticket_id: "TEAM-4805", summary: "Merged; console steps remain.", workflow_id: "wf_syq0p9", agent_id: "agentcore_hub_release_manager",
      outcome: "shipped", merge_commit: "77c1ab90de", pipeline_execution_id: "b3a1c0de-1234-4f56-89ab-cdef01234567", pipeline_name: "hub-agentcore-hub-deploy",
    }));
    expect(res.status).toBe("complete");

    // ONE ticket. Three asks in one person's queue, for one sitting at one console,
    // is three chances to close two and forget the third.
    expect(h.created).toHaveLength(1);
    const p = h.created[0].params;
    expect(p.assignee).toBe("human:engineer");
    expect(p.summary).toMatch(/^Post-merge console\/IAM handoff \(3 steps\) \[fu:[0-9a-f]{8}\]$/);
    expect(p.description).toContain("1. Enable the AGENTCORE_HUB_ROUTINES flag in the console");
    expect(p.description).toContain("2. Attach AccessAnalyzerReadOnly to the hub task role");
    expect(p.description).toContain("3. Re-run the smoke test against the prod endpoint");
    // A human gate is already a first-class blocker: no fix marker, no phase.
    expect("spawned_by" in p).toBe(false);
    expect("phase" in p).toBe(false);
    // The agent passed no follow_ups at all — the ledger alone produced this.
    expect(record("TEAM-4805").followUps).toHaveLength(1);

    const followUp = gateTicket({ key: "TEAM-4809", title: p.summary, assignee: "human:engineer", status: "todo", labels: p.labels });
    const tickets = [
      gateTicket({ key: "TEAM-4801", title: "Build", assignee: "agentcore_hub_api_dev", status: "done", phase: "development" }),
      gateTicket({ key: "TEAM-4802", title: "Verify", assignee: "agentcore_hub_qa_verifier", status: "done", phase: "verification" }),
      gateTicket({ key: "TEAM-4804", title: "Ship", assignee: "agentcore_hub_release_manager", status: "done", phase: "ship" }),
      followUp,
    ];
    // The marker the roll-up recognizes rode through the create call intact.
    expect(FOLLOWUP_TITLE_RE.test(followUp.title)).toBe(true);
    expect(deliveryRollUp(tickets, { agentcore_hub_release_manager: { outcome: "shipped", mergeCommit: "77c1ab90de", pipelineExecutionId: "b3a1c0de-1234-4f56-89ab-cdef01234567" } }))
      .toEqual({ outcome: "complete-with-handoff", prState: "merged" });
  });
});

describe("REGRESSION hirhfw — a completion with no follow-ups is unchanged but for delivery", () => {
  it("writes the pre-change record plus exactly one key, and calls no ticket tool but the transition", async () => {
    // hirhfw is an ordinary dev completion: a PR, no ship claim, no follow-ups. It
    // is the shape almost every report in the corpus has, so "additive" has to mean
    // additive here or TEAM-4740 changed every run in the fleet.
    const res = result(await report({
      ticket_id: "TEAM-4610", summary: "Added the retry wrapper; unit tests green.", workflow_id: "wf_hirhfw",
      agent_id: "agentcore_hub_api_dev", branch: "feature/TEAM-4600-integration", commit_sha: "5c1d2e3",
      pr_url: "https://github.com/tycenjmccann/agentcore-hub/pull/611", artifacts: "src/lib/retry.ts",
    }));
    expect(res.status).toBe("complete");
    expect(Object.keys(res).sort()).toEqual(["message", "status"]);
    const r = record("TEAM-4610");
    expect(Object.keys(r)).toEqual([
      "ticket_id", "summary", "artifacts", "branch", "commit_sha", "pr_url", "completed_at", "delivery",
    ]);
    expect(r.delivery).toEqual({ prUrl: "https://github.com/tycenjmccann/agentcore-hub/pull/611", prState: "open" });
    // No epic read, no sibling scan, no create: the report that needs none of it
    // pays for none of it.
    expect(h.calls.map((c) => c.tool)).toEqual(["Tickets___transition_ticket"]);
    expect(h.created).toHaveLength(0);
  });
});
