import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizeEscalationMode,
  redactText,
  clipText,
  selectChildren,
  createDeadSessionEscalation,
} from "./dead-session-escalation.mjs";

/**
 * TEAM-4120 FR-3 — the dead-session escalation tree (page → synthesize → park).
 *
 * Fully dependency-injected, so every case here runs with vi.fn stubs and a
 * fixed clock: no AWS, no network, no index.mjs. What these pin:
 *   - the mode normalizer's fail-safe direction (present-but-garbage → SHADOW,
 *     the opposite of the gate/ship guards — the dangerous failure here is
 *     doing nothing about a dead run);
 *   - the redaction table, one assertion per pattern, plus the ORDER contract
 *     (redact before clip, or a secret straddling the clip boundary survives);
 *   - child selection against the REAL yteqfl ticket set, including what the
 *     design's literal "empty blockedBy" rule would have missed;
 *   - the decision order, where "evidence" is deliberately narrow: a stale or
 *     blank completion record is NOT evidence, and an agent-reported error
 *     outranks children;
 *   - shadow writes exactly one thing (the page) and nothing else;
 *   - and that NO dep failure can make escalateExhausted reject — it runs
 *     inside a sweep that must still finish its other candidates.
 */

const NOW = Date.parse("2026-09-01T12:00:00Z");
const NOW_ISO = new Date(NOW).toISOString();
const CLAIM_STARTED = "2026-09-01T06:00:00Z";
const TID = "TEAM-1";
const AGENT = "agentcore_hub_backend_dev";

const workflow = () => ({
  id: "wf_1",
  epicId: "EPIC-1",
  repoConfig: { repos: [{ url: "https://github.com/tycenjmccann/agentcore-hub" }] },
  agentTasks: { [TID]: { status: "error", startedAt: CLAIM_STARTED } },
});

const claim = (over = {}) => ({
  startedAt: CLAIM_STARTED,
  lastHeartbeatAt: "2026-09-01T06:05:00Z",
  source: "dead-session-detector",
  ...over,
});

/** Every dep a vi.fn, defaults = "no evidence anywhere" (→ the park branch). */
function deps(over = {}) {
  const store = {
    appendNotification: vi.fn(async () => {}),
    mergeTaskMetadata: vi.fn(async () => {}),
    resetDeadSessionRetry: vi.fn(async () => true),
    claimDeadSessionSynthesis: vi.fn(async () => true),
  };
  const lease = {
    lastStreamedText: vi.fn(async () => ""),
    hasAgentErrorSince: vi.fn(async () => false),
  };
  const d = {
    mode: "enforce",
    store,
    lease,
    ddb: { send: vi.fn(async () => ({ Items: [] })) },
    eventsTable: "events",
    getChildTickets: vi.fn(async () => []),
    getTicket: vi.fn(async () => ({ ticketId: TID, title: "Ship the thing" })),
    invokeTickets: vi.fn(async () => ({ key: "TEAM-99", status: "created" })),
    s3Get: vi.fn(async () => null),
    githubApi: vi.fn(async () => []),
    addBlockers: vi.fn(async (_t, ids) => ids),
    parkGateForHuman: vi.fn(async () => {}),
    publishEvent: vi.fn(async () => {}),
    transitionTicket: vi.fn(async () => true),
    now: () => NOW,
    log: { log: () => {}, warn: () => {} },
    ...over,
  };
  // Overrides may replace store/lease wholesale; hand back what the tree got.
  return { d, store: d.store, lease: d.lease };
}

const run = (d, over = {}) =>
  createDeadSessionEscalation(d).escalateExhausted({
    workflow: workflow(), ticketId: TID, agentId: AGENT, claim: claim(), ...over,
  });

const notif = (store) => store.appendNotification.mock.calls[0]?.[1];
const eventsOfType = (fn, type) => fn.mock.calls.filter((c) => c[1] === type);

// ─── 1. mode normalization ────────────────────────────────────────────────────

describe("normalizeEscalationMode", () => {
  it("unset / empty / null → off (a fresh deploy is byte-identical)", () => {
    expect(normalizeEscalationMode(undefined)).toBe("off");
    expect(normalizeEscalationMode("")).toBe("off");
    expect(normalizeEscalationMode("   ")).toBe("off");
    expect(normalizeEscalationMode(null)).toBe("off");
  });

  it("recognized modes pass through, casing + whitespace tolerant", () => {
    expect(normalizeEscalationMode("off")).toBe("off");
    expect(normalizeEscalationMode("shadow")).toBe("shadow");
    expect(normalizeEscalationMode("enforce")).toBe("enforce");
    expect(normalizeEscalationMode("  SHADOW ")).toBe("shadow");
    expect(normalizeEscalationMode("Enforce")).toBe("enforce");
    expect(normalizeEscalationMode(" OFF")).toBe("off");
  });

  it("PRESENT-but-unrecognized → shadow (somebody meant to enable it)", () => {
    // Deliberately the opposite of GATE_STATE_GUARD/ship-head, where garbage → off:
    // there the dangerous failure is acting, here it is staying silent.
    expect(normalizeEscalationMode("bogus")).toBe("shadow");
    expect(normalizeEscalationMode("on")).toBe("shadow");
    expect(normalizeEscalationMode("1")).toBe("shadow");
    expect(normalizeEscalationMode("true")).toBe("shadow");
  });
});

// ─── 2. redaction ─────────────────────────────────────────────────────────────

