/**
 * ─── What a gate persona's verdict IS, in one place (TEAM-4246 D1) ────────────
 *
 * Run wf_1788731227559_dowtdh shipped over three failing verdicts because a
 * verdict has never been a FIELD — only prose:
 *
 *   TEAM-4180 code_reviewer  "VERDICT: CHANGES NEEDED (round 1)."   → QA dispatched 4s later
 *   TEAM-4181 qa_verifier    "VERDICT: FAIL — … NOT addressed"      → CI dispatched 4s later
 *   TEAM-4182 ci_agent       "CI verdict: PASS … at tested head SHA 12e9ac6…"
 *   TEAM-4183 fix           done at 001259d  →  workflow.complete 5s later
 *
 * Nothing in `agentTasks` recorded any of that: each entry had `status:
 * "complete"` and a `commitSha`, so the cascade unblocked the successor on
 * ticket-done and completion never compared the heads (QA verified 933ea6f, CI
 * certified 12e9ac6, the PR shipped 001259d).
 *
 * This module is the single definition the cascade gate, the fix-before-verify
 * block and the completion head check all read from. Zero imports, for the same
 * reason ticket-blockers.mjs has none: every one of those consumers lives in a
 * different module and index.mjs imports all of them, so a shared leaf with no
 * edges of its own is the only shape that cannot introduce a cycle. It is also
 * why the whole thing is pure — no clock, no AWS, no env beyond the one
 * normalizer — and therefore fully testable against the real dossier fixtures.
 *
 * TWO RULES, both learned from the fixtures:
 *
 *   1. A VERDICT may be inferred from prose. It is a four-value enum, the
 *      blueprints have always written it on a line of its own, and the ladder
 *      below resolves all nine gate completions across the two vendored
 *      dossiers. When it cannot, the answer is null — never a guess. (dowtdh
 *      TEAM-4128's "Verdict: code deploy SUCCEEDED" reads as NO verdict, not as
 *      a PASS, because SUCCEEDED is not in the enum.)
 *
 *   2. A HEAD SHA may NEVER be inferred from prose. dowtdh TEAM-4180's summary
 *      contains five 7-hex tokens (351d5ec, 933ea6f, 01a078f, 45ced77, a0b6e21)
 *      and the one that matters — the head it actually reviewed — is the
 *      `commit_sha` FIELD, 933ea6f. f50ucz TEAM-4128's prose even contains
 *      "chat 8661669497", which a /[0-9a-f]{7,}/ scan happily reads as a commit.
 *      So resolveTestedHead reads STRUCTURED FIELDS ONLY, in a fixed
 *      precedence, and a run whose gate ticket declared no head has no head.
 */

/** The wire vocabulary. Underscore, matching evidence_kind / ci_status style. */
export const VERDICTS = ["PASS", "CHANGES_NEEDED", "FAIL", "BLOCKED"];

/**
 * The personas whose verdict gates the run. An EXPLICIT agent-id set, never
 * derived from `phase`: agents.json puts ci_agent in `review` (the same phase as
 * code_reviewer) while lambda/workflow-output/index.mjs's PHASE_MAP puts it in
 * `verification`, so "the review/verification phases" names different agents
 * depending on which file you ask. security_reviewer is deliberately ABSENT — it
 * reviews a design doc, its blueprint explicitly permits a FAIL with no fix
 * ticket (f50ucz TEAM-4119: "VERDICT: FAIL (narrow) … No fix tickets filed (per
 * blueprint)"), and gating the design cascade on it would wedge that run.
 */
export const GATE_PERSONAS = new Set([
  "agentcore_hub_code_reviewer",
  "agentcore_hub_qa_verifier",
  "agentcore_hub_ci_agent",
  "agentcore_hub_release_manager",
]);

/** 7-40 hex — a short or full git object name, and nothing else. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * A ticket key. CANONICAL SOURCE: fix-contract.mjs:140 (`TICKET_KEY_RE`) — this is
 * a local copy only because this module is zero-import by design, and
 * verdict-contract.test.mjs asserts the two `.source` strings are equal so the copy
 * cannot drift. Every ticket id that reaches an event detail goes through it: the
 * ids arrive from agent-authored `spawned_by` markers, and an event is read by the
 * UI, cost-report and the replay harness.
 */
