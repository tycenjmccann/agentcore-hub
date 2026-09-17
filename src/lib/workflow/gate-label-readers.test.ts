import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { GATE_KINDS, GATE_LABEL_RE, gateKindsOf } from "../../../lambda/orchestrator/fix-contract.mjs";
import { parseDecision } from "../../../lambda/orchestrator/review-cap.mjs";
import { gateSlug } from "./intake-materialize";
import workflowDefs from "../../config/workflows.json";

/**
 * TEAM-4739 — the `[:-]` duality table, in one place.
 *
 * A gate label exists in TWO spellings and they mean the SAME gate: agents write
 * the canonical `gate:deploy-approval` / `head:<sha>` / `exec:<uuid>`, and the
 * ticket Lambdas' sanitizeUserLabels rewrites `[^a-z0-9._-]` → `-`, storing
 * `gate-deploy-approval`. normalizeSystemLabel, used for system-written labels,
 * keeps the colon. So the same ticket can carry either form depending on who wrote
 * it, and EVERY reader in the system must accept both.
 *
 * A reader that sees only one spelling does not error — it silently classifies a
 * real deploy gate as an ordinary ticket: the guard admits an unproven close, or
 * the Telegram bridge pages with the wrong kicker (or not at all). This file is
 * the cross-surface table: fix-contract.mjs (the twins + orchestrator),
 * gate-contract.mjs (the twins' probe/verdict half), and the bridge's own
 * literals.
 *
 * It also pins two things that are easy to get wrong at the seams:
 *   - the DECISION grammars of review-cap.mjs and gate-contract.mjs share a SHAPE
 *     but not a VOCABULARY, and no single line may be authorization to both;
 *   - the human review gates intake materializes (`gate:<gateSlug(name)>`) must
 *     never collide with a typed gate kind, or a Design Approval ticket would
 *     start getting probed on close.
 */

const ROOT = resolve(__dirname, "../../..");

// The mocked Lambda client, so the PROBE_TOOLS allow-list can be shown to refuse
// BEFORE any InvokeCommand is constructed (SEC-3) rather than merely failing later.
const probeSpy = vi.hoisted(() => ({ clients: 0, commands: 0 }));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    constructor() {
      probeSpy.clients += 1;
    }
    async send() {
      throw new Error("no network in unit tests");
    }
  },
  InvokeCommand: class {
    input: unknown;
    constructor(input: unknown) {
      probeSpy.commands += 1;
      this.input = input;
    }
  },
}));

import {
  HEAD_LABEL_RE,
  EXEC_LABEL_RE,
  MERGE_GATE_LABEL_RE,
  gateHeadOf,
  gateExecOf,
  parseFixDecision,
  invokeProbe,
  PROBE_TOOLS,
} from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";

/**
 * The Telegram bridge's label readers are module-local `const`s, not exports, and
 * that file is owned by another work package — so the literals are read out of the
 * source rather than imported. Extracting them (instead of copying the patterns
 * here) is the point: a future edit to the bridge's regex is checked by this table.
 */
function bridgeRegex(name: string): RegExp {
  const src = readFileSync(resolve(ROOT, "deploy/telegram-bug-intake/index.mjs"), "utf8");
  const m = new RegExp(`^const ${name} = (/.*/)([gimsuy]*);`, "m").exec(src);
  if (!m) throw new Error(`${name} not found in deploy/telegram-bug-intake/index.mjs`);
  return new RegExp(m[1].slice(1, -1), m[2]);
}