describe("redactText — one vector per pattern", () => {
  const R = "[REDACTED]";

  it("presigned URL: query VALUES redacted, host + path kept", () => {
    const out = redactText("see https://bucket.s3.amazonaws.com/wf/x.json?X-Amz-Signature=abc123&X-Amz-Expires=900");
    expect(out).toContain("https://bucket.s3.amazonaws.com/wf/x.json?");
    expect(out).toContain(`X-Amz-Signature=${R}`);
    expect(out).toContain(`X-Amz-Expires=${R}`);
    expect(out).not.toContain("abc123");
  });

  it("bare SigV4 params with no scheme, each key name preserved", () => {
    const out = redactText("X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAX/20260901/us-east-1");
    expect(out).toBe(`X-Amz-Signature=${R}&X-Amz-Credential=${R}`);
  });

  it("GitHub tokens: ghp_ / ghs_ / github_pat_", () => {
    expect(redactText(`ghp_${"a".repeat(36)}`)).toBe(R);
    expect(redactText(`ghs_${"b".repeat(36)}`)).toBe(R);
    expect(redactText(`github_pat_${"c".repeat(24)}`)).toBe(R);
  });

  it("AWS access key ids: AKIA + ASIA", () => {
    expect(redactText("AKIAIOSFODNN7EXAMPLE")).toBe(R);
    expect(redactText("ASIAIOSFODNN7EXAMPLE")).toBe(R);
  });

  it("aws_secret_access_key=…", () => {
    expect(redactText("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCY")).toBe(`aws_secret_access_key=${R}`);
  });

  it("Slack bot token + incoming webhook", () => {
    expect(redactText("xoxb-123456789-abcdefXYZ")).toBe(R);
    expect(redactText("posted to hooks.slack.com/services/T00/B00/XXXX")).toBe(`posted to hooks.slack.com/services/${R}`);
  });

  it("Bearer token and an Authorization header", () => {
    expect(redactText("Bearer abc.def-ghi_jkl+mno/pqr=")).toBe(`Bearer ${R}`);
    // The scheme name survives (it is not the secret); the credential does not.
    expect(redactText("Authorization: Basic dXNlcjpwYXNz")).toBe(`Authorization: Basic ${R}`);
    expect(redactText("Authorization: abc123")).toBe(`Authorization: ${R}`);
  });

  it("JWT", () => {
    expect(redactText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-DEF_123")).toBe(R);
  });

  it("Telegram bot token", () => {
    expect(redactText(`1234567890:${"A".repeat(35)}`)).toBe(R);
  });

  it("Anthropic + OpenAI-style keys", () => {
    expect(redactText(`sk-ant-api03-${"x".repeat(24)}`)).toBe(R);
    expect(redactText(`sk-${"y".repeat(32)}`)).toBe(R);
  });

  it("Jira API token (ATATT…)", () => {
    expect(redactText(`ATATT${"z".repeat(30)}`)).toBe(R);
  });

  it("a PEM private key block spanning lines", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc/def+ghi=\n-----END RSA PRIVATE KEY-----";
    const out = redactText(`deploy key: ${pem} done`);
    expect(out).toBe(`deploy key: ${R} done`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA");
  });

  it("generic key=value KEEPS the key name so the human knows what leaked", () => {
    expect(redactText("api_key=abc123")).toBe(`api_key=${R}`);
    expect(redactText("password: hunter2")).toBe(`password: ${R}`);
    expect(redactText("token=abc.def")).toBe(`token=${R}`);
  });

  it("emails become <email> (PII placeholder, not a secret)", () => {
    expect(redactText("paged dev.ops+ci@example.co.uk about it")).toBe("paged <email> about it");
  });

  it("ANSI escapes and code fences are stripped, whitespace collapsed", () => {
    const out = redactText("[31mERROR[0m in ```js\nconst x = 1;\n``` `inline`   spaced\n\nlines");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("`");
    expect(out).toBe("ERROR in js const x = 1; inline spaced lines");
  });

  it("empty / non-string input is empty, never a throw", () => {
    expect(redactText("")).toBe("");
    expect(redactText(undefined)).toBe("");
    expect(redactText(null)).toBe("");
    expect(redactText(42)).toBe("");
  });

  it("ORDER: a secret straddling the 600-char clip boundary is redacted FIRST", () => {
    // The production caller does redactText(raw) → clipText(…, 600). Clipping
    // first would cut the token in half so no pattern matches either half.
    const raw = `${"x".repeat(590)}ghp_${"a".repeat(36)}`;
    const out = clipText(redactText(raw), 600);
    expect(out).not.toContain("ghp_");
    expect(out.length).toBeLessThanOrEqual(600);
  });
});

describe("clipText", () => {
  it("adds the ellipsis only when it actually clipped", () => {
    expect(clipText("abcdefghij", 5)).toBe("abcd…");
    expect(clipText("abcd", 10)).toBe("abcd");
    expect(clipText("abcde", 5)).toBe("abcde");
    expect(clipText("abc", 0)).toBe("");
    expect(clipText(undefined, 10)).toBe("");
  });
});

// ─── 3. child selection ───────────────────────────────────────────────────────

/**
 * The REAL ticket set of run yteqfl (24 tickets), read from the reduced dossier
 * the Workflow Manager toolkit already keeps:
 *   s3://{ARTIFACT_BUCKET}/workflow-manager/dossiers/yteqfl-dossier.json
 * (checked in at deploy/workflow-manager/toolkit/fixtures/, `tickets` slice).
 * The window below is the release manager's dead claim on TEAM-4066.
 */
const YTEQFL = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json", import.meta.url)),
  "utf8"
));

