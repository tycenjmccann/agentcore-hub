/**
 * TEAM-4246 D1 PARITY — hand-port of lambda/orchestrator/completion.mjs
 * `evaluateVerifiedHeads` (and its local `normalizeHeadSha`), for the HTTP
 * completion route.
 *
 * The route is a second, human-driven way to close a run (the Workflow Manager's
 * `complete` intervention), and it already hand-ports the evidence gate and the
 * ship-verdict gate for exactly that reason: a gate that only the orchestrator
 * enforces is a gate with a bypass. This is the third one.
 *
 * Lives in a lib module rather than inline in route.ts because a Next.js route
 * file may only export HTTP handlers — an exported helper there fails the build's
 * route type-check, so the parity test could never drive it. Same shape as
 * completion-evidence.ts / ship-review.ts, which the route imports for the same
 * reason. src/lib/workflow/verified-heads-parity.test.ts pins this port against
 * the .mjs original over a shared table.
 *
 * Keep in agreement with completion.mjs.
 */

/** PARITY MIRROR of FIX_KINDS (completion.mjs / fix-contract.mjs / types.ts). */
const FIX_KINDS = new Set(["review_fix", "qa_fix", "codex_fix", "ship_fix", "ci_fix", "sync_fix"]);

export const QA_VERIFIER_ID = "agentcore_hub_qa_verifier";
export const CI_AGENT_ID = "agentcore_hub_ci_agent";

/**
 * PARITY MIRROR of GATE_PERSONA_IDS. It used to keep a gate persona's own
 * `commitSha` out of the PR-head derivation; TEAM-4264 F3 deleted that
 * derivation, so this now has no reader here either and stays exported for the
 * parity guard, exactly as in the .mjs original.
 */
export const GATE_PERSONA_IDS = new Set([
  "agentcore_hub_code_reviewer",
  QA_VERIFIER_ID,
  CI_AGENT_ID,
  "agentcore_hub_release_manager",
]);

const HEAD_SHA_RE = /^[0-9a-f]{7,40}$/;

/** 7-40 lowercase hex or nothing: a head is never inferred from prose (D1 rule 2). */
export function normalizeHeadSha(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toLowerCase();
  return HEAD_SHA_RE.test(norm) ? norm : null;
}

export interface HeadTicketLike {
  ticketId?: string;
  type?: string;
  status?: string;
  assignee?: string;
  labels?: unknown;
  completedAt?: string;
  spawnedBy?: { kind?: string } | null;
}

export interface HeadTaskLike {
  ticketId?: string;
  agentId?: string;
  completedAt?: string;
  testedHead?: unknown;
  tested_head?: unknown;
  ci_head_sha?: unknown;
  ciHeadSha?: unknown;
  commitSha?: unknown;
  commit_sha?: unknown;
}

export interface VerifiedHeads {
  ok: boolean;
  reason: null | "open-fix" | "head-divergence";
  heads: { qa: string | null; ci: string | null; pr: string | null };
  offenders: string[];
  stalePersonas: string[];
}

const isHuman = (a: unknown) => typeof a === "string" && a.startsWith("human:");

/** PARITY: completion.mjs isOpen — anything not done and not cancelled. */
const isOpen = (t: HeadTicketLike) => t.status !== "done" && t.status !== "cancelled";

/**
 * PARITY: completion.mjs isAdvisoryTicket + advisoryNeverApplies (TEAM-4131 F2).
 * A fix ticket (or a human gate) is never advisory whatever its labels say — which
 * is why the clause below can never excuse an open fix; it is kept for shape
 * parity with the original, not for effect.
 */
function isAdvisoryTicket(t: HeadTicketLike): boolean {
  if (!Array.isArray(t?.labels)) return false;
  if (!t.labels.some((l) => String(l).trim().toLowerCase() === "advisory")) return false;
  if (t?.spawnedBy && FIX_KINDS.has(String(t.spawnedBy.kind))) return false;
  return !isHuman(t?.assignee);
}

/** First readable head among `fields`, in order. Structured fields ONLY. */
function headFrom(entry: HeadTaskLike | undefined, fields: Array<keyof HeadTaskLike>): string | null {
  for (const field of fields) {
    const sha = normalizeHeadSha(entry?.[field]);
    if (sha) return sha;
  }
  return null;
}

/** Prefix equality counts: the same head arrives as a short sha and a full one. */
const sameHead = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a);

