import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5781 — the webhook's `request_fix` branch minted a ticket id with its own
 * `__COUNTER__` UpdateCommand and upserted the fix ticket straight into DynamoDB,
 * bypassing the tickets Lambda's create_ticket (validation, gate guards,
 * idempotency). Nothing in the repo ever posts `event_type: "request_fix"` to this
 * route (docs/architecture.md already called it dead code), so the branch — and
 * the webhook's private `nextTicketId` it alone called — is deleted outright
 * rather than rerouted through create_ticket.
 *
 * Seam-mocked exactly like src/app/api/bugs/route.test.ts: the real POST handler
 * runs; only the DynamoDB doc client is stubbed, with every send() recorded.
 *
 * TEAM-5917 — `h.row` plays the live `agentcore-hub-workflows` item: GetCommand
 * reads it, and an UpdateCommand against that table evaluates its
 * ConditionExpression against it (mirroring lambda/orchestrator's miniDdb,
 * evidence-harvest.test.mjs) before applying the SET, so a condition that would
 * fail in DynamoDB throws ConditionalCheckFailedException here too. This is what
 * lets a test see whether a replayed agent_completion re-stamps completedAt.
 */
const WORKFLOWS_TABLE = "agentcore-hub-workflows";

const h = vi.hoisted(() => ({
  sends: [] as Array<{ name: string; input: Record<string, unknown> }>,
  row: { workflowId: "wf_1", agentTasks: {} } as Record<string, unknown>,
  // When set, any UpdateCommand against the workflows table whose expression
  // touches `completedAt` (aliased pre-fix, literal post-fix) throws this
  // instead of evaluating the condition — simulates a non-condition DDB error
  // (throttle, auth, service fault) on the completion-stamp write.
  forceErrorOnCompletedAtWrite: null as (Error & { name: string }) | null,
}));

function resolvePath(path: string, names?: Record<string, string>): string[] {
  return path.split(".").map((seg) => names?.[seg] ?? seg);
}

function getAtPath(row: Record<string, unknown>, segs: string[]): unknown {
  return segs.reduce((o: unknown, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), row);
}

function setAtPath(row: Record<string, unknown>, segs: string[], v: unknown) {
  let o = row;
  for (const k of segs.slice(0, -1)) {
    o = (o[k] ??= {}) as Record<string, unknown>;
  }
  o[segs.at(-1) as string] = v;
}

/** Mirrors lambda/orchestrator/evidence-harvest.test.mjs's miniDdb condition evaluator. */
function evalCondition(
  ce: string | undefined,
  row: Record<string, unknown>,
  names?: Record<string, string>,
  values?: Record<string, unknown>
): boolean {
  if (!ce) return true;
  const bool = ce
    .replace(/attribute_(not_)?exists\(([^)]+)\)/g, (_m, not, p) =>
      String((getAtPath(row, resolvePath(p, names)) !== undefined) !== Boolean(not))
    )
    .replace(/([\w.#]+)\s*<>\s*(:\w+)/g, (_m, p, ph) => String(getAtPath(row, resolvePath(p, names)) !== values?.[ph]))
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||");
  return Boolean(new Function(`return (${bool});`)());
}

function applySet(ue: string, row: Record<string, unknown>, names?: Record<string, string>, values?: Record<string, unknown>) {
  for (const [, lhs, rhs] of ue.replace(/^\s*SET\s+/i, "").matchAll(/([\w.#]+)\s*=\s*(:\w+)/g)) {
    setAtPath(row, resolvePath(lhs, names), values?.[rhs]);
  }
}

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    UpdateCommand,
    GetCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
          const name = cmd.constructor.name;
          h.sends.push({ name, input: cmd.input });
          if (name === "GetCommand") return { Item: h.row };

          const input = cmd.input as {
            TableName?: string;
            UpdateExpression?: string;
            ConditionExpression?: string;
            ExpressionAttributeNames?: Record<string, string>;
            ExpressionAttributeValues?: Record<string, unknown>;
          };
          if (input.TableName !== WORKFLOWS_TABLE) return { Attributes: { nextNum: 1 } };

          const ue = input.UpdateExpression || "";
          const names = input.ExpressionAttributeNames;
          const touchesCompletedAt = ue.includes("completedAt") || Object.values(names ?? {}).includes("completedAt");
          if (touchesCompletedAt && h.forceErrorOnCompletedAtWrite) throw h.forceErrorOnCompletedAtWrite;

          if (!evalCondition(input.ConditionExpression, h.row, names, input.ExpressionAttributeValues)) {
            const e = new Error("conditional check failed") as Error & { name: string };
            e.name = "ConditionalCheckFailedException";
            throw e;
          }
          applySet(ue, h.row, names, input.ExpressionAttributeValues);
          return {};
        },
      }),
    },
  };
});

let POST: typeof import("./route").POST;