export const TICKET_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** Ticket ids only, trimmed, de-duplicated, order preserved. Never throws. */
export function sanitizeTicketIds(raw) {
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const id = typeof v === "string" ? v.trim() : "";
    if (TICKET_KEY_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The enum, as it appears in prose: PASS / FAIL / BLOCKED / CHANGES NEEDED. */
const VERDICT_ALT = "(PASS|FAIL|BLOCKED|CHANGES[\\s_-]*NEEDED)";

/**
 * The prose ladder, ordered, first hit wins. Verified against every completion
 * record in both vendored dossiers (see verdict-contract.test.mjs):
 *
 *   LABELLED  "VERDICT: CHANGES NEEDED", "CI verdict: PASS", "QA VERDICT: PASS",
 *             "**Verdict: PASS — ci_status: github-actions-proxy**"
 *   ROUND     "**Ship review round 2 — PASS on head `7c2391ba…`**" — the release
 *             manager's own heading form, which carries no "verdict:" label at
 *             all (f50ucz TEAM-4126). Second, so a labelled line always wins.
 *
 * There is deliberately no third rung scanning for a bare PASS/FAIL: these
 * summaries are full of "npm test 57/57", "0 Critical", "GH Actions green" and
 * "Deploy stage ended with the intentional HANDOFF exit 2". A wrong verdict is
 * worse than no verdict, because no verdict leaves today's behaviour in place.
 */
const VERDICT_LADDER = [
  new RegExp(`verdict\\s*:\\s*\\*{0,2}\\s*${VERDICT_ALT}\\b`, "i"),
  new RegExp(`round\\s*\\d+\\s*[—–-]+\\s*\\*{0,2}\\s*${VERDICT_ALT}\\b`, "i"),
];

/**
 * One of VERDICTS, or null. Accepts all three spellings the repo already
 * contains — the blueprints write "CHANGES NEEDED" (space), review-cap.mjs and
 * ship-review.mjs PERSIST "CHANGES-NEEDED" (hyphen) in
 * reviewGateHistory[].rounds[].verdict, and the new wire value is
 * CHANGES_NEEDED (underscore). Reading all three is what lets the persisted
 * round records stay exactly as they are: renaming them would break
 * ship-review.mjs's effectiveRoundCount and cost-report's computeGateRounds,
 * which both compare that string literally.
 *
 * "PASS-with-known-findings" (review-cap.mjs enforceDiffScope) reads as PASS: it
 * is that module's own spelling of a passing round, and the alternative — null —
 * would report a release manager who passed as having stated nothing.
 */
export function normalizeVerdict(raw) {
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (norm.startsWith("PASS")) return "PASS";  // PASS, PASS_WITH_KNOWN_FINDINGS
  if (norm === "CHANGES_NEEDED") return "CHANGES_NEEDED";
  if (norm === "FAIL" || norm === "BLOCKED") return norm;
  return null;
}

/** A git head SHA, lowercased — or null for anything that is not one. */
export function normalizeSha(raw) {
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toLowerCase();
  return SHA_RE.test(norm) ? norm : null;
}

/**
 * The verdict a summary states, or null. `matched` is the substring that decided
 * it, so an operator reading the event can see WHY without re-running the regex.
 */
export function deriveVerdict(summary) {
  if (typeof summary !== "string" || !summary) return null;
  for (const re of VERDICT_LADDER) {
    const m = summary.match(re);
    if (!m) continue;
    const verdict = normalizeVerdict(m[1]);
    if (verdict) return { verdict, source: "inferred", matched: m[0].trim() };
  }
  return null;
}

/**
 * The verdict for one completion record, and where it came from:
 *
 *   "declared"  the agent passed verdict= on report_completion (authoritative)
 *   "inferred"  read out of the summary prose by the ladder above
 *   "none"      a gate persona finished and stated nothing recognizable
 *   null        not a gate persona — the concept does not apply
 *
 * `declared` beats `inferred` unconditionally, including when they disagree: the
 * declared value is the one the agent chose to put in a field, and a summary
 * routinely quotes OTHER tickets' verdicts (dowtdh TEAM-4181's prose discusses
 * TEAM-4180's findings; f50ucz TEAM-4126's discusses CI TEAM-4157).
 */
export function resolveVerdict(record, assignee) {
  if (!GATE_PERSONAS.has(assignee)) return { verdict: null, verdictSource: null };
  const declared = normalizeVerdict(record?.verdict);
  if (declared) return { verdict: declared, verdictSource: "declared" };
  const inferred = deriveVerdict(record?.summary);
  if (inferred) return { verdict: inferred.verdict, verdictSource: "inferred", matched: inferred.matched };
  return { verdict: null, verdictSource: "none" };
}

/**
 * The head a gate persona actually tested, from STRUCTURED FIELDS ONLY (rule 2
 * above), in precedence order:
 *
 *   tested_head  the new explicit field — what the agent says it verified
 *   ci_head_sha  the CI agent's existing proven-build head (TEAM-4122 FR-4)
 *   commit_sha   the head the agent was sitting on, which is what every gate
 *                persona has always reported
 *
 * Both spellings of each are read because the same value lives under two
 * conventions: the S3 completion record is snake_case (`commit_sha`) and the
 * workflow's agentTasks entry is camelCase (`commitSha`), and this function is
 * called with each of them.
 */
export function resolveTestedHead(record) {
  if (!record || typeof record !== "object") return null;
  for (const field of ["tested_head", "testedHead", "ci_head_sha", "ciHeadSha", "commit_sha", "commitSha"]) {
    const sha = normalizeSha(record[field]);
    if (sha) return sha;
  }
  return null;
}

/** off | shadow | enforce. The three D1 flags all resolve through this. */
export const VERDICT_MODES = ["off", "shadow", "enforce"];

/**
 * UNSET → shadow; PRESENT-but-unrecognized → off.
 *
 * Both halves are deliberate and both differ from most flags in index.mjs. The
 * unset default is shadow (not off) because D1's whole point is that these three
 * holes are invisible today — a deployment that observes nothing tells us
 * nothing, and shadow writes no ticket, no blocker edge and no workflow row: it
 * publishes events. A garbage value falls to off rather than shadow (the
 * opposite of REWORK_LOOP_CAP) because the typo case is an operator who meant
 * something specific and got it wrong, and the safe reading of "I don't know
 * what you asked for" is to do nothing at all.
 */
export function normalizeVerdictMode(raw) {
  if (raw === undefined || raw === null) return "shadow";
  const norm = String(raw).trim().toLowerCase();
  if (!norm) return "shadow";
  return VERDICT_MODES.includes(norm) ? norm : "off";
}

/**
 * Should this gate persona's completion hold its successor, and on what?
 *
 * Returns, always the same five keys:
 *   reason              off | not-a-gate | no-verdict | pass | non-pass
 *   wouldSuppress       the decision, independent of mode (what shadow reports)
 *   suppress            wouldSuppress AND mode === "enforce" (what enforce acts on)
 *   blockOn             the open fix tickets the successor must wait for
 *   needsGateReverify   non-PASS with NOTHING to wait for
 *
 * `needsGateReverify` is the case f50ucz and the blueprints together create: a
 * gate persona may state a non-PASS verdict and file no fix ticket. Under
 * enforce the successor is still held — a non-PASS verdict must never unblock —
 * so the caller files ONE re-verify ticket and holds on that instead. Holding on
 * nothing would wedge the run; dispatching anyway would be the hole D1 closes.
 *
 * A null verdict never suppresses. "The agent stated nothing" is not "the agent
 * failed", and inventing a hold there would stall every run whose gate persona
 * writes a summary the ladder cannot read.
 */
export function evaluateGate({ assignee, verdict, spawnedTickets, mode } = {}) {
  const base = { reason: "off", wouldSuppress: false, suppress: false, blockOn: [], needsGateReverify: false };
  const normMode = normalizeVerdictMode(mode);
  if (normMode === "off") return base;
  if (!GATE_PERSONAS.has(assignee)) return { ...base, reason: "not-a-gate" };
  const normVerdict = normalizeVerdict(verdict);
  if (!normVerdict) return { ...base, reason: "no-verdict" };
  if (normVerdict === "PASS") return { ...base, reason: "pass" };

  const blockOn = [];
  for (const id of Array.isArray(spawnedTickets) ? spawnedTickets : []) {
    if (typeof id === "string" && id.trim() && !blockOn.includes(id.trim())) blockOn.push(id.trim());
  }
  return {
    reason: "non-pass",
    wouldSuppress: true,
    suppress: normMode === "enforce",
    blockOn,
    needsGateReverify: blockOn.length === 0,
  };
}

/**
 * The personas a fresh fix ticket must land BEFORE (FR-D1.7).
 *
 * An EXPLICIT id set, for exactly the reason GATE_PERSONAS is one: agents.json puts
 * ci_agent in the `review` phase, so "the verification-phase tickets" silently omits
 * the CI agent. code_reviewer is deliberately ABSENT — a review fix is filed BY the
 * reviewer, and blocking the reviewer's own open ticket on its own fix would park the
 * persona that has to re-verify it. release_manager is absent for the same reason
 * ship-phase ordering is already the live re-verify's job (live-reverify.mjs).
 */
export const FIX_BEFORE_VERIFY_PERSONAS = new Set([
  "agentcore_hub_qa_verifier",
  "agentcore_hub_ci_agent",
]);

/**
 * Which of a run's tickets must wait for a just-created fix ticket (FR-D1.7).
 *
 * dowtdh is the case, verbatim: TEAM-4183 `Fix (review): ActivityFeed clear/undo — 3
 * findings` was created with `blockedBy: []` at 23:18:03, and QA TEAM-4181 was
 * dispatched 78 seconds later against code the fix had not touched yet. The fix
 * existing is not the fix landing, so every open verifier downstream of it has to
 * gain a real blocker edge at creation time — not at the next cascade, which is
 * already too late.
 *
 * Pure, and every impure predicate is injected, so this is unit-testable with plain
 * objects and stays zero-import like the rest of this module:
 *   isFixKind(kind)  → is this ticket ITSELF a fix ticket (FIX_KINDS, completion.mjs)
 *   isAdvisory(t)    → isAdvisoryTicket (completion.mjs) — backlog the run never waits on
 *   phaseOf(t)       → the ticket's phase, board field first then the roster
 *
 * FIVE exclusions, each one a way this could wedge a run instead of gating it:
 *   1. the fix itself — a ticket may not block itself.
 *   2. closed tickets (done/cancelled) — nothing waits on a finished verifier, and an
 *      edge onto one is a permanent lie in the dependency graph.
 *   3. advisory tickets — by definition the run does not wait on them.
 *   4. OTHER FIX TICKETS. Two fix tickets arriving in one stream batch would each
 *      block the other and neither could ever start. This is the cycle guard, and it
 *      is why the check is on the target's own spawnedBy rather than on its phase.
 *   5. targets already carrying this fix in blockedBy — makes twin stream delivery a
 *      no-op instead of a duplicate write.
 */
export function selectFixBeforeVerifyTargets({ fixId, siblings, isFixKind, isAdvisory, phaseOf } = {}) {
  if (typeof fixId !== "string" || !fixId || !Array.isArray(siblings)) return [];
  const isFix = typeof isFixKind === "function" ? isFixKind : () => false;
  const advisory = typeof isAdvisory === "function" ? isAdvisory : () => false;
  const phase = typeof phaseOf === "function" ? phaseOf : (t) => t?.phase;
  const out = [];
  for (const t of siblings) {
    const id = t?.ticketId || t?.key;
    if (!id || id === fixId || out.includes(id)) continue;
    if (!FIX_BEFORE_VERIFY_PERSONAS.has(t?.assignee) && phase(t) !== "verification") continue;
    const status = String(t?.status || "").trim().toLowerCase();
    if (status === "done" || status === "cancelled") continue;
    if (advisory(t)) continue;
    if (isFix(t?.spawnedBy?.kind)) continue;
    if ((Array.isArray(t?.blockedBy) ? t.blockedBy : []).includes(fixId)) continue;
    out.push(id);
  }
  return out;
}

/**
 * The verdict fields on an `agent.complete` event detail.
 *
 * All four keys are ALWAYS present, with explicit off-defaults, rather than
 * spread in only when known: `agent.complete` is the event the UI, cost-report
 * and the replay harness all read, and a key that appears only sometimes forces
 * every one of them to distinguish "no verdict" from "an older orchestrator".
 * Fixed shape, fixed types:
 *
 *   verdict         one of VERDICTS, or null (non-gate persona / nothing stated)
 *   verdictSource   declared | inferred | none, or null for a non-gate persona
 *   spawnedTickets  the fix tickets this persona filed during the task — [], never null
 *   testedHead      the head it verified — "" when unknown, never null
 *
 * `spawnedTickets` and `testedHead` default to the EMPTY value of their own type
 * rather than to null so a consumer can `.length` / `.startsWith` unconditionally;
 * `verdict`/`verdictSource` stay nullable because "no verdict" is a real, distinct
 * state there and "" would read as a fifth enum value.
 *
 * `wouldSuppress` deliberately does NOT appear: whether a verdict WOULD have held
 * the successor is a property of one cascade decision under one flag mode, not of
 * the completion, and it lives on `orchestrator.verdict_observed` alone. Putting it
 * here would make the same completion carry different `agent.complete` details
 * depending on VERDICT_GATE, which is exactly what replay criterion (e) forbids.
 */
export function enrichCompleteDetail(base, info = {}) {
  return {
    ...base,
    verdict: normalizeVerdict(info.verdict),
    verdictSource: info.verdictSource ?? null,
    spawnedTickets: sanitizeTicketIds(info.spawnedTickets),
    testedHead: normalizeSha(info.testedHead) ?? "",
  };
}