describe("selectChildren", () => {
  it("PRIMARY: explicit spawnedBy provenance, all five origin keys", () => {
    const siblings = [
      { ticketId: "G1", spawnedBy: { gateTicketId: TID } },
      { ticketId: "Q1", spawnedBy: { qaTicketId: TID } },
      { ticketId: "C1", spawnedBy: { codexTicketId: TID } },
      { ticketId: "S1", spawnedBy: { shipTicketId: TID } },
      { ticketId: "I1", spawnedBy: { ciTicketId: TID } },
      { ticketId: "OTHER", spawnedBy: { gateTicketId: "TEAM-999" } },
      { ticketId: "NONE" },
    ];
    expect(selectChildren({ siblings, ticketId: TID, claim: claim(), now: NOW }))
      .toEqual(["G1", "Q1", "C1", "S1", "I1"]);
  });

  it("PRIMARY wins even when the window fallback would match more", () => {
    const siblings = [
      { ticketId: "G1", spawnedBy: { gateTicketId: TID }, createdAt: new Date(NOW - 1000).toISOString() },
      { ticketId: "W1", createdAt: new Date(NOW - 1000).toISOString(), blockedBy: [] },
    ];
    expect(selectChildren({ siblings, ticketId: TID, claim: claim(), now: NOW })).toEqual(["G1"]);
  });

  it("FALLBACK on the real yteqfl set: the whole dependency-closed chain", () => {
    const got = selectChildren({
      siblings: YTEQFL.tickets,
      ticketId: "TEAM-4066",
      claim: { startedAt: "2026-09-05T06:51:10.346Z" },
      now: Date.parse("2026-09-05T07:36:10.154Z"),
    });
    expect([...got].sort()).toEqual(
      ["TEAM-4101", "TEAM-4102", "TEAM-4103", "TEAM-4104", "TEAM-4105", "TEAM-4106"]
    );
  });

  it("documents what the literal 'empty blockedBy' rule would have MISSED", () => {
    // The design's original rule. On this real slice it yields only the two
    // roots and drops 4102→4103→4104 (the chain the dead release manager had
    // just built) plus 4106 — i.e. exactly the evidence a human needs, and the
    // tickets that must be done before the held ship ticket may resume.
    const from = Date.parse("2026-09-05T06:51:10.346Z");
    const to = Date.parse("2026-09-05T07:36:10.154Z");
    const literal = YTEQFL.tickets
      .filter((t) => t.ticketId !== "TEAM-4066" && t.status !== "cancelled")
      .filter((t) => { const c = Date.parse(t.createdAt); return c >= from && c <= to; })
      .filter((t) => !Array.isArray(t.blockedBy) || t.blockedBy.length === 0)
      .map((t) => t.ticketId);
    expect(literal).toEqual(["TEAM-4101", "TEAM-4105"]);
  });

  it("excludes cancelled siblings, the ticket itself, and pre-window tickets", () => {
    const inWindow = new Date(NOW - 60_000).toISOString();
    const siblings = [
      { ticketId: TID, createdAt: inWindow, blockedBy: [] },                      // itself
      { ticketId: "CANCELLED", createdAt: inWindow, blockedBy: [], status: "cancelled" },
      { ticketId: "OLD", createdAt: "2020-01-01T00:00:00Z", blockedBy: [] },      // before the claim
      { ticketId: "KEEP", createdAt: inWindow, blockedBy: [], status: "todo" },
    ];
    expect(selectChildren({ siblings, ticketId: TID, claim: claim(), now: NOW })).toEqual(["KEEP"]);
  });

  it("excludes a ticket blocked on something OUTSIDE the window (not this agent's chain)", () => {
    const inWindow = new Date(NOW - 60_000).toISOString();
    const siblings = [
      { ticketId: "ROOT", createdAt: inWindow, blockedBy: [] },
      { ticketId: "CHAINED", createdAt: inWindow, blockedBy: ["ROOT"] },
      { ticketId: "FOREIGN", createdAt: inWindow, blockedBy: ["TEAM-OUTSIDE"] },
    ];
    expect(selectChildren({ siblings, ticketId: TID, claim: claim(), now: NOW })).toEqual(["ROOT", "CHAINED"]);
  });

  it("no claim.startedAt → no window, so no fallback children (never a guess)", () => {
    const siblings = [{ ticketId: "W1", createdAt: new Date(NOW - 1000).toISOString(), blockedBy: [] }];
    expect(selectChildren({ siblings, ticketId: TID, claim: {}, now: NOW })).toEqual([]);
    expect(selectChildren({})).toEqual([]);
  });
});

// ─── 3b. the blocker-cycle invariant (TEAM-4129 F1) ───────────────────────────

/**
 * A dead-session-held ticket can never be blocked on a ticket that transitively
 * depends on it. The pre-4129 rule was one level deep — it asked whether each
 * blocker was IN THE WINDOW, not whether the blocker was itself SELECTED — so a
 * transitive dependent of the held ticket got in, enforce path (b) called
 * addBlockers(held, [dependent]), and the resulting cycle could never be released
 * by reconcileDependent. Path (b) also parks nothing and pages nobody, so the run
 * wedged silently: exactly the failure these cases pin shut.
 */
