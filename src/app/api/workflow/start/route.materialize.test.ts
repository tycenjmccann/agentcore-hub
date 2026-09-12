import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-4453 D1 — the start route executing a hub-materialized ticket plan.
 *
 * What is pinned here is the WRITE SEQUENCE, because it is what makes the
 * skeleton safe:
 *   - Every ticket is created in plan order with `blocked_by` resolved to the ids
 *     of tickets that already exist.
 *   - SR-1.1: in DynamoDB mode item 0 is created behind the epic as a sentinel
 *     blocker and released (edit_issue → unblock) only after the LAST create, so
 *     the orchestrator can't dispatch the operator into a half-written epic.
 *   - Jira has no removable blocker link, so ordering is the guard there:
 *     item 0's `transitionTo("Ready")` is the very last call of the plan.
 * Plus the `reviewGates` front-door validation, the `phase:"intake"` seed, and
 * the failure path (the error names the plan key; the row is marked error).
 */

const h = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  const state: {
    invokes: Array<{ tool_name: string; parameters: Record<string, unknown> }>;
    jira: Array<{ call: string; args: Record<string, unknown> }>;
    invokeImpl: ((payload: { tool_name: string; parameters: Record<string, unknown> }) => unknown) | null;
    deliveryMode: "cd" | "handoff";
    roster: Array<{ agentId: string; phase?: string; workflowDefIds?: string[] }>;
    nextKey: number;
  } = { invokes: [], jira: [], invokeImpl: null, deliveryMode: "cd", roster: [], nextKey: 100 };
  return { store, state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class TransactWriteCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    PutCommand,
    GetCommand,
    UpdateCommand,
    TransactWriteCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const { input } = cmd;
          if (cmd.constructor.name === "GetCommand") {
            return { Item: h.store.get((input.Key as { workflowId: string }).workflowId) };
          }
          if (cmd.constructor.name === "UpdateCommand") {
            const key = (input.Key as { workflowId: string }).workflowId;
            const vals = input.ExpressionAttributeValues as Record<string, unknown>;
            h.store.set(key, {
              ...(h.store.get(key) || { workflowId: key }),
              phase: vals[":error"],
              erroredAt: vals[":ts"],
              startError: vals[":msg"],
            });
            return {};
          }
          const item = input.Item as Record<string, unknown>;
          h.store.set(item.workflowId as string, item);
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    Payload: Uint8Array;
    constructor(input: { Payload: Uint8Array }) {
      this.Payload = input.Payload;
    }
  }
  class LambdaClient {
    async send(cmd: InstanceType<typeof InvokeCommand>) {
      const payload = JSON.parse(Buffer.from(cmd.Payload).toString("utf8"));
      h.state.invokes.push(payload);
      const override = h.state.invokeImpl?.(payload);
      if (override !== undefined) {
        return { Payload: new TextEncoder().encode(JSON.stringify(override)) };
      }
      // Default success shapes, mirroring the tickets Lambda's own contracts.
      const result =
        payload.tool_name === "Tickets___create_ticket"
          ? { key: `TEAM-${h.state.nextKey++}`, status: "created" }
          : payload.tool_name === "Tickets___edit_issue"
            ? { key: payload.parameters.ticket_id, status: "updated" }
            : { status: "transitioned" };
      return { Payload: new TextEncoder().encode(JSON.stringify(result)) };
    }
  }
  return { LambdaClient, InvokeCommand };
});

vi.mock("@/lib/workflow/intake", () => ({
  validateIntakeSources: vi.fn(async (sources: unknown[] = []) => ({
    results: [],
    definitiveErrors: [],
    transientErrors: [],
    sources,
  })),
  getSourceValidationMode: vi.fn(() => "lenient" as const),
  shouldRejectSubmission: vi.fn(() => ({ reject: false, errors: [] as string[] })),
}));

vi.mock("@/lib/workflow/ticket-provider-jira", () => ({
  JiraCloudProvider: class {
    async createEpic(args: Record<string, unknown>) {
      h.state.jira.push({ call: "createEpic", args });
      return { id: "TEAM-1" };
    }
    async createTicket(args: Record<string, unknown>) {
      const id = `TEAM-${h.state.nextKey++}`;
      h.state.jira.push({ call: "createTicket", args: { ...args, id } });
      return { id };
    }
    async transitionTo(id: string, status: string) {
      h.state.jira.push({ call: "transitionTo", args: { id, status } });
    }
    async deleteIssue(id: string) {
      h.state.jira.push({ call: "deleteIssue", args: { id } });
    }
  },
}));

