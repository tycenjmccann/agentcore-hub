import { describe, it, expect } from "vitest";
import { getWorkflowDef, WORKFLOW_DEFS } from "./workflow-defs";
import { assertDagWellFormed, type TicketDag } from "./dag";

/**
 * TEAM-3992 D3.4 — the ticketDag lives in the def and survives the loader.
 *
 * The loader (workflow-defs.ts) asserts every committed ticketDag is well-formed
 * at module load; these tests pin the template's shape, that the loader rejects a
 * malformed dag, and that resolving a def is stable (two intakes → deep-equal
 * topology, i.e. no hidden per-call mutation of the shared config object).
 */

describe("ticketDag template typing + presence", () => {
  it("software-delivery carries the full 9-node DAG", () => {
    const dag = getWorkflowDef("software-delivery").ticketDag;
    expect(dag).toBeDefined();
    expect(Object.keys(dag!.nodes).sort()).toEqual(
      ["cd", "ci", "design", "development", "mergeGate", "requirements", "review", "ship", "verification"].sort()
    );
    // Ship and CD share one agent, split by titlePrefix.
    expect(dag!.nodes.ship.titlePrefix).toBe("Ship:");
    expect(dag!.nodes.cd.titlePrefix).toBe("CD:");
    expect(dag!.nodes.mergeGate.gate).toBe("Merge Approval");
    expect(dag!.forbiddenEdges).toEqual(
      expect.arrayContaining([
        { from: "verification", to: "ci" },
        { from: "ci", to: "verification" },
      ])
    );
  });

  it("bug-fix drops the design node and blocks development on requirements", () => {
    const dag = getWorkflowDef("bug-fix").ticketDag!;
    expect(dag.nodes.design).toBeUndefined();
    expect(dag.edges).toEqual(expect.arrayContaining([{ from: "requirements", to: "development" }]));
    expect(dag.edges.find((e) => e.to === "development")?.from).toBe("requirements");
  });

  it("dead-code-sweep pins development to the code sweeper agent id", () => {
    const dag = getWorkflowDef("dead-code-sweep").ticketDag!;
    expect(dag.nodes.design).toBeUndefined();
    expect(dag.nodes.development.agentIds).toEqual(["agentcore_hub_code_sweeper"]);
  });

  it("non-code defs (marketing/sales/legal) declare no ticketDag", () => {
    for (const id of ["marketing", "sales", "legal"]) {
      expect(getWorkflowDef(id).ticketDag).toBeUndefined();
    }
  });

  it("every committed ticketDag is well-formed (the loader already asserted this)", () => {
    for (const def of WORKFLOW_DEFS) {
      if (def.ticketDag) expect(assertDagWellFormed(def.ticketDag, def.id)).toBe(true);
    }
  });
});

describe("loader rejects malformed ticketDags", () => {
  it("throws on an edge to an undeclared node", () => {
    const bad: TicketDag = { nodes: { a: {}, b: {} }, edges: [{ from: "a", to: "nope" }] };
    expect(() => assertDagWellFormed(bad)).toThrow(/undeclared node/);
  });

  it("throws on a cyclic edge set", () => {
    const cyclic: TicketDag = {
      nodes: { a: {}, b: {}, c: {} },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    };
    expect(() => assertDagWellFormed(cyclic)).toThrow(/cyclic/);
  });

  it("throws on a fallbackFrom to an undeclared node", () => {
    const bad: TicketDag = { nodes: { a: {}, b: {} }, edges: [{ from: "a", to: "b", fallbackFrom: "ghost" }] };
    expect(() => assertDagWellFormed(bad)).toThrow(/fallbackFrom/);
  });
});

describe("resolving a def twice yields identical topology", () => {
  it("two intakes of the same def deep-equal (no shared-object mutation)", () => {
    const a = getWorkflowDef("software-delivery").ticketDag;
    const b = getWorkflowDef("software-delivery").ticketDag;
    expect(a).toEqual(b);
    // bug-fix and software-delivery must NOT collapse to the same DAG.
    expect(getWorkflowDef("bug-fix").ticketDag).not.toEqual(a);
  });
});