describe("selectChildren — no blocker cycle with the held ticket", () => {
  const inWin = (over) => ({ createdAt: new Date(NOW - 60_000).toISOString(), status: "todo", ...over });
  const select = (siblings, over = {}) =>
    selectChildren({ siblings, ticketId: TID, claim: claim(), now: NOW, ...over });

  it("2 hops: QA-1 blockedBy [held], DEV-1 blockedBy [QA-1] → neither selected", () => {
    // QA-1 is dropped because the held ticket is not in the window. Pre-4129,
    // DEV-1 was still admitted (QA-1 *was* in the window) → TEAM-1 → DEV-1 →
    // QA-1 → TEAM-1.
    const got = select([
      inWin({ ticketId: "QA-1", blockedBy: [TID] }),
      inWin({ ticketId: "DEV-1", blockedBy: ["QA-1"] }),
    ]);
    expect(got).toEqual([]);
    expect(got).not.toContain("DEV-1");
  });

  it("3 hops: DEV-2 blockedBy [DEV-1] is excluded too (disqualification propagates)", () => {
    const got = select([
      inWin({ ticketId: "QA-1", blockedBy: [TID] }),
      inWin({ ticketId: "DEV-1", blockedBy: ["QA-1"] }),
      inWin({ ticketId: "DEV-2", blockedBy: ["DEV-1"] }),
    ]);
    expect(got).toEqual([]);
  });

  it("declaration order does not matter — the closure is a fixpoint, not one pass", () => {
    // Deepest first: a single forward pass over this list would admit nothing on
    // the way down and everything on a naive second look. The fixpoint admits the
    // clean roots only.
    const got = select([
      inWin({ ticketId: "DEV-2", blockedBy: ["DEV-1"] }),
      inWin({ ticketId: "DEV-1", blockedBy: ["QA-1"] }),
      inWin({ ticketId: "QA-1", blockedBy: [TID] }),
      inWin({ ticketId: "CLEAN-2", blockedBy: ["CLEAN-1"] }),
      inWin({ ticketId: "CLEAN-1", blockedBy: [] }),
    ]);
    expect(got).toEqual(["CLEAN-2", "CLEAN-1"]);
  });

  it("POSITIVE CONTROL: A (no blockers) and B blockedBy [A] are both selected", () => {
    // The fix must not degenerate into the literal "empty blockedBy" rule the
    // module comment explicitly rejects.
    expect(select([
      inWin({ ticketId: "A", blockedBy: [] }),
      inWin({ ticketId: "B", blockedBy: ["A"] }),
    ])).toEqual(["A", "B"]);
  });

  it("a chain that reaches the held ticket through a PRE-WINDOW sibling is excluded", () => {
    // OLD-1 was created before the claim, so it is not a window candidate at all,
    // yet it is the hop that closes the cycle: NEW-1 → OLD-1 → TEAM-1.
    const got = select([
      { ticketId: "OLD-1", createdAt: "2020-01-01T00:00:00Z", status: "todo", blockedBy: [TID] },
      inWin({ ticketId: "NEW-1", blockedBy: ["OLD-1"] }),
      inWin({ ticketId: "SAFE", blockedBy: [] }),
    ]);
    expect(got).toEqual(["SAFE"]);
  });

  it("a cycle among the siblings themselves does not hang the walk", () => {
    // X ↔ Y is already corrupt data; the visited set means we terminate and
    // simply admit neither (each is waiting on something unadmitted).
    expect(select([
      inWin({ ticketId: "X", blockedBy: ["Y"] }),
      inWin({ ticketId: "Y", blockedBy: ["X"] }),
      inWin({ ticketId: "SELF", blockedBy: ["SELF"] }),
      inWin({ ticketId: "OK", blockedBy: [] }),
    ])).toEqual(["OK"]);
  });

  it("PRIMARY provenance is guarded too: a spawned child that blocks on the held ticket is dropped", () => {
    // Barrier 2 does not depend on the claim window, so the same invariant holds
    // on the spawnedBy path where no window rule applies.
    expect(select([
      { ticketId: "G1", spawnedBy: { gateTicketId: TID }, blockedBy: [TID] },
      { ticketId: "G2", spawnedBy: { gateTicketId: TID }, blockedBy: [] },
    ])).toEqual(["G2"]);
  });

  it("the yteqfl closure is unchanged by the fix (regression guard)", () => {
    // The real slice has no dependent of TEAM-4066 inside the window, so both
    // barriers are no-ops there and the chain 4101→4102→4103→4104 plus 4105/4106
    // still lands — the behaviour the module comment describes.
    const got = selectChildren({
      siblings: YTEQFL.tickets,
      ticketId: "TEAM-4066",
      claim: { startedAt: "2026-09-05T06:51:10.346Z" },
      now: Date.parse("2026-09-05T07:36:10.154Z"),
    });
    expect([...got].sort()).toEqual(
      ["TEAM-4101", "TEAM-4102", "TEAM-4103", "TEAM-4104", "TEAM-4105", "TEAM-4106"]
    );
  });
});

// ─── 4. decision order (enforce) ──────────────────────────────────────────────

const evidenceRecord = (over = {}) => ({
  summary: "Shipped the migration",
  completed_at: "2026-09-01T11:00:00Z", // inside the claim (started 06:00Z)
  ...over,
});