// The LIVE defs doc is the bundled one here — so this file also pins the
// workflows.json opt-in (`operator` must be intakeMaterialization: "hub").
vi.mock("@/lib/workflow/defs-loader", async () => {
  const { getWorkflowDef } = await import("@/lib/workflow/workflow-defs");
  return { resolveWorkflowDef: vi.fn(async (id: string) => getWorkflowDef(id)) };
});

vi.mock("@/lib/workflow/roster-loader", () => ({
  loadRoster: vi.fn(async () => h.state.roster),
}));

vi.mock("@/lib/cd-registry", () => ({
  loadCdRegistry: vi.fn(async () => ({ repos: [] })),
  deliveryModeFor: vi.fn(() => h.state.deliveryMode),
}));

let POST: typeof import("./route").POST;

async function load(provider: "dynamodb" | "jira") {
  process.env.TICKET_PROVIDER = provider;
  process.env.REPO_CHECK_MODE = "off";
  vi.resetModules();
  ({ POST } = await import("./route"));
}

beforeEach(() => {
  h.store.clear();
  h.state.invokes.length = 0;
  h.state.jira.length = 0;
  h.state.invokeImpl = null;
  h.state.deliveryMode = "cd";
  h.state.roster = [];
  h.state.nextKey = 100;
});

afterEach(() => {
  delete process.env.TICKET_PROVIDER;
  delete process.env.REPO_CHECK_MODE;
});

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/workflow/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

const OPERATOR_BODY = {
  title: "Add a retry to the uploader",
  description: "It fails on 502.",
  workflowDefId: "operator",
  repoConfig: { layout: "multi-repo", repos: [{ name: "repo", url: "https://github.com/o/repo" }] },
};

/** The ticket-tools calls, as `tool:key` pairs, in the order they were made. */
function toolCalls() {
  return h.state.invokes.map((i) => {
    const p = i.parameters;
    const id = (p.ticket_id || p.summary) as string;
    return `${i.tool_name.replace("Tickets___", "")}:${id}`;
  });
}

function creates() {
  return h.state.invokes.filter((i) => i.tool_name === "Tickets___create_ticket").map((i) => i.parameters);
}

function workflowRow() {
  return [...h.store.values()].find((i) => String(i.workflowId).startsWith("wf_"));
}

