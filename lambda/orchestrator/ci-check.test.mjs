import { describe, it, expect, vi } from "vitest";
import {
  normalizeCiCheckMode,
  resolveCiProjectName,
  probeCiCheck,
  ensureCiCheck,
  formatCiCheckBlock,
  prefixCiWarning,
  CI_CHECK_TTL_MS_DEFAULT,
  CI_CHECK_UNKNOWN_TTL_MS_DEFAULT,
} from "./ci-check.mjs";

/**
 * ci-check.mjs (TEAM-4122 FR-5) — the dispatch-time "can a CodeBuild build for
 * this head SHA exist AT ALL?" probe. Fully dependency-injected (plain-object
 * deps + a fake clock + a stub store), so every branch is exercised with no AWS
 * and no network — same shape as repo-check.test.mjs / live-reverify.test.mjs.
 *
 * What must not regress, in order of how much it would cost:
 *   - F10: BatchGetProjects returns the project's webhook.url, webhook.secret and
 *     its whole environment-variable list. NOTHING derived from that object may
 *     reach the returned (and therefore persisted, logged and prompt-rendered)
 *     record except booleans. There is an explicit assertion on
 *     JSON.stringify(result) for a secret and a webhook URL.
 *   - `unknown` never becomes a warning: a missing IAM grant, an old
 *     pipeline-tools deployment or a 403 from GitHub must not manufacture a
 *     claim about the pipeline. Only BOTH-routes-provably-absent is uncertifiable.
 *   - the mode allow-list coalesces garbage to OFF (enforce writes a label on a
 *     real epic and rewrites the human merge gate's ping).
 *   - the TTL cache: one probe per workflow per 6h (30min while unknown), so a
 *     warm container dispatching 14 tickets makes one pair of API calls.
 */

const NOW = new Date("2026-09-06T12:00:00.000Z");
const clock = (d = NOW) => () => d;

/** A CodeBuild project whose webhook really does fire on PRs. */
const PR_WEBHOOK_PROJECT = {
  name: "agentcore-hub-ci",
  webhook: {
    url: "https://codebuild.us-east-1.amazonaws.com/webhooks?t=abc",
    filterGroups: [[{ type: "EVENT", pattern: "PULL_REQUEST_CREATED, PULL_REQUEST_UPDATED" }]],
  },
};
/** Same project, but the webhook only fires on push — no PR check exists. */
const PUSH_ONLY_PROJECT = {
  name: "agentcore-hub-ci",
  webhook: {
    url: "https://codebuild.us-east-1.amazonaws.com/webhooks?t=abc",
    filterGroups: [[{ type: "EVENT", pattern: "PUSH" }]],
  },
};

const capabilitiesEnvelope = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

/**
 * Injected deps. Every seam is a vi.fn so "off costs nothing" / "a fresh cache
 * costs nothing" can be asserted as CALL COUNTS, not as observable side effects.
 */
function makeDeps({ projects = [PR_WEBHOOK_PROJECT], startCiBuild, capabilityReply, throwCodebuild, throwInvoke, hooks, throwHooks, simulate, now = clock() } = {}) {
  const deps = {
    now,
    codebuildSend: vi.fn(async () => {
      if (throwCodebuild) throw throwCodebuild;
      return { projects };
    }),
    invokeLambda: vi.fn(async () => {
      if (throwInvoke) throw throwInvoke;
      if (capabilityReply !== undefined) return capabilityReply;
      if (startCiBuild === undefined) return capabilitiesEnvelope({ startCiBuild: false, version: 2 });
      return capabilitiesEnvelope({ startCiBuild, version: 2 });
    }),
  };
  if (hooks !== undefined || throwHooks) {
    deps.githubApi = vi.fn(async () => {
      if (throwHooks) throw throwHooks;
      return hooks;
    });
  }
  if (simulate !== undefined) {
    deps.iamSimulate = vi.fn(async () => {
      if (simulate instanceof Error) throw simulate;
      return { EvaluationResults: [{ EvalDecision: simulate }] };
    });
  }
  return deps;
}

const err = (name) => Object.assign(new Error(name), { name });

// ─── normalizeCiCheckMode ────────────────────────────────────────────────────

