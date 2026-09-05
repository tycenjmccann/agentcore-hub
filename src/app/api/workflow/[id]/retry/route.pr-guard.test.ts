import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-3991 D1.5 — the PR-aware dispatch guard on the two human "put the agent
 * back on it" endpoints (retry + nudge/dispatch).
 *
 * A retry restarts the agent from a BLANK session. If it already opened a PR for
 * the ticket, it cannot see that PR and re-investigates from scratch — prod
 * TEAM-3790 re-investigated a finding it had already merged, and a second run
 * opened a competing PR. So:
 *
 *   PR exists, no `resume`  ⇒ 409 PR_EXISTS, nothing stolen, nothing transitioned.
 *   PR exists, `resume:true` ⇒ a resume context is written FIRST, then dispatch.
 *   No PR / no PAT / GitHub down ⇒ FAIL OPEN, dispatch exactly as before.
 *
 * Only the seams are mocked (DDB doc client, lease helpers, global fetch as
 * GitHub); both routes run for real.
 */

const h = vi.hoisted(() => ({
  state: {
    workflow: null as Record<string, unknown> | null,
    ticket: null as Record<string, unknown> | null,
    updates: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    stolen: [] as string[],
    prs: [] as unknown[],
    githubCalls: [] as string[],
    githubThrows: false,
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
  class ScanCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    UpdateCommand,
    PutCommand,
    ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const name = cmd.constructor.name;
          if (name === "GetCommand") {
            return {
              Item:
                cmd.input.TableName === "agentcore-hub-workflows" ? h.state.workflow : h.state.ticket,
            };
          }
          if (name === "UpdateCommand") {
            h.state.updates.push(cmd.input);
            return {};
          }
          if (name === "PutCommand") {
            h.state.events.push(cmd.input.Item as Record<string, unknown>);
            return {};
          }
          if (name === "ScanCommand") return { Items: [] };
          return {};
        },
      }),
    },
  };
});

vi.mock("@/lib/workflow/lease", () => ({
  LEASE_TTL_MS: 900000,
  isLeaseLive: vi.fn(() => false), // the session is dead → the retry is legitimate
  lastAgentActivity: vi.fn(async () => null),
  stealClaim: vi.fn(async (_ddb: unknown, _t: string, _w: string, ticketId: string) => {
    h.state.stolen.push(ticketId);
    return true;
  }),
}));

vi.mock("@/lib/workflow/jira-client", () => ({
  JiraClient: { fromEnv: () => ({ transitionIssue: vi.fn(), getIssue: vi.fn() }) },
  mapJiraStatusToInternal: (s: string) => s,
  blockersFromLinks: () => [],
}));

const WORKFLOW = {
  workflowId: "wf_1",
  epicId: "EPIC-1",
  featureBranch: "shared/wf_1",
  repoConfig: { repos: [{ url: "https://github.com/acme/hub.git", defaultBranch: "main" }] },
  agentTasks: {
    "T-1": {
      ticketId: "T-1",
      agentId: "agentcore_hub_backend_dev",
      status: "running",
      startedAt: "2026-09-01T00:00:00Z",
    },
  },
};

const OPEN_PR = {
  number: 274,
  html_url: "https://github.com/acme/hub/pull/274",
  state: "open",
  head: { ref: "feature/T-1-backend-dev" },
};

const SAVED = ["GITHUB_PAT", "TICKET_PROVIDER"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

function stubGithub() {
  process.env.GITHUB_PAT = "ghp_test";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      h.state.githubCalls.push(String(url));
      if (h.state.githubThrows) throw new Error("ETIMEDOUT");
      return { ok: true, status: 200, json: async () => h.state.prs };
    })
  );
}

const resumeWrite = () =>
  h.state.updates.find((u) => String(u.UpdateExpression).includes("resumeContexts.#k"));

