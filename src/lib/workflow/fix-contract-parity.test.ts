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