beforeEach(async () => {
  h.sends.length = 0;
  h.row = { workflowId: "wf_1", agentTasks: {} };
  h.forceErrorOnCompletedAtWrite = null;
  vi.resetModules();
  ({ POST } = await import("./route"));
});

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/workflow/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/workflow/webhook — request_fix is not a live action (TEAM-5781)", () => {
  it("request_fix is ignored and writes NOTHING to DynamoDB (no orphan ticket-id mint, no bare upsert)", async () => {
    const res = await post({
      event_type: "request_fix",
      workflow_id: "wf_1",
      target_agent: "dev-1",
      findings: "QA found a bug",
      qa_ticket_id: "TEAM-42",
    });
    const json = await res.json();
    expect(json).toEqual({ received: true, ignored: true });
    expect(h.sends.length).toBe(0);
  });

  it("sanity: jira_transition still writes exactly one status Update (the mock really observes writes)", async () => {
    const res = await post({
      event_type: "jira_transition",
      issue_key: "TEAM-7",
      changelog: { items: [{ field: "status", toString: "Done" }] },
    });
    const json = await res.json();
    expect(json).toEqual({ received: true, processed: true, mode: "lambda" });
    expect(h.sends.filter((s) => s.name === "UpdateCommand").length).toBe(1);
  });
});

/**
 * TEAM-5917 — the webhook's agent_completion handler wrote agentTasks.<tid>.status
 * and .completedAt unconditionally (gated only on the entry existing), so a
 * replayed completion re-stamps completedAt. completeTaskEntry (lambda/orchestrator,
 * TEAM-5890) only stamps once per generation: running/failed/no-status -> complete
 * stamps; already-complete does not. The fix must mirror that condition exactly
 * while still merging metadata (branch/commitSha/prUrl/output) unconditionally.
 */
describe("POST /api/workflow/webhook — agent_completion stamps completedAt once per generation (TEAM-5917)", () => {
  const T0 = "2026-01-01T00:00:00.000Z";
  const T1 = "2026-01-01T00:05:00.000Z";

  function agentCompletion(ticketId: string, extra: Record<string, unknown> = {}) {
    return post({
      event_type: "agent_completion",
      workflow_id: "wf_1",
      agent_id: "dev-1",
      ticket_id: ticketId,
      branch: "feature/x",
      commit_sha: "abc123",
      pr_url: "https://github.com/org/repo/pull/1",
      ...extra,
    });
  }

  it("replayed agent_completion keeps original completedAt", async () => {
    (h.row.agentTasks as Record<string, unknown>)["TEAM-2"] = {
      agentId: "dev-1",
      ticketId: "TEAM-2",
      status: "complete",
      startedAt: T0,
      completedAt: T1,
    };

    const res = await agentCompletion("TEAM-2");
    expect(res.status).toBe(200);

    const task = (h.row.agentTasks as Record<string, Record<string, unknown>>)["TEAM-2"];
    expect(task.completedAt).toBe(T1); // must NOT move to a fresh "now"
    expect(task.status).toBe("complete");
    expect(task.commitSha).toBe("abc123"); // metadata merge still happens
  });

  it("first agent_completion on a running task stamps it", async () => {
    (h.row.agentTasks as Record<string, unknown>)["TEAM-3"] = {
      agentId: "dev-1",
      ticketId: "TEAM-3",
      status: "running",
      startedAt: T0,
    };

    const res = await agentCompletion("TEAM-3");
    expect(res.status).toBe(200);

    const task = (h.row.agentTasks as Record<string, Record<string, unknown>>)["TEAM-3"];
    expect(task.status).toBe("complete");
    expect(typeof task.completedAt).toBe("string");
    expect((task.completedAt as string) >= T0).toBe(true);
  });

  it("agent_completion on a failed task still stamps it (completeTaskEntry only blocks already-complete)", async () => {
    (h.row.agentTasks as Record<string, unknown>)["TEAM-4"] = {
      agentId: "dev-1",
      ticketId: "TEAM-4",
      status: "failed",
      startedAt: T0,
    };

    const res = await agentCompletion("TEAM-4");
    expect(res.status).toBe(200);

    const task = (h.row.agentTasks as Record<string, Record<string, unknown>>)["TEAM-4"];
    expect(task.status).toBe("complete");
    expect(typeof task.completedAt).toBe("string");
  });

  it("non-condition error on the completion stamp returns 500 (not swallowed)", async () => {
    (h.row.agentTasks as Record<string, unknown>)["TEAM-5"] = {
      agentId: "dev-1",
      ticketId: "TEAM-5",
      status: "running",
      startedAt: T0,
    };
    const e = new Error("ProvisionedThroughputExceededException") as Error & { name: string };
    e.name = "ProvisionedThroughputExceededException";
    h.forceErrorOnCompletedAtWrite = e;

    const res = await agentCompletion("TEAM-5");
    expect(res.status).toBe(500);
  });
});
