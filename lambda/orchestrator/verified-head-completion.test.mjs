import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CI_AGENT_ID,
  GATE_PERSONA_IDS,
  QA_VERIFIER_ID,
  evaluateVerifiedHeads,
  normalizeHeadSha,
} from "./completion.mjs";
import { GATE_PERSONAS, normalizeSha, resolveTestedHead } from "./verdict-contract.mjs";

/**
 * FR-D1.9 — the verified-head completion gate (TEAM-4246 D1).
 *
 * wf_1788731227559_dowtdh published `workflow.complete` five seconds after a fix
 * ticket landed at a head nothing had verified. Every gate the run passed through
 * asks about ONE ticket at a time — the evidence gate wants an output, the ship
 * verdict gate wants a merge commit — so nobody ever asked the only question that
 * would have caught it: is the head the gate personas certified the head we are
 * shipping?
 *
 * The heads below are NOT typed out. They are read out of the vendored dossier
 * (`deploy/workflow-manager/toolkit/fixtures/dowtdh-dossier.json`) and run through
 * the SAME resolveTestedHead the harvest uses, because the point of this test is
 * that the real run diverges — a hand-written trio of SHAs would only prove the
 * comparison operator works.
 *
 * The open-fix cases use literal boards: the dossier's ticket projection carries
 * no `spawnedBy` (that run was jira-mode, where the kind lives in a label), so
 * there is no fix-kind marker in the fixture to drive them from.
 */

/**
 * ─── Harness for the WIRING half (the bottom describe) ───────────────────────
 *
 * index.mjs is imported for real and only its I/O seams are mocked — the same
 * harness completion-gates.test.mjs uses for the other two completion gates,
 * because gate #3's whole contract is about the order it runs in relative to them.
 *
 * Two deliberate departures from that file's mock set:
 *   - workflow-store.mjs is a PARTIAL mock (importOriginal). `completionBlockedKey`
 *     stays the real one, so the escalation ids and the claim key asserted below are
 *     the values production computes; only the seams that talk to DynamoDB are
 *     replaced. `claimCompletionBlocked` gets a one-row in-memory CAS with the real
 *     tri-state — the DDB expression itself is pinned in workflow-store.test.mjs.
 *   - completion.mjs is a partial mock too, purely to SPY on evaluateVerifiedHeads:
 *     "off pays nothing" is a claim about the call not happening, and no event or
 *     write can prove that on its own.
 *
 * ARTIFACT_BUCKET is left UNSET on purpose (unlike completion-gates): every task
 * entry below already carries evidence, so the record fallback must never read S3,
 * and an unset bucket makes that structural rather than incidental.
 */
