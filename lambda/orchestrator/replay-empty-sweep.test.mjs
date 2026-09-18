import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4740 FR-10/FR-11 replay — run fz514x, the dead-code sweep that found nothing.
 *
 * fz514x planned the usual sweep chain (analyst → sweeper → removal → review → ship)
 * and then swept 41 modules and found every candidate still referenced. There was no
 * diff, no PR and nothing to merge — and no honest way to say so. The run's four
 * downstream tickets sat waiting for a diff that would never exist, and the only
 * ways out were to fake a ship or to leave the epic open forever.
 *
 * Two halves of the same fix are replayed here, both through REAL code:
 *
 *   the PLAN (FR-11) — `submit_ticket_plan` normalizes the analyst's plan so the
 *     sweeper is blocked on the analyst's own ticket. fz514x's plan named no blocker
 *     at all on its first tickets, so the orchestrator dispatched the sweeper before
 *     the requirements it was planned from existed.
 *   the CLOSE (FR-10) — `report_completion` with `outcome: "empty_sweep"` writes a
 *     skip completion for every remaining sibling and closes it, dependents first,
 *     BEFORE the sweeper's own Done cascades.
 *
 * Under test: the REAL workflow-output handler (both tools) as the producer, and the
 * REAL completion.mjs as the reader — the same two-module seam replay-followups.mjs
 * uses, for the same reason (DL-009 keeps this decision out of the router). Only the
 * AWS clients are mocked.
 *
 * ⚠️ RUN-LEVEL DEPENDENCY, stated rather than mocked around: `empty_sweep` only
 * reaches `shipVerdictOf` once harvestCompletionEvidence's outcome filter in
 * index.mjs admits it (TEAM-4739's one-line change). The verdict half asserted below
 * is this ticket's; the harvest term is not, so the last test drives shipVerdictOf
 * directly rather than pretending the harvest already forwards it.
 */

const h = vi.hoisted(() => ({
  puts: [], objects: new Map(), calls: [], events: [], siblings: [], issue: null,
  workflow: null, logs: [],
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

/**
 * The fake ticket system. `transition_ticket` mirrors the DynamoDB twin's real
 * TRANSITIONS constraint — `skip` is reachable only from `blocked` — because the
 * sweep's two-step transition exists ENTIRELY to satisfy that, and a permissive stub
 * would let a one-step implementation pass this replay while wedging in production.
 */
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      const call = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      const tool = call.tool_name;
      const params = call.parameters || {};
      h.calls.push({ tool, params });
      const reply = (obj) => ({ Payload: new TextEncoder().encode(JSON.stringify(obj)) });
      if (tool === "Tickets___get_issue") {
        const id = params.ticket_id;
        return reply(h.siblings.find((s) => s.key === id) || h.issue);
      }
      if (tool === "Tickets___list_tickets") return reply({ total: h.siblings.length, issues: h.siblings });
      if (tool === "Tickets___transition_ticket") {
        const row = h.siblings.find((s) => s.key === params.ticket_id);
        const from = row?.fields?.status?.name || "todo";
        if (params.transition_id === "skip" && from !== "blocked") {
          return reply({ content: [{ type: "text", text: `Error: transition skip is not available from ${from}` }] });
        }
        if (row) row.fields.status = { name: params.transition_id === "block" ? "blocked" : "done" };
        return reply({ ok: true, status: params.transition_id });
      }
      return reply({ ok: true });
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd) => {
        if (cmd?.constructor?.name === "GetCommand") return { Item: h.workflow || undefined };
        if (cmd?.input?.Item) h.events.push(cmd.input.Item);
        return {};
      },
    }),
  },
  PutCommand: class { constructor(input) { this.input = input; } },
  GetCommand: class { constructor(input) { this.input = input; } },
}));

process.env.ARTIFACT_BUCKET = "replay-bucket";
process.env.WORKFLOWS_TABLE = "agentcore-hub-workflows";
const { handler } = await import("../workflow-output/index.mjs");
const { isWorkflowComplete, shipVerdictOf, SHIP_BLOCKED_OUTCOMES } = await import("./completion.mjs");