describe("normalizeCiCheckMode — strict allow-list, garbage → off", () => {
  it("accepts the three real modes, case- and whitespace-insensitively", () => {
    expect(normalizeCiCheckMode("enforce")).toBe("enforce");
    expect(normalizeCiCheckMode(" Enforce ")).toBe("enforce");
    expect(normalizeCiCheckMode("shadow")).toBe("shadow");
    expect(normalizeCiCheckMode("off")).toBe("off");
  });

  it("coalesces legacy-truthy and unset values to off (NOT shadow) — enforce writes to a real ticket", () => {
    // The asymmetry with REWORK_LOOP_CAP is deliberate: a typo must not label an
    // epic or rewrite the merge-gate ping on its own.
    for (const v of ["on", "true", "1", "yes", "", "  ", "enforce!", "ENFORCED", "shdaow", undefined, null, 1, {}, []]) {
      expect(normalizeCiCheckMode(v)).toBe("off");
    }
  });
});

// ─── resolveCiProjectName ────────────────────────────────────────────────────

describe("resolveCiProjectName — entry.ciProject > CI_PROJECT_NAME > default", () => {
  it("prefers the CD registry entry's ciProject", () => {
    expect(
      resolveCiProjectName({ delivery: { entry: { ciProject: " juno-pr-check " } }, env: { CI_PROJECT_NAME: "env-ci" } })
    ).toBe("juno-pr-check");
  });

  it("falls back to CI_PROJECT_NAME, then to agentcore-hub-ci", () => {
    expect(resolveCiProjectName({ delivery: { entry: {} }, env: { CI_PROJECT_NAME: " env-ci " } })).toBe("env-ci");
    expect(resolveCiProjectName({ delivery: null, env: {} })).toBe("agentcore-hub-ci");
    expect(resolveCiProjectName()).toBe("agentcore-hub-ci");
    expect(resolveCiProjectName({ delivery: { entry: { ciProject: "   " } }, env: { CI_PROJECT_NAME: "" } })).toBe("agentcore-hub-ci");
  });

  it("NEVER uses entry.pipeline — that names a CodePipeline, not a CodeBuild project", () => {
    const name = resolveCiProjectName({ delivery: { entry: { pipeline: "juno-deploy", region: "us-west-2" } }, env: {} });
    expect(name).toBe("agentcore-hub-ci");
    expect(name).not.toBe("juno-deploy");
  });
});

// ─── probeCiCheck — probe 1: the CodeBuild webhook ───────────────────────────

describe("probeCiCheck — webhook probe", () => {
  it("url + a PR EVENT filter → webhook true, certifiable", async () => {
    const deps = makeDeps({ projects: [PR_WEBHOOK_PROJECT] });
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: {}, deps });

    expect(deps.codebuildSend).toHaveBeenCalledWith({ names: ["agentcore-hub-ci"] });
    expect(r.webhook).toBe(true);
    expect(r.certifiable).toBe(true);
    expect(r.verdict).toBe("certifiable");
    expect(r.checkedAt).toBe(NOW.toISOString());
    expect(r.projectName).toBe("agentcore-hub-ci");
  });

  it("url present but only a PUSH filter → webhook false (no PR check can fire)", async () => {
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: {}, deps: makeDeps({ projects: [PUSH_ONLY_PROJECT] }) });
    expect(r.webhook).toBe(false);
  });

  it("PR filter but no webhook url → webhook false (a filter group without a hook is inert)", async () => {
    const project = { name: "agentcore-hub-ci", webhook: { filterGroups: [[{ type: "EVENT", pattern: "PULL_REQUEST_UPDATED" }]] } };
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: {}, deps: makeDeps({ projects: [project] }) });
    expect(r.webhook).toBe(false);
  });

  it("project absent → unknown/project_not_found, NOT false", async () => {
    const r = await probeCiCheck({ projectName: "nope", env: {}, deps: makeDeps({ projects: [] }) });
    expect(r.webhook).toBe("unknown");
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toContain("webhook: project_not_found");
  });

  it("AccessDeniedException on BatchGetProjects → unknown, and only the error NAME is reported", async () => {
    const boom = Object.assign(new Error("User arn:aws:sts::1234567890:assumed-role/x is not authorized"), {
      name: "AccessDeniedException",
    });
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: {}, deps: makeDeps({ throwCodebuild: boom }) });
    expect(r.webhook).toBe("unknown");
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toContain("webhook: AccessDeniedException");
    // The SDK message can echo request parameters and the caller ARN.
    expect(JSON.stringify(r)).not.toContain("assumed-role");
  });
});

