import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { isPipelineEnabled } from "./status";

/**
 * TEAM-3723: PIPELINE_ENABLED was compared with strict `===` against "1" / "true",
 * so accidental whitespace or casing silently disabled the pipeline flag.
 *
 * TEAM-3745: isPipelineEnabled()'s default parameter reads process.env.PIPELINE_ENABLED,
 * so calling isPipelineEnabled(undefined) still falls through to the live env — it does
 * NOT exercise the unset case. Stub the env so the unset case is hermetic regardless of
 * what the surrounding shell/CI has set.
 *
 * TEAM-4336: getPipelineStatus is multi-target (one entry per CD-registry repo with a
 * pipeline, plus the env default). Its coverage is in the second half of this file; the
 * AWS SDK clients and the registry's S3 read are mocked at the module seam, so the real
 * derivation (pipelineProjectsFor) and the real repo normalization stay under test.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isPipelineEnabled", () => {
  it('"1" -> true', () => {
    expect(isPipelineEnabled("1")).toBe(true);
  });

  it('"1 " -> true (trailing whitespace)', () => {
    expect(isPipelineEnabled("1 ")).toBe(true);
  });

  it('" true" -> true (leading whitespace)', () => {
    expect(isPipelineEnabled(" true")).toBe(true);
  });

  it('"TRUE" -> true (casing)', () => {
    expect(isPipelineEnabled("TRUE")).toBe(true);
  });

  it('"0" -> false', () => {
    expect(isPipelineEnabled("0")).toBe(false);
  });

  it("unset -> false (env stubbed absent, default param genuinely reads nothing)", () => {
    vi.stubEnv("PIPELINE_ENABLED", undefined);
    expect(isPipelineEnabled()).toBe(false);
  });

  it("default param reads live env: stubbed PIPELINE_ENABLED=true -> true", () => {
    vi.stubEnv("PIPELINE_ENABLED", "true");
    expect(isPipelineEnabled()).toBe(true);
  });
});

// ─── getPipelineStatus — multi-target (TEAM-4336) ────────────────────────────

interface FakeBuild {
  id: string;
  buildStatus: string;
  sourceVersion?: string;
  startTime?: Date;
  logs?: { deepLink?: string; groupName?: string };
}

const h = vi.hoisted(() => ({
  registry: { version: 1, repos: [] as Array<Record<string, unknown>> },
  registryError: null as Error | null,
  cbRegions: [] as string[],
  cpRegions: [] as string[],
  listCalls: [] as string[],
  stateCalls: [] as string[],
  buildsByProject: {} as Record<string, Array<Record<string, unknown>>>,
  stagesByPipeline: {} as Record<string, Array<Record<string, unknown>>>,
  failProjects: new Set<string>(),
  failPipelines: new Set<string>(),
}));

vi.mock("@aws-sdk/client-codebuild", () => {
  class ListBuildsForProjectCommand {
    constructor(public input: { projectName: string }) {}
  }
  class BatchGetBuildsCommand {
    constructor(public input: { ids: string[] }) {}
  }
  class CodeBuildClient {
    constructor(cfg: { region: string }) {
      h.cbRegions.push(cfg.region);
    }
    async send(cmd: { constructor: { name: string }; input: Record<string, never> }) {
      if (cmd.constructor.name === "ListBuildsForProjectCommand") {
        const project = (cmd as unknown as ListBuildsForProjectCommand).input.projectName;
        h.listCalls.push(project);
        if (h.failProjects.has(project)) throw new Error(`project ${project} does not exist`);
        return { ids: (h.buildsByProject[project] || []).map((b) => b.id as string) };
      }
      const ids = (cmd as unknown as BatchGetBuildsCommand).input.ids;
      const all = Object.values(h.buildsByProject).flat();
      return { builds: all.filter((b) => ids.includes(b.id as string)) };
    }
  }
  return { CodeBuildClient, ListBuildsForProjectCommand, BatchGetBuildsCommand };
});

vi.mock("@aws-sdk/client-codepipeline", () => {
  class GetPipelineStateCommand {
    constructor(public input: { name: string }) {}
  }
  class CodePipelineClient {
    constructor(cfg: { region: string }) {
      h.cpRegions.push(cfg.region);
    }
    async send(cmd: { input: { name: string } }) {
      const name = cmd.input.name;
      h.stateCalls.push(name);
      if (h.failPipelines.has(name)) throw new Error(`pipeline ${name} not found`);
      return { stageStates: h.stagesByPipeline[name] || [] };
    }
  }
  return { CodePipelineClient, GetPipelineStateCommand };
});

// Only the S3 read is stubbed: importOriginal keeps the REAL pipelineProjectsFor
// and normalizeRepoKey, which are the derivation these tests exist to pin.
vi.mock("@/lib/cd-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cd-registry")>();
  return {
    ...actual,
    loadCdRegistry: async () => {
      if (h.registryError) throw h.registryError;
      return actual.parseCdRegistry(h.registry);
    },
  };
});

/** status.ts reads PIPELINE_* + AWS_REGION at module load, so re-import per case. */
async function loadStatus() {
  vi.resetModules();
  return await import("./status");
}

