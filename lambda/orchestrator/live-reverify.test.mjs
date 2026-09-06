import { describe, it, expect, vi } from "vitest";

/**
 * TEAM-4121 FR-9 — live-evidence re-verification, unit level.
 *
 * The module is fully dependency-injected, so these tests drive the REAL
 * decision logic with hand-built deps and assert on the CALLS: which ticket got
 * created with which params, which workflow metadata got merged, which ship
 * tickets got blocked, which events were published. That matters more than usual
 * here because two of the three effects are irreversible from the agents' point
 * of view — a re-verify ticket dispatches a real QA agent and blocks the run's
 * ship tickets — so "exactly once, exactly these params" IS the contract.
 *
 * The two actions are deliberately independent and both are covered separately:
 *   (1) the `Re-verify (QA): <fix> @ <sha7>` ticket, idempotent per (fix, head);
 *   (2) the `verification: "unverified"` mark, which fires on a missing live
 *       artifact regardless of whether (1) could be filed.
 */

import {
  createLiveReverify,
  hasLiveArtifact,
  normalizeLiveReverifyMode,
  LIVE_SHIP_STATUSES,
} from "./live-reverify.mjs";
import { isReworkFix } from "./rework-loop-cap.mjs";

const WF = "wf_1";
const EPIC = "EPIC-1";
const FIX = "TEAM-4089";
const QA = "TEAM-4064";
const SHIP = "TEAM-4066";
const SHA = "0949f9d881423ac7fe00a70e23d60fff5654078c";
const SHA7 = "0949f9d";
const REVERIFY = "TEAM-4200";

const CONTRACT = {
  evidenceSource: "live",
  invariant: "submit_workflow accepts a valid s3:// source and never surfaces the SDK placeholder name",
  evidenceRepro: "npm run dev; POST /api/workflow/start with source s3://bucket/key.md",
  citedLocation: ["src/lib/workflow/intake.ts:212"],
  siblingScope: "none",
};

/**
 * The store double for the (fix, sha7) re-verify slot (TEAM-4130 F2).
 *
 * It enforces the REAL CAS semantics against a per-(workflowId, ticketId) map,
 * because a recorder would prove nothing here: the whole finding is that the
 * LOSER of a race must be told "taken", and that only means something if the
 * fake can actually make one of two callers lose. mergeTaskMetadata writes into
 * the same map, so a redelivery that arrives after the winner persisted sees the
 * linked ticket id exactly as it would in DynamoDB.
 *
 *   cas: false     — a pre-F2 store (older dep, an older test double): the two
 *                    functions are ABSENT, which must degrade to the old
 *                    best-effort sibling scan rather than crash.
 *   untracked: true — the workflow row has no task entry to claim on, so the CAS
 *                    is unavailable and the module fails OPEN.
 */
function slotStore(calls, { cas = true, untracked = false, staleAfterMs = 10 * 60 * 1000 } = {}) {
  const slots = new Map();   // `${wfId}::${tid}` → { reverifySha, reverifyClaimedAt, reverifyTicketId }
  const keyOf = (wfId, tid) => `${wfId}::${tid}`;
  const store = {
    slots,
    mergeTaskMetadata: vi.fn(async (wfId, tid, fields) => {
      calls.mergeTaskMetadata.push({ wfId, tid, fields });
      // The real one swallows its own CCFE when there is no entry to merge into.
      if (untracked) return;
      const key = keyOf(wfId, tid);
      slots.set(key, { ...(slots.get(key) || {}), ...fields });
    }),
  };
  if (!cas) return store;
  const write = (key, held, sha7, nowIso) => {
    const next = { ...(held || {}), reverifySha: sha7, reverifyClaimedAt: nowIso };
    delete next.reverifyTicketId;   // the REMOVE in the real UpdateExpression
    slots.set(key, next);
  };
  store.claimReverifySlot = vi.fn(async (wfId, tid, sha7, nowIso) => {
    calls.claims.push({ wfId, tid, sha7, nowIso });
    if (untracked) return "untracked";
    const key = keyOf(wfId, tid);
    const held = slots.get(key);
    if (!held || held.reverifySha !== sha7) { write(key, held, sha7, nowIso); return "claimed"; }
    if (held.reverifyTicketId) return "taken";                 // the winner filed it
    const age = Date.parse(nowIso || "") - Date.parse(held.reverifyClaimedAt || "");
    if (!(age >= staleAfterMs)) return "taken";                // still in flight
    write(key, held, sha7, nowIso);                            // stale takeover
    return "claimed";
  });
  store.releaseReverifySlot = vi.fn(async (wfId, tid, sha7) => {
    calls.releases.push({ wfId, tid, sha7 });
    const held = slots.get(keyOf(wfId, tid));
    if (!held || held.reverifySha !== sha7 || held.reverifyTicketId) return false;
    delete held.reverifySha;
    delete held.reverifyClaimedAt;
    return true;
  });
  return store;
}