// ─── probeCiCheck — probe 2: pipeline-tools StartBuild capability ────────────

describe("probeCiCheck — start-build probe", () => {
  const noWebhook = { projects: [PUSH_ONLY_PROJECT] };

  it("capabilities {startCiBuild:true} → true; the invoke shape is what the handler reads", async () => {
    const deps = makeDeps({ ...noWebhook, startCiBuild: true });
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: {}, deps });

    expect(deps.invokeLambda).toHaveBeenCalledWith("agentcore-hub-pipeline-tools", {
      tool_name: "Pipeline___capabilities",
      parameters: {},
    });
    expect(r.startBuild).toBe(true);
    expect(r.verdict).toBe("certifiable");
    expect(r.reason).toContain("can start a build");
  });

  it("honours PIPELINE_TOOLS_LAMBDA when set", async () => {
    const deps = makeDeps({ ...noWebhook, startCiBuild: true });
    await probeCiCheck({ projectName: "p", env: { PIPELINE_TOOLS_LAMBDA: "custom-tools" }, deps });
    expect(deps.invokeLambda.mock.calls[0][0]).toBe("custom-tools");
  });

  it("capabilities {startCiBuild:false} → false", async () => {
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: {}, deps: makeDeps({ ...noWebhook, startCiBuild: false }) });
    expect(r.startBuild).toBe(false);
  });

  it('an older deployment answering {error:"Unknown tool"} → unknown, never false', async () => {
    // "this Lambda is out of date" is not "this Lambda cannot start builds".
    const reply = { error: 'Unknown tool: "capabilities". Available: get_state, ...', content: [{ text: "x" }] };
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: {}, deps: makeDeps({ ...noWebhook, capabilityReply: reply }) });
    expect(r.startBuild).toBe("unknown");
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toContain("start_build: capabilities_unavailable");
  });

  it("a malformed capabilities body → unknown", async () => {
    const r = await probeCiCheck({
      projectName: "agentcore-hub-ci",
      env: {},
      deps: makeDeps({ ...noWebhook, capabilityReply: capabilitiesEnvelope({ version: 2 }) }),
    });
    expect(r.startBuild).toBe("unknown");
    expect(r.reason).toContain("start_build: capabilities_malformed");
  });

  it("the invoke itself throwing → unknown", async () => {
    const r = await probeCiCheck({
      projectName: "agentcore-hub-ci",
      env: {},
      deps: makeDeps({ ...noWebhook, throwInvoke: err("ResourceNotFoundException") }),
    });
    expect(r.startBuild).toBe("unknown");
    expect(r.reason).toContain("start_build: ResourceNotFoundException");
  });
});

// ─── probeCiCheck — the verdict reduction ────────────────────────────────────

describe("probeCiCheck — verdict", () => {
  it("both routes provably absent → uncertifiable, with the sentence the epic/gate/context all render", async () => {
    const r = await probeCiCheck({
      projectName: "agentcore-hub-ci",
      env: {},
      deps: makeDeps({ projects: [PUSH_ONLY_PROJECT], startCiBuild: false }),
    });
    expect(r.webhook).toBe(false);
    expect(r.startBuild).toBe(false);
    expect(r.certifiable).toBe(false);
    expect(r.verdict).toBe("uncertifiable");
    expect(r.reason).toBe(
      "CodeBuild project agentcore-hub-ci has no PR webhook and the pipeline-tools Lambda cannot start a build."
    );
  });

  it("one false + one unknown → unknown (never uncertifiable on an unproven probe)", async () => {
    const r = await probeCiCheck({
      projectName: "agentcore-hub-ci",
      env: {},
      deps: makeDeps({ projects: [PUSH_ONLY_PROJECT], throwInvoke: err("TimeoutError") }),
    });
    expect(r.webhook).toBe(false);
    expect(r.startBuild).toBe("unknown");
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toContain("no warning is raised on an unproven probe");
  });

  it("either route alone is enough for certifiable", async () => {
    const viaWebhook = await probeCiCheck({ projectName: "p", env: {}, deps: makeDeps({ projects: [PR_WEBHOOK_PROJECT], startCiBuild: false }) });
    expect(viaWebhook.verdict).toBe("certifiable");
    expect(viaWebhook.reason).toContain("has a PR webhook");

    const viaStartBuild = await probeCiCheck({ projectName: "p", env: {}, deps: makeDeps({ projects: [PUSH_ONLY_PROJECT], startCiBuild: true }) });
    expect(viaStartBuild.verdict).toBe("certifiable");
    expect(viaStartBuild.reason).toContain("on demand (no PR webhook installed)");
  });
});

