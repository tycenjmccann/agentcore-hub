// Trust-boundary invariants of the trusted fork publisher,
// .github/workflows/config-evals-gate-fork-publish.yml (TEAM-3438 Finding 3).
//
// Fork pull_request runs of the gate get a read-only GITHUB_TOKEN and cannot
// publish the required `config-evals-gate` check (CRED-2). The publisher
// closes that gap from the trusted side: a workflow_run workflow that runs
// the DEFAULT-BRANCH definition with an honored write token. Its safety rests
// on structural properties a later edit could silently regress:
//
//   - it never checks out or executes fork code, and never downloads/trusts
//     artifacts from the triggering run — github-script only;
//   - it recomputes gatedness itself, with EXACTLY the same gated-path list
//     as the gate's changed-paths job (the keep-in-sync pin lives here);
//   - it can publish FAIL / SKIPPED / ERRORED verdicts but can never mint a
//     PASS, and every summary leads with the machine-readable marker line
//     deploy/lib/check-eval-gate.sh consumes;
//   - least privilege: workflow permissions {}, job holds exactly
//     checks:write + pull-requests:read.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const forkPublish = parse(
  readFileSync(join(REPO_ROOT, ".github/workflows/config-evals-gate-fork-publish.yml"), "utf8")
);
const gate = parse(
  readFileSync(join(REPO_ROOT, ".github/workflows/config-evals-gate.yml"), "utf8")
);

const jobs: Record<string, any> = forkPublish.jobs;
const publisher = jobs["publish-fork-check"];
const steps: any[] = publisher?.steps ?? [];
const script: string = steps.map((s) => `${s.run ?? ""}\n${s.with?.script ?? ""}`).join("\n");

describe("trigger & least privilege", () => {
  it("triggers ONLY on workflow_run(completed) of the Config Evals Gate", () => {
    expect(Object.keys(forkPublish.on)).toEqual(["workflow_run"]);
    expect(forkPublish.on.workflow_run.workflows).toEqual(["Config Evals Gate"]);
    expect(forkPublish.on.workflow_run.types).toEqual(["completed"]);
    // The reference stays valid only while the gate keeps this exact name.
    expect(gate.name).toBe("Config Evals Gate");
  });

  it("workflow permissions are {} and the single job holds exactly checks:write + pull-requests:read", () => {
    expect(forkPublish.permissions).toEqual({});
    expect(Object.keys(jobs)).toEqual(["publish-fork-check"]);
    expect(publisher.permissions).toEqual({ checks: "write", "pull-requests": "read" });
    expect(publisher["timeout-minutes"]).toBe(5);
  });

  it("acts only on fork pull_request runs (same-repo runs publish their own checks)", () => {
    const cond = String(publisher.if);
    expect(cond).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(cond).toContain(
      "github.event.workflow_run.head_repository.full_name != github.event.repository.full_name"
    );
  });
});

describe("zero fork code, zero artifact trust", () => {
  it("never checks out anything and never downloads artifacts — github-script only", () => {
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      const uses = String(s.uses ?? "");
      expect(uses, "no checkout step").not.toMatch(/actions\/checkout/);
      expect(uses, "no artifact download").not.toMatch(/download-artifact/);
      if (uses) expect(uses).toMatch(/^actions\/github-script@/);
      expect(s.run, "no shell steps at all").toBeUndefined();
    }
    expect(script).not.toContain("downloadArtifact");
    expect(script).not.toContain("listWorkflowRunArtifacts");
  });

  it("recomputes gatedness itself via pulls.listFiles, with rename (previous_filename) semantics", () => {
    expect(script).toContain("github.rest.pulls.listFiles");
    expect(script).toContain("previous_filename");
  });
});

describe("gated-path list — keep-in-sync pin with changed-paths", () => {
  // The publisher duplicates changed-paths' gated list because it cannot
  // trust the fork run's outputs. This equality IS the sync contract: editing
  // one list without the other fails here.
  const grab = (source: string, name: string): string[] => {
    const m = source.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\];`));
    expect(m, `${name} array not found`).toBeTruthy();
    return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const gateScript: string = gate.jobs["changed-paths"].steps[0].with.script;

  it("gatedPrefixes and gatedFiles match config-evals-gate.yml's changed-paths EXACTLY", () => {
    expect(grab(script, "const gatedPrefixes")).toEqual(grab(gateScript, "const gatedPrefixes"));
    expect(grab(script, "const gatedFiles")).toEqual(grab(gateScript, "const gatedFiles"));
  });

  it("the gated list covers the publisher workflow itself (a PR editing it runs the gate)", () => {
    expect(grab(gateScript, "const gatedFiles")).toContain(
      ".github/workflows/config-evals-gate-fork-publish.yml"
    );
  });
});

describe("published check — name, sha, verdicts, marker", () => {
  it("publishes the config-evals-gate check on the triggering run's head sha", () => {
    expect(script).toContain('name: "config-evals-gate"');
    expect(script).toContain("context.payload.workflow_run");
    expect(script).toMatch(/const headSha = run\.head_sha/);
    expect(script).toMatch(/head_sha: headSha/);
  });

  it("leads every summary with the marker line, prepended BEFORE truncation", () => {
    expect(script).toContain("`config-evals-gate-verdict: ${verdict}\\n\\n${body}`");
    expect(script).toContain("summary.slice(0, 60000)");
  });

  it("gated ⇒ failure/FAIL, ungated ⇒ success/SKIPPED, errors ⇒ failure/ERRORED — and it can never mint a PASS", () => {
    expect(script).toMatch(/publish\(\s*"failure",\s*"FAIL"/);
    expect(script).toMatch(/publish\(\s*"success",\s*"SKIPPED"/);
    expect(script).toMatch(/publish\(\s*"failure",\s*"ERRORED"/);
    // The ONLY success conclusion the publisher can produce is SKIPPED: a
    // fork PR must never acquire anything the deploy guard could read as a
    // battery PASS.
    const successVerdicts = [...script.matchAll(/publish\(\s*"success",\s*"([A-Z]+)"/g)].map((m) => m[1]);
    expect(successVerdicts).toEqual(["SKIPPED"]);
    expect(script).not.toContain('"PASS"');
  });

  it("fails closed: an unresolvable PR publishes an ERRORED FAILURE instead of silently skipping", () => {
    // Resolution has API fallbacks (workflow_run.pull_requests is often
    // empty for forks), and the no-PR terminal branch publishes red.
    expect(script).toContain("listPullRequestsAssociatedWithCommit");
    expect(script).toMatch(/prNumber == null[\s\S]*publish\(\s*"failure",\s*"ERRORED"/);
    // The outer catch also lands on ERRORED FAILURE and fails the job.
    expect(script).toContain("core.setFailed");
  });
});