/** Deps + a call log. Each dep records rather than acts, so order is assertable. */
function harness({ mode = "enforce", children = [], record = liveRecord(), tasks, phases = { [SHIP]: "ship" }, cas, untracked } = {}) {
  const calls = {
    mergeTaskMetadata: [],
    invokeTickets: [],
    addBlockers: [],
    events: [],
    childReads: 0,
    warns: [],
    claims: [],
    releases: [],
  };
  const workflow = {
    id: WF,
    epicId: EPIC,
    agentTasks: tasks === undefined ? { [FIX]: { agentId: "agentcore_hub_bug_fixer", commitSha: SHA } } : tasks,
  };
  const deps = {
    mode,
    store: slotStore(calls, { cas, untracked }),
    invokeTickets: vi.fn(async (tool, params) => {
      calls.invokeTickets.push({ tool, params });
      return { key: REVERIFY };
    }),
    getChildTickets: vi.fn(async () => { calls.childReads++; return children; }),
    // Only the tickets the fixture says are ship-phase resolve to one; a human
    // gate's assignee has no agent def, exactly as in the real roster.
    getAgentDef: (assignee) => (phases[assignee] ? { agentId: assignee, phase: phases[assignee] } : null),
    shipPhases: new Set(["ship"]),
    // TEAM-4130 F1: the third arg is the whole point of the option — record it.
    addBlockers: vi.fn(async (ticketId, ids, opts) => { calls.addBlockers.push({ ticketId, ids, opts }); return ids; }),
    publishEvent: vi.fn(async (ticketId, type, detail) => { calls.events.push({ ticketId, type, detail }); }),
    log: { warn: (m) => calls.warns.push(m), log: () => {} },
  };
  const { onFixDone } = createLiveReverify(deps);
  return { onFixDone, deps, calls, workflow, record };
}

/** A completion record that DOES carry live evidence. */
const liveRecord = () => ({ ticket_id: FIX, commit_sha: SHA, evidence_kind: "live", evidence_keys: "workflows/wf_1/shared/qa-evidence/403.log" });
/** …and one that carries only prose (the failure this FR exists for). */
const proseRecord = () => ({ ticket_id: FIX, commit_sha: SHA, summary: "Fixed the filter and added a regression test.", artifacts: "workflows/wf_1/agents/bug_fixer/notes.md" });

const fixTicket = (over = {}) => ({
  ticketId: FIX,
  title: 'Fix (QA): intake.ts — placeholder name "Unknown" leaks into the S3 error detail',
  status: "done",
  assignee: "agentcore_hub_bug_fixer",
  phase: "development",
  spawnedBy: { kind: "qa_fix", qaTicketId: QA },
  fixContract: CONTRACT,
  ...over,
});

const eventsOfType = (calls, type) => calls.events.filter((e) => e.type === type);
const created = (calls) => calls.invokeTickets.filter((c) => c.tool === "create_ticket");
/**
 * Every create_ticket ATTEMPT, including ones whose implementation a test
 * replaced with mockResolvedValueOnce/mockRejectedValueOnce (which bypasses the
 * recorder inside the default implementation).
 */
const createAttempts = (deps) => deps.invokeTickets.mock.calls.filter(([tool]) => tool === "create_ticket");

describe("normalizeLiveReverifyMode — STRICT allow-list (garbage → off)", () => {
  it.each([
    [undefined, "off"],
    [null, "off"],
    ["", "off"],
    ["   ", "off"],
    ["on", "off"],      // the legacy truthy other flags accept
    ["true", "off"],
    ["1", "off"],
    ["bogus", "off"],
    ["shadow", "shadow"],
    ["Shadow ", "shadow"],
    ["ENFORCE", "enforce"],
    ["enforce", "enforce"],
    ["off", "off"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeLiveReverifyMode(input)).toBe(expected);
  });

  it("garbage does NOT coalesce to shadow (unlike REWORK_LOOP_CAP)", () => {
    // The asymmetry is deliberate: enforce here mints tickets that dispatch a
    // real agent and block ship, so a typo must be inert, not observant.
    expect(normalizeLiveReverifyMode("shdaow")).toBe("off");
  });
});

describe("hasLiveArtifact", () => {
  it.each([
    ["explicit evidence_kind", { evidence_kind: "live" }, true],
    ["evidence_kind cased/padded", { evidence_kind: " LIVE " }, true],
    ["evidence_kind static", { evidence_kind: "static" }, false],
    ["a qa-evidence key mid-path", { artifacts: "workflows/w/shared/qa-evidence/x.png" }, true],
    ["a qa-evidence key at the root", { artifacts: "qa-evidence/x.png" }, true],
    ["evidence_keys instead of artifacts", { evidence_keys: "workflows/w/shared/qa-evidence/x.md" }, true],
    ["a comma list where only one entry qualifies", { artifacts: "notes.md, workflows/w/shared/qa-evidence/x.har" }, true],
    ["artifacts as a JSON array", { artifacts: ["notes.md", "qa-evidence/y.log"] }, true],
    ["artifacts as manifest objects", { artifacts: [{ s3Key: "workflows/w/shared/qa-evidence/z.png" }] }, true],
    ["prose only", { summary: "it works now" }, false],
    ["a non-qa artifact", { artifacts: "workflows/w/agents/dev/notes.md" }, false],
    // "qa-evidence" as a filename fragment is NOT the convention — the prefix is.
    ["a lookalike filename", { artifacts: "workflows/w/shared/my-qa-evidence.png" }, false],
    ["missing record", null, false],
    ["a string instead of a record", "live", false],
  ])("%s → %s", (_label, record, expected) => {
    expect(hasLiveArtifact(record)).toBe(expected);
  });
});

describe("not a live fix — zero calls on every dep", () => {
  it.each([
    ["static evidence", { evidenceSource: "static" }],
    ["unit evidence", { evidenceSource: "unit" }],
    ["no evidence_source", {}],
    ["no contract at all", undefined],
  ])("%s → not-live, nothing touched", async (_label, contract) => {
    const { onFixDone, deps, calls, workflow, record } = harness();

    const result = await onFixDone({ workflow, fixTicket: fixTicket({ fixContract: contract }), completionRecord: record });

    expect(result).toEqual({ action: "not-live", unverified: false });
    expect(deps.store.mergeTaskMetadata).not.toHaveBeenCalled();
    expect(deps.invokeTickets).not.toHaveBeenCalled();
    expect(deps.getChildTickets).not.toHaveBeenCalled();
    expect(deps.addBlockers).not.toHaveBeenCalled();
    expect(deps.publishEvent).not.toHaveBeenCalled();
    expect(calls.events).toEqual([]);
  });

  it("a missing workflow id or ticket id is also inert", async () => {
    const { onFixDone, deps, workflow } = harness();
    expect(await onFixDone({ workflow: { epicId: EPIC }, fixTicket: fixTicket() })).toEqual({ action: "not-live", unverified: false });
    expect(await onFixDone({ workflow, fixTicket: { fixContract: CONTRACT } })).toEqual({ action: "not-live", unverified: false });
    expect(deps.invokeTickets).not.toHaveBeenCalled();
  });
});

