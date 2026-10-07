import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { NON_ADMIN_HEADERS, SSO_AUTH_MODE, SVC_HEADERS } from "@/lib/auth/admin-test-headers";

/**
 * TEAM-5358 FR-2 / F1 / F6 — POST /api/workflow/[id]/closeout-override.
 *
 * Seams mocked: the DDB doc client (the workflow row; events-table puts captured),
 * the ticket readers, the def loader, and a stateful S3 that honours IfNoneMatch
 * and IfMatch against per-object etags, so the create-once and squatter paths run
 * against the same conditional semantics S3 applies.
 */

const h = vi.hoisted(() => {
  const state: {
    workflow: Record<string, unknown> | undefined;
    tickets: Array<Record<string, unknown>>;
    def: Record<string, unknown>;
    objects: Record<string, { body: string; etag: string }>;
    puts: Array<{ Key: string; Body: string; IfNoneMatch?: string; IfMatch?: string; ok: boolean }>;
    events: Array<Record<string, unknown>>;
    etagSeq: number;
    /** Runs once, right before the next IfMatch put is judged (a racing writer). */
    beforeIfMatch: (() => void) | null;
  } = { workflow: undefined, tickets: [], def: {}, objects: {}, puts: [], events: [], etagSeq: 0, beforeIfMatch: null };
  return { state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    PutCommand,
    UpdateCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (cmd.constructor.name === "GetCommand") return { Item: h.state.workflow };
          if (cmd.constructor.name === "PutCommand") h.state.events.push(cmd.input.Item as Record<string, unknown>);
          return {};
        },
      }),
    },
  };
});

function s3Error(name: string, status: number) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  class PutObjectCommand {
    constructor(public input: { Key: string; Body: string; IfNoneMatch?: string; IfMatch?: string }) {}
  }
  return {
    GetObjectCommand,
    PutObjectCommand,
    S3Client: class {
      async send(cmd: GetObjectCommand | PutObjectCommand) {
        const { Key } = cmd.input;
        if (cmd instanceof GetObjectCommand) {
          const o = h.state.objects[Key];
          if (!o) throw s3Error("NoSuchKey", 404);
          return { Body: { transformToString: async () => o.body }, ETag: o.etag };
        }
        const { Body, IfNoneMatch, IfMatch } = cmd.input;
        if (IfMatch && h.state.beforeIfMatch) {
          const race = h.state.beforeIfMatch;
          h.state.beforeIfMatch = null;
          race();
        }
        const cur = h.state.objects[Key];
        const ok = !(IfNoneMatch === "*" && cur) && !(IfMatch && (!cur || cur.etag !== IfMatch));
        h.state.puts.push({ Key, Body, IfNoneMatch, IfMatch, ok });
        if (!ok) throw s3Error("PreconditionFailed", 412);
        h.state.objects[Key] = { body: Body, etag: `"e${++h.state.etagSeq}"` };
        return {};
      }
    },
  };
});

// The 503 test's key read must fail closed without reaching AWS.
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
vi.mock("@/lib/workflow/defs-loader", () => ({ resolveWorkflowDef: vi.fn(async () => h.state.def) }));

const TEST_DECISION_KEY = "closeout-override-route-test-key";
const KEY = "workflows/wf_1/shared/closeout-override.json";
const SHIP = { ticketId: "S-1", type: "task", status: "done", phase: "ship", assignee: "agentcore_hub_release_manager" };
const CI = { ticketId: "C-1", type: "task", status: "done", phase: "review", assignee: "agentcore_hub_ci_agent" };
const QA = { ticketId: "Q-1", type: "task", status: "done", phase: "verification", assignee: "agentcore_hub_qa_verifier" };
const NOTICE = { id: "notif_completion_blocked_wf_1", type: "completion_blocked", acknowledged: false };

