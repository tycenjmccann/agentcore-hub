import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4739 WP2 — the typed gate guard, driven through BOTH ticket providers.
 *
 * The guard answers ONE question on a `→ done` transition: **may this gate ticket
 * close?** Its dangerous failure mode is an UNLIFTABLE STALL — there is no
 * escalation rung above the human, so a gate the system refuses to let anyone close
 * wedges the run forever. It therefore refuses ONLY on a definite negative (a
 * SUCCESSFUL probe read whose content contradicts the close) and ADMITS everything
 * indeterminate, stamping `gateVerification:"indeterminate"` so the close is still
 * auditable.
 *
 * That direction is the single most valuable thing this file pins. A future edit
 * that "hardens" the guard into refusing on a probe failure would pass every
 * happy-path test and take production down the first time the pipeline-tools Lambda
 * is throttled — so every failure mode below has its own row asserting ADMIT.
 *
 * The second thing it pins is TWIN PARITY. Both Lambdas expose the identical
 * `Tickets___*` tool interface and agents do not know which one is deployed; if one
 * refuses where the other admits, or phrases the same refusal differently, the agent
 * takes a different next action on Jira than on DynamoDB. Every row therefore runs
 * through both handlers and asserts the refusal payload is IDENTICAL, not merely
 * equivalent.
 */

// ── Env, hoisted above the twins' module-level `const … = process.env.X` reads ──
vi.hoisted(() => {
  process.env.PIPELINE_TOOLS_LAMBDA = "hub-pipeline-tools";
  process.env.EVENTS_TABLE = "agentcore-hub-events";
  process.env.TICKETS_TABLE = "agentcore-hub-tickets";
  process.env.PROJECT_KEY = "TEAM";
  process.env.JIRA_SITE_URL = "example.atlassian.net";
  process.env.JIRA_EMAIL = "bot@example.com";
  process.env.JIRA_API_TOKEN = "token";
  process.env.JIRA_PROJECT_KEY = "TEAM";
  // Deliberately NOT set: ARTIFACT_BUCKET. Both twins then fall back to their
  // hardcoded roster, and no test row accidentally depends on an S3 read.
  delete process.env.ARTIFACT_BUCKET;
});

type ProbeCall = { tool: string; args: Record<string, unknown> };
type Probe = { tool: string; result?: unknown; throws?: string; functionError?: string; raw?: string };

const h = vi.hoisted(() => ({
  /** Every probe the guard made, in order — so "made no probe" is assertable. */
  probes: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  /** What the next probe returns, by tool name. Absent ⇒ the probe throws. */
  probeBy: {} as Record<string, { result?: unknown; throws?: string; functionError?: string; raw?: string }>,
  /** Journey events written through publishJourneyEvent (both twins). */
  events: [] as Array<Record<string, unknown>>,
  /** DynamoDB twin state. */
  ddb: {
    items: {} as Record<string, Record<string, unknown>>,
    statusUpdates: [] as Array<Record<string, unknown>>,
    labelUpdates: [] as Array<Record<string, unknown>>,
  },
  /** Jira twin state. */
  jira: {
    /** Issues by key: `{labels, description, status}`. */
    issues: {} as Record<string, { labels: string[]; description?: unknown; status?: string }>,
    /** Every non-GET request, as `{method, path, body}`. */
    writes: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>,
  },
}));

// ── One mock per AWS package; BOTH twins resolve to these ────────────────────
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd: { input: { Payload: Uint8Array } }) {
      const req = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      h.probes.push({ tool: req.tool_name, args: req.parameters });
      const plan = h.probeBy[req.tool_name];
      if (!plan) {
        const err = new Error("connection reset");
        err.name = "TimeoutError";
        throw err;
      }
      if (plan.throws) {
        const err = new Error(plan.throws);
        err.name = plan.throws;
        throw err;
      }
      if (plan.functionError) return { FunctionError: plan.functionError, Payload: Buffer.from("{}") };
      // The tools Lambda's real MCP envelope: jsonResult() double-encodes, so the
      // probe must double-parse. Feeding the real shape is what proves it does.
      const raw = plan.raw ?? JSON.stringify({ content: [{ type: "text", text: JSON.stringify(plan.result, null, 2) }] });
      return { Payload: Buffer.from(raw) };
    }
  },
  InvokeCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
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
            // The only PutCommand either twin makes here is a journey event.
            h.events.push(cmd.input.Item);
            return {};
          }
          if (name === "GetCommand") return { Item: h.ddb.items[cmd.input.Key.ticketId] };
          if (name === "QueryCommand") return { Items: [] };
          if (name === "UpdateCommand") {
            const label = cmd.input.ExpressionAttributeValues?.[":label"];
            if (label !== undefined) {
              // addLabels' conditional append. Honour the real condition so the
              // "already present ⇒ no event" dedupe is exercised, not stubbed.
              const row = h.ddb.items[cmd.input.Key.ticketId];
              const have = Array.isArray(row?.labels) ? (row.labels as string[]) : [];
              if (!row || have.includes(label as string)) {
                const err = new Error("The conditional request failed");
                err.name = "ConditionalCheckFailedException";
                throw err;
              }
              h.ddb.labelUpdates.push(cmd.input);
              row.labels = [...have, label as string];
              return {};
            }
            if (cmd.input.ExpressionAttributeValues?.[":s"] !== undefined) {
              h.ddb.statusUpdates.push(cmd.input);
              return {};
            }
            return {};
          }
          return {};
        },
      }),
    },
  };
});

