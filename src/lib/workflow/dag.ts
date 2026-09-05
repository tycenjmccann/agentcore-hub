/**
 * TEAM-3992 D3.4 — ticket-plan DAG validator (console/API side).
 *
 * PARITY TWIN of lambda/orchestrator/dag.mjs — byte-for-byte the same logic, kept
 * in lock-step the way lease.ts↔lease.mjs and repo-check.ts↔repo-check.mjs are,
 * and pinned by dag-parity.test.ts (identical fixtures → deep-equal outputs).
 * Change one, change the other, extend the parity test.
 *
 * A workflow def may declare a `ticketDag`: the STRUCTURAL contract a run's ticket
 * plan must satisfy. This module is PURE (no I/O): callers pass the plan, the dag,
 * and the agent roster. See dag.mjs for the full contract prose — the two files
 * carry the same docblock deliberately.
 *
 * Node mapping order (first match wins): explicit `role` → a node's `agentIds` →
 * a node's `agentPhases` via roster phase → `titlePrefix` → `gate` (human:*).
 * Tickets matching `allowedExtraNodes` are EXEMPT. Required edges are satisfied
 * through same-node serial chaining (or `fallbackFrom` when the `from` node is
 * absent); forbidden edges use the full transitive blocker closure.
 *
 * Violation codes: missing_required_edge, forbidden_edge, node_cardinality,
 * unmapped_ticket, unknown_blocker_key, cycle.
 */

export interface DagNode {
  agentIds?: string[];
  agentPhases?: string[];
  titlePrefix?: string;
  gate?: string;
  min?: number;
  max?: number;
}

export interface DagEdge {
  from: string;
  to: string;
  fallbackFrom?: string;
}

export interface ExtraNodeRule {
  spawnedByKinds?: string[];
  spawnedByKey?: string;
  titlePattern?: string;
}

export interface FixRearm {
  [kind: string]: string[] | boolean;
}

export interface TicketDag {
  nodes: Record<string, DagNode>;
  edges: DagEdge[];
  forbiddenEdges?: DagEdge[];
  allowedExtraNodes?: Record<string, ExtraNodeRule>;
  fixRearm?: FixRearm;
}

export interface PlanTicket {
  id?: string;
  key?: string;
  ticket_id?: string;
  ref?: string;
  title?: string;
  summary?: string;
  assignee?: string;
  role?: string;
  blocked_by?: string | string[];
  blockedBy?: string | string[];
  spawned_by?: { kind?: string };
  spawnedBy?: { kind?: string };
  spawned_by_kind?: string;
  [k: string]: unknown;
}

export type Violation =
  | { code: "unmapped_ticket"; ticket: string; assignee: string }
  | { code: "unknown_blocker_key"; ticket: string; key: string }
  | { code: "cycle"; cycle: string[] }
  | { code: "node_cardinality"; node: string; count: number; min: number; max: number | null }
  | { code: "missing_required_edge"; from: string; to: string; ticket: string }
  | { code: "forbidden_edge"; from: string; to: string; ticket: string };

export interface PlanMapping {
  nodeOf: Record<string, string>;
  byNode: Record<string, string[]>;
  extras: string[];
  unmapped: string[];
  ids: string[];
  byId: Record<string, PlanTicket>;
  tickets: PlanTicket[];
}

type RosterLike =
  | Array<{ agentId?: string; phase?: string }>
  | { agents?: Array<{ agentId?: string; phase?: string }> }
  | Record<string, unknown>;

function ticketId(t: PlanTicket): string {
  return String(t?.id ?? t?.key ?? t?.ticket_id ?? t?.ref ?? t?.title ?? "");
}

function titleOf(t: PlanTicket): string {
  return String(t?.title ?? t?.summary ?? "");
}

function blockersOf(t: PlanTicket): string[] {
  const raw = t?.blocked_by ?? t?.blockedBy ?? [];
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [raw];
  return arr
    .map((x) => String(x).trim())
    .filter((x) => x && x.toLowerCase() !== "none");
}