const h = vi.hoisted(() => ({
  state: {
    /** Children per parentId-index query; the last one repeats once exhausted. */
    snapshots: /** @type {any[][]} */ ([]),
    queries: 0,
    freshWorkflow: /** @type {any} */ (null),
    getWorkflowThrows: false,
    storeCompletions: /** @type {any[]} */ ([]),
    finalized: /** @type {string[]} */ ([]),
    terminalClaims: /** @type {any[]} */ ([]),
    ebEvents: /** @type {any[]} */ ([]),
    notifications: /** @type {any[]} */ ([]),
    merges: /** @type {any[]} */ ([]),
    /** Every create_ticket the re-verify path fired, in order. */
    createdTickets: /** @type {any[]} */ ([]),
    /** Every claimCompletionBlocked attempt + what it returned. */
    blockedClaims: /** @type {any[]} */ ([]),
    /** workflowId → the currently held completion-blocked key (the CAS row). */
    blockedKeys: new Map(),
    blockedRowMissing: false,
    /** `${workflowId}|${ticketId}|${slotSha}` for every re-verify slot held. */
    reverifySlots: new Set(),
    s3Gets: /** @type {any[]} */ ([]),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand { constructor(input) { this.input = input; } }
  class PutCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          if (cmd.constructor.name === "QueryCommand") {
            const i = Math.min(h.state.queries, h.state.snapshots.length - 1);
            h.state.queries += 1;
            return { Items: h.state.snapshots[i] || [] };
          }
          return {}; // event Puts / Updates / Gets — irrelevant here
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      let payload = null;
      try { payload = JSON.parse(cmd.input?.Payload || "{}"); } catch { /* agent invokes */ }
      if (String(payload?.tool_name || "").startsWith("Tickets___create_ticket")) {
        h.state.createdTickets.push(payload.parameters);
        // invokeTickets READS the key back; without it every create looks failed.
        return { Payload: new TextEncoder().encode(JSON.stringify({ key: `RV-${h.state.createdTickets.length}` })) };
      }
      return {};
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

// No bucket is configured, so every loader takes its "absent" path; the keys are
// recorded anyway so a test can assert the record fallback never read one.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      h.state.s3Gets.push(cmd?.input?.Key);
      const e = new Error("The specified key does not exist.");
      e.name = "NoSuchKey";
      throw e;
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send(cmd) { h.state.ebEvents.push(cmd.input); return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("./workflow-store.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initWorkflowStore: vi.fn(() => {}), // called at index.mjs module load
    getWorkflow: vi.fn(async (id) => {
      if (h.state.getWorkflowThrows) throw new Error("workflow read exploded");
      return h.state.freshWorkflow?.id === id ? h.state.freshWorkflow : null;
    }),
    completeWorkflow: vi.fn(async (id, ts) => { h.state.storeCompletions.push({ id, ts }); return true; }),
    claimFinalization: vi.fn(async () => false),
    markFinalized: vi.fn(async (id) => { h.state.finalized.push(id); }),
    claimTerminalOutcome: vi.fn(async (id, outcome, ts, reason) => {
      h.state.terminalClaims.push({ id, outcome, ts, reason: reason ?? null });
      return true;
    }),
    mergeTaskMetadata: vi.fn(async (id, tid, fields) => {
      h.state.merges.push({ wfId: id, tid, fields });
      const tasks = h.state.freshWorkflow?.agentTasks;
      if (tasks) tasks[tid] = { ...(tasks[tid] || { ticketId: tid }), ...fields };
    }),
    appendNotification: vi.fn(async (id, n) => { h.state.notifications.push({ id, n }); }),
    setDelivery: vi.fn(async () => {}), // best-effort side effect on the completing paths
    // The real tri-state, one row deep: same key → taken, moved key → claimed,
    // no row → untracked (which the caller reads fail-open).
    claimCompletionBlocked: vi.fn(async (id, key) => {
      const result = h.state.blockedRowMissing
        ? "untracked"
        : h.state.blockedKeys.get(id) === key ? "taken" : "claimed";
      if (result === "claimed") h.state.blockedKeys.set(id, key);
      h.state.blockedClaims.push({ id, key, result });
      return result;
    }),
    // live-reverify's real mutex, in memory: without it the mocked DDB would say
    // "claimed" forever and a redelivered completion would file a second ticket.
    claimReverifySlot: vi.fn(async (wfId, ticketId, slotSha) => {
      const slot = `${wfId}|${ticketId}|${slotSha}`;
      if (h.state.reverifySlots.has(slot)) return "taken";
      h.state.reverifySlots.add(slot);
      return "claimed";
    }),
    releaseReverifySlot: vi.fn(async (wfId, ticketId, slotSha) => {
      h.state.reverifySlots.delete(`${wfId}|${ticketId}|${slotSha}`);
    }),
  };
});

// Spread of the real module + one spy: every predicate below is still the real
// one, including the gate itself (the spy delegates).
vi.mock("./completion.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, evaluateVerifiedHeads: vi.fn((...args) => actual.evaluateVerifiedHeads(...args)) };
});

const dossier = (name) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../deploy/workflow-manager/toolkit/fixtures/${name}-dossier.json`, import.meta.url)), "utf8"),
  );

const DOWTDH = dossier("dowtdh");

/**
 * The run exactly as the gate will see it AFTER the D1 harvest: the real tickets,
 * the real agentTasks, plus the one field harvestCompletionEvidence now fills from
 * each completion record (`testedHead = resolveTestedHead(record)`). Nothing else
 * is touched — the pre-4246 entries carry no head field at all, which is itself
 * the reason the harvest had to change.
 */
function harvested(d) {
  const agentTasks = JSON.parse(JSON.stringify(d.workflow.agentTasks || {}));
  for (const [ticketId, record] of Object.entries(d.completions || {})) {
    const entry = agentTasks[ticketId];
    if (!entry) continue;
    const testedHead = resolveTestedHead(record);
    if (testedHead) entry.testedHead = testedHead;
  }
  return { children: d.tickets, agentTasks };
}

/** The fixture's own value for a record field — never a retyped SHA. */
const recordHead = (ticketId) => resolveTestedHead(DOWTDH.completions[ticketId]);

describe("evaluateVerifiedHeads — dowtdh, the run this gate exists for", () => {
  const { children, agentTasks } = harvested(DOWTDH);
  let result;
  beforeEach(() => {
    result = evaluateVerifiedHeads(children, agentTasks);
  });

  it("refuses the completion with reason head-divergence", () => {
    expect(result.reason).toBe("head-divergence");
    expect(result.ok).toBe(false);
  });

  it("reports the three heads the run actually produced", () => {
    // QA TEAM-4181 and CI TEAM-4182 both certified the QA EVIDENCE commit; the fix
    // TEAM-4183 then landed the code at a third head, and that is what shipped.
    expect(result.heads.qa).toBe(recordHead("TEAM-4181"));
    expect(result.heads.ci).toBe(recordHead("TEAM-4182"));
    expect(result.heads.pr).toBe(recordHead("TEAM-4183"));
    expect(result.heads.qa.startsWith("12e9ac6")).toBe(true);
    expect(result.heads.ci.startsWith("12e9ac6")).toBe(true);
    expect(result.heads.pr.startsWith("001259d")).toBe(true);
    expect(result.heads.pr).not.toBe(result.heads.qa);
  });

  it("names BOTH verifier personas as stale — neither certified the shipped head", () => {
    expect(result.stalePersonas).toEqual([QA_VERIFIER_ID, CI_AGENT_ID]);
  });

  it("does not derive the PR head from the reviewer's ticket", () => {
    // TEAM-4180 (code_reviewer) recorded 933ea6f — the head it INSPECTED. Counting
    // a gate persona's commitSha as the run's current head would make the
    // comparison self-fulfilling, so the reviewer's head appears nowhere here.
    const reviewerHead = recordHead("TEAM-4180");
    expect(reviewerHead.startsWith("933ea6f")).toBe(true);
    expect(Object.values(result.heads)).not.toContain(reviewerHead);
  });

  it("takes the run's head from a done dev/fix commitSha, never from a mergeCommit", () => {
    // mergeCommit is the integration MERGE object — a different commit from the
    // branch head every persona tested, so comparing against it would report
    // divergence on every merged run. Adding one changes nothing.
    const tasks = JSON.parse(JSON.stringify(agentTasks));
    tasks["TEAM-4183"].mergeCommit = "f".repeat(40); // synthetic: no merge commit exists in this run
    expect(evaluateVerifiedHeads(children, tasks).heads.pr).toBe(recordHead("TEAM-4183"));
  });

  it("passes once the run's head IS the head both verifiers certified", () => {
    // The counterfactual: had QA and CI re-run at TEAM-4183's head, this closes.
    const tasks = JSON.parse(JSON.stringify(agentTasks));
    const shipped = recordHead("TEAM-4183");
    tasks["TEAM-4181"].testedHead = shipped;
    tasks["TEAM-4182"].testedHead = shipped;
    const ok = evaluateVerifiedHeads(children, tasks);
    expect(ok).toMatchObject({ ok: true, reason: null, offenders: [], stalePersonas: [] });
    expect(ok.heads).toEqual({ qa: shipped, ci: shipped, pr: shipped });
  });

  it("sees no head at all before the D1 harvest — which is why the harvest changed", () => {
    // The RAW fixture entries (status complete, a commitSha, no head field) are the
    // pre-4246 state. QA's and CI's heads are unknown there, and unknown is not
    // divergence — the gate cannot refuse a run for a fact nobody recorded.
    const raw = evaluateVerifiedHeads(DOWTDH.tickets, DOWTDH.workflow.agentTasks);
    expect(raw.heads.qa).toBeNull();
    expect(raw.heads.ci).toBeNull();
    expect(raw).toMatchObject({ ok: true, reason: null });
  });
});

describe("evaluateVerifiedHeads — the head-equality rule", () => {
  const A = "aaaaaaa1111111111111111111111111111111aa";
  const B = "bbbbbbb2222222222222222222222222222222bb";
  const qa = (testedHead) => ({ ticketId: "T-1", status: "done", assignee: QA_VERIFIER_ID, type: "task", completedAt: "2026-01-01T01:00:00Z", testedHead });
  const ci = (testedHead) => ({ ticketId: "T-2", status: "done", assignee: CI_AGENT_ID, type: "task", completedAt: "2026-01-01T02:00:00Z", testedHead });
  const dev = (commitSha) => ({ ticketId: "T-3", status: "done", assignee: "agentcore_hub_backend_dev", type: "task", completedAt: "2026-01-01T03:00:00Z", commitSha });
  /** children + agentTasks from one flat list, the way the orchestrator holds them. */
  const board = (...rows) => [
    rows.map(({ ticketId, status, assignee, type }) => ({ ticketId, status, assignee, type })),
    Object.fromEntries(rows.map((r) => [r.ticketId, { ticketId: r.ticketId, agentId: r.assignee, status: "complete", ...r }])),
  ];
  const evaluate = (...rows) => evaluateVerifiedHeads(...board(...rows));

  it("passes when all three heads are the same commit", () => {
    expect(evaluate(qa(A), ci(A), dev(A))).toMatchObject({ ok: true, reason: null });
  });

  it("passes on ONE known head — nothing to compare it against", () => {
    expect(evaluate(dev(A))).toMatchObject({ ok: true, reason: null, heads: { qa: null, ci: null, pr: A } });
    expect(evaluate(qa(A))).toMatchObject({ ok: true, reason: null, heads: { qa: A, ci: null, pr: null } });
  });

  it("passes on two known EQUAL heads, refuses two known DIFFERENT ones", () => {
    expect(evaluate(qa(A), dev(A))).toMatchObject({ ok: true, reason: null });
    expect(evaluate(qa(A), dev(B))).toMatchObject({ ok: false, reason: "head-divergence", stalePersonas: [QA_VERIFIER_ID] });
  });

  it("treats a short sha and the full sha it prefixes as the SAME head", () => {
    // The two conventions genuinely coexist in one run: dowtdh's CI wrote a
    // 40-char head while the reviewer's record carried a 7-char one.
    expect(evaluate(qa(A.slice(0, 7)), ci(A), dev(A))).toMatchObject({ ok: true, reason: null });
    expect(evaluate(qa(A.slice(0, 7)), dev(B.slice(0, 7)))).toMatchObject({ ok: false, reason: "head-divergence" });
  });

  it("with no PR head, two disagreeing verifiers are BOTH stale", () => {
    // There is no majority to appeal to, so neither head can be called current.
    expect(evaluate(qa(A), ci(B))).toMatchObject({
      ok: false,
      reason: "head-divergence",
      stalePersonas: [QA_VERIFIER_ID, CI_AGENT_ID],
    });
  });

  it("names only the persona that disagrees with the PR head", () => {
    expect(evaluate(qa(A), ci(B), dev(B))).toMatchObject({ stalePersonas: [QA_VERIFIER_ID] });
    expect(evaluate(qa(A), ci(B), dev(A))).toMatchObject({ stalePersonas: [CI_AGENT_ID] });
  });

  it("prefers the caller's PR head over any derived one", () => {
    const [children, agentTasks] = board(qa(A), ci(A), dev(A));
    expect(evaluateVerifiedHeads(children, agentTasks, { prHeadSha: B })).toMatchObject({
      ok: false,
      reason: "head-divergence",
      heads: { pr: B },
    });
    // A prHeadSha that is not a SHA is not a head: fall back to the derivation
    // rather than silently reporting "no PR head" and passing.
    expect(evaluateVerifiedHeads(children, agentTasks, { prHeadSha: "HEAD" })).toMatchObject({
      ok: true,
      heads: { pr: A },
    });
  });

  it("takes the NEWEST head each persona declared, by completedAt", () => {
    const early = { ...qa(B), ticketId: "T-1", completedAt: "2026-01-01T01:00:00Z" };
    const late = { ...qa(A), ticketId: "T-9", completedAt: "2026-01-01T09:00:00Z" };
    expect(evaluate(late, early, dev(A))).toMatchObject({ ok: true, heads: { qa: A } });
  });

  it("a head-less later round does not erase the head an earlier one proved", () => {
    // A re-verify ticket that closed without declaring a head certifies nothing;
    // reading it as "QA now has no head" would fail the run OPEN.
    const proved = { ...qa(B), ticketId: "T-1", completedAt: "2026-01-01T01:00:00Z" };
    const headless = { ...qa(undefined), ticketId: "T-9", completedAt: "2026-01-01T09:00:00Z" };
    expect(evaluate(proved, headless, dev(A))).toMatchObject({ ok: false, reason: "head-divergence" });
  });

  it("ignores a ticket that is not done, and one with no task entry", () => {
    const [children, agentTasks] = board(qa(A), dev(B));
    children.find((t) => t.ticketId === "T-3").status = "in_progress";
    expect(evaluateVerifiedHeads(children, agentTasks)).toMatchObject({ ok: true, heads: { pr: null } });
    delete agentTasks["T-1"];
    expect(evaluateVerifiedHeads(children, agentTasks)).toMatchObject({ ok: true, heads: { qa: null } });
  });

  it("returns the inert shape for junk input", () => {
    for (const bad of [undefined, null, [], "nope", 7]) {
      expect(evaluateVerifiedHeads(bad, {})).toEqual({
        ok: true, reason: null, heads: { qa: null, ci: null, pr: null }, offenders: [], stalePersonas: [],
      });
    }
    expect(evaluateVerifiedHeads([qa(A)], "nope")).toMatchObject({ ok: true });
  });

  it("never reads delivery.mode — a handoff run is held to the same heads", () => {
    // The handoff PR is what the owning team reviews, so its head must be verified
    // too. Neither delivery mode is even reachable from here: passing one changes
    // nothing about the answer.
    const [children, agentTasks] = board(qa(A), dev(B));
    const bare = evaluateVerifiedHeads(children, agentTasks);
    expect(bare).toMatchObject({ ok: false, reason: "head-divergence" });
    for (const mode of ["cd", "handoff"]) {
      expect(evaluateVerifiedHeads(children, agentTasks, { delivery: { mode } })).toEqual(bare);
    }
  });
});

describe("evaluateVerifiedHeads — the epic-wide open-fix refusal", () => {
  const HEAD = "c".repeat(7) + "d".repeat(33); // 40 hex, synthetic
  const done = (over) => ({ ticketId: "T-1", status: "done", assignee: "agentcore_hub_backend_dev", type: "task", commitSha: HEAD, completedAt: "2026-01-01T01:00:00Z", ...over });
  const fix = (over = {}) => ({ ticketId: "T-FIX", status: "in_progress", assignee: "agentcore_hub_backend_dev", type: "task", spawnedBy: { kind: "review_fix", gateTicketId: "T-GATE" }, ...over });
  const evaluate = (children) =>
    evaluateVerifiedHeads(children, Object.fromEntries(children.map((t) => [t.ticketId, { ...t, agentId: t.assignee }])));

  it("refuses on an open fix whose phase no def requires — this is the dowtdh shape", () => {
    // isWorkflowComplete only waits on fixes routed under a REQUIRED phase, so a
    // fix carrying a phase the def does not list (or none at all) is invisible to
    // it. dowtdh's def required development/verification/review/ship and closed
    // anyway. This check is deliberately phase-blind.
    const res = evaluate([done(), fix({ phase: "polish" })]);
    expect(res).toMatchObject({ ok: false, reason: "open-fix", offenders: ["T-FIX"], stalePersonas: [] });
    expect(evaluate([done(), fix({ phase: undefined })])).toMatchObject({ reason: "open-fix" });
  });

  it("still reports the heads it compared, so the event says what state was refused", () => {
    expect(evaluate([done(), fix()]).heads.pr).toBe(HEAD);
  });

  it("lists every open fix once, in board order", () => {
    const res = evaluate([done(), fix(), fix({ ticketId: "T-FIX2", spawnedBy: { kind: "qa_fix" } }), fix()]);
    expect(res.offenders).toEqual(["T-FIX", "T-FIX2"]);
  });

  it("ignores a fix that is done or cancelled", () => {
    expect(evaluate([done(), fix({ status: "done" })])).toMatchObject({ ok: true, reason: null });
    expect(evaluate([done(), fix({ status: "cancelled" })])).toMatchObject({ ok: true, reason: null });
  });

  it("ignores an open ticket that is not a fix — that is isWorkflowComplete's job", () => {
    expect(evaluate([done(), { ticketId: "T-2", status: "todo", assignee: "agentcore_hub_backend_dev", type: "task" }]))
      .toMatchObject({ ok: true, reason: null });
    // …including a spawnedBy whose kind is not a FIX_KIND.
    expect(evaluate([done(), fix({ spawnedBy: { kind: "followup" } })])).toMatchObject({ ok: true, reason: null });
  });

  it("an `advisory` label does NOT excuse an open fix (TEAM-4131 F2)", () => {
    // advisoryNeverApplies refuses the label on FIX_KINDS precisely so a
    // user-supplied label cannot bypass the gate the fix exists to hold. The
    // !isAdvisoryTicket clause here is shape-parity with the other gates; on a fix
    // ticket it can never fire.
    expect(evaluate([done(), fix({ labels: ["advisory"] })])).toMatchObject({ ok: false, reason: "open-fix" });
  });

  it("refuses on the open fix BEFORE reporting divergence — the fix is the actionable one", () => {
    const qa = { ticketId: "T-QA", status: "done", assignee: QA_VERIFIER_ID, type: "task", testedHead: "eeeeeee9999999999999999999999999999999ee", completedAt: "2026-01-01T02:00:00Z" };
    expect(evaluate([done(), qa, fix()])).toMatchObject({ reason: "open-fix" });
  });
});

describe("completion.mjs parity mirrors", () => {
  it("normalizeHeadSha agrees with verdict-contract's normalizeSha", () => {
    const table = [
      "933ea6f1f04fc0212b88b84a6fcbe6aa0ce1d052",
      "12e9ac6",
      "  001259D6932C9C870889D74E0AC66673CFD7B49E  ",
      "abc123", "zzzzzzz", "", "HEAD", "8661669497",
      "0123456789012345678901234567890123456789012", null, undefined, 42, {},
    ];
    for (const raw of table) expect(normalizeHeadSha(raw)).toBe(normalizeSha(raw));
  });

  it("GATE_PERSONA_IDS is the same set as verdict-contract's GATE_PERSONAS", () => {
    expect([...GATE_PERSONA_IDS].sort()).toEqual([...GATE_PERSONAS].sort());
    expect(GATE_PERSONA_IDS.has(QA_VERIFIER_ID)).toBe(true);
    expect(GATE_PERSONA_IDS.has(CI_AGENT_ID)).toBe(true);
  });
});

/**
 * ─── The wiring: completeWorkflow's gate #3 ───────────────────────────────────
 *
 * Everything above is the pure predicate. What dowtdh needed is the WIRING: the
 * refusal has to reach `completeWorkflow` before it publishes `workflow.complete`,
 * tell a human exactly once per distinct refusal (the gate re-runs on every done
 * cascade and every reconcile sweep), and leave the run something to act on.
 *
 * The claim key carries the REASON as well as the head triple, because `open-fix`
 * is checked first and therefore MASKS a divergence underneath it: "an open fix at
 * these heads" and "nobody verified these heads" are two different pieces of news
 * about the same triple, and an operator must get both.
 *
 * The direct CAS/key unit tests live in workflow-store.test.mjs (11 of them, down
 * to the UpdateExpression); here the real `completionBlockedKey` is used only to
 * spell out the ids the gate produces.
 */
const VERIFIED = "a".repeat(7) + "1".repeat(33); // 40 hex, synthetic: what QA+CI certified
const SHIPPED = "b".repeat(7) + "2".repeat(33); // 40 hex, synthetic: what the run would ship

/** The fallback roster's phases: dev→development, qa→verification, ci→review. */
const CHILDREN = () => [
  { ticketId: "V-1", assignee: "agentcore_hub_backend_dev", type: "task", status: "done", phase: "development", title: "Implement the feature" },
  { ticketId: "V-2", assignee: QA_VERIFIER_ID, type: "task", status: "done", phase: "verification", title: "QA verification" },
  { ticketId: "V-3", assignee: CI_AGENT_ID, type: "task", status: "done", phase: "review", title: "CI certification" },
];

/**
 * Evidence on every done ticket (so gate #1 passes and no completions/ record is
 * ever read) plus the heads the D1 harvest now fills. The dev commit is the newest
 * entry, so it is the head the run would ship — the dowtdh shape exactly.
 */
const TASKS = ({ qa = VERIFIED, ci = VERIFIED, pr = SHIPPED } = {}) => ({
  "V-1": { ticketId: "V-1", output: "implemented", commitSha: pr, completedAt: "2026-09-06T23:46:55Z" },
  "V-2": { ticketId: "V-2", output: "qa report", testedHead: qa, completedAt: "2026-09-06T23:36:28Z" },
  "V-3": { ticketId: "V-3", output: "ci green", testedHead: ci, completedAt: "2026-09-06T23:42:09Z" },
});

const OPEN_FIX = {
  ticketId: "V-FIX",
  assignee: "agentcore_hub_backend_dev",
  type: "task",
  status: "in_progress",
  phase: "development",
  spawnedBy: { kind: "review_fix", gateTicketId: "V-0" },
};

/** No featureBranch and no repoConfig: nothing here should reach GitHub. */
const WF = { id: "wf_1", phase: "review", workflowDefId: "software-delivery", epicId: "EPIC-1", input: { title: "t" } };

const detailsOfType = (type) =>
  h.state.ebEvents
    .flatMap((i) => i.Entries || [])
    .filter((e) => e.DetailType === type)
    .map((e) => JSON.parse(e.Detail));

describe("completeWorkflow — the verified-head gate (FR-D1.9 wiring)", () => {
  let completeWorkflow;
  let gate; // the evaluateVerifiedHeads spy from the graph index.mjs just loaded
  let completionBlockedKey;

  /**
   * VERIFIED_HEAD_COMPLETION is read at module scope, so the mode has to be set
   * before the import — the same reason completion-gates.test.mjs reloads per test.
   */
  async function loadWith(mode) {
    if (mode === undefined) delete process.env.VERIFIED_HEAD_COMPLETION;
    else process.env.VERIFIED_HEAD_COMPLETION = mode;
    vi.resetModules();
    ({ completeWorkflow } = await import("./index.mjs"));
    ({ evaluateVerifiedHeads: gate } = await import("./completion.mjs"));
    ({ completionBlockedKey } = await import("./workflow-store.mjs"));
    gate.mockClear();
  }

  const escalationId = (reason, heads) =>
    `notif_completion_heads_wf_1_${completionBlockedKey(heads).slice(0, 12)}_${reason}`;

  beforeEach(() => {
    h.state.snapshots = [CHILDREN()];
    h.state.queries = 0;
    h.state.freshWorkflow = { id: "wf_1", agentTasks: TASKS() };
    h.state.getWorkflowThrows = false;
    h.state.storeCompletions.length = 0;
    h.state.finalized.length = 0;
    h.state.terminalClaims.length = 0;
    h.state.ebEvents.length = 0;
    h.state.notifications.length = 0;
    h.state.merges.length = 0;
    h.state.createdTickets.length = 0;
    h.state.blockedClaims.length = 0;
    h.state.blockedKeys.clear();
    h.state.blockedRowMissing = false;
    h.state.reverifySlots.clear();
    h.state.s3Gets.length = 0;
    delete process.env.ARTIFACT_BUCKET;
  });

  afterEach(() => {
    delete process.env.VERIFIED_HEAD_COMPLETION;
  });

  it("enforce + divergence: one completion_blocked, no workflow.complete, one re-verify per stale persona", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadWith("enforce");
    const wf = { ...WF };
    await completeWorkflow(wf);

    // The refusal, once, on the epic — the same target the evidence gate publishes to.
    const blocked = detailsOfType("orchestrator.completion_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      workflowId: "wf_1",
      reason: "head-divergence",
      heads: { qa: VERIFIED, ci: VERIFIED, pr: SHIPPED },
      offenders: [],
      mode: "enforce",
    });

    // …and NO green close: not the claim, not the event, not the finalize.
    expect(h.state.storeCompletions).toHaveLength(0);
    expect(detailsOfType("workflow.complete")).toHaveLength(0);
    expect(h.state.finalized).toHaveLength(0);
    expect(h.state.terminalClaims).toHaveLength(0);
    expect(wf.phase).toBe("review"); // the run is left OPEN, not rewritten
    expect(gate).toHaveBeenCalledTimes(1);

    // One stale-head re-verification per stale persona, pinned to the SHIPPED head.
    expect(h.state.createdTickets).toHaveLength(2);
    expect(h.state.createdTickets.map((t) => t.assignee)).toEqual([QA_VERIFIER_ID, CI_AGENT_ID]);
    for (const [i, t] of h.state.createdTickets.entries()) {
      expect(t.spawned_by).toMatchObject({
        rearmOf: ["V-2", "V-3"][i],
        headSha: SHIPPED,
        reverify: true,
        round: 1,
      });
      expect(t.spawned_by.kind).toBe(["qa_fix", "ci_fix"][i]);
      expect(t.summary).toContain(SHIPPED.slice(0, 7));
      expect(t.blocked_by).toEqual([]); // nothing to wait for: the fix already landed
      expect(t.parent_key).toBe("EPIC-1");
      expect(t.description).toContain("tested_head=");
    }
    expect(detailsOfType("fix.reverify_created")).toHaveLength(2);

    // One escalation a human can read, keyed on (reason, heads).
    expect(h.state.notifications).toHaveLength(1);
    const n = h.state.notifications[0].n;
    expect(n.type).toBe("manager_escalation");
    expect(n.id).toBe(escalationId("head-divergence", { qa: VERIFIED, ci: VERIFIED, pr: SHIPPED }));
    expect(n.acknowledged).toBe(false);
    expect(n.details).toContain(`pr=${SHIPPED}`);
    expect(n.details).toContain("VERIFIED_HEAD_COMPLETION=off");

    expect(error.mock.calls.some((c) => String(c[0]).includes("CompletionRejectedUnverifiedHead"))).toBe(true);
    // Every task entry already carried its evidence, so gate #1 read no records.
    expect(h.state.s3Gets).toEqual([]);
    error.mockRestore();
  });

  it("the same refusal twice (twin delivery / reconcile sweep) adds no event and no ticket", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadWith("enforce");
    await completeWorkflow({ ...WF });
    await completeWorkflow({ ...WF });

    expect(h.state.blockedClaims.map((c) => c.result)).toEqual(["claimed", "taken"]);
    expect(detailsOfType("orchestrator.completion_blocked")).toHaveLength(1);
    expect(h.state.notifications).toHaveLength(1);
    expect(h.state.createdTickets).toHaveLength(2); // the re-verify slots are held
    expect(h.state.storeCompletions).toHaveLength(0);
    expect(gate).toHaveBeenCalledTimes(2); // the gate still RAN — it just said it once
    error.mockRestore();
  });

  it("open-fix: refused with reason open-fix, and nothing is dispatched for it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.snapshots = [[...CHILDREN(), OPEN_FIX]];
    await loadWith("enforce");
    await completeWorkflow({ ...WF });

    const blocked = detailsOfType("orchestrator.completion_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ reason: "open-fix", offenders: ["V-FIX"] });
    expect(h.state.storeCompletions).toHaveLength(0);
    // No re-verification: closing the fix re-enters completion by itself, and a
    // re-verify filed now would only have to be re-filed at the fix's head.
    expect(h.state.createdTickets).toHaveLength(0);
    expect(h.state.notifications[0].n.title).toContain("fix tickets still open");
    expect(h.state.notifications[0].n.details).toContain("V-FIX");
    error.mockRestore();
  });

  it("open-fix then divergence at the SAME heads are two distinct refusals", async () => {
    // Why the reason is part of the claim key: the open fix hid the divergence, so
    // a key on the triple alone would have told the operator only the first half.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const board = [...CHILDREN(), OPEN_FIX];
    h.state.snapshots = [board];
    await loadWith("enforce");
    await completeWorkflow({ ...WF });

    // The fix closes with evidence (or gate #1 would reject first) but WITHOUT a
    // commit of its own → the same head triple, a new reason.
    board[3].status = "done";
    h.state.freshWorkflow.agentTasks["V-FIX"] = { ticketId: "V-FIX", output: "fix applied" };
    await completeWorkflow({ ...WF });

    const blocked = detailsOfType("orchestrator.completion_blocked");
    expect(blocked.map((e) => e.reason)).toEqual(["open-fix", "head-divergence"]);
    expect(blocked[0].heads).toEqual(blocked[1].heads);
    const heads = { qa: VERIFIED, ci: VERIFIED, pr: SHIPPED };
    expect(h.state.notifications.map((x) => x.n.id)).toEqual([
      escalationId("open-fix", heads),
      escalationId("head-divergence", heads),
    ]);
    expect(h.state.storeCompletions).toHaveLength(0);
    expect(h.state.createdTickets).toHaveLength(2); // only the divergence pass files any
    error.mockRestore();
  });

  it("shadow: the refusal is observed and the run still completes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadWith("shadow");
    const wf = { ...WF };
    await completeWorkflow(wf);

    const blocked = detailsOfType("orchestrator.completion_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ reason: "head-divergence", mode: "shadow" });
    // Today's path, unchanged: claimed, published, finalized…
    expect(h.state.storeCompletions).toHaveLength(1);
    expect(detailsOfType("workflow.complete")).toHaveLength(1);
    expect(h.state.finalized).toEqual(["wf_1"]);
    expect(wf.phase).toBe("complete");
    // …and NOTHING is written to the board: shadow observes, it does not remediate.
    expect(h.state.createdTickets).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("would be blocked on head-divergence (shadow)"))).toBe(true);
    warn.mockRestore();
  });

  it("off: the gate is never even called and completion is byte-identical to pre-4246", async () => {
    await loadWith("off");
    const wf = { ...WF };
    await completeWorkflow(wf);

    expect(gate).not.toHaveBeenCalled();
    expect(h.state.blockedClaims).toHaveLength(0);
    expect(detailsOfType("orchestrator.completion_blocked")).toHaveLength(0);
    expect(h.state.notifications).toHaveLength(0);
    expect(h.state.createdTickets).toHaveLength(0);
    expect(h.state.storeCompletions).toHaveLength(1);
    expect(detailsOfType("workflow.complete")).toHaveLength(1);
    expect(wf.phase).toBe("complete");
  });

  it("heads that agree complete under enforce, with no event and no ticket", async () => {
    h.state.freshWorkflow = { id: "wf_1", agentTasks: TASKS({ qa: SHIPPED, ci: SHIPPED }) };
    await loadWith("enforce");
    await completeWorkflow({ ...WF });

    expect(gate).toHaveBeenCalledTimes(1);
    expect(detailsOfType("orchestrator.completion_blocked")).toHaveLength(0);
    expect(h.state.blockedClaims).toHaveLength(0);
    expect(h.state.createdTickets).toHaveLength(0);
    expect(h.state.storeCompletions).toHaveLength(1);
    expect(detailsOfType("workflow.complete")).toHaveLength(1);
  });

  it("enforce: the gate throwing HOLDS the completion (unlike gates #1 and #2)", async () => {
    // The one place this gate's failure mode differs from the two above it: they
    // fail OPEN because they can only prove a run never shipped, while this one is
    // the only check that the shipped head was verified. A check that cannot run
    // has proven nothing, so under enforce it must hold.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.getWorkflowThrows = true;
    await loadWith("enforce");
    await completeWorkflow({ ...WF });

    expect(h.state.storeCompletions).toHaveLength(0);
    expect(detailsOfType("workflow.complete")).toHaveLength(0);
    expect(h.state.createdTickets).toHaveLength(0);
    expect(error.mock.calls.some((c) => String(c[0]).includes("verified-head gate failed"))).toBe(true);
    // Gate #1 still fails open on the same exception — the contrast is the point.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("evidence check skipped"))).toBe(true);
    error.mockRestore();
    warn.mockRestore();
  });

  it("shadow: the gate throwing does not hold anything", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.getWorkflowThrows = true;
    await loadWith("shadow");
    await completeWorkflow({ ...WF });

    expect(h.state.storeCompletions).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("verified-head check skipped"))).toBe(true);
    warn.mockRestore();
  });

  it("an untracked claim row still tells the story (fail-open, as the slot CAS does)", async () => {
    // No workflow row to CAS on must not mean silence: an operator with a held run
    // and no escalation has nothing to act on. Same reading live-reverify gives it.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.blockedRowMissing = true;
    await loadWith("enforce");
    await completeWorkflow({ ...WF });
    await completeWorkflow({ ...WF });

    expect(h.state.blockedClaims.map((c) => c.result)).toEqual(["untracked", "untracked"]);
    expect(detailsOfType("orchestrator.completion_blocked")).toHaveLength(2);
    expect(h.state.storeCompletions).toHaveLength(0);
    error.mockRestore();
  });

  it("an unrecognized mode is OFF, not enforce — a typo cannot hold every run", async () => {
    await loadWith("enfrce");
    await completeWorkflow({ ...WF });
    expect(gate).not.toHaveBeenCalled();
    expect(h.state.storeCompletions).toHaveLength(1);
  });

  it("the mode defaults to shadow when the var is unset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadWith(undefined);
    await completeWorkflow({ ...WF });
    expect(detailsOfType("orchestrator.completion_blocked")).toHaveLength(1);
    expect(h.state.storeCompletions).toHaveLength(1);
    warn.mockRestore();
  });
});
