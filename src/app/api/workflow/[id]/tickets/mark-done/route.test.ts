import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-3991 D1.3 — POST /api/workflow/[id]/tickets/mark-done.
 *
 * The contract, in one line: a mark-done LEAVES EVIDENCE or it is REFUSED.
 * Three harvest sources in preference order (the agent's own completions record →
 * GitHub → the text the human typed), a hard refusal when all three are empty,
 * and two security rules that hold whatever the body says:
 *
 *   F16  `markedDoneBy` is the middleware identity, NEVER a body field, and this
 *        route never writes mergeCommit/outcome/blockReason (a human clicking
 *        "done" must not be able to forge a ship verdict).
 *   refuse_if_protected  a human-assigned ticket or an in_review ticket is a
 *        DECISION someone else owes — 409, use the transition endpoint.
 *
 * Only the seams are mocked: the DDB doc client, S3, the tickets Lambda, Jira.
 */

const h = vi.hoisted(() => ({
  state: {
    workflow: null as Record<string, unknown> | null,
    ticket: null as Record<string, unknown> | null,
    /** completions/<id>.json bodies by key. */
    s3Objects: {} as Record<string, string>,
    s3Puts: [] as Array<{ Key: string; Body: string }>,
    updates: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    lambdaCalls: [] as Array<Record<string, unknown>>,
    /** GitHub responses by path fragment; unmatched paths 404. */
    github: {} as Record<string, unknown>,
    githubCalls: [] as string[],
    /** When true the first (scoped) merge loses its CAS, forcing the seed path. */
    noTaskEntry: false,
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    UpdateCommand,
    PutCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const name = cmd.constructor.name;
          const table = cmd.input.TableName;
          if (name === "GetCommand") {
            if (table === "agentcore-hub-workflows") return { Item: h.state.workflow };
            return { Item: h.state.ticket };
          }
          if (name === "UpdateCommand") {
            const scoped = cmd.input.ConditionExpression === "attribute_exists(agentTasks.#tid)";
            if (scoped && h.state.noTaskEntry && !h.state.updates.some((u) => String(u.UpdateExpression).includes("if_not_exists(agentTasks.#tid"))) {
              h.state.updates.push(cmd.input);
              const e = new Error("no entry");
              e.name = "ConditionalCheckFailedException";
              throw e;
            }
            h.state.updates.push(cmd.input);
            return {};
          }
          if (name === "PutCommand") {
            h.state.events.push(cmd.input.Item as Record<string, unknown>);
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
    async send(cmd: { constructor: { name: string }; input: { Key: string; Body?: string } }) {
      if (cmd.constructor.name === "PutObjectCommand") {
        h.state.s3Puts.push({ Key: cmd.input.Key, Body: String(cmd.input.Body) });
        return {};
      }
      const body = h.state.s3Objects[cmd.input.Key];
      if (body === undefined) {
        const e = new Error("NoSuchKey");
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd: { input: Record<string, unknown> }) {
      h.state.lambdaCalls.push(JSON.parse(String(cmd.input.Payload)));
      return {};
    }
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@/lib/workflow/jira-read", () => ({
  getTicketsForWorkflowFromJira: vi.fn(async () => (h.state.ticket ? [h.state.ticket] : [])),
}));
vi.mock("@/lib/workflow/jira-client", () => ({
  JiraClient: { fromEnv: () => ({ transitionIssue: vi.fn() }) },
}));

let POST: typeof import("./route").POST;

const SAVED = ["ARTIFACT_BUCKET", "GITHUB_PAT", "TICKET_PROVIDER"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

async function load() {
  vi.resetModules();
  ({ POST } = await import("./route"));
}

/** POST with the middleware-stamped identity headers (the ONLY actor source). */
function post(body: Record<string, unknown>, user = "alice@example.com") {
  return POST(
    new NextRequest("http://localhost/api/workflow/wf_1/tickets/mark-done", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "x-agentcore-user": user, "x-agentcore-tenant": "acme" },
    }),
    { params: { id: "wf_1" } }
  );
}

const WORKFLOW = {
  workflowId: "wf_1",
  epicId: "EPIC-1",
  featureBranch: "feature/wf_1-shared",
  repoConfig: { repos: [{ url: "https://github.com/acme/hub.git", defaultBranch: "main" }] },
  agentTasks: { "T-1": { ticketId: "T-1", status: "running", agentId: "agentcore_hub_backend_dev" } },
};
const TICKET = {
  ticketId: "T-1",
  workflowId: "wf_1",
  status: "in_progress",
  assignee: "agentcore_hub_backend_dev",
};

/** The field-scoped evidence merge (the write the completion gate later reads). */
const evidenceMerge = () =>
  h.state.updates.find((u) => u.ConditionExpression === "attribute_exists(agentTasks.#tid)");
const mergedFields = (): Record<string, unknown> => {
  const u = evidenceMerge();
  if (!u) return {};
  const names = u.ExpressionAttributeNames as Record<string, string>;
  const values = u.ExpressionAttributeValues as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [placeholder, field] of Object.entries(names)) {
    if (placeholder === "#tid") continue;
    out[field] = values[`:v${placeholder.slice(2)}`];
  }
  return out;
};

beforeEach(() => {
  h.state.workflow = { ...WORKFLOW };
  h.state.ticket = { ...TICKET };
  h.state.s3Objects = {};
  h.state.s3Puts.length = 0;
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.lambdaCalls.length = 0;
  h.state.github = {};
  h.state.githubCalls.length = 0;
  h.state.noTaskEntry = false;
  for (const k of SAVED) saved[k] = process.env[k];
  process.env.ARTIFACT_BUCKET = "test-bucket";
  process.env.TICKET_PROVIDER = "dynamodb";
  delete process.env.GITHUB_PAT;
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

/** Stub global fetch as a tiny GitHub: `github` maps a path fragment → payload. */
function stubGithub(routes: Record<string, unknown>) {
  process.env.GITHUB_PAT = "ghp_test";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).replace("https://api.github.com", "");
      h.state.githubCalls.push(path);
      const hit = Object.entries(routes).find(([frag]) => path.includes(frag));
      if (!hit) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => hit[1] };
    })
  );
}

