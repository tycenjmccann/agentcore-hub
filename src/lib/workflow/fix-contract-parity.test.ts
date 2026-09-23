import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The three copies of the fix-ticket contract (TEAM-4121 FR-8). Each ticket
// Lambda and the orchestrator ship as a self-contained zip, so they CANNOT share
// a file — the module is duplicated byte-for-byte instead.
import * as ticketsCopy from "../../../lambda/agentcore-hub-tickets/fix-contract.mjs";
import * as jiraCopy from "../../../lambda/agentcore-hub-jira/fix-contract.mjs";
import * as orchestratorCopy from "../../../lambda/orchestrator/fix-contract.mjs";

/**
 * TEAM-4121 FR-8 parity contract — same shape as lease-parity.test.ts.
 *
 * A drift between these three copies is not a cosmetic problem: the DynamoDB
 * tickets Lambda decides whether a fix ticket may be FILED, the jira Lambda
 * decides what LABELS + description block it carries, and the orchestrator
 * decides what it READS BACK. If the copies disagree, a fix ticket can be
 * accepted by one provider and rejected by the other, or written in a form the
 * orchestrator can no longer parse — which silently reopens the completion-gate
 * hole the contract exists to close.
 *
 * Two guards, deliberately layered:
 *   1. byte-equality of the files (what CI's check-fix-kinds-parity.sh also does,
 *      repeated here so `npm run test:unit` alone catches a stale `cp`);
 *   2. a behavioural matrix pushed through all THREE imports asserting identical
 *      outputs — so an edit that keeps the files equal but breaks a contract
 *      (e.g. a regex that no longer rejects a shell-composed repro) still fails
 *      on the assertions rather than on a diff.
 */