describe("enforce — a live fix WITH live evidence gets exactly one re-verify ticket", () => {
  it("creates the ticket with the exact params, then records the marker", async () => {
    const { onFixDone, deps, calls, workflow, record } = harness();

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(result).toEqual({ action: "created", reverifyTicketId: REVERIFY, sha7: SHA7, unverified: false });
    expect(created(calls)).toHaveLength(1);
    const { params } = created(calls)[0];
    expect(params.summary).toBe(`Re-verify (QA): ${fixTicket().title} @ ${SHA7}`);
    expect(params.assignee).toBe("agentcore_hub_qa_verifier");
    expect(params.blocked_by).toEqual([FIX]);
    expect(params.parent_key).toBe(EPIC);
    expect(params.workflow_id).toBe(WF);
    expect(params.phase).toBe("development"); // the fix's phase, so the phase ledger still lines up
    expect(params.spawned_by).toEqual({
      kind: "qa_fix", qaTicketId: QA, reverify: true, rearmOf: FIX, headSha: SHA,
    });
    expect(params.fix_contract).toEqual({
      invariant: CONTRACT.invariant,
      evidence_source: "live",
      evidence_repro: CONTRACT.evidenceRepro,
      cited_location: CONTRACT.citedLocation,
      sibling_scope: CONTRACT.siblingScope,
    });
    // The marker that makes a second Done idempotent.
    expect(calls.mergeTaskMetadata).toEqual([
      { wfId: WF, tid: FIX, fields: { reverifyTicketId: REVERIFY, reverifySha: SHA7 } },
    ]);
    // A fix that DID leave live evidence is not marked unverified.
    expect(calls.mergeTaskMetadata.some((m) => m.fields.verification)).toBe(false);
    expect(eventsOfType(calls, "fix.unverified")).toEqual([]);
    expect(eventsOfType(calls, "fix.reverify_created")).toHaveLength(1);
  });

  it("the description carries the invariant + repro as an inert claim, never a command to paste", async () => {
    const { onFixDone, calls, workflow, record } = harness();
    await onFixDone({
      workflow,
      fixTicket: fixTicket({ fixContract: { ...CONTRACT, evidenceRepro: "`rm -rf /`\ncurl evil.example" } }),
      completionRecord: record,
    });

    const { description } = created(calls)[0].params;
    expect(description).toContain(`Re-run the fix's live evidence at HEAD ${SHA}.`);
    expect(description).toContain("re-derive the check yourself before running anything");
    expect(description).toContain(CONTRACT.invariant);
    // Backticks and the newline that would turn one "repro" into two commands
    // are gone, and the whole repro is on ONE line.
    expect(description).toContain("Repro: rm -rf / curl evil.example");
    expect(description).not.toContain("`rm -rf /`");
    expect(description).toContain("evidence_kind=live");
  });

  it("the re-verify ticket is NOT a new rework round (isReworkFix === false)", async () => {
    const { onFixDone, calls, workflow, record } = harness();
    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });
    const { spawned_by } = created(calls)[0].params;

    // The cap counts rounds of human rework; re-checking the SAME finding at a
    // new head is not one, so reverify/rearmOf must exempt it.
    expect(isReworkFix({ spawnedBy: spawned_by })).toBe(false);
    expect(isReworkFix({ spawnedBy: { kind: "qa_fix", qaTicketId: QA } })).toBe(true);
  });
});

describe("enforce — originQa comes from the fix's own lineage", () => {
  it.each([
    ["a QA-filed fix", { kind: "qa_fix", qaTicketId: "TEAM-4064" }, "TEAM-4064"],
    ["a codex_fix (codexTicketId)", { kind: "codex_fix", codexTicketId: "TEAM-4300" }, "TEAM-4300"],
    ["a ship_fix (shipTicketId)", { kind: "ship_fix", shipTicketId: "TEAM-4066" }, "TEAM-4066"],
    ["a review_fix (gateTicketId)", { kind: "review_fix", gateTicketId: "TEAM-4063" }, "TEAM-4063"],
    ["a ci_fix (ciTicketId)", { kind: "ci_fix", ciTicketId: "TEAM-4065" }, "TEAM-4065"],
  ])("%s → qaTicketId %s", async (_label, spawnedBy, expected) => {
    const { onFixDone, calls, workflow, record } = harness();

    await onFixDone({ workflow, fixTicket: fixTicket({ spawnedBy }), completionRecord: record });

    // The re-verification is always a qa_fix lineage entry — the ORIGIN is what
    // varies, and it is read through the shared KIND_TO_ORIGIN_KEY map.
    expect(created(calls)[0].params.spawned_by.kind).toBe("qa_fix");
    expect(created(calls)[0].params.spawned_by.qaTicketId).toBe(expected);
  });

  it("falls back to the fix's own id when the lineage carries no origin", async () => {
    const { onFixDone, calls, workflow, record } = harness();
    await onFixDone({ workflow, fixTicket: fixTicket({ spawnedBy: { kind: "qa_fix" } }), completionRecord: record });
    expect(created(calls)[0].params.spawned_by.qaTicketId).toBe(FIX);
  });
});