/**
 * May this run close at the head it is about to ship? See the .mjs original for
 * the full argument; the rules, verbatim:
 *   - "open-fix" (checked first, EPIC-WIDE — isWorkflowComplete only waits on
 *     fixes routed under a required phase, and dowtdh's fix was not one);
 *   - "head-divergence" when the known heads are not all the same commit;
 *   - fewer than two KNOWN heads is never divergence (unknown is unknown);
 *   - heads.pr is `opts.prHeadSha` and nothing else (TEAM-4264 F3): never a dev
 *     ticket's `commitSha`, never `mergeCommit`. Null is unknown, not divergence
 *     — but two KNOWN heads that differ (QA vs CI) still are, and with no PR
 *     head to appeal to both verifiers are reported stale;
 *   - `delivery.mode` is never read — a handoff PR must be verified too.
 */
export function evaluateVerifiedHeads(
  children: HeadTicketLike[],
  agentTasks: Record<string, HeadTaskLike>,
  opts: { prHeadSha?: unknown } = {}
): VerifiedHeads {
  const heads: VerifiedHeads["heads"] = { qa: null, ci: null, pr: normalizeHeadSha(opts.prHeadSha) };
  // Aliases `heads` on purpose, as in the original: a pass still reports what was
  // compared.
  const inert: VerifiedHeads = { ok: true, reason: null, heads, offenders: [], stalePersonas: [] };
  if (!Array.isArray(children) || children.length === 0) return inert;

  const tasks = agentTasks && typeof agentTasks === "object" ? agentTasks : {};
  const byTicketId = new Map<string, HeadTaskLike>();
  for (const entry of Object.values(tasks)) {
    if (entry && typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
  }

  // `pr` is not in here: it is the caller's fact, never scanned for.
  const at: Record<"qa" | "ci", string> = { qa: "", ci: "" };
  const take = (slot: "qa" | "ci", sha: string | null, when: string) => {
    if (!sha || when < at[slot]) return;
    heads[slot] = sha;
    at[slot] = when;
  };

  const openFixes: string[] = [];
  for (const t of children) {
    if (!t || t.type === "epic") continue;
    if (t.spawnedBy && FIX_KINDS.has(String(t.spawnedBy.kind)) && isOpen(t) && !isAdvisoryTicket(t)) {
      const id = String(t.ticketId || "");
      if (id && !openFixes.includes(id)) openFixes.push(id);
    }
    if (String(t.status || "").toLowerCase() !== "done") continue;
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    if (!entry) continue;
    const assignee = t.assignee || entry.agentId || "";
    const when = String(entry.completedAt || t.completedAt || "");
    if (assignee === QA_VERIFIER_ID) {
      take("qa", headFrom(entry, ["testedHead", "tested_head"]), when);
    } else if (assignee === CI_AGENT_ID) {
      take("ci", headFrom(entry, ["testedHead", "tested_head", "ci_head_sha", "ciHeadSha"]), when);
    }
    // NOTHING derives heads.pr (TEAM-4264 F3). A dev ticket's commitSha is the
    // head that ticket produced, not the head the run is shipping.
  }

  if (openFixes.length > 0) {
    return { ok: false, reason: "open-fix", heads, offenders: openFixes, stalePersonas: [] };
  }

  const known = Object.entries(heads).filter(([, sha]) => sha) as Array<[string, string]>;
  if (known.length < 2) return inert;
  if (known.every(([, a]) => known.every(([, b]) => sameHead(a, b)))) return inert;

  const personaOf: Record<string, string> = { qa: QA_VERIFIER_ID, ci: CI_AGENT_ID };
  const stalePersonas = (["qa", "ci"] as const)
    .filter((slot) => heads[slot] && (!heads.pr || !sameHead(heads[slot] as string, heads.pr)))
    .map((slot) => personaOf[slot]);
  return { ok: false, reason: "head-divergence", heads, offenders: [], stalePersonas };
}

/**
 * off | shadow | enforce — PARITY with verdict-contract.mjs normalizeVerdictMode:
 * UNSET → shadow, PRESENT-but-unrecognized → off (a typo must not silently
 * enforce a hold).
 */
export function normalizeVerifiedHeadMode(raw: unknown): "off" | "shadow" | "enforce" {
  if (raw === undefined || raw === null || String(raw).trim() === "") return "shadow";
  const v = String(raw).trim().toLowerCase();
  return v === "off" || v === "shadow" || v === "enforce" ? v : "off";
}
