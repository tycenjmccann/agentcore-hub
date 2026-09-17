/**
 * Ticket Flow layout — the pure geometry behind TicketFlowDag.
 *
 * Same graph the modal has always drawn (every edge is a `blockedBy`), with
 * two placement rules the old topological layering lacked:
 *
 *   1. Main-line columns are PHASE-ORDERED. A ticket's phase comes from its
 *      `phase` stamp, else its assignee's roster phase (the same precedence
 *      completion.mjs uses). Within a phase, tickets layer as-soon-as-possible
 *      by their main-line blockers, and every phase starts after the previous
 *      phase's last column — so a Ship ticket that only waits on rework never
 *      lands in the Requirements column.
 *   2. Tickets filed MID-RUN (fixes, re-certs, advisories — `spawnedBy`, or the
 *      title prefixes the agents use when the provider drops it) go in a REWORK
 *      band under the main line, directly beneath the ticket they unblock
 *      (as-late-as-possible through fix → re-cert chains). Advisories sit under
 *      the ticket that filed them.
 *
 * Deterministic, no graph library; the mock at
 * .local-workspace/design/ticket-flow-redesign/mockups.html#e is the visual spec.
 */

export interface FlowTicket {
  id: string;
  title: string;
  status: string;
  type: string;
  assignee?: string;
  blockedBy: string[];
  phase?: string;
  spawnedBy?: { kind?: string; [key: string]: unknown } | null;
  labels?: string[];
  createdAt?: string;
}

export type FlowKind =
  | "review_fix" | "qa_fix" | "codex_fix" | "ship_fix" | "ci_fix" | "sync_fix"
  | "recert" | "advisory" | "fix";

export interface FlowNode {
  id: string;
  ticket: FlowTicket;
  /** Display phase key (roster phase, "ci" for the CI agent, "cd" for merge/deploy gates). */
  phase: string;
  isHuman: boolean;
  /** null = planned main-line ticket; otherwise which kind of rework it is. */
  kind: FlowKind | null;
  band: "main" | "rework";
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  path: string;
  /** SVG polygon points for the arrowhead. */
  head: string;
  /** The blocker is done. */
  resolved: boolean;
}

export interface FlowCaption { phase: string; x: number; width: number }

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
  captions: FlowCaption[];
  width: number;
  height: number;
  /** y of the rework separator, or null when the run has no rework. */
  bandY: number | null;
  fixes: number;
  advisories: number;
}

export const FLOW_METRICS = {
  nodeW: 118,
  nodeH: 34,
  colGap: 26,
  rowGap: 8,
  bandRowGap: 14,
  captionH: 22,
  bandHead: 28,
} as const;

/** Canonical order for the phases the roster + defs use; unknown phases append in first-seen order. */
export const KNOWN_PHASE_ORDER = [
  "intake", "requirements", "design", "development", "review", "ci", "verification", "ship", "cd",
];

const FIX_KINDS = new Set<FlowKind>(["review_fix", "qa_fix", "codex_fix", "ship_fix", "ci_fix", "sync_fix"]);
const ORIGIN_KEYS = ["gateTicketId", "qaTicketId", "codexTicketId", "shipTicketId", "ciTicketId", "originTicketId"];

/** Display override: the CI agent is rostered under "review" but reads as its own step. */
const AGENT_DISPLAY_PHASE: Record<string, string> = { agentcore_hub_ci_agent: "ci" };

const CD_GATE_TITLE = /merge approval|deploy (approval|gate)|re-approval|handoff|post-deploy|\bCD\b/i;
/** The release manager's merge/deploy ticket is rostered "ship" but is the CD step. */
const CD_TICKET_TITLE = /^CD\b/i;

/** Which kind of rework a ticket is, or null for planned work. */
export function kindOf(t: FlowTicket): FlowKind | null {
  const title = t.title || "";
  // A re-cert is stamped with the kind of the fix it re-checks (ci_fix / ship_fix);
  // for the reader it is a re-cert, so the title wins here.
  if (/^CI \(re-cert\)|\bre-cert(ify|ification)?\b/i.test(title)) return "recert";
  const k = t.spawnedBy?.kind;
  if (typeof k === "string" && FIX_KINDS.has(k as FlowKind)) return k as FlowKind;
  if ((t.labels || []).includes("advisory") || /^advisory\b/i.test(title)) return "advisory";
  const m = /^fix\s*\(([^)]*)\)/i.exec(title);
  if (m) {
    const src = m[1].toLowerCase();
    if (src.startsWith("qa")) return "qa_fix";
    if (src.startsWith("review") || src.startsWith("code review")) return "review_fix";
    if (src.startsWith("ci")) return "ci_fix";
    if (src.startsWith("sync")) return "sync_fix";
    if (src.startsWith("ship")) return "ship_fix";
    return "fix";
  }
  if (/^fix\b/i.test(title)) return "fix";
  return null;
}

