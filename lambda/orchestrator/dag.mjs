/**
 * TEAM-3992 D3.4 — ticket-plan DAG validator (orchestrator/workflow-output side).
 *
 * PARITY TWIN of src/lib/workflow/dag.ts — byte-for-byte the same logic, kept in
 * lock-step the way lease.mjs↔lease.ts and repo-check.mjs↔repo-check.ts are, and
 * pinned by src/lib/workflow/dag-parity.test.ts (identical fixtures → deep-equal
 * outputs). Change one, change the other, extend the parity test.
 *
 * A workflow def may declare a `ticketDag`: the STRUCTURAL contract a run's ticket
 * plan must satisfy (which agent phases exist, how many, and which must block
 * which). This module answers "does this plan/graph obey the def's DAG?" — it is
 * PURE (no AWS, no fetch): callers pass the plan, the dag, and the agent roster.
 *
 * Validation is STRUCTURAL, not edge-set equality. A plan is free to chain
 * same-node tickets serially (two dev tickets for one surface), insert fix/rearm/
 * escalation tickets, and order independent phases however it likes; what it may
 * NOT do is drop a required dependency, introduce a forbidden one, or produce the
 * wrong cardinality for a node.
 *
 * Ticket shape (tolerant — a plan ticket and a realized ticket differ):
 *   id       — id ?? key ?? ticket_id ?? ref ?? title   (the plan-local handle
 *              other tickets reference in blocked_by)
 *   assignee — agent id ("agentcore_hub_*") or "human:*"
 *   title    — title ?? summary
 *   role     — optional explicit node key (highest-priority mapping signal)
 *   blocked_by / blockedBy — array | comma-string | single; "none"/"" dropped
 *   spawned_by.kind / rearmOf — extra-node signals
 *
 * Node mapping order (first match wins):
 *   1. explicit `role` naming a declared node
 *   2. a node whose `agentIds` lists the assignee (Ship vs CD share one agent —
 *      broken by `titlePrefix`)
 *   3. a node whose `agentPhases` includes the assignee's roster phase
 *   4. a node whose `titlePrefix` the title starts with
 *   5. a `gate` node when the assignee is human:* and the title contains the gate
 *   Tickets matching `allowedExtraNodes` are EXEMPT (fix/rearm/escalation), not
 *   unmapped.
 *
 * Required-edge rule: for edge from→to, every `to`-node ticket must reach a
 * `from`-node ticket through its blockers, where transitive hops are allowed ONLY
 * through other tickets of the SAME node as `to` (a serial same-agent chain). When
 * NO `from`-node ticket exists at all and the edge declares `fallbackFrom`, a
 * `fallbackFrom`-node ticket satisfies it (a plan that legitimately skipped an
 * optional phase, e.g. design). Forbidden-edge detection uses the FULL transitive
 * blocker closure (a forbidden dependency anywhere in the chain is a violation).
 *
 * Violation codes: missing_required_edge, forbidden_edge, node_cardinality,
 * unmapped_ticket, unknown_blocker_key, cycle.
 */

function ticketId(t) {
  return String(t?.id ?? t?.key ?? t?.ticket_id ?? t?.ref ?? t?.title ?? "");
}

function titleOf(t) {
  return String(t?.title ?? t?.summary ?? "");
}

function blockersOf(t) {
  const raw = t?.blocked_by ?? t?.blockedBy ?? [];
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [raw];
  return arr
    .map((x) => String(x).trim())
    .filter((x) => x && x.toLowerCase() !== "none");
}

/** Normalize any accepted roster shape to an { agentId → phase } map. */
export function phaseByAgentOf(roster) {
  const m = {};
  if (Array.isArray(roster)) {
    for (const r of roster) if (r?.agentId) m[r.agentId] = r.phase || "";
  } else if (roster && typeof roster === "object") {
    if (Array.isArray(roster.agents)) {
      for (const r of roster.agents) if (r?.agentId) m[r.agentId] = r.phase || "";
    } else {
      for (const [k, v] of Object.entries(roster)) m[k] = v && typeof v === "object" ? v.phase || "" : v;
    }
  }
  return m;
}

