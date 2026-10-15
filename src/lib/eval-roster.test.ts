import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { deriveEvalColumns, runtimeNameFromArn, type EvalRosterAgent } from "./eval-roster";

const ARN = (leaf: string) => `arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/${leaf}`;

const agent = (agentId: string, runtimeArn: string | null, extra: Partial<EvalRosterAgent> = {}): EvalRosterAgent => ({
  agentId,
  displayName: agentId,
  evaluationsEnabled: true,
  runtimeArn,
  ...extra,
});

describe("runtimeNameFromArn", () => {
  it("strips the generated suffix and a harness_ prefix", () => {
    expect(runtimeNameFromArn(ARN("agentcore_hub_agent-ITPP0eBToO"))).toBe("agentcore_hub_agent");
    expect(runtimeNameFromArn(ARN("harness_agentcore_hub_workflow_manager-cJ6kEr51cY"))).toBe("agentcore_hub_workflow_manager");
  });
  it("is null for non-runtime input", () => {
    expect(runtimeNameFromArn(null)).toBeNull();
    expect(runtimeNameFromArn("arn:aws:s3:::bucket")).toBeNull();
  });
});

describe("deriveEvalColumns", () => {
  it("collapses personas sharing the hub's ARN onto the hub; agents on their own ARN stay columns", () => {
    const shared = ARN("agentcore_hub_agent-ITPP0eBToO");
    const { columns, hosted } = deriveEvalColumns([
      agent("agentcore_hub_requirements_analyst", shared),
      agent("agentcore_hub_workflow_manager", ARN("harness_agentcore_hub_workflow_manager-cJ6kEr51cY")),
      agent("agentcore_hub_agent", shared),
      agent("agentcore_hub_backend_dev", shared),
      agent("agentcore_hub_coding_runtime", ARN("agentcore_hub_coding_runtime-infasNCWad")),
      agent("not_evaluated", shared, { evaluationsEnabled: false }),
    ]);
    expect(columns.map((c) => c.agentId)).toEqual([
      "agentcore_hub_workflow_manager",
      "agentcore_hub_agent",
      "agentcore_hub_coding_runtime",
    ]);
    expect(hosted).toEqual({
      agentcore_hub_requirements_analyst: "agentcore_hub_agent",
      agentcore_hub_backend_dev: "agentcore_hub_agent",
    });
  });

  it("dedicated-runtime topology: every persona owns its ARN, so every persona is a column", () => {
    const { columns, hosted } = deriveEvalColumns([
      agent("agentcore_hub_requirements_analyst", ARN("agentcore_hub_requirements_analyst-0MPOhw4DYi")),
      agent("agentcore_hub_backend_dev", ARN("agentcore_hub_backend_dev-Ezbf5SAGPU")),
      agent("agentcore_hub_agent", ARN("agentcore_hub_agent-ITPP0eBToO")),
    ]);
    expect(columns).toHaveLength(3);
    expect(hosted).toEqual({});
  });

  it("null ARNs (the checked-in roster) never collapse anything", () => {
    const { columns, hosted } = deriveEvalColumns([
      agent("agentcore_hub_requirements_analyst", null),
      agent("agentcore_hub_agent", null),
    ]);
    expect(columns).toHaveLength(2);
    expect(hosted).toEqual({});
  });

  it("a shared ARN with no agent named after the runtime is left alone — no guessing at a host", () => {
    const shared = ARN("fleet_runtime-abcdefghij");
    const { columns, hosted } = deriveEvalColumns([agent("a", shared), agent("b", shared)]);
    expect(columns).toHaveLength(2);
    expect(hosted).toEqual({});
  });

  it("an explicit evalHost wins, but only when it names an evaluations-enabled agent", () => {
    const { columns, hosted } = deriveEvalColumns([
      agent("hub", ARN("hub-0000000000")),
      agent("p1", ARN("p1-0000000000"), { evalHost: "hub" }),
      agent("p2", ARN("p2-0000000000"), { evalHost: "ghost" }),
      agent("p3", null, { evalHost: "p3" }),
    ]);
    expect(hosted).toEqual({ p1: "hub" });
    expect(columns.map((c) => c.agentId)).toEqual(["hub", "p2", "p3"]);
  });
});

/**
 * TEAM-6211 sibling — loadEvalRoster shares roster-loader.ts's 15s TTL cache
 * over the SAME document (config/agents.json). On a failed refresh it must
 * keep the last-good LIVE roster rather than falling back to the bundled
 * roster (which would flip the Evaluations tab from the live runtimes to the
 * bundled ones during a brief S3 outage).
 */
const h = vi.hoisted(() => ({
  state: { doc: undefined as string | undefined, nextError: null as Error | null, getCalls: 0 },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      h.state.getCalls++;
      if (h.state.nextError) {
        const err = h.state.nextError;
        h.state.nextError = null;
        throw err;
      }
      return { Body: { transformToString: async () => h.state.doc } };
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

describe("loadEvalRoster — last-good live roster on a failed refresh (TEAM-6211)", () => {
  let loadEvalRoster: typeof import("./eval-roster").loadEvalRoster;
  let bundledEvalRoster: typeof import("./eval-roster").bundledEvalRoster;

  beforeEach(async () => {
    h.state.doc = undefined;
    h.state.nextError = null;
    h.state.getCalls = 0;
    process.env.ARTIFACT_BUCKET = "test-bucket";
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    ({ loadEvalRoster, bundledEvalRoster } = await import("./eval-roster"));
  });

  afterEach(() => {
    delete process.env.ARTIFACT_BUCKET;
    vi.useRealTimers();
  });

  it("a failed refresh after the TTL expires returns the last-good live roster, not the bundled one", async () => {
    const live: EvalRosterAgent[] = [{ agentId: "agentcore_hub_release_captain", displayName: "Release Captain", runtimeArn: null }];
    h.state.doc = JSON.stringify({ agents: live });
    expect(await loadEvalRoster()).toEqual(live);

    vi.setSystemTime(new Date(Date.now() + 15_001));
    h.state.nextError = new Error("S3 unavailable");
    const result = await loadEvalRoster();
    expect(result).toEqual(live);
    expect(result).not.toEqual(bundledEvalRoster());
  });
});
