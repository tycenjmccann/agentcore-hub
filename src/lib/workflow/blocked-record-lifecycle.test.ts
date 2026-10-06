import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TEAM-5340 F9 — the persona blocked record, end to end through its real writer
 * and its real reader (DL-035 "Blocked is not dead", the cap-resolution lifecycle
 * table in docs/architecture.md).
 *
 * Writer: the persona itself, following its blueprint, through
 * `S3Storage___write_object` — which is workflow-output's handler. Reader: the
 * dead-session detector's `blockedEvidence`, reached through `runSweep` with its
 * `readArtifactJson` seam reading back what the handler stored. A text pin on the
 * blueprint alone could agree with the reader and still be refused as a protected
 * key, or written somewhere the detector never looks; this cannot.
 */

const h = vi.hoisted(() => {
  process.env.ARTIFACT_BUCKET = "test-bucket";
  return { objects: new Map<string, string>() };
});

vi.mock("@aws-sdk/client-s3", () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutObjectCommand extends Cmd {}
  class GetObjectCommand extends Cmd {}
  class HeadObjectCommand extends Cmd {}
  class ListObjectsV2Command extends Cmd {}
  class DeleteObjectCommand extends Cmd {}
  return {
    S3Client: class {
      async send(cmd: Cmd) {
        const input = cmd.input as { Key: string; Body?: unknown };
        if (cmd instanceof PutObjectCommand) {
          h.objects.set(input.Key, typeof input.Body === "string" ? input.Body : Buffer.from(input.Body as Uint8Array).toString("utf8"));
          return { ETag: '"e1"' };
        }
        const err = Object.assign(new Error(`NoSuchKey: ${input.Key}`), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        throw err;
      }
    },
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    DeleteObjectCommand,
  };
});

const root = resolve(__dirname, "../../..");
const blueprint = (name: string) => readFileSync(resolve(root, `blueprints/${name}.md`), "utf8");

const { handler } = (await import("../../../lambda/workflow-output/index.mjs")) as {
  handler: (e: unknown) => Promise<{ content: Array<{ text: string }> }>;
};
const { createDetector } = (await import("../../../lambda/orchestrator/dead-session-detector.mjs")) as {
  createDetector: (deps: Record<string, unknown>) => { runSweep: (mode: string) => Promise<{ blocked: number }> };
};

const WF = "wf_1";
const TICKET = "TEAM-2";
const NOW = Date.parse("2026-09-01T12:00:00Z");
const STARTED = "2026-09-01T00:00:00Z"; // 12h silent: far past any dead-session threshold
const TTL_MS = 30 * 60 * 1000;

/**
 * The blocked record exactly as the persona's blueprint tells it to write one: the
 * JSON example with its placeholders filled in, or (operator) the field list.
 */
