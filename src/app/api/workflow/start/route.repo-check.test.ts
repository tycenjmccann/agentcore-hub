import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WorkflowDef } from "@/lib/workflow/workflow-defs";

/**
 * Submit-time repo URL pre-flight on POST /api/workflow/start.
 *
 * Same seams mocked as route.test.ts (DDB doc client, ticket Lambda, def
 * loader, source validation) plus the repo-check module itself, so these pin
 * the ROUTE's policy: definitive failure → 422 + hint (nothing written);
 * allowUnresolvedRepo → 200 with repoCheck persisted on the row; soft failure
 * → 200 with repoCheck persisted + echoed; clean → nothing persisted;
 * REPO_CHECK_MODE=off → checker never called.
 */
const h = vi.hoisted(() => {
  const puts: Array<{ TableName: string; Item: Record<string, unknown> }> = [];
  const invokes: Array<{ tool_name: string; parameters: Record<string, unknown> }> = [];
  const check = { fn: vi.fn() };
  return { puts, invokes, check };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class PutCommand {
    constructor(public input: { TableName: string; Item: Record<string, unknown> }) {}
  }
  return {
    PutCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: InstanceType<typeof PutCommand>) => {
          h.puts.push(cmd.input);
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
      h.invokes.push(JSON.parse(Buffer.from(cmd.Payload).toString("utf8")));
      return { Payload: new TextEncoder().encode(JSON.stringify({ key: "TEAM-100" })) };
    }
  }
  return { LambdaClient, InvokeCommand };
});
vi.mock("@/lib/workflow/intake", () => ({
  // TEAM-4054 contract: a structured result + the two pure decision helpers.
  validateIntakeSources: vi.fn(async (sources: unknown[] = []) => ({
    results: [],
    definitiveErrors: [],
    transientErrors: [],
    sources,
  })),
  getSourceValidationMode: vi.fn(() => "lenient" as const),
  shouldRejectSubmission: vi.fn(() => ({ reject: false, errors: [] as string[] })),
}));
vi.mock("@/lib/workflow/repo-check", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/workflow/repo-check")>();
  return { ...real, checkRepoConfig: (...args: unknown[]) => h.check.fn(...args) };
});

const DEF: WorkflowDef = {
  id: "software-delivery",
  name: "Software Delivery",
  description: "test def",
  icon: "Workflow",
  intakeAgentId: "requirements-analyst",
  requiresRepo: true,
  featureBranchPhase: null,
  phases: [],
  reviewGates: [],
} as unknown as WorkflowDef;
vi.mock("@/lib/workflow/defs-loader", () => ({ resolveWorkflowDef: vi.fn(async () => DEF) }));

let POST: (req: NextRequest) => Promise<Response>;
const SAVED_KEYS = ["TICKET_PROVIDER", "REPO_CHECK_MODE", "GITHUB_PAT", "GITHUB_OWNER"] as const;
const saved: Record<string, string | undefined> = {};

const BAD = "https://github.com/tycenj/agentcore-hub";
const GOOD = "https://github.com/tycenjmccann/agentcore-hub";
const repoConfig = (url: string) => ({ layout: "monorepo", repos: [{ url, defaultBranch: "main", platform: "backend" }] });
const bad404 = { url: BAD, ok: false, definitive: true, status: 404, reason: "GitHub 404: tycenj/agentcore-hub not found", suggestions: ["tycenjmccann/agentcore-hub"] };
const soft = { url: BAD, ok: false, definitive: false, status: 403, reason: "GitHub 403 — could not verify" };
const clean = { url: GOOD, ok: true, definitive: true, status: 200, reason: "found" };

beforeEach(async () => {
  h.puts.length = 0;
  h.invokes.length = 0;
  h.check.fn.mockReset();
  for (const key of SAVED_KEYS) saved[key] = process.env[key];
  delete process.env.REPO_CHECK_MODE;
  process.env.GITHUB_PAT = "ghp_test";
  process.env.GITHUB_OWNER = "tycenjmccann";
  process.env.TICKET_PROVIDER = "dynamodb";
  vi.resetModules();
  ({ POST } = await import("./route"));
});
afterEach(() => {
  for (const key of SAVED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
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

describe("POST /api/workflow/start — repo URL pre-flight", () => {
  it("rejects a definitively missing repo with 422, a did-you-mean, and writes nothing", async () => {
    h.check.fn.mockResolvedValue({ checkedAt: "t", results: [bad404] });
    const res = await post({ title: "t", repoConfig: repoConfig(BAD) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/did not resolve/);
    expect(body.suggestions).toEqual(["tycenjmccann/agentcore-hub"]);
    expect(body.hint).toMatch(/allowUnresolvedRepo:true/);
    expect(h.puts.length).toBe(0);
    expect(h.invokes.length).toBe(0);
    // The checker got the server's token + owner — the did-you-mean depends on them.
    expect(h.check.fn).toHaveBeenCalledWith(repoConfig(BAD), { token: "ghp_test", fallbackOwner: "tycenjmccann" });
  });

  it("allowUnresolvedRepo:true lets it through and persists repoCheck on the row for the orchestrator", async () => {
    h.check.fn.mockResolvedValue({ checkedAt: "t", results: [bad404] });
    const res = await post({ title: "t", repoConfig: repoConfig(BAD), allowUnresolvedRepo: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.workflowId).toMatch(/^wf_/);
    expect(json.repoCheck.results[0].url).toBe(BAD);
    expect(h.puts.length).toBe(1);
    expect((h.puts[0].Item.repoCheck as { results: unknown[] }).results).toEqual([bad404]);
  });

  it("a non-definitive failure (rate limit / no token) proceeds with the warning persisted + echoed", async () => {
    h.check.fn.mockResolvedValue({ checkedAt: "t", results: [soft] });
    const res = await post({ title: "t", repoConfig: repoConfig(BAD) });
    expect(res.status).toBe(200);
    expect((await res.json()).repoCheck.results[0].definitive).toBe(false);
    expect((h.puts[0].Item.repoCheck as { results: unknown[] }).results).toEqual([soft]);
  });

  it("a clean check persists NOTHING extra and echoes nothing", async () => {
    h.check.fn.mockResolvedValue({ checkedAt: "t", results: [clean] });
    const res = await post({ title: "t", repoConfig: repoConfig(GOOD) });
    expect(res.status).toBe(200);
    expect("repoCheck" in (await res.json())).toBe(false);
    expect("repoCheck" in h.puts[0].Item).toBe(false);
  });

  it("REPO_CHECK_MODE=off skips the checker entirely (kill switch)", async () => {
    process.env.REPO_CHECK_MODE = "off";
    vi.resetModules();
    ({ POST } = await import("./route"));
    const res = await post({ title: "t", repoConfig: repoConfig(BAD) });
    expect(res.status).toBe(200);
    expect(h.check.fn).not.toHaveBeenCalled();
  });

  it("no repo URLs → checker not consulted", async () => {
    const res = await post({ title: "t", repoConfig: { layout: "multi-repo", repos: [] } });
    expect(res.status).toBe(200);
    expect(h.check.fn).not.toHaveBeenCalled();
  });
});