const SHA = "e".repeat(40);
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("every gate-label reader accepts BOTH spellings", () => {
  // [reader name, matches?, colon form, hyphen form]
  const READERS: Array<[string, (label: string) => boolean, string, string]> = [
    [
      "fix-contract GATE_LABEL_RE",
      (l) => GATE_LABEL_RE.test(l),
      "gate:deploy-approval",
      "gate-deploy-approval",
    ],
    [
      "fix-contract gateKindsOf",
      (l) => gateKindsOf([l]).length > 0,
      "gate:ci-unavailable",
      "gate-ci-unavailable",
    ],
    ["gate-contract HEAD_LABEL_RE", (l) => HEAD_LABEL_RE.test(l), `head:${SHA}`, `head-${SHA}`],
    ["gate-contract EXEC_LABEL_RE", (l) => EXEC_LABEL_RE.test(l), `exec:${UUID}`, `exec-${UUID}`],
    [
      "gate-contract MERGE_GATE_LABEL_RE",
      (l) => MERGE_GATE_LABEL_RE.test(l),
      "gate:merge-approval",
      "gate-merge-approval",
    ],
    ["gate-contract gateHeadOf", (l) => gateHeadOf([l]) === SHA, `head:${SHA}`, `head-${SHA}`],
    ["gate-contract gateExecOf", (l) => gateExecOf([l]) === UUID, `exec:${UUID}`, `exec-${UUID}`],
    [
      "bridge DEPLOY_APPROVAL_LABEL_RE",
      (l) => bridgeRegex("DEPLOY_APPROVAL_LABEL_RE").test(l),
      "gate:deploy-approval",
      "gate-deploy-approval",
    ],
    [
      "bridge DEPLOY_PIPELINE_LABEL_RE",
      (l) => bridgeRegex("DEPLOY_PIPELINE_LABEL_RE").test(l),
      "pipeline:hub-x-deploy",
      "pipeline-hub-x-deploy",
    ],
    [
      "bridge DEPLOY_EXEC_LABEL_RE",
      (l) => bridgeRegex("DEPLOY_EXEC_LABEL_RE").test(l),
      `exec:${UUID}`,
      `exec-${UUID}`,
    ],
  ];

  it.each(READERS)("%s reads the colon and hyphen forms alike", (_name, reads, colon, hyphen) => {
    expect(reads(colon)).toBe(true);
    expect(reads(hyphen)).toBe(true);
  });

  it("every GATE_KINDS member is readable in both spellings", () => {
    for (const kind of GATE_KINDS) {
      expect(gateKindsOf([`gate:${kind}`]), `gate:${kind}`).toEqual([kind]);
      expect(gateKindsOf([`gate-${kind}`]), `gate-${kind}`).toEqual([kind]);
      expect(GATE_LABEL_RE.test(`gate:${kind}`)).toBe(true);
      expect(GATE_LABEL_RE.test(`gate-${kind}`)).toBe(true);
    }
  });

  it("neither spelling leaks into a neighbouring label", () => {
    for (const bad of [
      "gate",
      "gate:",
      "gate:blockers",
      "gateblocker",
      "gate_blocker",
      "not-gate:blocker",
      "gate:blocker ",
    ]) {
      expect(GATE_LABEL_RE.test(bad), bad).toBe(false);
    }
    // gateKindsOf trims, so the trailing-space form IS a gate for it — the readers
    // differ here on purpose: the regex is exact, the reader normalizes first.
    expect(gateKindsOf(["gate:blocker "])).toEqual(["blocker"]);
  });
});

describe("the human review gates intake materializes are NOT typed gate kinds", () => {
  // src/lib/workflow/intake-materialize.ts stamps `gate:${gateSlug(gate.name)}` on
  // every reviewGates ticket. If one of those slugs ever equalled a GATE_KINDS
  // member, a plain human approval ticket would be routed into the typed-gate
  // guard on close, get probed for a pipeline it was never bound to, and stall.
  const slugs = (() => {
    const out = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "reviewGates" && Array.isArray(v)) {
          for (const g of v) {
            const name = (g as { name?: string })?.name;
            if (name) out.add(gateSlug(name));
          }
        }
        walk(v);
      }
    };
    walk(workflowDefs);
    return [...out].sort();
  })();

  it("workflows.json actually declares review gates (the matrix is not empty)", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  it.each(slugs)("gate:%s is not a typed gate kind", (slug) => {
    expect(GATE_LABEL_RE.test(`gate:${slug}`)).toBe(false);
    expect(GATE_LABEL_RE.test(`gate-${slug}`)).toBe(false);
    expect(gateKindsOf([`gate:${slug}`])).toEqual([]);
  });

  it("the merge-approval reader is the ONE deliberate overlap with a review-gate slug", () => {
    // `Merge Approval` → `gate:merge-approval` is a review gate, and
    // MERGE_GATE_LABEL_RE exists precisely to recognize it — that is why the kind
    // is NOT in GATE_KINDS: recognizing it must not drag it into the probe guard.
    expect(slugs).toContain("merge-approval");
    expect(MERGE_GATE_LABEL_RE.test("gate:merge-approval")).toBe(true);
    expect(gateKindsOf(["gate:merge-approval"])).toEqual([]);
  });
});