const COPIES = [
  "lambda/agentcore-hub-tickets/fix-contract.mjs",
  "lambda/agentcore-hub-jira/fix-contract.mjs",
  "lambda/orchestrator/fix-contract.mjs",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODULES: Array<[string, any]> = [
  ["tickets", ticketsCopy],
  ["jira", jiraCopy],
  ["orchestrator", orchestratorCopy],
];

/** Run `fn` through all three copies and assert every result is identical. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function agree(label: string, fn: (m: any) => unknown): unknown {
  const [[, first]] = MODULES;
  const expected = fn(first);
  for (const [name, mod] of MODULES.slice(1)) {
    expect(fn(mod), `${name} disagrees with tickets on: ${label}`).toEqual(expected);
  }
  return expected;
}

describe("fix-contract.mjs — the three copies are byte-identical", () => {
  it("every copy matches the first, byte for byte", () => {
    const root = resolve(__dirname, "../../..");
    const [firstPath, ...rest] = COPIES;
    const first = readFileSync(resolve(root, firstPath));
    expect(first.length).toBeGreaterThan(0);
    for (const p of rest) {
      const other = readFileSync(resolve(root, p));
      expect(
        other.equals(first),
        `${p} has drifted from ${firstPath} — edit one copy, then \`cp\` it over the other two`
      ).toBe(true);
    }
  });
});

describe("normalizeContractMode — the fail-safe direction", () => {
  it("unset/blank → off (a fresh deploy changes nothing)", () => {
    expect(agree("undefined", (m) => m.normalizeContractMode(undefined))).toBe("off");
    expect(agree("null", (m) => m.normalizeContractMode(null))).toBe("off");
    expect(agree("empty", (m) => m.normalizeContractMode(""))).toBe("off");
    expect(agree("blank", (m) => m.normalizeContractMode("   "))).toBe("off");
  });

  it("known values are case/whitespace tolerant", () => {
    expect(agree("Enforce ", (m) => m.normalizeContractMode("Enforce "))).toBe("enforce");
    expect(agree("shadow", (m) => m.normalizeContractMode("shadow"))).toBe("shadow");
    expect(agree("OFF", (m) => m.normalizeContractMode("OFF"))).toBe("off");
  });

  it("a garbage value coerces to SHADOW, not off", () => {
    // The INVERSE of the ship/gate guards' allow-list: there, acting on bad state
    // is the dangerous failure, so they fall to off. Here the dangerous failure
    // is refusing to file fix tickets at all, and shadow validates + accepts.
    expect(agree("on", (m) => m.normalizeContractMode("on"))).toBe("shadow");
    expect(agree("true", (m) => m.normalizeContractMode("true"))).toBe("shadow");
    expect(agree("1", (m) => m.normalizeContractMode(1))).toBe("shadow");
  });
});

describe("validateFixContract — identical verdicts across all three copies", () => {
  const COMPLETE = {
    spawnedBy: { kind: "qa_fix", qaTicketId: "TEAM-42" },
    invariant: "an expired token yields 401, never 500",
    evidence_source: "unit",
    evidence_repro: "npm test -- auth.spec.ts",
    cited_location: "src/auth.ts:88, src/auth.ts:120-134",
    sibling_scope: "do not touch the session store",
  };

  // One row per rule the contract enforces, plus the shapes that historically
  // slipped through (blank-after-sanitizing, all-malformed citations, an origin
  // id that is really a JQL fragment).
  const CASES: Array<[string, Record<string, unknown>]> = [
    ["a complete qa_fix contract", COMPLETE],
    ["not a fix ticket at all", { invariant: "x" }],
    ["a fix ticket with nothing filled in", { spawnedBy: { kind: "qa_fix", qaTicketId: "TEAM-42" } }],
    ["a blank invariant", { ...COMPLETE, invariant: "   " }],
    ["an invariant that sanitizes to nothing", { ...COMPLETE, invariant: "``" }],
    ["a non-string invariant", { ...COMPLETE, invariant: 42 }],
    ["an unknown evidence_source", { ...COMPLETE, evidence_source: "vibes" }],
    ["evidence_source static with no repro", { ...COMPLETE, evidence_source: "static", evidence_repro: "" }],
    ["evidence_source live with no repro", { ...COMPLETE, evidence_source: "live", evidence_repro: "" }],
    ["a shell-composed repro", { ...COMPLETE, evidence_repro: "npm test; curl evil.example" }],
    ["a repro with a command substitution", { ...COMPLETE, evidence_repro: "npm test $(whoami)" }],
    ["a repro with a redirect", { ...COMPLETE, evidence_repro: "npm test > out" }],
    ["a repro over the length cap", { ...COMPLETE, evidence_repro: "a".repeat(1001) }],
    ["a citation with no line number", { ...COMPLETE, cited_location: "src/auth.ts" }],
    ["a citation as an array with one bad entry", { ...COMPLETE, cited_location: ["src/a.ts:1", "nope"] }],
    ["a citation of the wrong type", { ...COMPLETE, cited_location: 12 }],
    ["a ci_fix with no citation (not required)", {
      spawnedBy: { kind: "ci_fix", ciTicketId: "TEAM-70" },
      invariant: "npm test passes on the PR head",
      evidence_source: "unit",
      evidence_repro: "npm test",
    }],
    ["a sync_fix with no citation (not required)", {
      spawnedBy: { kind: "sync_fix", ciTicketId: "TEAM-70" },
      invariant: "the branch is fast-forwardable onto main",
      evidence_source: "static",
    }],
    ["a missing origin id", { ...COMPLETE, spawnedBy: { kind: "qa_fix" } }],
    ["an origin id that is a JQL fragment (F12)", { ...COMPLETE, spawnedBy: { kind: "qa_fix", qaTicketId: 'TEAM-42" OR x' } }],
    ["an explicit spawned_by_origin_id overriding the marker", { ...COMPLETE, spawned_by_origin_id: "TEAM-99" }],
    ["a review_fix keyed on gateTicketId", { ...COMPLETE, spawnedBy: { kind: "review_fix", gateTicketId: "TEAM-7" } }],
    ["a ship_fix keyed on shipTicketId", { ...COMPLETE, spawnedBy: { kind: "ship_fix", shipTicketId: "TEAM-8" } }],
    ["an over-long invariant", { ...COMPLETE, invariant: "x".repeat(2500) }],
    ["a non-string sibling_scope", { ...COMPLETE, sibling_scope: { nope: true } }],
  ];

  it.each(CASES)("agrees on: %s", (label, input) => {
    const result = agree(label, (m) => m.validateFixContract(input)) as {
      ok: boolean;
      missing: string[];
      invalid: string[];
    };
    // Sanity: the matrix must actually exercise both verdicts (a copy that
    // returned {ok:true} for everything would otherwise "agree" trivially).
    expect(typeof result.ok).toBe("boolean");
  });

  it("the matrix covers both verdicts and every reported field", () => {
    const verdicts = new Set<boolean>();
    const problems = new Set<string>();
    for (const [, input] of CASES) {
      const r = ticketsCopy.validateFixContract(input);
      verdicts.add(r.ok);
      for (const f of [...r.missing, ...r.invalid]) problems.add(f);
    }
    expect([...verdicts].sort()).toEqual([false, true]);
    expect([...problems].sort()).toEqual([
      "cited_location",
      "evidence_repro",
      "evidence_source",
      "invariant",
      "sibling_scope",
      "spawned_by_origin_id",
    ]);
  });
});

describe("renderFixContractBlock → parseFixContractBlock round-trips identically", () => {
  const CONTRACTS: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      "a full contract",
      {
        version: 1,
        invariant: "an expired token yields 401, never 500",
        evidenceSource: "live",
        evidenceRepro: "curl -H 'Authorization: Bearer expired' /api/me",
        citedLocation: ["src/auth.ts:88", "src/auth.ts:120-134"],
        siblingScope: "do not touch the session store",
      },
      { kind: "ship_fix", originId: "TEAM-50", phase: "ship" },
    ],
    [
      "invariant only (what shadow mode persists)",
      { version: 1, invariant: "the retry budget is never negative", evidenceSource: null, evidenceRepro: null, citedLocation: [], siblingScope: null },
      { kind: "qa_fix", originId: "TEAM-42", phase: "verification" },
    ],
    [
      "no meta at all",
      { version: 1, invariant: "x", evidenceSource: "static", evidenceRepro: null, citedLocation: ["a.ts:1"], siblingScope: null },
      {},
    ],
    [
      "a multi-line invariant (the only field allowed to span lines)",
      { version: 1, invariant: "line one\nline two", evidenceSource: "unit", evidenceRepro: "npm test", citedLocation: [], siblingScope: null },
      { kind: "ci_fix", originId: "TEAM-70", phase: "development" },
    ],
  ];

  it.each(CONTRACTS)("round-trips: %s", (label, contract, meta) => {
    const rendered = agree(`render ${label}`, (m) => m.renderFixContractBlock(contract, meta)) as string;
    expect(rendered.startsWith("# fix-contract v1")).toBe(true);
    expect(rendered.endsWith("# /fix-contract")).toBe(true);

    // The block is what actually ships in a Jira description: a prose body
    // follows it, and the parse must hand that back untouched as `rest`.
    const prose = "The final diff regresses the expired-token path.";
    const parsed = agree(`parse ${label}`, (m) => m.parseFixContractBlock(`${rendered}\n${prose}`)) as {
      contract: Record<string, unknown>;
      kind: string | null;
      originId: string | null;
      phase: string | null;
      rest: string;
    };
    expect(parsed.rest).toBe(prose);
    expect(parsed.kind).toBe(meta.kind ?? null);
    expect(parsed.originId).toBe(meta.originId ?? null);
    expect(parsed.phase).toBe(meta.phase ?? null);
    expect(parsed.contract.evidenceSource).toBe(contract.evidenceSource ?? null);
    expect(parsed.contract.evidenceRepro).toBe(contract.evidenceRepro ?? null);
    expect(parsed.contract.citedLocation).toEqual(contract.citedLocation);
    expect(parsed.contract.siblingScope).toBe(contract.siblingScope ?? null);
    expect(parsed.contract.invariant).toBe(contract.invariant);
  });

  it("agrees on text that is NOT a contract block", () => {
    expect(agree("plain prose", (m) => m.parseFixContractBlock("just a description"))).toBeNull();
    expect(agree("non-string", (m) => m.parseFixContractBlock(null))).toBeNull();
    expect(
      agree("unterminated", (m) => m.parseFixContractBlock("# fix-contract v1\nkind: qa_fix\n"))
    ).toBeNull();
    expect(agree("empty contract", (m) => m.renderFixContractBlock(null))).toBe("");
  });
});

describe("contractLabels / sanitizeUserLabels / escapeJql agree across copies", () => {
  it("contractLabels emits the same index for the same contract", () => {
    expect(
      agree("full", (m) =>
        m.contractLabels({ evidenceSource: "live" }, { kind: "ship_fix", originId: "TEAM-50", phase: "ship" })
      )
    ).toEqual(["fix:ship_fix", "origin:TEAM-50", "evidence:live", "phase:ship"]);

    expect(
      agree("incomplete", (m) => m.contractLabels(null, { kind: "qa_fix", phase: "verification", incomplete: true }))
    ).toEqual(["fix:qa_fix", "phase:verification", "contract:incomplete"]);

    expect(agree("nothing", (m) => m.contractLabels(null, {}))).toEqual([]);
  });

  it("sanitizeUserLabels drops the same system namespaces and normalizes the same way", () => {
    expect(
      agree("mixed", (m) => m.sanitizeUserLabels("advisory, FIX:qa_fix, wf:run1, needs docs, advisory, human-review"))
    ).toEqual({
      labels: ["advisory", "needs-docs"],
      dropped: ["fix:qa_fix", "wf:run1", "human-review"],
    });
    expect(agree("array form", (m) => m.sanitizeUserLabels(["ok", 7, null, "  "]))).toEqual({
      labels: ["ok"],
      dropped: ["7"],
    });
    expect(agree("absent", (m) => m.sanitizeUserLabels(undefined))).toEqual({ labels: [], dropped: [] });
  });

  it("escapeJql escapes the backslash before the quote in every copy", () => {
    expect(agree("both", (m) => m.escapeJql('a"b\\c'))).toBe('a\\"b\\\\c');
    expect(agree("injection attempt", (m) => m.escapeJql('x" OR project = OTHER'))).toBe(
      'x\\" OR project = OTHER'
    );
    expect(agree("nullish", (m) => m.escapeJql(undefined))).toBe("");
  });

  it("sanitizeSpawnedBy keeps the same allow-list and the same F12 shape check", () => {
    expect(
      agree("full marker", (m) =>
        m.sanitizeSpawnedBy({
          kind: "qa_fix",
          qaTicketId: "TEAM-42",
          reverify: 1,
          rearmOf: "TEAM-9",
          headSha: "a1b2c3d",
          evil: "'; DROP TABLE",
        })
      )
    ).toEqual({
      value: { kind: "qa_fix", qaTicketId: "TEAM-42", reverify: true, rearmOf: "TEAM-9", headSha: "a1b2c3d" },
      error: null,
    });
    expect(agree("bad origin shape", (m) => m.sanitizeSpawnedBy({ kind: "qa_fix", qaTicketId: "TEAM-42 OR 1=1" }))).toEqual({
      value: { kind: "qa_fix" },
      error: null,
    });
    expect(agree("absent", (m) => m.sanitizeSpawnedBy(undefined))).toEqual({ value: null, error: null });
    const unknownKind = agree("unknown kind", (m) => m.sanitizeSpawnedBy({ kind: "nope" })) as { error: string };
    expect(unknownKind.error).toContain("spawned_by.kind");
  });

  it("the GATE kinds agree, and gateKindsOf reads both label spellings (TEAM-4739)", () => {
    expect(agree("GATE_KINDS", (m) => m.GATE_KINDS)).toEqual([
      "approval",
      "deploy-approval",
      "blocker",
      "ci-unavailable",
      "awaiting-console",
      "loop-broken",
    ]);

    // Agents write `gate:x`; sanitizeUserLabels rewrites it to `gate-x`. Both are
    // the SAME gate, and every reader in the system is /^gate[:-]…$/ for that
    // reason — a reader that saw only one spelling would let a gate close unchecked.
    expect(agree("colon", (m) => m.gateKindsOf(["gate:deploy-approval"]))).toEqual([
      "deploy-approval",
    ]);
    expect(agree("hyphen", (m) => m.gateKindsOf(["gate-deploy-approval"]))).toEqual([
      "deploy-approval",
    ]);
    // Deduped, and always in GATE_KINDS order regardless of label order.
    expect(
      agree("both spellings + order", (m) =>
        m.gateKindsOf(["gate-blocker", "GATE:APPROVAL", "gate:blocker"])
      )
    ).toEqual(["approval", "blocker"]);
    expect(agree("string form", (m) => m.gateKindsOf("gate:blocker, needs-docs"))).toEqual([
      "blocker",
    ]);

    // Not gate kinds: the human review gates intake materializes (`gate:<slug>`
    // from a reviewGates entry) must NOT be swept into the typed-gate guard.
    expect(agree("review gate slug", (m) => m.gateKindsOf(["gate:merge-approval"]))).toEqual([]);
    expect(agree("prefixed", (m) => m.gateKindsOf(["gate:approval-2", "xgate:approval"]))).toEqual([]);
    expect(agree("empty", (m) => m.gateKindsOf(undefined))).toEqual([]);
    expect(agree("junk", (m) => m.gateKindsOf([null, 7, "  "]))).toEqual([]);
  });

  it("labelList normalizes a label list one way for every reader (TEAM-4987)", () => {
    // The ONE spelling of "what a label list is": array or comma-joined string in,
    // trimmed + lowercased, blanks dropped. gateKindsOf, the binding readers and
    // gate-contract's own gatePipelineOf all go through it, so a label that one
    // reader sees is a label they ALL see.
    expect(agree("array", (m) => m.labelList([" Gate:Approval ", "x"]))).toEqual([
      "gate:approval",
      "x",
    ]);
    expect(agree("string", (m) => m.labelList("a, B ,, c"))).toEqual(["a", "b", "c"]);
    expect(agree("junk", (m) => m.labelList([null, undefined, "  ", 7]))).toEqual(["7"]);
    expect(agree("absent", (m) => m.labelList(undefined))).toEqual([]);
  });

  describe("gate BINDINGS — what a gate is about, not just what kind it is (TEAM-4987)", () => {
    const EXEC_A = "11111111-2222-3333-4444-555555555555";
    const EXEC_B = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const HEAD_A = "a".repeat(40);
    const HEAD_B = "b".repeat(40);
    const deploy = (labels: string[], blockedBy?: string[]) => ({
      labels: ["gate:deploy-approval", ...labels],
      ...(blockedBy ? { blockedBy } : {}),
    });
    const blocker = (labels: string[] = [], blockedBy?: string[]) => ({
      labels: ["gate:blocker", ...labels],
      ...(blockedBy ? { blockedBy } : {}),
    });

    it("gateHeadOf / gateExecOf read both spellings, lowercase, first match wins", () => {
      expect(agree("exec colon", (m) => m.gateExecOf([`exec:${EXEC_A}`]))).toBe(EXEC_A);
      expect(agree("exec hyphen + case", (m) => m.gateExecOf([`exec-${EXEC_A.toUpperCase()}`]))).toBe(
        EXEC_A
      );
      expect(agree("exec string form", (m) => m.gateExecOf(`gate:deploy-approval, exec:${EXEC_A}`))).toBe(
        EXEC_A
      );
      expect(agree("exec first of two", (m) => m.gateExecOf([`exec:${EXEC_A}`, `exec:${EXEC_B}`]))).toBe(
        EXEC_A
      );
      expect(agree("no exec", (m) => m.gateExecOf(["gate:deploy-approval"]))).toBeNull();
      expect(agree("head colon", (m) => m.gateHeadOf([`head:${HEAD_A.toUpperCase()}`]))).toBe(HEAD_A);
      expect(agree("head hyphen", (m) => m.gateHeadOf([`head-${HEAD_A}`]))).toBe(HEAD_A);
      // 40 hex exactly — a short SHA is not a binding.
      expect(agree("short sha", (m) => m.gateHeadOf(["head:abc1234"]))).toBeNull();
      expect(agree("no head", (m) => m.gateHeadOf(undefined))).toBeNull();
    });

    it("a deploy gate is bound to its exec: and to NOTHING else", () => {
      const same = (m: { sameGateBinding: (k: string, a: unknown, b: unknown) => boolean }) =>
        m.sameGateBinding;
      expect(
        agree("same exec", (m) =>
          same(m)("deploy-approval", deploy([`exec:${EXEC_A}`]), deploy([`exec-${EXEC_A}`]))
        )
      ).toBe(true);
      // The wf_bug_TEAM-4798 shape: two executions, two decisions, not a re-file.
      expect(
        agree("different exec", (m) =>
          same(m)("deploy-approval", deploy([`exec:${EXEC_A}`]), deploy([`exec:${EXEC_B}`]))
        )
      ).toBe(false);
      expect(
        agree("one side unbound", (m) => same(m)("deploy-approval", deploy([`exec:${EXEC_A}`]), deploy([])))
      ).toBe(false);
      expect(agree("both unbound", (m) => same(m)("deploy-approval", deploy([]), deploy([])))).toBe(false);
      // A shared head or blocker is NOT a deploy binding — four CD follow-ups off
      // one merge commit share a head while approving four different executions.
      expect(
        agree("shared head does not bind a deploy gate", (m) =>
          same(m)(
            "deploy-approval",
            deploy([`head:${HEAD_A}`, `exec:${EXEC_A}`], ["TEAM-9"]),
            deploy([`head:${HEAD_A}`, `exec:${EXEC_B}`], ["TEAM-9"])
          )
        )
      ).toBe(false);
    });

    it("every other kind is bound by head: when both carry one, else by blocked_by", () => {
      const same = (m: { sameGateBinding: (k: string, a: unknown, b: unknown) => boolean }) =>
        m.sameGateBinding;
      expect(
        agree("same head", (m) => same(m)("blocker", blocker([`head:${HEAD_A}`]), blocker([`head-${HEAD_A}`])))
      ).toBe(true);
      expect(
        agree("different head", (m) =>
          same(m)("blocker", blocker([`head:${HEAD_A}`]), blocker([`head:${HEAD_B}`]))
        )
      ).toBe(false);
      // Head on one side only → it cannot decide; fall through to blocked_by.
      expect(
        agree("head one side, blockers overlap", (m) =>
          same(m)("blocker", blocker([`head:${HEAD_A}`], ["TEAM-9"]), blocker([], ["TEAM-9", "TEAM-8"]))
        )
      ).toBe(true);
      expect(
        agree("blockers overlap", (m) =>
          same(m)("ci-unavailable", { labels: ["gate:ci-unavailable"], blockedBy: "TEAM-9, TEAM-8" },
            { labels: ["gate:ci-unavailable"], blockedBy: ["team-8"] })
        )
      ).toBe(true);
      expect(
        agree("blockers disjoint", (m) => same(m)("blocker", blocker([], ["TEAM-9"]), blocker([], ["TEAM-7"])))
      ).toBe(false);
      expect(agree("no binding at all", (m) => same(m)("blocker", blocker(), blocker()))).toBe(false);
    });

    it("sameGateBinding is symmetric, and an unknown kind never binds", () => {
      const same = (m: { sameGateBinding: (k: string, a: unknown, b: unknown) => boolean }) =>
        m.sameGateBinding;
      const a = deploy([`exec:${EXEC_A}`]);
      const b = deploy([`exec:${EXEC_A}`]);
      expect(agree("a,b", (m) => same(m)("deploy-approval", a, b))).toBe(
        agree("b,a", (m) => same(m)("deploy-approval", b, a))
      );
      expect(agree("unknown kind", (m) => same(m)("nope", a, b))).toBe(false);
      expect(agree("blank kind", (m) => same(m)("  ", a, b))).toBe(false);
      expect(agree("undefined kind", (m) => same(m)(undefined, a, b))).toBe(false);
    });

    it("gateRefileBindingMatches is the whole rule — deploy-approval governs alone", () => {
      // A real deploy gate carries BOTH `gate:approval` and `gate:deploy-approval`.
      // Letting the generic kind vote too would re-admit the bug through a shared
      // head or blocked_by while the executions differ, so the most-specific kind
      // wins — the same precedence probedGateKindOf applies in the twins.
      const withBoth = (exec: string) => ({
        labels: ["gate:approval", "gate:deploy-approval", `head:${HEAD_A}`, `exec:${exec}`],
        blockedBy: ["TEAM-9"],
      });
      expect(agree("precedence", (m) => m.gateRefileBindingMatches(withBoth(EXEC_A), withBoth(EXEC_B)))).toBe(
        false
      );
      expect(agree("precedence same exec", (m) =>
        m.gateRefileBindingMatches(withBoth(EXEC_A), withBoth(EXEC_A))
      )).toBe(true);
      // No shared kind is no re-file, however well the bindings line up.
      expect(
        agree("no shared kind", (m) =>
          m.gateRefileBindingMatches(blocker([`head:${HEAD_A}`]), {
            labels: ["gate:ci-unavailable", `head:${HEAD_A}`],
          })
        )
      ).toBe(false);
      // And kind alone, with nothing bound, is never a re-file — TEAM-4987 itself.
      expect(
        agree("kind alone", (m) =>
          m.gateRefileBindingMatches({ labels: ["gate:deploy-approval"] }, { labels: ["gate:deploy-approval"] })
        )
      ).toBe(false);
      expect(agree("non-gate rows", (m) => m.gateRefileBindingMatches({}, {}))).toBe(false);
    });
  });

  it("does NOT export the twin-only gate contract (gate-contract.mjs is not here)", () => {
    // fix-contract.mjs is import-free and lives in THREE zips; the probe/journey/
    // console-link half of the gate contract does I/O and lives only in the two
    // ticket Lambdas. Keeping the split explicit stops the orchestrator from
    // growing a probe seam by accident (DL-009).
    for (const [name, mod] of MODULES) {
      for (const forbidden of ["invokeProbe", "publishJourneyEvent", "consoleApprovalUrl", "gateLoopVerdict"]) {
        expect(mod[forbidden], `${name} should not export ${forbidden}`).toBeUndefined();
      }
    }
  });

  it("the kind lists themselves agree (the parity guard's subject)", () => {
    expect(agree("FIX_KINDS", (m) => m.FIX_KINDS)).toEqual([
      "review_fix",
      "qa_fix",
      "codex_fix",
      "ship_fix",
      "ci_fix",
      "sync_fix",
    ]);
    expect(agree("REWORK_FIX_KINDS", (m) => m.REWORK_FIX_KINDS)).toEqual([
      "review_fix",
      "qa_fix",
      "codex_fix",
      "ship_fix",
    ]);
    // Every kind has an origin key, and the environmental pair shares one.
    expect(agree("KIND_TO_ORIGIN_KEY", (m) => m.KIND_TO_ORIGIN_KEY)).toEqual({
      review_fix: "gateTicketId",
      qa_fix: "qaTicketId",
      codex_fix: "codexTicketId",
      ship_fix: "shipTicketId",
      ci_fix: "ciTicketId",
      sync_fix: "ciTicketId",
    });
  });
});