describe("enforce — decision order", () => {
  it("a REAL agent error outranks children: park, never synthesize", async () => {
    const { d, store } = deps({
      lease: { lastStreamedText: vi.fn(async () => ""), hasAgentErrorSince: vi.fn(async () => true) },
      getChildTickets: vi.fn(async () => [
        { ticketId: "TEAM-50", createdAt: new Date(NOW - 60_000).toISOString(), blockedBy: [] },
      ]),
    });
    const res = await run(d);

    expect(res.disposition).toBe("parked");
    expect(d.invokeTickets).toHaveBeenCalledWith("create_ticket", expect.objectContaining({
      summary: `Escalation: dead session on ${TID} (${AGENT})`,
      assignee: "human:engineer",
      parent_key: "EPIC-1",
      workflow_id: "wf_1",
      blocked_by: [],
    }));
    expect(d.addBlockers).toHaveBeenCalledWith(TID, ["TEAM-99"]);
    expect(d.parkGateForHuman).toHaveBeenCalledWith("TEAM-99", "human:engineer", expect.objectContaining({ id: "wf_1" }));
    // Never the synthesize path, even though children exist.
    expect(store.mergeTaskMetadata).not.toHaveBeenCalled();
    expect(d.transitionTicket).not.toHaveBeenCalled();
    expect(notif(store).disposition).toBe("parked");
    expect(notif(store).gateTicketId).toBe("TEAM-99");
  });

  it("fresh evidence-bearing completion record → Done via the NORMAL done path", async () => {
    const { d, store } = deps({ s3Get: vi.fn(async () => evidenceRecord()) });
    const res = await run(d);

    expect(res.disposition).toBe("synthesized_completion");
    expect(d.s3Get).toHaveBeenCalledWith(`completions/${TID}.json`);
    expect(store.mergeTaskMetadata).toHaveBeenCalledWith("wf_1", TID, {
      synthesized: true, evidenceSource: "completion_record",
    });
    expect(d.transitionTicket).toHaveBeenCalledWith(TID, "done");
    // The done handlers own the resume; this path adds no blockers and does not
    // hand back the retry budget (there is nothing left to retry).
    expect(d.addBlockers).not.toHaveBeenCalled();
    expect(store.resetDeadSessionRetry).not.toHaveBeenCalled();
    expect(store.claimDeadSessionSynthesis).not.toHaveBeenCalled();
  });

  it("STALE record (completed_at before the claim started) is NOT evidence — F4", async () => {
    // Attempt 1 left a record behind; closing attempt 2 on it would mark a
    // ticket Done for work the second agent never did.
    const { d, store } = deps({
      s3Get: vi.fn(async () => evidenceRecord({ completed_at: "2026-08-31T23:00:00Z" })),
    });
    const res = await run(d);

    expect(res.disposition).toBe("parked");
    expect(d.transitionTicket).not.toHaveBeenCalled();
    expect(notif(store).artifacts.completionRecord).toBe(false);
    expect(notif(store).details).toContain("predates this attempt");
  });

  it("a stale record still falls through to the CHILDREN branch when children exist", async () => {
    const { d, store } = deps({
      s3Get: vi.fn(async () => evidenceRecord({ completed_at: "2026-08-31T23:00:00Z" })),
      getChildTickets: vi.fn(async () => [
        { ticketId: "TEAM-50", createdAt: new Date(NOW - 60_000).toISOString(), blockedBy: [] },
      ]),
    });
    const res = await run(d);

    expect(res.disposition).toBe("synthesized_children");
    expect(d.transitionTicket).not.toHaveBeenCalled();
    expect(store.mergeTaskMetadata).toHaveBeenCalledWith("wf_1", TID, {
      synthesized: true, evidenceSource: "children", children: ["TEAM-50"],
    });
  });

  it("a BLANK record is not evidence (reuses completion.mjs completionRecordHasEvidence)", async () => {
    for (const record of [{}, { completed_at: "2026-09-01T11:00:00Z" }, { summary: "   ", completed_at: "2026-09-01T11:00:00Z" }]) {
      const { d } = deps({ s3Get: vi.fn(async () => record) });
      const res = await run(d);
      expect(res.disposition).toBe("parked");
      expect(d.transitionTicket).not.toHaveBeenCalled();
    }
  });

  it("children only → block on them, hand back the retry budget, NEVER Done", async () => {
    const kids = [
      { ticketId: "TEAM-50", createdAt: new Date(NOW - 90_000).toISOString(), blockedBy: [] },
      { ticketId: "TEAM-51", createdAt: new Date(NOW - 60_000).toISOString(), blockedBy: ["TEAM-50"] },
    ];
    const { d, store } = deps({ getChildTickets: vi.fn(async () => kids) });
    const res = await run(d);

    expect(res.disposition).toBe("synthesized_children");
    expect(store.claimDeadSessionSynthesis).toHaveBeenCalledWith("wf_1", TID);
    expect(store.mergeTaskMetadata).toHaveBeenCalledWith("wf_1", TID, {
      synthesized: true, evidenceSource: "children", children: ["TEAM-50", "TEAM-51"],
    });
    expect(d.addBlockers).toHaveBeenCalledWith(TID, ["TEAM-50", "TEAM-51"]);
    expect(store.resetDeadSessionRetry).toHaveBeenCalledWith("wf_1", TID);
    expect(eventsOfType(d.publishEvent, "agent.escalation_synthesized")).toHaveLength(1);
    expect(d.publishEvent.mock.calls.find((c) => c[1] === "agent.escalation_synthesized")[2]).toEqual({
      workflowId: "wf_1", ticketId: TID, evidenceSource: "children", children: ["TEAM-50", "TEAM-51"],
    });
    // R3: never marks Done without a fresh evidence-bearing record.
    expect(d.transitionTicket).not.toHaveBeenCalled();
    expect(d.invokeTickets).not.toHaveBeenCalled();
  });

  it("F5 cap: the SECOND children-synthesis for the same ticket parks instead", async () => {
    const { d, store } = deps({
      store: {
        appendNotification: vi.fn(async () => {}),
        mergeTaskMetadata: vi.fn(async () => {}),
        resetDeadSessionRetry: vi.fn(async () => true),
        claimDeadSessionSynthesis: vi.fn(async () => false), // already spent
      },
      getChildTickets: vi.fn(async () => [
        { ticketId: "TEAM-50", createdAt: new Date(NOW - 60_000).toISOString(), blockedBy: [] },
      ]),
    });
    const res = await run(d);

    expect(res.disposition).toBe("parked");
    expect(res.gateTicketId).toBe("TEAM-99");
    // The synthesis writes are skipped entirely — only the gate blocks the ticket.
    expect(store.mergeTaskMetadata).not.toHaveBeenCalled();
    expect(store.resetDeadSessionRetry).not.toHaveBeenCalled();
    expect(d.addBlockers).toHaveBeenCalledWith(TID, ["TEAM-99"]);
  });

  it("F1: a cycle-only child set parks instead of blocking the held ticket on it", async () => {
    // The whole point of the selection fix, end to end. Both in-window tickets
    // (transitively) depend on TEAM-1, so `children` is empty, canSynthesize is
    // false, and the tree falls to path (c) — which is what a human needs, since
    // path (b) would have written the cycle and paged nobody.
    const { d, store } = deps({
      getChildTickets: vi.fn(async () => [
        { ticketId: "QA-1", createdAt: new Date(NOW - 90_000).toISOString(), status: "todo", blockedBy: [TID] },
        { ticketId: "DEV-1", createdAt: new Date(NOW - 60_000).toISOString(), status: "todo", blockedBy: ["QA-1"] },
      ]),
    });
    const res = await run(d);

    expect(res.children).toEqual([]);
    expect(res.disposition).toBe("parked");
    expect(res.gateTicketId).toBe("TEAM-99");

    // The gate exists and is the ONLY blocker written.
    expect(d.invokeTickets).toHaveBeenCalledWith("create_ticket", expect.objectContaining({
      summary: `Escalation: dead session on ${TID} (${AGENT})`,
      assignee: "human:engineer",
    }));
    expect(d.addBlockers.mock.calls).toEqual([[TID, ["TEAM-99"]]]);
    expect(d.addBlockers).not.toHaveBeenCalledWith(TID, expect.arrayContaining(["DEV-1"]));
    expect(d.addBlockers).not.toHaveBeenCalledWith(TID, expect.arrayContaining(["QA-1"]));
    expect(d.parkGateForHuman).toHaveBeenCalledWith("TEAM-99", "human:engineer", expect.objectContaining({ id: "wf_1" }));

    // Not the synthesis path at all: no CAS spend, no retry-budget give-back.
    expect(store.claimDeadSessionSynthesis).not.toHaveBeenCalled();
    expect(store.mergeTaskMetadata).not.toHaveBeenCalled();
    expect(store.resetDeadSessionRetry).not.toHaveBeenCalled();
    expect(d.transitionTicket).not.toHaveBeenCalled();

    // …and the human is actually told there was nothing to block on.
    expect(notif(store).disposition).toBe("parked");
    expect(notif(store).children).toEqual([]);
    expect(notif(store).details).toContain("Spawned nothing");
  });

  it("F1: the clean members of a mixed set still synthesize, without the cyclic one", async () => {
    const { d, store } = deps({
      getChildTickets: vi.fn(async () => [
        { ticketId: "QA-1", createdAt: new Date(NOW - 90_000).toISOString(), status: "todo", blockedBy: [TID] },
        { ticketId: "DEV-1", createdAt: new Date(NOW - 80_000).toISOString(), status: "todo", blockedBy: ["QA-1"] },
        { ticketId: "FIX-1", createdAt: new Date(NOW - 70_000).toISOString(), status: "todo", blockedBy: [] },
        { ticketId: "FIX-2", createdAt: new Date(NOW - 60_000).toISOString(), status: "todo", blockedBy: ["FIX-1"] },
      ]),
    });
    const res = await run(d);

    expect(res.disposition).toBe("synthesized_children");
    expect(d.addBlockers).toHaveBeenCalledWith(TID, ["FIX-1", "FIX-2"]);
    expect(store.mergeTaskMetadata).toHaveBeenCalledWith("wf_1", TID, {
      synthesized: true, evidenceSource: "children", children: ["FIX-1", "FIX-2"],
    });
    expect(d.invokeTickets).not.toHaveBeenCalled(); // no gate needed, there IS evidence
  });

  it("no evidence at all → park", async () => {
    const { d, store } = deps();
    const res = await run(d);
    expect(res.disposition).toBe("parked");
    expect(store.mergeTaskMetadata).not.toHaveBeenCalled();
    expect(d.transitionTicket).not.toHaveBeenCalled();
  });

  it("gate creation failing leaves the ticket in error rather than half-parked", async () => {
    const { d, store } = deps({ invokeTickets: vi.fn(async () => { throw new Error("tickets lambda down"); }) });
    const res = await run(d);
    expect(res.disposition).toBe("shadow"); // nothing was actually done
    expect(d.addBlockers).not.toHaveBeenCalled();
    expect(d.parkGateForHuman).not.toHaveBeenCalled();
    expect(store.appendNotification).toHaveBeenCalledTimes(1); // the page still lands
  });
});

