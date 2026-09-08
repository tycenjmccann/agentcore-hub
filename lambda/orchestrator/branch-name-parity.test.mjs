import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalBranchFor } from "./ticket-plan-validator.mjs";

/**
 * ONE definition of the branch convention, and it renders what it always did
 * (TEAM-4248 D3).
 *
 * The convention now lives in canonicalBranchFor, byte-copied into four Lambda
 * zips — check-fix-kinds-parity.sh cmp's the copies against each other. What
 * that guard cannot see is a FIFTH copy: index.mjs used to build the string by
 * hand in its ## Branch block, and the whole point of D3 is that a branch name
 * an agent is TOLD must never disagree with the branch a producer actually
 * pushes. c2uqki is what disagreement costs: the sweeper pushed
 * feature/TEAM-4230-code-sweeper while the reviewer, QA and CI were each told to
 * look at chore/dead-code-sweep-2026-09-07.
 *
 * So this file guards two things:
 *   1. index.mjs derives the name from canonicalBranchFor and carries no second
 *      template of its own — a re-inlined literal fails here.
 *   2. canonicalBranchFor still renders exactly what index.mjs rendered BEFORE
 *      D3 moved it. The expectations below are the output of the pre-D3 lines
 *      (index.mjs at 40bd1ca):
 *        const slug = agentDef.agentId.replace(/^agentcore_hub_/, "").replace(/_/g, "-");
 *        context += `feature_branch: feature/${ticket.ticketId}-${advisory ? "advisory" : slug}\n`;
 *      transcribed as literals, so this test is a behavioural pin rather than a
 *      restatement of the implementation it is checking.
 */

const INDEX = fileURLToPath(new URL("./index.mjs", import.meta.url));
const src = readFileSync(INDEX, "utf8");

describe("branch-name parity: index.mjs has ONE source for the convention", () => {
  it("index.mjs renders the block from canonicalBranchFor", () => {
    expect(src).toMatch(/import \{[^}]*canonicalBranchFor[^}]*\} from "\.\/ticket-plan-validator\.mjs";/);
    expect(src).toContain("context += `feature_branch: ${branchPlan.canonical}\\n`;");
  });

  it("index.mjs carries no hand-rolled copy of the template", () => {
    // The two shapes the pre-D3 code used. Either one reappearing means a second
    // definition is live and free to drift from the four copies.
    expect(src, "a `feature/<ticketId>-…` template was re-inlined in index.mjs").not.toContain(
      "feature_branch: feature/${ticket.ticketId}",
    );
    expect(src, "the persona slug is derived in index.mjs again").not.toMatch(
      /const slug = agentDef\.agentId/,
    );
  });
});

describe("canonicalBranchFor renders the pre-D3 literal", () => {
  // [ticketId, agentId, advisory, what index.mjs rendered at 40bd1ca]
  const cases = [
    ["TEAM-4230", "agentcore_hub_code_sweeper", false, "feature/TEAM-4230-code-sweeper"],
    ["TEAM-4231", "agentcore_hub_code_reviewer", false, "feature/TEAM-4231-code-reviewer"],
    ["TEAM-4177", "agentcore_hub_backend_dev", false, "feature/TEAM-4177-backend-dev"],
    ["TEAM-4177", "agentcore_hub_backend_dev", true, "feature/TEAM-4177-advisory"],
    ["PROJ-1", "agentcore_hub_frontend_designer", false, "feature/PROJ-1-frontend-designer"],
    // No prefix and no underscores — both slug replacements must be no-ops.
    ["TEAM-1", "sweeper", false, "feature/TEAM-1-sweeper"],
  ];

  for (const [ticketId, agentId, advisory, expected] of cases) {
    it(`${agentId} advisory=${advisory} → ${expected}`, () => {
      expect(canonicalBranchFor(ticketId, agentId, { advisory })).toBe(expected);
    });
  }

  it("agrees on c2uqki's real sweeper branch", () => {
    // The branch the sweeper actually pushed, and the one the other three
    // personas should have been handed instead of chore/dead-code-sweep-2026-09-07.
    expect(canonicalBranchFor("TEAM-4230", "agentcore_hub_code_sweeper")).toBe(
      "feature/TEAM-4230-code-sweeper",
    );
  });
});
