/**
 * An in-memory stand-in for the @aws-sdk/* modules the tickets twin imports, so a
 * probe can drive the REAL handler with no AWS account (see p4-scope.mjs). State
 * lives on `globalThis.__probeAws`. DynamoDB expressions are evaluated, not
 * pattern-matched; anything this evaluator does not understand THROWS, so a probe
 * can never pass on an expression it silently skipped.
 */

const state = (globalThis.__probeAws ||= { items: {}, s3: {}, invoke: null, log: [] });

// ── DynamoDB expressions ─────────────────────────────────────────────────────
function tokenize(src) {
  const re = /\s*(<>|<=|>=|[=<>(),.+]|#[A-Za-z0-9_]+|:[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)/y;
  const out = [];
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length && (m = re.exec(src))) out.push(m[1]);
  if (re.lastIndex < src.trimEnd().length) throw new Error(`probe ddb: cannot tokenize ${JSON.stringify(src.slice(re.lastIndex))}`);
  return out;
}

function parser(tokens, names, values) {
  let i = 0;
  const peek = () => tokens[i];
  const take = (t) => {
    if (t !== undefined && tokens[i] !== t) throw new Error(`probe ddb: expected ${t} at ${tokens.slice(i).join(" ")}`);
    return tokens[i++];
  };
  const name = (t) => {
    if (t.startsWith("#")) {
      if (!(t in names)) throw new Error(`probe ddb: unbound name ${t}`);
      return names[t];
    }
    return t;
  };
  function path() {
    const parts = [name(take())];
    while (peek() === ".") { take("."); parts.push(name(take())); }
    return parts;
  }
  function operand() {
    const t = peek();
    if (t?.startsWith(":")) {
      take();
      if (!(t in values)) throw new Error(`probe ddb: unbound value ${t}`);
      return { kind: "val", v: values[t] };
    }
    if (/^(if_not_exists|list_append|size)$/.test(t || "")) {
      const fn = take();
      take("(");
      const args = [operand()];
      while (peek() === ",") { take(","); args.push(operand()); }
      take(")");
      return { kind: "fn", fn, args };
    }
    return { kind: "path", p: path() };
  }
  return { peek, take, path, operand, done: () => i >= tokens.length };
}

const get = (item, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), item);
function set(item, p, v) {
  let o = item;
  for (const k of p.slice(0, -1)) o = o[k] ??= {};
  o[p.at(-1)] = v;
}
function del(item, p) {
  const o = get(item, p.slice(0, -1));
  if (o) delete o[p.at(-1)];
}

function evalOperand(op, item) {
  if (op.kind === "val") return op.v;
  if (op.kind === "path") return get(item, op.p);
  if (op.fn === "if_not_exists") {
    const cur = evalOperand(op.args[0], item);
    return cur === undefined ? evalOperand(op.args[1], item) : cur;
  }
  if (op.fn === "list_append") return [...(evalOperand(op.args[0], item) || []), ...(evalOperand(op.args[1], item) || [])];
  if (op.fn === "size") {
    const v = evalOperand(op.args[0], item);
    return v instanceof Set ? v.size : v?.length ?? 0;
  }
  throw new Error(`probe ddb: unsupported function ${op.fn}`);
}

const eq = (a, b) => JSON.stringify(a instanceof Set ? [...a].sort() : a) === JSON.stringify(b instanceof Set ? [...b].sort() : b);

function evalCondition(expr, names, values, item) {
  const P = parser(tokenize(expr), names, values);
  function primary() {
    const t = P.peek();
    if (t === "(") { P.take("("); const v = or(); P.take(")"); return v; }
    if (t === "NOT") { P.take(); return !primary(); }
    if (/^(attribute_exists|attribute_not_exists|contains|begins_with)$/.test(t)) {
      const fn = P.take();
      P.take("(");
      const p = P.operand();
      let arg;
      if (P.peek() === ",") { P.take(","); arg = evalOperand(P.operand(), item); }
      P.take(")");
      const v = evalOperand(p, item);
      if (fn === "attribute_exists") return v !== undefined;
      if (fn === "attribute_not_exists") return v === undefined;
      if (fn === "begins_with") return typeof v === "string" && v.startsWith(arg);
      if (v instanceof Set) return v.has(arg);
      if (Array.isArray(v)) return v.some((x) => eq(x, arg));
      return typeof v === "string" && v.includes(arg);
    }
    const a = evalOperand(P.operand(), item);
    const op = P.take();
    const b = evalOperand(P.operand(), item);
    if (op === "=") return eq(a, b);
    if (op === "<>") return !eq(a, b);
    if (op === "<") return a < b;
    if (op === ">") return a > b;
    if (op === "<=") return a <= b;
    if (op === ">=") return a >= b;
    throw new Error(`probe ddb: unsupported comparator ${op}`);
  }
  function and() { let v = primary(); while (P.peek() === "AND") { P.take(); const r = primary(); v = v && r; } return v; }
  function or() { let v = and(); while (P.peek() === "OR") { P.take(); const r = and(); v = v || r; } return v; }
  const v = or();
  if (!P.done()) throw new Error(`probe ddb: trailing condition tokens in ${expr}`);
  return v;
}