/** Normalize any accepted roster shape to an { agentId → phase } map. */
export function phaseByAgentOf(roster: RosterLike | undefined | null): Record<string, string> {
  const m: Record<string, string> = {};
  if (Array.isArray(roster)) {
    for (const r of roster) if (r?.agentId) m[r.agentId] = r.phase || "";
  } else if (roster && typeof roster === "object") {
    const agents = (roster as { agents?: Array<{ agentId?: string; phase?: string }> }).agents;
    if (Array.isArray(agents)) {
      for (const r of agents) if (r?.agentId) m[r.agentId] = r.phase || "";
    } else {
      for (const [k, v] of Object.entries(roster as Record<string, unknown>)) {
        m[k] = v && typeof v === "object" ? (v as { phase?: string }).phase || "" : String(v ?? "");
      }
    }
  }
  return m;
}

function extraNodeMatch(t: PlanTicket, dag: TicketDag): string | null {
  const extra = dag?.allowedExtraNodes || {};
  const title = titleOf(t);
  const kind = t?.spawned_by?.kind ?? t?.spawnedBy?.kind ?? t?.spawned_by_kind ?? "";
  for (const [name, rule] of Object.entries(extra)) {
    if (rule?.spawnedByKinds && kind && rule.spawnedByKinds.includes(kind)) return name;
    if (rule?.spawnedByKey && t?.[rule.spawnedByKey] != null) return name;
    if (rule?.titlePattern && new RegExp(rule.titlePattern).test(title)) return name;
  }
  return null;
}

function nodeForTicket(t: PlanTicket, dag: TicketDag, phaseByAgent: Record<string, string>): string | null {
  const nodes = dag?.nodes || {};
  const keys = Object.keys(nodes);
  const assignee = String(t?.assignee ?? "");
  const title = titleOf(t);
  const role = t?.role ? String(t.role) : "";

  if (role && nodes[role]) return role;

  const byAgent = keys.filter((k) => (nodes[k].agentIds || []).includes(assignee));
  if (byAgent.length === 1) return byAgent[0];
  if (byAgent.length > 1) {
    const byPrefix = byAgent.find((k) => nodes[k].titlePrefix && title.startsWith(nodes[k].titlePrefix as string));
    return byPrefix || byAgent[0];
  }

  const phase = phaseByAgent[assignee] || "";
  if (phase) {
    const byPhase = keys.filter((k) => (nodes[k].agentPhases || []).includes(phase));
    if (byPhase.length === 1) return byPhase[0];
    if (byPhase.length > 1) {
      const byPrefix = byPhase.find((k) => nodes[k].titlePrefix && title.startsWith(nodes[k].titlePrefix as string));
      return byPrefix || byPhase[0];
    }
  }

  const byPrefixOnly = keys.find((k) => nodes[k].titlePrefix && title.startsWith(nodes[k].titlePrefix as string));
  if (byPrefixOnly) return byPrefixOnly;

  if (assignee.startsWith("human:")) {
    const byGate = keys.find((k) => nodes[k].gate && title.includes(nodes[k].gate as string));
    if (byGate) return byGate;
  }
  return null;
}

/** Map every plan ticket to its DAG node (or extra/unmapped bucket). */
export function mapPlanToNodes(
  plan: { tickets?: PlanTicket[] } | PlanTicket[] | undefined,
  dag: TicketDag,
  roster: RosterLike | undefined | null
): PlanMapping {
  const tickets = Array.isArray((plan as { tickets?: PlanTicket[] })?.tickets)
    ? (plan as { tickets: PlanTicket[] }).tickets
    : Array.isArray(plan)
      ? (plan as PlanTicket[])
      : [];
  const phaseByAgent = phaseByAgentOf(roster);
  const nodeOf: Record<string, string> = {};
  const byNode: Record<string, string[]> = {};
  const extras: string[] = [];
  const unmapped: string[] = [];
  const ids: string[] = [];
  const byId: Record<string, PlanTicket> = {};
  for (const t of tickets) {
    const id = ticketId(t);
    ids.push(id);
    byId[id] = t;
    const ex = extraNodeMatch(t, dag);
    if (ex) {
      extras.push(id);
      continue;
    }
    const node = nodeForTicket(t, dag, phaseByAgent);
    if (node) {
      nodeOf[id] = node;
      (byNode[node] = byNode[node] || []).push(id);
    } else {
      unmapped.push(id);
    }
  }
  return { nodeOf, byNode, extras, unmapped, ids, byId, tickets };
}

