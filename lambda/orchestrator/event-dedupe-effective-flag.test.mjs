/**
 * TEAM-4190 (ship-review r1 F2) — EVENT_DEDUPE_MODE's EFFECTIVE deployed value.
 *
 * TEAM-4167 D3 (FR-3.4) flipped the default to enforce in all three code
 * consumers (index.mjs, agent-invoker.mjs, events-writer.mjs each call
 * normalizeEventDedupeMode(process.env.EVENT_DEDUPE_MODE, "enforce")) and in
 * deploy.sh (EVENT_DEDUPE_VARS forwards ${EVENT_DEDUPE_MODE:-enforce} to all
 * three). The SAM parameter in template.yaml was never updated — its Default
 * stayed "off" with pre-epic prose claiming a fresh deploy was byte-identical.
 * Any `sam deploy` relying on the template default (no override passed) would
 * hand all three writers EVENT_DEDUPE_MODE=off and silently re-introduce the
 * events-table twin write. .env.example disagreed too: the line shipped
 * commented out, the header said "(default off)", and the prose claimed a
 * garbage value coalesces to off — wrong for the two-arg call, which takes the
 * caller's defaultMode ("enforce").
 *
 * event-id.test.mjs already pins normalizeEventDedupeMode as a FUNCTION; it
 * never reads the deployed template/deploy.sh/.env.example values, so it could
 * not catch this. EXPECTED_DEFAULT is written once, here; every part below
 * compares against it, following the TEAM-4188 sync-main-effective-flag.test.mjs
 * pattern for the same class of bug.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { normalizeEventDedupeMode } from "./event-id.mjs";

/** The ONE value all deploy surfaces must agree on. */
const EXPECTED_DEFAULT = "enforce";

const HERE = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(HERE, "..", "..");
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

const TEMPLATE_SRC = read("lambda/orchestrator/template.yaml");
const DEPLOY_SRC = read("lambda/orchestrator/deploy.sh");
const ENV_EXAMPLE_SRC = read(".env.example");
const INDEX_SRC = read("lambda/orchestrator/index.mjs");
const INVOKER_SRC = read("lambda/orchestrator/agent-invoker.mjs");
const EVENTS_WRITER_SRC = read("lambda/orchestrator/events-writer.mjs");

// `!Ref`/`!GetAtt` are CFN short tags the plain YAML parser cannot resolve; it
// renders them as bare strings (which is exactly what part (a) reads) and warns
// doing it, hence logLevel silent.
const TEMPLATE = parse(TEMPLATE_SRC, { logLevel: "silent" });

const FUNCTION_RESOURCES = ["OrchestratorFunction", "AgentInvokerFunction", "EventsWriterFunction"];

// ── (a) template.yaml — the DEPLOYED parameter ───────────────────────────────
//
// The var rides Globals.Function.Environment.Variables, so all three
// AWS::Serverless::Function resources in this stack receive it. A per-function
// Environment override on any one of them would leave that writer alone with
// the stale value even after the Default is fixed — the exact way one writer
// gets left writing its own second row — so that is asserted PER FUNCTION.
describe("(a) template.yaml — the deployed EventDedupeMode parameter", () => {
  const param = () => TEMPLATE?.Parameters?.EventDedupeMode;

  it(`Default is "${EXPECTED_DEFAULT}"`, () => {
    expect(param()).toBeTruthy();
    expect(param().Default).toBe(EXPECTED_DEFAULT);
  });

  it("the Default is a real allow-list member — CFN cannot hand the Lambdas a value the code downgrades", () => {
    expect(normalizeEventDedupeMode(param().Default, "enforce")).toBe(param().Default);
  });

  it("the Default does NOT resolve to off (the literal F2 acceptance)", () => {
    expect(normalizeEventDedupeMode(param().Default, "enforce")).not.toBe("off");
  });

  it("AllowedValues still contains it, and off is still reachable for rollback", () => {
    expect(param().AllowedValues).toContain(EXPECTED_DEFAULT);
    expect(param().AllowedValues).toContain("off");
  });

  it("the Globals env var still !Refs THIS parameter", () => {
    expect(TEMPLATE?.Globals?.Function?.Environment?.Variables?.EVENT_DEDUPE_MODE)
      .toBe("EventDedupeMode");
  });

  it.each(FUNCTION_RESOURCES)("%s declares no per-function EVENT_DEDUPE_MODE override", (name) => {
    const props = TEMPLATE?.Resources?.[name]?.Properties;
    expect(props?.Environment?.Variables?.EVENT_DEDUPE_MODE).toBeUndefined();
  });
});