/** A DynamoDB-twin ticket row (the shape both twins' reads normalize from). */
const row = ({ key, summary, assignee, status = "todo", created, blockedBy = [] }) => ({
  key,
  fields: { summary, description: "", status: { name: status }, assignee: { displayName: assignee }, parent: { key: "TEAM-4634" }, created },
  blockedBy,
});

const result = (res) => JSON.parse(res.content[0].text);
const record = (ticketId) => JSON.parse(h.objects.get(`completions/${ticketId}.json`));
const hasRecord = (ticketId) => h.objects.has(`completions/${ticketId}.json`);

// fz514x, as planned. TEAM-4635 is the analyst's own ticket (the hub creates it
// first at start, which is what makes it the deterministic root); TEAM-4639 is the
// sweeper; 4640/4643/4644 are the removal, review and ship tickets that depend on a
// diff; TEAM-4645 is the human Merge Approval gate.
const BRANCH = "feature/TEAM-4634-dead-code-sweep";
const CHAIN = () => [
  row({ key: "TEAM-4635", summary: "Analyse the sweep request", assignee: "agentcore_hub_requirements_analyst", status: "done", created: "2026-09-12T08:00:00.000Z" }),
  row({ key: "TEAM-4639", summary: "Sweep for dead code", assignee: "agentcore_hub_api_dev", status: "in_progress", created: "2026-09-12T08:05:00.000Z", blockedBy: ["TEAM-4635"] }),
  row({ key: "TEAM-4640", summary: "Remove the dead modules", assignee: "agentcore_hub_api_dev", created: "2026-09-12T08:06:00.000Z", blockedBy: ["TEAM-4639"] }),
  row({ key: "TEAM-4643", summary: "Review the removals", assignee: "agentcore_hub_code_reviewer", created: "2026-09-12T08:07:00.000Z", blockedBy: ["TEAM-4640"] }),
  row({ key: "TEAM-4644", summary: "Ship + deploy the sweep", assignee: "agentcore_hub_release_manager", created: "2026-09-12T08:08:00.000Z", blockedBy: ["TEAM-4643"] }),
  row({ key: "TEAM-4645", summary: "Merge Approval", assignee: "human:engineer", status: "in_review", created: "2026-09-12T08:09:00.000Z", blockedBy: ["TEAM-4644"] }),
];

// The phases fz514x's chain actually contains. dead-code-sweep's def requires
// ["development","verification","review","ship"], but neither the plan the analyst
// submitted nor the tickets the run created had a verification ticket — so requiring
// it here would be asserting against the def rather than against the fixture.
const DEF = { completionRequiresAgentPhases: ["development", "review", "ship"] };
const PHASES = { agentcore_hub_api_dev: "development", agentcore_hub_code_reviewer: "review", agentcore_hub_release_manager: "ship", agentcore_hub_requirements_analyst: "requirements" };
const complete = (tickets) => isWorkflowComplete(tickets, DEF, { getAgentPhase: (a) => PHASES[a] });

beforeEach(() => {
  h.puts.length = 0;
  h.calls.length = 0;
  h.events.length = 0;
  h.siblings.length = 0;
  h.objects.clear();
  h.workflow = { workflowId: "fz514x", featureBranch: BRANCH };
  h.issue = null;
  vi.spyOn(console, "warn").mockImplementation((...a) => h.logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => h.logs.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a) => h.logs.push(a.join(" ")));
});

