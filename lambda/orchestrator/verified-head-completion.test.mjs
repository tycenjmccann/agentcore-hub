import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  CI_AGENT_ID,
  GATE_PERSONA_IDS,
  QA_VERIFIER_ID,
  evaluateVerifiedHeads,
  normalizeHeadSha,
} from "./completion.mjs";
import { GATE_PERSONAS, normalizeSha, resolveTestedHead } from "./verdict-contract.mjs";
import {
  claimCompletionBlocked,
  completionBlockedKey,
  initWorkflowStore,
} from "./workflow-store.mjs";

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
 * ─── The claim: exactly one escalation per refused head triple ────────────────
 *
 * The gate runs on every completion attempt, and a refused run keeps attempting
 * (the reconcile sweep, the next ticket done, a redelivered stream record). Without
 * a CAS the operator gets one manager escalation per attempt; with one keyed on the
 * REASON only, a run that moves to a new set of heads never re-escalates. So the
 * key is the head triple, and the store test below pins both halves.
 */
describe("completionBlockedKey", () => {
  const heads = { qa: "12e9ac6", ci: "12e9ac6", pr: "001259d" };

  it("is stable for the same heads", () => {
    expect(completionBlockedKey(heads)).toBe(completionBlockedKey({ ...heads }));
    expect(completionBlockedKey(heads)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when ANY head changes", () => {
    const base = completionBlockedKey(heads);
    expect(completionBlockedKey({ ...heads, qa: "933ea6f" })).not.toBe(base);
    expect(completionBlockedKey({ ...heads, ci: "933ea6f" })).not.toBe(base);
    expect(completionBlockedKey({ ...heads, pr: "933ea6f" })).not.toBe(base);
  });

  it("distinguishes an unknown head from an empty one only by position", () => {
    expect(completionBlockedKey({ qa: null, ci: null, pr: "001259d" }))
      .not.toBe(completionBlockedKey({ qa: "001259d", ci: null, pr: null }));
    expect(completionBlockedKey({ qa: null, ci: null, pr: null })).toBe(completionBlockedKey({}));
    expect(completionBlockedKey(undefined)).toBe(completionBlockedKey({}));
  });

  it("normalizes case and whitespace, so one head cannot be two keys", () => {
    expect(completionBlockedKey({ qa: " 12E9AC6 ", ci: "", pr: "" })).toBe(completionBlockedKey({ qa: "12e9ac6" }));
  });
});

describe("claimCompletionBlocked", () => {
  /** One row, real condition semantics: re-claiming the SAME key loses the CAS. */
  let row;
  const stub = {
    async send(cmd) {
      if (cmd instanceof GetCommand) return { Item: row };
      if (cmd instanceof UpdateCommand) {
        const key = cmd.input.ExpressionAttributeValues[":key"];
        if (!row || row.completionBlockedKey === key) {
          const err = new Error("conditional check failed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        row.completionBlockedKey = key;
        row.completionBlockedAt = cmd.input.ExpressionAttributeValues[":now"];
        return {};
      }
      return {};
    },
  };

  beforeEach(() => {
    row = { workflowId: "wf_1" };
    initWorkflowStore(stub, "workflows-test");
  });

  const KEY = completionBlockedKey({ qa: "12e9ac6", ci: "12e9ac6", pr: "001259d" });

  it("claims once and reports `taken` on every later attempt at the same heads", async () => {
    expect(await claimCompletionBlocked("wf_1", KEY, "2026-01-01T00:00:00Z")).toBe("claimed");
    expect(await claimCompletionBlocked("wf_1", KEY, "2026-01-01T00:01:00Z")).toBe("taken");
    expect(await claimCompletionBlocked("wf_1", KEY, "2026-01-01T00:02:00Z")).toBe("taken");
  });

  it("re-arms when the heads move — a new triple is a new refusal", async () => {
    expect(await claimCompletionBlocked("wf_1", KEY, "2026-01-01T00:00:00Z")).toBe("claimed");
    const moved = completionBlockedKey({ qa: "001259d", ci: "12e9ac6", pr: "001259d" });
    expect(await claimCompletionBlocked("wf_1", moved, "2026-01-01T00:03:00Z")).toBe("claimed");
    expect(await claimCompletionBlocked("wf_1", moved, "2026-01-01T00:04:00Z")).toBe("taken");
  });

  it("records the key and the time on the row, and nothing else", async () => {
    await claimCompletionBlocked("wf_1", KEY, "2026-01-01T00:00:00Z");
    expect(row).toEqual({
      workflowId: "wf_1",
      completionBlockedKey: KEY,
      completionBlockedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("returns `untracked` when there is no workflow row to claim on", async () => {
    row = null;
    expect(await claimCompletionBlocked("wf_1", KEY, "2026-01-01T00:00:00Z")).toBe("untracked");
  });

  it("rethrows anything that is not a lost condition", async () => {
    initWorkflowStore({ async send() { const e = new Error("throttled"); e.name = "ProvisionedThroughputExceededException"; throw e; } }, "workflows-test");
    await expect(claimCompletionBlocked("wf_1", KEY, "2026-01-01T00:00:00Z")).rejects.toThrow("throttled");
  });
});
