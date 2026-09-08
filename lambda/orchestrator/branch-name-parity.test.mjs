import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalBranchFor } from "./ticket-plan-validator.mjs";

/**
 * canonicalBranchFor MUST render the branch index.mjs renders (TEAM-4248 D3).
 *
 * There are now FIVE places the convention lives: the literal in index.mjs's
 * buildAgentContext ## Branch block, and canonicalBranchFor in four byte-copied
 * modules. check-fix-kinds-parity.sh keeps the four copies identical to each
 * other; nothing keeps them identical to the string an agent is actually TOLD.
 *
 * If they drift, the failure is silent and expensive in exactly the way c2uqki
 * was: the harness tells the sweeper one branch, and the reviewer, QA and CI are
 * each judged against a different name. So this test does not compare prose — it
 * extracts index.mjs's own two lines as TEXT, executes them, and requires the
 * output to equal canonicalBranchFor's for the same inputs. A refactor that
 * moves or renames the literal fails here rather than in production.
 */

const INDEX = fileURLToPath(new URL("./index.mjs", import.meta.url));
const src = readFileSync(INDEX, "utf8");

const slugMatch = /const slug = (agentDef\.agentId(?:[^;\n]+));/.exec(src);
const branchMatch = /context \+= `feature_branch: (feature\/[^`\n]+?)\\n`;/.exec(src);

describe("branch-name parity: index.mjs vs canonicalBranchFor", () => {
  it("still finds the ## Branch literal in index.mjs", () => {
    // An empty extraction would make every assertion below vacuously pass.
    expect(
      slugMatch,
      "the `const slug = agentDef.agentId...` line moved — update this extractor",
    ).not.toBeNull();
    expect(
      branchMatch,
      "the `feature_branch: feature/...` literal moved — update this extractor",
    ).not.toBeNull();
  });

  it("renders the same branch as index.mjs for every persona shape", () => {
    const slugExpr = slugMatch[1];
    const tpl = branchMatch[1];
    // index.mjs's own expressions, executed. `advisory` and `ticket` are the
    // names they close over there, so the body is copied verbatim.
    const renderAsIndexDoes = new Function(
      "agentDef",
      "ticket",
      "advisory",
      `const slug = ${slugExpr}; return \`${tpl}\`;`,
    );

    const cases = [
      ["TEAM-4230", "agentcore_hub_code_sweeper", false],
      ["TEAM-4231", "agentcore_hub_code_reviewer", false],
      ["TEAM-4177", "agentcore_hub_backend_dev", false],
      ["TEAM-4177", "agentcore_hub_backend_dev", true],
      ["PROJ-1", "agentcore_hub_frontend_designer", false],
      // No prefix and no underscores — the slug helpers must be no-ops.
      ["TEAM-1", "sweeper", false],
    ];

    for (const [ticketId, agentId, advisory] of cases) {
      const fromIndex = renderAsIndexDoes({ agentId }, { ticketId }, advisory);
      expect(canonicalBranchFor(ticketId, agentId, { advisory }), `${agentId} advisory=${advisory}`).toBe(
        fromIndex,
      );
    }
  });

  it("agrees on c2uqki's real sweeper branch", () => {
    // The branch the sweeper actually pushed, and the one the other three
    // personas should have been handed instead of chore/dead-code-sweep-2026-09-07.
    expect(canonicalBranchFor("TEAM-4230", "agentcore_hub_code_sweeper")).toBe(
      "feature/TEAM-4230-code-sweeper",
    );
    expect(src).toContain("feature_branch: feature/${ticket.ticketId}-");
  });
});