const SAVED = ["AUTH_MODE", "ARTIFACT_BUCKET", "GATE_DECISION_KEY", "TICKET_PROVIDER"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

let POST: typeof import("./route").POST;

async function load() {
  vi.resetModules();
  ({ POST } = await import("./route"));
}

function post(body: unknown, headers: Record<string, string> = NON_ADMIN_HEADERS, id = "wf_1") {
  const req = new NextRequest(`http://localhost/api/workflow/${id}/closeout-override`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req, { params: { id } });
}

const completion = (t: Record<string, unknown>) =>
  JSON.stringify({ ticket_id: t.ticketId, summary: "ran", agent_id: t.assignee });

async function verify(raw: string) {
  const { verifyCloseoutOverride } = await import("@/lib/workflow/closeout-override");
  return verifyCloseoutOverride(raw, [TEST_DECISION_KEY], "wf_1");
}

beforeEach(async () => {
  for (const k of SAVED) saved[k] = process.env[k];
  process.env.AUTH_MODE = SSO_AUTH_MODE;
  process.env.ARTIFACT_BUCKET = "test-bucket";
  process.env.GATE_DECISION_KEY = TEST_DECISION_KEY;
  process.env.TICKET_PROVIDER = "dynamodb";
  h.state.workflow = { workflowId: "wf_1", phase: "ship", workflowDefId: "software-delivery", humanNotifications: [NOTICE] };
  // S-1 backed, C-1 and Q-1 have no completions record: two gate offenders.
  h.state.tickets = [SHIP, CI, QA];
  h.state.def = { completionRequiresAgentPhases: [] };
  h.state.objects = { "completions/S-1.json": { body: completion(SHIP), etag: '"s1"' } };
  h.state.puts = [];
  h.state.events = [];
  h.state.beforeIfMatch = null;
  (await import("@/lib/workflow/decision-keys")).resetDecisionKeyCache();
  await load();
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("POST closeout-override — who may write it (F6)", () => {
  it("a signed-in human -> 201 and a signed record at shared/closeout-override.json that verifies", async () => {
    const res = await post({ reason: "CI and QA ran out of band; see PR #12" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("created");
    expect(body.record.by).toBe("alice@example.com");
    expect(body.replacedUnverifiable).toBe(false);
    expect(h.state.puts).toEqual([expect.objectContaining({ Key: KEY, IfNoneMatch: "*", ok: true })]);
    const stored = h.state.objects[KEY].body;
    expect(await verify(stored)).toMatchObject({ by: "alice@example.com", offenders: ["C-1", "Q-1"] });
    expect(h.state.events.at(-1)).toMatchObject({ type: "workflow.closeout_override", detail: { by: "alice@example.com" } });
  });

  it("the default identity (AUTH_MODE=none) -> 403 human_identity_required, no PutObject", async () => {
    delete process.env.AUTH_MODE;
    await load();
    const res = await post({ reason: "x" }, {});
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("human_identity_required");
    expect(h.state.puts).toEqual([]);
  });

  it("a svc: identity -> 403, no PutObject", async () => {
    const res = await post({ reason: "x" }, SVC_HEADERS);
    expect(res.status).toBe(403);
    expect(h.state.puts).toEqual([]);
  });

  it("`by` is the verified identity; a body `by` is ignored", async () => {
    const body = await (await post({ reason: "ok", by: "someone-else@example.com" })).json();
    expect(body.record.by).toBe("alice@example.com");
  });
});

describe("POST closeout-override — what it covers", () => {
  it("offenders are computed server-side; body offenders are ignored", async () => {
    const body = await (await post({ reason: "ok", offenders: ["S-1", "X-9"] })).json();
    expect(body.record.offenders).toEqual(["C-1", "Q-1"]);
    expect(body.offenders.map((o: { ticketId: string; why: string }) => `${o.ticketId}:${o.why}`)).toEqual([
      "C-1:no_record",
      "Q-1:no_record",
    ]);
  });

  it("offenderSetHash matches the sorted offenders", async () => {
    const { offenderSetHash } = await import("@/lib/workflow/closeout-override");
    const body = await (await post({ reason: "ok" })).json();
    expect(body.record.offenderSetHash).toBe(offenderSetHash(["Q-1", "C-1"]));
    expect(body.record.offenderSetHash).toBe(offenderSetHash(["C-1", "Q-1"]));
  });

  it("no notice and no offenders -> 409 nothing_to_override, no PutObject", async () => {
    h.state.workflow = { workflowId: "wf_1", phase: "ship", workflowDefId: "software-delivery" };
    h.state.tickets = [SHIP];
    const res = await post({ reason: "ok" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nothing_to_override");
    expect(h.state.puts).toEqual([]);
  });

  it("open gates without a notice can still be overridden (the set /complete would refuse)", async () => {
    h.state.workflow = { workflowId: "wf_1", phase: "ship", workflowDefId: "software-delivery" };
    expect((await post({ reason: "ok" })).status).toBe(201);
  });

  it("a terminal run -> 409 workflow_terminal", async () => {
    h.state.workflow = { ...h.state.workflow, cancelledAt: "2026-10-01T00:00:00Z" };
    const res = await post({ reason: "ok" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("workflow_terminal");
  });

  it("a missing workflow -> 404", async () => {
    h.state.workflow = undefined;
    expect((await post({ reason: "ok" })).status).toBe(404);
  });
});

describe("POST closeout-override — reason", () => {
  it.each([[{}], [{ reason: "" }], [{ reason: "  \u0007\u0001 " }], [{ reason: 42 }], ["not json"]])(
    "missing/blank/non-string reason %j -> 400 reason_required",
    async (body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("reason_required");
      expect(h.state.puts).toEqual([]);
    }
  );

  it("a reason over 1000 chars -> 400 reason_too_long (never silently clamped)", async () => {
    const res = await post({ reason: "x".repeat(1001) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("reason_too_long");
  });

  it("control chars are stripped from the stored reason", async () => {
    const body = await (await post({ reason: "ran\u0000 out of band\u001b" })).json();
    expect(body.record.reason).toBe("ran out of band");
  });
});

describe("POST closeout-override — create-once and the squatter rule (F1)", () => {
  it("a verified override already there -> 409 override_exists, object untouched", async () => {
    expect((await post({ reason: "first" })).status).toBe(201);
    const before = h.state.objects[KEY];
    const res = await post({ reason: "second" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("override_exists");
    expect(h.state.objects[KEY]).toEqual(before);
    expect(h.state.puts.filter((p) => p.IfMatch)).toEqual([]);
  });

  it("an unverifiable object squatting the key is overwritten with IfMatch:<its etag> and logged", async () => {
    const squat = JSON.stringify({ by: "agentcore_hub_ci_agent", reason: "trust me", offenders: [], at: "2026-10-01T00:00:00Z" });
    h.state.objects[KEY] = { body: squat, etag: '"squat"' };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ reason: "real override" });
    expect(res.status).toBe(201);
    expect((await res.json()).replacedUnverifiable).toBe(true);
    expect(h.state.puts.map((p) => [p.IfNoneMatch ?? null, p.IfMatch ?? null, p.ok])).toEqual([
      ["*", null, false],
      [null, '"squat"', true],
    ]);
    expect(await verify(h.state.objects[KEY].body)).toMatchObject({ by: "alice@example.com" });
    expect(warn.mock.calls.some((c) => /unverifiable object squatting .*closeout-override\.json.*"squat"/.test(String(c[0])))).toBe(true);
  });

  it("a record signed with another key is a squatter too", async () => {
    const { buildCloseoutOverride } = await import("@/lib/workflow/closeout-override");
    const forged = buildCloseoutOverride({ workflowId: "wf_1", by: "x@example.com", reason: "r", offenders: ["C-1", "Q-1"] }, "not-the-key");
    h.state.objects[KEY] = { body: JSON.stringify(forged), etag: '"forged"' };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ reason: "real" });
    expect(res.status).toBe(201);
    expect(h.state.puts.at(-1)).toMatchObject({ IfMatch: '"forged"', ok: true });
  });

  it("a real override landing between the squatter read and the IfMatch put wins -> 409 override_exists", async () => {
    h.state.objects[KEY] = { body: "{}", etag: '"squat"' };
    const { buildCloseoutOverride } = await import("@/lib/workflow/closeout-override");
    const winner = buildCloseoutOverride({ workflowId: "wf_1", by: "bob@example.com", reason: "r", offenders: ["C-1", "Q-1"] }, TEST_DECISION_KEY);
    h.state.beforeIfMatch = () => {
      h.state.objects[KEY] = { body: JSON.stringify(winner), etag: '"winner"' };
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ reason: "late" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("override_exists");
    expect(await verify(h.state.objects[KEY].body)).toMatchObject({ by: "bob@example.com" });
  });

  it("a squatter that keeps rewriting the key -> 409 override_contended after bounded attempts", async () => {
    h.state.objects[KEY] = { body: "{}", etag: '"s0"' };
    let n = 0;
    const resquat = () => {
      h.state.objects[KEY] = { body: "{}", etag: `"s${++n}"` };
      h.state.beforeIfMatch = resquat;
    };
    h.state.beforeIfMatch = resquat;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ reason: "x" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("override_contended");
    expect(h.state.puts.filter((p) => p.ok)).toEqual([]);
    expect(h.state.puts.length).toBe(6);
  });
});

describe("POST closeout-override — key availability", () => {
  it("no decision key -> 503 decision_key_unavailable, no PutObject", async () => {
    delete process.env.GATE_DECISION_KEY;
    delete process.env.GATE_DECISION_SECRET_ID;
    (await import("@/lib/workflow/decision-keys")).resetDecisionKeyCache();
    await load();
    const res = await post({ reason: "ok" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("decision_key_unavailable");
    expect(h.state.puts).toEqual([]);
  });
});
