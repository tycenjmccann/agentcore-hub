import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4167 D3a: loadWorkflowDefs runs the repo-agnostic honesty lint
 * (lintWorkflowDefShape) on every def AFTER the S3 fetch, OUTSIDE the fetch
 * fallback — so a dishonest ship gate throws rather than being swallowed into a
 * silent bundled fallback. This lives in its own file because it has to
 * vi.mock("@aws-sdk/client-s3") at module scope.
 */

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = h.send;
    constructor(_config: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

function s3Returns(doc: unknown) {
  h.send.mockResolvedValue({
    Body: { transformToString: async () => JSON.stringify(doc) },
  });
}

/** Fresh module (clears the loader's 15s cache) with ARTIFACT_BUCKET set so the
 *  S3 path — and thus the mock — is taken. */
async function freshLoader() {
  vi.resetModules();
  process.env.ARTIFACT_BUCKET = "test-artifact-bucket";
  return import("./defs-loader");
}

const honestGate = { afterPhase: "ship", name: "Merge Approval", blocking: true, condition: "cdRegistered", onReject: "rework" };
const dishonestGate = { afterPhase: "ship", name: "Merge Approval", blocking: true, condition: "always", onReject: "rework" };

function def(gate: Record<string, unknown>) {
  return {
    id: "rogue", name: "Rogue", description: "", icon: "x",
    intakeAgentId: "a", requiresRepo: true, featureBranchPhase: null,
    createsPullRequest: true, completionRequiresAgentPhases: ["ship"],
    reviewGates: [gate],
    phases: [{ id: "ship", name: "Ship", type: "agent", agentPhase: "ship" }],
  };
}

describe("loadWorkflowDefs — load-time honesty lint", () => {
  const savedBucket = process.env.ARTIFACT_BUCKET;
  beforeEach(() => h.send.mockReset());
  afterEach(() => {
    if (savedBucket === undefined) delete process.env.ARTIFACT_BUCKET;
    else process.env.ARTIFACT_BUCKET = savedBucket;
  });

  it("REJECTS (does not fall back) when an S3 def carries an always ship gate", async () => {
    s3Returns({ workflows: [def(dishonestGate)] });
    const { loadWorkflowDefs } = await freshLoader();
    await expect(loadWorkflowDefs()).rejects.toThrow(/ship gate .*condition:"always"/);
  });

  it("resolves when the S3 def's ship gate is honest (condition:cdRegistered)", async () => {
    s3Returns({ workflows: [def(honestGate)] });
    const { loadWorkflowDefs } = await freshLoader();
    const defs = await loadWorkflowDefs();
    expect(defs.find((d) => d.id === "rogue")).toBeDefined();
  });

  it("resolves the bundled defs (all now honest) when S3 returns no workflows", async () => {
    s3Returns({ workflows: [] });
    const { loadWorkflowDefs } = await freshLoader();
    const defs = await loadWorkflowDefs();
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.find((d) => d.id === "software-delivery")).toBeDefined();
  });
});
