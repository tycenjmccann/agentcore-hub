/**
 * The bridge's `pipelineConsoleUrl` and the twins' `gate-contract.mjs`
 * `consoleApprovalUrl` must produce the SAME link, because a human follows one of
 * them from a Telegram ping and the other from a refused `→ done` comment — for
 * the same gate, in the same minute. Two links that differ is two places to look.
 *
 * Why it is duplicated instead of imported (TEAM-4739): `gate-contract.mjs` is
 * pinned at exactly TWO copies by `scripts/check-fix-kinds-parity.sh` §1b (the
 * tickets canonical and the jira copy), so the bridge may not take a third, and
 * this Lambda's zip carries no shared-module dependency on the twins. The
 * duplication is therefore deliberate; this test is what keeps it honest, by
 * comparing the FUNCTION SOURCE at the character level rather than a handful of
 * sample inputs — a drift in either body fails here even if no sampled case
 * happens to diverge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/**
 * The body between the `{` that OPENS the function and the `}` that closes it.
 * The parameter list is skipped by paren depth first, because both signatures
 * destructure (`function f({ pipeline, region } = {}, …)`) and taking the first
 * `{` after the name would compare two parameter lists and pass vacuously.
 */
function bodyOf(source, name) {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `${name} is declared`).toBeGreaterThan(-1);
  let i = source.indexOf("(", at);
  for (let parens = 0; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")" && --parens === 0) break;
  }
  const open = source.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}" && --depth === 0) return source.slice(open + 1, j);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("the console deep link is built once, in two places", () => {
  it("has byte-identical bodies in the bridge and the gate contract", () => {
    const bridge = bodyOf(
      readFileSync(join(REPO, "deploy/telegram-bug-intake/index.mjs"), "utf8"),
      "pipelineConsoleUrl");
    const contract = bodyOf(
      readFileSync(join(REPO, "lambda/agentcore-hub-tickets/gate-contract.mjs"), "utf8"),
      "consoleApprovalUrl");

    expect(bridge).toBe(contract);
    // Not vacuously equal: the body has to actually build the link, from the
    // pipeline name and a region, with both escaped.
    expect(bridge).toContain("codesuite/codepipeline/pipelines/");
    expect(bridge).toContain("encodeURIComponent");
    // And an unlabelled gate yields no link at all rather than a broken one.
    expect(bridge).toContain('if (!name) return "";');
  });
});