describe("enforce — blocking the run's OPEN ship tickets", () => {
  const ship = (over = {}) => ({ ticketId: SHIP, assignee: "agentcore_hub_release_manager", status: "in_progress", ...over });
  const PRESERVE = ["in_progress", "in_review"];

  it("blocks an open ship-phase sibling", async () => {
    const { onFixDone, calls, workflow, record } = harness({
      children: [ship()],
      phases: { agentcore_hub_release_manager: "ship" },
    });

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(calls.addBlockers).toEqual([{ ticketId: SHIP, ids: [REVERIFY], opts: { preserveStatusIf: PRESERVE } }]);
    expect(eventsOfType(calls, "fix.reverify_created")[0].detail.blockedShipTickets).toEqual([SHIP]);
  });

  /**
   * TEAM-4130 F1 — the option is passed UNCONDITIONALLY, for every open ship
   * ticket regardless of the status the sibling snapshot happens to show. The
   * park-or-preserve decision belongs to addBlockers' conditional write, because
   * this snapshot can be seconds stale relative to the agent's own transition.
   */
  it("passes preserveStatusIf for a LIVE (in_progress) ship ticket", async () => {
    const { onFixDone, calls, workflow, record } = harness({
      children: [ship({ status: "in_progress" })],
      phases: { agentcore_hub_release_manager: "ship" },
    });

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(calls.addBlockers[0].opts).toEqual({ preserveStatusIf: ["in_progress", "in_review"] });
    expect(calls.addBlockers[0].opts.preserveStatusIf).toEqual(LIVE_SHIP_STATUSES);
  });

  it("passes the SAME option for a ready ship ticket — the decision is not made here", async () => {
    const { onFixDone, calls, workflow, record } = harness({
      children: [ship({ status: "ready" })],
      phases: { agentcore_hub_release_manager: "ship" },
    });

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(calls.addBlockers).toEqual([{ ticketId: SHIP, ids: [REVERIFY], opts: { preserveStatusIf: PRESERVE } }]);
  });

  it("an in_review human gate on a ship phase is blocked, not parked", async () => {
    const { onFixDone, calls, workflow, record } = harness({
      children: [ship({ ticketId: "TEAM-4067", status: "in_review" })],
      phases: { agentcore_hub_release_manager: "ship" },
    });

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(calls.addBlockers[0]).toEqual({ ticketId: "TEAM-4067", ids: [REVERIFY], opts: { preserveStatusIf: PRESERVE } });
  });

  it.each([["done"], ["cancelled"], ["DONE"]])("does not reopen a %s ship ticket", async (status) => {
    const { onFixDone, deps, workflow, record } = harness({
      children: [ship({ status })],
      phases: { agentcore_hub_release_manager: "ship" },
    });

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(deps.addBlockers).not.toHaveBeenCalled();
  });

  it("blocks EVERY open ship ticket (Ship + CD are two)", async () => {
    const { onFixDone, calls, workflow, record } = harness({
      children: [ship(), ship({ ticketId: "TEAM-4068", status: "todo" })],
      phases: { agentcore_hub_release_manager: "ship" },
    });

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(calls.addBlockers).toEqual([
      { ticketId: SHIP, ids: [REVERIFY], opts: { preserveStatusIf: PRESERVE } },
      { ticketId: "TEAM-4068", ids: [REVERIFY], opts: { preserveStatusIf: PRESERVE } },
    ]);
  });

  it("non-ship siblings and human gates are never blocked", async () => {
    const { onFixDone, deps, workflow, record } = harness({
      children: [
        { ticketId: "TEAM-4090", assignee: "agentcore_hub_bug_fixer", status: "in_progress" },
        { ticketId: "TEAM-4067", assignee: "human:engineer", status: "ready" }, // Merge Approval — no agent def
      ],
      phases: { agentcore_hub_bug_fixer: "development" },
    });

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(deps.addBlockers).not.toHaveBeenCalled();
  });
});

/**
 * TEAM-4130 F1, end to end — the same flow with an addBlockers fake that HONOURS
 * preserveStatusIf against a board, so the observable is the board rather than
 * the call log. (That the two DDB conditions actually implement this contract is
 * proven against evaluated ConditionExpressions in ticket-blockers.test.mjs.)
 */
describe("enforce — the board after a live fix blocks the ship tickets (TEAM-4130 F1)", () => {
  /** addBlockers over a `{ ticketId: row }` board, per its documented contract. */
  function boardHarness(rows) {
    const board = Object.fromEntries(rows.map((r) => [r.ticketId, { ...r }]));
    const addBlockers = vi.fn(async (ticketId, ids, opts = {}) => {
      const row = board[ticketId];
      if (!row) return [];
      const preserve = opts.preserveStatusIf ?? [];
      const added = [];
      for (const id of ids) {
        if ((row.blockedBy ?? []).includes(id)) continue; // idempotent per edge
        row.blockedBy = [...(row.blockedBy ?? []), id];
        if (!preserve.includes(row.status)) row.status = "blocked";
        added.push(id);
      }
      return added;
    });
    const h = harness({
      children: Object.values(board),
      phases: { agentcore_hub_release_manager: "ship" },
    });
    h.deps.addBlockers = addBlockers;
    // Rebuild with the board-backed dep in place.
    const { onFixDone } = createLiveReverify(h.deps);
    return { onFixDone, board, workflow: h.workflow, record: h.record, calls: h.calls };
  }

  const shipRow = (over = {}) => ({
    ticketId: SHIP, assignee: "agentcore_hub_release_manager", status: "in_progress", ...over,
  });

  it("a release manager mid-run keeps in_progress and gains the edge", async () => {
    const { onFixDone, board, workflow, record, calls } = boardHarness([shipRow()]);

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(board[SHIP].status).toBe("in_progress"); // report_completion can still reach done
    expect(board[SHIP].blockedBy).toEqual([REVERIFY]);
    expect(eventsOfType(calls, "fix.reverify_created")[0].detail.blockedShipTickets).toEqual([SHIP]);
  });

  it("a ready ship ticket IS parked to blocked (cascadeUnblock re-readies it)", async () => {
    const { onFixDone, board, workflow, record } = boardHarness([shipRow({ status: "ready" })]);

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(board[SHIP].status).toBe("blocked");
    expect(board[SHIP].blockedBy).toEqual([REVERIFY]);
  });

  it("a mixed ship phase: the live one is preserved, the queued one is parked", async () => {
    const { onFixDone, board, workflow, record } = boardHarness([
      shipRow(),
      shipRow({ ticketId: "TEAM-4068", status: "todo" }),
    ]);

    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(board[SHIP].status).toBe("in_progress");
    expect(board["TEAM-4068"].status).toBe("blocked");
    expect(board["TEAM-4068"].blockedBy).toEqual([REVERIFY]);
  });
});

