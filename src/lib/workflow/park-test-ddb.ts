/**
 * Test-only (TEAM-5323): a stateful stand-in for `@aws-sdk/lib-dynamodb` that the
 * park tests mock in, so the retry/nudge routes and the orchestrator's real
 * workflow-store.mjs move the SAME in-memory workflow row.
 *
 * Only the exact update expressions those callers send are modelled. Anything
 * else throws `unmodelled`, so a changed expression fails the test that relies on
 * it instead of silently passing through a permissive mock. Nothing imports this
 * outside *.test.ts files.
 */

type Row = Record<string, any>;
type Input = Record<string, any>;

export const fake = {
  workflows: {} as Record<string, Row>,
  tickets: {} as Record<string, Row>,
  events: [] as Row[],
  /** Every UpdateCommand input, in order. */
  updates: [] as Input[],
  /** Items the events-table Query (lease activity) returns. */
  activity: [] as Row[],
  reset() {
    this.workflows = {};
    this.tickets = {};
    this.events = [];
    this.updates = [];
    this.activity = [];
  },
};

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function conditionFailed(): never {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  throw err;
}

const isWorkflows = (t: string) => /workflows/.test(t);

function updateWorkflow(input: Input): Row {
  const row = fake.workflows[input.Key.workflowId] ?? (fake.workflows[input.Key.workflowId] = { workflowId: input.Key.workflowId });
  const n = input.ExpressionAttributeNames || {};
  const v = input.ExpressionAttributeValues || {};
  const cond = String(input.ConditionExpression || "");
  const t = n["#t"];
  const tid = n["#tid"];
  switch (input.UpdateExpression) {
    case "SET agentTasks = if_not_exists(agentTasks, :empty)":
      row.agentTasks ??= {};
      return {};
    case "SET parkedTickets = if_not_exists(parkedTickets, :empty), redispatchCounts = if_not_exists(redispatchCounts, :empty)":
      row.parkedTickets ??= {};
      row.redispatchCounts ??= {};
      return {};
    case "SET parkedTickets.#t = :p": {
      // parkTicket, pinned to the generation it judged (TEAM-5336 F3).
      const m = /^attribute_not_exists\(parkedTickets\.#t\) AND (agentTasks\.#t\.startedAt = :seen|attribute_not_exists\(agentTasks\.#t\.startedAt\))( AND agentTasks\.#t\.#st IN \(:running, :inprog\))?$/.exec(cond);
      if (!m) break;
      if (t in row.parkedTickets) conditionFailed();
      const task = row.agentTasks?.[t];
      if (m[1].includes(":seen") ? task?.startedAt !== v[":seen"] : task?.startedAt !== undefined) conditionFailed();
      if (m[2] && ![v[":running"], v[":inprog"]].includes(task?.[n["#st"]])) conditionFailed();
      row.parkedTickets[t] = clone(v[":p"]);
      return {};
    }
    case "SET redispatchCounts.#t = if_not_exists(redispatchCounts.#t, :legacy) + :one": {
      // incrementRedispatch, seeded from the legacy deadSessionRetries (TEAM-5336 F8).
      const m = /^attribute_not_exists\(parkedTickets\.#t\) AND \(\(attribute_not_exists\(redispatchCounts\.#t\) AND (deadSessionRetries\.#t = :legacy|attribute_not_exists\(deadSessionRetries\.#t\))\) OR redispatchCounts\.#t < :cap\)$/.exec(cond);
      if (!m) break;
      if (t in row.parkedTickets) conditionFailed();
      const legacy = row.deadSessionRetries?.[t];
      const pinned = m[1].includes(":legacy") ? legacy === v[":legacy"] : legacy === undefined;
      if (t in row.redispatchCounts ? !(row.redispatchCounts[t] < v[":cap"]) : !pinned) conditionFailed();
      row.redispatchCounts[t] = (row.redispatchCounts[t] ?? v[":legacy"]) + v[":one"];
      return { Attributes: { redispatchCounts: { [t]: row.redispatchCounts[t] } } };
    }
    case "REMOVE parkedTickets.#t, redispatchCounts.#t":
      if (cond !== "attribute_exists(parkedTickets) OR attribute_exists(redispatchCounts)") break;
      if (!row.parkedTickets && !row.redispatchCounts) conditionFailed();
      if (row.parkedTickets) delete row.parkedTickets[t];
      if (row.redispatchCounts) delete row.redispatchCounts[t];
      return {};
    case "SET agentTasks.#tid = :task": {
      // claimInvocation. The park clause is what these tests are about, so its
      // literal is required; the rest is evaluated as the store spells it.
      if (!cond.includes("attribute_not_exists(parkedTickets.#tid)")) break;
      const terminal = Object.entries(v).filter(([k]) => /^:tp\d+$/.test(k)).map(([, p]) => p);
      if (row.cancelledAt !== undefined || terminal.includes(row.phase)) conditionFailed();
      if (row.parkedTickets && tid in row.parkedTickets) conditionFailed();
      const cur = row.agentTasks?.[tid];
      if (cur && cur[n["#st"]] === v[":running"] && !(cur.startedAt < v[":staleBefore"])) conditionFailed();
      row.agentTasks[tid] = clone(v[":task"]);
      return {};
    }
    case "SET agentTasks.#tid.#st = :ready": {
      // lease.ts stealClaim
      const cur = row.agentTasks?.[tid];
      if (!cur || ![v[":running"], v[":inprog"]].includes(cur.status)) conditionFailed();
      if (v[":exp"] !== undefined ? cur.startedAt !== v[":exp"] : cur.startedAt !== undefined) conditionFailed();
      cur.status = v[":ready"];
      return {};
    }
    case "SET #at.#tid.#s = :ready":
    case "SET #at.#tid.#s = :s": {
      // retry's no-lease reset / nudge's releaseInvocationClaim
      const cur = row.agentTasks?.[tid];
      if (!cur) conditionFailed();
      if (cond.includes(":prev") && cur.status !== v[":prev"]) conditionFailed();
      cur.status = v[":ready"] ?? v[":s"];
      return {};
    }
  }
  throw new Error(`unmodelled workflows update: ${input.UpdateExpression} / ${cond}`);
}

function updateTicket(input: Input): Row {
  const row = fake.tickets[input.Key.ticketId];
  if (!row) throw new Error(`no ticket ${input.Key.ticketId}`);
  const n = input.ExpressionAttributeNames || {};
  const v = input.ExpressionAttributeValues || {};
  switch (input.UpdateExpression) {
    case "SET #s = :s, #u = :u":
      row[n["#s"]] = v[":s"];
      row[n["#u"]] = v[":u"];
      return {};
    case "SET #s = :s, #bb = :bb, #u = :u":
      row[n["#s"]] = v[":s"];
      row[n["#bb"]] = v[":bb"];
      row[n["#u"]] = v[":u"];
      return {};
  }
  throw new Error(`unmodelled tickets update: ${input.UpdateExpression}`);
}

async function send(cmd: { constructor: { name: string }; input: Input }) {
  const { input } = cmd;
  switch (cmd.constructor.name) {
    case "GetCommand":
      return { Item: clone(isWorkflows(input.TableName) ? fake.workflows[input.Key.workflowId] : fake.tickets[input.Key.ticketId]) };
    case "PutCommand":
      fake.events.push(clone(input.Item));
      return {};
    case "QueryCommand":
      return { Items: clone(fake.activity) };
    case "ScanCommand":
      return { Items: clone(Object.values(fake.tickets).filter((r) => r.workflowId === input.ExpressionAttributeValues?.[":wid"])) };
    case "UpdateCommand":
      fake.updates.push(clone(input));
      return isWorkflows(input.TableName) ? updateWorkflow(input) : updateTicket(input);
  }
  throw new Error(`unmodelled command ${cmd.constructor.name}`);
}

/** The module `vi.mock("@aws-sdk/lib-dynamodb", ...)` returns. */
export function mockLibDynamodb() {
  class Command {
    constructor(public input: Input) {}
  }
  class GetCommand extends Command {}
  class PutCommand extends Command {}
  class UpdateCommand extends Command {}
  class QueryCommand extends Command {}
  class ScanCommand extends Command {}
  const client = { send };
  return {
    GetCommand,
    PutCommand,
    UpdateCommand,
    QueryCommand,
    ScanCommand,
    DynamoDBDocumentClient: { from: () => client },
    client,
  };
}