describe("DynamoDB: the operator skeleton is written in plan order and released last", () => {
  it("creates build (behind the epic sentinel), the gate, ship — then releases build", async () => {
    await load("dynamodb");
    const res = await post(OPERATOR_BODY);
    expect(res.status).toBe(200);
    const body = await res.json();

    // TEAM-100 is the epic; the plan's tickets follow.
    const [epic, build, gate, ship] = ["TEAM-100", "TEAM-101", "TEAM-102", "TEAM-103"];
    expect(body).toMatchObject({ epicId: epic, materialized: [build, gate, ship], deferred: [] });

    expect(toolCalls()).toEqual([
      "create_ticket:Add a retry to the uploader", // epic
      `transition_ticket:${epic}`, // epic → in_progress
      "create_ticket:Build: agentcore_hub_operator — Add a retry to the uploader",
      "create_ticket:Merge Approval: Add a retry to the uploader",
      "create_ticket:Ship: agentcore_hub_operator — Add a retry to the uploader",
      // SR-1.1: the sentinel release is the LAST thing that happens.
      `edit_issue:${build}`,
      `transition_ticket:${build}`,
    ]);

    const [, buildCreate, gateCreate, shipCreate] = creates();
    expect(buildCreate).toMatchObject({
      parent_key: epic,
      assignee: "agentcore_hub_operator",
      phase: "development",
      blocked_by: [epic], // the sentinel
    });
    expect(gateCreate).toMatchObject({
      assignee: "human:engineer",
      phase: "development",
      blocked_by: [build],
    });
    expect(shipCreate).toMatchObject({
      assignee: "agentcore_hub_operator",
      phase: "ship",
      blocked_by: [gate],
    });
    // sanitizeUserLabels would mangle "phase:ship" → "phase-ship", so DynamoDB
    // creates carry the phase FIELD and no labels.
    expect(creates().some((c) => "labels" in c)).toBe(false);

    const release = h.state.invokes.slice(-2);
    expect(release[0]).toMatchObject({
      tool_name: "Tickets___edit_issue",
      parameters: { ticket_id: build, blocked_by: [] },
    });
    expect(release[1]).toMatchObject({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: build, transition_id: "unblock" },
    });
  });

  it("a handoff run plans no ship ticket", async () => {
    h.state.deliveryMode = "handoff";
    await load("dynamodb");
    const res = await post(OPERATOR_BODY);
    expect(res.status).toBe(200);
    expect((await res.json()).materialized).toEqual(["TEAM-101", "TEAM-102"]);
    expect(creates().map((c) => c.phase)).toEqual([undefined, "development", "development"]);
  });

  it("reports the assignee fallback as a warning without deferring the phase", async () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    await load("dynamodb");
    await post(OPERATOR_BODY);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("materialized 3 ticket(s) for def operator (hub, cd)");
    expect(logged).toContain("phase:development=TEAM-101");
    warn.mockRestore();
  });

  it("an agent-mode def still writes ONE ticket and no sentinel release", async () => {
    await load("dynamodb");
    const res = await post({ ...OPERATOR_BODY, title: "t", description: "d", workflowDefId: "software-delivery" });
    expect(res.status).toBe(200);
    expect((await res.json()).materialized).toEqual(["TEAM-101"]);
    expect(toolCalls()).toEqual([
      "create_ticket:t",
      "transition_ticket:TEAM-100",
      "create_ticket:Intake: agentcore_hub_requirements_analyst — t",
    ]);
    expect(creates()[1].blocked_by).toBeUndefined();
  });

  it("seeds the workflow row in the intake phase (R6a)", async () => {
    await load("dynamodb");
    await post(OPERATOR_BODY);
    expect(workflowRow()?.phase).toBe("intake");
  });

  it("a create failure names the plan key and marks the run phase=error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let creates = 0;
    h.state.invokeImpl = (p) => {
      if (p.tool_name === "Tickets___create_ticket" && ++creates === 3) return { error: "gate boom" };
      return undefined;
    };
    await load("dynamodb");
    const res = await post(OPERATOR_BODY);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(
      "Failed to create gate:merge-approval@development ticket: gate boom"
    );
    expect(workflowRow()?.phase).toBe("error");
    // The ship ticket was never attempted, and item 0 stays blocked by the
    // sentinel — a half-written skeleton never dispatches.
    expect(toolCalls().filter((c) => c.startsWith("edit_issue"))).toEqual([]);
    error.mockRestore();
  });

  it("a failed unblock is surfaced instead of leaving item 0 blocked forever", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.invokeImpl = (p) =>
      p.tool_name === "Tickets___transition_ticket" && p.parameters.transition_id === "unblock"
        ? { content: [{ text: "Invalid transition 'unblock' from status 'todo'" }] }
        : undefined;
    await load("dynamodb");
    const res = await post(OPERATOR_BODY);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Failed to unblock TEAM-101 after clearing the sentinel");
    expect((await workflowRow())?.phase).toBe("error");
    error.mockRestore();
  });

  it("a failed blocker clear is surfaced too (edit_issue reports {error})", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.invokeImpl = (p) =>
      p.tool_name === "Tickets___edit_issue" ? { error: "ticket not found" } : undefined;
    await load("dynamodb");
    const res = await post(OPERATOR_BODY);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain(
      "Failed to clear the sentinel blocker on TEAM-101: ticket not found"
    );
    error.mockRestore();
  });
});