function recordFromBlueprint(name: string, agentId: string, blockedAt: string): Record<string, unknown> {
  const text = blueprint(name);
  const example = /`(\{"ticketId":[^`]*\})`/.exec(text)?.[1];
  if (example) {
    const filled = example
      .replace("<your ticket>", TICKET)
      .replace("{workflow_id}", WF)
      .replace("<ISO-8601 now>", blockedAt);
    return JSON.parse(filled) as Record<string, unknown>;
  }
  const fields = /`\{(ticketId, agentId: "[a-z_]+", workflowId, reason,\s+blockedAt, evidence\[\])\}`/.exec(text)?.[1];
  expect(fields, `${name}: no blocked-record example or field list`).toBeDefined();
  const named = /agentId: "([a-z_]+)"/.exec(fields!)?.[1];
  expect(named).toBe(agentId);
  return { ticketId: TICKET, agentId, workflowId: WF, reason: "waiting on a human", blockedAt, evidence: ["workflows/wf_1/shared/x.md"] };
}

/** The persona's own key, as each blueprint names it. */
const recordKey = (agentId: string) => `workflows/${WF}/agents/${agentId}/${TICKET}-blocked.json`;

function detectorFor(agentId: string) {
  const task = { id: "task_1", agentId, ticketId: TICKET, status: "running", startedAt: STARTED };
  const workflow = { id: WF, workflowId: WF, phase: "development", agentTasks: { [TICKET]: task }, startedAt: STARTED };
  const store = {
    markDeadSessionDetected: vi.fn(async () => true),
    clearDeadSessionDetected: vi.fn(async () => true),
    incrementRedispatch: vi.fn(async () => ({ allowed: true, count: 1 })),
    parkTicket: vi.fn(async () => true),
    setTaskStatus: vi.fn(async () => {}),
    appendNotification: vi.fn(async () => {}),
    getWorkflow: vi.fn(async () => null),
  };
  const publishEvent = vi.fn(async (..._args: unknown[]) => {});
  const deps = {
    ddb: {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: { TableName?: string } }) =>
        cmd.constructor.name === "ScanCommand" && cmd.input.TableName === "workflows" ? { Items: [workflow] } : { Items: [] }),
    },
    workflowsTable: "workflows",
    eventsTable: "events",
    store,
    lease: {
      LEASE_TTL_MS: TTL_MS,
      isLeaseLive: vi.fn(() => false),
      lastAgentActivity: vi.fn(async () => null),
      stealClaim: vi.fn(async () => true),
    },
    getTicket: vi.fn(async () => ({ ticketId: TICKET, type: "task", status: "in_progress", assignee: agentId })),
    getAgentDef: vi.fn(() => ({ agentId, phase: "development" })),
    publishEvent,
    redispatch: vi.fn(async () => true),
    blockTicket: vi.fn(async () => {}),
    // The detector's seam, reading back exactly what the write tool stored.
    readArtifactJson: vi.fn(async (key: string) => (h.objects.has(key) ? JSON.parse(h.objects.get(key)!) : null)),
    now: () => NOW,
    log: () => {},
  };
  return { detector: createDetector(deps), store, publishEvent };
}

/** Write the record the way the persona does: S3Storage___write_object on workflow-output. */
async function personaWrites(agentId: string, record: Record<string, unknown>) {
  const res = await handler({
    tool_name: "S3Storage___write_object",
    arguments: { key: recordKey(agentId), content: JSON.stringify(record), content_type: "application/json" },
  });
  return JSON.parse(res.content[0].text) as { status?: string; ok?: boolean; reason?: string };
}

const PERSONAS = [
  ["ci-agent", "agentcore_hub_ci_agent"],
  ["qa-verifier", "agentcore_hub_qa_verifier"],
  ["operator", "agentcore_hub_operator"],
  ["release-manager", "agentcore_hub_release_manager"],
] as const;

beforeEach(() => {
  h.objects.clear();
  // The detector's EMF line and the handler's routing log, not under test.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("persona blocked record — blueprint → S3Storage___write_object → detector blockedEvidence (TEAM-5340 F9)", () => {
  for (const [name, agentId] of PERSONAS) {
    it(`${name} blocked record written through S3Storage___write_object is detected as blocked-record`, async () => {
      expect(blueprint(name)).toContain(`\`workflows/{workflow_id}/agents/${agentId}/{ticket_id}-blocked.json\``);
      const record = recordFromBlueprint(name, agentId, "2026-09-01T01:00:00Z");
      const wrote = await personaWrites(agentId, record);
      // Not refused as a protected key: the persona can actually write it.
      expect(wrote.ok, JSON.stringify(wrote)).not.toBe(false);
      expect(wrote.status).toBe("saved");
      expect(h.objects.has(recordKey(agentId))).toBe(true);

      const { detector, store, publishEvent } = detectorFor(agentId);
      const m = await detector.runSweep("enforce");
      expect(m.blocked).toBe(1);
      const blocked = publishEvent.mock.calls.filter((c) => c[1] === "agent.blocked");
      expect(blocked).toHaveLength(1);
      expect(blocked[0][2]).toMatchObject({ workflowId: WF, ticketId: TICKET, agentId, source: "blocked-record" });
      expect(store.parkTicket).toHaveBeenCalledWith(WF, TICKET, "agent_blocked", { startedAt: STARTED, liveOnly: true });
      expect(store.incrementRedispatch).not.toHaveBeenCalled();
    });

    it(`${name} blocked record with blockedAt before the task's startedAt is a previous episode: not blocked`, async () => {
      const record = recordFromBlueprint(name, agentId, "2026-08-31T23:00:00Z");
      expect((await personaWrites(agentId, record)).status).toBe("saved");
      const { detector, store, publishEvent } = detectorFor(agentId);
      const m = await detector.runSweep("enforce");
      expect(m.blocked).toBe(0);
      expect(publishEvent.mock.calls.filter((c) => c[1] === "agent.blocked")).toHaveLength(0);
      expect(store.parkTicket).not.toHaveBeenCalledWith(WF, TICKET, "agent_blocked", expect.anything());
      // It takes the dead-session path instead: the budget is spent.
      expect(store.incrementRedispatch).toHaveBeenCalled();
    });
  }
});
