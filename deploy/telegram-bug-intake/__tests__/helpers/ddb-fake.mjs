/**
 * The `update` half of the DynamoDB fakes in this directory (TEAM-4663).
 *
 * index.mjs now issues UpdateItemCommand against its claim rows — the two-phase
 * claim: `claimedAt` at claim time, `deliveredAt`/`lastPingAt`/`pingCount`/
 * `messageIds` once a ping is confirmed, and a conditional lease re-take when it
 * never was. Every suite that drives the handler therefore needs the op, and a
 * fake that gets it subtly wrong is worse than one that throws: an update that
 * REPLACED the item instead of merging would silently drop `pagedAt` and hide a
 * TEAM-4461 repage regression, and one that ignored ConditionExpression would
 * make a double-page look impossible when it isn't.
 *
 * So the evaluator lives here once, and supports exactly what index.mjs sends:
 *   UpdateExpression:   SET a = :x, b = if_not_exists(b, :y)
 *   ConditionExpression: attribute_exists(a) / attribute_not_exists(a) / a = :v,
 *                        joined by AND, with parenthesised OR groups.
 * Anything else throws loudly, so a new expression shape cannot quietly pass
 * untested.
 */

/** Split on a separator only at paren depth 0, so OR groups stay intact. */
function splitTop(expr, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && expr.startsWith(sep, i)) {
      parts.push(expr.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** DynamoDB compares typed attribute values; only the types we send are allowed. */
function attrEq(item, name, av) {
  const cur = item?.[name];
  if (cur === undefined || av === undefined) return false;
  if (av.N != null) return String(cur.N) === String(av.N);
  if (av.S != null) return cur.S === av.S;
  throw new Error(`ddb fake: unsupported condition value ${JSON.stringify(av)}`);
}

function clauseHolds(item, clause, vals) {
  let c = clause.trim();
  while (/^\(.*\)$/s.test(c)) c = c.slice(1, -1).trim();
  const ors = splitTop(c, " OR ");
  if (ors.length > 1) return ors.some((o) => clauseHolds(item, o, vals));
  const ands = splitTop(c, " AND ");
  if (ands.length > 1) return ands.every((a) => clauseHolds(item, a, vals));

  let m = /^attribute_exists\(\s*([\w.]+)\s*\)$/.exec(c);
  if (m) return item?.[m[1]] !== undefined;
  m = /^attribute_not_exists\(\s*([\w.]+)\s*\)$/.exec(c);
  if (m) return item?.[m[1]] === undefined;
  m = /^([\w.]+)\s*=\s*(:\w+)$/.exec(c);
  if (m) return attrEq(item, m[1], vals?.[m[2]]);
  throw new Error(`ddb fake: unsupported condition clause "${c}"`);
}

function applySet(item, expr, vals) {
  const body = /^\s*SET\s+(.*)$/is.exec(expr || "");
  if (!body) throw new Error(`ddb fake: unsupported UpdateExpression "${expr}"`);
  const next = { ...item };
  for (const assign of splitTop(body[1], ",")) {
    const m = /^([\w.]+)\s*=\s*(.+)$/s.exec(assign);
    if (!m) throw new Error(`ddb fake: unsupported assignment "${assign}"`);
    const [, name, rhs] = m;
    const inf = /^if_not_exists\(\s*([\w.]+)\s*,\s*(:\w+)\s*\)$/.exec(rhs.trim());
    const value = inf
      ? (next[inf[1]] !== undefined ? next[inf[1]] : vals?.[inf[2]])
      : (/^:\w+$/.test(rhs.trim()) ? vals?.[rhs.trim()] : undefined);
    if (value === undefined) throw new Error(`ddb fake: unsupported SET value "${rhs.trim()}"`);
    next[name] = value;
  }
  return next;
}

/**
 * Apply one UpdateItemCommand input to `db.items`, MERGING attributes (as the
 * service does) and honouring ConditionExpression. Records the call on
 * `db.updates` for assertions. Throws ConditionalCheckFailedException by the
 * real name, which is what index.mjs branches on.
 */
export function applyUpdate(db, input) {
  const id = input.Key.id.S;
  const existing = db.items.get(id);
  if (input.ConditionExpression &&
      !clauseHolds(existing, input.ConditionExpression, input.ExpressionAttributeValues)) {
    const err = new Error("The conditional request failed");
    err.name = "ConditionalCheckFailedException";
    throw err;
  }
  // UpdateItem upserts in the real service; keep that, so a test that updates a
  // row nobody claimed behaves like production rather than silently no-op'ing.
  const merged = applySet(existing || { id: { S: id } }, input.UpdateExpression, input.ExpressionAttributeValues);
  db.items.set(id, merged);
  if (!db.updates) db.updates = [];
  db.updates.push({ id, input, item: merged });
  return {};
}
