import { describe, it, expect } from "vitest";
import {
  shouldGateShipDispatch,
  normalizeShipDispatchMode,
  emitShipDispatchMetrics,
} from "./ship-dispatch-gate.mjs";

/**
 * TEAM-4112 — ship-dispatch prerequisite gate. Pure-decision coverage: ship is
 * gated iff a non-epic prerequisite sibling (a completion-required, present,
 * pre-ship phase) is not terminal. Unclassifiable tickets (human gates) and
 * absent phases never gate (fail-safe: don't wedge ship). Mode normalization is
 * a strict allow-list matching the ship-head gate.
 */

// A def whose completion contract requires dev + QA + ship.
const WFDEF = { completionRequiresAgentPhases: ["development", "verification", "review", "ship"] };
const SHIP = { phase: "ship" };
const shipPhases = new Set(["ship"]);

// getAgentPhase stub: maps the agent ids used below to their roster phase.
const PHASES = {
  agentcore_hub_backend_dev: "development",
  agentcore_hub_qa_verifier: "verification",
  agentcore_hub_ci_agent: "review",
  agentcore_hub_release_manager: "ship",
};
const getAgentPhase = (a) => PHASES[a];

const t = (id, assignee, status, extra = {}) => ({ ticketId: id, assignee, status, ...extra });
const gate = (siblings, def = WFDEF, agentDef = SHIP) =>
  shouldGateShipDispatch({ agentDef, wfDef: def, siblings, getAgentPhase, shipPhases });

describe("shouldGateShipDispatch — applicability", () => {
  it("non-ship ticket → not gated", () => {
    const r = shouldGateShipDispatch({ agentDef: { phase: "development" }, wfDef: WFDEF, siblings: [], getAgentPhase, shipPhases });
    expect(r.gated).toBe(false);
    expect(r.reason).toBe("not-ship-phase");
  });

  it("def whose completion contract omits ship → not gated", () => {
    const r = gate([t("D1", "agentcore_hub_backend_dev", "ready")], { completionRequiresAgentPhases: ["development", "verification"] });
    expect(r.gated).toBe(false);
    expect(r.reason).toBe("ship-not-in-completion-contract");
  });

  it("no completionRequiresAgentPhases at all → not gated", () => {
    const r = gate([t("D1", "agentcore_hub_backend_dev", "ready")], {});
    expect(r.gated).toBe(false);
    expect(r.reason).toBe("ship-not-in-completion-contract");
  });
});

describe("shouldGateShipDispatch — prerequisite completeness", () => {
  it("all prerequisites done → not gated", () => {
    const r = gate([
      t("EPIC", null, "in_progress", { type: "epic" }),
      t("D1", "agentcore_hub_backend_dev", "done"),
      t("Q1", "agentcore_hub_qa_verifier", "done"),
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(false);
    expect(r.reason).toBe("prereqs-complete");
  });

  it("an open dev prerequisite → gated on it", () => {
    const r = gate([
      t("D1", "agentcore_hub_backend_dev", "in_progress"),
      t("Q1", "agentcore_hub_qa_verifier", "done"),
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(true);
    expect(r.reason).toBe("prereqs-incomplete");
    expect(r.repairBlocker).toBe("D1");
    expect(r.blockers).toEqual(["D1"]);
  });

  it("cancelled prerequisite counts as terminal (not a blocker)", () => {
    const r = gate([
      t("D1", "agentcore_hub_backend_dev", "cancelled"),
      t("Q1", "agentcore_hub_qa_verifier", "done"),
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(false);
  });

  it("open EPIC never gates ship (epics excluded)", () => {
    const r = gate([
      t("EPIC", null, "in_progress", { type: "epic" }),
      t("D1", "agentcore_hub_backend_dev", "done"),
      t("Q1", "agentcore_hub_qa_verifier", "done"),
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(false);
  });

  it("a sibling ship-phase ticket (e.g. CD/gate) never gates ship (ship excluded from prereqs)", () => {
    const r = gate([
      t("D1", "agentcore_hub_backend_dev", "done"),
      t("CD", "agentcore_hub_release_manager", "ready"), // another ship-phase ticket, still open
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(false);
  });

  it("an open, unclassifiable-phase ticket (human gate) never gates (fail-safe)", () => {
    const r = gate([
      t("D1", "agentcore_hub_backend_dev", "done"),
      t("Q1", "agentcore_hub_qa_verifier", "done"),
      t("GATE", "human:alice", "ready"), // getAgentPhase → undefined
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(false);
    expect(r.reason).toBe("prereqs-complete");
  });

  it("required phase with no tickets present is ignored (never wedges on absent work)", () => {
    // completion contract requires verification, but this run spawned no QA
    // ticket at all — the only open work is dev, which IS present.
    const r = gate([
      t("D1", "agentcore_hub_backend_dev", "done"),
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(false);
    // verification/review absent → prereqPhases only reflects present dev
    expect(r.prereqPhases).toEqual(["development"]);
  });
});

describe("shouldGateShipDispatch — repairBlocker selection", () => {
  it("prefers a verification/CI prerequisite over a dev one", () => {
    const r = gate([
      t("D1", "agentcore_hub_backend_dev", "in_progress"),
      t("Q1", "agentcore_hub_qa_verifier", "ready"),
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(true);
    expect(r.repairBlocker).toBe("Q1"); // verification ranks above development
    expect(new Set(r.blockers)).toEqual(new Set(["D1", "Q1"]));
  });

  it("no preferred phase → picks the most recently touched blocker", () => {
    const r = gate([
      t("D1", "agentcore_hub_backend_dev", "in_progress", { updatedAt: "2026-09-05T00:00:00Z" }),
      t("D2", "agentcore_hub_backend_dev", "in_progress", { updatedAt: "2026-09-05T02:00:00Z" }),
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(true);
    expect(r.repairBlocker).toBe("D2"); // later updatedAt
  });

  it("phaseOf falls back to getAgentPhase(assignee) when ticket.phase is absent", () => {
    // no explicit .phase on any ticket → all resolved via getAgentPhase
    const r = gate([
      t("Q1", "agentcore_hub_qa_verifier", "in_progress"),
      t("SHIP", "agentcore_hub_release_manager", "ready"),
    ]);
    expect(r.gated).toBe(true);
    expect(r.repairBlocker).toBe("Q1");
  });
});

describe("normalizeShipDispatchMode — strict allow-list (opposite of merge-on-green)", () => {
  it("passes off|shadow|enforce", () => {
    expect(normalizeShipDispatchMode("off")).toBe("off");
    expect(normalizeShipDispatchMode("shadow")).toBe("shadow");
    expect(normalizeShipDispatchMode("enforce")).toBe("enforce");
    expect(normalizeShipDispatchMode(" ENFORCE ")).toBe("enforce");
  });
  it("legacy truthy + garbage fail SAFE to off", () => {
    for (const v of ["on", "true", "1", "yes", "xyzzy", "", null, undefined]) {
      expect(normalizeShipDispatchMode(v)).toBe("off");
    }
  });
});

describe("emitShipDispatchMetrics", () => {
  it("emits a single EMF record with the requested counter set to 1", () => {
    const calls = [];
    const spy = console.log;
    console.log = (s) => calls.push(s);
    try {
      emitShipDispatchMetrics("gated", () => 123);
    } finally {
      console.log = spy;
    }
    const rec = JSON.parse(calls[0]);
    expect(rec._aws.Timestamp).toBe(123);
    expect(rec.ShipDispatchGated).toBe(1);
    expect(rec.ShipDispatchWouldGate).toBe(0);
    expect(rec.ShipDispatchClear).toBe(0);
  });
});
