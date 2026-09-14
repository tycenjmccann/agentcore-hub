import { describe, it, expect } from "vitest";
import { FLOW_METRICS, kindOf, layoutTicketFlow, type FlowTicket } from "./ticket-flow-layout";
import { ticketMetaFromLabels } from "./jira-read";

const ROSTER: Record<string, string> = {
  agentcore_hub_requirements_analyst: "requirements",
  agentcore_hub_backend_designer: "design",
  agentcore_hub_security_reviewer: "design",
  agentcore_hub_backend_dev: "development",
  agentcore_hub_api_dev: "development",
  agentcore_hub_code_reviewer: "review",
  agentcore_hub_ci_agent: "review",
  agentcore_hub_qa_verifier: "verification",
  agentcore_hub_release_manager: "ship",
};
const agentPhaseOf = (id: string) => ROSTER[id];

let seq = 0;
function t(id: string, agent: string, title: string, blockedBy: string[] = [], extra: Partial<FlowTicket> = {}): FlowTicket {
  seq += 1;
  return {
    id,
    title,
    status: "done",
    type: "task",
    assignee: agent.startsWith("human:") ? agent : `agentcore_hub_${agent}`,
    blockedBy,
    createdAt: new Date(Date.UTC(2026, 8, 11, 16, 0, seq)).toISOString(),
    ...extra,
  };
}

/** A trimmed real run: main line + QA fixes with a re-cert + ship re-review waiting only on rework. */
function realRun(): FlowTicket[] {
  seq = 0;
  return [
    { id: "TEAM-1", title: "Epic", status: "in_progress", type: "epic", blockedBy: [] },
    t("TEAM-2", "requirements_analyst", "Requirements: thing"),
    t("TEAM-3", "backend_designer", "Design: thing"),
    t("TEAM-4", "security_reviewer", "Security review: thing", ["TEAM-3"]),
    t("TEAM-5", "backend_dev", "Backend: thing", ["TEAM-3", "TEAM-4"]),
    t("TEAM-6", "api_dev", "API: thing", ["TEAM-3", "TEAM-4"]),
    t("TEAM-7", "code_reviewer", "Review: thing", ["TEAM-5", "TEAM-6", "TEAM-11"]),
    t("TEAM-8", "ci_agent", "CI: validate", ["TEAM-7"]),
    t("TEAM-9", "qa_verifier", "QA: verify", ["TEAM-8", "TEAM-12", "TEAM-13"], { status: "blocked" }),
    t("TEAM-10", "release_manager", "Ship: open PR", ["TEAM-9"], { status: "todo" }),
    // rework
    t("TEAM-11", "backend_dev", "Fix (review): dedupe", [], { spawnedBy: { kind: "review_fix", gateTicketId: "TEAM-7" } }),
    t("TEAM-12", "backend_dev", "Fix (QA): truncation", [], { status: "in_progress", spawnedBy: { kind: "qa_fix", qaTicketId: "TEAM-9" } }),
    t("TEAM-13", "ci_agent", "CI (re-cert): after QA fixes", ["TEAM-12"], { status: "todo" }),
    t("TEAM-14", "api_dev", "ADVISORY: pipefail", [], { status: "todo", labels: ["advisory"] }),
    // ship-phase re-review that waits ONLY on rework (the case the old layering mis-placed)
    t("TEAM-15", "release_manager", "Ship: re-review after drift", ["TEAM-16"], { status: "todo" }),
    t("TEAM-16", "ci_agent", "CI (re-cert): after ship fix", [], { status: "todo" }),
    t("TEAM-17", "human:engineer", "Merge Approval: thing", ["TEAM-10", "TEAM-15"], { status: "todo" }),
    t("TEAM-18", "human:engineer", "Deploy gate: approve Approve_deploy", [], { status: "todo" }),
    t("TEAM-19", "release_manager", "CD: merge + deploy", ["TEAM-17", "TEAM-18"], { status: "todo" }),
  ];
}

const nodeOf = (layout: ReturnType<typeof layoutTicketFlow>, id: string) => {
  const n = layout.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`missing ${id}`);
  return n;
};