describe("the two DECISION grammars share a shape but never an authorization", () => {
  // Same line shape (the LAST line that is nothing but `DECISION: <option>`), two
  // disjoint vocabularies: review-cap.mjs decides a REVIEW escalation
  // (continue | merge-with-known-findings | cancel), gate-contract.mjs decides an
  // ENVIRONMENTAL gate stall (repaired | accept-proxy | abort). No single LINE may
  // be authorization to both, or a human answering one question would silently be
  // answering the other.
  const LINES: string[] = [
    "DECISION: continue",
    "DECISION: merge-with-known-findings",
    "DECISION: cancel",
    "DECISION: repaired",
    "DECISION: accept-proxy",
    "DECISION: abort",
    "decision: ABORT.",
    "- **DECISION: repaired**",
    "**DECISION: cancel**",
    "> DECISION: cancel",
    "DECISION: ship-it",
    "DECISION:",
    "the options are DECISION: abort or DECISION: repaired",
    "",
  ];

  it.each(LINES)("no single line is non-null through both parsers: %j", (line) => {
    expect(line.includes("\n"), "this table is per-LINE by construction").toBe(false);
    const review = parseDecision(line);
    const gate = parseFixDecision(line);
    expect(review !== null && gate !== null, `${line} authorized BOTH`).toBe(false);
  });

  it("a description carrying one line of EACH answers each question separately", () => {
    // Not a collision: the two DECISIONs are answers to two different questions,
    // read off two different tickets by two different callers. What must never
    // happen is one LINE meaning both — hence the per-line table above.
    const both = "DECISION: continue\nDECISION: abort";
    expect(parseDecision(both)).toBe("continue");
    expect(parseFixDecision(both)).toBe("abort");
  });

  it("each vocabulary is invisible to the other parser", () => {
    for (const opt of ["continue", "merge-with-known-findings", "cancel"]) {
      expect(parseDecision(`DECISION: ${opt}`)).toBe(opt);
      expect(parseFixDecision(`DECISION: ${opt}`)).toBeNull();
    }
    for (const opt of ["repaired", "accept-proxy", "abort"]) {
      expect(parseFixDecision(`DECISION: ${opt}`)).toBe(opt);
      expect(parseDecision(`DECISION: ${opt}`)).toBeNull();
    }
  });

  it("gate-contract is STRICTER than review-cap on quoted and fenced lines", () => {
    // review-cap tolerates a blockquote on purpose (`[\s>*-]*`) — a human replying
    // inline in Jira. A gate DECISION is read off a ticket DESCRIPTION, where a
    // quoted or fenced line is far more likely to be the options being echoed
    // back, or documentation of the syntax, than an instruction.
    expect(parseDecision("> DECISION: cancel")).toBe("cancel");
    expect(parseFixDecision("> DECISION: abort")).toBeNull();
    expect(parseFixDecision(">> DECISION: abort")).toBeNull();
    expect(parseFixDecision("```\nDECISION: abort\n```")).toBeNull();
    expect(parseFixDecision("~~~\nDECISION: abort\n~~~")).toBeNull();
    // …and an unquoted, unfenced line still counts, including after a fenced example.
    expect(parseFixDecision("```\nDECISION: abort\n```\n\nDECISION: repaired")).toBe("repaired");
  });
});

describe("PROBE_TOOLS refuses before it invokes", () => {
  it("a disallowed tool never constructs a client or a command", async () => {
    probeSpy.clients = 0;
    probeSpy.commands = 0;
    for (const tool of [
      "Pipeline___start_deploy",
      "Pipeline___start_ci_build",
      "Tickets___transition_ticket",
      "",
      "pipeline___get_state", // case matters: the allow-list is exact
    ]) {
      expect(await invokeProbe("some-fn", tool, {})).toEqual({
        ok: false,
        indeterminate: true,
        error: "tool_not_allowed",
      });
    }
    expect(probeSpy.clients, "a refused tool must not construct a Lambda client").toBe(0);
    expect(probeSpy.commands, "a refused tool must not construct an InvokeCommand").toBe(0);
  });

  it("an allow-listed tool DOES invoke — and a throw is indeterminate, not a verdict", async () => {
    probeSpy.clients = 0;
    probeSpy.commands = 0;
    const res = await invokeProbe("some-fn", PROBE_TOOLS[0], { pipeline_name: "hub-x-deploy" });
    expect(probeSpy.commands).toBe(1);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ indeterminate: true });
    // The fail direction: an unreachable probe can only ever ADMIT the close
    // (recorded as gateVerification:"indeterminate"), never refuse it.
    expect("result" in res).toBe(false);
  });
});