function applyUpdate(expr, names, values, item) {
  const sections = expr.split(/\b(SET|REMOVE|ADD|DELETE)\b/).map((s) => s.trim()).filter(Boolean);
  for (let k = 0; k < sections.length; k += 2) {
    const verb = sections[k];
    const P = parser(tokenize(sections[k + 1]), names, values);
    do {
      if (P.peek() === ",") P.take(",");
      const p = P.path();
      if (verb === "SET") {
        P.take("=");
        let v = evalOperand(P.operand(), item);
        if (P.peek() === "+") { P.take("+"); v = v + evalOperand(P.operand(), item); }
        set(item, p, v);
      } else if (verb === "REMOVE") {
        del(item, p);
      } else if (verb === "ADD") {
        const v = evalOperand(P.operand(), item);
        const cur = get(item, p);
        if (v instanceof Set) set(item, p, new Set([...(cur || []), ...v]));
        else set(item, p, (cur || 0) + v);
      } else {
        throw new Error(`probe ddb: unsupported update verb ${verb}`);
      }
    } while (P.peek() === ",");
    if (!P.done()) throw new Error(`probe ddb: trailing update tokens in ${sections[k + 1]}`);
  }
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
function ccf() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

class Command {
  constructor(input) { this.input = input; }
}
export class GetCommand extends Command {}
export class PutCommand extends Command {}
export class UpdateCommand extends Command {}
export class QueryCommand extends Command {}
export class ScanCommand extends Command {}
export class DynamoDBClient { constructor() {} }

async function ddbSend(cmd) {
  const { input } = cmd;
  const kind = cmd.constructor.name;
  state.log.push({ service: "ddb", kind, input: clone(input) });
  const names = input.ExpressionAttributeNames || {};
  const values = input.ExpressionAttributeValues || {};
  if (kind === "GetCommand") return { Item: clone(state.items[input.Key.ticketId]) };
  if (kind === "PutCommand") {
    // Journey events and other tables: recorded, not stored as tickets.
    if (input.Item?.ticketId && !input.Item?.eventId) {
      const cur = state.items[input.Item.ticketId];
      if (input.ConditionExpression && !evalCondition(input.ConditionExpression, names, values, cur || {})) throw ccf();
      state.items[input.Item.ticketId] = clone(input.Item);
    }
    return {};
  }
  if (kind === "UpdateCommand") {
    const id = input.Key.ticketId;
    if (id === undefined) return { Attributes: { nextNum: 1 } }; // a counter row
    const cur = state.items[id] || { ticketId: id };
    if (input.ConditionExpression && !evalCondition(input.ConditionExpression, names, values, cur)) throw ccf();
    const next = clone(cur);
    applyUpdate(input.UpdateExpression, names, values, next);
    state.items[id] = next;
    return { Attributes: clone(next) };
  }
  if (kind === "ScanCommand" || kind === "QueryCommand") {
    const all = Object.values(state.items);
    const hits = input.FilterExpression ? all.filter((it) => evalCondition(input.FilterExpression, names, values, it)) : all;
    return { Items: clone(hits) };
  }
  throw new Error(`probe ddb: unsupported command ${kind}`);
}

export const DynamoDBDocumentClient = { from: () => ({ send: ddbSend }) };

// ── S3 ───────────────────────────────────────────────────────────────────────
export class GetObjectCommand extends Command {}
export class PutObjectCommand extends Command {}
export class S3Client {
  async send(cmd) {
    const { input } = cmd;
    const key = `${input.Bucket}/${input.Key}`;
    state.log.push({ service: "s3", kind: cmd.constructor.name, key });
    if (cmd instanceof PutObjectCommand) {
      if (input.IfNoneMatch === "*" && key in state.s3) {
        const err = new Error("PreconditionFailed");
        err.name = "PreconditionFailed";
        err.$metadata = { httpStatusCode: 412 };
        throw err;
      }
      state.s3[key] = String(input.Body);
      return { ETag: `"${Object.keys(state.s3).length}"` };
    }
    if (!(key in state.s3)) {
      const err = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    const body = state.s3[key];
    return { Body: { transformToString: async () => body }, ETag: '"1"' };
  }
}

// ── Lambda (the post-condition probe) and Secrets Manager ───────────────────
export class InvokeCommand extends Command {}
export class LambdaClient {
  async send(cmd) {
    const args = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
    state.log.push({ service: "lambda", tool: args.tool_name });
    const result = state.invoke ? state.invoke(args) : { ok: false };
    return { Payload: Buffer.from(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] })) };
  }
}
export class GetSecretValueCommand extends Command {}
export class SecretsManagerClient {
  async send() {
    const err = new Error("probe: no secrets - set GATE_DECISION_KEY");
    err.name = "ResourceNotFoundException";
    throw err;
  }
}