describe("fz514x — the sweep that found nothing closes its own chain", () => {
  beforeEach(() => {
    h.siblings.push(...CHAIN());
    h.issue = h.siblings.find((s) => s.key === "TEAM-4639");
  });

  const sweepReport = () => handler({
    tool_name: "WorkflowOutput___report_completion",
    arguments: {
      ticket_id: "TEAM-4639", workflow_id: "fz514x", agent_id: "agentcore_hub_api_dev",
      summary: "Swept 41 modules against the full call graph; every candidate is still referenced. No removals.",
      branch: BRANCH, outcome: "empty_sweep",
    },
  });

  it("writes skip completions for TEAM-4640 / 4643 / 4644 and closes each", async () => {
    const res = result(await sweepReport());
    expect(res.status).toBe("complete");
    expect(res).not.toHaveProperty("emptySweepFailed");
    // Reverse topological: ship, then review, then removal. The real run's four
    // tickets each had a live agent waiting on them.
    expect(res.emptySweepSkipped).toEqual(["TEAM-4644", "TEAM-4643", "TEAM-4640"]);
    for (const id of ["TEAM-4640", "TEAM-4643", "TEAM-4644"]) {
      expect(hasRecord(id), id).toBe(true);
      expect(record(id), id).toEqual({
        ticketId: id,
        workflowId: "fz514x",
        summary: "Skipped: empty_sweep — no removals found by TEAM-4639",
        evidence_kind: "skipped",
        skipped: true,
        reason: "empty_sweep",
      });
      expect(h.siblings.find((s) => s.key === id).fields.status.name).toBe("done");
    }
  });

  it("goes through blocked to reach skip, because the twin's map allows nothing else", async () => {
    await sweepReport();
    // The stub enforces the real TRANSITIONS constraint, so this passing IS the
    // evidence that the two-step exists. Per ticket: skip (refused) → block → skip.
    const forShip = h.calls.filter((c) => c.tool === "Tickets___transition_ticket" && c.params.ticket_id === "TEAM-4644");
    expect(forShip.map((c) => c.params.transition_id)).toEqual(["skip", "block", "skip"]);
    expect(forShip[1].params.reason).toBe("empty_sweep — no removals found by TEAM-4639");
  });

  it("closes the chain BEFORE the sweeper's own Done, which is what cascades", async () => {
    await sweepReport();
    const transitions = h.calls.filter((c) => c.tool === "Tickets___transition_ticket");
    const sweeperAt = transitions.findIndex((c) => c.params.ticket_id === "TEAM-4639");
    expect(transitions[sweeperAt].params.transition_id).toBe("done");
    // Last. In the real run the sweeper's Done was the FIRST thing to happen, and the
    // cascade handed TEAM-4640 to a live dev agent with nothing to remove.
    expect(sweeperAt).toBe(transitions.length - 1);
    expect(hasRecord("TEAM-4640")).toBe(true);
  });

  it("leaves the human Merge Approval gate alone", async () => {
    const res = result(await sweepReport());
    expect(res.emptySweepSkipped).not.toContain("TEAM-4645");
    expect(hasRecord("TEAM-4645")).toBe(false);
    expect(h.siblings.find((s) => s.key === "TEAM-4645").fields.status.name).toBe("in_review");
  });

  it("records an honest terminal outcome — a skip, not a ship", async () => {
    await sweepReport();
    const own = record("TEAM-4639");
    expect(own.outcome).toBe("empty_sweep");
    expect(own.pr_url).toBeNull();
    // Nothing merged and nothing open: "merged" would be a false claim and "open"
    // would point at a PR that does not exist.
    expect(own.delivery).toEqual({ prUrl: null, prState: "unknown" });
    expect(h.events.filter((e) => e.type === "delivery.prState")).toHaveLength(1);
  });

  it("and the run can then close, because nothing is left open", async () => {
    await sweepReport();
    const done = (key, assignee) => ({ ticketId: key, title: "t", assignee, status: "done", phase: PHASES[assignee] });
    expect(complete([
      done("TEAM-4635", "agentcore_hub_requirements_analyst"),
      done("TEAM-4639", "agentcore_hub_api_dev"),
      done("TEAM-4640", "agentcore_hub_api_dev"),
      done("TEAM-4643", "agentcore_hub_code_reviewer"),
      done("TEAM-4644", "agentcore_hub_release_manager"),
      { ticketId: "TEAM-4645", title: "Merge Approval", assignee: "human:engineer", status: "done" },
    ])).toBe(true);
  });

  it("the verdict is `shipped`, and `empty_sweep` is NOT a blocked outcome", () => {
    // The pair that stops an empty sweep closing RED: a run with provably nothing to
    // merge has shipped everything it had. Asserted here rather than end-to-end
    // because the harvest term that forwards the outcome is TEAM-4739's.
    // shipVerdictOf reads a harvested agentTasks ENTRY, which is why the harvest term
    // is what activates this: the entry it will be handed carries no mergeCommit.
    expect(shipVerdictOf({ outcome: "empty_sweep" })).toBe("shipped");
    expect(shipVerdictOf({ outcome: "empty_sweep", mergeCommit: null })).toBe("shipped");
    expect(SHIP_BLOCKED_OUTCOMES).not.toContain("empty_sweep");
    // An entry the harvest DROPPED the outcome from is the pre-fix behaviour, and it
    // is a phantom green — which is the failure the harvest term removes.
    expect(shipVerdictOf({})).toBeNull();
  });
});