describe("kindOf", () => {
  it("prefers the spawnedBy stamp", () => {
    expect(kindOf({ id: "a", title: "anything", status: "todo", type: "task", blockedBy: [], spawnedBy: { kind: "ship_fix" } })).toBe("ship_fix");
  });
  it("falls back to the title prefixes agents use when the provider drops spawnedBy", () => {
    const k = (title: string, labels?: string[]) => kindOf({ id: "a", title, status: "todo", type: "task", blockedBy: [], labels });
    expect(k("Fix (QA): thing")).toBe("qa_fix");
    expect(k("Fix (review): thing")).toBe("review_fix");
    expect(k("Fix (CI): thing")).toBe("ci_fix");
    expect(k("Fix (sync-main): merge")).toBe("sync_fix");
    expect(k("Fix (ship-review r1): thing")).toBe("ship_fix");
    expect(k("CI (re-cert): certify")).toBe("recert");
    expect(kindOf({ id: "a", title: "CI (re-cert): certify after ship fix", status: "todo", type: "task", blockedBy: [], spawnedBy: { kind: "ship_fix" } })).toBe("recert");
    expect(k("ADVISORY: hardening")).toBe("advisory");
    expect(k("Hardening", ["advisory"])).toBe("advisory");
    expect(k("Backend: build the thing")).toBeNull();
    expect(k("Ship: open PR")).toBeNull();
  });
});

