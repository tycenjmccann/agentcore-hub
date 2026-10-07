import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5367 / DL-036 — GET /api/workflow/[id]/gate-decisions: verified human-gate
 * decisions for keyless readers (the workflow-manager toolkit). Seams mocked: the
 * workflow row, the ticket readers, S3 (every command captured, so "no writes" is
 * pinned), the key secret, and the live gate read.
 *
 * TEAM-5397 F4: a standing record can still be a PENDING claim (the twins keep it
 * when the status write after the claim fails, TEAM-5387). The live gate mock
 * defaults to `status: "done"` so existing cases stay committed; tests below flip
 * it to pin `pending`/`liveStatus`.
 */

const h = vi.hoisted(() => ({
  state: {
    workflow: undefined as Record<string, unknown> | undefined,
    tickets: [] as Array<Record<string, unknown>>,
    objects: {} as Record<string, string>,
    s3Commands: [] as string[],
    live: {} as Record<string, { cycle?: string | null; status?: string | null } | null>,
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string } }) => {
          if (cmd.constructor.name === "GetCommand") return { Item: h.state.workflow };
          throw new Error(`unexpected DDB write ${cmd.constructor.name}`);
        },
      }),
    },
  };
});
vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  return {
    GetObjectCommand,
    S3Client: class {
      async send(cmd: { constructor: { name: string }; input: { Key: string } }) {
        h.state.s3Commands.push(cmd.constructor.name);
        const body = h.state.objects[cmd.input.Key];
        if (body === undefined) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        if (body === "DENIED") throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied" });
        return { Body: { transformToString: async () => body } };
      }
    },
  };
});
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    async send() {
      throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    }
  },
  GetSecretValueCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));
vi.mock("@/lib/workflow/dynamo-read", () => ({ getTicketsForWorkflowFromDynamo: vi.fn(async () => h.state.tickets) }));
vi.mock("@/lib/workflow/jira-read", () => ({ getTicketsForWorkflowFromJira: vi.fn(async () => h.state.tickets) }));
vi.mock("@/lib/workflow/gate-live", () => ({
  liveGate: vi.fn(async (ticketId: string) => {
    const l = ticketId in h.state.live ? h.state.live[ticketId] : { cycle: null, status: "done" };
    return l ? { ticketId, cycle: l.cycle, scope: null, status: l.status ?? null } : null;
  }),
}));

