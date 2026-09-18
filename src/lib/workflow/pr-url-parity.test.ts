import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as out from "../../../lambda/workflow-output/index.mjs";

/**
 * TEAM-4752 D3 — workflow-output's `parsePrUrl` is a COPY, pinned to its original.
 *
 * The original lives in lambda/agentcore-hub-pipeline-tools/index.mjs, where it
 * decides which GitHub URL the merge-binding verifier fetches. workflow-output now
 * needs the same parse for the same reason (an agent-supplied string that selects a
 * URL to fetch), and a Lambda ships as its own zip, so it cannot import from a
 * sibling — the same constraint that makes BASE_BRANCH_RE a copy across the ticket
 * twins.
 *
 * A copy is only safe if a fix to one is a CI failure in the other, so this test
 * reads the pipeline-tools SOURCE TEXT and asserts both regex sources appear in it
 * verbatim — the anti-drift trick setup-pipeline-tools-lambda.test.mjs already uses
 * on its embedded Lambda source. The behavioural matrix underneath then pins what
 * the parse is FOR: no query, no fragment, no traversal, no host but github.com.
 */

const PIPELINE_TOOLS_SRC = readFileSync(
  join(process.cwd(), "lambda/agentcore-hub-pipeline-tools/index.mjs"),
  "utf8"
);

describe("parsePrUrl — pinned to the pipeline-tools original", () => {
  it("both regex sources appear verbatim in pipeline-tools' parsePrUrl", () => {
    expect(PIPELINE_TOOLS_SRC).toContain(out.PR_URL_RE.source);
    expect(PIPELINE_TOOLS_SRC).toContain(out.PR_API_URL_RE.source);
    // And in the function that owns them, not merely somewhere in a 3k-line file.
    const fn = PIPELINE_TOOLS_SRC.slice(
      PIPELINE_TOOLS_SRC.indexOf("function parsePrUrl("),
      PIPELINE_TOOLS_SRC.indexOf("async function githubJson(")
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain(out.PR_URL_RE.source);
    expect(fn).toContain(out.PR_API_URL_RE.source);
    // The traversal guard is the non-obvious half of the copy: "." and ".." both
    // satisfy the character class, and a repo of ".." would escape the API path.
    expect(fn).toContain("/^\\.+$/.test(owner)");
  });

  const parse = out.parsePrUrl as (v: unknown) => { owner: string; repo: string; number: string } | null;

  it("accepts both forms blueprints actually paste", () => {
    expect(parse("https://github.com/tycenjmccann/agentcore-hub/pull/611")).toEqual({
      owner: "tycenjmccann",
      repo: "agentcore-hub",
      number: "611",
    });
    expect(parse("https://api.github.com/repos/owner/repo/pulls/42")).toEqual({
      owner: "owner",
      repo: "repo",
      number: "42",
    });
    // Padded is fine — an agent pasting a trailing newline is not an attacker.
    expect(parse("  https://github.com/o/r/pull/1  ")?.number).toBe("1");
  });

  const REJECT: Array<[unknown, string]> = [
    ["", "blank"],
    ["TBD", "prose"],
    ["feature/TEAM-4200-fix", "a branch name, not a URL"],
    ["http://github.com/o/r/pull/1", "http, not https"],
    ["https://gitlab.com/o/r/pull/1", "another host"],
    ["https://github.com.evil.test/o/r/pull/1", "host suffix attack"],
    ["https://github.com/o/r/pulls/1", "the human form uses /pull/"],
    ["https://github.com/o/r/pull/1?x=1", "query"],
    ["https://github.com/o/r/pull/1#c", "fragment"],
    ["https://github.com/o/r/pull/1/files", "trailing path"],
    ["https://github.com/../r/pull/1", "traversal in owner"],
    ["https://github.com/o/../pull/1", "traversal in repo"],
    ["https://github.com/./r/pull/1", "single-dot owner"],
    ["https://github.com/o/r/pull/", "no number"],
    ["https://github.com/o/r/pull/12345678901", "11 digits"],
    ["https://github.com/o/r/pull/abc", "non-numeric"],
    [null, "null"],
    [undefined, "undefined"],
    [42, "not a string"],
  ];

  it.each(REJECT)("rejects %j (%s)", (value, _why) => {
    expect(parse(value)).toBeNull();
  });
});