// ─── probeCiCheck — the IAM simulate override ────────────────────────────────

describe("probeCiCheck — iam:SimulatePrincipalPolicy override (opt-in)", () => {
  const SIM_ENV = {
    CI_CHECK_USE_IAM_SIMULATE: "1",
    PIPELINE_TOOLS_ROLE_ARN: "arn:aws:iam::111122223333:role/pipeline-tools",
    AWS_ACCOUNT_ID: "111122223333",
    AWS_REGION: "us-east-1",
  };

  it("allowed overrides a self-reported startCiBuild:false — the ROLE is the authority", async () => {
    const deps = makeDeps({ projects: [PUSH_ONLY_PROJECT], startCiBuild: false, simulate: "allowed" });
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: SIM_ENV, deps });

    expect(deps.iamSimulate).toHaveBeenCalledWith({
      PolicySourceArn: SIM_ENV.PIPELINE_TOOLS_ROLE_ARN,
      ActionNames: ["codebuild:StartBuild"],
      ResourceArns: ["arn:aws:codebuild:us-east-1:111122223333:project/agentcore-hub-ci"],
    });
    expect(r.startBuild).toBe(true);
    expect(r.verdict).toBe("certifiable");
  });

  it("implicitDeny is a real no — it overrides a capabilities flag that claimed true", async () => {
    const deps = makeDeps({ projects: [PUSH_ONLY_PROJECT], startCiBuild: true, simulate: "implicitDeny" });
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: SIM_ENV, deps });
    expect(r.startBuild).toBe(false);
    expect(r.verdict).toBe("uncertifiable");
  });

  it("a throwing simulate falls back to the capabilities answer", async () => {
    const deps = makeDeps({ projects: [PUSH_ONLY_PROJECT], startCiBuild: false, simulate: err("AccessDenied") });
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: SIM_ENV, deps });
    expect(deps.iamSimulate).toHaveBeenCalledTimes(1);
    expect(r.startBuild).toBe(false); // the capability flag, not a crash
  });

  it("an unrecognized decision shape falls back too", async () => {
    const deps = makeDeps({ projects: [PUSH_ONLY_PROJECT], startCiBuild: true, simulate: undefined });
    deps.iamSimulate = vi.fn(async () => ({ EvaluationResults: [{}] }));
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: SIM_ENV, deps });
    expect(r.startBuild).toBe(true);
  });

  it("no AWS_ACCOUNT_ID → the ARN cannot be built, so the simulate is skipped entirely", async () => {
    const deps = makeDeps({ projects: [PUSH_ONLY_PROJECT], startCiBuild: false, simulate: "allowed" });
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: { ...SIM_ENV, AWS_ACCOUNT_ID: "" }, deps });
    expect(deps.iamSimulate).not.toHaveBeenCalled();
    expect(r.startBuild).toBe(false);
  });

  it("not opted in (CI_CHECK_USE_IAM_SIMULATE unset) → never called even with a role arn + dep", async () => {
    const deps = makeDeps({ projects: [PUSH_ONLY_PROJECT], startCiBuild: false, simulate: "allowed" });
    await probeCiCheck({ projectName: "agentcore-hub-ci", env: { ...SIM_ENV, CI_CHECK_USE_IAM_SIMULATE: undefined }, deps });
    expect(deps.iamSimulate).not.toHaveBeenCalled();
  });
});

// ─── probeCiCheck — probe 3: GitHub's side of the webhook ────────────────────