// ─── 5. shadow ────────────────────────────────────────────────────────────────

describe("shadow — reports the decision, writes only the page", () => {
  const shadowDeps = (over) => deps({ mode: "shadow", ...over });

  it("children present → wouldSynthesize, and ZERO board/state writes", async () => {
    const { d, store } = shadowDeps({
      getChildTickets: vi.fn(async () => [
        { ticketId: "TEAM-50", createdAt: new Date(NOW - 60_000).toISOString(), blockedBy: [] },
      ]),
    });
    const res = await run(d);

    expect(res.disposition).toBe("shadow");
    const decided = d.publishEvent.mock.calls.find((c) => c[1] === "dead_session.escalation_decided");
    expect(decided[2]).toEqual({
      workflowId: "wf_1", ticketId: TID, agentId: AGENT, shadow: true,
      wouldSynthesize: true, evidenceSource: "children", children: ["TEAM-50"],
    });
    // Exactly one store write: the page.
    expect(store.appendNotification).toHaveBeenCalledTimes(1);
    expect(store.mergeTaskMetadata).not.toHaveBeenCalled();
    expect(store.resetDeadSessionRetry).not.toHaveBeenCalled();
    expect(store.claimDeadSessionSynthesis).not.toHaveBeenCalled();
    expect(d.addBlockers).not.toHaveBeenCalled();
    expect(d.transitionTicket).not.toHaveBeenCalled();
    expect(d.invokeTickets).not.toHaveBeenCalled();
    expect(d.parkGateForHuman).not.toHaveBeenCalled();
    expect(notif(store).disposition).toBe("shadow");
    expect(notif(store).wouldSynthesize).toBe(true);
    expect(notif(store).reviewer).toBe("dead-session-escalation");
  });

  it("no evidence → wouldPark, still no writes but the page", async () => {
    const { d, store } = shadowDeps();
    const res = await run(d);

    expect(res.disposition).toBe("shadow");
    const decided = d.publishEvent.mock.calls.find((c) => c[1] === "dead_session.escalation_decided");
    expect(decided[2]).toMatchObject({ shadow: true, wouldPark: true, children: [] });
    expect(decided[2].wouldSynthesize).toBeUndefined();
    expect(store.appendNotification).toHaveBeenCalledTimes(1);
    expect(notif(store).wouldPark).toBe(true);
  });

  it("a fresh completion record in shadow reports it but does NOT transition", async () => {
    const { d, store } = shadowDeps({ s3Get: vi.fn(async () => evidenceRecord()) });
    await run(d);
    const decided = d.publishEvent.mock.calls.find((c) => c[1] === "dead_session.escalation_decided");
    expect(decided[2]).toMatchObject({ wouldSynthesize: true, evidenceSource: "completion_record" });
    expect(d.transitionTicket).not.toHaveBeenCalled();
    expect(store.appendNotification).toHaveBeenCalledTimes(1);
  });
});

