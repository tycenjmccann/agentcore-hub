import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { CURRENT_REPORT_VERSION } from "@/lib/workflow/performance";
import { TERMINAL_PHASES } from "@/lib/workflow/types";

/**
 * TEAM-4483 — POST /api/workflow/performance triggers an asynchronous recompute
 * of one terminal run's performance card.
 *
 * The security-relevant properties this pins, in order of how badly they'd hurt:
 *  1. A malformed workflowId reaches ZERO AWS calls, and the guard's `typeof`
 *     half survives refactors — RegExp.test stringifies, so ["wf_a"] and 12345
 *     would sail through a pattern-only check.
 *  2. The Lambda's FunctionName and Payload are never influenced by the body.
 *  3. A failure answers with a STATIC message: raw AWS errors carry the account
 *     id and the assumed-role ARN.
 *  4. This surface never writes DynamoDB — the only DDB traffic is GetCommand.
 *
 * Mocked at the SDK seam (the same idiom as [id]/cancel/route.test.ts and
 * cd-registry/route.test.ts) rather than at @/lib/workflow/dynamo-read, so the
 * real read helper runs and every command it issues can be inspected.
 */

const h = vi.hoisted(() => ({
  state: {
    /** workflows table, keyed by workflowId; undefined = no Item. */
    workflows: {} as Record<string, Record<string, unknown> | undefined>,
    /** artifact bucket, keyed by S3 key; undefined = NoSuchKey. */
    s3Objects: {} as Record<string, string | undefined>,
    /** every DynamoDB command object the route caused. */
    ddbSends: [] as Array<{ name: string; input: Record<string, unknown> }>,
    s3Gets: [] as string[],
    invokes: [] as Array<Record<string, unknown>>,
    /** when set, the Lambda client throws it instead of invoking. */
    invokeError: null as Error | null,
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class ScanCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class QueryCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class BatchGetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    ScanCommand,
    QueryCommand,
    BatchGetCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          h.state.ddbSends.push({ name: cmd.constructor.name, input: cmd.input });
          if (cmd.constructor.name !== "GetCommand") {
            throw new Error(`unexpected DynamoDB command ${cmd.constructor.name}`);
          }
          const key = (cmd.input.Key as { workflowId?: string } | undefined)?.workflowId ?? "";
          return { Item: h.state.workflows[key] };
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      if (cmd.constructor.name !== "GetObjectCommand") {
        throw new Error(`unexpected S3 command ${cmd.constructor.name}`);
      }
      const key = cmd.input.Key as string;
      h.state.s3Gets.push(key);
      const body = h.state.s3Objects[key];
      if (body === undefined) {
        const e = new Error("The specified key does not exist.");
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd: { input: Record<string, unknown> }) {
      if (h.state.invokeError) throw h.state.invokeError;
      h.state.invokes.push(cmd.input);
      return { StatusCode: 202 };
    }
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

type RouteModule = typeof import("./route");
let route: RouteModule;

async function load() {
  vi.resetModules();
  route = await import("./route");
}

const SAVED = ["ARTIFACT_BUCKET", "COST_REPORT_FUNCTION"] as const;
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

const CARD_KEY = (id: string) => `workflows/${id}/shared/performance-card.json`;
const post = (body: unknown, raw?: string) =>
  new NextRequest("http://localhost/api/workflow/performance", {
    method: "POST",
    body: raw ?? JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

/** A terminal run with no card yet — the plain 202 path. */
function seedTerminalRun(id = "wf_1") {
  h.state.workflows[id] = { workflowId: id, phase: "complete" };
  return id;
}

function noAwsCalls() {
  expect(h.state.ddbSends).toHaveLength(0);
  expect(h.state.s3Gets).toHaveLength(0);
  expect(h.state.invokes).toHaveLength(0);
}

beforeEach(async () => {
  h.state.workflows = {};
  h.state.s3Objects = {};
  h.state.ddbSends.length = 0;
  h.state.s3Gets.length = 0;
  h.state.invokes.length = 0;
  h.state.invokeError = null;
  for (const k of SAVED) saved[k] = process.env[k];
  // ARTIFACT_BUCKET is read at module load (src/lib/workflow/agent-setup.ts),
  // so it has to be set before the dynamic import.
  process.env.ARTIFACT_BUCKET = "test-bucket";
  delete process.env.COST_REPORT_FUNCTION;
  await load();
  route.__resetInflightForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("POST validation — nothing reaches AWS until the id is known-good", () => {
  // The array and number entries are the point of the `typeof` guard:
  // /^[\w-]+$/.test(["wf_a"]) and .test(12345) are both TRUE.
  const BAD_BODIES: Array<[string, unknown]> = [
    ["array (RegExp.test stringifies it)", { workflowId: ["wf_a"] }],
    ["number (RegExp.test stringifies it)", { workflowId: 12345 }],
    ["boolean", { workflowId: true }],
    ["null", { workflowId: null }],
    ["object", { workflowId: {} }],
    ["missing key", {}],
    ["empty string", { workflowId: "" }],
    ["slash", { workflowId: "a/b" }],
    ["dot", { workflowId: "a.b" }],
    ["traversal", { workflowId: "../x" }],
    ["non-ascii", { workflowId: "café" }],
    ["space", { workflowId: "a b" }],
    ["newline", { workflowId: "a\nb" }],
    ["null body", null],
  ];

  it.each(BAD_BODIES)("400s on %s with zero SDK calls", async (_label, body) => {
    // Seeded so a leaky implementation would have something to find.
    seedTerminalRun("wf_a");
    const res = await route.POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid workflowId" });
    noAwsCalls();
  });

  it("400s on an unparseable body", async () => {
    const res = await route.POST(post(undefined, "{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid workflowId" });
    noAwsCalls();
  });

  it("500s with zero SDK calls when ARTIFACT_BUCKET is unset", async () => {
    delete process.env.ARTIFACT_BUCKET;
    await load();
    const res = await route.POST(post({ workflowId: "wf_1" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "ARTIFACT_BUCKET not configured" });
    noAwsCalls();
  });
});

describe("POST lifecycle", () => {
  it("404s an unknown workflow after exactly one GetItem", async () => {
    const res = await route.POST(post({ workflowId: "wf_missing" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown workflow" });
    expect(h.state.ddbSends).toHaveLength(1);
    expect(h.state.s3Gets).toHaveLength(0);
    expect(h.state.invokes).toHaveLength(0);
  });

  it("404s a tombstoned workflow (the read helper hides deleted rows)", async () => {
    h.state.workflows.wf_dead = { workflowId: "wf_dead", phase: "complete", deleted: true };
    const res = await route.POST(post({ workflowId: "wf_dead" }));
    expect(res.status).toBe(404);
    expect(h.state.invokes).toHaveLength(0);
  });

  it.each(["development", "requirements", "design", "qa", "ship", "in_progress"])(
    "409s a run still in %s and never invokes",
    async (phase) => {
      h.state.workflows.wf_1 = { workflowId: "wf_1", phase };
      const res = await route.POST(post({ workflowId: "wf_1" }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "run is not terminal" });
      expect(h.state.s3Gets).toHaveLength(0);
      expect(h.state.invokes).toHaveLength(0);
    }
  );

  it.each([...TERMINAL_PHASES])("accepts a %s run (every TERMINAL_PHASES member, not just complete)", async (phase) => {
    h.state.workflows.wf_1 = { workflowId: "wf_1", phase };
    const res = await route.POST(post({ workflowId: "wf_1" }));
    expect(res.status).toBe(202);
    expect(h.state.invokes).toHaveLength(1);
  });

  it("409s a null/absent phase (an unknown phase is not terminal)", async () => {
    h.state.workflows.wf_1 = { workflowId: "wf_1" };
    expect((await route.POST(post({ workflowId: "wf_1" }))).status).toBe(409);
    expect(h.state.invokes).toHaveLength(0);
  });

  it("200s with the stored card, and does NOT invoke, when it is already current", async () => {
    const id = seedTerminalRun();
    const card = { workflowId: id, reportVersion: CURRENT_REPORT_VERSION, kpi: { version: 1 } };
    h.state.s3Objects[CARD_KEY(id)] = JSON.stringify(card);
    const res = await route.POST(post({ workflowId: id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ card });
    expect(h.state.invokes).toHaveLength(0);
  });

  it("202s when the stored card is an older report version", async () => {
    const id = seedTerminalRun();
    h.state.s3Objects[CARD_KEY(id)] = JSON.stringify({ workflowId: id, reportVersion: CURRENT_REPORT_VERSION - 1 });
    const res = await route.POST(post({ workflowId: id }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, workflowId: id, pollAfterMs: 3000 });
    expect(h.state.invokes).toHaveLength(1);
  });

  it("202s with an Event invoke whose payload is exactly { workflowId }", async () => {
    const id = seedTerminalRun();
    const res = await route.POST(post({ workflowId: id }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, workflowId: id, pollAfterMs: 3000 });
    expect(h.state.invokes).toHaveLength(1);
    const [invoke] = h.state.invokes;
    expect(invoke.InvocationType).toBe("Event");
    expect(JSON.parse(Buffer.from(invoke.Payload as Uint8Array).toString())).toEqual({ workflowId: id });
  });
});

describe("POST — the Lambda target is never client-controlled", () => {
  it("defaults FunctionName to the naming convention", async () => {
    const id = seedTerminalRun();
    await route.POST(post({ workflowId: id }));
    expect(h.state.invokes[0].FunctionName).toBe("agentcore-hub-cost-report");
  });

  it("honours COST_REPORT_FUNCTION", async () => {
    process.env.COST_REPORT_FUNCTION = "custom-fn";
    const id = seedTerminalRun();
    await route.POST(post({ workflowId: id }));
    expect(h.state.invokes[0].FunctionName).toBe("custom-fn");
  });

  it("ignores FunctionName / functionName / force injected via the body", async () => {
    const id = seedTerminalRun("wf_x");
    const res = await route.POST(
      post({ workflowId: id, functionName: "evil", FunctionName: "evil", force: true, region: "eu-west-1" })
    );
    expect(res.status).toBe(202);
    const [invoke] = h.state.invokes;
    expect(invoke.FunctionName).toBe("agentcore-hub-cost-report");
    expect(JSON.parse(Buffer.from(invoke.Payload as Uint8Array).toString())).toEqual({ workflowId: "wf_x" });
  });
});

describe("POST in-flight de-dupe", () => {
  it("429s a repeat with both wait hints and no second invoke", async () => {
    const id = seedTerminalRun();
    expect((await route.POST(post({ workflowId: id }))).status).toBe(202);

    const res = await route.POST(post({ workflowId: id }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("compute already in flight");
    expect(body.pollAfterMs).toBe(3000);
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.retryAfterMs).toBeLessThanOrEqual(600_000);
    expect(h.state.invokes).toHaveLength(1);
  });

  it("holds the claim for the full 600 s Lambda timeout, not 60 s", async () => {
    vi.useFakeTimers();
    const id = seedTerminalRun();
    expect((await route.POST(post({ workflowId: id }))).status).toBe(202);

    // The ticket's original 60 s would have expired here; the security review
    // raised it to the cost-report Lambda's own timeout.
    vi.advanceTimersByTime(61_000);
    expect((await route.POST(post({ workflowId: id }))).status).toBe(429);
    expect(h.state.invokes).toHaveLength(1);

    vi.advanceTimersByTime(600_001);
    expect((await route.POST(post({ workflowId: id }))).status).toBe(202);
    expect(h.state.invokes).toHaveLength(2);
  });

  it("de-dupes per workflow, not globally", async () => {
    seedTerminalRun("wf_a");
    seedTerminalRun("wf_b");
    expect((await route.POST(post({ workflowId: "wf_a" }))).status).toBe(202);
    expect((await route.POST(post({ workflowId: "wf_b" }))).status).toBe(202);
    expect(h.state.invokes).toHaveLength(2);
  });

  it("sweeps EVERY expired marker, so the map can't grow without bound", async () => {
    vi.useFakeTimers();
    const ids = Array.from({ length: 25 }, (_, i) => seedTerminalRun(`wf_${i}`));
    for (const id of ids) expect((await route.POST(post({ workflowId: id }))).status).toBe(202);
    expect(route.__inflightSizeForTests()).toBe(25);

    vi.advanceTimersByTime(600_001);
    const fresh = seedTerminalRun("wf_fresh");
    expect((await route.POST(post({ workflowId: fresh }))).status).toBe(202);
    // One POST collapsed all 25 stale markers, leaving only its own.
    expect(route.__inflightSizeForTests()).toBe(1);
  });

  it("leaves no marker behind for an invalid, unknown or non-terminal id", async () => {
    h.state.workflows.wf_open = { workflowId: "wf_open", phase: "development" };
    expect((await route.POST(post({ workflowId: ["wf_a"] }))).status).toBe(400);
    expect((await route.POST(post(undefined, "{nope"))).status).toBe(400);
    expect((await route.POST(post({ workflowId: "wf_missing" }))).status).toBe(404);
    expect((await route.POST(post({ workflowId: "wf_open" }))).status).toBe(409);
    expect(route.__inflightSizeForTests()).toBe(0);

    // ...and an already-current card doesn't claim either.
    const id = seedTerminalRun();
    h.state.s3Objects[CARD_KEY(id)] = JSON.stringify({ reportVersion: CURRENT_REPORT_VERSION });
    expect((await route.POST(post({ workflowId: id }))).status).toBe(200);
    expect(route.__inflightSizeForTests()).toBe(0);
  });
});

describe("POST failure handling", () => {
  const ARN_ERROR =
    "User: arn:aws:sts::123456789012:assumed-role/agentcore-hub-ecs-task/x is not authorized to perform: " +
    "lambda:InvokeFunction on resource: arn:aws:lambda:us-east-1:123456789012:function:agentcore-hub-cost-report";

  it("500s with a static body that leaks no account id or ARN, and logs the real error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = seedTerminalRun();
    h.state.invokeError = new Error(ARN_ERROR);

    const res = await route.POST(post({ workflowId: id }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "failed to start performance report" });
    expect(JSON.stringify(body)).not.toMatch(/\d{12}|assumed-role|arn:aws|InvokeFunction/);
    expect(errorSpy).toHaveBeenCalled();
    // The operator still gets the detail, just not the client.
    const logged = errorSpy.mock.calls.flat().map((a) => (a instanceof Error ? a.message : String(a)));
    expect(logged.join(" ")).toContain("assumed-role");
  });

  it("releases the claim on failure, so an immediate retry is not locked out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = seedTerminalRun();
    h.state.invokeError = new Error(ARN_ERROR);
    expect((await route.POST(post({ workflowId: id }))).status).toBe(500);
    expect(route.__inflightSizeForTests()).toBe(0);

    h.state.invokeError = null;
    expect((await route.POST(post({ workflowId: id }))).status).toBe(202);
    expect(h.state.invokes).toHaveLength(1);
  });

  it("500s statically when the card read itself fails (not a NoSuchKey)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = seedTerminalRun();
    // A non-NoSuchKey S3 error must propagate out of getJson, per its contract.
    h.state.s3Objects[CARD_KEY(id)] = "{ this is not json";
    const res = await route.POST(post({ workflowId: id }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "failed to start performance report" });
    expect(h.state.invokes).toHaveLength(0);
    expect(route.__inflightSizeForTests()).toBe(0);
  });
});

describe("this surface never writes DynamoDB", () => {
  it("issues only GetCommands across every branch", async () => {
    seedTerminalRun("wf_ok");
    h.state.workflows.wf_open = { workflowId: "wf_open", phase: "development" };
    const done = seedTerminalRun("wf_done");
    h.state.s3Objects[CARD_KEY(done)] = JSON.stringify({ reportVersion: CURRENT_REPORT_VERSION });

    for (const body of [
      { workflowId: ["bad"] },
      { workflowId: "wf_missing" },
      { workflowId: "wf_open" },
      { workflowId: "wf_done" },
      { workflowId: "wf_ok" },
      { workflowId: "wf_ok" }, // the 429 path
    ]) {
      await route.POST(post(body));
    }
    expect(h.state.ddbSends.length).toBeGreaterThan(0);
    for (const send of h.state.ddbSends) expect(send.name).toBe("GetCommand");
  });

  it("names no write command in its source", () => {
    const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\b(Put|Update|Delete|BatchWrite|TransactWrite)(Item)?Command\b/);
    expect(src).not.toMatch(/PutObjectCommand/);
  });
});

describe("GET", () => {
  it("serves a stored card", async () => {
    h.state.s3Objects[CARD_KEY("wf_1")] = JSON.stringify({ workflowId: "wf_1", reportVersion: 5 });
    const res = await route.GET(new NextRequest("http://localhost/api/workflow/performance?workflowId=wf_1"));
    expect(res.status).toBe(200);
    expect((await res.json()).card.workflowId).toBe("wf_1");
  });

  it("404s a run with no card and 400s a malformed id", async () => {
    const missing = await route.GET(new NextRequest("http://localhost/api/workflow/performance?workflowId=wf_1"));
    expect(missing.status).toBe(404);
    const bad = await route.GET(new NextRequest("http://localhost/api/workflow/performance?workflowId=a%2Fb"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid workflowId" });
  });

  it("builds a fleet view from an empty index", async () => {
    h.state.s3Objects["performance/index.json"] = JSON.stringify({ version: 1, updatedAt: null, cards: [], infra: null });
    const res = await route.GET(new NextRequest("http://localhost/api/workflow/performance?days=7&defId=all"));
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.totals.runs).toBe(0);
    expect(Array.isArray(view.kpis)).toBe(true);
  });

  it("500s with a static message that leaks no ARN (A5)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.s3Objects[CARD_KEY("wf_1")] = "{ not json";
    const res = await route.GET(new NextRequest("http://localhost/api/workflow/performance?workflowId=wf_1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "failed to load performance data" });
    expect(JSON.stringify(body)).not.toMatch(/\d{12}|assumed-role|arn:aws/);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("500s when ARTIFACT_BUCKET is unset", async () => {
    delete process.env.ARTIFACT_BUCKET;
    await load();
    const res = await route.GET(new NextRequest("http://localhost/api/workflow/performance"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "ARTIFACT_BUCKET not configured" });
    noAwsCalls();
  });
});