const build = (over: Partial<FakeBuild> = {}): Record<string, unknown> => ({
  id: "b:1",
  buildStatus: "SUCCEEDED",
  sourceVersion: "abc123",
  startTime: new Date("2026-09-10T00:00:00Z"),
  logs: { groupName: "/aws/codebuild/x" },
  ...over,
});

const approvalStage = (name: string) => ({
  stageName: name,
  latestExecution: { status: "InProgress" },
  actionStates: [
    {
      latestExecution: {
        token: "tok-1",
        status: "InProgress",
        lastStatusChange: new Date("2026-09-10T01:00:00Z"),
      },
      currentRevision: { revisionId: "deadbeefcafebabe" },
      entityUrl: "https://console.aws.amazon.com/approve",
    },
  ],
});

const plainStage = (name: string, status = "Succeeded") => ({
  stageName: name,
  latestExecution: { status },
  actionStates: [{ latestExecution: { status } }],
});

describe("getPipelineStatus — multi-target", () => {
  beforeEach(() => {
    h.registry = { version: 1, repos: [] };
    h.registryError = null;
    h.cbRegions.length = 0;
    h.cpRegions.length = 0;
    h.listCalls.length = 0;
    h.stateCalls.length = 0;
    h.buildsByProject = {};
    h.stagesByPipeline = {};
    h.failProjects = new Set();
    h.failPipelines = new Set();
    // Hermetic env: the default target + DEFAULT_REGION must not depend on the shell.
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("PIPELINE_CI_PROJECT", undefined);
    vi.stubEnv("PIPELINE_DEPLOY_NAME", undefined);
    vi.stubEnv("PIPELINE_ENABLED", "1");
    // sourceRepo (TEAM-4433) falls back to this convention when a target has no
    // registry-key repo; stubbed here so every test in this describe is hermetic.
    vi.stubEnv("GITHUB_OWNER", "tycenjmccann");
    vi.stubEnv("GITHUB_REPO", "agentcore-hub");
  });

  const twoRepos = () => {
    h.registry = {
      version: 1,
      repos: [
        { repo: "acme/juno", pipeline: "hub-juno-deploy", region: "us-east-1" },
        { repo: "acme/kepler", pipeline: "hub-kepler-deploy", region: "eu-west-1", ciProject: "kepler-pr-checks" },
      ],
    };
    h.stagesByPipeline["hub-juno-deploy"] = [plainStage("Source"), approvalStage("Approval")];
    h.stagesByPipeline["hub-kepler-deploy"] = [plainStage("Source")];
    h.buildsByProject["hub-juno-ci"] = [build({ id: "juno:1" })];
    h.buildsByProject["kepler-pr-checks"] = [build({ id: "kep:1", buildStatus: "FAILED" })];
  };

  it("returns { enabled, pipelines[] } with every per-target field populated", async () => {
    twoRepos();
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.enabled).toBe(true);
    expect(Object.keys(res)).toEqual(["enabled", "pipelines"]);
    const juno = res.pipelines.find((p) => p.repo === "acme/juno")!;
    expect(juno).toMatchObject({
      repo: "acme/juno",
      pipeline: "hub-juno-deploy",
      region: "us-east-1",
      ciProject: "hub-juno-ci",
    });
    expect(juno.recentBuilds.map((b) => b.id)).toEqual(["juno:1"]);
    expect(juno.stages.map((s) => s.name)).toEqual(["Source", "Approval"]);
    expect(juno.error).toBeUndefined();
  });

  it("builds ONE client pair per region and reads each target in its own region", async () => {
    twoRepos();
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    // 3 targets (juno, kepler, env default agentcore-hub-deploy) across 2 regions.
    expect(res.pipelines).toHaveLength(3);
    expect([...new Set(h.cbRegions)].sort()).toEqual(["eu-west-1", "us-east-1"]);
    expect([...new Set(h.cpRegions)].sort()).toEqual(["eu-west-1", "us-east-1"]);
    expect(h.cbRegions).toHaveLength(2); // cached per region, not per target
    expect(h.cpRegions).toHaveLength(2);
    expect(res.pipelines.find((p) => p.repo === "acme/kepler")!.region).toBe("eu-west-1");
  });

  it("an explicit registry ciProject is the project actually read", async () => {
    twoRepos();
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.pipelines.find((p) => p.repo === "acme/kepler")!.ciProject).toBe("kepler-pr-checks");
    expect(h.listCalls).toContain("kepler-pr-checks");
    expect(h.listCalls).not.toContain("hub-kepler-ci");
  });

  it("empty registry → exactly the env default target (repo: \"\")", async () => {
    vi.stubEnv("PIPELINE_DEPLOY_NAME", "custom-deploy");
    vi.stubEnv("PIPELINE_CI_PROJECT", "custom-ci");
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.pipelines).toHaveLength(1);
    expect(res.pipelines[0]).toMatchObject({
      repo: "",
      pipeline: "custom-deploy",
      ciProject: "custom-ci",
      region: "us-east-1",
    });
  });

  it("dedupes by pipeline name: a registry entry owning the env pipeline wins", async () => {
    h.registry = {
      version: 1,
      repos: [{ repo: "acme/hub", pipeline: "agentcore-hub-deploy", region: "eu-west-1", ciProject: "hub-own-ci" }],
    };
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.pipelines).toHaveLength(1);
    expect(res.pipelines[0]).toMatchObject({
      repo: "acme/hub",
      pipeline: "agentcore-hub-deploy",
      region: "eu-west-1",
      ciProject: "hub-own-ci",
    });
  });

  it("a registered repo with no pipeline is not a target (legacy DEPLOY.md path)", async () => {
    h.registry = { version: 1, repos: [{ repo: "acme/juno", deployDoc: "DEPLOY.md" }] };
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.pipelines.map((p) => p.repo)).toEqual([""]); // env default only
  });

  it("?repo= narrows to that entry's target, normalizing any GitHub ref form", async () => {
    twoRepos();
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus({ repo: "https://github.com/Acme/Juno.git" });

    expect(res.pipelines).toHaveLength(1);
    expect(res.pipelines[0].pipeline).toBe("hub-juno-deploy");
    // Nothing else was even read — no cross-repo AWS calls.
    expect(h.stateCalls).toEqual(["hub-juno-deploy"]);
  });

  it("an unknown/unregistered repo falls back to the env default target only", async () => {
    twoRepos();
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus({ repo: "acme/not-registered" });

    expect(res.pipelines).toHaveLength(1);
    expect(res.pipelines[0]).toMatchObject({ repo: "", pipeline: "agentcore-hub-deploy" });
    // The board matches on `repo`, so "" can never be attributed to a run.
  });

  it("isolates a failing target: one error, every other target still renders", async () => {
    twoRepos();
    h.failPipelines.add("hub-juno-deploy");
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    const juno = res.pipelines.find((p) => p.repo === "acme/juno")!;
    const kepler = res.pipelines.find((p) => p.repo === "acme/kepler")!;
    expect(juno.error).toMatch(/hub-juno-deploy not found/);
    expect(juno.stages).toEqual([]);
    expect(kepler.error).toBeUndefined();
    expect(kepler.stages.map((s) => s.name)).toEqual(["Source"]);
    expect(kepler.recentBuilds.map((b) => b.id)).toEqual(["kep:1"]);
  });

  it("a CI-project failure is isolated the same way", async () => {
    twoRepos();
    h.failProjects.add("hub-juno-ci");
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.pipelines.find((p) => p.repo === "acme/juno")!.error).toMatch(/hub-juno-ci does not exist/);
    expect(res.pipelines.find((p) => p.repo === "acme/kepler")!.error).toBeUndefined();
  });

  it("a registry read that throws degrades to the env default, never rejects", async () => {
    h.registryError = new Error("s3 down");
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.pipelines).toHaveLength(1);
    expect(res.pipelines[0]).toMatchObject({ repo: "", pipeline: "agentcore-hub-deploy" });
  });

  it("keeps the awaitingApproval + approvalUrl contract the board reads", async () => {
    twoRepos();
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus({ repo: "acme/juno" });

    const stages = res.pipelines[0].stages;
    const gate = stages.find((s) => s.awaitingApproval)!;
    expect(gate.name).toBe("Approval");
    expect(gate.approvalUrl).toBe("https://console.aws.amazon.com/approve");
    expect(gate.revisionSummary).toBe("deadbeefcafe"); // 12 chars
    expect(stages.find((s) => s.name === "Source")!.awaitingApproval).toBe(false);
  });

  it("enabled is independent of the targets (PIPELINE_ENABLED unset → false)", async () => {
    vi.stubEnv("PIPELINE_ENABLED", undefined);
    twoRepos();
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.enabled).toBe(false);
    expect(res.pipelines.length).toBeGreaterThan(0);
  });

  // ─── sourceRepo (TEAM-4433) — display-only owner/repo for the commit link ────

  it("a registered target's sourceRepo is its own registry key", async () => {
    twoRepos();
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.pipelines.find((p) => p.repo === "acme/juno")!.sourceRepo).toBe("acme/juno");
  });

  it("empty registry → the env default target's sourceRepo is GITHUB_OWNER/GITHUB_REPO", async () => {
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.pipelines).toHaveLength(1);
    expect(res.pipelines[0].repo).toBe("");
    expect(res.pipelines[0].sourceRepo).toBe("tycenjmccann/agentcore-hub");
  });

  it("either GITHUB_OWNER/GITHUB_REPO unset → sourceRepo undefined, repo still \"\"", async () => {
    vi.stubEnv("GITHUB_REPO", undefined);
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();

    expect(res.pipelines[0].repo).toBe("");
    expect(res.pipelines[0].sourceRepo).toBeUndefined();
  });

  it("a malformed GITHUB_OWNER or GITHUB_REPO → sourceRepo undefined", async () => {
    vi.stubEnv("GITHUB_OWNER", "a/b");
    const { getPipelineStatus: loadA } = await loadStatus();
    const resA = await loadA();
    expect(resA.pipelines[0].sourceRepo).toBeUndefined();

    vi.stubEnv("GITHUB_OWNER", "tycenjmccann");
    vi.stubEnv("GITHUB_REPO", "");
    const { getPipelineStatus: loadB } = await loadStatus();
    const resB = await loadB();
    expect(resB.pipelines[0].sourceRepo).toBeUndefined();
  });
});