// ─── 6. the notification (what a human actually sees) ─────────────────────────

describe("the page", () => {
  it("carries every field the Telegram renderer reads, with the secret redacted", async () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const { d, store } = deps({
      lease: {
        lastStreamedText: vi.fn(async () => `pushing with ${secret} to origin`),
        hasAgentErrorSince: vi.fn(async () => false),
      },
      getChildTickets: vi.fn(async () => [
        { ticketId: "TEAM-50", createdAt: new Date(NOW - 60_000).toISOString(), blockedBy: [] },
      ]),
      githubApi: vi.fn(async () => [{ head: { ref: `feature/${TID}-thing` }, html_url: "https://github.com/o/r/pull/7" }]),
    });
    await run(d);
    const n = notif(store);

    expect(n.id).toBe(`notif_dead_session_${TID}_${NOW_ISO}`);
    expect(n.type).toBe("manager_escalation");
    expect(n.reviewer).toBe("dead-session-escalation");
    expect(n.source).toBe("dead-session-detector");
    expect(n.ticketId).toBe(TID);
    expect(n.agentId).toBe(AGENT);
    expect(n.ticketTitle).toBe("Ship the thing");
    expect(n.lastText).toBe("pushing with [REDACTED] to origin");
    expect(n.lastText).not.toContain("ghp_");
    expect(n.lastText.length).toBeLessThanOrEqual(600);
    expect(n.children).toEqual(["TEAM-50"]);
    expect(n.artifacts).toEqual({ completionRecord: false, prUrl: "https://github.com/o/r/pull/7" });
    expect(n.disposition).toBe("synthesized_children");
    expect(n.acknowledged).toBe(false);
    expect(n.timestamp).toBe(NOW_ISO);
    expect(n.details.length).toBeLessThanOrEqual(700);
  });

  it("clips an over-long last-streamed blob to 600 chars", async () => {
    const { d, store } = deps({
      lease: { lastStreamedText: vi.fn(async () => "z".repeat(5000)), hasAgentErrorSince: vi.fn(async () => false) },
    });
    await run(d);
    expect(notif(store).lastText).toHaveLength(600);
    expect(notif(store).lastText.endsWith("…")).toBe(true);
  });

  it("only matches a PR on this ticket's own feature branch", async () => {
    const { d, store } = deps({
      githubApi: vi.fn(async () => [
        { head: { ref: "feature/TEAM-999-other" }, html_url: "https://github.com/o/r/pull/1" },
        { head: { ref: `feature/${TID}-mine` }, html_url: "https://github.com/o/r/pull/2" },
      ]),
    });
    await run(d);
    expect(notif(store).artifacts.prUrl).toBe("https://github.com/o/r/pull/2");
  });

  it("appends the page LAST, so the disposition it reports is final", async () => {
    const order = [];
    const { d } = deps({
      store: {
        appendNotification: vi.fn(async () => { order.push("notify"); }),
        mergeTaskMetadata: vi.fn(async () => { order.push("merge"); }),
        resetDeadSessionRetry: vi.fn(async () => { order.push("reset"); return true; }),
        claimDeadSessionSynthesis: vi.fn(async () => { order.push("claim"); return true; }),
      },
      addBlockers: vi.fn(async () => { order.push("block"); return []; }),
      getChildTickets: vi.fn(async () => [
        { ticketId: "TEAM-50", createdAt: new Date(NOW - 60_000).toISOString(), blockedBy: [] },
      ]),
    });
    await run(d);
    expect(order[order.length - 1]).toBe("notify");
  });
});

// ─── 7. resilience (this runs inside a sweep) ─────────────────────────────────