function detectCycles(ids: string[], blockersById: Record<string, string[]>): string[][] {
  const idSet = new Set(ids);
  const color: Record<string, number> = {};
  const cycles: string[][] = [];
  const seenCycle = new Set<string>();
  const stackArr: string[] = [];
  function visit(id: string) {
    color[id] = 1;
    stackArr.push(id);
    for (const b of blockersById[id] || []) {
      if (!idSet.has(b)) continue;
      if (color[b] === 1) {
        const from = stackArr.indexOf(b);
        const cyc = stackArr.slice(from).concat(b);
        const canon = [...cyc].sort().join("|");
        if (!seenCycle.has(canon)) {
          seenCycle.add(canon);
          cycles.push(cyc);
        }
      } else if (!color[b]) {
        visit(b);
      }
    }
    stackArr.pop();
    color[id] = 2;
  }
  for (const id of ids) if (!color[id]) visit(id);
  return cycles;
}

function _validate(tickets: PlanTicket[], dag: TicketDag, roster: RosterLike | undefined | null): Violation[] {
  const mapping = mapPlanToNodes({ tickets }, dag, roster);
  const idSet = new Set(mapping.ids);
  const blockersById: Record<string, string[]> = {};
  for (const t of tickets) blockersById[ticketId(t)] = blockersOf(t);
  const nodeOf = mapping.nodeOf;
  const nodes = dag?.nodes || {};
  const violations: Violation[] = [];

  for (const id of mapping.unmapped) {
    violations.push({ code: "unmapped_ticket", ticket: id, assignee: String(mapping.byId[id]?.assignee ?? "") });
  }

  for (const id of mapping.ids) {
    for (const b of blockersById[id] || []) {
      if (!idSet.has(b)) violations.push({ code: "unknown_blocker_key", ticket: id, key: b });
    }
  }

  for (const cyc of detectCycles(mapping.ids, blockersById)) {
    violations.push({ code: "cycle", cycle: cyc });
  }

  for (const [node, cfg] of Object.entries(nodes)) {
    const count = (mapping.byNode[node] || []).length;
    const min = cfg.min ?? 0;
    const max = cfg.max ?? null;
    if (count < min || (max != null && count > max)) {
      violations.push({ code: "node_cardinality", node, count, min, max });
    }
  }

  function closure(startId: string): Set<string> {
    const seen = new Set<string>();
    const stack = [...(blockersById[startId] || [])];
    while (stack.length) {
      const x = stack.pop() as string;
      if (!idSet.has(x) || seen.has(x)) continue;
      seen.add(x);
      for (const y of blockersById[x] || []) stack.push(y);
    }
    return seen;
  }

  function reachThroughNode(startId: string, throughNode: string): Set<string> {
    const encountered = new Set<string>();
    const walked = new Set<string>();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop() as string;
      for (const b of blockersById[cur] || []) {
        if (!idSet.has(b)) continue;
        encountered.add(b);
        if (nodeOf[b] === throughNode && !walked.has(b)) {
          walked.add(b);
          stack.push(b);
        }
      }
    }
    return encountered;
  }

  for (const edge of dag?.edges || []) {
    const toTickets = mapping.byNode[edge.to] || [];
    if (toTickets.length === 0) continue;
    const fromExists = (mapping.byNode[edge.from] || []).length > 0;
    for (const tid of toTickets) {
      const enc = reachThroughNode(tid, edge.to);
      if ([...enc].some((id) => nodeOf[id] === edge.from)) continue;
      if (!fromExists && edge.fallbackFrom && [...enc].some((id) => nodeOf[id] === edge.fallbackFrom)) continue;
      violations.push({ code: "missing_required_edge", from: edge.from, to: edge.to, ticket: tid });
    }
  }

  for (const edge of dag?.forbiddenEdges || []) {
    for (const tid of mapping.byNode[edge.to] || []) {
      const clo = closure(tid);
      if ([...clo].some((id) => nodeOf[id] === edge.from)) {
        violations.push({ code: "forbidden_edge", from: edge.from, to: edge.to, ticket: tid });
      }
    }
  }

  return violations;
}