describe("Jira: ordering is the guard — item 0 goes Ready last", () => {
  it("creates the skeleton, parks the blocked items, and readies build LAST", async () => {
    await load("jira");
    const res = await post(OPERATOR_BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.materialized).toEqual(["TEAM-100", "TEAM-101", "TEAM-102"]);

    expect(h.state.jira.map((c) => `${c.call}:${c.args.id}:${c.args.status ?? ""}`)).toEqual([
      "createEpic:undefined:",
      "createTicket:TEAM-100:", // build
      "createTicket:TEAM-101:", // Merge Approval gate
      "transitionTo:TEAM-101:Blocked",
      "createTicket:TEAM-102:", // ship
      "transitionTo:TEAM-102:Blocked",
      // Amendment 3: the ONLY thing that can dispatch is last.
      "transitionTo:TEAM-100:Ready",
    ]);
    const last = h.state.jira[h.state.jira.length - 1];
    expect(last).toEqual({ call: "transitionTo", args: { id: "TEAM-100", status: "Ready" } });
  });

  it("carries the wfdef/phase/gate labels (Jira keeps them verbatim)", async () => {
    await load("jira");
    await post(OPERATOR_BODY);
    const tickets = h.state.jira.filter((c) => c.call === "createTicket");
    expect(tickets.map((t) => t.args.extraLabels)).toEqual([
      ["wfdef:operator", "phase:development"],
      ["wfdef:operator", "phase:development", "gate:merge-approval"],
      ["wfdef:operator", "phase:ship"],
    ]);
    expect(tickets.map((t) => t.args.blockedBy)).toEqual([[], ["TEAM-100"], ["TEAM-101"]]);
  });

  it("a park failure is logged and never fails the start", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await load("jira");
    const { JiraCloudProvider } = await import("@/lib/workflow/ticket-provider-jira");
    const spy = vi
      .spyOn(JiraCloudProvider.prototype, "transitionTo")
      .mockImplementation(async (id: string, status: string) => {
        h.state.jira.push({ call: "transitionTo", args: { id, status } });
        if (status === "Blocked") throw new Error("no Blocked transition");
      });
    const res = await post(OPERATOR_BODY);
    expect(res.status).toBe(200);
    expect(String(warn.mock.calls[0]?.[0])).toContain("could not park TEAM-101 in Blocked");
    // Build still went Ready last.
    expect(h.state.jira[h.state.jira.length - 1].args).toEqual({ id: "TEAM-100", status: "Ready" });
    spy.mockRestore();
    warn.mockRestore();
  });

  it("an agent-mode def is byte-identical to before: one ticket, then Ready", async () => {
    await load("jira");
    const res = await post({ ...OPERATOR_BODY, title: "t", description: "d", workflowDefId: "software-delivery" });
    expect(res.status).toBe(200);
    expect(h.state.jira.map((c) => c.call)).toEqual(["createEpic", "createTicket", "transitionTo"]);
    expect(h.state.jira[1].args).toMatchObject({
      title: "Intake: agentcore_hub_requirements_analyst — t",
      assignee: "agentcore_hub_requirements_analyst",
      blockedBy: [],
    });
    expect(h.state.jira[2].args).toEqual({ id: "TEAM-100", status: "Ready" });
  });
});

describe("reviewGates front-door validation (SR-1.4)", () => {
  beforeEach(async () => {
    await load("dynamodb");
  });

  it("rejects a non-array", async () => {
    const res = await post({ ...OPERATOR_BODY, reviewGates: "development" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("reviewGates must be an array");
    expect(h.state.invokes).toHaveLength(0); // rejected before any ticket exists
  });

  it("rejects a non-string entry and an empty one", async () => {
    expect((await post({ ...OPERATOR_BODY, reviewGates: [1] })).status).toBe(400);
    expect((await post({ ...OPERATOR_BODY, reviewGates: ["  "] })).status).toBe(400);
  });

  it("rejects a phase this def does not declare", async () => {
    const res = await post({ ...OPERATOR_BODY, reviewGates: ["design"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(
      'reviewGates entry "design" is not a phase of the "operator" workflow def'
    );
  });

  it("rejects more than 20 entries", async () => {
    const res = await post({ ...OPERATOR_BODY, reviewGates: Array(21).fill("development") });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("at most 20 entries");
  });

  it("accepts a phase the def declares, and an absent value", async () => {
    expect((await post({ ...OPERATOR_BODY, reviewGates: ["development"] })).status).toBe(200);
    expect((await post(OPERATOR_BODY)).status).toBe(200);
  });

  it("accepts a gate phase the def declares only as a gate (software-delivery ship)", async () => {
    const res = await post({ ...OPERATOR_BODY, workflowDefId: "software-delivery", reviewGates: ["ship"] });
    expect(res.status).toBe(200);
  });
});