describe("resilience — no dep can make escalateExhausted reject", () => {
  const boom = () => { throw new Error("boom"); };

  for (const [label, over] of [
    ["lease.lastStreamedText", { lease: { lastStreamedText: vi.fn(boom), hasAgentErrorSince: vi.fn(async () => false) } }],
    ["lease.hasAgentErrorSince", { lease: { lastStreamedText: vi.fn(async () => ""), hasAgentErrorSince: vi.fn(boom) } }],
    ["getChildTickets", { getChildTickets: vi.fn(boom) }],
    ["s3Get", { s3Get: vi.fn(boom) }],
    ["githubApi", { githubApi: vi.fn(boom) }],
    ["getTicket", { getTicket: vi.fn(boom) }],
    ["invokeTickets", { invokeTickets: vi.fn(boom) }],
    ["parkGateForHuman", { parkGateForHuman: vi.fn(boom) }],
    ["publishEvent", { publishEvent: vi.fn(boom) }],
  ]) {
    it(`${label} throwing still resolves AND still pages`, async () => {
      const { d, store } = deps(over);
      const res = await run(d);
      expect(res.disposition).toEqual(expect.any(String));
      expect(store.appendNotification).toHaveBeenCalledTimes(1);
    });
  }

  it("even appendNotification throwing does not reject (the caller is mid-sweep)", async () => {
    const { d } = deps({
      store: {
        appendNotification: vi.fn(boom),
        mergeTaskMetadata: vi.fn(async () => {}),
        resetDeadSessionRetry: vi.fn(async () => true),
        claimDeadSessionSynthesis: vi.fn(async () => true),
      },
    });
    await expect(run(d)).resolves.toMatchObject({ disposition: "parked" });
  });

  it("an unwired store / lease / github is a narrower page, not a crash", async () => {
    const d = {
      mode: "enforce",
      publishEvent: vi.fn(async () => {}),
      now: () => NOW,
      log: { log: () => {}, warn: () => {} },
    };
    await expect(run(d)).resolves.toMatchObject({ disposition: "shadow" });
  });

  it("a missing workflow/ticketId is refused before any I/O", async () => {
    const { d, store } = deps();
    await expect(createDeadSessionEscalation(d).escalateExhausted({ ticketId: TID })).resolves
      .toMatchObject({ disposition: "shadow" });
    await expect(createDeadSessionEscalation(d).escalateExhausted({})).resolves
      .toMatchObject({ disposition: "shadow" });
    expect(store.appendNotification).not.toHaveBeenCalled();
    expect(d.getChildTickets).not.toHaveBeenCalled();
  });
});

// ─── 8. TEAM-4156 — the escalation gate's id is read under BOTH providers ──────

/**
 * The park branch is the third create_ticket producer in the orchestrator, and it
 * read `res?.key || res?.ticket?.key` too. Under TICKET_PROVIDER=jira that is
 * always null: the gate ticket really lands on the board, `park` then reports it
 * missing, nothing blocks on it, it is never handed to a human, and the run's
 * disposition degrades to "shadow" — the exact signature of a gate that "did
 * nothing" while the board says otherwise.
 *
 * `deps()`'s defaults are the no-evidence-anywhere set, so every case below takes
 * the park branch with the only variable being the shape the tickets Lambda
 * answered with.
 */
describe("TEAM-4156 — the escalation gate's id is read under BOTH providers", () => {
  const GATE = "TEAM-99";

  /** Every provider shape must reach the SAME parked end state. */
  async function expectGatedOnHuman(reply) {
    const warns = [];
    const { d, store } = deps({
      invokeTickets: vi.fn(async () => reply),
      log: { log: () => {}, warn: (m) => warns.push(String(m)) },
    });
    const res = await run(d);

    expect(res.disposition).toBe("parked");
    expect(res.gateTicketId).toBe(GATE);
    // Filed exactly once, with the human-owned summary the page refers to.
    expect(d.invokeTickets).toHaveBeenCalledTimes(1);
    expect(d.invokeTickets).toHaveBeenCalledWith("create_ticket", expect.objectContaining({
      summary: `Escalation: dead session on ${TID} (${AGENT})`,
      assignee: "human:engineer",
      parent_key: "EPIC-1",
      workflow_id: "wf_1",
    }));
    // The held ticket blocks on the gate, so the gate's own done cascade resumes it.
    expect(d.addBlockers.mock.calls).toEqual([[TID, [GATE]]]);
    expect(d.parkGateForHuman).toHaveBeenCalledWith(GATE, "human:engineer", expect.objectContaining({ id: "wf_1" }));
    // And the page names the gate, so the human has something to open.
    expect(notif(store).disposition).toBe("parked");
    expect(notif(store).gateTicketId).toBe(GATE);
    expect(warns.join("\n")).not.toMatch(/could not create the escalation gate/);
  }

  it("DynamoDB's { key } reply parks on the gate (unchanged)", async () => {
    await expectGatedOnHuman({ key: GATE, status: "created" });
  });

  it("JIRA's fresh-create reply ({ ticketId }) parks on the gate", async () => {
    await expectGatedOnHuman({ ticketId: GATE, status: "created", message: `Created ${GATE}` });
  });

  it("JIRA's summary-dedupe reply ({ ticketId, deduplicated }) parks on the EXISTING gate", async () => {
    await expectGatedOnHuman({
      ticketId: GATE,
      title: `Escalation: dead session on ${TID} (${AGENT})`,
      status: "To Do",
      deduplicated: true,
    });
  });

  it("DynamoDB's nested { ticket: { key } } reply parks on the gate", async () => {
    await expectGatedOnHuman({ ticket: { key: GATE, status: "todo" } });
  });

  /** No usable id → the pre-TEAM-4156 fail-open, which must stay exactly as it was. */
  async function expectNoGate(invokeTickets) {
    const warns = [];
    const { d, store } = deps({
      invokeTickets,
      log: { log: () => {}, warn: (m) => warns.push(String(m)) },
    });
    const res = await run(d);

    expect(res.disposition).toBe("shadow"); // nothing was actually done
    expect(res.gateTicketId).toBeNull(); // park() said "no gate", not "some gate"
    expect(d.addBlockers).not.toHaveBeenCalled();
    expect(d.parkGateForHuman).not.toHaveBeenCalled();
    expect(store.appendNotification).toHaveBeenCalledTimes(1); // the page still lands
    expect(warns.join("\n")).toMatch(/could not create the escalation gate/);
  }

  it("a resolved { error } is NOT a ticket — defence in depth behind the seam's throw", async () => {
    await expectNoGate(vi.fn(async () => ({ error: "boom" })));
  });

  it("the seam throwing on { error } leaves no half-parked gate", async () => {
    await expectNoGate(vi.fn(async () => { throw new Error("Tickets___create_ticket: boom"); }));
  });

  it("a non-string id is never used as a gate", async () => {
    for (const reply of [{ key: 42 }, { ticketId: { value: GATE } }, { key: "   " }, {}, null]) {
      await expectNoGate(vi.fn(async () => reply));
    }
  });
});
