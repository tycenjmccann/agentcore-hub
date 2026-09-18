import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4663 replay — `base_branch: main` from the create seam to the refusal.
 *
 * This file replaces a fixture that could not fail. `replay-head-of-line.test.mjs`
 * used to declare the release manager's create_ticket payload as a literal and then
 * assert its own fields back (`RM_CREATE_TICKET_PAYLOAD.base_branch === "main"`),
 * which is true for every possible state of the code under test. What TEAM-4663
 * actually needs pinned is the CHAIN that payload starts, and that chain spans two
 * Lambdas:
 *
 *   1. the tickets twin's `create_ticket` records the branch (`item.baseBranch`)
 *      AND writes the machine-parseable `base_branch: main` line into the stored
 *      description — which is the only carrier of the fact, because
 *   2. workflow-output's `report_completion` reads the branch back out of that
 *      DESCRIPTION (`statedBaseBranch` → `BASE_BRANCH_LINE_RE`), not out of a
 *      `baseBranch` field: the twin's `get_issue` does not return one. A fix to
 *      main that carries no PR to main is then refused before anything durable.
 *
 * So both real modules run in one process: the tickets twin IS the Lambda behind
 * workflow-output's `ticketTool` seam (the `@aws-sdk/client-lambda` mock routes
 * every `Tickets___*` invoke into the twin's own handler), and the only things
 * mocked are the AWS seams themselves — DynamoDB, S3, that Lambda invoke, and
 * `fetch` for the one GitHub read. Every refusal string, banner and regex is the
 * shipped one; nothing here hard-codes their prose.
 *
 * The run is p5ogpg: the Merge Approval gate was open, the release manager filed a
 * fix ticket for a change that had to land on main, and the work went onto a branch
 * the imminent merge superseded.
 *
 * The jira half of the same create lives in
 * lambda/agentcore-hub-jira/replay-base-branch-main.test.mjs (node:test, run by
 * `node --test lambda/agentcore-hub-jira`); the twins' banner byte-identity is
 * asserted at the bottom of THIS file, where both modules can be loaded at once.
 */