describe("fz514x — every sweep plan gives the sweeper the analyst as its blocker", () => {
  // The plan the analyst actually submitted: five tickets, not one blocker between
  // them. The sweeper was dispatched the moment the epic existed.
  const SWEEP_PLAN = [
    { title: "Analyse the sweep request", description: "Read the request and scope the sweep.", assignee: "agentcore_hub_requirements_analyst", blockedBy: [] },
    { title: "Sweep for dead code", description: "Walk the call graph on feature/sweep-2026-09 and list every unreferenced module.", assignee: "agentcore_hub_api_dev", blockedBy: [] },
    { title: "Remove the dead modules", description: "Delete what the sweep found.", assignee: "agentcore_hub_api_dev", blockedBy: ["Sweep for dead code"] },
    { title: "Ship + deploy the sweep", description: "Merge and deploy.", assignee: "agentcore_hub_release_manager", blockedBy: ["Remove the dead modules"] },
    { title: "Merge Approval", description: "Approve the merge.", assignee: "human:engineer", blockedBy: [] },
  ];

  const submit = () => handler({
    tool_name: "WorkflowOutput___submit_ticket_plan",
    arguments: { workflow_id: "fz514x", epic_id: "TEAM-4634", tickets: JSON.stringify(SWEEP_PLAN) },
  });

  beforeEach(() => {
    // At plan time only the analyst's own ticket exists — that is the whole reason
    // the root is deterministic.
    h.siblings.push(row({ key: "TEAM-4635", summary: "Analyse the sweep request", assignee: "agentcore_hub_requirements_analyst", status: "in_progress", created: "2026-09-12T08:00:00.000Z" }));
  });

  it("blocks the sweeper on TEAM-4635 and leaves the analyst's own chain alone", async () => {
    const res = result(await submit());
    const t = (title) => res.tickets.find((x) => x.title === title);
    expect(t("Sweep for dead code").blockedBy).toEqual(["TEAM-4635"]);
    expect(res.autowired).toEqual({ reason: "no_root_blocker", rootTicketId: "TEAM-4635", tickets: ["Sweep for dead code"] });
    // The root does not block itself, an explicit chain is authoritative, and the
    // human gate is not made to wait on the work it gates.
    expect(t("Analyse the sweep request").blockedBy).toEqual([]);
    expect(t("Remove the dead modules").blockedBy).toEqual(["Sweep for dead code"]);
    expect(t("Merge Approval").blockedBy).toEqual([]);
    expect(h.events.filter((e) => e.type === "plan.autowired")).toHaveLength(1);
  });

  it("replaces the coined branch name with the orchestrator's integration branch", async () => {
    const res = result(await submit());
    const sweeper = res.tickets.find((x) => x.title === "Sweep for dead code");
    // The analyst invented `feature/sweep-2026-09`; three agents on three branches is
    // how a sweep loses its own diff.
    expect(sweeper.description).toContain(BRANCH);
    expect(sweeper.description).not.toContain("feature/sweep-2026-09");
    for (const x of res.tickets) {
      expect(x.description, x.title).toContain(`Integration branch: ${BRANCH} (orchestrator-provided; do not coin branch names)`);
    }
    expect(res.integration_branch).toBe(BRANCH);
    expect(res.ticket_count).toBe(5);
  });
});