beforeEach(() => {
  h.state.workflow = JSON.parse(JSON.stringify(WORKFLOW));
  h.state.ticket = { ticketId: "T-1", workflowId: "wf_1", status: "in_progress", assignee: "agentcore_hub_backend_dev" };
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.stolen.length = 0;
  h.state.prs = [];
  h.state.githubCalls.length = 0;
  h.state.githubThrows = false;
  for (const k of SAVED) saved[k] = process.env[k];
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

async function loadRetry() {
  vi.resetModules();
  return (await import("./route")).POST;
}
async function loadNudge() {
  vi.resetModules();
  return (await import("../nudge/route")).POST;
}

const req = (body: Record<string, unknown>, path = "retry") =>
  new NextRequest(`http://localhost/api/workflow/wf_1/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("POST retry — PR-aware guard (D1.5)", () => {
  it("an existing OPEN PR refuses the retry with 409 PR_EXISTS — nothing stolen, nothing transitioned", async () => {
    h.state.prs = [OPEN_PR];
    stubGithub();
    const POST = await loadRetry();

    const res = await POST(req({ agentId: "agentcore_hub_backend_dev" }), { params: { id: "wf_1" } });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PR_EXISTS");
    expect(body.number).toBe(274);
    expect(body.prUrl).toBe("https://github.com/acme/hub/pull/274");
    expect(body.state).toBe("open");
    expect(body.merged).toBe(false);
    expect(body.message).toContain("PR #274 exists — resume, don't re-investigate");
    // The claim is untouched and the ticket never moved to ready.
    expect(h.state.stolen).toEqual([]);
    expect(h.state.updates).toEqual([]);
    expect(h.state.events).toEqual([]);
  });

  it("a MERGED PR refuses just the same, and says so (the TEAM-3790 case)", async () => {
    h.state.prs = [{ ...OPEN_PR, state: "closed", merged_at: "2026-09-02T00:00:00Z" }];
    stubGithub();
    const POST = await loadRetry();
    const res = await POST(req({ agentId: "agentcore_hub_backend_dev" }), { params: { id: "wf_1" } });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.state).toBe("merged");
    expect(body.merged).toBe(true);
  });

  it("resume:true writes the resume context, then dispatches", async () => {
    h.state.prs = [OPEN_PR];
    stubGithub();
    const POST = await loadRetry();

    const res = await POST(req({ agentId: "agentcore_hub_backend_dev", resume: true }), { params: { id: "wf_1" } });

    expect(res.status).toBe(200);
    expect((await res.json()).ticketId).toBe("T-1");
    // The note the orchestrator's consumeResumeContext will prepend.
    const write = resumeWrite();
    expect(write).toBeTruthy();
    expect((write!.ExpressionAttributeNames as Record<string, string>)["#k"]).toBe("T-1");
    const note = String((write!.ExpressionAttributeValues as Record<string, unknown>)[":note"]);
    expect(note).toContain("PR #274 exists on feature/T-1-backend-dev");
    expect(note).toContain("resume, don't re-investigate");
    // Written BEFORE the claim was stolen / the ticket re-readied.
    expect(h.state.updates.indexOf(write!)).toBeLessThan(
      h.state.updates.findIndex((u) => String(u.TableName) === "agentcore-hub-tickets")
    );
    expect(h.state.stolen).toEqual(["T-1"]);
    expect(h.state.events.some((e) => e.type === "agent.retry")).toBe(true);
  });

  it("no PR for this ticket → the retry proceeds untouched (other tickets' PRs are not ours)", async () => {
    h.state.prs = [{ ...OPEN_PR, head: { ref: "feature/T-99-dev" } }];
    stubGithub();
    const POST = await loadRetry();
    const res = await POST(req({ agentId: "agentcore_hub_backend_dev" }), { params: { id: "wf_1" } });
    expect(res.status).toBe(200);
    expect(resumeWrite()).toBeUndefined();
    expect(h.state.stolen).toEqual(["T-1"]);
  });

  it("GitHub unreachable → FAILS OPEN: the human's retry still runs", async () => {
    h.state.githubThrows = true;
    stubGithub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const POST = await loadRetry();
    const res = await POST(req({ agentId: "agentcore_hub_backend_dev" }), { params: { id: "wf_1" } });
    expect(res.status).toBe(200);
    expect(h.state.stolen).toEqual(["T-1"]);
    warn.mockRestore();
  });

  it("no GITHUB_PAT → no GitHub call at all", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const POST = await loadRetry();
    const res = await POST(req({ agentId: "agentcore_hub_backend_dev" }), { params: { id: "wf_1" } });
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the guard never fires for a human-owned task entry", async () => {
    (h.state.workflow!.agentTasks as Record<string, Record<string, unknown>>)["T-1"].assignee =
      "human:reviewer@example.com";
    h.state.prs = [OPEN_PR];
    stubGithub();
    const POST = await loadRetry();
    // agentId matches on `assignee` too, so this entry IS the retry target — but a
    // human's ticket is never guarded by an agent's PR.
    const res = await POST(req({ agentId: "human:reviewer@example.com" }), { params: { id: "wf_1" } });
    expect(res.status).toBe(200);
    expect(h.state.githubCalls).toEqual([]);
  });
});

describe("POST nudge (targeted dispatch) — PR-aware guard (D1.5)", () => {
  it("an existing PR refuses the dispatch with 409 PR_EXISTS", async () => {
    h.state.prs = [OPEN_PR];
    stubGithub();
    const POST = await loadNudge();

    const res = await POST(req({ ticketId: "T-1" }, "nudge"), { params: { id: "wf_1" } });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PR_EXISTS");
    expect(body.ticketId).toBe("T-1");
    expect(h.state.updates).toEqual([]); // the ticket was never moved to ready
  });

  it("resume:true dispatches with a resume context", async () => {
    h.state.prs = [OPEN_PR];
    stubGithub();
    const POST = await loadNudge();

    const res = await POST(req({ ticketId: "T-1", resume: true }, "nudge"), { params: { id: "wf_1" } });

    expect(res.status).toBe(200);
    expect((await res.json()).nudged).toEqual(["T-1 (dispatch→ready)"]);
    expect(String((resumeWrite()!.ExpressionAttributeValues as Record<string, unknown>)[":note"])).toContain("PR #274");
  });

  it("no PR → the dispatch behaves exactly as before", async () => {
    stubGithub();
    const POST = await loadNudge();
    const res = await POST(req({ ticketId: "T-1" }, "nudge"), { params: { id: "wf_1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).nudged).toEqual(["T-1 (dispatch→ready)"]);
    expect(resumeWrite()).toBeUndefined();
  });

  it("a bodyless broad scan is not guarded (it dispatches nothing new)", async () => {
    h.state.prs = [OPEN_PR];
    stubGithub();
    const POST = await loadNudge();
    const res = await POST(
      new NextRequest("http://localhost/api/workflow/wf_1/nudge", { method: "POST" }),
      { params: { id: "wf_1" } }
    );
    expect(res.status).toBe(200);
    expect(h.state.githubCalls).toEqual([]);
  });
});