const h = vi.hoisted(() => ({
  state: {
    items: /** @type {Record<string, any>} */ ({}),
    puts: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    siblings: /** @type {any[]} */ ([]),
    objects: /** @type {Map<string, string>} */ (new Map()),
    s3Puts: /** @type {any[]} */ ([]),
    /** Every tool call that crossed the Lambda seam, with the twin's own answer. */
    calls: /** @type {any[]} */ ([]),
    counter: 0,
  },
  /** The REAL tickets-twin handler, late-bound: the seam below routes into it. */
  tickets: /** @type {null | ((event: any) => Promise<any>)} */ (null),
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      const req = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      const tool = req.tool_name || req.name;
      // Only the ticket tools are answerable here. Anything else (the gate probe's
      // Pipeline___* calls) must not reach the twin — an unexpected invoke is a
      // test-harness bug, not a timeout to be swallowed.
      if (!String(tool).startsWith("Tickets___")) throw new Error(`unexpected invoke: ${tool}`);
      const payload = await h.tickets({ tool_name: tool, parameters: req.parameters || {} });
      h.state.calls.push({ tool, params: req.parameters || {}, payload });
      return { Payload: Buffer.from(JSON.stringify(payload)) };
    }
  },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand { constructor(input) { this.input = input; } }
  class GetCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const name = cmd.constructor.name;
          const input = cmd.input;
          if (name === "PutCommand") {
            // An event row (journey audit) vs a ticket row — the tickets table and
            // the events table share this client in both Lambdas.
            if (input.Item?.eventId) h.state.events.push(input.Item);
            else {
              h.state.puts.push(input.Item);
              h.state.items[input.Item.ticketId] = { ...input.Item };
            }
            return {};
          }
          if (name === "GetCommand") return { Item: h.state.items[input.Key.ticketId] || null };
          if (name === "QueryCommand") return { Items: h.state.siblings };
          if (name === "UpdateCommand") {
            // `nextTicketId`'s counter bump: the one write that means "a ticket is
            // about to exist".
            if (input.ExpressionAttributeNames?.["#n"] === "nextNum") {
              h.state.counter += 1;
              return { Attributes: { nextNum: h.state.counter } };
            }
            // A status transition. APPLIED to the row, so a later get_issue and the
            // twin's own transition table see what the twin actually wrote.
            const status = input.ExpressionAttributeValues?.[":s"];
            const row = h.state.items[input.Key.ticketId];
            if (status !== undefined && row) row.status = status;
            return {};
          }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input || {};
      if (name === "PutObjectCommand") {
        h.state.s3Puts.push(input);
        h.state.objects.set(input.Key, typeof input.Body === "string" ? input.Body : Buffer.from(input.Body).toString("utf8"));
        return {};
      }
      if (name === "GetObjectCommand") {
        if (!h.state.objects.has(input.Key)) {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        const body = h.state.objects.get(input.Key);
        return { Body: { transformToString: async () => body } };
      }
      if (name === "HeadObjectCommand") {
        if (h.state.objects.has(input.Key)) return { ContentLength: h.state.objects.get(input.Key).length };
        const err = new Error("NotFound");
        err.name = "NotFound";
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  HeadObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));

// ─── The run ──────────────────────────────────────────────────────────────────

const EPIC = "TEAM-4734";
const CD = "TEAM-4703";          // the release manager's CD ticket
const GATE = "TEAM-4705";        // the open human Merge Approval gate
const WF = "p5ogpg";
const FIX_BODY = "The FR-5 base-branch check must fire at the create seam, not at review time.";
const PR = "https://github.com/tycenjmccann/agentcore-hub/pull/634";

/** The epic's children as they stood while the merge gate was open. */
const siblingRows = () => [
  { ticketId: CD, title: "CD: merge and deploy the TEAM-4734 epic", status: "in_progress", assignee: "agentcore_hub_release_manager", phase: "ship", labels: [], createdAt: "2026-09-10T10:00:00Z", parentId: EPIC },
  { ticketId: GATE, title: "Merge Approval: TEAM-4734", status: "in_review", assignee: "human:tycen", labels: ["human-review", "reviewer:tycen"], createdAt: "2026-09-10T11:00:00Z", parentId: EPIC },
];

let output;
const create = (args) => h.tickets({ name: "Tickets___create_ticket", arguments: args });
const transition = (args) => h.tickets({ name: "Tickets___transition_ticket", arguments: args });
const report = (args) => output({ tool_name: "WorkflowOutput___report_completion", arguments: args });
const result = (res) => JSON.parse(res.content[0].text);
const record = (ticketId) => JSON.parse(h.state.objects.get(`completions/${ticketId}.json`));
/** The stored description as LINES, so a structural assertion needs no prose. */
const lines = (text) => String(text || "").split(/\n+/).filter((l) => l.length > 0);

beforeEach(async () => {
  const s = h.state;
  s.items = {};
  s.puts.length = 0;
  s.events.length = 0;
  s.calls.length = 0;
  s.siblings = siblingRows();
  s.objects.clear();
  s.s3Puts.length = 0;
  s.counter = 4762;   // the next ticket minted on the run is TEAM-4763

  process.env.AWS_REGION = "us-east-1";
  process.env.ARTIFACT_BUCKET = "replay-bucket";
  process.env.EVENTS_TABLE = "agentcore-hub-events";
  // The twin under test IS the DynamoDB one, so workflow-output must be wired to it
  // (otherwise its FR-5 check logs the jira-mode INERT warning instead of running).
  process.env.TICKET_PROVIDER = "dynamodb";
  process.env.TICKET_TOOLS_LAMBDA = "agentcore-hub-tickets";
  // No pipeline module (no gate probe), no workflows table (no branch templating),
  // and no GitHub token unless a test sets one.
  delete process.env.PIPELINE_TOOLS_LAMBDA;
  delete process.env.WORKFLOWS_TABLE;
  delete process.env.GITHUB_TOKEN;

  vi.resetModules();
  ({ handler: h.tickets } = await import("./index.mjs"));
  ({ handler: output } = await import("../workflow-output/index.mjs"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The create the release manager made, as it was actually made: no blockers named. */
const filedFix = (extra = {}) => create({
  summary: "Fix: deliver the FR-5 base-branch check to main",
  description: FIX_BODY,
  issue_type: "Task",
  parent_key: EPIC,
  assignee: "agentcore_hub_api_dev",
  workflow_id: WF,
  phase: "ship",
  base_branch: "main",
  ...extra,
});

describe("TEAM-4663 create half — the twin records the branch and states it in the description", () => {
  it("stores baseBranch, writes the base_branch line last, and freezes behind the CD ticket", async () => {
    const res = await filedFix();

    // The field, for anything reading the row …
    const item = h.state.puts.at(-1);
    expect(item.baseBranch).toBe("main");
    // … and the line, which is the ONLY thing report_completion can read (get_issue
    // returns no baseBranch field — asserted below).
    expect(lines(item.description).at(-1)).toBe("base_branch: main");
    // Banner, prose, branch line — in that order, each on its own block.
    expect(lines(item.description)).toHaveLength(3);
    expect(lines(item.description)[1]).toBe(FIX_BODY);
    // The freeze: no blocker was named, so the open gate's CD ticket is autowired in
    // and the banner names it. (The prose itself is pinned by the parity test below.)
    expect(item.blockedBy).toEqual([CD]);
    expect(item.status).toBe("blocked");
    expect(lines(item.description)[0]).toContain(CD);
    expect(res.autowired).toEqual({ reason: "open_gate", blockedBy: [CD], gateTicketId: GATE });
    // The response mirrors the branch under its wire name — this object is what an
    // agent copies from.
    expect(res.ticket.base_branch).toBe("main");
    expect(res.ticket.blocked_by).toEqual([CD]);
    // Exactly one audit row for the one edge that was added.
    expect(h.state.events.filter((e) => e.type === "plan.autowired")).toHaveLength(1);
  });

  it("a caller that already named the CD ticket gets no second edge and no banner — the branch line stays", async () => {
    const res = await filedFix({ blocked_by: [CD] });

    const item = h.state.puts.at(-1);
    expect(item.blockedBy).toEqual([CD]);
    expect(res.autowired).toBeUndefined();
    // Prose then branch line, and nothing else: composeDescription omits an absent
    // banner rather than leaving a blank block behind.
    expect(lines(item.description)).toEqual([FIX_BODY, "base_branch: main"]);
    expect(h.state.events.filter((e) => e.type === "plan.autowired")).toHaveLength(0);
  });

  it("a base_branch the regex refuses mints nothing at all", async () => {
    const res = await filedFix({ base_branch: "main; rm -rf /" });

    // The refusal text itself is byte-compared against the jira twin's by
    // src/lib/workflow/base-branch-parity.test.ts; what this pins is that the
    // HANDLER path refuses, and that the refusal costs no ticket number and no row.
    expect(res.content[0].text).toMatch(/^Error: /);
    expect(h.state.puts).toHaveLength(0);
    expect(h.state.counter).toBe(4762);
  });
});

describe("TEAM-4663 report half — a fix to main with no PR to main is refused", () => {
  /** The ticket as the twin actually minted it, then started by its assignee. */
  async function fileAndStart() {
    const res = await filedFix();
    const ticketId = res.key;
    await transition({ ticket_id: ticketId, transition_id: "start" });
    h.state.calls.length = 0;
    h.state.events.length = 0;
    h.state.s3Puts.length = 0;
    return ticketId;
  }

  it("refuses main_fix_requires_pr, and leaves nothing behind", async () => {
    const ticketId = await fileAndStart();

    const res = result(await report({
      ticket_id: ticketId,
      summary: "Implemented the FR-5 check and pushed the branch.",
      branch: "feature/TEAM-4734--si-system-binding-gate-resolution-deplo",
      commit_sha: "eb71dbb",
      agent_id: "agentcore_hub_api_dev",
      workflow_id: WF,
    }));

    expect(res).toMatchObject({
      ok: false,
      reason: "main_fix_requires_pr",
      detail: "no_pr_url",
      missing: ["pr_url"],
    });
    // The refusal precedes EVERYTHING durable: no record, no Done transition, no
    // cd_unmerged handoff ticket, and no delivery event.
    expect(h.state.s3Puts).toHaveLength(0);
    expect(h.state.objects.has(`completions/${ticketId}.json`)).toBe(false);
    expect(h.state.calls.map((c) => c.tool)).toEqual(["Tickets___get_issue"]);
    expect(h.state.events).toHaveLength(0);
    expect(h.state.items[ticketId].status).toBe("in_progress");
  });

  it("the branch is read off the twin's real get_issue payload — from the description, not a field", async () => {
    const ticketId = await fileAndStart();
    await report({ ticket_id: ticketId, summary: "s", workflow_id: WF });

    // This is the finding the deleted fixture could never have caught: the payload
    // the check consults is the twin's OWN get_issue output, and that output has no
    // baseBranch key — the description line is the whole carrier.
    const payload = h.state.calls[0].payload;
    expect(payload.key).toBe(ticketId);
    expect(payload.baseBranch).toBeUndefined();
    expect(payload.fields.baseBranch).toBeUndefined();
    expect(lines(payload.fields.description).at(-1)).toBe("base_branch: main");
  });

  it("a pr_url that is not a GitHub PR URL is refused the same way, with no GitHub read", async () => {
    const ticketId = await fileAndStart();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("no HTTP call may happen here"); };
    try {
      const res = result(await report({
        ticket_id: ticketId,
        summary: "Delivered.",
        pr_url: "https://github.example.com/o/r/pull/1",
        workflow_id: WF,
      }));
      expect(res).toMatchObject({ ok: false, reason: "main_fix_requires_pr", detail: "pr_url_not_a_github_pr", missing: ["pr_url"] });
      expect(h.state.s3Puts).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("a well-formed PR that GitHub says targets the integration branch is refused — the actual TEAM-4663 delivery", async () => {
    const ticketId = await fileAndStart();
    const originalFetch = globalThis.fetch;
    process.env.GITHUB_TOKEN = "gh-test-token";
    globalThis.fetch = async () => new Response(
      JSON.stringify({ base: { ref: "feature/TEAM-4734--si-system-binding-gate-resolution-deplo" } }),
      { status: 200 }
    );
    try {
      const res = result(await report({ ticket_id: ticketId, summary: "Delivered.", pr_url: PR, workflow_id: WF }));
      expect(res).toMatchObject({ ok: false, reason: "main_fix_requires_pr", detail: "pr_base_not_main", missing: ["pr_url"] });
      expect(h.state.s3Puts).toHaveLength(0);
      expect(h.state.items[ticketId].status).toBe("in_progress");
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("the PR to main is recorded and the twin's own DL-030 guard then admits the Done", async () => {
    const ticketId = await fileAndStart();
    const originalFetch = globalThis.fetch;
    process.env.GITHUB_TOKEN = "gh-test-token";
    globalThis.fetch = async () => new Response(JSON.stringify({ base: { ref: "main" } }), { status: 200 });
    try {
      const res = result(await report({ ticket_id: ticketId, summary: "Delivered to main.", pr_url: PR, workflow_id: WF }));
      expect(res.status).toBe("complete");
      // The record exists, says it is not provisional, and carries the open PR …
      const rec = record(ticketId);
      expect(rec.followUpsPending).toBe(false);
      expect(rec.status).toBe("complete");
      expect(rec.delivery).toEqual({ prUrl: PR, prState: "open" });
      // … which is what lets the ship-phase ticket close: the twin's DL-030 guard
      // reads that same record through the same S3 seam.
      expect(h.state.items[ticketId].status).toBe("done");
      expect(h.state.calls.map((c) => c.tool)).toEqual(["Tickets___get_issue", "Tickets___transition_ticket"]);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.GITHUB_TOKEN;
    }
  });
});

describe("both twins state the same thing (banner + base_branch line)", () => {
  it("the jira twin's flattened description is line-for-line the tickets twin's", async () => {
    // The tickets twin's stored description …
    await filedFix();
    const ddbLines = lines(h.state.puts.at(-1).description);

    // … against the jira twin's, driven through the same create args. `adfToText` is
    // the jira twin's own flattener, so neither side's prose is written down here:
    // gateFreezeBanner is not exported from either module, and this is what proves
    // the two copies have not drifted.
    const { handler: jiraHandler, adfToText } = await import("../agentcore-hub-jira/index.mjs");
    const originalFetch = globalThis.fetch;
    let createdFields = null;
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method || "GET";
      if (url.includes("/rest/api/3/search/jql")) {
        const jql = decodeURIComponent(new URL(url).searchParams.get("jql") || "");
        // The sibling scan and the idempotency dedupe hit the same endpoint.
        if (!jql.startsWith(`parent = ${EPIC}`)) return new Response(JSON.stringify({ issues: [] }), { status: 200 });
        return new Response(JSON.stringify({
          issues: [
            { key: CD, fields: { summary: "CD: merge and deploy the TEAM-4734 epic", status: { name: "In Progress" }, labels: ["agent:agentcore_hub_release_manager", "phase:ship"], created: "2026-09-10T10:00:00Z" } },
            { key: GATE, fields: { summary: "Merge Approval: TEAM-4734", status: { name: "In Review" }, labels: ["human-review", "reviewer:tycen"], created: "2026-09-10T11:00:00Z" } },
          ],
        }), { status: 200 });
      }
      if (url.endsWith("/rest/api/3/issue") && method === "POST") {
        createdFields = JSON.parse(options.body).fields;
        return new Response(JSON.stringify({ key: "TEAM-4763" }), { status: 201 });
      }
      if (url.includes("/transitions") && method === "GET") {
        return new Response(JSON.stringify({ transitions: [{ id: "41", name: "Blocked", to: { name: "Blocked" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    try {
      const res = await jiraHandler({
        tool_name: "Tickets___create_ticket",
        parameters: {
          summary: "Fix: deliver the FR-5 base-branch check to main",
          description: FIX_BODY,
          issue_type: "Task",
          parent_key: EPIC,
          assignee: "agentcore_hub_api_dev",
          workflow_id: WF,
          phase: "ship",
          base_branch: "main",
        },
      });
      expect(res.base_branch).toBe("main");
      expect(res.autowired).toEqual({ reason: "open_gate", blockedBy: [CD], gateTicketId: GATE });
      expect(lines(adfToText(createdFields.description))).toEqual(ddbLines);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
