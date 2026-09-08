/**
 * ─── What a VALID ticket plan is, in one place (TEAM-4248 D3) ─────────────────
 *
 * Run wf_1788...c2uqki (dead-code-sweep on tycenjmccann/ember) dispatched its
 * code sweeper 92.3 SECONDS BEFORE the requirements analyst it depends on
 * finished:
 *
 *   TEAM-4229 requirements_analyst  agent.complete 11:42:10.105Z (unblocked=[])
 *   TEAM-4230 code_sweeper          INVOKED        11:40:37.834Z  ← 92.3s earlier
 *
 * TEAM-4230 was created with `blocked_by=[]`. Nothing rejected it: the plan the
 * analyst submits is stored verbatim, and create_ticket mints whatever it is
 * asked for. Only the analyst's own discipline — it happened to save
 * requirements.md before creating the sweeper ticket — kept the sweeper from
 * reading a document that did not exist yet. The run analysis found the same
 * shape on all three ember runs (0ph7b1, iczquj TEAM-2859, c2uqki TEAM-4230),
 * so it is the workflow definition's problem, not one model's bad day.
 *
 * The same runs invented branch names. All four c2uqki downstream tickets told
 * their persona to look at `chore/dead-code-sweep-2026-09-07`; the sweeper had
 * actually pushed `feature/TEAM-4230-code-sweeper`. The reviewer, QA and CI each
 * opened a session, discovered "Ticket-named branch does not exist", and
 * reconciled by hand — three chances to review the wrong tree.
 *
 * Zero imports, for exactly the reason fix-contract.mjs and ticket-blockers.mjs
 * have none: this module is BYTE-COPIED into three other Lambda zips
 * (agentcore-hub-tickets, agentcore-hub-jira, workflow-output), none of which
 * can import from lambda/orchestrator/. scripts/check-fix-kinds-parity.sh
 * byte-compares all four copies. Edit ONE, then cp it to the rest.
 *
 * TWO RULES, both learned from the fixtures:
 *
 *   1. THE ROOT IS FOUND BY ROLE, NEVER BY POSITION. A plan submitted to
 *      submit_ticket_plan does not contain its own root — the analyst is writing
 *      it FROM its own requirements ticket, so that ticket is absent and the
 *      first entry is unblocked on every healthy run. c2uqki's plan opens with
 *      the offender (TEAM-4230, blocked_by=[]) and this epic's own plan opens
 *      with a legitimate first-tier designer, also blocked_by=[]. "The first
 *      unblocked entry is the root" would therefore exempt precisely the defect
 *      it exists to catch. The root is opts.rootTicketId, else the entry whose
 *      role is requirements, else nothing — and nothing means FAIL OPEN.
 *
 *   2. A BRANCH NAME IS NEVER GUESSED FROM PROSE. The harness renders exactly
 *      one convention, `feature/<ticketId>-<persona-slug>` (index.mjs's
 *      buildAgentContext ## Branch block), and canonicalBranchFor below MUST
 *      reproduce that literal character for character — branch-name-parity.test.mjs
 *      reads index.mjs as TEXT and asserts it. Everything else found in a
 *      description is a token to be flagged, not a name to be trusted.
 *
 * Pure: no clock, no AWS, no I/O, and no env beyond the one normalizer — so the
 * whole thing is testable against the vendored c2uqki dossier fixtures.
 */

export const TICKET_PLAN_VALIDATOR_MODES = ["off", "shadow", "enforce"];

/**
 * UNSET → shadow; PRESENT-but-unrecognized → off.
 *
 * Byte-for-byte the same shape as verdict-contract.mjs's normalizeVerdictMode,
 * and deliberately so: an unset default of shadow because the two holes D3
 * closes are invisible today (a deployment that observes nothing tells us
 * nothing), and a garbage value falling to off rather than shadow because the
 * typo case is an operator who meant something specific and got it wrong, and
 * the safe reading of "I don't know what you asked for" is to do nothing at all.
 * It is re-implemented rather than imported because this module is zero-import
 * by contract (see the docblock).
 */
export function normalizeTicketPlanValidatorMode(raw) {
  if (raw === undefined || raw === null) return "shadow";
  const norm = String(raw).trim().toLowerCase();
  if (!norm) return "shadow";
  return TICKET_PLAN_VALIDATOR_MODES.includes(norm) ? norm : "off";
}

/**
 * The tickets argument as an ARRAY, whatever shape it arrived in.
 *
 * main.py's WorkflowOutput___submit_ticket_plan declares `tickets: str` and
 * passes a JSON string, so workflow-output's `ticket_count: tickets.length` has
 * been reporting the CHARACTER COUNT of that string since the tool was written
 * (a 6-ticket plan reports ~380). Accepts an array, a JSON string of an array,
 * or a `{tickets: [...]}` wrapper.
 *
 * Returns null — not [] — when the input is non-empty but does not resolve to an
 * array, so the caller can tell "nothing was sent" from "something unusable was
 * sent" and throw on the latter instead of silently persisting an empty plan.
 */
