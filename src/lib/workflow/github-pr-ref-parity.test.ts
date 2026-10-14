import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// TEAM-6154 (ship review r3 F2 of #954). The workflow-output Lambda compares a
// cd-ledger's prUrl against a report's pr_url by CANONICAL PR identity, and the
// one PR-url parser is the orchestrator's githubPrRef (TEAM-6133 host anchoring,
// TEAM-6148 whole-integer number). Each Lambda ships as its own zip and the
// manifest check follows only `./x.mjs` imports, so workflow-output cannot import
// the orchestrator: the function is byte-mirrored instead, exactly like
// fix-contract.mjs / gate-contract.mjs. Same two guards as fix-contract-parity:
//   1. the function SOURCE TEXT is identical in both files;
//   2. a behavioural matrix pushed through both imports agrees.
import { githubPrRef as orchestratorRef } from "../../../lambda/orchestrator/completion.mjs";
import { githubPrRef as workflowOutputRef } from "../../../lambda/workflow-output/github-pr-ref.mjs";

const ROOT = resolve(__dirname, "../../..");
const FILES = ["lambda/orchestrator/completion.mjs", "lambda/workflow-output/github-pr-ref.mjs"];

function functionText(file: string): string {
  const src = readFileSync(resolve(ROOT, file), "utf8");
  const m = /^export function githubPrRef\(text\) \{\n[\s\S]*?^\}\n/m.exec(src);
  if (!m) throw new Error(`${file}: githubPrRef not found`);
  return m[0];
}

describe("githubPrRef parity (orchestrator completion.mjs vs workflow-output github-pr-ref.mjs)", () => {
  it("the function source text is byte-identical in both files", () => {
    const [a, b] = FILES.map(functionText);
    expect(b).toBe(a);
  });

  const WANT = { owner: "o", repo: "r", number: 12 };
  const PARSES: Array<[string, { owner: string; repo: string; number: number } | null]> = [
    ["https://github.com/o/r/pull/12", WANT],
    ["https://github.com/o/r/pull/12/", WANT],
    ["https://github.com/o/r/pull/12/files", WANT],
    ["https://github.com/o/r/pull/12/commits", WANT],
    ["https://github.com/o/r/pull/12?x=1", WANT],
    ["https://github.com/o/r/pull/12#issuecomment-1", WANT],
    ["https://github.com/o/r/pull/12#discussion_r1", WANT],
    ["HTTPS://GITHUB.COM/o/r/pull/12", WANT],
    ["http://github.com/o/r/pull/12", WANT],
    ["see https://github.com/o/r/pull/12.", WANT],
    ["(see https://github.com/o/r/pull/12)", WANT],
    // owner/repo case is preserved by the parser; the caller lowercases for identity
    ["https://github.com/O/R/pull/12", { owner: "O", repo: "R", number: 12 }],
    // TEAM-6148: the number segment is a whole positive integer
    ["https://github.com/o/r/pull/1not-a-pr", null],
    ["https://github.com/o/r/pull/1%2Fnot-a-pr", null],
    ["https://github.com/o/r/pull/0", null],
    ["https://github.com/o/r/pull/", null],
    // TEAM-6133: the host is parsed, not substring-matched
    ["https://notgithub.com/o/r/pull/12", null],
    ["https://example.org/github.com/o/r/pull/12", null],
    ["https://github.com/o/r/issues/12", null],
    ["not a url", null],
    ["", null],
  ];

  for (const [input, want] of PARSES) {
    it(`both parse ${JSON.stringify(input)} to ${JSON.stringify(want)}`, () => {
      expect(orchestratorRef(input)).toEqual(want);
      expect(workflowOutputRef(input)).toEqual(want);
    });
  }

  it("both treat null / undefined / non-string input as no PR", () => {
    for (const v of [null, undefined, 12, {}] as unknown[]) {
      expect(orchestratorRef(v as string)).toBeNull();
      expect(workflowOutputRef(v as string)).toBeNull();
    }
  });
});