describe("probeCiCheck — GitHub hook corroboration (best-effort)", () => {
  const REPO = { owner: "acme", repo: "juno" };

  it("a codebuild hook subscribed to pull_request → true", async () => {
    const hooks = [
      { config: { url: "https://example.com/other" }, events: ["push"] },
      { config: { url: "https://codebuild.us-east-1.amazonaws.com/webhooks?t=abc" }, events: ["push", "pull_request"] },
    ];
    const r = await probeCiCheck({ projectName: "p", env: {}, deps: makeDeps({ hooks }), repo: REPO });
    expect(r.githubHook).toBe(true);
  });

  it("a codebuild hook that is NOT subscribed to pull_request → false", async () => {
    const hooks = [{ config: { url: "https://codebuild.us-east-1.amazonaws.com/webhooks" }, events: ["push"] }];
    const r = await probeCiCheck({ projectName: "p", env: {}, deps: makeDeps({ hooks }), repo: REPO });
    expect(r.githubHook).toBe(false);
  });

  it("a 403 (token without admin:repo_hook — the normal case) → unknown, and the verdict is unaffected", async () => {
    const deps = makeDeps({ projects: [PUSH_ONLY_PROJECT], startCiBuild: false, throwHooks: err("HttpError403") });
    const r = await probeCiCheck({ projectName: "agentcore-hub-ci", env: {}, deps, repo: REPO });
    expect(r.githubHook).toBe("unknown");
    // githubHook only ever ADDS information — the verdict is webhook + startBuild.
    expect(r.verdict).toBe("uncertifiable");
  });

  it("no githubApi dep / no repo → unknown, and no call is attempted", async () => {
    const deps = makeDeps({ hooks: [] });
    const r = await probeCiCheck({ projectName: "p", env: {}, deps, repo: null });
    expect(r.githubHook).toBe("unknown");
    expect(deps.githubApi).not.toHaveBeenCalled();

    const bare = makeDeps({});
    expect((await probeCiCheck({ projectName: "p", env: {}, deps: bare, repo: REPO })).githubHook).toBe("unknown");
  });

  it("owner and repo are URL-encoded into the hooks path", async () => {
    const deps = makeDeps({ hooks: [] });
    await probeCiCheck({ projectName: "p", env: {}, deps, repo: { owner: "a b", repo: "c/d" } });
    expect(deps.githubApi).toHaveBeenCalledWith("/repos/a%20b/c%2Fd/hooks");
  });

  it("a non-array body → unknown", async () => {
    const deps = makeDeps({ hooks: { message: "Not Found" } });
    const r = await probeCiCheck({ projectName: "p", env: {}, deps, repo: REPO });
    expect(r.githubHook).toBe("unknown");
  });
});

// ─── F10 ─────────────────────────────────────────────────────────────────────

describe("probeCiCheck — F10: nothing but booleans crosses the boundary", () => {
  it("neither an env-var value nor the webhook url/secret appears anywhere in the result", async () => {
    // This object is the real BatchGetProjects shape: a project description
    // carries the webhook secret and every environment variable. The result is
    // persisted to the workflows table, logged, and rendered into every agent's
    // prompt — so a leak here is a leak into all three.
    const project = {
      name: "agentcore-hub-ci",
      arn: "arn:aws:codebuild:us-east-1:111122223333:project/agentcore-hub-ci",
      webhook: {
        url: "https://codebuild.us-east-1.amazonaws.com/webhooks?t=eyJlbmMi",
        secret: "whsec_super_secret",
        filterGroups: [[{ type: "EVENT", pattern: "PUSH" }]],
      },
      environment: {
        environmentVariables: [{ name: "SECRET", value: "hunter2" }],
      },
    };
    const r = await probeCiCheck({
      projectName: "agentcore-hub-ci",
      env: {},
      deps: makeDeps({ projects: [project], startCiBuild: false }),
    });

    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("whsec_super_secret");
    expect(serialized).not.toContain("codebuild.us-east-1.amazonaws.com/webhooks");
    expect(serialized).not.toContain("eyJlbmMi");
    // …and it still answered the question.
    expect(r.verdict).toBe("uncertifiable");
    expect(Object.keys(r).sort()).toEqual(
      ["certifiable", "checkedAt", "githubHook", "projectName", "reason", "startBuild", "verdict", "webhook"]
    );
  });
});

// ─── ensureCiCheck — the per-workflow cache ─────────────────────────────────