const KEY = "gate-decisions-route-test-key";
const recKey = (tid: string) => `pipeline-artifacts/gate-decisions/wf_1/gates/${tid}.json`;
const SAVED = ["ARTIFACT_BUCKET", "GATE_DECISION_KEY", "TICKET_PROVIDER"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

async function signed(ticketId: string, over: Record<string, unknown> = {}, key = KEY) {
  const { canonicalJson, signVerifyRecord } = await import("@/lib/workflow/decision-contract");
  const u = {
    v: 3, ticketId, workflowId: "wf_1", kind: "gate-decision", status: "done",
    decision: { option: "approve", override: false, channel: "hub", by: "eng@example.com" },
    decidedAt: "2026-10-01T00:00:00Z", scope: null, cycle: null, labels: [], ...over,
  };
  return JSON.stringify({ ...u, sig: signVerifyRecord([canonicalJson(u)], key) });
}

async function get(id = "wf_1") {
  vi.resetModules();
  const { GET } = await import("./route");
  return GET(new NextRequest(`http://localhost/api/workflow/${id}/gate-decisions`), { params: { id } });
}

const gate = (ticketId: string) => ({ ticketId, status: "done", phase: "ship", assignee: "human:eng" });

beforeEach(async () => {
  for (const k of SAVED) saved[k] = process.env[k];
  process.env.ARTIFACT_BUCKET = "test-bucket";
  process.env.GATE_DECISION_KEY = KEY;
  process.env.TICKET_PROVIDER = "dynamodb";
  h.state.workflow = { workflowId: "wf_1", phase: "ship" };
  h.state.tickets = [];
  h.state.objects = {};
  h.state.s3Commands = [];
  h.state.live = {};
  (await import("@/lib/workflow/decision-keys")).resetDecisionKeyCache();
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("GET gate-decisions", () => {
  it("a record that stands -> decisions[tid] with verifiedBy hub, no sig, nothing written", async () => {
    h.state.tickets = [gate("G-1"), { ticketId: "D-1", status: "done", assignee: "agentcore_hub_backend_dev" }];
    h.state.objects[recKey("G-1")] = await signed("G-1");
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      keyAvailable: true,
      decisions: {
        "G-1": {
          status: "done",
          decision: { option: "approve" },
          decidedAt: "2026-10-01T00:00:00Z",
          verifiedBy: "hub",
          liveStatus: "done",
          pending: false,
        },
      },
      unverified: [],
    });
    expect(JSON.stringify(body)).not.toContain("sig");
    expect(h.state.s3Commands.every((c) => c === "GetObjectCommand")).toBe(true);
  });

  it("TEAM-5397 F4: a record whose live status differs from the record's is pending, not a decision (the probe)", async () => {
    // The twins claim the record BEFORE the status write and keep it if that write
    // fails (TEAM-5387) — a ticket still In Review can carry a `done` record.
    h.state.tickets = [gate("G-1")];
    h.state.objects[recKey("G-1")] = await signed("G-1");
    h.state.live["G-1"] = { cycle: null, status: "in_review" };
    const body = await (await get()).json();
    expect(body.decisions["G-1"]).toMatchObject({ status: "done", liveStatus: "in_review", pending: true });
  });

  it("TEAM-5397 F4: live status equal to the record's status is committed, not pending", async () => {
    h.state.tickets = [gate("G-1")];
    h.state.objects[recKey("G-1")] = await signed("G-1", { status: "cancelled", decision: { option: "stopped", override: false, channel: "hub", by: "eng@example.com" } });
    h.state.live["G-1"] = { cycle: null, status: "cancelled" };
    const body = await (await get()).json();
    expect(body.decisions["G-1"]).toMatchObject({ status: "cancelled", liveStatus: "cancelled", pending: false });
  });

  it("TEAM-5397 F4: an unknown live status (the twin sent none) is pending — fails closed", async () => {
    h.state.tickets = [gate("G-1")];
    h.state.objects[recKey("G-1")] = await signed("G-1");
    h.state.live["G-1"] = { cycle: null, status: null };
    const body = await (await get()).json();
    expect(body.decisions["G-1"]).toMatchObject({ status: "done", liveStatus: null, pending: true });
  });

  it("forged, another run's, stale-cycle and unknown-cycle records -> unverified with why", async () => {
    h.state.tickets = ["G-1", "G-2", "G-3", "G-4", "G-5"].map(gate);
    h.state.objects[recKey("G-1")] = JSON.stringify({ ...JSON.parse(await signed("G-1")), sig: "invalid" });
    h.state.objects[recKey("G-2")] = await signed("G-2", { workflowId: "wrong" });
    h.state.objects[recKey("G-3")] = await signed("G-3", { cycle: "c-1" });
    h.state.live["G-3"] = { cycle: "c-2" };
    h.state.objects[recKey("G-4")] = await signed("G-4", { cycle: "c-1" });
    h.state.live["G-4"] = null;
    h.state.objects[recKey("G-5")] = "DENIED";
    const body = await (await get()).json();
    expect(body.decisions).toEqual({});
    expect(body.unverified).toEqual([
      { ticketId: "G-1", why: "unverified" },
      { ticketId: "G-2", why: "wrong_run" },
      { ticketId: "G-3", why: "stale_cycle" },
      { ticketId: "G-4", why: "cycle_unknown" },
      { ticketId: "G-5", why: "record_unreadable" },
    ]);
  });

  it("a gate with no record is not listed", async () => {
    h.state.tickets = [gate("G-1")];
    expect(await (await get()).json()).toEqual({ keyAvailable: true, decisions: {}, unverified: [] });
  });

  it("no decision key -> keyAvailable false, empty decisions, no record read", async () => {
    delete process.env.GATE_DECISION_KEY;
    (await import("@/lib/workflow/decision-keys")).resetDecisionKeyCache();
    h.state.tickets = [gate("G-1")];
    h.state.objects[recKey("G-1")] = await signed("G-1");
    const body = await (await get()).json();
    expect(body).toEqual({ keyAvailable: false, decisions: {}, unverified: [] });
    expect(h.state.s3Commands).toEqual([]);
  });

  it("an unknown workflow -> 404; a malformed id -> 400", async () => {
    h.state.workflow = undefined;
    expect((await get()).status).toBe(404);
    expect((await get("bad id!")).status).toBe(400);
  });
});
