/**
 * TEAM-4188 (TEAM-4169 D1 FR-1.6) — SYNC_MAIN_BEFORE_CI's EFFECTIVE value.
 *
 * FR-1.6 asks for an assertion on the effective flag, not on a merge commit. There
 * was none, and all four surfaces resolved to OFF: template.yaml's parameter
 * Default was "off", deploy.sh forwarded the var to the Lambda only when it was
 * explicitly exported, .env.example shipped the line commented out and described
 * the default as off, and index.mjs resolved `undefined` through normalizeSyncMode
 * to "off". So every install ran with the pre-CI default-branch sync OFF while
 * blueprints/ci-agent.md told the CI agent the orchestrator had already merged main
 * for it — the prose was a promise the config did not keep. The one existing test
 * in the area (replay-f50ucz-ship-rewake.test.mjs:246) asserts normalizeSyncMode as
 * a FUNCTION and never reads the effective value, so it could not catch this.
 *
 * The flag is the only thing that decides whether a run syncs, so all four surfaces
 * have to agree on ONE value. EXPECTED_DEFAULT is written once, here; every part
 * below compares against it. A future flip to shadow (or back to off) therefore
 * fails loudly in one place instead of drifting surface by surface.
 *
 * This is the SURFACE + SOURCE half of the assertion. The BEHAVIOURAL half is
 * replay-yteqfl-sync-main.test.mjs's `describe("unset — the plain install now
 * ENFORCES")`, which deletes the env var, re-imports the real index.mjs and drives
 * the real handler through the real guard: main is merged, the 409 files the
 * sync_fix ticket, CI is not dispatched. The pair is deliberate — a behavioural
 * test cannot tell a reverted `:280` from a config change, and a source pin cannot
 * prove the guard actually runs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { normalizeSyncMode, resolveSyncModeFromEnv, DEFAULT_SYNC_MODE } from "./sync-main.mjs";

/** The ONE value all four surfaces must agree on. */
const EXPECTED_DEFAULT = "enforce";

const HERE = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(HERE, "..", "..");
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

const TEMPLATE_SRC = read("lambda/orchestrator/template.yaml");
const DEPLOY_SRC = read("lambda/orchestrator/deploy.sh");
const ENV_EXAMPLE_SRC = read(".env.example");
const INDEX_SRC = read("lambda/orchestrator/index.mjs");

// `!Ref`/`!GetAtt` are CFN short tags the plain YAML parser cannot resolve; it
// renders them as bare strings (which is exactly what part (a) reads) and warns
// ~50 times doing it, hence logLevel silent.
const TEMPLATE = parse(TEMPLATE_SRC, { logLevel: "silent" });

// ── (a) template.yaml — the DEPLOYED parameter ───────────────────────────────
//
// The var rides Globals.Function.Environment.Variables, so all three
// AWS::Serverless::Function resources in this stack (OrchestratorFunction,
// AgentInvokerFunction, EventsWriterFunction) receive it. Only index.mjs reads it;
// it is inert in the other two. That "inert" claim is asserted in part (e), not
// here, because it is a property of the source, not of the template.
describe("(a) template.yaml — the deployed SyncMainBeforeCi parameter", () => {
  const param = () => TEMPLATE?.Parameters?.SyncMainBeforeCi;

  it(`Default is "${EXPECTED_DEFAULT}"`, () => {
    expect(param()).toBeTruthy();
    expect(param().Default).toBe(EXPECTED_DEFAULT);
  });

  it("the Default is a real allow-list member — CFN cannot hand the Lambda a value the code downgrades", () => {
    // If Default drifted to something outside MODES, normalizeSyncMode would
    // silently coerce it to off inside the Lambda and the stack would still deploy.
    expect(normalizeSyncMode(param().Default)).toBe(param().Default);
  });

  it("the Default does NOT resolve to off (the literal FR-1.6 acceptance)", () => {
    expect(normalizeSyncMode(param().Default)).not.toBe("off");
  });

  it("AllowedValues still contains it, and off is still reachable for rollback", () => {
    expect(param().AllowedValues).toContain(EXPECTED_DEFAULT);
    expect(param().AllowedValues).toContain("off");
  });

  it("the Globals env var still !Refs THIS parameter", () => {
    // A rename that missed one side would leave SYNC_MAIN_BEFORE_CI unset in the
    // deployed stack — i.e. silently back to the bug, with the Default looking right.
    expect(TEMPLATE?.Globals?.Function?.Environment?.Variables?.SYNC_MAIN_BEFORE_CI)
      .toBe("SyncMainBeforeCi");
  });
});