describe("layoutTicketFlow", () => {
  it("excludes the epic and puts planned tickets on the main line, rework in the band", () => {
    const L = layoutTicketFlow(realRun(), { agentPhaseOf });
    expect(L.nodes.find((n) => n.id === "TEAM-1")).toBeUndefined();
    expect(nodeOf(L, "TEAM-5").band).toBe("main");
    expect(nodeOf(L, "TEAM-11").band).toBe("rework");
    expect(nodeOf(L, "TEAM-13").kind).toBe("recert");
    expect(nodeOf(L, "TEAM-14").kind).toBe("advisory");
    expect(L.fixes).toBe(4);
    expect(L.advisories).toBe(1);
    expect(L.bandY).not.toBeNull();
  });

  it("orders main-line columns by phase and never sends a later phase backwards", () => {
    const L = realRunLayout();
    const c = (id: string) => nodeOf(L, id).col;
    expect(c("TEAM-2")).toBeLessThan(c("TEAM-3"));
    expect(c("TEAM-3")).toBeLessThan(c("TEAM-4")); // security review waits on design → next column, same phase
    expect(c("TEAM-4")).toBeLessThan(c("TEAM-5"));
    expect(c("TEAM-5")).toBe(c("TEAM-6")); // parallel dev
    expect(c("TEAM-7")).toBeLessThan(c("TEAM-8")); // CI shows as its own step after review
    expect(c("TEAM-8")).toBeLessThan(c("TEAM-9"));
    expect(c("TEAM-9")).toBeLessThan(c("TEAM-10"));
    // The ship re-review only waits on rework: it must still sit in the Ship column, not column 0.
    expect(c("TEAM-15")).toBe(c("TEAM-10"));
    // The merge gate trails everything as its own "cd" group.
    expect(c("TEAM-17")).toBeGreaterThan(c("TEAM-10"));
    expect(nodeOf(L, "TEAM-17").phase).toBe("cd");
    expect(nodeOf(L, "TEAM-17").isHuman).toBe(true);
    // The release manager's CD ticket is the CD step, not another Ship card; it follows the gates it waits on.
    expect(nodeOf(L, "TEAM-19").phase).toBe("cd");
    expect(c("TEAM-18")).toBe(c("TEAM-17"));
    expect(c("TEAM-19")).toBe(c("TEAM-17") + 1);
  });

  it("places rework directly under the ticket it unblocks, chains as-late-as-possible", () => {
    const L = realRunLayout();
    const c = (id: string) => nodeOf(L, id).col;
    expect(c("TEAM-11")).toBe(c("TEAM-7")); // review fix under the reviewer
    expect(c("TEAM-13")).toBe(c("TEAM-9")); // re-cert under QA
    expect(c("TEAM-12")).toBe(c("TEAM-9") - 1); // the fix it waits on, one column left
    expect(c("TEAM-16")).toBe(c("TEAM-15")); // ship re-cert under the ship re-review
    expect(c("TEAM-14")).toBe(0); // advisory with no filer and no dependents → first column
    // Nothing in the band collides.
    const seen = new Set<string>();
    for (const n of L.nodes) {
      const key = `${n.band}:${n.x}:${n.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("draws every blockedBy as an edge; same-column rework points straight up", () => {
    const L = realRunLayout();
    const edges = L.edges.map((e) => `${e.from}->${e.to}`);
    expect(edges).toContain("TEAM-3->TEAM-4");
    expect(edges).toContain("TEAM-11->TEAM-7");
    expect(edges).toContain("TEAM-13->TEAM-9");
    const up = L.edges.find((e) => e.from === "TEAM-13" && e.to === "TEAM-9")!;
    expect(up.path.startsWith("M")).toBe(true);
    expect(up.path).toContain(" L"); // vertical line, not a bezier
    expect(up.resolved).toBe(false); // re-cert is todo
    const across = L.edges.find((e) => e.from === "TEAM-3" && e.to === "TEAM-4")!;
    expect(across.path).toContain(" C");
    expect(across.resolved).toBe(true);
  });

  it("routes a gate releasing an earlier ticket between the two columns, not across the diagram", () => {
    seq = 0;
    const L = layoutTicketFlow(
      [
        t("B", "operator", "Build: thing"),
        t("S", "operator", "Ship: thing", ["B", "G1", "G2"], { status: "blocked" }),
        t("G1", "human:engineer", "Merge Approval", ["S"], { status: "in_review" }),
        t("G2", "human:engineer", "Deploy gate pending", [], { status: "todo" }),
      ],
      { agentPhaseOf: (id) => (id === "agentcore_hub_operator" ? "development" : undefined) }
    );
    expect(nodeOf(L, "G1").col).toBe(nodeOf(L, "S").col + 1);
    const back = L.edges.find((e) => e.from === "G1" && e.to === "S")!;
    const sRight = nodeOf(L, "S").x + FLOW_METRICS.nodeW + 1;
    expect(back.path.startsWith(`M${nodeOf(L, "G1").x - 1},`)).toBe(true); // leaves the gate's left side
    expect(back.path.endsWith(`${sRight},${nodeOf(L, "S").y + FLOW_METRICS.nodeH / 2}`)).toBe(true); // lands on the ship ticket's right side
    expect(back.head.startsWith(`${sRight},`)).toBe(true);
  });

  it("spans one caption per phase group over its columns", () => {
    const L = realRunLayout();
    const phases = L.captions.map((c) => c.phase);
    expect(phases).toEqual(["requirements", "design", "development", "review", "ci", "verification", "ship", "cd"]);
    const design = L.captions.find((c) => c.phase === "design")!;
    expect(design.width).toBe(2 * (FLOW_METRICS.nodeW + FLOW_METRICS.colGap) - FLOW_METRICS.colGap);
    expect(L.width).toBeGreaterThan(0);
    expect(L.height).toBeGreaterThan(L.bandY!);
  });

  it("handles a run with no dependencies and no rework", () => {
    seq = 0;
    const L = layoutTicketFlow(
      [t("A", "backend_dev", "Backend: a"), t("B", "api_dev", "API: b"), t("C", "qa_verifier", "QA: c")],
      { agentPhaseOf }
    );
    expect(L.bandY).toBeNull();
    expect(L.edges).toHaveLength(0);
    expect(nodeOf(L, "A").col).toBe(0);
    expect(nodeOf(L, "B").col).toBe(0);
    expect(nodeOf(L, "C").col).toBe(1);
    expect(nodeOf(L, "A").y).not.toBe(nodeOf(L, "B").y);
  });

  it("appends def-specific phases after the SDLC ones, and unknown agents last", () => {
    seq = 0;
    const L = layoutTicketFlow(
      [
        t("S", "strategist", "Strategy", [], { phase: "strategy" }),
        t("Cr", "creative", "Creative", ["S"], { phase: "creative" }),
        t("X", "mystery", "Unknown agent"),
      ],
      { agentPhaseOf: () => undefined, phaseOrder: ["intake", "strategy", "creative"] }
    );
    expect(nodeOf(L, "S").col).toBe(0);
    expect(nodeOf(L, "Cr").col).toBe(1);
    expect(nodeOf(L, "X").phase).toBe("other");
    expect(nodeOf(L, "X").col).toBe(2);
  });
});

describe("ticketMetaFromLabels (Jira provider)", () => {
  it("rebuilds phase + spawnedBy from the Lambda's labels and keeps only user labels", () => {
    const meta = ticketMetaFromLabels([
      "wf:wf_1", "agent:agentcore_hub_backend_dev", "fix:qa_fix", "origin:TEAM-9", "phase:verification",
      "evidence:test-run", "advisory",
    ]);
    expect(meta.phase).toBe("verification");
    expect(meta.spawnedBy).toEqual({ kind: "qa_fix", qaTicketId: "TEAM-9" });
    expect(meta.userLabels).toEqual(["advisory"]);
  });
  it("ignores unknown fix kinds and re-arms on reverify", () => {
    expect(ticketMetaFromLabels(["fix:bogus", "origin:TEAM-1"]).spawnedBy).toBeUndefined();
    expect(ticketMetaFromLabels(["fix:ci_fix", "reverify:TEAM-40"]).spawnedBy).toEqual({ kind: "ci_fix", reverify: true, rearmOf: "TEAM-40" });
    expect(ticketMetaFromLabels(["human-review", "reviewer:engineer"]).userLabels).toEqual([]);
  });
});

function realRunLayout() {
  return layoutTicketFlow(realRun(), { agentPhaseOf });
}
