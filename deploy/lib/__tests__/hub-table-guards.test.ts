/**
 * TEAM-5346 (review r2 of TEAM-5325) - the DynamoDB authz floor, as data.
 *
 * Two agent-reachable principals run prompt-driven code with a shell: the fleet
 * runtime role (deploy/setup-runtime-role.sh) and the shared harness role
 * (deploy/workflow-manager/setup-workflow-manager.mjs). Both used to hold
 * PutItem/UpdateItem on the tickets and workflows tables, so an agent could
 * rewrite a ticket's status, forget a spent decision jti (`decisionJtisUsed`) or
 * REMOVE `parkedTickets.<t>` / `redispatchCounts.<t>` without the Tickets Lambda
 * or the orchestrator's workflow-store ever seeing it. This suite drives the one
 * shared definition (deploy/lib/hub-table-guards.mjs) and parses the EXACT
 * documents both scripts send to PutRolePolicy, rendered offline:
 *   - `PRINT_POLICY=<name> bash deploy/setup-runtime-role.sh` (new here, modelled
 *     on setup-coding-runtime-role.sh) and
 *   - `node setup-workflow-manager.mjs --print-policy` (TEAM-4770).
 *
 * HERMETIC: a stub `aws` on PATH exits 64 on ANY call, dummy credentials, a fake
 * account id, AWS_EC2_METADATA_DISABLED. If either script reaches for AWS in
 * print mode the test fails loudly. The technique is
 * scripts/__tests__/si-ledger-handoff.test.mjs's.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GUARDED_TABLES,
  ITEM_WRITE_ACTIONS,
  denyGuardedTableWrites,
  runtimeDynamoDbPolicy,
  tableArn,
} from "../hub-table-guards.mjs";

const REPO = resolve(__dirname, "../../..");
const ACCOUNT = "111122223333";
const REGION = "us-east-1";
const TICKETS = tableArn(REGION, ACCOUNT, "agentcore-hub-tickets");
const WORKFLOWS = tableArn(REGION, ACCOUNT, "agentcore-hub-workflows");
const EVENTS = tableArn(REGION, ACCOUNT, "agentcore-hub-events");
const SESSIONS = tableArn(REGION, ACCOUNT, "agentcore-hub-cloud-code-sessions");

type Statement = {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
};
type Policy = { Version: string; Statement: Statement[] };

const WRITE_ACTIONS = new Set<string>(ITEM_WRITE_ACTIONS);
const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
const writes = (s: Statement) => list(s.Action).filter((a) => WRITE_ACTIONS.has(a) || a === "dynamodb:*");
const allowsWriteOn = (p: Policy, arn: string) =>
  p.Statement.filter((s) => s.Effect === "Allow" && writes(s).length && list(s.Resource).includes(arn));

// The repo's ProcessEnv augmentation requires NODE_ENV; these subprocess envs are
// deliberately scrubbed, so they are built as plain records and cast at the call.
type Env = Record<string, string>;
const asEnv = (e: Env) => e as unknown as NodeJS.ProcessEnv;

function stubEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "hub-table-guards-"));
  mkdirSync(join(dir, "bin"));
  const stub = join(dir, "bin", "aws");
  writeFileSync(stub, '#!/bin/bash\necho "stub aws: unexpected call: $*" >&2\nexit 64\n');
  chmodSync(stub, 0o755);
  return {
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    HOME: dir,
    AWS_ACCOUNT_ID: ACCOUNT,
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
    AWS_ACCESS_KEY_ID: "AKIAHUBTABLEGUARDS00",
    AWS_SECRET_ACCESS_KEY: "not-a-secret",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_ENDPOINT_URL: "http://127.0.0.1:1",
    AWS_MAX_ATTEMPTS: "1",
  };
}

function runtimePolicy(name: string, extra: Record<string, string> = {}): Policy {
  const r = spawnSync("bash", [join(REPO, "deploy/setup-runtime-role.sh")], {
    encoding: "utf8",
    env: asEnv({ ...stubEnv(), PRINT_POLICY: name, ...extra }),
    timeout: 60_000,
  });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stderr).not.toMatch(/stub aws/);
  return JSON.parse(r.stdout) as Policy;
}

function wmPolicy(): Policy {
  const r = spawnSync(process.execPath, [join(REPO, "deploy/workflow-manager/setup-workflow-manager.mjs"), "--print-policy"], {
    cwd: REPO,
    encoding: "utf8",
    env: asEnv({ ...stubEnv(), WORKFLOW_API_URL: "http://127.0.0.1:9" }),
    timeout: 60_000,
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Policy;
}

describe("hub-table-guards.mjs - the shared definition", () => {
  it("guards exactly the tickets and workflows tables, env-overridable", () => {
    expect(Object.keys(GUARDED_TABLES).sort()).toEqual(["tickets", "workflows"]);
    expect(GUARDED_TABLES.tickets).toBe(process.env.TICKETS_TABLE || "agentcore-hub-tickets");
    expect(GUARDED_TABLES.workflows).toBe(process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows");
  });

  it("denies every item-write action, including batch, transact and PartiQL", () => {
    expect([...ITEM_WRITE_ACTIONS].sort()).toEqual([
      "dynamodb:BatchWriteItem",
      "dynamodb:DeleteItem",
      "dynamodb:PartiQLDelete",
      "dynamodb:PartiQLInsert",
      "dynamodb:PartiQLUpdate",
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem",
    ]);
  });

  it("emits one unconditional Deny per guarded table", () => {
    const st = denyGuardedTableWrites({ region: REGION, accountId: ACCOUNT });
    expect(st.map((s) => [s.Sid, s.Effect, s.Resource])).toEqual([
      ["DenyTicketsTableWrites", "Deny", TICKETS],
      ["DenyWorkflowsTableWrites", "Deny", WORKFLOWS],
    ]);
    for (const s of st) {
      expect(s.Action).toEqual([...ITEM_WRITE_ACTIONS]);
      expect(s).not.toHaveProperty("Condition");
    }
  });

  it("the UpdateItem carve-out removes only UpdateItem, only on the named table", () => {
    const st = denyGuardedTableWrites({ region: REGION, accountId: ACCOUNT, updateItemCarveOut: ["agentcore-hub-workflows"] });
    const tickets = st.find((s) => s.Resource === TICKETS)!;
    const workflows = st.find((s) => s.Resource === WORKFLOWS)!;
    expect(tickets.Action).toContain("dynamodb:UpdateItem");
    expect(workflows.Action).not.toContain("dynamodb:UpdateItem");
    expect(workflows.Action).toEqual(ITEM_WRITE_ACTIONS.filter((a) => a !== "dynamodb:UpdateItem"));
    expect(() => denyGuardedTableWrites({ region: REGION, accountId: ACCOUNT, updateItemCarveOut: ["agentcore-hub-events"] })).toThrow(/not a guarded table/);
  });

  it("the fleet document writes only events + coding sessions and denies both guarded tables outright", () => {
    const p = runtimeDynamoDbPolicy({ region: REGION, accountId: ACCOUNT, eventsTable: "agentcore-hub-events", sessionsTable: "agentcore-hub-cloud-code-sessions" });
    const writeAllows = p.Statement.filter((s) => s.Effect === "Allow" && writes(s).length);
    expect(writeAllows.map((s) => s.Resource).sort()).toEqual([SESSIONS, EVENTS].sort());
    const deny = p.Statement.filter((s) => s.Effect === "Deny");
    expect(deny.map((s) => s.Resource).sort()).toEqual([TICKETS, WORKFLOWS].sort());
    for (const s of deny) expect(s.Action).toEqual([...ITEM_WRITE_ACTIONS]);
  });
});

describe("deploy/setup-runtime-role.sh - DynamoDBEventsWrite as PutRolePolicy sends it", () => {
  const policy = runtimePolicy("DynamoDBEventsWrite");

  it("no write Allow has a wildcard table segment (the old table/agentcore-hub-* grant is gone)", () => {
    for (const s of policy.Statement) {
      if (s.Effect !== "Allow" || !writes(s).length) continue;
      for (const r of list(s.Resource)) expect(r.split(":table/")[1]).not.toContain("*");
    }
  });

  it("no Allow grants a write action on the tickets or workflows table", () => {
    expect(allowsWriteOn(policy, TICKETS)).toEqual([]);
    expect(allowsWriteOn(policy, WORKFLOWS)).toEqual([]);
  });

  it("write Allows exist exactly for the events table (Put/Query/Delete) and the coding-session row (Put/Update/Get)", () => {
    const writeAllows = policy.Statement.filter((s) => s.Effect === "Allow" && writes(s).length);
    const byResource = Object.fromEntries(writeAllows.map((s) => [s.Resource as string, [...list(s.Action)].sort()]));
    expect(byResource).toEqual({
      [EVENTS]: ["dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:Query"],
      [SESSIONS]: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
    });
  });

  it("denies every write action on both guarded tables, no carve-out for the fleet", () => {
    const deny = policy.Statement.filter((s) => s.Effect === "Deny");
    expect(deny.map((s) => [s.Sid, s.Resource]).sort()).toEqual([
      ["DenyTicketsTableWrites", TICKETS],
      ["DenyWorkflowsTableWrites", WORKFLOWS],
    ]);
    for (const s of deny) {
      expect([...list(s.Action)].sort()).toEqual([...ITEM_WRITE_ACTIONS].sort());
      expect(s).not.toHaveProperty("Condition");
    }
  });

  it("keeps the read surface (GetItem/Query) so this change is about writes only", () => {
    const read = policy.Statement.find((s) => s.Sid === "HubTablesRead")!;
    expect(read.Effect).toBe("Allow");
    expect([...list(read.Action)].sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    expect(writes(read)).toEqual([]);
  });

  it("honours EVENTS_TABLE / CLOUD_CODE_TABLE / TICKETS_TABLE / WORKFLOWS_TABLE overrides", () => {
    const p = runtimePolicy("DynamoDBEventsWrite", {
      EVENTS_TABLE: "ev-x", CLOUD_CODE_TABLE: "cc-x", TICKETS_TABLE: "tk-x", WORKFLOWS_TABLE: "wf-x",
    });
    const res = p.Statement.map((s) => s.Resource as string);
    expect(res).toContain(tableArn(REGION, ACCOUNT, "ev-x"));
    expect(res).toContain(tableArn(REGION, ACCOUNT, "cc-x"));
    expect(p.Statement.filter((s) => s.Effect === "Deny").map((s) => s.Resource).sort()).toEqual(
      [tableArn(REGION, ACCOUNT, "tk-x"), tableArn(REGION, ACCOUNT, "wf-x")].sort(),
    );
  });
});

describe("deploy/setup-runtime-role.sh - S3ArtifactAccess keeps the completion-record pattern", () => {
  const policy = runtimePolicy("S3ArtifactAccess");
  const bucket = `arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT}-${REGION}`;

  it("DenyCompletionRecordWrites, DenyGateDecisionRecordWrites and DenyRegistryWrite are still there, prefix-exact", () => {
    const by = Object.fromEntries(policy.Statement.map((s) => [s.Sid, s]));
    expect(by.DenyCompletionRecordWrites.Effect).toBe("Deny");
    expect(list(by.DenyCompletionRecordWrites.Resource)).toEqual([`${bucket}/completions/*`]);
    expect([...list(by.DenyCompletionRecordWrites.Action)].sort()).toEqual(["s3:DeleteObject", "s3:PutObject"]);
    expect(by.DenyGateDecisionRecordWrites.Effect).toBe("Deny");
    expect(list(by.DenyGateDecisionRecordWrites.Resource)).toEqual([`${bucket}/pipeline-artifacts/gate-decisions/*`]);
    expect(by.DenyRegistryWrite.Effect).toBe("Deny");
    expect(list(by.DenyRegistryWrite.Resource)).toContain(`${bucket}/config/models.json`);
    expect(by.S3Access.Effect).toBe("Allow");
  });
});

describe("deploy/setup-runtime-role.sh - print mode is offline and cannot leak into the sourced path", () => {
  it("--print-policy flag form works when run directly", () => {
    const r = spawnSync("bash", [join(REPO, "deploy/setup-runtime-role.sh"), "--print-policy", "DynamoDBEventsWrite"], {
      encoding: "utf8", env: asEnv(stubEnv()), timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).Statement.some((s: Statement) => s.Sid === "DenyTicketsTableWrites")).toBe(true);
  });

  it("an unknown PRINT_POLICY exits 2 without calling aws", () => {
    const r = spawnSync("bash", [join(REPO, "deploy/setup-runtime-role.sh")], {
      encoding: "utf8", env: asEnv({ ...stubEnv(), PRINT_POLICY: "Nope" }), timeout: 60_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown PRINT_POLICY/);
    expect(r.stderr).not.toMatch(/stub aws/);
  });

  it("when SOURCED, PRINT_POLICY and AWS_ACCOUNT_ID are both ignored: the script goes to STS", () => {
    // deploy-fleet.sh `source`s this file after `set -a; source .env.local`. A
    // leaked PRINT_POLICY must not short-circuit the role setup (the ARN export at
    // the end would be skipped), and a forged AWS_ACCOUNT_ID must not feed the
    // trust policy - so the first thing the sourced script does is call STS, which
    // the stub refuses (exit 64).
    const r = spawnSync("bash", ["-c", `source "${join(REPO, "deploy/setup-runtime-role.sh")}"; echo "REACHED-END"`], {
      encoding: "utf8", env: asEnv({ ...stubEnv(), PRINT_POLICY: "DynamoDBEventsWrite" }), timeout: 60_000,
    });
    expect(r.stderr).toMatch(/stub aws: unexpected call: sts get-caller-identity/);
    expect(r.stdout).not.toContain("REACHED-END");
    expect(r.stdout).not.toContain("DenyTicketsTableWrites");
  });

  it("AWS_ACCOUNT_ID is read from env ONLY under PRINT_POLICY (source pin)", () => {
    const src = readFileSync(join(REPO, "deploy/setup-runtime-role.sh"), "utf8");
    const assigns = src.split("\n").filter((l) => /^ACCOUNT_ID=/.test(l.trim()));
    expect(assigns.some((l) => l.includes("PRINT_POLICY:+") && l.includes("AWS_ACCOUNT_ID"))).toBe(true);
    expect(assigns.filter((l) => l.includes("AWS_ACCOUNT_ID") && !l.includes("PRINT_POLICY"))).toEqual([]);
  });
});

describe("deploy/workflow-manager/setup-workflow-manager.mjs --print-policy - WorkflowManagerData", () => {
  const policy = wmPolicy();

  it("no Allow grants any write action on the tickets table", () => {
    expect(allowsWriteOn(policy, TICKETS)).toEqual([]);
    expect(allowsWriteOn(policy, `${TICKETS}/index/*`)).toEqual([]);
  });

  it("the only write Allow on the workflows table is the attribute-scoped humanNotifications UpdateItem", () => {
    const allows = allowsWriteOn(policy, WORKFLOWS);
    expect(allows.map((s) => s.Sid)).toEqual(["WorkflowEscalationAppend"]);
    const [s] = allows;
    expect(list(s.Action)).toEqual(["dynamodb:UpdateItem"]);
    expect(s.Resource).toBe(WORKFLOWS);
    expect(s.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:Attributes": ["workflowId", "humanNotifications"] },
      StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
    });
  });

  it("the attribute-scoped Allow is the same shape the anomaly watcher runs in production", () => {
    const src = readFileSync(join(REPO, "lambda/anomaly-watcher/deploy.sh"), "utf8");
    expect(src).toMatch(/"Sid\\?": \\?"WorkflowsNotify\\?"/);
    expect(src).toMatch(/ForAllValues:StringEquals/);
    expect(src).toMatch(/dynamodb:Attributes\\?": \[\\?"workflowId\\?", \\?"humanNotifications\\?"\]/);
    expect(src).toMatch(/dynamodb:ReturnValues\\?": \\?"NONE\\?"/);
  });

  it("AnalysesWrite writes analyses + events only", () => {
    const s = policy.Statement.find((x) => x.Sid === "AnalysesWrite")!;
    expect(list(s.Resource).sort()).toEqual([tableArn(REGION, ACCOUNT, "agentcore-hub-workflow-analyses"), EVENTS].sort());
  });

  it("denies every write on tickets, and every write but UpdateItem on workflows - so the Deny cannot override the escalation Allow", () => {
    const deny = policy.Statement.filter((s) => s.Effect === "Deny" && String(s.Resource).includes(":table/"));
    const tickets = deny.find((s) => s.Resource === TICKETS)!;
    const workflows = deny.find((s) => s.Resource === WORKFLOWS)!;
    expect(tickets.Sid).toBe("DenyTicketsTableWrites");
    expect([...list(tickets.Action)].sort()).toEqual([...ITEM_WRITE_ACTIONS].sort());
    expect(workflows.Sid).toBe("DenyWorkflowsTableWrites");
    expect(list(workflows.Action)).not.toContain("dynamodb:UpdateItem");
    expect([...list(workflows.Action)].sort()).toEqual(ITEM_WRITE_ACTIONS.filter((a) => a !== "dynamodb:UpdateItem").sort());
    expect(tickets).not.toHaveProperty("Condition");
    expect(workflows).not.toHaveProperty("Condition");
  });

  it("no OTHER Allow of UpdateItem on the workflows table exists without the attribute condition", () => {
    for (const s of policy.Statement) {
      if (s.Effect !== "Allow" || !list(s.Resource).includes(WORKFLOWS) || !list(s.Action).includes("dynamodb:UpdateItem")) continue;
      expect(s.Condition?.["ForAllValues:StringEquals"]?.["dynamodb:Attributes"]).toEqual(["workflowId", "humanNotifications"]);
    }
  });

  it("the untouched statements are untouched: SiLedgerReadWrite, DenyRegistryWrite, HubTablesRead", () => {
    const by = Object.fromEntries(policy.Statement.map((s) => [s.Sid, s]));
    expect(by.SiLedgerReadWrite.Resource).toBe(tableArn(REGION, ACCOUNT, "agentcore-hub-si-ledger"));
    expect(list(by.SiLedgerReadWrite.Action)).toContain("dynamodb:DeleteItem");
    expect(by.DenyRegistryWrite.Effect).toBe("Deny");
    expect(list(by.HubTablesRead.Resource)).toContain(TICKETS);
    expect(writes(by.HubTablesRead)).toEqual([]);
  });
});