describe("ensureCiCheck — TTL cache + persistence", () => {
  const stubStore = () => ({ setCiCheck: vi.fn(async () => {}) });
  const storedAt = (ms, extra = {}) => ({
    checkedAt: new Date(NOW.getTime() - ms).toISOString(),
    projectName: "agentcore-hub-ci",
    webhook: false,
    startBuild: false,
    githubHook: "unknown",
    certifiable: false,
    verdict: "uncertifiable",
    reason: "stored reason",
    mode: "enforce",
    ...extra,
  });

  it("mode off → null, and NOT ONE call (the byte-identical default)", async () => {
    const deps = makeDeps({});
    const store = stubStore();
    const out = await ensureCiCheck({ id: "wf_1" }, { store, deps, env: {}, mode: "off" });
    expect(out).toBeNull();
    expect(deps.codebuildSend).not.toHaveBeenCalled();
    expect(deps.invokeLambda).not.toHaveBeenCalled();
    expect(store.setCiCheck).not.toHaveBeenCalled();
  });

  it("a fresh record for the SAME project → returned as-is, zero probe calls, no re-persist", async () => {
    const deps = makeDeps({});
    const store = stubStore();
    const stored = storedAt(60 * 60 * 1000); // 1h old, TTL 6h
    const out = await ensureCiCheck({ id: "wf_1", ciCheck: stored }, { store, deps, env: {}, mode: "enforce" });

    expect(out).toBe(stored);
    expect(deps.codebuildSend).not.toHaveBeenCalled();
    expect(deps.invokeLambda).not.toHaveBeenCalled();
    expect(store.setCiCheck).not.toHaveBeenCalled();
  });

  it("expired by 1ms (6h TTL) → re-probes and persists exactly once", async () => {
    const deps = makeDeps({ projects: [PR_WEBHOOK_PROJECT] });
    const store = stubStore();
    const stored = storedAt(CI_CHECK_TTL_MS_DEFAULT + 1);
    const out = await ensureCiCheck({ id: "wf_1", ciCheck: stored }, { store, deps, env: {}, mode: "enforce" });

    expect(deps.codebuildSend).toHaveBeenCalledTimes(1);
    expect(store.setCiCheck).toHaveBeenCalledTimes(1);
    expect(store.setCiCheck).toHaveBeenCalledWith("wf_1", out);
    expect(out.verdict).toBe("certifiable");
    expect(out.checkedAt).toBe(NOW.toISOString());
  });

  it("an `unknown` verdict is re-probed after 30min, but not at 29min", async () => {
    const fresh = makeDeps({});
    await ensureCiCheck(
      { id: "wf_1", ciCheck: storedAt(29 * 60 * 1000, { verdict: "unknown" }) },
      { store: stubStore(), deps: fresh, env: {}, mode: "shadow" }
    );
    expect(fresh.codebuildSend).not.toHaveBeenCalled();

    const stale = makeDeps({});
    await ensureCiCheck(
      { id: "wf_1", ciCheck: storedAt(CI_CHECK_UNKNOWN_TTL_MS_DEFAULT + 1, { verdict: "unknown" }) },
      { store: stubStore(), deps: stale, env: {}, mode: "shadow" }
    );
    expect(stale.codebuildSend).toHaveBeenCalledTimes(1);
  });

  it("CI_CHECK_TTL_MS overrides the settled TTL (and only a positive finite number does)", async () => {
    const short = makeDeps({});
    await ensureCiCheck(
      { id: "wf_1", ciCheck: storedAt(60 * 1000) },
      { store: stubStore(), deps: short, env: { CI_CHECK_TTL_MS: "1000" }, mode: "shadow" }
    );
    expect(short.codebuildSend).toHaveBeenCalledTimes(1);

    const garbage = makeDeps({});
    await ensureCiCheck(
      { id: "wf_1", ciCheck: storedAt(60 * 1000) },
      { store: stubStore(), deps: garbage, env: { CI_CHECK_TTL_MS: "soon" }, mode: "shadow" }
    );
    expect(garbage.codebuildSend).not.toHaveBeenCalled();
  });

  it("the project name changing (a CD entry gained a ciProject) invalidates the cache", async () => {
    const deps = makeDeps({});
    const out = await ensureCiCheck(
      { id: "wf_1", ciCheck: storedAt(1000) },
      { store: stubStore(), deps, env: {}, mode: "shadow", delivery: { entry: { ciProject: "juno-pr-check" } } }
    );
    expect(deps.codebuildSend).toHaveBeenCalledWith({ names: ["juno-pr-check"] });
    expect(out.projectName).toBe("juno-pr-check");
  });

  it("a record with an unparseable checkedAt is treated as stale, not as fresh-forever", async () => {
    const deps = makeDeps({});
    await ensureCiCheck(
      { id: "wf_1", ciCheck: storedAt(0, { checkedAt: "never" }) },
      { store: stubStore(), deps, env: {}, mode: "shadow" }
    );
    expect(deps.codebuildSend).toHaveBeenCalledTimes(1);
  });

  it("labeled:true survives a re-probe — the epic is never labelled twice", async () => {
    const deps = makeDeps({ projects: [PR_WEBHOOK_PROJECT] });
    const out = await ensureCiCheck(
      { id: "wf_1", ciCheck: storedAt(CI_CHECK_TTL_MS_DEFAULT + 1, { labeled: true }) },
      { store: stubStore(), deps, env: {}, mode: "enforce" }
    );
    // Even though the verdict flipped back to certifiable.
    expect(out.verdict).toBe("certifiable");
    expect(out.labeled).toBe(true);
  });

  it("stamps the mode it ran under", async () => {
    const out = await ensureCiCheck({ id: "wf_1" }, { store: stubStore(), deps: makeDeps({}), env: {}, mode: "shadow" });
    expect(out.mode).toBe("shadow");
  });

  it("a throwing setCiCheck still returns the new record (the prompt block is not held hostage to a write)", async () => {
    const store = { setCiCheck: vi.fn(async () => { throw new Error("ProvisionedThroughputExceeded"); }) };
    const out = await ensureCiCheck(
      { id: "wf_1" },
      { store, deps: makeDeps({ projects: [PR_WEBHOOK_PROJECT] }), env: {}, mode: "enforce", log: () => {} }
    );
    expect(out.verdict).toBe("certifiable");
  });

  it("a store without setCiCheck at all is fine", async () => {
    const out = await ensureCiCheck({ id: "wf_1" }, { store: {}, deps: makeDeps({}), env: {}, mode: "shadow" });
    expect(out.verdict).toBe("certifiable");
  });

  it("BOTH AWS seams throwing → never throws; verdict unknown, and it is still persisted", async () => {
    const store = stubStore();
    const deps = makeDeps({ throwCodebuild: err("AccessDeniedException"), throwInvoke: err("AccessDeniedException") });
    const out = await ensureCiCheck({ id: "wf_1" }, { store, deps, env: {}, mode: "enforce", log: () => {} });

    expect(out.verdict).toBe("unknown");
    expect(out.webhook).toBe("unknown");
    expect(out.startBuild).toBe("unknown");
    expect(store.setCiCheck).toHaveBeenCalledTimes(1);
  });

  it("an unexpected internal failure falls back to the STORED record rather than throwing at dispatch", async () => {
    const stored = storedAt(1000);
    // resolveCiProjectName reads env — a hostile env getter is the cheapest way
    // to make the module's own code throw outside the probes' try/catch.
    const hostileEnv = { get CI_PROJECT_NAME() { throw new Error("boom"); } };
    const out = await ensureCiCheck(
      { id: "wf_1", ciCheck: stored },
      { store: stubStore(), deps: makeDeps({}), env: hostileEnv, mode: "enforce", log: () => {} }
    );
    expect(out).toBe(stored);
  });

  it("reads the workflow id from either `id` or `workflowId`", async () => {
    const store = stubStore();
    await ensureCiCheck({ workflowId: "wf_9" }, { store, deps: makeDeps({}), env: {}, mode: "shadow" });
    expect(store.setCiCheck.mock.calls[0][0]).toBe("wf_9");
  });
});