// ─── execution identity on StageState (TEAM-4403) ─────────────────────────────

/**
 * The workflow board's deploy-gate banner was repo-scoped, so a single parked
 * approval showed up on every active run of that repo. `executionId` + `sourceSha`
 * let the board scope it to the run whose commit is actually at the gate. Both are
 * derived from the GetPipelineState response we already fetch: the task role has
 * codepipeline:GetPipelineState and NOT GetPipelineExecution, so the SHA must come
 * from `actionStates[].currentRevision` — and never from the 12-char
 * `revisionSummary`, which is a display digest, not a commit.
 */

const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
const SHA_B = "f00dfeeddeadbeefcafebabe0123456789abcdef";
const EXEC_A = "exec-aaaa-1111";
const EXEC_B = "exec-bbbb-2222";

/** Source stage: carries the full commit SHA for `execId`. */
const sourceStage = (execId: string, sha: string, status = "Succeeded") => ({
  stageName: "Source",
  latestExecution: { pipelineExecutionId: execId, status },
  actionStates: [
    {
      latestExecution: { status, lastStatusChange: new Date("2026-09-10T00:30:00Z") },
      currentRevision: { revisionId: sha },
    },
  ],
});

/** ManualApproval stage parked on `execId`; its own revision is only a digest. */
const gateStage = (execId: string, name = "Approval") => ({
  stageName: name,
  latestExecution: { pipelineExecutionId: execId, status: "InProgress" },
  actionStates: [
    {
      latestExecution: {
        token: "tok-1",
        status: "InProgress",
        lastStatusChange: new Date("2026-09-10T01:00:00Z"),
      },
      currentRevision: { revisionId: "deadbeefcafebabe" },
      entityUrl: "https://console.aws.amazon.com/approve",
    },
  ],
});

