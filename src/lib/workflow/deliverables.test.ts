import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import agentsConfig from "@/config/agents.json";
import {
  WORKFLOW_DEFS,
  getDeliverableFamilies,
  getDeliverables,
  deliverableMatches,
  type Deliverable,
} from "./workflow-defs";

/**
 * The deliverables registry in src/config/workflows.json is read by three
 * consumers that must agree: the workflow-output Lambda's write-time lint
 * (filename → family → sections), the board's deliverables strip, and the
 * generated docs/workflow/deliverables.md. This test pins the registry's
 * integrity so a hand edit cannot silently disable any of them: every entry
 * names a real phase, family, author and template; a filename never maps to two
 * families; every template blueprint carries exactly its family's sections.
 */
const ROOT = resolve(__dirname, "../../..");
const families = getDeliverableFamilies();
const AGENT_IDS = new Set((agentsConfig as { agents: { agentId: string }[] }).agents.map((a) => a.agentId));

const authorsOf = (d: Deliverable) => (Array.isArray(d.author) ? d.author : [d.author]);

describe("deliverable families", () => {
  it("are the five the standard names, each with a template blueprint carrying exactly its sections", () => {
    expect(Object.keys(families).sort()).toEqual(["assessment", "brief", "external", "record", "spec"]);
    for (const [name, fam] of Object.entries(families)) {
      const file = resolve(ROOT, "blueprints", `${fam.template}.md`);
      expect(existsSync(file), `${fam.template}.md missing`).toBe(true);
      const md = readFileSync(file, "utf8");
      // The "## Sections" block lists `## <name>` in backticks, in order.
      const block = /## Sections[\s\S]*?(?=\n## Example)/.exec(md)?.[0] || "";
      const listed = [...block.matchAll(/^\d+\. `## ([^`]+)`/gm)].map((m) => m[1]);
      expect(listed, `${name}: template sections drift from workflows.json`).toEqual(fam.sections);
      expect(fam.sections.length).toBeGreaterThanOrEqual(3);
      expect(fam.sections.length).toBeLessThanOrEqual(4);
    }
  });
});

describe("deliverables registry", () => {
  it("every def declares deliverables and a writingStandard flag", () => {
    for (const def of WORKFLOW_DEFS) {
      expect(typeof def.writingStandard, def.id).toBe("boolean");
      expect((def.deliverables || []).length, def.id).toBeGreaterThan(0);
    }
  });
  it("every entry names a real phase, family, author and template", () => {
    for (const def of WORKFLOW_DEFS) {
      const phases = new Set<string>();
      for (const p of def.phases) { phases.add(p.agentPhase); for (const x of p.extraAgentPhases || []) phases.add(x); }
      for (const d of def.deliverables || []) {
        const where = `${def.id}/${d.key}`;
        expect(phases.has(d.phase), `${where}: phase ${d.phase}`).toBe(true);
        expect(families[d.family], `${where}: family ${d.family}`).toBeDefined();
        for (const a of authorsOf(d)) expect(a === "hub" || AGENT_IDS.has(a), `${where}: author ${a}`).toBe(true);
        if (d.template) expect(existsSync(resolve(ROOT, "blueprints", `${d.template}.md`)), `${where}: template ${d.template}`).toBe(true);
        if (d.kind === "pr") expect(d.template, `${where}: a PR has no template`).toBeNull();
        expect(d.reader.length).toBeGreaterThan(3);
      }
    }
  });
  it("keys are unique within a def and a filename never maps to two families across defs", () => {
    const familyByKey = new Map<string, string>();
    for (const def of WORKFLOW_DEFS) {
      const seen = new Set<string>();
      for (const d of def.deliverables || []) {
        expect(seen.has(d.key), `${def.id}: duplicate ${d.key}`).toBe(false);
        seen.add(d.key);
        const prior = familyByKey.get(d.key);
        expect(!prior || prior === d.family, `${d.key}: ${prior} vs ${d.family}`).toBe(true);
        familyByKey.set(d.key, d.family);
      }
    }
  });
  it("every human gate a def declares has a brief-family deliverable read at it", () => {
    for (const def of WORKFLOW_DEFS) {
      for (const g of def.reviewGates || []) {
        const at = (def.deliverables || []).filter((d) => d.gate === g.name);
        expect(at.length, `${def.id}: gate ${g.name} has no deliverable`).toBeGreaterThan(0);
        expect(at.some((d) => d.family === "brief" || d.family === "spec" || d.family === "external"), `${def.id}: ${g.name}`).toBe(true);
      }
    }
  });
  it("getDeliverables hides framework-only entries unless that framework is asked for", () => {
    const std = getDeliverables("software-delivery");
    expect(std.some((d) => d.key === "spec.md")).toBe(false);
    expect(std.some((d) => d.key === "requirements.md")).toBe(true);
    const pb = getDeliverables("software-delivery", "playbook");
    expect(pb.some((d) => d.key === "spec.md")).toBe(true);
    expect(pb.some((d) => d.key === "plan.md")).toBe(true);
  });
  it("deliverableMatches handles exact names and single-segment globs", () => {
    const d = (key: string): Deliverable => ({ key, title: "", phase: "x", family: "record", author: "hub", reader: "r", required: false });
    expect(deliverableMatches(d("merge-brief.md"), "workflows/wf_1/shared/merge-brief.md")).toBe(true);
    expect(deliverableMatches(d("merge-brief.md"), "workflows/wf_1/agentcore_hub_operator/merge-brief.md")).toBe(false);
    expect(deliverableMatches(d("design-doc-*.md"), "workflows/wf_1/shared/design-doc-agentcore_hub_ios_designer.md")).toBe(true);
    expect(deliverableMatches(d("cd-evidence/deploy-*.md"), "workflows/wf_1/shared/cd-evidence/deploy-abc.md")).toBe(true);
    expect(deliverableMatches(d("cd-evidence/deploy-*.md"), "workflows/wf_1/shared/cd-evidence/x/deploy-abc.md")).toBe(false);
  });
});
