import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isTypedGate, gateKindsOf, GATE_KINDS } from "./fix-contract.mjs";
import { gateSlug } from "../../src/lib/workflow/intake-materialize.ts";

/**
 * TEAM-5336 F4 — one rule for "is this gate typed?", at both places that skip a
 * human gate without a human: the orchestrator's skipGateForAbsentDeliverable
 * (DL-035) and workflow-output's empty-sweep humanGateRefusal (TEAM-5323).
 *
 * Typed gates (`gate:<kind>` / the twins' stored `gate-<kind>`, kind in
 * GATE_KINDS) close only on DL-031 external evidence and are never skipped. The
 * def gates intake materializes as `gate:<gateSlug(name)>` (gate:merge-approval
 * …) are ordinary. The bug this pins: workflow-output refused EVERY `gate:` label
 * (so a real Merge Approval was never skippable) and admitted the hyphen spelling
 * of a typed gate. Both sites now call fix-contract.mjs, which is byte-identical
 * across the four Lambdas that ship it (scripts/check-fix-kinds-parity.sh §1).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoFile = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");
const SITES = ["lambda/orchestrator/index.mjs", "lambda/workflow-output/index.mjs"];
const COPIES = [
  "lambda/orchestrator/fix-contract.mjs",
  "lambda/agentcore-hub-tickets/fix-contract.mjs",
  "lambda/agentcore-hub-jira/fix-contract.mjs",
  "lambda/workflow-output/fix-contract.mjs",
];

describe("gate classifier parity (TEAM-5336 F4)", () => {
  it("both gate-skip sites classify typed vs ordinary with fix-contract.isTypedGate", () => {
    for (const site of SITES) {
      const src = repoFile(site);
      expect(src, site).not.toContain('startsWith("gate:")');
      expect(src, site).toMatch(/import \{[^}]*\b(isTypedGate|gateKindsOf)\b[^}]*\} from "\.\/fix-contract\.mjs";/);
    }
    for (const copy of COPIES.slice(1)) expect(repoFile(copy), copy).toBe(repoFile(COPIES[0]));
  });

  it("the completion hold and the empty-sweep skip pass read ONE follow-up / non-review-gate predicate (TEAM-5340 G1)", () => {
    const fromFix = (src, name) => new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./fix-contract\\.mjs";`).test(src);
    for (const site of ["lambda/orchestrator/completion.mjs", "lambda/workflow-output/index.mjs"]) {
      const src = repoFile(site);
      expect(fromFix(src, "isFollowUpTicket"), site).toBe(true);
      expect(src, site).not.toMatch(/(const|function) (FOLLOWUP_LABEL_RE|FOLLOWUP_TITLE_RE|isFollowUpTicket)\b/);
    }
    for (const site of SITES) {
      const src = repoFile(site);
      expect(fromFix(src, "isNonReviewGateTitle"), site).toBe(true);
      expect(src, site).not.toMatch(/\(escalation\|handoff\)/);
    }
  });

  it("every def gate in workflows.json materializes as an ordinary gate", () => {
    const cfg = JSON.parse(repoFile("src/config/workflows.json"));
    const names = new Set();
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v.reviewGates)) for (const g of v.reviewGates) names.add(g.name);
      Object.values(v).forEach(walk);
    };
    walk(cfg);
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      const slug = gateSlug(name);
      expect(GATE_KINDS, `gate "${name}" slugs to a typed kind`).not.toContain(slug);
      expect(isTypedGate([`wfdef:x`, `phase:y`, `gate:${slug}`]), name).toBe(false);
    }
  });

  it.each([
    [["gate:merge-approval"], false],
    [["wfdef:dead-code-sweep", "phase:ship", "gate:merge-approval"], false],
    [["gate-merge-approval"], false],
    [["gate:spec-approval"], false],
    [["human-review", "reviewer:engineer"], false],
    [[], false],
    [undefined, false],
    [["gate-deploy-approval"], true],
    [["gate-ci-unavailable"], true],
    [["gate:approval"], true],
    [["Gate:Deploy-Approval"], true],
    ["gate-blocker,phase:ship", true],
  ])("isTypedGate(%j) === %s", (labels, typed) => {
    expect(isTypedGate(labels)).toBe(typed);
    expect(gateKindsOf(labels).length > 0).toBe(typed);
  });
});