/** Validate a submitted ticket PLAN. */
export function validateTicketPlan(
  plan: { tickets?: PlanTicket[] } | PlanTicket[] | undefined,
  dag: TicketDag,
  roster: RosterLike | undefined | null
): { ok: boolean; violations: Violation[] } {
  const tickets = Array.isArray((plan as { tickets?: PlanTicket[] })?.tickets)
    ? (plan as { tickets: PlanTicket[] }).tickets
    : Array.isArray(plan)
      ? (plan as PlanTicket[])
      : [];
  const violations = _validate(tickets, dag, roster);
  return { ok: violations.length === 0, violations };
}

/** Validate the REALIZED graph of created child tickets. */
export function validateRealizedGraph(
  children: PlanTicket[] | { tickets?: PlanTicket[] },
  dag: TicketDag,
  roster: RosterLike | undefined | null
): Violation[] {
  const tickets = Array.isArray(children)
    ? children
    : Array.isArray((children as { tickets?: PlanTicket[] })?.tickets)
      ? (children as { tickets: PlanTicket[] }).tickets
      : [];
  return _validate(tickets, dag, roster);
}

/**
 * Structural sanity of a ticketDag definition itself. Throws a specific Error
 * when an edge (or fallbackFrom / forbiddenEdge) references an undeclared node,
 * or when the edge set contains a cycle. Called by the def loader so a bad
 * hand-edit of workflows.json fails fast rather than at run time.
 */
export function assertDagWellFormed(dag: TicketDag, label = "ticketDag"): true {
  if (!dag || typeof dag !== "object") throw new Error(`${label}: not an object`);
  const nodes = dag.nodes || {};
  const declared = new Set(Object.keys(nodes));
  if (declared.size === 0) throw new Error(`${label}: no nodes declared`);
  const edges = Array.isArray(dag.edges) ? dag.edges : [];
  for (const e of edges) {
    if (!declared.has(e.from)) throw new Error(`${label}: edge references undeclared node "${e.from}"`);
    if (!declared.has(e.to)) throw new Error(`${label}: edge references undeclared node "${e.to}"`);
    if (e.fallbackFrom != null && !declared.has(e.fallbackFrom)) {
      throw new Error(`${label}: edge fallbackFrom references undeclared node "${e.fallbackFrom}"`);
    }
  }
  for (const e of dag.forbiddenEdges || []) {
    if (!declared.has(e.from) || !declared.has(e.to)) {
      throw new Error(`${label}: forbiddenEdge references undeclared node "${e.from}→${e.to}"`);
    }
  }
  const adj: Record<string, string[]> = {};
  const indeg: Record<string, number> = {};
  for (const n of declared) {
    adj[n] = [];
    indeg[n] = 0;
  }
  for (const e of edges) {
    adj[e.from].push(e.to);
    indeg[e.to] += 1;
  }
  const q = [...declared].filter((n) => indeg[n] === 0);
  let seen = 0;
  while (q.length) {
    const n = q.shift() as string;
    seen += 1;
    for (const m of adj[n]) if (--indeg[m] === 0) q.push(m);
  }
  if (seen !== declared.size) throw new Error(`${label}: edge set is cyclic`);
  return true;
}
