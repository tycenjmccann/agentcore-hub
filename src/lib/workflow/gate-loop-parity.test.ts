import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4739 WP2 — the two `createTicket` gate seams, through BOTH ticket providers.
 *
 * `refuseGateLoop` closes the ENVIRONMENTAL LOOP: an agent that cannot make CI run
 * files "CI is unavailable" again, and again, and again, each time believing it is
 * reporting news. The third one under the same epic, against the same target, is not
 * new work — it is the same fact restated, and the run needs a human, not another
 * ticket. `validateGateTicketShape` closes the other half: a `gate:deploy-approval`
 * ticket nobody can act on (no execution bound, no pipeline, no console link) pages a
 * human who then has nothing to click.
 *
 * BOTH FAIL OPEN, and that is the property most worth pinning. A creation wall that
 * trips whenever a read fails is not a guard, it is a wedge — the agent cannot file
 * the ticket AND cannot proceed, with no rung above it. So: an unreadable epic files
 * the ticket, an unreachable capabilities probe files the ticket, and only a
 * SUCCESSFUL read that contradicts the request refuses.
 *
 * Twin parity again: the refusal payload and message an agent reads must not depend
 * on which provider is deployed, so every refusal row runs through both handlers and
 * compares them field by field.
 */

vi.hoisted(() => {
  process.env.PIPELINE_TOOLS_LAMBDA = "hub-pipeline-tools";
  process.env.EVENTS_TABLE = "agentcore-hub-events";
  process.env.TICKETS_TABLE = "agentcore-hub-tickets";
  process.env.PROJECT_KEY = "TEAM";
  process.env.JIRA_SITE_URL = "example.atlassian.net";
  process.env.JIRA_EMAIL = "bot@example.com";
  process.env.JIRA_API_TOKEN = "token";
  process.env.JIRA_PROJECT_KEY = "TEAM";
  delete process.env.ARTIFACT_BUCKET;
});

const h = vi.hoisted(() => ({
  probes: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  probeBy: {} as Record<string, { result?: unknown; throws?: string }>,
  events: [] as Array<Record<string, unknown>>,
  ddb: {
    items: {} as Record<string, Record<string, unknown>>,
    siblings: [] as Array<Record<string, unknown>>,
    /** Set to a name to make the sibling Query throw. */
    queryThrows: "" as string,
    created: [] as Array<Record<string, unknown>>,
    labelUpdates: [] as Array<Record<string, unknown>>,
  },
  jira: {
    issues: {} as Record<string, { labels: string[] }>,
    /** Raw Jira issues the `parent = X` search returns. */
    siblings: [] as Array<Record<string, unknown>>,
    searchThrows: false,
    writes: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>,
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd: { input: { Payload: Uint8Array } }) {
      const req = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      h.probes.push({ tool: req.tool_name, args: req.parameters });
      const plan = h.probeBy[req.tool_name];
      if (!plan || plan.throws) {
        const err = new Error(plan?.throws || "unreachable");
        err.name = plan?.throws || "TimeoutError";
        throw err;
      }
      return {
        Payload: Buffer.from(
          JSON.stringify({ content: [{ type: "text", text: JSON.stringify(plan.result, null, 2) }] })
        ),
      };
    }
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      const err = new Error("NotFound");
      err.name = "NotFound";
      throw err;
    }
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
  HeadObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand {
    constructor(public input: { TableName: string; Item: Record<string, unknown> }) {}
  }
  class GetCommand {
    constructor(public input: { Key: { ticketId: string } }) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class QueryCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class ScanCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    PutCommand,
    GetCommand,
    UpdateCommand,
    QueryCommand,
    ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: async (cmd: any) => {
          const name = cmd.constructor.name;
          if (name === "PutCommand") {
            // A journey event and a new ticket both arrive as a Put; `eventId` is
            // what tells them apart.
            if (cmd.input.Item?.eventId) h.events.push(cmd.input.Item);
            else h.ddb.created.push(cmd.input.Item);
            return {};
          }
          if (name === "GetCommand") return { Item: h.ddb.items[cmd.input.Key.ticketId] };
          if (name === "QueryCommand") {
            if (h.ddb.queryThrows) {
              const err = new Error("scan failed");
              err.name = h.ddb.queryThrows;
              throw err;
            }
            return { Items: h.ddb.siblings };
          }
          if (name === "UpdateCommand") {
            const label = cmd.input.ExpressionAttributeValues?.[":label"];
            if (label !== undefined) {
              const row = h.ddb.items[cmd.input.Key.ticketId];
              const have = Array.isArray(row?.labels) ? (row.labels as string[]) : [];
              if (!row || have.includes(label as string)) {
                const err = new Error("conditional");
                err.name = "ConditionalCheckFailedException";
                throw err;
              }
              h.ddb.labelUpdates.push(cmd.input);
              row.labels = [...have, label as string];
              return {};
            }
            // nextTicketId's counter bump.
            return { Attributes: { nextNum: 901 } };
          }
          return {};
        },
      }),
    },
  };
});