export function parseTicketPlanTickets(tickets) {
  if (tickets === undefined || tickets === null || tickets === "") return [];
  if (Array.isArray(tickets)) return tickets;
  if (typeof tickets === "string") {
    let parsed;
    try {
      parsed = JSON.parse(tickets);
    } catch {
      return null;
    }
    return parseTicketPlanTickets(parsed);
  }
  if (typeof tickets === "object") {
    if (Array.isArray(tickets.tickets)) return tickets.tickets;
    return null;
  }
  return null;
}

/**
 * Does this entry claim FIX LINEAGE — i.e. was it spawned by a gate persona as
 * rework?
 *
 * Deliberately tests for the PRESENCE of a spawnedBy kind rather than its
 * membership in FIX_KINDS. Re-implementing that set here would make an eighth
 * copy of it (scripts/check-fix-kinds-parity.sh already lists seven and exists
 * because each one is independently forgettable), and presence is the safer
 * predicate for every use below: anything claiming to be rework is EXEMPT from
 * the unblocked-non-root check, so an unrecognized kind fails open. A kind
 * outside FIX_KINDS cannot reach storage anyway — fix-contract.mjs refuses to
 * write one.
 */
function hasFixLineage(t) {
  const kind =
    t?.spawnedBy?.kind ?? t?.spawned_by_kind ?? t?.spawnedByKind ?? null;
  return typeof kind === "string" && kind.trim() !== "";
}

const isHumanAssignee = (a) => typeof a === "string" && a.startsWith("human:");

/**
 * Is this ticket ADVISORY — backlog the run does not wait on?
 *
 * The same semantics as completion.mjs's isAdvisoryTicket / advisoryNeverApplies
 * (TEAM-4122 FR-7, TEAM-4131 F2), re-implemented because this module is
 * zero-import: the marker is the literal label `advisory` as an EXACT word
 * (case- and whitespace-insensitive; "advisory-ish" is not advisory), and a fix
 * ticket or a human gate is never advisory no matter what it is labelled.
 *
 * One documented divergence: the fix-ticket exclusion uses hasFixLineage
 * (presence of a kind) where completion.mjs uses FIX_KINDS membership, to avoid
 * an eighth copy of that set. The shapes only differ for a spawnedBy.kind
 * outside FIX_KINDS, which fix-contract.mjs will not store, and in
 * validateTicketPlan both readings reach the same verdict — such an entry is
 * exempt either way (advisory OR fix lineage).
 */
export function isAdvisoryTicket(t) {
  if (!Array.isArray(t?.labels)) return false;
  if (!t.labels.some((l) => String(l).trim().toLowerCase() === "advisory")) return false;
  if (hasFixLineage(t)) return false;
  return !isHumanAssignee(t?.assignee);
}

const REQUIREMENTS_ASSIGNEE = "agentcore_hub_requirements_analyst";

/** A root in one of these states can no longer be raced. See validateTicketPlan. */
export const TERMINAL_ROOT_STATUSES = new Set(["done", "closed"]);

/** Is this entry the run's requirements ROOT — by role, never by position? */
export function isRequirementsRoot(t) {
  const assignee = String(t?.assignee || "").trim().toLowerCase();
  if (assignee === REQUIREMENTS_ASSIGNEE) return true;
  return String(t?.phase || "").trim().toLowerCase() === "requirements";
}

/** blocked_by as an array, across every spelling the two providers use. */
function blockersOf(t) {
  const raw = t?.blockedBy ?? t?.blocked_by ?? null;
  if (Array.isArray(raw)) return raw.filter((b) => String(b || "").trim() !== "");
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** How to name an entry in a violation message when it has no ticket id yet. */
function refOf(t) {
  return (
    t?.ticketId ||
    t?.ticket_id ||
    t?.key ||
    t?.title ||
    t?.summary ||
    "(untitled ticket)"
  );
}

/**
 * The one branch convention the harness renders. MUST stay character-identical
 * to index.mjs's buildAgentContext ## Branch block —
 * branch-name-parity.test.mjs reads that file as text and asserts it.
 */
export function canonicalBranchFor(ticketId, agentId, { advisory = false } = {}) {
  const slug = String(agentId || "")
    .replace(/^agentcore_hub_/, "")
    .replace(/_/g, "-");
  return `feature/${ticketId}-${advisory ? "advisory" : slug}`;
}

/**
 * A git-branch-shaped token in prose. The lookbehind stops the match at a real
 * word boundary but deliberately does NOT exclude a backtick, because that is
 * exactly how c2uqki's descriptions wrote it:
 *
 *   "...on branch `chore/dead-code-sweep-2026-09-07` -> main"
 */
export const BRANCH_TOKEN_RE =
  /(?<![\w/.-])(chore|feature|feat|fix|hotfix|release|bugfix)\/[A-Za-z0-9._/-]+/g;

/** The harness convention: feature/<TICKET-KEY>-<lowercase-slug>. */
export const CANONICAL_BRANCH_RE = /^feature\/[A-Z][A-Z0-9]+-\d+-[a-z0-9-]+$/;

/** Trailing punctuation a prose token collects that is not part of the name. */
function trimBranchToken(tok) {
  return String(tok).replace(/[.,;:)\]}'"]+$/, "");
}