// ── (b) deploy.sh — the shell default and its scope ──────────────────────────
describe("(b) deploy.sh — unconditional forward with the same default, to ALL THREE writers", () => {
  const assignment =
    /EVENT_DEDUPE_VARS=",EVENT_DEDUPE_MODE=\$\{EVENT_DEDUPE_MODE:-([a-z]+)\}"/;

  it(`forwards \${EVENT_DEDUPE_MODE:-${EXPECTED_DEFAULT}} — the shell default matches the template`, () => {
    const m = DEPLOY_SRC.match(assignment);
    expect(m).toBeTruthy();
    expect(m[1]).not.toBe("off");
    expect(m[1]).toBe(EXPECTED_DEFAULT);
    expect(m[1]).toBe(TEMPLATE.Parameters.EventDedupeMode.Default);
  });

  it("uses `:-`, not `-`, so an exported-but-EMPTY value counts as unset", () => {
    expect(DEPLOY_SRC).toContain("${EVENT_DEDUPE_MODE:-enforce}");
    expect(DEPLOY_SRC).not.toMatch(/\$\{EVENT_DEDUPE_MODE-/);
  });

  it("no forward-when-set block survives", () => {
    expect(DEPLOY_SRC).not.toMatch(/if \[ -n "\$\{EVENT_DEDUPE_MODE/);
    expect(DEPLOY_SRC).not.toMatch(/^EVENT_DEDUPE_VARS=""$/m);
  });

  it("ALL THREE of ENV_VARS_ORCH / ENV_VARS_INVOKER / ENV_VARS_EVENTS carry it — one knob, three consumers", () => {
    const line = (name) => DEPLOY_SRC.match(new RegExp(`^${name}="Variables=.*$`, "m"))?.[0] || "";
    expect(line("ENV_VARS_ORCH")).toContain("${EVENT_DEDUPE_VARS}");
    expect(line("ENV_VARS_INVOKER")).toContain("${EVENT_DEDUPE_VARS}");
    expect(line("ENV_VARS_EVENTS")).toContain("${EVENT_DEDUPE_VARS}");
  });
});

// ── (c) code — all three consumers agree, and the two-arg contract holds ─────
describe("(c) index.mjs / agent-invoker.mjs / events-writer.mjs — all three consumers", () => {
  const CALL_RE = /const EVENT_DEDUPE_MODE = normalizeEventDedupeMode\(process\.env\.EVENT_DEDUPE_MODE, "enforce"\);/;

  it.each([
    ["index.mjs", () => INDEX_SRC],
    ["agent-invoker.mjs", () => INVOKER_SRC],
    ["events-writer.mjs", () => EVENTS_WRITER_SRC],
  ])("%s calls normalizeEventDedupeMode(process.env.EVENT_DEDUPE_MODE, \"enforce\")", (_name, getSrc) => {
    expect(getSrc()).toMatch(CALL_RE);
  });

  it("no single-arg legacy call survives in any of the three", () => {
    const singleArg = /normalizeEventDedupeMode\(process\.env\.EVENT_DEDUPE_MODE\)(?!,)/;
    expect(INDEX_SRC).not.toMatch(singleArg);
    expect(INVOKER_SRC).not.toMatch(singleArg);
    expect(EVENTS_WRITER_SRC).not.toMatch(singleArg);
  });

  it("unset/empty/garbage resolve to the default (enforce), matching the template Default", () => {
    for (const v of [undefined, "", "garbage"]) {
      expect(normalizeEventDedupeMode(v, "enforce")).toBe(EXPECTED_DEFAULT);
    }
    expect(normalizeEventDedupeMode(undefined, "enforce")).toBe(TEMPLATE.Parameters.EventDedupeMode.Default);
  });

  it("an explicit off still opts out (instant rollback)", () => {
    expect(normalizeEventDedupeMode("off", "enforce")).toBe("off");
  });

  it("the single-arg legacy default is UNCHANGED at off", () => {
    expect(normalizeEventDedupeMode(undefined)).toBe("off");
  });
});

// ── (d) .env.example — what the operator is told ─────────────────────────────
describe("(d) .env.example — one voice, and it says enforce", () => {
  it(`ships exactly one uncommented EVENT_DEDUPE_MODE=${EXPECTED_DEFAULT}`, () => {
    const live = ENV_EXAMPLE_SRC.split("\n").filter((l) => /^EVENT_DEDUPE_MODE=/.test(l));
    expect(live).toHaveLength(1);
    const value = live[0].match(/^EVENT_DEDUPE_MODE=(\S+)$/)?.[1];
    expect(value).not.toBe("off");
    expect(value).toBe(EXPECTED_DEFAULT);
    expect(value).toBe(TEMPLATE.Parameters.EventDedupeMode.Default);
  });

  it("leaves NO commented twin — the file cannot say two different things", () => {
    const commented = ENV_EXAMPLE_SRC.split("\n").filter((l) => /^#\s*EVENT_DEDUPE_MODE=/.test(l));
    expect(commented).toEqual([]);
  });

  it("the header agrees with the value — the header saying off while the value said on IS the finding", () => {
    expect(ENV_EXAMPLE_SRC).toContain(`(default ${EXPECTED_DEFAULT})`);
    expect(ENV_EXAMPLE_SRC).not.toContain("Events-table double-write collapse (default off)");
  });
});
