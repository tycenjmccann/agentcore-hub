import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { buildDeliverableIndex, matchDeliverable, familyOf, lintMarkdown, lintDeliverable, LEAD_MAX_WORDS } from "./deliverables-lint.mjs";

/**
 * The writing-standard lint is what turns blueprints/writing-standard.md from
 * advice into a contract: a registered deliverable that is not answer-first, in
 * its family's sections, is refused at write time. These tests pin (a) which
 * files are covered, driven by the REAL src/config/workflows.json, and (b) each
 * structural rule, using the templates' own examples as the conforming corpus —
 * if a template example ever fails its own family's lint, that is the bug.
 */
const config = JSON.parse(readFileSync(new URL("../../src/config/workflows.json", import.meta.url), "utf8"));
const index = buildDeliverableIndex(config);

const exampleFrom = (template) => {
  const md = readFileSync(new URL(`../../blueprints/${template}.md`, import.meta.url), "utf8");
  const m = /## Example[^\n]*\n\n```\n([\s\S]*?)\n```/.exec(md);
  if (!m) throw new Error(`${template} has no fenced example`);
  return m[1];
};

const BRIEF = config.deliverableFamilies.brief.sections;

describe("deliverable index — who is covered", () => {
  it("covers the software defs' human-read markdown and nothing else", () => {
    expect(matchDeliverable(index, "workflows/wf_1/shared/merge-brief.md")?.family).toBe("brief");
    expect(matchDeliverable(index, "workflows/wf_1/shared/findings.md")?.family).toBe("assessment");
    expect(matchDeliverable(index, "workflows/wf_1/shared/requirements.md")?.family).toBe("spec");
    expect(matchDeliverable(index, "workflows/wf_1/shared/operator-status.md")?.family).toBe("record");
    expect(matchDeliverable(index, "workflows/wf_1/shared/cd-evidence/deploy-abc123.md")?.family).toBe("record");
    expect(matchDeliverable(index, "workflows/wf_1/shared/design-doc-agentcore_hub_backend_designer.md")?.family).toBe("spec");
  });
  it("skips own-contract docs, JSON, binaries, agent folders and non-enforced defs", () => {
    expect(matchDeliverable(index, "workflows/wf_1/shared/plan.md")).toBeNull();       // template: null (playbook / operator contract)
    expect(matchDeliverable(index, "workflows/wf_1/shared/spec.md")).toBeNull();
    expect(matchDeliverable(index, "workflows/wf_1/shared/intent.md")).toBeNull();     // verbatim request
    expect(matchDeliverable(index, "workflows/wf_1/shared/cd-ledger.json")).toBeNull();
    expect(matchDeliverable(index, "workflows/wf_1/shared/review-package-ship.json")).toBeNull();
    expect(matchDeliverable(index, "workflows/wf_1/agentcore_hub_operator/merge-brief.md")).toBeNull(); // staging copy
    expect(matchDeliverable(index, "workflows/wf_1/shared/campaign-brief.md")).toBeNull(); // marketing: writingStandard false
    expect(matchDeliverable(index, "workflows/wf_1/shared/redlines.md")).toBeNull();       // legal: writingStandard false
    expect(matchDeliverable(index, "random/key.md")).toBeNull();
  });
  it("a file name shared by several defs maps to one family", () => {
    for (const e of index.exact.values()) expect(new Set([e.family]).size).toBe(1);
    expect(index.exact.get("merge-brief.md").defIds.sort()).toEqual(["bug-fix", "dead-code-sweep", "operator", "software-delivery"]);
  });
  it("familyOf exposes the spec family for save_design_doc", () => {
    expect(familyOf(index, "spec")).toMatchObject({ family: "spec", template: "template-spec" });
    expect(familyOf(index, "nope")).toBeNull();
    expect(familyOf(null, "spec")).toBeNull();
  });
});

describe("every template's own example passes its family's lint", () => {
  for (const [family, fam] of Object.entries(config.deliverableFamilies)) {
    it(`${family} (${fam.template})`, () => {
      expect(lintMarkdown(exampleFrom(fam.template), fam.sections)).toEqual([]);
    });
  }
});