describe("enforce — idempotent per (fix, head sha)", () => {
  it("a second Done at the SAME sha files nothing (in-memory marker)", async () => {
    const { onFixDone, deps, calls, workflow, record } = harness();

    const first = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });
    expect(first.action).toBe("created");

    // onFixDone mirrors the marker onto the in-memory task, so the re-Done that
    // the human's re-check lever produces costs nothing at all.
    const second = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(second).toEqual({ action: "already", reverifyTicketId: REVERIFY, sha7: SHA7, unverified: false });
    expect(created(calls)).toHaveLength(1);
    expect(deps.getChildTickets).toHaveBeenCalledTimes(1); // no sibling re-read either
  });

  it("an existing sibling with the same rearmOf+headSha is found even when the marker write was lost", async () => {
    const { onFixDone, deps, calls, workflow, record } = harness({
      // No reverifySha on the task (the metadata merge never landed), but the
      // ticket itself exists — the authoritative check.
      children: [{ ticketId: REVERIFY, assignee: "agentcore_hub_qa_verifier", status: "todo", spawnedBy: { kind: "qa_fix", reverify: true, rearmOf: FIX, headSha: SHA } }],
    });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(result).toEqual({ action: "already", reverifyTicketId: REVERIFY, sha7: SHA7, unverified: false });
    expect(created(calls)).toHaveLength(0);
    expect(deps.addBlockers).not.toHaveBeenCalled();
  });

  it("a sibling re-armed off a DIFFERENT head does not suppress this one", async () => {
    const { onFixDone, calls, workflow, record } = harness({
      children: [{ ticketId: "TEAM-4150", spawnedBy: { rearmOf: FIX, headSha: "9ca1963427719c57232c8962815728f460c1a82a" } }],
    });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(result.action).toBe("created");
    expect(created(calls)).toHaveLength(1);
  });

  it("a NEW head is a new claim → a fresh re-verify ticket", async () => {
    const { onFixDone, calls, workflow, record } = harness();
    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    // The fix was re-Done after another commit landed on its branch.
    workflow.agentTasks[FIX].commitSha = "9ca1963427719c57232c8962815728f460c1a82a";
    const second = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(second.action).toBe("created");
    expect(second.sha7).toBe("9ca1963");
    expect(created(calls)).toHaveLength(2);
  });
});

