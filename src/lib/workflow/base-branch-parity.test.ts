import { describe, it, expect } from "vitest";

// The two ticket twins, imported directly. Both modules are import-side-effect
// free (they only read env and construct AWS clients), which is what lets a
// vitest .ts file hold BOTH providers to the same contract in one process — the
// same trick fix-contract-parity.test.ts uses on the three fix-contract copies.
import * as tickets from "../../../lambda/agentcore-hub-tickets/index.mjs";
import * as jira from "../../../lambda/agentcore-hub-jira/index.mjs";

/**
 * TEAM-4740 FR-12 parity contract — `base_branch` across the twins.
 *
 * A ticket filed mid-run with no branch identity inherits whatever branch its
 * assignee happens to be on; while a Merge Approval gate is open that is the
 * integration branch the merge is about to supersede, so the work evaporates
 * with it (run p5ogpg / TEAM-4663). `base_branch` is the fix, and it has to mean
 * the SAME thing under either ticket backend:
 *
 *   1. the same branch names are accepted and refused (a ticket that is legal in
 *      DynamoDB mode must be legal in Jira mode, or the same agent call fails
 *      depending on which provider is deployed);
 *   2. the refusal TEXT is byte-identical, because it is the only thing the agent
 *      reads to correct itself — the delivery differs (tickets returns
 *      `Error: <body>` in a textResult, jira throws `<body>`) but the body must
 *      not;
 *   3. the `base_branch: <name>` DESCRIPTION line is byte-identical and matches
 *      the parser workflow-output's FR-5 refusal will use — that line is the only
 *      carrier that survives Tickets___get_issue in BOTH providers (it returns
 *      neither a `baseBranch` field nor labels), so a wording change in either
 *      twin must fail CI rather than silently disable the refusal.
 *
 * Layered like fix-contract-parity.test.ts: identity of the exported primitives
 * first, then a behavioural matrix pushed through both modules — so an edit that
 * keeps the two in agreement but breaks the contract still fails on assertions.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TWINS: Array<[string, any]> = [
  ["tickets", tickets],
  ["jira", jira],
];

/** Run `fn` through both twins and assert the results are identical. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function agree(label: string, fn: (m: any) => unknown): unknown {
  const expected = fn(TWINS[0][1]);
  for (const [name, mod] of TWINS.slice(1)) {
    expect(fn(mod), `${name} disagrees with tickets on: ${label}`).toEqual(expected);
  }
  return expected;
}

// The accept matrix: real branch names the pipeline actually uses.
const ACCEPT = [
  "main",
  "feature/TEAM-4734--si-x",
  "release/1.2.3",
  "hotfix_x.y",
];

// The reject matrix, one entry per rule in the pattern. `--upload-pack=x` is the
// argument-injection shape a branch name must never be able to take.
const REJECT: Array<[string, string]> = [
  ["-main", "leading dash is an argument, not a ref"],
  ["/main", "leading slash"],
  ["feature/../main", ".. anywhere"],
  ["feature//main", "// anywhere"],
  ["main@{1}", "@{ is a reflog selector"],
  ["main.lock", ".lock suffix is git's own ref lock"],
  ["feature/", "trailing slash"],
  ["main.", "trailing dot"],
  ["a".repeat(121), "121 characters"],
  ["a b", "whitespace"],
  ["--upload-pack=x", "argument injection"],
];

describe("BASE_BRANCH_RE — one pattern, both twins", () => {
  it("is the identical source in both twins", () => {
    expect(jira.BASE_BRANCH_RE.source).toBe(tickets.BASE_BRANCH_RE.source);
    expect(jira.BASE_BRANCH_RE.flags).toBe(tickets.BASE_BRANCH_RE.flags);
  });

  it.each(ACCEPT)("accepts %s in both twins", (name) => {
    for (const [label, mod] of TWINS) {
      expect(mod.BASE_BRANCH_RE.test(name), `${label} rejected ${name}`).toBe(true);
      expect(mod.validateBaseBranch(name)).toEqual({ ok: true, value: name });
    }
  });

  it.each(REJECT)("rejects %s (%s) in both twins", (name, why) => {
    for (const [label, mod] of TWINS) {
      expect(mod.BASE_BRANCH_RE.test(name), `${label} accepted ${name} (${why})`).toBe(false);
      expect(mod.validateBaseBranch(name)).toEqual({ ok: false, value: null });
    }
  });

  it("treats absent/empty as 'no branch stated', not as an error", () => {
    // The pre-feature ticket: nothing stated, nothing refused, nothing stored.
    for (const v of [undefined, null, "", "   ", 42]) {
      expect(agree(`validateBaseBranch(${JSON.stringify(v)})`, (m) => m.validateBaseBranch(v)))
        .toEqual({ ok: true, value: null });
    }
  });

  it("trims before validating, so a stated branch is stored canonically", () => {
    expect(agree("padded", (m) => m.validateBaseBranch("  main  "))).toEqual({
      ok: true,
      value: "main",
    });
  });
});

describe("baseBranchRefusal — byte-identical body, per-twin delivery", () => {
  it.each(["-main", "a b", ""])("is byte-identical for %j", (value) => {
    const t = tickets.baseBranchRefusal(value);
    const j = jira.baseBranchRefusal(value);
    expect(typeof t).toBe("string");
    expect(t.length).toBeGreaterThan(0);
    // Byte-for-byte, not merely equal-ish: this string is the agent's only
    // instruction for how to retry.
    expect(Buffer.from(j, "utf8").equals(Buffer.from(t, "utf8"))).toBe(true);
  });

  it("quotes the offending value and names the field, so a retry is possible", () => {
    const body = agree("refusal(-main)", (m) => m.baseBranchRefusal("-main")) as string;
    expect(body).toContain("'base_branch'");
    expect(body).toContain(JSON.stringify("-main"));
  });
});

describe("baseBranchLine / BASE_BRANCH_LINE_RE — the description carrier", () => {
  it("emits the identical line in both twins", () => {
    for (const name of ACCEPT) {
      const t = tickets.baseBranchLine(name);
      const j = jira.baseBranchLine(name);
      expect(Buffer.from(j, "utf8").equals(Buffer.from(t, "utf8"))).toBe(true);
      expect(t).toBe(`base_branch: ${name}`);
    }
  });

  it("uses the identical parser in both twins", () => {
    expect(jira.BASE_BRANCH_LINE_RE.source).toBe(tickets.BASE_BRANCH_LINE_RE.source);
    expect(jira.BASE_BRANCH_LINE_RE.flags).toBe(tickets.BASE_BRANCH_LINE_RE.flags);
    // Multiline, or the anchors cannot find a line inside a description body.
    expect(tickets.BASE_BRANCH_LINE_RE.flags).toContain("m");
  });

  it("round-trips the branch name back out of a real description body", () => {
    for (const name of ACCEPT) {
      // What a ticket description actually looks like: a banner, prose, then the
      // line — as the twins compose it (banner, body, base_branch line).
      const description = [
        "DELIVERY CONSTRAINT: a Merge Approval gate is open on this run's integration branch.",
        "Fix the abandon guard so a parked execution is not left running.",
        tickets.baseBranchLine(name),
      ].join("\n\n");
      const captured = description.match(tickets.BASE_BRANCH_LINE_RE);
      expect(captured, `no base_branch line found for ${name}`).not.toBeNull();
      expect(captured![1]).toBe(name);
      // And the jira twin's parser finds the same thing in the same body.
      expect(description.match(jira.BASE_BRANCH_LINE_RE)![1]).toBe(name);
    }
  });

  it("finds nothing when no branch was stated", () => {
    const description = "Plain ticket. No branch identity.";
    expect(description.match(tickets.BASE_BRANCH_LINE_RE)).toBeNull();
    expect(description.match(jira.BASE_BRANCH_LINE_RE)).toBeNull();
  });

  it("only ever captures a branch the validator would have accepted", () => {
    // Belt and braces: the line is written from a validated value, so anything the
    // parser can capture must round-trip back through the regex. A future edit that
    // widened the line format without widening the validator would fail here.
    for (const name of ACCEPT) {
      const captured = tickets.baseBranchLine(name).match(tickets.BASE_BRANCH_LINE_RE)![1];
      expect(tickets.BASE_BRANCH_RE.test(captured)).toBe(true);
    }
  });
});