describe("mark-done — harvest order", () => {
  it("1. the agent's completions record wins: its summary/branch/PR become the evidence", async () => {
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify({
      source: "agent",
      ticket_id: "T-1",
      summary: "Implemented the endpoints; 12 tests green.",
      branch: "feature/T-1-backend-dev",
      commit_sha: "aaa1111",
      pr_url: "https://github.com/acme/hub/pull/12",
    });
    await load();
    const res = await post({ ticketId: "T-1" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ticketId: "T-1",
      evidenceSource: "record",
      branch: "feature/T-1-backend-dev",
      commitSha: "aaa1111",
      prUrl: "https://github.com/acme/hub/pull/12",
    });
    expect(mergedFields()).toMatchObject({
      output: "Implemented the endpoints; 12 tests green.",
      branch: "feature/T-1-backend-dev",
      commitSha: "aaa1111",
      prUrl: "https://github.com/acme/hub/pull/12",
      evidenceSource: "manager",
      markedDoneBy: "alice@example.com",
    });
    // The board moves LAST, and through the same tickets Lambda every other
    // console path uses.
    expect(h.state.lambdaCalls).toEqual([
      {
        tool_name: "Tickets___transition_ticket",
        parameters: { ticket_id: "T-1", transition_id: "done", reason: "Marked done by alice@example.com" },
      },
    ]);
  });

  it("2. no record → GitHub: a pushed branch with a PR is harvested (the agent died before reporting)", async () => {
    stubGithub({
      "/branches/feature%2FT-1-agentcore_hub_backend_dev": {
        name: "feature/T-1-agentcore_hub_backend_dev",
        commit: { sha: "bbb2222" },
      },
      "/compare/": { ahead_by: 3 },
      "/pulls?head=": [
        { number: 44, html_url: "https://github.com/acme/hub/pull/44", state: "open", head: { ref: "feature/T-1-agentcore_hub_backend_dev" } },
      ],
    });
    await load();
    const res = await post({ ticketId: "T-1" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evidenceSource).toBe("github");
    expect(body.commitSha).toBe("bbb2222");
    expect(body.prUrl).toBe("https://github.com/acme/hub/pull/44");
    expect(String(mergedFields().output)).toContain("3 commit(s) on feature/T-1-agentcore_hub_backend_dev");
    expect(h.state.githubCalls.some((p) => p.startsWith("/repos/acme/hub/branches/"))).toBe(true);
  });

  it("3. no record and nothing on GitHub → the human's own words are accepted as evidence", async () => {
    stubGithub({}); // every probe 404s
    await load();
    const res = await post({ ticketId: "T-1", evidence: "Verified by hand in staging; screenshots on the ticket." });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evidenceSource).toBe("typed");
    expect(mergedFields()).toMatchObject({
      output: "Verified by hand in staging; screenshots on the ticket.",
      evidenceSource: "manager",
    });
    expect(mergedFields().branch).toBeUndefined(); // nothing invented
  });

  it("nothing anywhere → 409 NO_EVIDENCE, and NOTHING is written or transitioned", async () => {
    await load();
    const res = await post({ ticketId: "T-1" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("NO_EVIDENCE");
    expect(body.error).toContain("evidence");
    expect(h.state.updates).toEqual([]);
    expect(h.state.s3Puts).toEqual([]);
    expect(h.state.lambdaCalls).toEqual([]);
    expect(h.state.events).toEqual([]);
  });

  it("an evidence-less completions record does not count (falls through to the typed text)", async () => {
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify({ ticket_id: "T-1", summary: "   " });
    await load();
    const res = await post({ ticketId: "T-1", evidence: "checked it myself" });
    expect((await res.json()).evidenceSource).toBe("typed");
  });
});

describe("mark-done — refuse_if_protected", () => {
  it("a human-assigned gate is 409 PROTECTED_TICKET — a decision cannot be marked done", async () => {
    h.state.ticket = { ...TICKET, ticketId: "TEAM-3757", assignee: "human:reviewer@example.com", status: "todo" };
    h.state.s3Objects["completions/TEAM-3757.json"] = JSON.stringify({ summary: "looks fine to me" });
    await load();
    const res = await post({ ticketId: "TEAM-3757" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PROTECTED_TICKET");
    expect(body.error).toContain("transition endpoint");
    // Refused BEFORE any write — no evidence, no record, no transition.
    expect(h.state.updates).toEqual([]);
    expect(h.state.s3Puts).toEqual([]);
    expect(h.state.lambdaCalls).toEqual([]);
  });

  it("an in_review ticket is 409 PROTECTED_TICKET even with an agent assignee", async () => {
    h.state.ticket = { ...TICKET, status: "in_review" };
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify({ summary: "done really" });
    await load();
    const res = await post({ ticketId: "T-1" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PROTECTED_TICKET");
    expect(h.state.updates).toEqual([]);
  });
});

describe("mark-done — security invariants (F16)", () => {
  beforeEach(() => {
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify({ summary: "the work", commit_sha: "aaa1111" });
  });

  it("a body-supplied actor is IGNORED — markedDoneBy comes from the identity header", async () => {
    await load();
    const res = await post({ ticketId: "T-1", by: "ceo@example.com", markedDoneBy: "ceo@example.com" }, "alice@example.com");
    expect(res.status).toBe(200);
    expect(mergedFields().markedDoneBy).toBe("alice@example.com");
    expect(JSON.parse(h.state.s3Puts[0].Body).marked_done_by).toBe("alice@example.com");
    expect((h.state.events[0].detail as Record<string, unknown>).by).toBe("alice@example.com");
    expect(JSON.stringify(h.state.updates)).not.toContain("ceo@example.com");
  });

  it("NEVER writes mergeCommit / outcome / blockReason — a manager cannot forge a ship verdict", async () => {
    // Even when the body asks for them explicitly.
    await load();
    const res = await post({
      ticketId: "T-1",
      mergeCommit: "ddd4444",
      outcome: "shipped",
      blockReason: "none",
      evidence: "merged it myself",
    });
    expect(res.status).toBe(200);
    const fields = Object.keys(mergedFields());
    expect(fields).not.toContain("mergeCommit");
    expect(fields).not.toContain("outcome");
    expect(fields).not.toContain("blockReason");
    expect(JSON.stringify(h.state.updates)).not.toContain("ddd4444");
    const record = JSON.parse(h.state.s3Puts[0].Body);
    expect(record.source).toBe("manager"); // never "agent"
    expect(record).not.toHaveProperty("merge_commit");
    expect(record).not.toHaveProperty("outcome");
  });

  it("the completions record is stamped source:manager with the audit trail", async () => {
    await load();
    await post({ ticketId: "T-1" });
    expect(h.state.s3Puts[0].Key).toBe("completions/T-1.json");
    expect(JSON.parse(h.state.s3Puts[0].Body)).toMatchObject({
      source: "manager",
      ticket_id: "T-1",
      workflow_id: "wf_1",
      agent_id: "agentcore_hub_backend_dev",
      commit_sha: "aaa1111",
      marked_done_by: "alice@example.com",
    });
  });

  it("publishes manager.intervention so a replay shows the human's hand", async () => {
    await load();
    await post({ ticketId: "T-1" });
    expect(h.state.events).toHaveLength(1);
    expect(h.state.events[0].type).toBe("manager.intervention");
    expect(h.state.events[0].detail).toMatchObject({
      workflowId: "wf_1",
      ticketId: "T-1",
      action: "mark_done",
      evidenceSource: "record",
      by: "alice@example.com",
    });
  });
});

describe("mark-done — plumbing", () => {
  it("seeds a missing agentTasks entry before merging (the agent died before any claim)", async () => {
    h.state.noTaskEntry = true;
    h.state.s3Objects["completions/T-1.json"] = JSON.stringify({ summary: "the work" });
    await load();
    const res = await post({ ticketId: "T-1" });

    expect(res.status).toBe(200);
    const seed = h.state.updates.find((u) => String(u.UpdateExpression).includes("if_not_exists(agentTasks.#tid"));
    expect(seed).toBeTruthy();
    expect((seed!.ExpressionAttributeValues as Record<string, Record<string, unknown>>)[":seed"]).toMatchObject({
      ticketId: "T-1",
      status: "pending",
      agentId: "agentcore_hub_backend_dev",
    });
    // …and the scoped merge is retried after the seed, so the evidence lands.
    expect(h.state.updates.filter((u) => u.ConditionExpression === "attribute_exists(agentTasks.#tid)").length).toBe(2);
  });

  it("400 without a ticketId, 404 for an unknown workflow or ticket", async () => {
    await load();
    expect((await post({})).status).toBe(400);
    h.state.workflow = null;
    expect((await post({ ticketId: "T-1" })).status).toBe(404);
    h.state.workflow = { ...WORKFLOW };
    h.state.ticket = null;
    expect((await post({ ticketId: "T-1" })).status).toBe(404);
  });

  it("no GITHUB_PAT → the probe is skipped entirely (no fetch), not an error", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await load();
    const res = await post({ ticketId: "T-1", evidence: "vouched" });
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