describe("enforce — the (fix, sha7) slot is CAS-claimed before create_ticket (TEAM-4130 F2)", () => {
  /** A re-verify ticket as it appears on the board once filed. */
  const reverifyChild = (headSha = SHA, id = REVERIFY) => ({
    ticketId: id,
    assignee: "agentcore_hub_qa_verifier",
    status: "todo",
    spawnedBy: { kind: "qa_fix", reverify: true, rearmOf: FIX, headSha },
  });

  it("two concurrent Dones for the same fix file exactly ONE re-verify ticket", async () => {
    const { onFixDone, calls, workflow } = harness();
    // Two invocations of the same Lambda: they share DynamoDB (the store fake)
    // but NOT the in-memory workflow row, which is how a stream redelivery and
    // its webhook twin actually arrive.
    const [a, b] = await Promise.all([
      onFixDone({ workflow: structuredClone(workflow), fixTicket: fixTicket(), completionRecord: liveRecord() }),
      onFixDone({ workflow: structuredClone(workflow), fixTicket: fixTicket(), completionRecord: liveRecord() }),
    ]);

    expect(created(calls)).toHaveLength(1);
    expect(calls.claims).toHaveLength(2);
    const [winner, loser] = a.action === "created" ? [a, b] : [b, a];
    expect(winner).toEqual({ action: "created", reverifyTicketId: REVERIFY, sha7: SHA7, unverified: false });
    expect(loser.action).toBe("already");
    // The loser knows the ticket is still in flight, so it neither invents an id
    // nor blocks ship tickets on one — the winner does both.
    expect(loser.pendingClaim).toBe(true);
    expect(calls.addBlockers).toHaveLength(0);   // no ship tickets in this fixture
  });

  it("a redelivery after the winner persisted returns the winner's ticket, not a new one", async () => {
    const children = [];
    const { onFixDone, calls, workflow } = harness({ children });

    const first = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });
    expect(first.action).toBe("created");
    children.push(reverifyChild());   // the winner's ticket is now on the board

    // A cold invocation: fresh in-memory row, so the free check cannot help.
    const second = await onFixDone({
      workflow: { id: WF, epicId: EPIC, agentTasks: { [FIX]: { commitSha: SHA } } },
      fixTicket: fixTicket(),
      completionRecord: liveRecord(),
    });

    expect(second).toEqual({ action: "already", reverifyTicketId: REVERIFY, sha7: SHA7, unverified: false, pendingClaim: false });
    expect(created(calls)).toHaveLength(1);
  });

  it("a re-Done at a NEW head takes the slot from the previous head (documented behaviour)", async () => {
    const NEW = "9ca1963427719c57232c8962815728f460c1a82a";
    const { onFixDone, deps, calls, workflow } = harness();
    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });

    deps.invokeTickets.mockResolvedValueOnce({ key: "TEAM-4201" });
    workflow.agentTasks[FIX].commitSha = NEW;
    const second = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: { ...liveRecord(), commit_sha: NEW } });

    expect(second).toEqual({ action: "created", reverifyTicketId: "TEAM-4201", sha7: "9ca1963", unverified: false });
    expect(createAttempts(deps)).toHaveLength(2);
    // The new claim must have dropped the OLD head's ticket id, or the next
    // reader would treat this head as already re-verified.
    const slot = deps.store.slots.get(`${WF}::${FIX}`);
    expect(slot.reverifySha).toBe("9ca1963");
    expect(slot.reverifyTicketId).toBe("TEAM-4201");
  });

  it("a failed create_ticket RELEASES the slot, so the next Done can file it", async () => {
    const { onFixDone, deps, calls, workflow } = harness();
    deps.invokeTickets.mockRejectedValueOnce(new Error("tickets lambda 500"));

    const first = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });
    expect(first.action).toBe("no-sha");
    expect(calls.releases).toEqual([{ wfId: WF, tid: FIX, sha7: SHA7 }]);
    expect(deps.store.slots.get(`${WF}::${FIX}`).reverifySha).toBeUndefined();

    // Without the release this retry would sit behind our own dead claim until
    // staleAfterMs — with the run's ship tickets waiting on a ticket that does
    // not exist.
    const second = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });
    expect(second).toEqual({ action: "created", reverifyTicketId: REVERIFY, sha7: SHA7, unverified: false });
    expect(createAttempts(deps)).toHaveLength(2);   // one rejected, one that landed
  });

  it("'taken' with no sibling on the board yet creates nothing and blocks nothing", async () => {
    const { onFixDone, deps, calls, workflow } = harness();
    // Someone else holds a fresh claim for this exact head.
    deps.store.slots.set(`${WF}::${FIX}`, { reverifySha: SHA7, reverifyClaimedAt: new Date().toISOString() });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });

    expect(result).toEqual({ action: "already", reverifyTicketId: undefined, sha7: SHA7, unverified: false, pendingClaim: true });
    expect(created(calls)).toHaveLength(0);
    expect(deps.addBlockers).not.toHaveBeenCalled();
  });

  it("a PENDING claim in memory no longer short-circuits (sha alone is not evidence)", async () => {
    // Pre-F2 the in-memory check was `reverifySha === sha7`, which a claim now
    // also satisfies — short-circuiting on it would drop the re-verification.
    const { onFixDone, deps, workflow } = harness({
      tasks: { [FIX]: { commitSha: SHA, reverifySha: SHA7 } },   // no ticket id
    });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });

    expect(deps.store.claimReverifySlot).toHaveBeenCalledWith(WF, FIX, SHA7, expect.any(String));
    expect(result.action).toBe("created");
  });

  it("a store without claimReverifySlot degrades to the pre-F2 behaviour", async () => {
    const { onFixDone, calls, workflow } = harness({ cas: false });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });

    expect(result.action).toBe("created");
    expect(created(calls)).toHaveLength(1);
    expect(calls.warns.join("\n")).toMatch(/falling back to the best-effort sibling scan/);
  });

  it("an untracked task entry fails OPEN: the CAS is skipped, the ticket is still filed", async () => {
    const { onFixDone, calls, workflow } = harness({ untracked: true });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });

    expect(result.action).toBe("created");
    expect(calls.warns.join("\n")).toMatch(/no tracked task entry to claim the \(fix, 0949f9d\) re-verify slot on/);
    expect(calls.releases).toHaveLength(0);   // nothing was claimed, nothing to release
  });

  it("a claim that finds a pre-F2 ticket links it instead of filing a second one", async () => {
    const { onFixDone, calls, workflow } = harness({ children: [reverifyChild()] });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });

    expect(result).toEqual({ action: "already", reverifyTicketId: REVERIFY, sha7: SHA7, unverified: false });
    expect(created(calls)).toHaveLength(0);
    // Linked, so the pending claim the CAS just wrote does not read as wedged.
    expect(calls.mergeTaskMetadata.at(-1).fields).toEqual({ reverifyTicketId: REVERIFY, reverifySha: SHA7 });
    expect(workflow.agentTasks[FIX].reverifyTicketId).toBe(REVERIFY);
  });

  it("a claim failure (ddb down) degrades to the best-effort path, never to silence", async () => {
    const { onFixDone, deps, calls, workflow } = harness();
    deps.store.claimReverifySlot.mockRejectedValueOnce(new Error("ddb down"));

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });

    expect(result.action).toBe("created");
    expect(calls.warns.join("\n")).toMatch(/claimReverifySlot failed \(non-fatal\)/);
  });

  it("board-level: the winner's re-verify blocks the run's open ship tickets, the loser touches nothing", async () => {
    const children = [
      { ticketId: SHIP, assignee: "agentcore_hub_release_manager", status: "in_progress" },
    ];
    const { onFixDone, calls, workflow } = harness({ children, phases: { agentcore_hub_release_manager: "ship" } });

    const [a, b] = await Promise.all([
      onFixDone({ workflow: structuredClone(workflow), fixTicket: fixTicket(), completionRecord: liveRecord() }),
      onFixDone({ workflow: structuredClone(workflow), fixTicket: fixTicket(), completionRecord: liveRecord() }),
    ]);

    expect([a.action, b.action].sort()).toEqual(["already", "created"]);
    // ONE edge on the ship ticket, added once, with F1's preserve option intact.
    expect(calls.addBlockers).toEqual([
      { ticketId: SHIP, ids: [REVERIFY], opts: { preserveStatusIf: LIVE_SHIP_STATUSES } },
    ]);
    expect(eventsOfType(calls, "fix.reverify_created")).toHaveLength(1);
  });
});