// ── (b) deploy.sh — the shell default and its scope ──────────────────────────
describe("(b) deploy.sh — unconditional forward with the same default", () => {
  const assignment =
    /SYNC_MAIN_BEFORE_CI_VARS=",SYNC_MAIN_BEFORE_CI=\$\{SYNC_MAIN_BEFORE_CI:-([a-z-]+)\}"/;

  it(`forwards \${SYNC_MAIN_BEFORE_CI:-${EXPECTED_DEFAULT}} — the shell default matches the template`, () => {
    const m = DEPLOY_SRC.match(assignment);
    expect(m).toBeTruthy();
    expect(m[1]).not.toBe("off");
    expect(m[1]).toBe(EXPECTED_DEFAULT);
    expect(m[1]).toBe(TEMPLATE.Parameters.SyncMainBeforeCi.Default);
  });

  it("uses `:-`, not `-`, so an exported-but-EMPTY value counts as unset (matches the resolver)", () => {
    // `${VAR-default}` would forward an empty string, which resolveSyncModeFromEnv
    // maps to enforce anyway — but then the two halves of one install disagree about
    // what the deployed config SAYS. `:-` keeps them identical.
    expect(DEPLOY_SRC).toContain("${SYNC_MAIN_BEFORE_CI:-enforce}");
    expect(DEPLOY_SRC).not.toMatch(/\$\{SYNC_MAIN_BEFORE_CI-/);
  });

  it("no forward-when-set block survives — that IS the regression this ticket fixes", () => {
    expect(DEPLOY_SRC).not.toMatch(/if \[ -n "\$\{SYNC_MAIN_BEFORE_CI/);
    expect(DEPLOY_SRC).not.toMatch(/^SYNC_MAIN_BEFORE_CI_VARS=""$/m);
  });

  it("orchestrator ONLY: ENV_VARS_ORCH carries it, the invoker and events writer do not", () => {
    const line = (name) => DEPLOY_SRC.match(new RegExp(`^${name}="Variables=.*$`, "m"))?.[0] || "";
    expect(line("ENV_VARS_ORCH")).toContain("${SYNC_MAIN_BEFORE_CI_VARS}");
    expect(line("ENV_VARS_INVOKER")).not.toContain("SYNC_MAIN_BEFORE_CI");
    expect(line("ENV_VARS_EVENTS")).not.toContain("SYNC_MAIN_BEFORE_CI");
  });
});

// ── (c) .env.example — what the operator is told ─────────────────────────────
describe("(c) .env.example — one voice, and it says enforce", () => {
  it(`ships exactly one uncommented SYNC_MAIN_BEFORE_CI=${EXPECTED_DEFAULT}`, () => {
    const live = ENV_EXAMPLE_SRC.split("\n").filter((l) => /^SYNC_MAIN_BEFORE_CI=/.test(l));
    expect(live).toHaveLength(1);
    const value = live[0].match(/^SYNC_MAIN_BEFORE_CI=(\S+)$/)?.[1];
    expect(value).not.toBe("off");
    expect(value).toBe(EXPECTED_DEFAULT);
    expect(value).toBe(TEMPLATE.Parameters.SyncMainBeforeCi.Default);
  });

  it("leaves NO commented twin — the file cannot say two different things", () => {
    const commented = ENV_EXAMPLE_SRC.split("\n").filter((l) => /^#\s*SYNC_MAIN_BEFORE_CI=/.test(l));
    expect(commented).toEqual([]);
  });

  it("the prose agrees with the value — the prose saying off while the value said on IS the finding", () => {
    expect(ENV_EXAMPLE_SRC).toContain(`# Pre-CI default-branch sync (default ${EXPECTED_DEFAULT}):`);
    expect(ENV_EXAMPLE_SRC).not.toContain("# Pre-CI default-branch sync (default off):");
  });
});

// ── (d) resolveSyncModeFromEnv — the module-level resolution ─────────────────
//
// Pure, so this is a plain-object table with no module-graph reset. The asymmetry
// is the whole design: ABSENT means nobody chose, so the guarantee applies;
// PRESENT-but-garbage means someone typed something wrong, and enforce PUSHES A
// COMMIT to a shared branch, so that must fail safe to off.
describe("(d) resolveSyncModeFromEnv — absent/empty default, garbage still fails safe", () => {
  it("an absent var resolves to the default, NOT off (the AC)", () => {
    expect(resolveSyncModeFromEnv({})).toBe(EXPECTED_DEFAULT);
    expect(resolveSyncModeFromEnv({})).not.toBe("off");
    expect(resolveSyncModeFromEnv({ SYNC_MAIN_BEFORE_CI: undefined })).toBe(EXPECTED_DEFAULT);
    expect(resolveSyncModeFromEnv({ SYNC_MAIN_BEFORE_CI: null })).toBe(EXPECTED_DEFAULT);
  });

  it("EMPTY counts as unset — bash `${VAR:-enforce}` parity", () => {
    expect(resolveSyncModeFromEnv({ SYNC_MAIN_BEFORE_CI: "" })).toBe(EXPECTED_DEFAULT);
    expect(resolveSyncModeFromEnv({ SYNC_MAIN_BEFORE_CI: "   " })).toBe(EXPECTED_DEFAULT);
  });

  it("an explicit value passes through, including the off rollback", () => {
    expect(resolveSyncModeFromEnv({ SYNC_MAIN_BEFORE_CI: "off" })).toBe("off");
    expect(resolveSyncModeFromEnv({ SYNC_MAIN_BEFORE_CI: "shadow" })).toBe("shadow");
    expect(resolveSyncModeFromEnv({ SYNC_MAIN_BEFORE_CI: "enforce" })).toBe("enforce");
    expect(resolveSyncModeFromEnv({ SYNC_MAIN_BEFORE_CI: "ENFORCE" })).toBe("enforce");
  });

  it("PRESENT-but-garbage still coalesces to off — the fail-safe is UNCHANGED", () => {
    for (const v of ["main-first", "enfroce", "shadwo", "true", "1", "on", "yes", "0", "false"]) {
      expect(resolveSyncModeFromEnv({ SYNC_MAIN_BEFORE_CI: v })).toBe("off");
    }
  });

  it("normalizeSyncMode is untouched: unset/empty still off there", () => {
    // Re-pinned HERE as well as in sync-main.test.mjs, so a future refactor cannot
    // "simplify" the two functions into one and quietly arm a typo'd env var.
    for (const v of [undefined, null, "", "  "]) expect(normalizeSyncMode(v)).toBe("off");
    expect(normalizeSyncMode("main-first")).toBe("off");
  });

  it("DEFAULT_SYNC_MODE is the one source of truth, and matches the deploy surfaces", () => {
    expect(DEFAULT_SYNC_MODE).toBe(EXPECTED_DEFAULT);
    expect(DEFAULT_SYNC_MODE).toBe(TEMPLATE.Parameters.SyncMainBeforeCi.Default);
    expect(resolveSyncModeFromEnv({})).toBe(DEFAULT_SYNC_MODE);
  });
});

// ── (e) the flag reaches the CI phase in that mode ───────────────────────────
//
// Source-level pins. Cheap, and they guard the exact regression: reverting :280 to
// normalizeSyncMode(process.env.…) restores the bug while every behavioural test
// that sets the var explicitly keeps passing.
describe("(e) index.mjs consumes the resolver, and both CI guards are live", () => {
  it("the module-level flag is resolveSyncModeFromEnv(), not normalizeSyncMode(process.env…)", () => {
    expect(INDEX_SRC).toMatch(/const SYNC_MAIN_BEFORE_CI = resolveSyncModeFromEnv\(\)/);
    expect(INDEX_SRC).not.toMatch(/normalizeSyncMode\(process\.env/);
  });

  it("BOTH CI dispatch guards are present (unified ready path + DDB ready path)", () => {
    // Asserted as a COUNT: there are two ready paths, and deleting one would leave
    // half the runs unsynced with every other assertion here still green.
    const guards = INDEX_SRC.match(
      /SYNC_MAIN_BEFORE_CI !== "off" && agentDef\?\.agentId === CI_AGENT_ID/g,
    );
    expect(guards).toHaveLength(2);
  });

  it("syncDeps() short-circuits on `=== \"off\"` only — shadow and enforce both build the seams", () => {
    expect(INDEX_SRC).toMatch(/if \(SYNC_MAIN_BEFORE_CI === "off"\) return null;/);
  });

  it("the other two Lambdas never read the var (the 'inert in Globals' claim from (a))", () => {
    expect(read("lambda/orchestrator/agent-invoker.mjs")).not.toContain("SYNC_MAIN_BEFORE_CI");
    expect(read("lambda/orchestrator/events-writer.mjs")).not.toContain("SYNC_MAIN_BEFORE_CI");
  });
});
