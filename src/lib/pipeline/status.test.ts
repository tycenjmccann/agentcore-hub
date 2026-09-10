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
});