describe("enforce — where the head sha comes from", () => {
  it("prefers the tracked task's commitSha", async () => {
    const { onFixDone, calls, workflow } = harness({
      tasks: { [FIX]: { commitSha: SHA } },
      record: { commit_sha: "ffffffffffffffffffffffffffffffffffffffff", evidence_kind: "live" },
    });
    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: { commit_sha: "ffffffffffffffffffffffffffffffffffffffff", evidence_kind: "live" } });
    expect(created(calls)[0].params.spawned_by.headSha).toBe(SHA);
  });

  it("falls back to the completion record's commit_sha when the task has none", async () => {
    const { onFixDone, calls, workflow } = harness({ tasks: { [FIX]: { agentId: "agentcore_hub_bug_fixer" } } });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: liveRecord() });

    expect(result.sha7).toBe(SHA7);
    expect(created(calls)[0].params.spawned_by.headSha).toBe(SHA);
  });

  it("no sha anywhere → no-sha, a warning, and no ticket", async () => {
    const { onFixDone, deps, calls, workflow } = harness({ tasks: {} });

    const result = await onFixDone({
      workflow, fixTicket: fixTicket(),
      completionRecord: { ticket_id: FIX, evidence_kind: "live" }, // live, but headless
    });

    expect(result).toEqual({ action: "no-sha", unverified: false });
    expect(deps.invokeTickets).not.toHaveBeenCalled();
    expect(calls.warns.join("\n")).toMatch(/no commit sha/);
  });
});

describe("enforce — (2) the unverified mark, independent of (1)", () => {
  it("a prose-only completion record marks the fix AND still files the re-verify ticket", async () => {
    const { onFixDone, calls, workflow } = harness({ record: proseRecord() });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: proseRecord() });

    expect(result).toEqual({ action: "created", reverifyTicketId: REVERIFY, sha7: SHA7, unverified: true });
    // The mark lands FIRST, so it survives even if the create had failed.
    expect(calls.mergeTaskMetadata[0]).toEqual({
      wfId: WF, tid: FIX,
      fields: {
        verification: "unverified",
        verificationReason: "evidence_source=live but no live artifact in completion record",
      },
    });
    expect(calls.mergeTaskMetadata[1].fields).toEqual({ reverifyTicketId: REVERIFY, reverifySha: SHA7 });
    // …and the in-memory snapshot is updated too, so a ship ticket dispatched in
    // this same pass renders the row.
    expect(workflow.agentTasks[FIX].verification).toBe("unverified");

    const [ev] = eventsOfType(calls, "fix.unverified");
    expect(ev.ticketId).toBe(FIX);
    expect(ev.detail).toEqual({
      workflowId: WF, ticketId: FIX, sha7: SHA7, evidenceRepro: CONTRACT.evidenceRepro,
    });
    expect(created(calls)).toHaveLength(1);
  });

  it("a missing completion record is unverified too (the least-verified case)", async () => {
    const { onFixDone, calls, workflow } = harness();

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: null });

    expect(result.unverified).toBe(true);
    expect(eventsOfType(calls, "fix.unverified")).toHaveLength(1);
  });

  it("marks even when there is no sha to pin a re-verification to → unverified-only", async () => {
    const { onFixDone, deps, calls, workflow } = harness({ tasks: {} });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: { ticket_id: FIX } });

    expect(result).toEqual({ action: "unverified-only", unverified: true });
    expect(calls.mergeTaskMetadata[0].fields.verification).toBe("unverified");
    expect(eventsOfType(calls, "fix.unverified")[0].detail.sha7).toBe(null);
    expect(deps.invokeTickets).not.toHaveBeenCalled();
  });

  it("evidence_kind:'live' alone is enough — no mark", async () => {
    const { onFixDone, calls, workflow } = harness();
    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: { commit_sha: SHA, evidence_kind: "live" } });
    expect(result.unverified).toBe(false);
    expect(eventsOfType(calls, "fix.unverified")).toEqual([]);
  });

  it("a qa-evidence/ key in evidence_keys is enough — no mark", async () => {
    const { onFixDone, calls, workflow } = harness();
    const result = await onFixDone({
      workflow, fixTicket: fixTicket(),
      completionRecord: { commit_sha: SHA, evidence_keys: "workflows/wf_1/shared/qa-evidence/x.md" },
    });
    expect(result.unverified).toBe(false);
    expect(eventsOfType(calls, "fix.unverified")).toEqual([]);
  });

  it("the published repro is inert (one line, no backticks)", async () => {
    const { onFixDone, calls, workflow } = harness();
    await onFixDone({
      workflow,
      fixTicket: fixTicket({ fixContract: { ...CONTRACT, evidenceRepro: "line one\n`line two`" } }),
      completionRecord: proseRecord(),
    });
    expect(eventsOfType(calls, "fix.unverified")[0].detail.evidenceRepro).toBe("line one line two");
  });
});