describe("StageState execution identity (TEAM-4403)", () => {
  beforeEach(() => {
    h.registry = { version: 1, repos: [] };
    h.registryError = null;
    h.cbRegions.length = 0;
    h.cpRegions.length = 0;
    h.listCalls.length = 0;
    h.stateCalls.length = 0;
    h.buildsByProject = {};
    h.stagesByPipeline = {};
    h.failProjects = new Set();
    h.failPipelines = new Set();
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("PIPELINE_CI_PROJECT", undefined);
    vi.stubEnv("PIPELINE_DEPLOY_NAME", undefined);
    vi.stubEnv("PIPELINE_ENABLED", "1");
  });

  /** Reads the single env-default target's stages for the given fixture. */
  const stagesFor = async (fixture: Array<Record<string, unknown>>) => {
    h.stagesByPipeline["agentcore-hub-deploy"] = fixture;
    const { getPipelineStatus } = await loadStatus();
    const res = await getPipelineStatus();
    expect(res.pipelines[0].error).toBeUndefined();
    return res.pipelines[0].stages;
  };

  it("an awaiting-approval stage exposes its latestExecution.pipelineExecutionId", async () => {
    const stages = await stagesFor([sourceStage(EXEC_A, SHA_A), gateStage(EXEC_A)]);
    const gate = stages.find((s) => s.awaitingApproval)!;

    expect(gate.name).toBe("Approval");
    expect(gate.executionId).toBe(EXEC_A);
    // Set wherever the API reports one, not only on the gate.
    expect(stages.find((s) => s.name === "Source")!.executionId).toBe(EXEC_A);
  });

  it("executionId is undefined when GetPipelineState reports none", async () => {
    const stages = await stagesFor([
      { stageName: "Source", latestExecution: { status: "Succeeded" }, actionStates: [] },
    ]);
    expect(stages[0].executionId).toBeUndefined();
  });

  it("sourceSha is the FULL 40-char SHA, never the 12-char revisionSummary", async () => {
    const stages = await stagesFor([sourceStage(EXEC_A, SHA_A), gateStage(EXEC_A)]);
    const gate = stages.find((s) => s.awaitingApproval)!;

    expect(gate.sourceSha).toBe(SHA_A);
    expect(gate.sourceSha).toHaveLength(40);
    expect(gate.revisionSummary).toHaveLength(12);
    expect(gate.sourceSha).not.toBe(gate.revisionSummary);
    expect(gate.sourceSha!.startsWith(gate.revisionSummary!)).toBe(false);
  });

  it("cross-stage lookup: Source carries the SHA and shares the gate's executionId", async () => {
    // The gate's own revision is only a digest, so the SHA can only come from the
    // sibling stage on the same execution — this is the GetPipelineExecution-free path.
    const stages = await stagesFor([
      sourceStage(EXEC_A, SHA_A),
      // A stage carrying no revision of its own at all.
      {
        stageName: "Build",
        latestExecution: { pipelineExecutionId: EXEC_A, status: "Succeeded" },
        actionStates: [{ latestExecution: { status: "Succeeded" } }],
      },
      gateStage(EXEC_A),
    ]);

    expect(stages.find((s) => s.name === "Approval")!.sourceSha).toBe(SHA_A);
    expect(stages.find((s) => s.name === "Build")!.sourceSha).toBe(SHA_A);
  });

  it("a superseded execution (Source already on a newer execution) → sourceSha undefined", async () => {
    // Source has advanced to EXEC_B/SHA_B while the gate is still parked on EXEC_A.
    // Reporting SHA_B would attribute the gate to the wrong commit, so we report nothing.
    const stages = await stagesFor([sourceStage(EXEC_B, SHA_B), gateStage(EXEC_A)]);
    const gate = stages.find((s) => s.awaitingApproval)!;

    expect(gate.executionId).toBe(EXEC_A);
    expect(gate.sourceSha).toBeUndefined();
    expect(stages.find((s) => s.name === "Source")!.sourceSha).toBe(SHA_B);
  });

  // ─── waitingSince (TEAM-4433) ────────────────────────────────────────────

  it("waitingSince on a parked gate is the approval action's own lastStatusChange", async () => {
    const stages = await stagesFor([sourceStage(EXEC_A, SHA_A), gateStage(EXEC_A)]);
    const gate = stages.find((s) => s.awaitingApproval)!;

    expect(gate.waitingSince).toBe("2026-09-10T01:00:00.000Z");
    expect(gate.waitingSince).toBe(gate.lastUpdated);
  });

  it("waitingSince on a non-gate stage falls back to actionStates[0]", async () => {
    const stages = await stagesFor([sourceStage(EXEC_A, SHA_A), gateStage(EXEC_A)]);
    const source = stages.find((s) => s.name === "Source")!;

    expect(source.waitingSince).toBe("2026-09-10T00:30:00.000Z");
  });

  it("waitingSince is the gate action's change even when it isn't actionStates[0]", async () => {
    const T0 = new Date("2026-09-10T00:00:00Z");
    const T1 = new Date("2026-09-10T02:00:00Z");
    const stages = await stagesFor([
      {
        stageName: "Approval",
        latestExecution: { status: "InProgress" },
        actionStates: [
          { latestExecution: { status: "Succeeded", lastStatusChange: T0 } },
          { latestExecution: { token: "tok-1", status: "InProgress", lastStatusChange: T1 } },
        ],
      },
    ]);

    expect(stages[0].waitingSince).toBe(T1.toISOString());
    expect(stages[0].lastUpdated).toBe(T0.toISOString());
  });

  it("waitingSince is undefined (not a throw) when actionStates is empty", async () => {
    const stages = await stagesFor([
      { stageName: "Source", latestExecution: { status: "Succeeded" }, actionStates: [] },
    ]);

    expect(stages[0].waitingSince).toBeUndefined();
  });

  it("no regression: revisionSummary / awaitingApproval / approvalUrl / status / lastUpdated / sourceSha", async () => {
    const stages = await stagesFor([sourceStage(EXEC_A, SHA_A), gateStage(EXEC_A)]);
    const gate = stages.find((s) => s.name === "Approval")!;
    const source = stages.find((s) => s.name === "Source")!;

    expect(gate.revisionSummary).toBe("deadbeefcafe"); // still revisionId.slice(0, 12)
    expect(gate.awaitingApproval).toBe(true);
    expect(gate.approvalUrl).toBe("https://console.aws.amazon.com/approve");
    expect(gate.status).toBe("InProgress");
    expect(gate.lastUpdated).toBe("2026-09-10T01:00:00.000Z");
    expect(gate.sourceSha).toBe(SHA_A);
    expect(source.awaitingApproval).toBe(false);
    expect(source.approvalUrl).toBeUndefined();
    expect(source.revisionSummary).toBe(SHA_A.slice(0, 12));
    expect(source.status).toBe("Succeeded");
    expect(source.sourceSha).toBe(SHA_A);
  });

  it("only ONE GetPipelineState call still backs the whole stage list", async () => {
    await stagesFor([sourceStage(EXEC_A, SHA_A), gateStage(EXEC_A)]);
    // No GetPipelineExecution: the task role is granted GetPipelineState only.
    expect(h.stateCalls).toEqual(["agentcore-hub-deploy"]);
  });
});