import { handler as ticketsHandler } from "../../../lambda/agentcore-hub-tickets/index.mjs";
import { handler as jiraHandler } from "../../../lambda/agentcore-hub-jira/index.mjs";
import { GATE_CONDITION_UNMET } from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";

// ── The Jira fetch fake ──────────────────────────────────────────────────────
function installJiraFetch() {
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(String(options.body)) : {};
    const ok = (payload: unknown) => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify(payload ?? {}),
    });

    const keyMatch = /^\/rest\/api\/3\/issue\/([^/?]+)/.exec(path);
    const key = keyMatch ? keyMatch[1] : "";
    const issue = h.jira.issues[key];

    if (method !== "GET") h.jira.writes.push({ method, path, body });

    if (/\/transitions$/.test(path) && method === "GET") {
      return ok({ transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] });
    }
    if (/\/transitions$/.test(path) && method === "POST") return { status: 204, ok: true, text: async () => "" };
    if (/\/comment$/.test(path)) return ok({ id: "1" });
    if (keyMatch && method === "PUT") {
      // addLabels: Jira's `add` verb is idempotent server-side, so apply it that way.
      const ops = body?.update?.labels || [];
      for (const op of ops) {
        if (op.add && issue && !issue.labels.includes(op.add)) issue.labels.push(op.add);
        if (op.remove && issue) issue.labels = issue.labels.filter((l) => l !== op.remove);
      }
      return { status: 204, ok: true, text: async () => "" };
    }
    if (keyMatch && method === "GET") {
      if (!issue) return { status: 404, ok: false, text: async () => JSON.stringify({ errorMessages: ["not found"] }) };
      return ok({
        key,
        fields: {
          labels: issue.labels,
          description: issue.description ?? null,
          status: { name: issue.status || "In Review" },
          issuetype: { name: "Task" },
          issuelinks: [],
        },
      });
    }
    if (/\/search\/jql/.test(path)) return ok({ issues: [] });
    return ok({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

// ── The scenario runner ──────────────────────────────────────────────────────
const TICKET = "TEAM-900";
const PIPELINE = "hub-x-deploy";
const EXEC = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SHA = "a".repeat(40);

type Outcome = "REFUSE" | "ADMIT_VERIFIED" | "ADMIT_INDETERMINATE" | "UNSTAMPED";

interface Scenario {
  labels: string[];
  description?: string;
  probes?: Probe[];
}

interface Run {
  outcome: Outcome;
  /** The refusal payload, normalized to the six fields both twins must agree on. */
  payload: Record<string, unknown> | null;
  message: string;
  reason: string | null;
  probes: ProbeCall[];
  events: Array<Record<string, unknown>>;
  labels: string[];
}

function seed(scn: Scenario) {
  h.probes.length = 0;
  h.events.length = 0;
  h.ddb.statusUpdates.length = 0;
  h.ddb.labelUpdates.length = 0;
  h.jira.writes.length = 0;
  h.probeBy = {};
  for (const p of scn.probes || []) {
    h.probeBy[p.tool] = { result: p.result, throws: p.throws, functionError: p.functionError, raw: p.raw };
  }
}

async function runTickets(scn: Scenario): Promise<Run> {
  seed(scn);
  h.ddb.items = {
    [TICKET]: {
      ticketId: TICKET,
      status: "in_review",
      assignee: "human:reviewer",
      labels: [...scn.labels],
      description: scn.description ?? "",
      workflowId: "wf_1",
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await ticketsHandler({
    _tool_name: "Tickets___transition_ticket",
    tool_name: "Tickets___transition_ticket",
    parameters: { ticket_id: TICKET, transition_id: "done" },
  });
  return {
    outcome: classify(res),
    payload: res?.ok === false ? six(res) : null,
    message: res?.content?.[0]?.text ?? "",
    reason: res?.gateVerification?.reason ?? null,
    probes: [...h.probes],
    events: [...h.events],
    labels: (h.ddb.items[TICKET].labels as string[]) || [],
  };
}

async function runJira(scn: Scenario): Promise<Run> {
  seed(scn);
  installJiraFetch();
  h.jira.issues = {
    [TICKET]: { labels: [...scn.labels], description: scn.description ?? "", status: "In Review" },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await jiraHandler({
    _tool_name: "Tickets___transition_ticket",
    tool_name: "Tickets___transition_ticket",
    parameters: { ticket_id: TICKET, transition_id: "done" },
  });
  return {
    outcome: classify(res),
    payload: res?.ok === false ? six(res) : null,
    message: res?.error ?? "",
    reason: res?.gateVerification?.reason ?? null,
    probes: [...h.probes],
    events: [...h.events],
    labels: h.jira.issues[TICKET].labels,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classify(res: any): Outcome {
  if (res?.ok === false && res?.reason === GATE_CONDITION_UNMET) return "REFUSE";
  if (res?.gateVerification?.result === "verified") return "ADMIT_VERIFIED";
  if (res?.gateVerification?.result === "indeterminate") return "ADMIT_INDETERMINATE";
  return "UNSTAMPED";
}

/** The six fields of a refusal that MUST be byte-identical across the twins. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function six(res: any) {
  const { ok, reason, hint, consoleUrl, stage, action } = res;
  return { ok, reason, hint, consoleUrl, stage, action };
}

const DEPLOY_LABELS = [`gate:deploy-approval`, `pipeline:${PIPELINE}`, `exec:${EXEC}`, "wf:wf_1"];
const CI_LABELS = [`gate:ci-unavailable`, `pipeline:${PIPELINE}`, `head:${SHA}`, "wf:wf_1"];

beforeEach(() => {
  h.jira.issues = {};
  h.ddb.items = {};
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the truth table, through BOTH twins", () => {
  // [name, scenario, expected outcome, expected verification sub-reason]
  const ROWS: Array<[string, Scenario, Outcome, string | null]> = [
    // ── gate:deploy-approval — the definite negatives ──
    [
      "deploy: the gate is OPEN on this execution",
      {
        labels: DEPLOY_LABELS,
        probes: [
          {
            tool: "Pipeline___get_state",
            result: { waitingOn: { kind: "human_approval", stage: "Deploy", action: "ApproveDeploy", holdsGate: "this" } },
          },
        ],
      },
      "REFUSE",
      null,
    ],
    [
      "deploy: an OLDER execution holds the gate (named)",
      {
        labels: DEPLOY_LABELS,
        probes: [
          {
            tool: "Pipeline___get_state",
            result: { waitingOn: { stage: "Deploy", action: "ApproveDeploy", holdsGate: "older", queuedBehind: "exec-older" } },
          },
        ],
      },
      "REFUSE",
      null,
    ],
    [
      "deploy: an OLDER execution holds the gate (unnamed)",
      {
        labels: DEPLOY_LABELS,
        probes: [{ tool: "Pipeline___get_state", result: { waitingOn: { stage: "Deploy", holdsGate: "older" } } }],
      },
      "REFUSE",
      null,
    ],
    [
      "deploy: a human REJECTED the approval",
      {
        labels: DEPLOY_LABELS,
        probes: [
          {
            tool: "Pipeline___get_state",
            result: {
              terminal: true,
              matchesExecution: true,
              actionDetails: [{ stage: "Deploy", action: "ApproveDeploy", status: "Failed", summary: "no" }],
            },
          },
        ],
      },
      "REFUSE",
      null,
    ],

    // ── gate:deploy-approval — the proofs ──
    [
      "deploy: our execution was SUPERSEDED",
      {
        labels: DEPLOY_LABELS,
        probes: [{ tool: "Pipeline___get_state", result: { waitingOn: { holdsGate: "older", supersededBy: "exec-newer" } } }],
      },
      "ADMIT_VERIFIED",
      "execution_superseded",
    ],
    [
      "deploy: no pending approval anywhere",
      { labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", result: { waitingOn: null, terminal: false } }] },
      "ADMIT_VERIFIED",
      "no_open_approval",
    ],
    [
      "deploy: terminal, and the stages are OURS",
      {
        labels: DEPLOY_LABELS,
        probes: [
          {
            tool: "Pipeline___get_state",
            result: { terminal: true, matchesExecution: true, waitingOn: { holdsGate: "unknown" } },
          },
        ],
      },
      "ADMIT_VERIFIED",
      "execution_terminal",
    ],

    // ── gate:deploy-approval — everything indeterminate ADMITS ──
    [
      "deploy: the probe could not attribute the open approval",
      { labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", result: { waitingOn: { holdsGate: "unknown" } } }] },
      "ADMIT_INDETERMINATE",
      "gate_holder_unknown",
    ],
    [
      "deploy: terminal, but of some OTHER execution",
      {
        labels: DEPLOY_LABELS,
        probes: [
          {
            tool: "Pipeline___get_state",
            result: { terminal: true, matchesExecution: false, waitingOn: { holdsGate: "unknown" } },
          },
        ],
      },
      "ADMIT_INDETERMINATE",
      "gate_holder_unknown",
    ],
    [
      "deploy: the probe THREW (timeout)",
      { labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", throws: "TimeoutError" }] },
      "ADMIT_INDETERMINATE",
      "probe_failed",
    ],
    [
      "deploy: the probe returned a FunctionError",
      { labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", functionError: "Unhandled" }] },
      "ADMIT_INDETERMINATE",
      "probe_failed",
    ],
    [
      "deploy: the probe payload was not the MCP envelope",
      { labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", raw: "not json at all" }] },
      "ADMIT_INDETERMINATE",
      "probe_failed",
    ],
    [
      "deploy: the pipeline is not in the CD registry",
      {
        labels: DEPLOY_LABELS,
        probes: [{ tool: "Pipeline___get_state", result: { ok: false, reason: "pipeline_not_registered" } }],
      },
      "ADMIT_INDETERMINATE",
      "probe_unanswerable",
    ],
    [
      "deploy: the pipeline module is not configured",
      { labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", result: { configured: false } }] },
      "ADMIT_INDETERMINATE",
      "probe_unanswerable",
    ],
    [
      "deploy: UNBOUND — no exec: label",
      { labels: ["gate:deploy-approval", `pipeline:${PIPELINE}`], probes: [] },
      "ADMIT_INDETERMINATE",
      "gate_unbound",
    ],
    [
      "deploy: UNBOUND — no pipeline: label",
      { labels: ["gate:deploy-approval", `exec:${EXEC}`], probes: [] },
      "ADMIT_INDETERMINATE",
      "gate_unbound",
    ],

    // ── gate:ci-unavailable ──
    [
      "ci: a SUCCEEDED build exists for the SHA",
      {
        labels: CI_LABELS,
        probes: [{ tool: "Pipeline___get_build_status", result: { match: { buildId: "b:1", buildStatus: "SUCCEEDED" } } }],
      },
      "ADMIT_VERIFIED",
      "build_exists",
    ],
    [
      "ci: an IN_PROGRESS build exists for the SHA",
      {
        labels: CI_LABELS,
        probes: [{ tool: "Pipeline___get_build_status", result: { match: { buildId: "b:2", buildStatus: "IN_PROGRESS" } } }],
      },
      "ADMIT_VERIFIED",
      "build_exists",
    ],
    [
      "ci: a FAILED build exists for the SHA",
      {
        labels: CI_LABELS,
        probes: [{ tool: "Pipeline___get_build_status", result: { match: { buildId: "b:3", buildStatus: "FAILED" } } }],
      },
      "ADMIT_VERIFIED",
      "build_exists",
    ],
    [
      "ci: NO build for the SHA and no DECISION — the one creation-free refusal",
      { labels: CI_LABELS, probes: [{ tool: "Pipeline___get_build_status", result: { match: null, project: "hub-x-ci" } }] },
      "REFUSE",
      null,
    ],
    [
      "ci: NO build, but a human recorded DECISION: accept-proxy",
      {
        labels: CI_LABELS,
        description: "CI is down in this account.\n\nDECISION: accept-proxy",
        probes: [{ tool: "Pipeline___get_build_status", result: { match: null } }],
      },
      "ADMIT_INDETERMINATE",
      "decision_advisory",
    ],
    [
      "ci: the probe THREW",
      { labels: CI_LABELS, probes: [{ tool: "Pipeline___get_build_status", throws: "TimeoutError" }] },
      "ADMIT_INDETERMINATE",
      "probe_failed",
    ],
    [
      "ci: UNBOUND — no head: label",
      { labels: ["gate:ci-unavailable", `pipeline:${PIPELINE}`], probes: [] },
      "ADMIT_INDETERMINATE",
      "gate_unbound",
    ],

    // ── gate:blocker — never probed, never refused ──
    [
      "blocker: always indeterminate, and no probe is made",
      { labels: ["gate:blocker", "wf:wf_1"], probes: [] },
      "ADMIT_INDETERMINATE",
      "no_probe_available",
    ],

    // ── not a probed gate at all ──
    ["no gate label: untouched", { labels: ["phase:development", "wf:wf_1"], probes: [] }, "UNSTAMPED", null],
    [
      "gate:approval alone: a human escalation gate is untouched",
      { labels: ["gate:approval", "wf:wf_1"], probes: [] },
      "UNSTAMPED",
      null,
    ],
  ];

  it.each(ROWS)("%s", async (_name, scn, expected, subReason) => {
    const t = await runTickets(scn);
    const j = await runJira(scn);

    expect(t.outcome, "dynamodb twin").toBe(expected);
    expect(j.outcome, "jira twin").toBe(expected);
    if (subReason) {
      expect(t.reason, "dynamodb sub-reason").toBe(subReason);
      expect(j.reason, "jira sub-reason").toBe(subReason);
    }
    // PARITY: the payload an agent reads must not depend on the provider.
    expect(j.payload, "refusal payload parity").toEqual(t.payload);
    expect(j.message, "refusal message parity").toBe(t.message);
  });

  it("the matrix actually exercises all four outcomes", () => {
    const seen = new Set(ROWS.map(([, , outcome]) => outcome));
    expect([...seen].sort()).toEqual(["ADMIT_INDETERMINATE", "ADMIT_VERIFIED", "REFUSE", "UNSTAMPED"]);
  });
});

describe("the fail direction is ADMIT, in every failure mode", () => {
  // The rule this file exists for, stated once more as its own assertion so a
  // future "harden the guard" edit fails HERE with an unmissable name rather than
  // in one row of a 27-row table.
  const FAILURES: Array<[string, Probe]> = [
    ["a timeout", { tool: "Pipeline___get_state", throws: "TimeoutError" }],
    ["an aborted invoke", { tool: "Pipeline___get_state", throws: "AbortError" }],
    ["access denied", { tool: "Pipeline___get_state", throws: "AccessDeniedException" }],
    ["throttling", { tool: "Pipeline___get_state", throws: "ThrottlingException" }],
    ["the function does not exist", { tool: "Pipeline___get_state", throws: "ResourceNotFoundException" }],
    ["an unhandled error inside the tool", { tool: "Pipeline___get_state", functionError: "Unhandled" }],
    ["a truncated payload", { tool: "Pipeline___get_state", raw: '{"content":[' }],
    ["an envelope with no text block", { tool: "Pipeline___get_state", raw: '{"content":[{"type":"image"}]}' }],
    ["a text block that is not JSON", { tool: "Pipeline___get_state", raw: '{"content":[{"type":"text","text":"oops"}]}' }],
  ];

  it.each(FAILURES)("%s admits the close and stamps indeterminate", async (_name, probe) => {
    const scn = { labels: DEPLOY_LABELS, probes: [probe] };
    for (const [who, run] of [
      ["dynamodb", await runTickets(scn)],
      ["jira", await runJira(scn)],
    ] as Array<[string, Run]>) {
      expect(run.outcome, `${who} must ADMIT on an unreadable probe`).toBe("ADMIT_INDETERMINATE");
      expect(run.payload, `${who} must not refuse`).toBeNull();
    }
  });

  it("an unset PIPELINE_TOOLS_LAMBDA would admit too (probe_not_configured is indeterminate)", async () => {
    // Same class of failure, reached without reloading the module: an allow-listed
    // tool with no function name configured returns the same indeterminate shape.
    const { invokeProbe } = await import("../../../lambda/agentcore-hub-tickets/gate-contract.mjs");
    expect(await invokeProbe("", "Pipeline___get_state", {})).toEqual({
      ok: false,
      indeterminate: true,
      error: "probe_not_configured",
    });
  });

  it("IN_PROGRESS is never a refusal — the gate asks 'does CI exist', not 'did it pass'", async () => {
    for (const buildStatus of ["IN_PROGRESS", "QUEUED", "FAILED", "STOPPED", "SUCCEEDED"]) {
      const scn: Scenario = {
        labels: CI_LABELS,
        probes: [{ tool: "Pipeline___get_build_status", result: { match: { buildId: "b", buildStatus } } }],
      };
      expect((await runTickets(scn)).outcome, `dynamodb / ${buildStatus}`).toBe("ADMIT_VERIFIED");
      expect((await runJira(scn)).outcome, `jira / ${buildStatus}`).toBe("ADMIT_VERIFIED");
    }
  });
});

describe("a refusal's side effects", () => {
  const OPEN: Scenario = {
    labels: DEPLOY_LABELS,
    probes: [
      {
        tool: "Pipeline___get_state",
        result: { waitingOn: { stage: "Deploy", action: "ApproveDeploy", holdsGate: "this" } },
      },
    ],
  };

  it("the payload carries the six fields an agent acts on, and names the console", async () => {
    const t = await runTickets(OPEN);
    expect(t.payload).toEqual({
      ok: false,
      reason: "gate_condition_unmet",
      hint: expect.stringContaining("still OPEN"),
      consoleUrl: `https://console.aws.amazon.com/codesuite/codepipeline/pipelines/${PIPELINE}/view?region=us-east-1`,
      stage: "Deploy",
      action: "ApproveDeploy",
    });
    // The remedy must not be "file another gate ticket" — that is the loop the
    // createTicket seam then refuses, so the two halves would deadlock the agent.
    expect(t.payload?.hint).toContain("do not file another gate ticket");
  });

  it("the ticket does NOT move, and gets gate:awaiting-console + one comment", async () => {
    const t = await runTickets(OPEN);
    expect(h.ddb.statusUpdates, "no status write on a refusal").toHaveLength(0);
    expect(t.labels).toContain("gate:awaiting-console");

    const j = await runJira(OPEN);
    expect(h.jira.writes.filter((w) => /\/transitions$/.test(w.path)), "no transition POST").toHaveLength(0);
    expect(j.labels).toContain("gate:awaiting-console");
    expect(h.jira.writes.filter((w) => /\/comment$/.test(w.path)), "exactly one comment").toHaveLength(1);
  });

  it("emits ONE gate.repaged, and a repeat refusal emits nothing (both twins)", async () => {
    const t1 = await runTickets(OPEN);
    expect(t1.events.map((e) => e.type)).toEqual(["gate.repaged"]);
    expect(t1.events[0]).toMatchObject({
      workflowId: "wf_1",
      type: "gate.repaged",
      detail: { ticketId: TICKET, gateKind: "deploy-approval", attempt: 1 },
    });
    // The event carries a ttl (SEC-13): these are the first rows in the events
    // table with an expiry, and an unbounded gate-event stream is a cost leak.
    expect(typeof t1.events[0].ttl).toBe("number");

    // Retry on the same stall: the label is already there, so nothing pages again.
    h.probes.length = 0;
    h.events.length = 0;
    h.probeBy = { Pipeline___get_state: { result: { waitingOn: { stage: "Deploy", action: "ApproveDeploy", holdsGate: "this" } } } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const again: any = await ticketsHandler({
      _tool_name: "Tickets___transition_ticket",
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: TICKET, transition_id: "done" },
    });
    expect(again.reason).toBe("gate_condition_unmet");
    expect(h.events, "no second gate.repaged").toHaveLength(0);

    // Same for Jira, whose dedupe is a before/after label read rather than a
    // conditional write (its `add` verb reports nothing back).
    const j1 = await runJira(OPEN);
    expect(j1.events.map((e) => e.type)).toEqual(["gate.repaged"]);
    h.events.length = 0;
    h.probeBy = { Pipeline___get_state: { result: { waitingOn: { stage: "Deploy", action: "ApproveDeploy", holdsGate: "this" } } } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jAgain: any = await jiraHandler({
      _tool_name: "Tickets___transition_ticket",
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: TICKET, transition_id: "done" },
    });
    expect(jAgain.reason).toBe("gate_condition_unmet");
    expect(h.events, "no second gate.repaged (jira)").toHaveLength(0);
  });

  it("a rejected approval says `block`, not close — a human decision is never overwritten", async () => {
    const scn: Scenario = {
      labels: DEPLOY_LABELS,
      probes: [
        {
          tool: "Pipeline___get_state",
          result: { actionDetails: [{ stage: "Deploy", action: "ApproveDeploy", status: "Failed" }] },
        },
      ],
    };
    const t = await runTickets(scn);
    const j = await runJira(scn);
    expect(t.payload?.hint).toContain("REJECTED by a human");
    expect(t.payload?.hint).toContain("`block`");
    expect(j.payload).toEqual(t.payload);
  });

  it("the ci refusal lists remedies and rules out filing another ticket", async () => {
    const scn: Scenario = {
      labels: CI_LABELS,
      probes: [{ tool: "Pipeline___get_build_status", result: { match: null, project: "hub-x-ci" } }],
    };
    const t = await runTickets(scn);
    expect(t.payload?.hint).toContain(`Pipeline___start_ci_build(commit_sha="${SHA}")`);
    expect(t.payload?.hint).toContain("Filing another CI ticket is NOT a remedy");
    expect((await runJira(scn)).payload).toEqual(t.payload);
  });
});

describe("the admit path writes the stamp WITH the status", () => {
  const CLEAR: Scenario = {
    labels: [...DEPLOY_LABELS, "gate:awaiting-console"],
    probes: [{ tool: "Pipeline___get_state", result: { waitingOn: null } }],
  };

  it("dynamodb: one UpdateCommand carries status + gateVerification, and clears the park label", async () => {
    await runTickets(CLEAR);
    expect(h.ddb.statusUpdates).toHaveLength(1);
    const write = h.ddb.statusUpdates[0] as {
      UpdateExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
      ConditionExpression?: string;
    };
    expect(write.ExpressionAttributeValues[":s"]).toBe("done");
    expect((write.ExpressionAttributeValues[":gv"] as { result: string }).result).toBe("verified");
    expect(write.UpdateExpression).toContain("#gv = :gv");
    // The park label's SLOT is overwritten with the verification label: DynamoDB
    // rejects an expression that touches both `labels` and `labels[i]`, so a
    // remove-plus-append is not expressible in one command — and a whole-list SET
    // would clobber a concurrent labeller.
    expect(write.UpdateExpression).toMatch(/#l\[\d+] = :stampl/);
    expect(write.ExpressionAttributeValues[":stampl"]).toBe("gateverify:verified");
    expect(write.ConditionExpression).toMatch(/#l\[\d+] = :awaiting/);
  });

  it("jira: the stamp and the label removal ride in the SAME transitions POST", async () => {
    await runJira(CLEAR);
    const posts = h.jira.writes.filter((w) => /\/transitions$/.test(w.path));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      transition: { id: "31" },
      update: { labels: [{ remove: "gate:awaiting-console" }, { add: "gateverify:verified" }] },
    });
    // No adjacent second call: a stamp written separately could be lost after the
    // close, leaving a closed gate with no record of what admitted it.
    expect(h.jira.writes.filter((w) => w.method === "PUT"), "no separate label PUT").toHaveLength(0);
  });

  it("a non-gate ticket's write is byte-identical to the pre-TEAM-4739 one", async () => {
    await runTickets({ labels: ["phase:development"], probes: [] });
    const write = h.ddb.statusUpdates[0] as { UpdateExpression: string; ConditionExpression?: string };
    expect(write.UpdateExpression).toBe("SET #s = :s, #u = :u");
    expect(write.ConditionExpression).toBeUndefined();
    expect(h.probes, "no probe for a non-gate ticket").toHaveLength(0);

    await runJira({ labels: ["phase:development"], probes: [] });
    const posts = h.jira.writes.filter((w) => /\/transitions$/.test(w.path));
    expect(posts[0].body).toEqual({ transition: { id: "31" } });
  });

  it("an indeterminate close is stamped too — the audit trail is the whole point", async () => {
    const scn: Scenario = { labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", throws: "TimeoutError" }] };
    await runTickets(scn);
    const write = h.ddb.statusUpdates[0] as { ExpressionAttributeValues: Record<string, unknown> };
    expect(write.ExpressionAttributeValues[":gv"]).toMatchObject({
      result: "indeterminate",
      reason: "probe_failed",
      gateKind: "deploy-approval",
    });

    await runJira(scn);
    const posts = h.jira.writes.filter((w) => /\/transitions$/.test(w.path));
    expect(posts[0].body.update).toEqual({ labels: [{ add: "gateverify:indeterminate" }] });
  });
});

describe("the probe surface is exactly what the tools Lambda accepts", () => {
  it("deploy-approval probes get_state with pipeline_name + execution_id, and nothing else", async () => {
    await runTickets({ labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", result: { waitingOn: null } }] });
    expect(h.probes).toEqual([
      { tool: "Pipeline___get_state", args: { pipeline_name: PIPELINE, execution_id: EXEC } },
    ]);
  });

  it("ci-unavailable probes get_build_status with pipeline_name + commit_sha — never a derived project", async () => {
    // `project` already defaults to `target.ciProject || CI_PROJECT` inside the
    // tool. Deriving a CI project name here would be a SECOND derivation of a name
    // CLAUDE.md says may only come from pipelineProjects()/pipelineProjectsFor().
    await runTickets({
      labels: CI_LABELS,
      probes: [{ tool: "Pipeline___get_build_status", result: { match: { buildId: "b", buildStatus: "SUCCEEDED" } } }],
    });
    expect(h.probes).toEqual([
      { tool: "Pipeline___get_build_status", args: { pipeline_name: PIPELINE, commit_sha: SHA } },
    ]);
  });

  it("a blocker gate makes NO probe at all", async () => {
    await runTickets({ labels: ["gate:blocker"], probes: [] });
    expect(h.probes).toHaveLength(0);
    await runJira({ labels: ["gate:blocker"], probes: [] });
    expect(h.probes).toHaveLength(0);
  });

  it("both twins send the same probe for the same gate", async () => {
    const scn: Scenario = { labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", result: { waitingOn: null } }] };
    const t = await runTickets(scn);
    const j = await runJira(scn);
    expect(j.probes).toEqual(t.probes);
  });
});

describe("the label readers accept both spellings at the guard seam", () => {
  // sanitizeUserLabels rewrites `:` → `-`, normalizeSystemLabel keeps `:`, so the
  // same gate arrives in either spelling depending on who wrote it. WP1 pins the
  // regexes; this pins that the GUARD — bindings and all — reads both.
  it("a hyphen-spelled deploy gate is bound and probed identically", async () => {
    const hyphen: Scenario = {
      labels: ["gate-deploy-approval", `pipeline-${PIPELINE}`, `exec-${EXEC}`, "wf:wf_1"],
      probes: [{ tool: "Pipeline___get_state", result: { waitingOn: { holdsGate: "this", stage: "Deploy" } } }],
    };
    const colon: Scenario = {
      labels: DEPLOY_LABELS,
      probes: [{ tool: "Pipeline___get_state", result: { waitingOn: { holdsGate: "this", stage: "Deploy" } } }],
    };
    const a = await runTickets(hyphen);
    const b = await runTickets(colon);
    expect(a.outcome).toBe("REFUSE");
    expect(a.payload).toEqual(b.payload);
    expect(a.probes).toEqual(b.probes);
    expect((await runJira(hyphen)).payload).toEqual(a.payload);
  });

  it("a hyphen-spelled park label is still cleared on admit", async () => {
    await runTickets({
      labels: [...DEPLOY_LABELS, "gate-awaiting-console"],
      probes: [{ tool: "Pipeline___get_state", result: { waitingOn: null } }],
    });
    const write = h.ddb.statusUpdates[0] as { ConditionExpression?: string; ExpressionAttributeValues: Record<string, unknown> };
    expect(write.ConditionExpression).toMatch(/#l\[\d+] = :awaiting/);
    expect(write.ExpressionAttributeValues[":awaiting"]).toBe("gate-awaiting-console");
  });
});

describe("only a → done transition is gated", () => {
  it("block makes no probe and no stamp (both twins)", async () => {
    seed({ labels: DEPLOY_LABELS });
    h.ddb.items = {
      [TICKET]: { ticketId: TICKET, status: "in_review", labels: [...DEPLOY_LABELS], workflowId: "wf_1" },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await ticketsHandler({
      _tool_name: "Tickets___transition_ticket",
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: TICKET, transition_id: "block" },
    });
    expect(res.gateVerification).toBeUndefined();
    expect(h.probes, "block must not probe").toHaveLength(0);
    expect(h.ddb.statusUpdates[0]).toMatchObject({ ExpressionAttributeValues: { ":s": "blocked" } });
  });

  it("skip IS gated — it is how a blocked ticket reaches done", async () => {
    seed({ labels: DEPLOY_LABELS, probes: [{ tool: "Pipeline___get_state", result: { waitingOn: { holdsGate: "this" } } }] });
    h.ddb.items = {
      [TICKET]: { ticketId: TICKET, status: "blocked", labels: [...DEPLOY_LABELS], workflowId: "wf_1" },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await ticketsHandler({
      _tool_name: "Tickets___transition_ticket",
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: TICKET, transition_id: "skip" },
    });
    expect(res.reason, "skip must not walk around the gate").toBe("gate_condition_unmet");
    expect(h.ddb.statusUpdates).toHaveLength(0);
  });
});
