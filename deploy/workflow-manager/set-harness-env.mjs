#!/usr/bin/env node
/**
 * set-harness-env.mjs — set (or unset) environment variables on a deployed
 * AgentCore Harness WITHOUT touching anything else about it.
 *
 * TEAM-4770. Before this file there was NO tool in the repo that pushed env to a
 * harness: all four UpdateHarness call sites (setup-builder-agent.mjs,
 * routine-builder/setup-routine-builder.mjs, workflow-manager/setup-workflow-manager.mjs,
 * pipeline/restore-harness.mjs) deliberately omit environmentVariables, and
 * setup-routine-builder.mjs says so outright: "Env changes still need a delete +
 * re-run (UpdateHarness env is replace-all)." That is why PR #637's SI_LEDGER_TABLE
 * never reached the live Workflow Manager harness.
 *
 * Why a merge is mandatory (from the SDK typings, UpdateHarnessRequest):
 *   harnessId              — the ONLY required member
 *   environmentVariables?  — "If specified, this replaces all existing environment
 *                            variables. If not specified, the existing value is retained."
 *   everything else        — optional, "If not specified, the existing value is retained."
 * So we send {harnessId, environmentVariables} and NOTHING else: re-sending
 * model/systemPrompt/skills would silently overwrite whatever CD last deployed,
 * and executionRoleArn/environmentArtifact do not need re-sending at all.
 * environmentVariables is read back from GetHarness first and merged, because
 * that one field we do send is replace-all. ListHarnesses is not enough —
 * HarnessSummary carries no environmentVariables, only Harness does.
 *
 * Usage:
 *   node deploy/workflow-manager/set-harness-env.mjs KEY=VALUE [KEY=VALUE ...] \
 *        [--unset KEY ...] [--harness <name>] [--dry-run]
 *
 * Values are NEVER printed (harness env carries credentials) — only key names
 * and counts. Exits 0 with "nothing changed" when every value already matches,
 * so callers can re-run it freely.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// The WM harness name, kept in lockstep with setup-workflow-manager.mjs's
// HARNESS_NAME constant (that file is a top-level-await script with no exports,
// so this is the closest thing to reuse available without refactoring it).
export const DEFAULT_HARNESS_NAME = "agentcore_hub_workflow_manager";

/**
 * Pure merge: existing keys survive, KEY=VALUE args override, --unset removes.
 * Exported for the unit test — this is the whole correctness claim of the file.
 */
export function mergeEnv(live, sets, unsets = []) {
  const env = { ...(live || {}) };
  const changed = [];
  const removed = [];
  for (const [k, v] of Object.entries(sets || {})) {
    if (env[k] !== v) changed.push(k);
    env[k] = v;
  }
  for (const k of unsets) {
    if (k in env) {
      delete env[k];
      removed.push(k);
    }
  }
  return { env, changed, removed };
}

/**
 * The UpdateHarness input. Exactly two members, by design — see the header.
 * Exported so the test can assert nothing else ever creeps in.
 */
export function updateInput(harnessId, env) {
  return { harnessId, environmentVariables: env };
}

/** KEY=VALUE list → object. Throws on a malformed pair. */
export function parseAssignments(args) {
  const sets = {};
  for (const a of args) {
    const eq = a.indexOf("=");
    if (eq <= 0) throw new Error(`expected KEY=VALUE, got ${JSON.stringify(a)}`);
    sets[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return sets;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log([
      "Usage: node deploy/workflow-manager/set-harness-env.mjs KEY=VALUE [...] \\",
      "         [--unset KEY ...] [--harness <name>] [--dry-run]",
      "",
      `  --harness   harness name (default ${DEFAULT_HARNESS_NAME})`,
      "  --unset     remove a key (repeatable)",
      "  --dry-run   print the merged key names and the would-be call, write nothing",
    ].join("\n"));
    return 0;
  }

  const REGION = process.env.AWS_REGION || "us-east-1";
  const DRY_RUN = argv.includes("--dry-run");
  let harnessName = DEFAULT_HARNESS_NAME;
  const unsets = [];
  const assignments = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") continue;
    if (a === "--unset") { unsets.push(argv[++i]); continue; }
    if (a === "--harness") { harnessName = argv[++i]; continue; }
    if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    assignments.push(a);
  }
  const sets = parseAssignments(assignments);
  if (Object.keys(sets).length === 0 && unsets.length === 0) {
    throw new Error("nothing to do — pass at least one KEY=VALUE or --unset KEY");
  }

  const {
    BedrockAgentCoreControlClient,
    GetHarnessCommand,
    ListHarnessesCommand,
    UpdateHarnessCommand,
  } = await import("@aws-sdk/client-bedrock-agentcore-control");
  const agentcore = new BedrockAgentCoreControlClient({ region: REGION });

  // ListHarnesses → id, then GetHarness → the live env (summaries have no env).
  let summary = null;
  let nextToken;
  do {
    const page = await agentcore.send(new ListHarnessesCommand({ nextToken }));
    summary = (page.harnesses || []).find((h) => h.harnessName === harnessName) || summary;
    nextToken = page.nextToken;
  } while (nextToken && !summary);
  if (!summary) throw new Error(`harness ${harnessName} not found in ${REGION}`);

  const { harness } = await agentcore.send(new GetHarnessCommand({ harnessId: summary.harnessId }));
  const { env, changed, removed } = mergeEnv(harness?.environmentVariables, sets, unsets);

  console.log(
    `🔧 ${harnessName} (${summary.harnessId}, status ${harness?.status}) — ` +
    `set ${changed.length ? changed.join(",") : "nothing"}, ` +
    `unset ${removed.length ? removed.join(",") : "nothing"}; ${Object.keys(env).length} vars total`,
  );
  if (!changed.length && !removed.length) {
    console.log("   nothing changed");
    return 0;
  }
  if (DRY_RUN) {
    console.log(`   dry run — would call UpdateHarness(${JSON.stringify(Object.keys(updateInput(summary.harnessId, env)))}) ` +
      `with keys: ${Object.keys(env).sort().join(",")}`);
    return 0;
  }

  await agentcore.send(new UpdateHarnessCommand(updateInput(summary.harnessId, env)));

  // Same poll shape as setup-workflow-manager.mjs's update path.
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const { harness: h } = await agentcore.send(new GetHarnessCommand({ harnessId: summary.harnessId }));
    if (h?.status === "READY") {
      console.log("   ✓ READY");
      return 0;
    }
    if (h?.status === "UPDATE_FAILED") {
      throw new Error(`UpdateHarness failed: ${h?.failureReason || "unknown"}`);
    }
  }
  throw new Error("timed out waiting for harness READY after env update");
}

// Only run when invoked directly, so the test can import the pure helpers.
// TEAM-4787: pathToFileURL, not `file://${process.argv[1]}` — import.meta.url is
// percent-encoded, so from any path containing a space (or #, ?, …) the template
// never matched, main() never ran, and the process exited 0 with NO output. The
// handoff would then report a successful harness push having pushed nothing,
// which is the same class of silent-inertness bug as TEAM-4770 itself.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await main());
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