function extraNodeMatch(t, dag) {
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

function nodeForTicket(t, dag, phaseByAgent) {
  const nodes = dag?.nodes || {};
  const keys = Object.keys(nodes);
  const assignee = String(t?.assignee ?? "");
  const title = titleOf(t);
  const role = t?.role ? String(t.role) : "";

  // 1. explicit role
  if (role && nodes[role]) return role;

  // 2. agentIds (Ship/CD share release_manager — split by titlePrefix)
  const byAgent = keys.filter((k) => (nodes[k].agentIds || []).includes(assignee));
  if (byAgent.length === 1) return byAgent[0];
  if (byAgent.length > 1) {
    const byPrefix = byAgent.find((k) => nodes[k].titlePrefix && title.startsWith(nodes[k].titlePrefix));
    return byPrefix || byAgent[0];
  }

  // 3. agentPhases via roster phase
  const phase = phaseByAgent[assignee] || "";
  if (phase) {
    const byPhase = keys.filter((k) => (nodes[k].agentPhases || []).includes(phase));
    if (byPhase.length === 1) return byPhase[0];
    if (byPhase.length > 1) {
      const byPrefix = byPhase.find((k) => nodes[k].titlePrefix && title.startsWith(nodes[k].titlePrefix));
      return byPrefix || byPhase[0];
    }
  }

  // 4. titlePrefix only
  const byPrefixOnly = keys.find((k) => nodes[k].titlePrefix && title.startsWith(nodes[k].titlePrefix));
  if (byPrefixOnly) return byPrefixOnly;

  // 5. gate for human assignees
  if (assignee.startsWith("human:")) {
    const byGate = keys.find((k) => nodes[k].gate && title.includes(nodes[k].gate));
    if (byGate) return byGate;
  }
  return null;
}

/** Map every plan ticket to its DAG node (or extra/unmapped bucket). */
export function mapPlanToNodes(plan, dag, roster) {
  const tickets = Array.isArray(plan?.tickets) ? plan.tickets : Array.isArray(plan) ? plan : [];
  const phaseByAgent = phaseByAgentOf(roster);
  const nodeOf = {};
  const byNode = {};
  const extras = [];
  const unmapped = [];
  const ids = [];
  const byId = {};
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

function detectCycles(ids, blockersById) {
  const idSet = new Set(ids);
  const color = {}; // 0 unvisited, 1 in-stack, 2 done
  const cycles = [];
  const seenCycle = new Set();
  const stackArr = [];
  function visit(id) {
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

function _validate(tickets, dag, roster) {
  const mapping = mapPlanToNodes({ tickets }, dag, roster);
  const idSet = new Set(mapping.ids);
  const blockersById = {};
  for (const t of tickets) blockersById[ticketId(t)] = blockersOf(t);
  const nodeOf = mapping.nodeOf;
  const nodes = dag?.nodes || {};
  const violations = [];

  // unmapped tickets
  for (const id of mapping.unmapped) {
    violations.push({ code: "unmapped_ticket", ticket: id, assignee: String(mapping.byId[id]?.assignee ?? "") });
  }

  // unknown blocker keys
  for (const id of mapping.ids) {
    for (const b of blockersById[id] || []) {
      if (!idSet.has(b)) violations.push({ code: "unknown_blocker_key", ticket: id, key: b });
    }
  }

  // cycles
  for (const cyc of detectCycles(mapping.ids, blockersById)) {
    violations.push({ code: "cycle", cycle: cyc });
  }

  // node cardinality
  for (const [node, cfg] of Object.entries(nodes)) {
    const count = (mapping.byNode[node] || []).length;
    const min = cfg.min ?? 0;
    const max = cfg.max ?? null;
    if (count < min || (max != null && count > max)) {
      violations.push({ code: "node_cardinality", node, count, min, max });
    }
  }

  // full transitive blocker closure (cycle-safe)
  function closure(startId) {
    const seen = new Set();
    const stack = [...(blockersById[startId] || [])];
    while (stack.length) {
      const x = stack.pop();
      if (!idSet.has(x) || seen.has(x)) continue;
      seen.add(x);
      for (const y of blockersById[x] || []) stack.push(y);
    }
    return seen;
  }

  // same-node-restricted reach: every blocker id encountered while hopping ONLY
  // through tickets of `throughNode` (serial same-agent chaining).
  function reachThroughNode(startId, throughNode) {
    const encountered = new Set();
    const walked = new Set();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
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

  // required edges
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

  // forbidden edges
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

/** Validate a submitted ticket PLAN. Returns { ok, violations }. */
export function validateTicketPlan(plan, dag, roster) {
  const tickets = Array.isArray(plan?.tickets) ? plan.tickets : Array.isArray(plan) ? plan : [];
  const violations = _validate(tickets, dag, roster);
  return { ok: violations.length === 0, violations };
}

/** Validate the REALIZED graph of created child tickets. Returns violations[]. */
export function validateRealizedGraph(children, dag, roster) {
  const tickets = Array.isArray(children) ? children : Array.isArray(children?.tickets) ? children.tickets : [];
  return _validate(tickets, dag, roster);
}

/**
 * Structural sanity of a ticketDag definition itself. Throws a specific Error
 * when an edge (or fallbackFrom / forbiddenEdge) references an undeclared node,
 * or when the edge set contains a cycle. Called by the def loader so a bad
 * hand-edit of workflows.json fails fast rather than at run time.
 */
export function assertDagWellFormed(dag, label = "ticketDag") {
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
  // Acyclicity over the edge set (Kahn).
  const adj = {};
  const indeg = {};
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
    const n = q.shift();
    seen += 1;
    for (const m of adj[n]) if (--indeg[m] === 0) q.push(m);
  }
  if (seen !== declared.size) throw new Error(`${label}: edge set is cyclic`);
  return true;
}
