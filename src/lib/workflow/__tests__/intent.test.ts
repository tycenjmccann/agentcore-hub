import { describe, it, expect } from "vitest";
import { renderIntentMarkdown, intentReviewPackage, intentGateFor, artifactChainDir, intentGateDescription } from "@/lib/workflow/intent";
import { getWorkflowDef } from "@/lib/workflow/workflow-defs";
import type { WorkflowInput } from "@/lib/workflow/types";

const base: WorkflowInput = {
  title: "Keyboard shortcut for dark mode",
  description: "Users keep asking for a faster way to flip the theme.",
  repoConfig: { layout: "monorepo", repos: [{ url: "https://github.com/acme/demo-app.git", defaultBranch: "main", platform: "shared" }] },
  sources: [],
};

describe("intent.md rendering (playbook PLAN stage)", () => {
  it("copies the originator's words verbatim under fixed headings", () => {
    const md = renderIntentMarkdown({
      workflowId: "wf_1",
      filedAt: "2026-09-05T00:00:00.000Z",
      input: { ...base, intent: { problem: "  Toggling theme takes 3 clicks.  ", successCriteria: "Shift+D flips it; hint visible.", who: "Power users", originator: "Tycen (PM)" } },
    });
    expect(md).toContain("# Intent: Keyboard shortcut for dark mode");
    expect(md).toContain("## Problem\nToggling theme takes 3 clicks.");
    expect(md).toContain("## Success criteria\nShift+D flips it; hint visible.");
    expect(md).toContain("## Who is affected\nPower users");
    expect(md).toContain("Originator: Tycen (PM) (via console)");
    expect(md).toContain("Target repo: https://github.com/acme/demo-app.git");
    // the free-text description is kept, labelled, never dropped
    expect(md).toContain("## Original request (verbatim)\nUsers keep asking for a faster way to flip the theme.");
    expect(md).toContain("## Constraints\nNone stated.");
  });
  it("falls back to the description as the problem when no brief is given", () => {
    const md = renderIntentMarkdown({ workflowId: "wf_2", input: base });
    expect(md).toContain("## Problem\nUsers keep asking for a faster way to flip the theme.");
    expect(md).toContain("product owner confirms the success criteria at acceptance");
    expect(md).not.toContain("## Original request");
  });
  it("review package links intent.md and names the decision", () => {
    const pkg = intentReviewPackage({ workflowId: "wf_3", input: { ...base, intent: { problem: "p", successCriteria: "s" } } });
    expect(pkg.gate).toBe("intake");
    expect(pkg.links).toEqual([{ label: "intent.md", artifactKey: "workflows/wf_3/shared/intent.md" }]);
    expect(pkg.summary).toContain("Intent Acceptance");
    expect(pkg.bullets.some((b) => b.startsWith("Approve = accept"))).toBe(true);
  });
  it("gate ticket body embeds the intent", () => {
    expect(intentGateDescription("# Intent: x", "wf_4")).toContain("# Intent: x");
    expect(intentGateDescription("# Intent: x", "wf_4")).toContain("workflows/wf_4/shared/intent.md");
  });
});

describe("intent gate + chain dir resolution from the def", () => {
  it("sdlc-playbook has an always-on intent gate and a chain dir", () => {
    const def = getWorkflowDef("sdlc-playbook");
    expect(def.id).toBe("sdlc-playbook");
    expect(intentGateFor(def)?.name).toBe("Intent Acceptance");
    expect(intentGateFor(def)?.assignee).toBe("human:product-owner");
    expect(artifactChainDir(def, "wf_5")).toBe(".sdlc/wf_5");
  });
  it("software-delivery has neither", () => {
    const def = getWorkflowDef("software-delivery");
    expect(intentGateFor(def)).toBeNull();
    expect(artifactChainDir(def, "wf_5")).toBeNull();
  });
});
