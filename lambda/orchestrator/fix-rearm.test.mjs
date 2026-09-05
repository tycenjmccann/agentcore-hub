import { describe, it, expect, vi } from "vitest";
import {
  spawnFixTicketsFromFindings,
  rearmVerification,
  findingId,
  finderKind,
} from "./fix-tickets.mjs";

/**
 * TEAM-3992 D3.1/D3.2 — the orchestrator's fix-ticket spawn + SHA-pinned re-arm.
 *
 * Both functions are fully dependency-injected (the tickets-Lambda invoke, event
 * publish, child read, def/roster lookups), so the real logic runs here with no
 * AWS and no network — the same seam the orchestrator wires in runFixTicketMachinery.
 *
 * Pinned behaviors:
 *   spawn — one fix ticket per component, deterministic findingId dedupe against
 *     existing siblings, assigned to the dev agent, blocked_by the finder, with a
 *     by:"orchestrator" fix_spawned event.
 *   re-arm — one Re-verify ticket per role the fix kind re-arms, PINNED to the
 *     fix's final commit SHA; QA re-verify additionally blocked_by the review
 *     re-verify (D3.2); Ship blocked on the re-arm tickets; never re-arm a re-arm;
 *     no SHA → no re-arm.
 */

const DEF = {
  id: "software-delivery",
  ticketDag: {
    fixRearm: {
      review_fix: ["review", "ci"],
      qa_fix: ["review", "ci", "verification"],
      codex_fix: ["review", "ci"],
      shipBlockedByRearmed: true,
    },
    nodes: {
      review: { agentIds: ["agentcore_hub_code_reviewer"] },
      ci: { agentIds: ["agentcore_hub_ci_agent"] },
      verification: { agentIds: ["agentcore_hub_qa_verifier"] },
      ship: { agentIds: ["agentcore_hub_release_manager"] },
    },
  },
};

const AGENT_PHASE = {
  agentcore_hub_code_reviewer: "review",
  agentcore_hub_ci_agent: "review",
  agentcore_hub_qa_verifier: "verification",
  agentcore_hub_release_manager: "ship",
};

const WF = { id: "wf_1", epicId: "EPIC-1", workflowDefId: "software-delivery" };

/** A deps double that records ticket creates, blocker-adds, and events. */
function makeDeps({ children = [], headSha = null, def = DEF } = {}) {
  const creates = [];
  const blockerAdds = [];
  const events = [];
  let n = 0;
  return {
    creates, blockerAdds, events,
    invokeTickets: vi.fn(async (op, params) => {
      if (op === "create_ticket") {
        const id = `NEW-${++n}`;
        creates.push({ id, params });
        return { ticket_id: id };
      }
      if (op === "add_blockers") {
        blockerAdds.push(params);
        return { status: "ok" };
      }
      return {};
    }),
    publishEvent: vi.fn(async (epicId, type, detail) => events.push({ epicId, type, detail })),
    getChildTickets: vi.fn(async () => children),
    getWorkflowDef: vi.fn(() => def),
    getAgentDef: vi.fn((id) => ({ phase: AGENT_PHASE[id] })),
    resolveDevAssignee: vi.fn(() => "agentcore_hub_backend_dev"),
    commitShaOf: vi.fn(() => headSha),
  };
}

describe("spawnFixTicketsFromFindings (D3.1)", () => {
  const finder = { ticketId: "TEAM-19", assignee: "agentcore_hub_code_reviewer", phase: "review" };

  it("creates one fix ticket per component, assigned to dev, blocked_by the finder, deterministically keyed", async () => {
    const deps = makeDeps();
    const completion = {
      findings: [
        { component: "auth", severity: "high", summary: "null deref", files: ["a.ts"] },
        { component: "auth", summary: "missing guard", files: ["b.ts"] },
        { component: "api", summary: "bad status code", files: ["c.ts"] },
      ],
    };
    const created = await spawnFixTicketsFromFindings(WF, finder, completion, deps);
    expect(created.map((c) => c.component).sort()).toEqual(["api", "auth"]);
    expect(deps.creates).toHaveLength(2);

    const auth = deps.creates.find((c) => c.params.spawned_by.findingId === findingId("TEAM-19", "auth"));
    expect(auth.params.assignee).toBe("agentcore_hub_backend_dev");
    expect(auth.params.blocked_by).toEqual(["TEAM-19"]);
    expect(auth.params.phase).toBe("review");
    expect(auth.params.parent_key).toBe("EPIC-1");
    expect(auth.params.spawned_by).toMatchObject({
      kind: "review_fix", gateTicketId: "TEAM-19", by: "orchestrator", findingId: findingId("TEAM-19", "auth"),
    });
    // Both same-component findings collapse into one ticket's summary.
    expect(auth.params.summary).toMatch(/null deref/);
    expect(auth.params.summary).toMatch(/missing guard/);

    // One by:"orchestrator" fix_spawned event per created ticket.
    const spawned = deps.events.filter((e) => e.type === "orchestrator.fix_spawned");
    expect(spawned).toHaveLength(2);
    expect(spawned.every((e) => e.detail.by === "orchestrator")).toBe(true);
  });

  it("dedupes against a sibling that already answers the same (origin, component)", async () => {
    const existing = { ticketId: "OLD", spawnedBy: { kind: "review_fix", findingId: findingId("TEAM-19", "auth") } };
    const deps = makeDeps({ children: [existing] });
    const created = await spawnFixTicketsFromFindings(WF, finder, {
      findings: [{ component: "auth", summary: "x" }, { component: "api", summary: "y" }],
    }, deps);
    expect(created.map((c) => c.component)).toEqual(["api"]); // auth already spawned
    expect(deps.creates).toHaveLength(1);
  });

  it("a blank component falls into the 'general' bucket", async () => {
    const deps = makeDeps();
    const created = await spawnFixTicketsFromFindings(WF, finder, { findings: [{ summary: "no component" }] }, deps);
    expect(created[0].component).toBe("general");
    expect(deps.creates[0].params.spawned_by.findingId).toBe(findingId("TEAM-19", "general"));
  });

  it("no findings, or a finder that is not a verifier, spawns nothing", async () => {
    const deps = makeDeps();
    expect(await spawnFixTicketsFromFindings(WF, finder, { findings: [] }, deps)).toEqual([]);
    expect(await spawnFixTicketsFromFindings(WF, { ticketId: "T", assignee: "agentcore_hub_backend_dev" }, { findings: [{ component: "x", summary: "y" }] }, deps)).toEqual([]);
    expect(deps.creates).toHaveLength(0);
  });

  it("finderKind maps each verifier to its fix kind", () => {
    expect(finderKind("agentcore_hub_code_reviewer")).toBe("review_fix");
    expect(finderKind("agentcore_hub_qa_verifier")).toBe("qa_fix");
    expect(finderKind("agentcore_hub_codex")).toBe("codex_fix");
    expect(finderKind("agentcore_hub_backend_dev")).toBeNull();
  });
});