/** Every branch-shaped token in a blob of text, de-duplicated, in order. */
export function findBranchTokens(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  for (const m of text.matchAll(BRANCH_TOKEN_RE)) {
    const tok = trimBranchToken(m[0]);
    if (tok && !out.includes(tok)) out.push(tok);
  }
  return out;
}

/**
 * Validate a ticket plan. NEVER throws — the caller decides what a violation
 * costs, and a bug in here must not be how a plan gets lost.
 *
 * Returns { ok, violations: [{ code, ticketRef, message }] }.
 *
 * Codes:
 *   unblocked-non-root  an entry with blocked_by=[] that is not the requirements
 *                       root, not advisory and claims no fix lineage, while the
 *                       root is still open. THE c2uqki DEFECT.
 *   invented-branch     a branch-shaped token in an entry's prose that is
 *                       neither a known branch nor the harness convention.
 *
 * Fails open on every uncertainty: no root resolvable → no unblocked-non-root
 * violations at all; a TERMINAL rootStatus → likewise (the plan is being
 * submitted or replayed after requirements closed, so an unblocked entry is
 * legitimate). Both providers' terminal names count — the jira Lambda's
 * mapStatusToInternal and the DynamoDB twin's TRANSITIONS each produce "done"
 * AND "closed", and reading a closed root as still-open would reject a legal
 * ticket for the rest of the run.
 */
export function validateTicketPlan(tickets, opts = {}) {
  const violations = [];
  const list = Array.isArray(tickets) ? tickets : [];
  if (!list.length) return { ok: true, violations };

  const { rootTicketId = null, rootStatus = null, knownBranches = [] } = opts;

  // ── 1. unblocked-non-root ───────────────────────────────────────────────────
  const rootDone = TERMINAL_ROOT_STATUSES.has(String(rootStatus || "").trim().toLowerCase());
  const roleRoot = list.find(isRequirementsRoot) || null;
  // Root by ROLE, never by position — see rule 1 in the docblock.
  const rootRef = rootTicketId || (roleRoot ? refOf(roleRoot) : null);

  if (!rootDone) {
    for (const t of list) {
      if (blockersOf(t).length) continue;
      if (t === roleRoot) continue; // the root itself is unblocked by definition
      if (rootTicketId && refOf(t) === rootTicketId) continue;
      if (isRequirementsRoot(t)) continue;
      if (isAdvisoryTicket(t)) continue; // declined scope stands outside the chain
      if (hasFixLineage(t)) continue; // rework is chained by the fix contract
      if (isHumanAssignee(t?.assignee) && !rootRef) continue; // hub-created gate, no root yet
      violations.push({
        code: "unblocked-non-root",
        ticketRef: refOf(t),
        message:
          `${refOf(t)} has blocked_by=[] but the requirements root ` +
          `${rootRef || "the requirements ticket"} is not done — a non-root ticket ` +
          `must be blocked_by at least one upstream ticket.`,
      });
    }
  }

  // ── 2. invented-branch ──────────────────────────────────────────────────────
  const known = new Set((knownBranches || []).filter(Boolean));
  for (const t of list) {
    const text = [t?.description, t?.summary, t?.title].filter(Boolean).join("\n");
    for (const tok of findBranchTokens(text)) {
      if (known.has(tok)) continue;
      if (CANONICAL_BRANCH_RE.test(tok)) continue;
      violations.push({
        code: "invented-branch",
        ticketRef: refOf(t),
        message:
          `${refOf(t)} names the branch "${tok}", which does not exist and does ` +
          `not follow the harness convention feature/<ticketId>-<persona-slug>. ` +
          `Do not invent branch names — the orchestrator tells each persona its ` +
          `branch in the ## Branch block.`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Rewrite every invented branch token in `text` to `canonical`.
 *
 * Returns { text, rewrites: [{ from, to }] } and leaves the input string
 * IDENTICAL (same reference semantics, `rewrites: []`) when there is nothing to
 * do, so a caller can use rewrites.length as its "did anything change" signal
 * without diffing.
 */
export function rewriteBranchNames(text, { canonical, knownBranches = [] } = {}) {
  if (typeof text !== "string" || !text || !canonical) {
    return { text: typeof text === "string" ? text : "", rewrites: [] };
  }
  const known = new Set((knownBranches || []).filter(Boolean));
  const rewrites = [];
  let out = text;
  for (const tok of findBranchTokens(text)) {
    if (tok === canonical) continue;
    if (known.has(tok)) continue;
    if (CANONICAL_BRANCH_RE.test(tok)) continue;
    out = out.split(tok).join(canonical);
    rewrites.push({ from: tok, to: canonical });
  }
  return { text: out, rewrites };
}