// ─── formatCiCheckBlock ──────────────────────────────────────────────────────

describe("formatCiCheckBlock — the ## CI Certification prompt block", () => {
  const base = {
    projectName: "agentcore-hub-ci",
    webhook: false,
    startBuild: false,
    githubHook: "unknown",
    certifiable: false,
    verdict: "uncertifiable",
    reason: "CodeBuild project agentcore-hub-ci has no PR webhook and the pipeline-tools Lambda cannot start a build.",
  };

  it("uncertifiable: header, verdict, the three probe values, and the Consequence contract", () => {
    const out = formatCiCheckBlock(base, "enforce");
    expect(out).toContain("## CI Certification");
    expect(out).toContain("verdict: uncertifiable");
    expect(out).toContain("ci_project: agentcore-hub-ci");
    expect(out).toContain("webhook: false · start_build: false · github_hook: unknown");
    expect(out).toContain(base.reason);
    expect(out).toContain("Consequence:");
    expect(out).toContain("ci_status=unverified");
    expect(out).toContain("github-actions-proxy");
    // The one thing the CI agent must not do.
    expect(out).toContain("must NOT claim ci_status=certified");
    expect(out).not.toContain("mode: shadow");
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("certifiable: the verdict, and NO Consequence paragraph", () => {
    const out = formatCiCheckBlock(
      { ...base, verdict: "certifiable", certifiable: true, webhook: true, reason: "has a PR webhook" },
      "enforce"
    );
    expect(out).toContain("verdict: certifiable");
    expect(out).not.toContain("Consequence:");
    expect(out).not.toContain("ci_status=unverified");
  });

  it("unknown: no Consequence either — an unproven probe states nothing about CI", () => {
    const out = formatCiCheckBlock({ ...base, verdict: "unknown", webhook: "unknown", reason: "Could not determine" }, "enforce");
    expect(out).toContain("verdict: unknown");
    expect(out).not.toContain("Consequence:");
  });

  it("shadow adds the observe-only note so a persona knows nothing was written", () => {
    const out = formatCiCheckBlock(base, "shadow");
    expect(out).toContain("mode: shadow (observe-only — no label, no gate prefix)");
    expect(out).toContain("Consequence:"); // the verdict is still stated
  });

  it("null check → empty string, so `context +=` is always safe", () => {
    expect(formatCiCheckBlock(null, "enforce")).toBe("");
    expect(formatCiCheckBlock(undefined)).toBe("");
  });
});

// ─── prefixCiWarning ─────────────────────────────────────────────────────────

describe("prefixCiWarning — the human merge gate's package", () => {
  const CI = {
    projectName: "agentcore-hub-ci",
    reason: "CodeBuild project agentcore-hub-ci has no PR webhook and the pipeline-tools Lambda cannot start a build.",
  };
  const PKG = {
    gate: "Merge Approval",
    summary: "All 12 tickets done; review clean.",
    bullets: ["3 files changed", "unit tests green"],
    links: [{ label: "PR", url: "https://github.com/acme/juno/pull/42" }],
  };

  it("the warning comes FIRST in summary (that string is the phone notification's details)", () => {
    const out = prefixCiWarning(PKG, CI);
    expect(out.summary.startsWith("⚠ CI UNCERTIFIABLE: ")).toBe(true);
    expect(out.summary).toContain(CI.reason);
    // The original summary is kept, after the warning.
    expect(out.summary).toContain("All 12 tickets done");
    expect(out.summary.length).toBeLessThanOrEqual(500);
  });

  it("a very long original summary is still clipped to the 500-char package contract", () => {
    const out = prefixCiWarning({ ...PKG, summary: "x".repeat(900) }, CI);
    expect(out.summary.length).toBe(500);
    expect(out.summary.startsWith("⚠ CI UNCERTIFIABLE: ")).toBe(true);
  });

  it("the CI bullet is bullet #1, the list stays within 10, and links/gate survive", () => {
    const out = prefixCiWarning({ ...PKG, bullets: Array.from({ length: 12 }, (_, i) => `b${i}`) }, CI);
    expect(out.bullets[0]).toBe("CI: no CodeBuild build can exist for this head (agentcore-hub-ci)");
    expect(out.bullets[0]).toContain(CI.projectName);
    expect(out.bullets).toHaveLength(10);
    expect(out.bullets[1]).toBe("b0");
    expect(out.links).toEqual(PKG.links);
    expect(out.gate).toBe("Merge Approval");
  });

  it("a null package still yields a minimal, well-formed one (the gate ping must carry the warning either way)", () => {
    const out = prefixCiWarning(null, CI);
    expect(out.summary).toBe(`⚠ CI UNCERTIFIABLE: ${CI.reason}`);
    expect(out.bullets).toEqual(["CI: no CodeBuild build can exist for this head (agentcore-hub-ci)"]);
    expect(out.links).toEqual([]);
  });

  it("a ciCheck without a reason/project degrades to a generic sentence, never to undefined", () => {
    const out = prefixCiWarning({ summary: "s" }, {});
    expect(out.summary).toBe("⚠ CI UNCERTIFIABLE: no CodeBuild build can exist for this head. · s");
    expect(out.bullets[0]).toContain("the CI project");
  });

  it("malformed bullets/links on the input package are normalized to arrays", () => {
    const out = prefixCiWarning({ summary: "s", bullets: "nope", links: "nope" }, CI);
    expect(out.bullets).toHaveLength(1);
    expect(out.links).toEqual([]);
  });
});