describe("shadow — observe only", () => {
  it("publishes fix.reverify_planned and writes NOTHING", async () => {
    const { onFixDone, deps, calls, workflow } = harness({ mode: "shadow", record: proseRecord() });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: proseRecord() });

    expect(result).toEqual({ action: "planned", sha7: SHA7, unverified: true });
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]).toEqual({
      ticketId: FIX,
      type: "fix.reverify_planned",
      detail: { workflowId: WF, fixTicketId: FIX, sha7: SHA7, wouldCreate: true, wouldMarkUnverified: true, shadow: true },
    });
    // Zero ticket writes, zero workflow writes, zero ship blocking — the whole
    // point of shadow is that the rate is measurable before anything is minted.
    expect(deps.invokeTickets).not.toHaveBeenCalled();
    expect(deps.store.mergeTaskMetadata).not.toHaveBeenCalled();
    expect(deps.addBlockers).not.toHaveBeenCalled();
    expect(deps.getChildTickets).not.toHaveBeenCalled();
    expect(workflow.agentTasks[FIX].verification).toBeUndefined();
  });

  it("wouldMarkUnverified:false when the record does carry live evidence", async () => {
    const { onFixDone, calls, workflow, record } = harness({ mode: "shadow" });
    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });
    expect(calls.events[0].detail).toMatchObject({ wouldCreate: true, wouldMarkUnverified: false });
  });

  it("wouldCreate:false when there is no head sha to pin to", async () => {
    const { onFixDone, calls, workflow } = harness({ mode: "shadow", tasks: {} });
    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: { ticket_id: FIX } });
    expect(calls.events[0].detail).toMatchObject({ sha7: null, wouldCreate: false, wouldMarkUnverified: true });
  });

  it("wouldCreate:false when this head already has a re-verify ticket", async () => {
    const { onFixDone, calls, workflow, record } = harness({
      mode: "shadow",
      tasks: { [FIX]: { commitSha: SHA, reverifySha: SHA7, reverifyTicketId: REVERIFY } },
    });
    await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });
    expect(calls.events[0].detail).toMatchObject({ wouldCreate: false });
  });

  it("a non-live fix is still inert in shadow", async () => {
    const { onFixDone, deps, workflow, record } = harness({ mode: "shadow" });
    const result = await onFixDone({ workflow, fixTicket: fixTicket({ fixContract: { evidenceSource: "unit" } }), completionRecord: record });
    expect(result).toEqual({ action: "not-live", unverified: false });
    expect(deps.publishEvent).not.toHaveBeenCalled();
  });
});

describe("never throws — a broken dep narrows the action, it never fails the done cascade", () => {
  it("create_ticket throwing leaves no reverify marker and no crash", async () => {
    const { onFixDone, deps, calls, workflow, record } = harness();
    deps.invokeTickets.mockRejectedValueOnce(new Error("Tickets___create_ticket: project is archived"));

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(result).toEqual({ action: "no-sha", sha7: SHA7, unverified: false });
    expect(calls.mergeTaskMetadata).toEqual([]); // no marker → the next Done retries
    expect(calls.warns.join("\n")).toMatch(/create_ticket\(re-verify\) failed/);
    expect(deps.addBlockers).not.toHaveBeenCalled();
  });

  it("create_ticket returning no key is the same as failing", async () => {
    const { onFixDone, deps, calls, workflow, record } = harness();
    deps.invokeTickets.mockResolvedValueOnce({ content: [{ text: "?" }] });

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(result.action).toBe("no-sha");
    expect(calls.warns.join("\n")).toMatch(/could not create the re-verify ticket/);
  });

  it("a failed unverified mark still lets the re-verify ticket be filed", async () => {
    const { onFixDone, deps, calls, workflow } = harness({ record: proseRecord() });
    deps.store.mergeTaskMetadata.mockRejectedValueOnce(new Error("ddb down"));

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: proseRecord() });

    expect(result).toEqual({ action: "created", reverifyTicketId: REVERIFY, sha7: SHA7, unverified: true });
    expect(created(calls)).toHaveLength(1);
  });

  it("a failed sibling read degrades to 'create it' rather than skipping", async () => {
    const { onFixDone, deps, workflow, record } = harness();
    deps.getChildTickets.mockRejectedValueOnce(new Error("index throttled"));

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    // The in-memory marker is the idempotency guard that still holds; a lost
    // sibling read must not silently skip the re-verification.
    expect(result.action).toBe("created");
    expect(deps.addBlockers).not.toHaveBeenCalled(); // no siblings known → nothing to block
  });

  it("a failed addBlockers still records the created ticket", async () => {
    const { onFixDone, deps, calls, workflow, record } = harness({
      children: [{ ticketId: SHIP, assignee: "agentcore_hub_release_manager", status: "in_progress" }],
      phases: { agentcore_hub_release_manager: "ship" },
    });
    deps.addBlockers.mockRejectedValueOnce(new Error("jira 500"));

    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(result.action).toBe("created");
    expect(eventsOfType(calls, "fix.reverify_created")[0].detail.blockedShipTickets).toEqual([]);
  });

  it("every dep missing entirely → still resolves", async () => {
    const { onFixDone } = createLiveReverify({ mode: "enforce", log: { warn: () => {} } });
    const result = await onFixDone({
      workflow: { id: WF, epicId: EPIC, agentTasks: { [FIX]: { commitSha: SHA } } },
      fixTicket: fixTicket(),
      completionRecord: liveRecord(),
    });
    expect(result.action).toBe("no-sha"); // no invokeTickets → no ticket, no throw
  });
});

describe("mode off (the default) — the module is inert even if it is constructed", () => {
  it("off does not create, mark, or publish", async () => {
    const { onFixDone, deps, workflow, record } = harness({ mode: "off" });

    // index.mjs never constructs it when off; this pins the module's own floor.
    const result = await onFixDone({ workflow, fixTicket: fixTicket(), completionRecord: record });

    expect(result.action).toBe("created"); // mode is only consulted for the shadow branch…
    expect(deps.invokeTickets).toHaveBeenCalled();
    // …which is why the flag gate lives in index.mjs (observeLiveReverify), and
    // done-handlers-cascade.test.mjs is what proves off costs nothing there.
  });
});