describe("sourceShaForExecution", () => {
  const load = async () => (await loadStatus()).sourceShaForExecution;

  it("prefers a full SHA on the own stage over any sibling", async () => {
    const sourceShaForExecution = await load();
    const own = sourceStage(EXEC_A, SHA_A);
    const sibling = sourceStage(EXEC_A, SHA_B);

    expect(sourceShaForExecution([sibling, own], EXEC_A, own)).toBe(SHA_A);
  });

  it("falls back to a sibling stage on the same pipelineExecutionId", async () => {
    const sourceShaForExecution = await load();
    const gate = gateStage(EXEC_A);

    expect(sourceShaForExecution([sourceStage(EXEC_A, SHA_B), gate], EXEC_A, gate)).toBe(SHA_B);
  });

  it("ignores stages on a different pipelineExecutionId", async () => {
    const sourceShaForExecution = await load();
    const gate = gateStage(EXEC_A);

    expect(
      sourceShaForExecution([sourceStage(EXEC_B, SHA_B), gate], EXEC_A, gate)
    ).toBeUndefined();
  });

  it("never matches a non-full-hex revisionId (short digest, over/underlong, non-hex)", async () => {
    const sourceShaForExecution = await load();
    const notShas = [
      "deadbeefcafe", // the 12-char revisionSummary digest
      "deadbeefcafebabe", // 16 hex
      SHA_A.slice(0, 39), // 39 hex
      SHA_A + "0", // 41 hex
      "z" + SHA_A.slice(1), // 40 chars, not hex
      "main", // a branch name
      "", // empty
    ];
    for (const revisionId of notShas) {
      const stage = {
        stageName: "Source",
        latestExecution: { pipelineExecutionId: EXEC_A, status: "Succeeded" },
        actionStates: [{ currentRevision: { revisionId } }],
      };
      expect(sourceShaForExecution([stage], EXEC_A, stage)).toBeUndefined();
    }
  });

  it("accepts an uppercase 40-char SHA (hex is case-insensitive)", async () => {
    const sourceShaForExecution = await load();
    const upper = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const stage = {
      stageName: "Source",
      latestExecution: { pipelineExecutionId: EXEC_A, status: "Succeeded" },
      actionStates: [{ currentRevision: { revisionId: upper } }],
    };

    expect(sourceShaForExecution([stage], EXEC_A, stage)).toBe(upper);
  });

  it("takes the first full SHA among several actions on one stage", async () => {
    const sourceShaForExecution = await load();
    const stage = {
      stageName: "Source",
      latestExecution: { pipelineExecutionId: EXEC_A, status: "Succeeded" },
      actionStates: [
        { currentRevision: { revisionId: "deadbeefcafe" } },
        { currentRevision: { revisionId: SHA_A } },
        { currentRevision: { revisionId: SHA_B } },
      ],
    };

    expect(sourceShaForExecution([stage], EXEC_A, stage)).toBe(SHA_A);
  });

  it("undefined executionId cannot match stages that also report none", async () => {
    const sourceShaForExecution = await load();
    const orphan = {
      stageName: "Source",
      latestExecution: { status: "Succeeded" },
      actionStates: [{ currentRevision: { revisionId: SHA_A } }],
    };
    const gate = { stageName: "Approval", latestExecution: { status: "InProgress" }, actionStates: [] };

    expect(sourceShaForExecution([orphan, gate], undefined, gate)).toBeUndefined();
  });

  it("empty / missing inputs are undefined, not a throw", async () => {
    const sourceShaForExecution = await load();
    expect(sourceShaForExecution([], EXEC_A)).toBeUndefined();
    expect(sourceShaForExecution([{}], EXEC_A, {})).toBeUndefined();
    expect(sourceShaForExecution([sourceStage(EXEC_A, SHA_A)], undefined)).toBeUndefined();
  });
});
