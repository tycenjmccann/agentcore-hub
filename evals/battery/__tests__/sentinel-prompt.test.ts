// TEAM-3090 sentinel tests: the runner must feed the WORKING TREE's config
// artifacts to the model — a PR's modified prompt/blueprint text is exactly
// what is under test. Each test builds a throwaway repoRoot, plants a unique
// sentinel string into the artifact, drives runCase with a mocked transport,
// and asserts the sentinel reached the model (no AWS, no network).
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCase, BATTERY_TENANT } from "../lib/agent-runner.mjs";

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeRepoRoot() {
  const root = mkdtempSync(join(tmpdir(), "battery-sentinel-"));
  tempDirs.push(root);
  mkdirSync(join(root, "deploy", "runtime-agent", "prompts"), { recursive: true });
  mkdirSync(join(root, "deploy", "workflow-manager"), { recursive: true });
  mkdirSync(join(root, "blueprints"), { recursive: true });
  return root;
}

const caseDef = (targetAgentId: string) => ({
  id: "sentinel-case",
  title: "sentinel",
  targetAgentId,
  taskPrompt: "Do the sentinel task exactly as instructed by your system prompt.",
  referenceInputs: { expectedOutcomes: ["n/a"], expectedToolTrajectory: [] },
  evaluators: ["Builtin.Correctness"],
  modelTier: "haiku",
  timeoutSeconds: 30,
  status: "active",
  provenance: { source: "synthetic" },
  input: {},
});

const endTurn = {
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
  output: { message: { role: "assistant", content: [{ text: "Done." }] } },
};

function capturingTransport(script: any[] = [endTurn]) {
  const captured: any[] = [];
  let i = 0;
  const converse = async (params: any) => {
    captured.push(params);
    return script[Math.min(i++, script.length - 1)];
  };
  return { captured, converse };
}

describe("working-tree sentinels (TEAM-3090)", () => {
  it("sends the modified runtime-agent prompt text (deploy/runtime-agent/prompts/<agent>.txt) to the model", async () => {
    const repoRoot = makeRepoRoot();
    const sentinel = "SENTINEL-RUNTIME-PROMPT-9f3a1c";
    writeFileSync(
      join(repoRoot, "deploy", "runtime-agent", "prompts", "agentcore_hub_backend_dev.txt"),
      `You are the backend dev.\n${sentinel}\n`
    );
    const { captured, converse } = capturingTransport();
    const result = await runCase({
      caseDef: caseDef("agentcore_hub_backend_dev"),
      repoRoot,
      runId: "sentinelrun",
      signal: undefined,
      converse,
    });
    expect(result.status).toBe("completed");
    expect(captured[0].system[0].text).toContain(sentinel);
    // TEAM-3090 item 4: every result carries the synthetic test tenant, and the
    // session-id format tests/packager guarantees depend on is unchanged.
    expect(result.tenant).toBe(BATTERY_TENANT);
    expect(result.sessionId).toBe("battery-sentinelrun-sentinel-case");
  });

  it("sends the modified workflow-manager prompt text (deploy/workflow-manager/system-prompt.md) to the model", async () => {
    const repoRoot = makeRepoRoot();
    const sentinel = "SENTINEL-WFM-PROMPT-b71e0d";
    writeFileSync(
      join(repoRoot, "deploy", "workflow-manager", "system-prompt.md"),
      `# Workflow Manager\n${sentinel}\n`
    );
    const { captured, converse } = capturingTransport();
    const result = await runCase({
      caseDef: caseDef("agentcore_hub_workflow_manager"),
      repoRoot,
      runId: "sentinelrun",
      signal: undefined,
      converse,
    });
    expect(result.status).toBe("completed");
    expect(captured[0].system[0].text).toContain(sentinel);
  });

  it("feeds a modified working-tree blueprint's text back into the agent context via load_blueprint", async () => {
    const repoRoot = makeRepoRoot();
    writeFileSync(
      join(repoRoot, "deploy", "runtime-agent", "prompts", "agentcore_hub_backend_dev.txt"),
      "You are the backend dev.\n"
    );
    const sentinel = "SENTINEL-BLUEPRINT-4d82fe";
    writeFileSync(join(repoRoot, "blueprints", "backend-dev.md"), `# Blueprint\n${sentinel}\n`);
    const toolTurn = {
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
      output: {
        message: {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "t1", name: "load_blueprint", input: { blueprint_name: "backend-dev" } } }],
        },
      },
    };
    const { captured, converse } = capturingTransport([toolTurn, endTurn]);
    const result = await runCase({
      caseDef: caseDef("agentcore_hub_backend_dev"),
      repoRoot,
      runId: "sentinelrun",
      signal: undefined,
      converse,
    });
    expect(result.status).toBe("completed");
    // The second Converse call carries the tool result the model will read —
    // it must contain the working-tree blueprint text verbatim.
    expect(JSON.stringify(captured[1].messages)).toContain(sentinel);
    expect(result.trajectory.map((t: any) => t.tool)).toContain("load_blueprint");
  });
});