/** The ticket that filed a rework ticket, when the record says so. */
export function filerOf(t: FlowTicket): string | null {
  const sb = t.spawnedBy;
  if (!sb) return null;
  for (const key of ORIGIN_KEYS) {
    const v = sb[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export interface LayoutOptions {
  /** Roster lookup: assignee agentId → agents.json phase. */
  agentPhaseOf: (agentId: string) => string | undefined;
  /** Phase order from the workflow definition; merged onto KNOWN_PHASE_ORDER. */
  phaseOrder?: string[];
}

function byCreated(a: FlowTicket, b: FlowTicket): number {
  const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
  const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
  return ta - tb || a.id.localeCompare(b.id);
}

export function layoutTicketFlow(all: FlowTicket[], opts: LayoutOptions): FlowLayout {
  const M = FLOW_METRICS;
  const tickets = all.filter((t) => t.type !== "epic");
  const byId = new Map(tickets.map((t) => [t.id, t]));

  const order = [...KNOWN_PHASE_ORDER];
  for (const p of opts.phaseOrder || []) if (!order.includes(p)) order.push(p);
  const rank = (p: string) => {
    const i = order.indexOf(p);
    if (i >= 0) return i;
    order.push(p);
    return order.length - 1;
  };

  const kinds = new Map(tickets.map((t) => [t.id, kindOf(t)]));
  const isHuman = (t: FlowTicket) => !!t.assignee?.startsWith("human:");
  const main = tickets.filter((t) => kinds.get(t.id) === null);
  const rework = tickets.filter((t) => kinds.get(t.id) !== null);
  const inMain = new Set(main.map((t) => t.id));

  // Phase of a main-line ticket. Human gates carry no roster entry: merge/deploy
  // gates form a trailing "cd" group, other gates sit with the phase they guard.
  const phaseCache = new Map<string, string>();
  const phaseOf = (t: FlowTicket, depth = 0): string => {
    const hit = phaseCache.get(t.id);
    if (hit) return hit;
    let p: string | undefined;
    if (isHuman(t)) {
      if (CD_GATE_TITLE.test(t.title || "")) p = "cd";
      else if (t.phase) p = t.phase;
      else if (depth < 8) {
        const guarded = t.blockedBy
          .map((b) => byId.get(b))
          .filter((b): b is FlowTicket => !!b && inMain.has(b.id))
          .map((b) => phaseOf(b, depth + 1));
        if (guarded.length) p = guarded.sort((a, b) => rank(b) - rank(a))[0];
      }
      p = p || "cd";
    } else {
      const roster = t.assignee ? opts.agentPhaseOf(t.assignee) : undefined;
      const override = t.assignee ? AGENT_DISPLAY_PHASE[t.assignee] : undefined;
      p = CD_TICKET_TITLE.test(t.title || "") ? "cd" : override || t.phase || roster || "other";
    }
    phaseCache.set(t.id, p);
    return p;
  };

  // 1. Main line: phase-ordered groups, ASAP by main-line blockers inside a group.
  const col = new Map<string, number>();
  const phases = Array.from(new Set(main.map((t) => phaseOf(t)))).sort((a, b) => rank(a) - rank(b));
  let base = 0;
  for (const p of phases) {
    const group = main.filter((t) => phaseOf(t) === p).sort(byCreated);
    let pending = group.slice();
    let maxc = base - 1;
    let guard = 0;
    while (pending.length && guard++ < 100) {
      const considered = (t: FlowTicket) =>
        t.blockedBy.filter((b) => inMain.has(b) && rank(phaseOf(byId.get(b)!)) <= rank(p));
      const ready = pending.filter((t) => considered(t).every((b) => col.has(b)));
      for (const t of ready.length ? ready : pending) {
        const c = Math.max(base, ...considered(t).filter((b) => col.has(b)).map((b) => col.get(b)! + 1));
        col.set(t.id, c);
        if (c > maxc) maxc = c;
      }
      pending = pending.filter((t) => !col.has(t.id));
    }
    base = maxc + 1;
  }

  // 2. Rework: under the ticket it unblocks (ALAP through chains); advisories under their filer.
  const dependentsOf = (id: string) => tickets.filter((t) => t.blockedBy.includes(id));
  const memo = new Map<string, number>();
  const reworkCol = (t: FlowTicket, seen = new Set<string>()): number => {
    const hit = memo.get(t.id);
    if (hit !== undefined) return hit;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const deps = dependentsOf(t.id);
    let c: number;
    if (deps.length) {
      c = Math.min(...deps.map((d) => (inMain.has(d.id) ? col.get(d.id) ?? 0 : reworkCol(d, seen) - 1)));
    } else {
      const filer = filerOf(t);
      if (filer && col.has(filer)) c = col.get(filer)!;
      else {
        const placed = t.blockedBy.filter((b) => col.has(b)).map((b) => col.get(b)! + 1);
        c = placed.length ? Math.max(...placed) : 0;
      }
    }
    c = Math.max(0, c);
    memo.set(t.id, c);
    return c;
  };
  for (const t of rework) col.set(t.id, reworkCol(t));

  // 3. Rows. Main stacks by creation; the band stacks by the row of the main ticket it feeds.
  const ncols = tickets.length ? Math.max(...Array.from(col.values())) + 1 : 0;
  const mainRows = new Array<number>(ncols).fill(0);
  const bandRows = new Array<number>(ncols).fill(0);
  const mainRow = new Map<string, number>();
  const nodes: FlowNode[] = [];
  const stepX = M.nodeW + M.colGap;

  for (const t of main.slice().sort(byCreated)) {
    const c = col.get(t.id)!;
    const r = mainRows[c]++;
    mainRow.set(t.id, r);
    nodes.push({ id: t.id, ticket: t, phase: phaseOf(t), isHuman: isHuman(t), kind: null, band: "main",
      col: c, row: r, x: c * stepX, y: M.captionH + r * (M.nodeH + M.rowGap) });
  }
  const mainH = Math.max(0, Math.max(0, ...mainRows) * (M.nodeH + M.rowGap) - M.rowGap);
  const bandY = rework.length ? M.captionH + mainH + 12 : null;

  const feeds = (t: FlowTicket) => {
    const rows = dependentsOf(t.id)
      .filter((d) => inMain.has(d.id) && col.get(d.id) === col.get(t.id))
      .map((d) => mainRow.get(d.id) ?? 99);
    return rows.length ? Math.min(...rows) : 99;
  };
  for (const t of rework.slice().sort((a, b) => feeds(a) - feeds(b) || byCreated(a, b))) {
    const c = col.get(t.id)!;
    const r = bandRows[c]++;
    nodes.push({ id: t.id, ticket: t, phase: phaseOf(t), isHuman: isHuman(t), kind: kinds.get(t.id)!, band: "rework",
      col: c, row: r, x: c * stepX, y: (bandY ?? 0) + M.bandHead + r * (M.nodeH + M.bandRowGap) });
  }
  const bandH = rework.length ? Math.max(0, ...bandRows) * (M.nodeH + M.bandRowGap) - M.bandRowGap : 0;

  const width = Math.max(0, ncols * stepX - M.colGap);
  const height = bandY !== null ? bandY + M.bandHead + bandH + 4 : M.captionH + mainH + 4;

  // Captions: one per phase group, spanning its columns.
  const captions: FlowCaption[] = [];
  for (const p of phases) {
    const cols = nodes.filter((n) => n.band === "main" && n.phase === p).map((n) => n.col);
    if (!cols.length) continue;
    const c0 = Math.min(...cols), c1 = Math.max(...cols);
    captions.push({ phase: p, x: c0 * stepX, width: (c1 - c0 + 1) * stepX - M.colGap });
  }

  // Edges: every blockedBy. A rework card directly under its main ticket points straight up.
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const edges: FlowEdge[] = [];
  for (const t of tickets) {
    for (const b of t.blockedBy) {
      const from = pos.get(b), to = pos.get(t.id);
      if (!from || !to) continue;
      const resolved = byId.get(b)?.status === "done";
      if (from.col === to.col && from.y > to.y) {
        const xv = to.x + 14 + (mainRow.get(t.id) ?? 0) * 12;
        const ay = to.y + M.nodeH + 1;
        edges.push({ from: b, to: t.id, resolved,
          path: `M${xv},${from.y - 1} L${xv},${ay}`,
          head: `${xv},${ay} ${xv - 3},${ay + 5} ${xv + 3},${ay + 5}` });
      } else if (to.col < from.col) {
        // A later ticket unblocking an earlier one (a human gate releasing the
        // parked ship ticket): hook the near sides so the arrow stays between
        // the two columns instead of crossing the diagram.
        const x1 = from.x - 1, y1 = from.y + M.nodeH / 2;
        const x2 = to.x + M.nodeW + 1, y2 = to.y + M.nodeH / 2;
        const mx = (x1 + x2) / 2;
        edges.push({ from: b, to: t.id, resolved,
          path: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
          head: `${x2},${y2} ${x2 + 5},${y2 - 3} ${x2 + 5},${y2 + 3}` });
      } else {
        const x1 = from.x + M.nodeW + 1, y1 = from.y + M.nodeH / 2;
        const x2 = to.x - 1, y2 = to.y + M.nodeH / 2;
        const mx = (x1 + x2) / 2;
        const path = x2 > x1
          ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
          : `M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`;
        edges.push({ from: b, to: t.id, resolved, path,
          head: `${x2},${y2} ${x2 - 5},${y2 - 3} ${x2 - 5},${y2 + 3}` });
      }
    }
  }

  return {
    nodes, edges, captions, width, height, bandY,
    fixes: rework.filter((t) => kinds.get(t.id) !== "advisory").length,
    advisories: rework.filter((t) => kinds.get(t.id) === "advisory").length,
  };
}