describe("rearmVerification (D3.2)", () => {
  const SHA = "abcdef1234567890";
  const reviewFix = { ticketId: "FIX-1", title: "Fix (auth): null deref", spawnedBy: { kind: "review_fix", gateTicketId: "TEAM-19" } };
  const qaFix = { ticketId: "FIX-2", title: "Fix (api): bad code", spawnedBy: { kind: "qa_fix", qaTicketId: "TEAM-30" } };

  it("review_fix → one Re-verify per re-armed role, SHA-pinned and blocked_by the fix", async () => {
    const deps = makeDeps({ headSha: SHA });
    const { created } = await rearmVerification(WF, reviewFix, deps);
    expect(created.map((c) => c.role)).toEqual(["review", "ci"]);

    const review = deps.creates.find((c) => c.params.spawned_by.role === "review");
    expect(review.params.assignee).toBe("agentcore_hub_code_reviewer");
    expect(review.params.blocked_by).toEqual(["FIX-1"]);
    expect(review.params.summary).toContain("@ abcdef1"); // sha7 in the title
    expect(review.params.spawned_by).toMatchObject({
      kind: "review_fix", gateTicketId: "TEAM-19", rearmOf: "FIX-1", headSha: SHA, role: "review",
    });
    const rearmed = deps.events.filter((e) => e.type === "orchestrator.verification_rearmed");
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0].detail.headSha).toBe(SHA);
  });

  it("qa_fix → verification re-verify is additionally blocked_by the review re-verify (D3.2)", async () => {
    const deps = makeDeps({ headSha: SHA });
    const { created } = await rearmVerification(WF, qaFix, deps);
    expect(created.map((c) => c.role)).toEqual(["review", "ci", "verification"]);
    const reviewId = created.find((c) => c.role === "review").ticketId;
    const verification = deps.creates.find((c) => c.params.spawned_by.role === "verification");
    // The re-QA must see the re-REVIEWED code.
    expect(verification.params.blocked_by).toEqual(["FIX-2", reviewId]);
    expect(verification.params.assignee).toBe("agentcore_hub_qa_verifier");
  });

  it("blocks the Ship ticket on the freshly-created re-arm tickets", async () => {
    const ship = { ticketId: "SHIP-1", assignee: "agentcore_hub_release_manager", title: "Ship: deliver" };
    const deps = makeDeps({ headSha: SHA, children: [ship] });
    const { created, shipTicketId } = await rearmVerification(WF, reviewFix, deps);
    expect(shipTicketId).toBe("SHIP-1");
    expect(deps.blockerAdds).toHaveLength(1);
    expect(deps.blockerAdds[0]).toEqual({ ticket_id: "SHIP-1", blocked_by: created.map((c) => c.ticketId) });
  });

  it("never re-arms a re-arm ticket", async () => {
    const deps = makeDeps({ headSha: SHA });
    const rearm = { ticketId: "RA-1", spawnedBy: { kind: "review_fix", rearmOf: "FIX-1", role: "review", headSha: SHA } };
    const res = await rearmVerification(WF, rearm, deps);
    expect(res.created).toEqual([]);
    expect(deps.creates).toHaveLength(0);
  });

  it("no harvested commit SHA → no re-arm (cannot pin a verification to nothing)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ headSha: null });
    const res = await rearmVerification(WF, reviewFix, deps);
    expect(res.created).toEqual([]);
    expect(deps.creates).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/no commit sha/i);
    warn.mockRestore();
  });

  it("dedupes: an existing re-verify for (fix, role, sha) is not created twice", async () => {
    const existing = { ticketId: "RA-old", spawnedBy: { kind: "review_fix", rearmOf: "FIX-1", role: "review", headSha: SHA } };
    const deps = makeDeps({ headSha: SHA, children: [existing] });
    const { created } = await rearmVerification(WF, reviewFix, deps);
    expect(created.map((c) => c.role)).toEqual(["ci"]); // review already re-armed
  });

  it("a non-fix ticket kind re-arms nothing", async () => {
    const deps = makeDeps({ headSha: SHA });
    const res = await rearmVerification(WF, { ticketId: "T", spawnedBy: { kind: "task" } }, deps);
    expect(res.created).toEqual([]);
  });
});
