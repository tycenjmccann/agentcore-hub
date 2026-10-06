#!/usr/bin/env node
/**
 * hub-table-guards.mjs - the one definition of "an agent-reachable role must not
 * write the tickets or workflows tables" (TEAM-5346, review r2 of TEAM-5325).
 *
 * The Tickets Lambda is the guarded twin: every ticket write goes through its
 * conditional expressions (single-use decision jtis in `decisionJtisUsed`, the
 * signed `gateVerify` record, human-identity checks on park clears) and every
 * workflow-row write through lambda/orchestrator/workflow-store.mjs
 * (`parkedTickets`, `redispatchCounts`, legacy `deadSessionRetries`). The fleet
 * runtime role held PutItem/UpdateItem/DeleteItem on `table/agentcore-hub-*` and
 * the shared harness role held PutItem/UpdateItem on both tables outright, and
 * both principals run prompt-driven code with a shell - so an agent could
 * rewrite a ticket's status, delete its park entry, or forget a spent jti with
 * one boto3 call. IAM is the only boundary there.
 *
 * Same shape as TEAM-5323's DenyCompletionRecordWrites (S3): keep the Allow the
 * code needs, then an explicit Deny per protected resource in the SAME policy
 * document, because a Deny outranks every Allow in every attached policy -
 * including BedrockAgentCoreFullAccess on the fleet role and whatever the other
 * two setup scripts on the shared harness role grant.
 *
 * Consumers:
 *   deploy/setup-runtime-role.sh          `node deploy/lib/hub-table-guards.mjs runtime-policy ...`
 *   deploy/workflow-manager/setup-workflow-manager.mjs   import { denyGuardedTableWrites }
 *   deploy/lib/__tests__/hub-table-guards.test.ts         the policy-as-data pin
 *
 * The Deny statements are deliberately UNCONDITIONAL. The Workflow Manager keeps
 * exactly one write to the workflows table - intervene.py's escalation
 * `SET humanNotifications = list_append(...)` - and that write is permitted by an
 * attribute-scoped Allow (ForAllValues:StringEquals dynamodb:Attributes
 * [workflowId, humanNotifications], the shape lambda/anomaly-watcher/deploy.sh
 * runs in production), with UpdateItem simply left OUT of that role's workflows
 * Deny (`updateItemCarveOut`). A conditional Deny (ForAnyValue:StringNotEquals on
 * dynamodb:Attributes) would carry the same meaning but its semantics cannot be
 * proven by an offline test, so the carve-out is on the action list instead.
 * Every other write action on that table, and every write action on the tickets
 * table, is denied for both principals.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Default table names, env-overridable like setup-workflow-manager.mjs's TABLES. */
export const GUARDED_TABLES = Object.freeze({
  tickets: process.env.TICKETS_TABLE || "agentcore-hub-tickets",
  workflows: process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows",
});

/** Every DynamoDB action that can create, change or remove an item. */
export const ITEM_WRITE_ACTIONS = Object.freeze([
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
  "dynamodb:DeleteItem",
  "dynamodb:BatchWriteItem",
  "dynamodb:TransactWriteItems",
  "dynamodb:PartiQLInsert",
  "dynamodb:PartiQLUpdate",
  "dynamodb:PartiQLDelete",
]);

export const tableArn = (region, accountId, table) => `arn:aws:dynamodb:${region}:${accountId}:table/${table}`;

const sidFor = (table) => `Deny${table.replace(/^agentcore-hub-/, "").replace(/(^|[-_])([a-z0-9])/g, (_, __, c) => c.toUpperCase())}TableWrites`;

/**
 * One `Effect: Deny` statement per guarded table.
 * @param {object} o
 * @param {string} o.region
 * @param {string} o.accountId
 * @param {Record<string,string>} [o.tables]  guarded table names (default GUARDED_TABLES)
 * @param {string[]} [o.updateItemCarveOut]   tables whose Deny omits dynamodb:UpdateItem
 *        because an attribute-scoped Allow governs that one action (WM: workflows)
 */
export function denyGuardedTableWrites({ region, accountId, tables = GUARDED_TABLES, updateItemCarveOut = [] }) {
  if (!region || !accountId) throw new Error("denyGuardedTableWrites: region and accountId are required");
  const names = Object.values(tables);
  for (const t of updateItemCarveOut) {
    if (!names.includes(t)) throw new Error(`updateItemCarveOut names ${t}, which is not a guarded table (${names.join(", ")})`);
  }
  return names.map((table) => ({
    Sid: sidFor(table),
    Effect: "Deny",
    Action: updateItemCarveOut.includes(table)
      ? ITEM_WRITE_ACTIONS.filter((a) => a !== "dynamodb:UpdateItem")
      : [...ITEM_WRITE_ACTIONS],
    Resource: tableArn(region, accountId, table),
  }));
}

/**
 * The fleet runtime role's whole DynamoDB document (inline policy name
 * DynamoDBEventsWrite in deploy/setup-runtime-role.sh). What deploy/runtime-agent/
 * main.py actually does: events put_item (agent.* journey events), query +
 * delete_item (the operator mailbox, eventId prefix 0#mailbox#<agent>#), and the
 * coding-session row's put_item / update_item / get_item. Nothing in the fleet
 * reads or writes any other table directly - the Tickets___* / WorkflowOutput___*
 * tools are lambda:InvokeFunction. Reads keep their previous wildcard so this
 * change is about writes only.
 */
export function runtimeDynamoDbPolicy({ region, accountId, eventsTable, sessionsTable, tables = GUARDED_TABLES }) {
  if (!region || !accountId || !eventsTable || !sessionsTable) {
    throw new Error("runtimeDynamoDbPolicy: region, accountId, eventsTable and sessionsTable are required");
  }
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "EventsTableWrite",
        Effect: "Allow",
        Action: ["dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem"],
        Resource: tableArn(region, accountId, eventsTable),
      },
      {
        Sid: "CodingSessionsWrite",
        Effect: "Allow",
        Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"],
        Resource: tableArn(region, accountId, sessionsTable),
      },
      {
        Sid: "HubTablesRead",
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:Query"],
        Resource: tableArn(region, accountId, "agentcore-hub-*"),
      },
      ...denyGuardedTableWrites({ region, accountId, tables }),
    ],
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    out[key] = out[key] === undefined ? argv[++i] : [].concat(out[key], argv[++i]);
  }
  return out;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const die = (msg) => {
    console.error(`hub-table-guards: ${msg}`);
    console.error("usage: runtime-policy --region R --account A --events-table T --sessions-table T\n" +
      "       deny --region R --account A [--carve-out-update-item TABLE]...");
    process.exit(2);
  };
  let f;
  try {
    f = parseFlags(rest);
  } catch (err) {
    return die(err.message);
  }
  try {
    if (cmd === "runtime-policy") {
      console.log(JSON.stringify(runtimeDynamoDbPolicy({
        region: f.region, accountId: f.account, eventsTable: f["events-table"], sessionsTable: f["sessions-table"],
      }), null, 2));
    } else if (cmd === "deny") {
      console.log(JSON.stringify(denyGuardedTableWrites({
        region: f.region, accountId: f.account, updateItemCarveOut: [].concat(f["carve-out-update-item"] || []),
      }), null, 2));
    } else {
      die(`unknown command ${cmd}`);
    }
  } catch (err) {
    console.error(`hub-table-guards: ${err.message}`);
    process.exit(1);
  }
}

// Importing this module must print nothing: the WM's --print-policy stdout is
// JSON.parse'd whole by its tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
