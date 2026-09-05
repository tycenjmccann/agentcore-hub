/**
 * TEAM-3992 D3.4 — submit_ticket_plan structural validation.
 *
 * Drives the REAL `handler` export with the AWS SDK clients mocked at the module
 * seam (same shape as report-completion.test.mjs). The S3 GetObject seam serves
 * the ACTUAL committed config/workflows.json + config/agents.json, so the plan is
 * validated against the real ticketDag and the real roster — not a stub — while
 * PutObject is captured to prove enforce mode creates nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_JSON = readFileSync(resolve(__dirname, "../../src/config/workflows.json"), "utf8");
const AGENTS_JSON = readFileSync(resolve(__dirname, "../../src/config/agents.json"), "utf8");

const h = vi.hoisted(() => ({ state: { s3Puts: [] } }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.__type === "PutObject") {
        h.state.s3Puts.push(cmd.input);
        return {};
      }
      if (cmd.__type === "GetObject") {
        const body =
          cmd.input.Key === "config/workflows.json"
            ? WORKFLOWS_JSON
            : cmd.input.Key === "config/agents.json"
              ? AGENTS_JSON
              : null;
        if (body == null) throw new Error("NoSuchKey");
        return { Body: { transformToString: async () => body } };
      }
      if (cmd.__type === "ListObjectsV2") return { Contents: [] };
      return {};
    }
  },
  PutObjectCommand: class { constructor(i) { this.input = i; this.__type = "PutObject"; } },
  GetObjectCommand: class { constructor(i) { this.input = i; this.__type = "GetObject"; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; this.__type = "ListObjectsV2"; } },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://example.invalid/x" }));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return { Payload: Buffer.from(JSON.stringify({ ok: true })) }; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ async send() { return {}; } }) },
  PutCommand: class { constructor(i) { this.input = i; } },
}));

async function loadHandler(mode) {
  if (mode) process.env.DAG_VALIDATION_MODE = mode;
  else delete process.env.DAG_VALIDATION_MODE;
  vi.resetModules();
  return (await import("./index.mjs")).handler;
}

function submit(handler, args) {
  return handler({ name: "WorkflowOutput___submit_ticket_plan", arguments: args });
}

function bodyOf(res) {
  return JSON.parse(res.content[0].text);
}

// A structurally valid software-delivery plan.
const VALID_TICKETS = [
  { id: "R", assignee: "agentcore_hub_requirements_analyst", title: "Requirements", blocked_by: [] },
  { id: "D", assignee: "agentcore_hub_backend_designer", title: "Design", blocked_by: ["R"] },
  { id: "DEV", assignee: "agentcore_hub_backend_dev", title: "Build", blocked_by: ["D"] },
  { id: "REV", assignee: "agentcore_hub_code_reviewer", title: "Review", blocked_by: ["DEV"] },
  { id: "QA", assignee: "agentcore_hub_qa_verifier", title: "Verify", blocked_by: ["REV"] },
  { id: "CI", assignee: "agentcore_hub_ci_agent", title: "CI", blocked_by: ["REV"] },
  { id: "SHIP", assignee: "agentcore_hub_release_manager", title: "Ship: X", blocked_by: ["QA", "CI"] },
  { id: "GATE", assignee: "human:engineer", title: "Merge Approval", blocked_by: ["SHIP"] },
  { id: "CD", assignee: "agentcore_hub_release_manager", title: "CD: X", blocked_by: ["GATE"] },
];

// CI blocked_by QA (a serial review→QA→CI chain): forbidden verification→ci AND
// missing review→ci.
const SERIAL_TICKETS = [
  { id: "R", assignee: "agentcore_hub_requirements_analyst", title: "Requirements", blocked_by: [] },
  { id: "DEV", assignee: "agentcore_hub_backend_dev", title: "Build", blocked_by: ["R"] },
  { id: "REV", assignee: "agentcore_hub_code_reviewer", title: "Review", blocked_by: ["DEV"] },
  { id: "QA", assignee: "agentcore_hub_qa_verifier", title: "Verify", blocked_by: ["REV"] },
  { id: "CI", assignee: "agentcore_hub_ci_agent", title: "CI", blocked_by: ["QA"] },
  { id: "SHIP", assignee: "agentcore_hub_release_manager", title: "Ship: X", blocked_by: ["QA", "CI"] },
  { id: "GATE", assignee: "human:engineer", title: "Merge Approval", blocked_by: ["SHIP"] },
  { id: "CD", assignee: "agentcore_hub_release_manager", title: "CD: X", blocked_by: ["GATE"] },
];

// bug-fix with no design ticket (development blocks straight on requirements).
const BUGFIX_TICKETS = [
  { id: "R", assignee: "agentcore_hub_requirements_analyst", title: "Triage", blocked_by: [] },
  { id: "DEV", assignee: "agentcore_hub_backend_dev", title: "Fix", blocked_by: ["R"] },
  { id: "REV", assignee: "agentcore_hub_code_reviewer", title: "Review", blocked_by: ["DEV"] },
  { id: "QA", assignee: "agentcore_hub_qa_verifier", title: "Verify", blocked_by: ["REV"] },
  { id: "CI", assignee: "agentcore_hub_ci_agent", title: "CI", blocked_by: ["REV"] },
  { id: "SHIP", assignee: "agentcore_hub_release_manager", title: "Ship: X", blocked_by: ["QA", "CI"] },
  { id: "GATE", assignee: "human:engineer", title: "Merge Approval", blocked_by: ["SHIP"] },
  { id: "CD", assignee: "agentcore_hub_release_manager", title: "CD: X", blocked_by: ["GATE"] },
];

const SAVED = {};
beforeEach(() => {
  h.state.s3Puts = [];
  for (const k of ["ARTIFACT_BUCKET", "DAG_VALIDATION_MODE"]) SAVED[k] = process.env[k];
  process.env.ARTIFACT_BUCKET = "test-bucket";
});
afterEach(() => {
  for (const k of ["ARTIFACT_BUCKET", "DAG_VALIDATION_MODE"]) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("submit_ticket_plan — enforce (default)", () => {
  it("accepts a valid software-delivery plan and saves it", async () => {
    const handler = await loadHandler("enforce");
    const res = await submit(handler, { workflow_id: "wf1", requirements: "r", tickets: VALID_TICKETS });
    expect(res.isError).toBeFalsy();
    expect(bodyOf(res).status).toBe("saved");
    expect(h.state.s3Puts).toHaveLength(1);
  });

  it("rejects the serial review→QA→CI plan and creates NOTHING", async () => {
    const handler = await loadHandler("enforce");
    const res = await submit(handler, { workflow_id: "wf2", requirements: "r", tickets: SERIAL_TICKETS });
    expect(res.isError).toBe(true);
    const body = bodyOf(res);
    expect(body.status).toBe("rejected");
    expect(body.error).toBe("ticket_plan_invalid");
    expect(body.hint).toMatch(/nothing was created/i);
    expect(body.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "forbidden_edge", from: "verification", to: "ci", ticket: "CI" }),
        expect.objectContaining({ code: "missing_required_edge", from: "review", to: "ci", ticket: "CI" }),
      ])
    );
    expect(h.state.s3Puts).toHaveLength(0);
  });

  it("rejects two Ship tickets with node_cardinality", async () => {
    const handler = await loadHandler("enforce");
    const tickets = [
      ...VALID_TICKETS,
      { id: "SHIP2", assignee: "agentcore_hub_release_manager", title: "Ship: dup", blocked_by: ["QA", "CI"] },
    ];
    const res = await submit(handler, { workflow_id: "wf3", requirements: "r", tickets });
    expect(res.isError).toBe(true);
    expect(bodyOf(res).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "node_cardinality", node: "ship" })])
    );
    expect(h.state.s3Puts).toHaveLength(0);
  });

  it("rejects an unknown blocker key", async () => {
    const handler = await loadHandler("enforce");
    const tickets = VALID_TICKETS.map((t) => (t.id === "DEV" ? { ...t, blocked_by: ["GHOST"] } : t));
    const res = await submit(handler, { workflow_id: "wf4", requirements: "r", tickets });
    expect(res.isError).toBe(true);
    expect(bodyOf(res).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unknown_blocker_key", ticket: "DEV", key: "GHOST" })])
    );
  });

  it("accepts a bug-fix plan with no design ticket", async () => {
    const handler = await loadHandler("enforce");
    const res = await submit(handler, { workflow_id: "wf5", requirements: "r", tickets: BUGFIX_TICKETS, def_id: "bug-fix" });
    expect(res.isError).toBeFalsy();
    expect(bodyOf(res).status).toBe("saved");
  });
});

describe("submit_ticket_plan — shadow", () => {
  it("saves the invalid plan but reports dagViolations", async () => {
    const handler = await loadHandler("shadow");
    const res = await submit(handler, { workflow_id: "wf6", requirements: "r", tickets: SERIAL_TICKETS });
    expect(res.isError).toBeFalsy();
    const body = bodyOf(res);
    expect(body.status).toBe("saved");
    expect(body.dagViolations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "forbidden_edge", to: "ci" })])
    );
    expect(h.state.s3Puts).toHaveLength(1);
  });
});

describe("submit_ticket_plan — off", () => {
  it("skips validation entirely and never reads config", async () => {
    const handler = await loadHandler("off");
    const res = await submit(handler, { workflow_id: "wf7", requirements: "r", tickets: SERIAL_TICKETS });
    expect(res.isError).toBeFalsy();
    expect(bodyOf(res).status).toBe("saved");
    expect(bodyOf(res).dagViolations).toBeUndefined();
    expect(h.state.s3Puts).toHaveLength(1);
  });
});