import { handler as ticketsHandler } from "../../../lambda/agentcore-hub-tickets/index.mjs";
import { handler as jiraHandler } from "../../../lambda/agentcore-hub-jira/index.mjs";

const EPIC = "TEAM-1";
const PIPELINE = "hub-x-deploy";
const EXEC = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SHA = "b".repeat(40);
const CONSOLE = `https://console.aws.amazon.com/codesuite/codepipeline/pipelines/${PIPELINE}/view?region=us-east-1`;

function installJiraFetch() {
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(String(options.body)) : {};
    if (method !== "GET") h.jira.writes.push({ method, path, body });
    const ok = (payload: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(payload ?? {}) });

    if (/\/search\/jql/.test(path)) {
      if (/parent%20%3D|parent\+%3D/.test(path)) {
        if (h.jira.searchThrows) return { status: 500, ok: false, text: async () => JSON.stringify({ errorMessages: ["boom"] }) };
        return ok({ issues: h.jira.siblings });
      }
      return ok({ issues: [] }); // the idempotency guard's own search
    }
    const keyMatch = /^\/rest\/api\/3\/issue\/([^/?]+)/.exec(path);
    if (keyMatch && method === "GET") {
      const issue = h.jira.issues[keyMatch[1]];
      if (!issue) return { status: 404, ok: false, text: async () => JSON.stringify({ errorMessages: ["not found"] }) };
      return ok({ key: keyMatch[1], fields: { labels: issue.labels, issuetype: { name: "Epic" } } });
    }
    if (path === "/rest/api/3/issue" && method === "POST") return ok({ key: "TEAM-901", id: "901" });
    if (keyMatch && method === "PUT") {
      const issue = h.jira.issues[keyMatch[1]];
      for (const op of body?.update?.labels || []) {
        if (op.add && issue && !issue.labels.includes(op.add)) issue.labels.push(op.add);
      }
      return { status: 204, ok: true, text: async () => "" };
    }
    return ok({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

interface Scenario {
  labels: string[];
  description?: string;
  blocked_by?: string | string[];
  parent_key?: string;
  /** DynamoDB sibling rows / Jira sibling issues, described once. */
  siblings?: Array<{ id: string; labels: string[]; blockedBy?: string[] }>;
  epicLabels?: string[];
  caps?: unknown;
  scanFails?: boolean;
}

interface Run {
  refused: boolean;
  payload: Record<string, unknown> | null;
  message: string;
  probes: Array<{ tool: string; args: Record<string, unknown> }>;
  events: Array<Record<string, unknown>>;
  epicLabels: string[];
}

function seed(scn: Scenario) {
  h.probes.length = 0;
  h.events.length = 0;
  h.probeBy = scn.caps === undefined ? {} : { Pipeline___capabilities: { result: scn.caps } };
}

async function runTickets(scn: Scenario): Promise<Run> {
  seed(scn);
  h.ddb.created.length = 0;
  h.ddb.labelUpdates.length = 0;
  h.ddb.queryThrows = scn.scanFails ? "ProvisionedThroughputExceededException" : "";
  h.ddb.items = {
    [EPIC]: { ticketId: EPIC, type: "epic", workflowId: "wf_1", labels: [...(scn.epicLabels || [])] },
  };
  h.ddb.siblings = (scn.siblings || []).map((s) => ({
    ticketId: s.id,
    labels: s.labels,
    ...(s.blockedBy ? { blockedBy: s.blockedBy } : {}),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await ticketsHandler({
    _tool_name: "Tickets___create_ticket",
    tool_name: "Tickets___create_ticket",
    parameters: {
      summary: "CI is unavailable for this branch",
      description: scn.description ?? "",
      labels: scn.labels,
      parent_key: scn.parent_key === undefined ? EPIC : scn.parent_key,
      ...(scn.blocked_by ? { blocked_by: scn.blocked_by } : {}),
    },
  });
  return {
    refused: res?.ok === false,
    payload: res?.ok === false ? strip(res) : null,
    message: res?.content?.[0]?.text ?? "",
    probes: [...h.probes],
    events: [...h.events],
    epicLabels: (h.ddb.items[EPIC].labels as string[]) || [],
  };
}

async function runJira(scn: Scenario): Promise<Run> {
  seed(scn);
  installJiraFetch();
  h.jira.writes.length = 0;
  h.jira.searchThrows = Boolean(scn.scanFails);
  // Jira has no place to put a workflow id, so the epic carries `wf:<id>` as a
  // label — that label IS the Jira equivalent of the DynamoDB row's `workflowId`
  // attribute, and it is where the event's run attribution comes from (SEC-16: off
  // the epic, never off a caller-supplied argument).
  h.jira.issues = { [EPIC]: { labels: ["wf:wf_1", ...(scn.epicLabels || [])] } };
  h.jira.siblings = (scn.siblings || []).map((s) => ({
    key: s.id,
    fields: {
      summary: "prior gate",
      status: { name: "To Do" },
      labels: s.labels,
      issuelinks: (s.blockedBy || []).map((b) => ({ type: { name: "Blocks" }, inwardIssue: { key: b } })),
    },
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await jiraHandler({
    _tool_name: "Tickets___create_ticket",
    tool_name: "Tickets___create_ticket",
    parameters: {
      summary: "CI is unavailable for this branch",
      description: scn.description ?? "",
      labels: scn.labels,
      parent_key: scn.parent_key === undefined ? EPIC : scn.parent_key,
      ...(scn.blocked_by ? { blocked_by: scn.blocked_by } : {}),
    },
  });
  return {
    refused: res?.ok === false,
    payload: res?.ok === false ? strip(res) : null,
    message: res?.error ?? "",
    probes: [...h.probes],
    events: [...h.events],
    epicLabels: h.jira.issues[EPIC].labels,
  };
}

/** The refusal fields both twins must agree on, without either's envelope. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function strip(res: any) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { content, error, ...rest } = res;
  return rest;
}

const CI_GATE = ["gate:ci-unavailable", `pipeline:${PIPELINE}`, `head:${SHA}`];
const prior = (id: string, extra: string[] = []) => ({
  id,
  labels: ["gate-ci-unavailable", `head-${SHA}`, ...extra],
});

beforeEach(() => {
  h.ddb.siblings = [];
  h.jira.siblings = [];
  h.ddb.queryThrows = "";
  h.jira.searchThrows = false;
});

// ─────────────────────────────────────────────────────────────────────────────

describe("refuseGateLoop — the third identical gate is not new work", () => {
  it("the FIRST gate ticket is created (no priors)", async () => {
    for (const run of [await runTickets({ labels: CI_GATE }), await runJira({ labels: CI_GATE })]) {
      expect(run.refused).toBe(false);
      expect(run.events).toHaveLength(0);
      expect(run.epicLabels).not.toContain("gate:loop-broken");
    }
  });

  it("the SECOND is created too — one repeat is a retry, not a loop", async () => {
    const scn: Scenario = { labels: CI_GATE, siblings: [prior("TEAM-800")] };
    for (const run of [await runTickets(scn), await runJira(scn)]) {
      expect(run.refused).toBe(false);
      expect(run.events).toHaveLength(0);
    }
  });

  it("the THIRD is refused identically by both twins, and pages once", async () => {
    const scn: Scenario = { labels: CI_GATE, siblings: [prior("TEAM-800"), prior("TEAM-810")] };
    const t = await runTickets(scn);
    const j = await runJira(scn);

    expect(t.payload).toEqual({
      ok: false,
      reason: "gate_loop_environmental",
      existingTicketId: "TEAM-800",
    });
    expect(j.payload, "payload parity").toEqual(t.payload);
    expect(j.message, "message parity").toBe(t.message);

    // The remedy is the EXISTING ticket, named — an agent told only "refused"
    // files a fourth one somewhere else.
    expect(t.message).toContain("TEAM-800, TEAM-810");
    expect(t.message).toContain("Work the existing ticket TEAM-800");
    expect(t.message).toContain("environmental loop, not new work");
    expect(t.message).toContain(EPIC);

    for (const [who, run] of [["dynamodb", t], ["jira", j]] as Array<[string, Run]>) {
      expect(run.epicLabels, `${who} marks the epic`).toContain("gate:loop-broken");
      expect(run.events.map((e) => e.type), `${who} pages once`).toEqual(["workflow.blocked"]);
      expect(run.events[0]).toMatchObject({
        workflowId: "wf_1",
        detail: {
          reason: "environmental",
          gateKind: "ci-unavailable",
          blockedByTicketId: "TEAM-800",
          head: SHA,
          // `attempt` is how many already EXIST (2 at the threshold), not a
          // counter of our own — nothing here is stateful enough to keep one.
          attempt: 2,
        },
      });
    }
  });

  it("the FOURTH refuses with the same payload and emits NOTHING", async () => {
    // The epic already carries the marker, which is the event dedupe in both twins
    // (a conditional add's outcome in DynamoDB, a before/after label read in Jira).
    const scn: Scenario = {
      labels: CI_GATE,
      siblings: [prior("TEAM-800"), prior("TEAM-810"), prior("TEAM-820")],
      epicLabels: ["gate:loop-broken"],
    };
    const t = await runTickets(scn);
    const j = await runJira(scn);
    expect(t.refused).toBe(true);
    expect(j.payload).toEqual(t.payload);
    expect(t.events, "no second page (dynamodb)").toHaveLength(0);
    expect(j.events, "no second page (jira)").toHaveLength(0);
    expect(h.ddb.labelUpdates, "no redundant label write").toHaveLength(0);
  });

  it("a DIFFERENT gate kind is not a prior", async () => {
    const scn: Scenario = {
      labels: CI_GATE,
      siblings: [
        { id: "TEAM-800", labels: ["gate-deploy-approval", `head-${SHA}`] },
        { id: "TEAM-810", labels: ["gate-blocker", `head-${SHA}`] },
      ],
    };
    expect((await runTickets(scn)).refused).toBe(false);
    expect((await runJira(scn)).refused).toBe(false);
  });

  it("a different TARGET is not a prior", async () => {
    const other = "c".repeat(40);
    const scn: Scenario = {
      labels: CI_GATE,
      siblings: [
        { id: "TEAM-800", labels: ["gate-ci-unavailable", `head-${other}`] },
        { id: "TEAM-810", labels: ["gate-ci-unavailable", `head-${other}`] },
      ],
    };
    expect((await runTickets(scn)).refused).toBe(false);
    expect((await runJira(scn)).refused).toBe(false);
  });

  it("an overlapping blocked_by set is the same target when there is no head", async () => {
    const scn: Scenario = {
      labels: ["gate:blocker"],
      blocked_by: ["TEAM-500", "TEAM-501"],
      siblings: [
        { id: "TEAM-800", labels: ["gate-blocker"], blockedBy: ["TEAM-501"] },
        { id: "TEAM-810", labels: ["gate-blocker"], blockedBy: ["TEAM-500", "TEAM-999"] },
      ],
    };
    const t = await runTickets(scn);
    const j = await runJira(scn);
    expect(t.refused).toBe(true);
    // Jira's gather asks for `issuelinks` explicitly — listTickets' lean field set
    // returns no blockedBy at all, so without that request this row would silently
    // stop refusing on Jira while still refusing on DynamoDB.
    expect(j.payload).toEqual(t.payload);
  });

  it("`gate:approval` is NEVER a loop — re-filing it is the one escalation path", async () => {
    const scn: Scenario = {
      labels: ["gate:approval"],
      siblings: [
        { id: "TEAM-800", labels: ["gate-approval"] },
        { id: "TEAM-810", labels: ["gate-approval"] },
        { id: "TEAM-820", labels: ["gate-approval"] },
      ],
    };
    expect((await runTickets(scn)).refused, "dynamodb").toBe(false);
    expect((await runJira(scn)).refused, "jira").toBe(false);
  });

  it("a non-gate ticket is not scanned at all", async () => {
    const scn: Scenario = { labels: ["needs-docs"], siblings: [prior("TEAM-800"), prior("TEAM-810")] };
    expect((await runTickets(scn)).refused).toBe(false);
    expect(h.jira.writes.filter((w) => /search/.test(w.path))).toHaveLength(0);
  });

  it("no parent_key ⇒ no scan, no refusal (an orphan has no siblings to count)", async () => {
    const scn: Scenario = { labels: CI_GATE, parent_key: "", siblings: [prior("TEAM-800"), prior("TEAM-810")] };
    expect((await runTickets(scn)).refused).toBe(false);
    expect((await runJira(scn)).refused).toBe(false);
  });

  it("FAILS OPEN: an unreadable epic files the ticket", async () => {
    // A loop breaker that blocks creation whenever it cannot read is a wedge, not
    // a guard — there is no rung above the agent to lift it.
    const scn: Scenario = {
      labels: CI_GATE,
      siblings: [prior("TEAM-800"), prior("TEAM-810")],
      scanFails: true,
    };
    expect((await runTickets(scn)).refused, "dynamodb").toBe(false);
    expect((await runJira(scn)).refused, "jira").toBe(false);
  });

  it("an unlabelable epic still refuses — the marker is the dedupe, not the verdict", async () => {
    // The epic row is missing, so the conditional label add fails. The refusal must
    // survive: the ticket count is the loop evidence, and losing the marker only
    // costs a duplicate page.
    const scn: Scenario = { labels: CI_GATE, siblings: [prior("TEAM-800"), prior("TEAM-810")] };
    seed(scn);
    h.ddb.created.length = 0;
    h.ddb.items = {}; // no epic row at all
    h.ddb.siblings = [
      { ticketId: "TEAM-800", labels: prior("TEAM-800").labels },
      { ticketId: "TEAM-810", labels: prior("TEAM-810").labels },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await ticketsHandler({
      _tool_name: "Tickets___create_ticket",
      tool_name: "Tickets___create_ticket",
      parameters: { summary: "CI is unavailable", labels: CI_GATE, parent_key: EPIC },
    });
    expect(res.reason).toBe("gate_loop_environmental");
    expect(h.ddb.created, "no ticket minted").toHaveLength(0);
  });

  it("a refusal costs no ticket number", async () => {
    // Same rule the fix-contract enforce path follows: mint nothing on a refusal,
    // so a looping agent does not burn the counter it shares with every run.
    await runTickets({ labels: CI_GATE, siblings: [prior("TEAM-800"), prior("TEAM-810")] });
    expect(h.ddb.created).toHaveLength(0);
    await runJira({ labels: CI_GATE, siblings: [prior("TEAM-800"), prior("TEAM-810")] });
    expect(h.jira.writes.filter((w) => w.path === "/rest/api/3/issue")).toHaveLength(0);
  });

  it("jira: the seams run BEFORE the idempotency guard, which fails open", async () => {
    // The guard swallows its own errors and proceeds to create. If the seams sat
    // after it, a dedupe read that threw would carry a looping gate straight
    // through to creation.
    const scn: Scenario = { labels: CI_GATE, siblings: [prior("TEAM-800"), prior("TEAM-810")] };
    seed(scn);
    installJiraFetch();
    h.jira.writes.length = 0;
    h.jira.issues = { [EPIC]: { labels: [] } };
    h.jira.siblings = [
      { key: "TEAM-800", fields: { labels: prior("TEAM-800").labels, status: { name: "To Do" } } },
      { key: "TEAM-810", fields: { labels: prior("TEAM-810").labels, status: { name: "To Do" } } },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await jiraHandler({
      _tool_name: "Tickets___create_ticket",
      tool_name: "Tickets___create_ticket",
      // workflow_id is what arms the idempotency search at all.
      parameters: { summary: "CI is unavailable", labels: CI_GATE, parent_key: EPIC, workflow_id: "wf_1" },
    });
    expect(res.reason).toBe("gate_loop_environmental");
    expect(h.jira.writes.filter((w) => w.path === "/rest/api/3/issue")).toHaveLength(0);
  });
});

describe("validateGateTicketShape — a deploy gate a human can act on", () => {
  const CAPS = { ok: true, approveDeploy: false, version: 4 };
  const withLink = `Approve the deploy for this run.\n\nConsole: ${CONSOLE}`;

  const ROWS: Array<[string, Scenario, string | null]> = [
    [
      "two exec labels ⇒ refuse",
      { labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`, `exec:${"1".repeat(8)}-2222-3333-4444-555555555555`], description: withLink, caps: CAPS },
      "exactly one `exec:<execution-id>` label (found 2)",
    ],
    [
      "no exec label ⇒ refuse",
      { labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`], description: withLink, caps: CAPS },
      "exactly one `exec:<execution-id>` label (found 0)",
    ],
    [
      "no pipeline label ⇒ refuse",
      { labels: ["gate:deploy-approval", `exec:${EXEC}`], description: withLink, caps: CAPS },
      "exactly one `pipeline:<name>` label (found 0)",
    ],
    [
      "the pipeline is not in the CD registry ⇒ refuse",
      {
        labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`],
        description: withLink,
        caps: { ok: false, reason: "pipeline_not_registered" },
      },
      "is not one the hub may reach (pipeline_not_registered)",
    ],
    [
      "no console link in the description ⇒ refuse",
      { labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`], description: "please approve", caps: CAPS },
      "must carry the console link",
    ],
    [
      "bound, registered and linked ⇒ create",
      { labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`], description: withLink, caps: CAPS },
      null,
    ],
    [
      "FAILS OPEN: the capabilities probe is unreachable ⇒ create",
      { labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`], description: "please approve" },
      null,
    ],
    [
      "a ci-unavailable gate is not shape-checked (nothing to bind)",
      { labels: ["gate:ci-unavailable", `head:${SHA}`], caps: CAPS },
      null,
    ],
    [
      "a blocker gate is not shape-checked",
      { labels: ["gate:blocker"], caps: CAPS },
      null,
    ],
  ];

  it.each(ROWS)("%s", async (_name, scn, expectedHint) => {
    const t = await runTickets(scn);
    const j = await runJira(scn);
    if (expectedHint === null) {
      expect(t.refused, "dynamodb creates").toBe(false);
      expect(j.refused, "jira creates").toBe(false);
      return;
    }
    expect(t.refused, "dynamodb refuses").toBe(true);
    expect(t.payload?.reason).toBe("gate_condition_unmet");
    expect(String(t.payload?.hint)).toContain(expectedHint);
    // The hint IS the message in both twins — the agent reads one string.
    expect(t.message).toBe(t.payload?.hint);
    expect(j.payload, "payload parity").toEqual(t.payload);
    expect(j.message, "message parity").toBe(t.message);
  });

  it("the probe is a capabilities read on the labelled pipeline, and nothing more", async () => {
    await runTickets({
      labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`],
      description: withLink,
      caps: CAPS,
    });
    expect(h.probes).toEqual([{ tool: "Pipeline___capabilities", args: { pipeline_name: PIPELINE } }]);
  });

  it("a non-deploy gate makes NO probe", async () => {
    await runTickets({ labels: ["gate:ci-unavailable", `head:${SHA}`], caps: CAPS });
    expect(h.probes).toHaveLength(0);
    await runJira({ labels: ["gate:blocker"], caps: CAPS });
    expect(h.probes).toHaveLength(0);
  });

  it("the console-link check accepts the bare path, not just the full URL", async () => {
    // Agents paste the link in whatever form the console gave them; requiring one
    // exact string would refuse a gate that is in fact perfectly actionable.
    for (const description of [
      `see ${CONSOLE}`,
      `see https://us-east-1.console.aws.amazon.com/codesuite/codepipeline/pipelines/${PIPELINE}/view?region=us-east-1`,
      `[approve](/codesuite/codepipeline/pipelines/${PIPELINE}/view)`,
    ]) {
      const run = await runTickets({
        labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`],
        description,
        caps: CAPS,
      });
      expect(run.refused, `should create for: ${description}`).toBe(false);
    }
  });

  it("the loop seam runs FIRST — a looping deploy gate reports the loop, not the shape", async () => {
    // Order matters for the agent's next action: "work TEAM-800" is actionable,
    // "add a console link" invites a fourth ticket with a link.
    const scn: Scenario = {
      labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`, `exec:${EXEC}`],
      description: "no link here",
      caps: CAPS,
      blocked_by: ["TEAM-500"],
      siblings: [
        { id: "TEAM-800", labels: ["gate-deploy-approval"], blockedBy: ["TEAM-500"] },
        { id: "TEAM-810", labels: ["gate-deploy-approval"], blockedBy: ["TEAM-500"] },
      ],
    };
    const t = await runTickets(scn);
    expect(t.payload?.reason).toBe("gate_loop_environmental");
    expect(h.probes, "the shape probe never runs").toHaveLength(0);
    expect((await runJira(scn)).payload).toEqual(t.payload);
  });
});

describe("an over-long pipeline: label is refused, not silently renamed (TEAM-4750 B3)", () => {
  // sanitizeUserLabels truncates a label to 64 chars, which used to leave a 55-char
  // pipeline name that STILL matched PIPELINE_LABEL_RE — so the shape check and the
  // probe ran against a pipeline nobody had named, and the human was eventually
  // paged about it. Refused on the RAW label instead, before truncation.
  const name = (len: number) => "h" + "u".repeat(len - 1);
  const CAPS = { ok: true, approveDeploy: true, version: 4 };

  it("both twins refuse identically, naming the limit, before any probe", async () => {
    const scn: Scenario = {
      labels: ["gate:deploy-approval", `pipeline:${name(56)}`, `exec:${EXEC}`],
      description: `Console: ${CONSOLE}`,
      caps: CAPS,
    };
    const t = await runTickets(scn);
    const j = await runJira(scn);

    expect(t.refused, "dynamodb refuses").toBe(true);
    expect(j.refused, "jira refuses").toBe(true);
    expect(t.payload?.reason).toBe("gate_condition_unmet");
    // Both caps by number: the label cap it broke, and the name cap to aim at.
    expect(String(t.payload?.hint)).toContain("64-character limit");
    expect(String(t.payload?.hint)).toContain("at most 55");
    expect(t.message).toBe(t.payload?.hint);
    expect(j.payload, "payload parity").toEqual(t.payload);
    expect(j.message, "message parity").toBe(t.message);

    // It is the FIRST seam: nothing was read, nothing was written, and on the
    // DynamoDB side not even a ticket number was minted.
    expect(t.probes, "refuses before the capabilities probe").toHaveLength(0);
    expect(j.probes, "refuses before the capabilities probe").toHaveLength(0);
    expect(h.ddb.created, "no ticket row").toHaveLength(0);
  });

  it("a name at the cap — a 64-char label — is created", async () => {
    const scn: Scenario = {
      labels: ["gate:deploy-approval", `pipeline:${name(55)}`, `exec:${EXEC}`],
      description: `Console: ${CONSOLE}`,
      caps: CAPS,
    };
    expect(`pipeline:${name(55)}`).toHaveLength(64);
    expect((await runTickets(scn)).refused, "dynamodb creates").toBe(false);
    expect((await runJira(scn)).refused, "jira creates").toBe(false);
  });

  it("the hyphen spelling is refused too, and a long non-pipeline label is not", async () => {
    const hyphen: Scenario = { labels: ["gate:blocker", `pipeline-${name(56)}`] };
    expect((await runTickets(hyphen)).payload?.reason).toBe("gate_condition_unmet");
    expect((await runJira(hyphen)).payload?.reason).toBe("gate_condition_unmet");
    // Only the `pipeline:` namespace is forwarded to a probe, so only it is capped.
    const other: Scenario = { labels: ["gate:blocker", `needs-${name(90)}`] };
    expect((await runTickets(other)).refused).toBe(false);
    expect((await runJira(other)).refused).toBe(false);
  });
});