describe("lintMarkdown — the rules", () => {
  const good = exampleFrom("template-brief");
  it("the real 14.5 KB merge brief shape (ALL-CAPS labels, • bullets, no title) is refused for the right reasons", () => {
    const legacy = [
      "DECISION: BLOCKED — live verification could not run. Approving merges UNVERIFIED code. Reject = nothing merges.",
      "Revertibility: High — additive only.",
      "",
      "WHAT HAPPENED",
      "• Plan: 9 units; executed in 4 worker turns.",
      "• LIVE CHECK: BLOCKED.",
      "",
      "⚠ NEEDS YOUR ATTENTION",
      "• The live rows are BLOCKED, not failed.",
    ].join("\n");
    const problems = lintMarkdown(legacy, BRIEF);
    expect(problems).toContain("first line must be the document title as `# Title`");
    expect(problems).toContain("missing section `## Decision`");
    expect(problems.some((p) => p.startsWith("bare ALL-CAPS label `WHAT HAPPENED`"))).toBe(true);
    expect(problems).toContain("`•` bullets do not render; use `-`");
  });
  it("requires the title line", () => {
    expect(lintMarkdown(good.replace(/^# .*\n/, ""), BRIEF)).toContain("first line must be the document title as `# Title`");
  });
  it("requires every section, in order, answer first", () => {
    const noEye = good.replace("## What needs your eye", "## Watch out");
    expect(lintMarkdown(noEye, BRIEF)).toContain("missing section `## What needs your eye`");
    const swapped = good.replace("## Decision", "## TMP").replace("## Why it is ready", "## Decision").replace("## TMP", "## Why it is ready");
    const p = lintMarkdown(swapped, BRIEF);
    expect(p.some((x) => x.startsWith("sections out of order"))).toBe(true);
    expect(p.some((x) => x.includes("the answer comes first"))).toBe(true);
  });
  it("allows appendix sections only after the template's sections", () => {
    expect(lintMarkdown(good + "\n## Appendix: raw ledger\nrows\n", BRIEF)).toEqual([]);
    const between = good.replace("## Why it is ready", "## Background\nlong story\n\n## Why it is ready");
    expect(lintMarkdown(between, BRIEF).some((x) => x.includes("extra sections must follow"))).toBe(true);
  });
  it("the lead is short prose: no list, no table, at most LEAD_MAX_WORDS words", () => {
    const listy = good.replace("## Decision\n", "## Decision\n- approve\n");
    expect(lintMarkdown(listy, BRIEF)).toContain("`## Decision` must be prose: no list, table or sub-heading in the lead");
    const long = good.replace("## Decision\n", `## Decision\n${"word ".repeat(LEAD_MAX_WORDS + 1)}\n`);
    expect(lintMarkdown(long, BRIEF).some((x) => x.includes(`max ${LEAD_MAX_WORDS} words`))).toBe(true);
    const empty = good.replace(/## Decision\n[\s\S]*?\n\n## Why it is ready/, "## Decision\n\n## Why it is ready");
    expect(lintMarkdown(empty, BRIEF)).toContain("`## Decision` is empty; state the conclusion in one to three sentences");
  });
  it("rejects ALL-CAPS headings but tolerates acronyms and short caps", () => {
    expect(lintMarkdown(good.replace("## After approval", "## AFTER APPROVAL"), BRIEF).some((x) => x.startsWith("ALL-CAPS heading"))).toBe(true);
    expect(lintMarkdown(good + "\n## CI\nfine\n", BRIEF)).toEqual([]);
    expect(lintMarkdown(good + "\n## QA and CI evidence\nfine\n", BRIEF)).toEqual([]);
  });
  it("ignores fenced code when scanning headings and labels", () => {
    const fenced = good + "\n## Appendix\n```\nWHAT HAPPENED\n## Not a heading\n• bullet in code\n```\n";
    expect(lintMarkdown(fenced, BRIEF)).toEqual([]);
  });
  it("an empty document is one problem, not a crash", () => {
    expect(lintMarkdown("", BRIEF)).toEqual(["document is empty"]);
    expect(lintMarkdown(null, BRIEF)).toEqual(["document is empty"]);
  });
});

describe("lintDeliverable — the tool-facing refusal", () => {
  it("returns null for an unregistered key or a conforming doc", () => {
    expect(lintDeliverable({ key: "workflows/wf_1/shared/notes.md", content: "anything", match: null })).toBeNull();
    const match = matchDeliverable(index, "workflows/wf_1/shared/merge-brief.md");
    expect(lintDeliverable({ key: "workflows/wf_1/shared/merge-brief.md", content: exampleFrom("template-brief"), match })).toBeNull();
  });
  it("names the family, the template to load and every problem", () => {
    const match = matchDeliverable(index, "workflows/wf_1/shared/findings.md");
    const r = lintDeliverable({ key: "workflows/wf_1/shared/findings.md", content: "just prose", match });
    expect(r).toMatchObject({ status: "refused", reason: "writing_standard", family: "assessment", template: "template-assessment" });
    expect(r.problems.length).toBeGreaterThan(1);
    expect(r.message).toContain('load_blueprint("template-assessment")');
    expect(r.message).toContain("Do not rename the file");
  });
});
