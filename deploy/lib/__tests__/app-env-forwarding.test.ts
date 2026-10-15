import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TEAM-6188 regression: SHIP_MERGE_VERIFY (the ship merge-verify completion
 * gate opt-out, read by src/lib/workflow/follow-up-pr-gate.ts and the
 * orchestrator's index.mjs completeWorkflow) is documented in .env.example
 * and scripts/orchestrator-env.allow, but none of the three deploy scripts
 * that assemble a runtime's env actually forwarded it — so setting it in
 * .env.local / the shell had no effect on any deployed function. The HTTP
 * /complete route and the orchestrator would silently disagree about whether
 * the gate is on.
 *
 * Each script's env-builder is sliced out between two anchor lines (so a
 * refactor that moves the anchors fails loudly here rather than silently
 * testing nothing) and run standalone in bash with a clean env (does NOT
 * inherit process.env — only PATH plus the case's vars), then the resulting
 * JSON is parsed back so these tests pin WHAT is forwarded, not just that a
 * loop ran.
 */

const REPO = resolve(__dirname, "../../..");

function extractBlock(file: string, startMarker: string, endMarker: string): string {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l.includes(startMarker));
  if (startIdx === -1) {
    throw new Error(`anchor not found in ${file}: ${JSON.stringify(startMarker)}`);
  }
  const endIdx = lines.findIndex((l, i) => i >= startIdx && l.includes(endMarker));
  if (endIdx === -1) {
    throw new Error(`end anchor not found in ${file}: ${JSON.stringify(endMarker)}`);
  }
  return lines.slice(startIdx, endIdx + 1).join("\n");
}

function runBashSnippet(snippet: string, env: Record<string, string>, printVar: string): string {
  // The snippet itself may `echo` (e.g. lambda/orchestrator/deploy.sh's forwarded-var
  // log lines) — redirect its own stdout away so only the final printf is captured.
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n{ ${snippet}\n} >/dev/null\nprintf '%s' "$${printVar}"`], {
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
  });
  if (r.status !== 0) {
    throw new Error(`bash snippet failed (status ${r.status}): ${r.stderr}`);
  }
  return r.stdout;
}

describe("deploy/ecs-express/deploy.sh env forwarding", () => {
  const FILE = resolve(REPO, "deploy/ecs-express/deploy.sh");
  const BLOCK = () => extractBlock(FILE, 'ENV_JSON="[{\\"name\\":\\"HOSTNAME\\"', 'ENV_JSON+="]"');

  it("forwards SHIP_MERGE_VERIFY when set", () => {
    const out = runBashSnippet(BLOCK(), { SHIP_MERGE_VERIFY: "off" }, "ENV_JSON");
    const vars = JSON.parse(out) as Array<{ name: string; value: string }>;
    expect(vars).toContainEqual({ name: "SHIP_MERGE_VERIFY", value: "off" });
  });

  it("omits SHIP_MERGE_VERIFY when unset (default-on is preserved)", () => {
    const out = runBashSnippet(BLOCK(), {}, "ENV_JSON");
    const vars = JSON.parse(out) as Array<{ name: string; value: string }>;
    expect(vars.find((v) => v.name === "SHIP_MERGE_VERIFY")).toBeUndefined();
  });

  it("still forwards the control vars (GITHUB_OWNER, TICKETS_TABLE) and the HOSTNAME/PORT pins", () => {
    // GITHUB_OWNER/TICKETS_TABLE (not GITHUB_PAT/ARTIFACT_BUCKET) deliberately:
    // this sandbox pins real AWS/GitHub credentials ambiently into every Node
    // child process regardless of the explicit `env` passed to spawnSync, so a
    // credential-shaped control var would assert against a real secret value
    // instead of the fixture's. These names are not similarly pinned.
    const out = runBashSnippet(BLOCK(), { GITHUB_OWNER: "fake-owner", TICKETS_TABLE: "fake-table" }, "ENV_JSON");
    const vars = JSON.parse(out) as Array<{ name: string; value: string }>;
    expect(vars).toContainEqual({ name: "GITHUB_OWNER", value: "fake-owner" });
    expect(vars).toContainEqual({ name: "TICKETS_TABLE", value: "fake-table" });
    expect(vars).toContainEqual({ name: "HOSTNAME", value: "0.0.0.0" });
    expect(vars).toContainEqual({ name: "PORT", value: "8080" });
  });
});

describe("deploy/apprunner/deploy.sh env forwarding", () => {
  const FILE = resolve(REPO, "deploy/apprunner/deploy.sh");
  const BLOCK = () => extractBlock(FILE, "ENV_VARS='{", "ENV_VARS+='}'");

  it("forwards SHIP_MERGE_VERIFY when set", () => {
    const out = runBashSnippet(BLOCK(), { SHIP_MERGE_VERIFY: "off" }, "ENV_VARS");
    const vars = JSON.parse(out) as Record<string, string>;
    expect(vars.SHIP_MERGE_VERIFY).toBe("off");
  });

  it("omits SHIP_MERGE_VERIFY when unset (default-on is preserved)", () => {
    const out = runBashSnippet(BLOCK(), {}, "ENV_VARS");
    const vars = JSON.parse(out) as Record<string, string>;
    expect(vars.SHIP_MERGE_VERIFY).toBeUndefined();
  });

  it("still forwards the control vars (GITHUB_OWNER, TICKETS_TABLE) and the HOSTNAME/PORT pins", () => {
    const out = runBashSnippet(BLOCK(), { GITHUB_OWNER: "fake-owner", TICKETS_TABLE: "fake-table" }, "ENV_VARS");
    const vars = JSON.parse(out) as Record<string, string>;
    expect(vars.GITHUB_OWNER).toBe("fake-owner");
    expect(vars.TICKETS_TABLE).toBe("fake-table");
    expect(vars.HOSTNAME).toBe("0.0.0.0");
    expect(vars.PORT).toBe("8080");
  });
});

describe("lambda/orchestrator/deploy.sh SHIP_MERGE_VERIFY forwarding", () => {
  const FILE = resolve(REPO, "lambda/orchestrator/deploy.sh");
  const BLOCK = () => extractBlock(FILE, 'SHIP_MERGE_VERIFY_VARS=""', "fi");

  it("forwards SHIP_MERGE_VERIFY when set", () => {
    const out = runBashSnippet(BLOCK(), { SHIP_MERGE_VERIFY: "off" }, "SHIP_MERGE_VERIFY_VARS");
    expect(out).toBe(",SHIP_MERGE_VERIFY=off");
  });

  it("stays empty when unset (default-on is preserved)", () => {
    const out = runBashSnippet(BLOCK(), {}, "SHIP_MERGE_VERIFY_VARS");
    expect(out).toBe("");
  });
});
