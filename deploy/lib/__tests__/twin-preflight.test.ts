/**
 * TEAM-5910 (TEAM-5799 follow-up) — the Deploy stage's ticket-twin preflight.
 *
 * Since TEAM-5832/TEAM-5805 both ticket twins refuse every non-ship Done whose
 * completions/<ticket>.json S3 cannot provably report as missing (404). S3 answers 404
 * only to a caller holding s3:ListBucket on the bucket — the ArtifactBucketList grant
 * that ONLY deploy/setup-tickets-lambda.mjs (a handoff) applies. The pipeline ships twin
 * code with update-function-code alone, so a green deploy could ship code that refuses
 * every non-ship Done fleet-wide. deploy/lib/twin-preflight.mjs runs in buildspec-deploy's
 * pre_build and refuses the whole deploy unless each planned twin's live role carries an
 * unconditioned ListBucket (inline, as tickets-lambda-config.mjs writes it) and its env
 * carries ARTIFACT_BUCKET.
 *
 * Policies below are built with the REAL buildTicketsPolicyStatements, so the producer
 * and the checker cannot drift. The aws CLI is a fake runner; nothing touches AWS.
 * Account ids are the AWS-docs placeholder (scripts/check-no-hardcoded-accounts.sh).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildTicketsPolicyStatements } from "../tickets-lambda-config.mjs";
import {
  TWIN_FUNCTIONS,
  decideTwin,
  inspectTwin,
  parsePlanTwins,
  policyDenies,
  policyGrants,
  runPreflight,
} from "../twin-preflight.mjs";
// TEAM-5924's helpers are read off the namespace so this file still loads on a head
// that lacks them, and each case fails on its own instead of the whole file.
import * as twinPreflight from "../twin-preflight.mjs";

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const BUCKET = `agentcore-hub-artifacts-${ACCOUNT}-${REGION}`;
const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;
const ROLE = { "agentcore-hub-jira": "AgentCoreHubJiraLambdaRole", "agentcore-hub-tickets": "AgentCoreHubTicketsLambdaRole" } as const;
type Twin = keyof typeof ROLE;

type Statement = Record<string, unknown>;
const policyFor = (provider: "jira" | "dynamodb"): { Version: string; Statement: Statement[] } => ({
  Version: "2012-10-17",
  Statement: buildTicketsPolicyStatements({
    provider,
    region: REGION,
    accountId: ACCOUNT,
    tableName: "agentcore-hub-tickets",
    artifactBucket: BUCKET,
  }),
});
const withoutList = (doc: { Version: string; Statement: Statement[] }) => ({
  ...doc,
  Statement: doc.Statement.filter((s) => s.Sid !== "ArtifactBucketList"),
});
const fnArn = (fn: string) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${fn}`;
const TABLE_ARN = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/agentcore-hub-tickets`;
const docs = (document: unknown) => [{ name: "TicketsLambdaAccess", document }];

// ── the fake aws CLI ────────────────────────────────────────────────────────────
type Reply = { code: number; stdout?: string; stderr?: string };
const ok = (v: unknown): Reply => ({ code: 0, stdout: JSON.stringify(v) });
const awsError = (code: string, op: string): Reply => ({
  code: 254,
  stderr: `\nAn error occurred (${code}) when calling the ${op} operation: denied for test\n`,
});

function fakeAws(spec: {
  config?: Partial<Record<Twin, Reply>>;
  list?: Partial<Record<Twin, Reply>>;
  get?: Partial<Record<Twin, Reply>>;
}) {
  const calls: string[][] = [];
  const twinOfRole = (role: string) => (Object.keys(ROLE) as Twin[]).find((t) => ROLE[t] === role)!;
  const run = async (args: string[]): Promise<Reply> => {
    calls.push(args);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    const [svc, op] = args;
    if (svc === "lambda" && op === "get-function-configuration") {
      const fn = at("--function-name") as Twin;
      return spec.config?.[fn] ?? ok({ role: `arn:aws:iam::${ACCOUNT}:role/${ROLE[fn]}`, bucket: BUCKET, arn: fnArn(fn), table: null });
    }
    if (svc === "iam" && op === "list-role-policies") {
      return spec.list?.[twinOfRole(at("--role-name"))] ?? ok(["TicketsLambdaAccess"]);
    }
    if (svc === "iam" && op === "get-role-policy") {
      const t = twinOfRole(at("--role-name"));
      return spec.get?.[t] ?? ok(policyFor(t === "agentcore-hub-jira" ? "jira" : "dynamodb"));
    }
    throw new Error(`unexpected aws call: ${args.join(" ")}`);
  };
  return { run, calls };
}

const JIRA_ROW = "LAMBDA\tagentcore-hub-jira\tlambda/agentcore-hub-jira\t0\t0\tindex.mjs fix-contract.mjs gate-contract.mjs\tnote";
const TICKETS_ROW = "LAMBDA\tagentcore-hub-tickets\tlambda/agentcore-hub-tickets\t0\t1\tindex.mjs fix-contract.mjs gate-contract.mjs\tnote";
const OTHER_ROW = "LAMBDA\tagentcore-hub-cost-report\tlambda/cost-report\t0\t0\tindex.mjs kpi.json\t";
const plan = (...rows: string[]) => rows.join("\n") + "\n";

const preflight = (planText: string, aws: ReturnType<typeof fakeAws>, bucket = BUCKET) => {
  const lines: string[] = [];
  return runPreflight({ planText, bucket, region: REGION, run: aws.run, log: (l: string) => lines.push(l) }).then(
    (r: { exitCode: number }) => ({ ...r, out: lines.join("\n") })
  );
};

// ── plan parsing ────────────────────────────────────────────────────────────────
describe("parsePlanTwins", () => {
  it("returns only the twin LAMBDA rows, with their optional flag", () => {
    expect(parsePlanTwins(plan(OTHER_ROW, JIRA_ROW, TICKETS_ROW, "HANDOFF\tdeploy/setup-tickets-lambda.mjs"))).toEqual([
      { fn: "agentcore-hub-jira", optional: false },
      { fn: "agentcore-hub-tickets", optional: true },
    ]);
  });
  it("is empty for a plan that ships no twin", () => {
    expect(parsePlanTwins(plan(OTHER_ROW))).toEqual([]);
    expect(parsePlanTwins("")).toEqual([]);
  });
});

// ── the matcher ─────────────────────────────────────────────────────────────────
describe("policyGrants / policyDenies", () => {
  it("sees the grant tickets-lambda-config.mjs writes, for both providers", () => {
    for (const p of ["jira", "dynamodb"] as const) {
      expect(policyGrants(docs(policyFor(p)), "s3:ListBucket", BUCKET_ARN)).toBe(true);
      expect(policyGrants(docs(policyFor(p)), "s3:GetObject", `${BUCKET_ARN}/completions/x.json`)).toBe(true);
    }
  });
  it("does not count a grant without ArtifactBucketList", () => {
    expect(policyGrants(docs(withoutList(policyFor("jira"))), "s3:ListBucket", BUCKET_ARN)).toBe(false);
  });
  it("does not count a conditioned Allow (TEAM-5883: s3:prefix never binds to GetObject's implicit list)", () => {
    const doc = { Statement: [{ Effect: "Allow", Action: "s3:ListBucket", Resource: BUCKET_ARN, Condition: { StringLike: { "s3:prefix": ["completions/*"] } } }] };
    expect(policyGrants(docs(doc), "s3:ListBucket", BUCKET_ARN)).toBe(false);
  });
  it("honours IAM globs and case-insensitive actions; a single statement object counts", () => {
    expect(policyGrants(docs({ Statement: { Effect: "Allow", Action: "s3:*", Resource: "arn:aws:s3:::*" } }), "s3:ListBucket", BUCKET_ARN)).toBe(true);
    expect(policyGrants(docs({ Statement: [{ Effect: "Allow", Action: ["S3:LISTBUCKET"], Resource: [BUCKET_ARN] }] }), "s3:ListBucket", BUCKET_ARN)).toBe(true);
    expect(policyGrants(docs({ Statement: [{ Effect: "Allow", Action: "s3:ListBucket", Resource: `${BUCKET_ARN}/*` }] }), "s3:ListBucket", BUCKET_ARN)).toBe(false);
  });
  it("does not count NotAction / NotResource Allows", () => {
    expect(policyGrants(docs({ Statement: [{ Effect: "Allow", NotAction: "iam:*", Resource: "*" }] }), "s3:ListBucket", BUCKET_ARN)).toBe(false);
    expect(policyGrants(docs({ Statement: [{ Effect: "Allow", Action: "s3:ListBucket", NotResource: "arn:aws:s3:::other" }] }), "s3:ListBucket", BUCKET_ARN)).toBe(false);
  });
  it("sees a matching Deny, conditioned or not, and treats a NotAction Deny as a possible deny", () => {
    expect(policyDenies(docs({ Statement: [{ Effect: "Deny", Action: "s3:List*", Resource: "*" }] }), "s3:ListBucket", BUCKET_ARN)).toBe(true);
    expect(policyDenies(docs({ Statement: [{ Effect: "Deny", Action: "s3:ListBucket", Resource: BUCKET_ARN, Condition: { Bool: { "aws:SecureTransport": "false" } } }] }), "s3:ListBucket", BUCKET_ARN)).toBe(true);
    expect(policyDenies(docs({ Statement: [{ Effect: "Deny", NotAction: "s3:GetObject", Resource: "*" }] }), "s3:ListBucket", BUCKET_ARN)).toBe(true);
    expect(policyDenies(docs(policyFor("jira")), "s3:ListBucket", BUCKET_ARN)).toBe(false);
  });
});

// ── the pure decision ───────────────────────────────────────────────────────────
describe("decideTwin", () => {
  const good = {
    fn: "agentcore-hub-jira",
    optional: false,
    expectedBucket: BUCKET,
    config: { state: "ok", role: ROLE["agentcore-hub-jira"], bucket: BUCKET },
    policies: { state: "ok", docs: docs(policyFor("jira")) },
  };
  it("grant present → proceed", () => {
    expect(decideTwin(good).action).toBe("proceed");
  });
  it("missing grant → block, naming setup-tickets-lambda.mjs", () => {
    const v = decideTwin({ ...good, policies: { state: "ok", docs: docs(withoutList(policyFor("jira"))) } });
    expect(v.action).toBe("block");
    expect(v.reasons.join(" ")).toMatch(/s3:ListBucket/);
    expect(v.reasons.join(" ")).toMatch(/setup-tickets-lambda\.mjs/);
  });
  it("a refusal says a managed-policy-only grant does not count", () => {
    const v = decideTwin({ ...good, policies: { state: "ok", docs: [] } });
    expect(v.action).toBe("block");
    expect(v.reasons.join(" ")).toMatch(/managed polic/i);
  });
  it("missing completions/* read → block", () => {
    const doc = { Statement: [{ Effect: "Allow", Action: "s3:ListBucket", Resource: BUCKET_ARN }] };
    expect(decideTwin({ ...good, policies: { state: "ok", docs: docs(doc) } }).action).toBe("block");
  });
  // TEAM-5941: the Done-intent fence writes completions/<ticket>.json before the commit and
  // REFUSES the Done when the write is denied, so twin code must not ship onto a role
  // whose policy pre-dates the CompletionRecordFence statement.
  it("missing completions/* write (a pre-TEAM-5941 policy) → block, naming s3:PutObject and the setup script", () => {
    const preFence = { ...policyFor("jira"), Statement: policyFor("jira").Statement.filter((s) => s.Sid !== "CompletionRecordFence") };
    const v = decideTwin({ ...good, policies: { state: "ok", docs: docs(preFence) } });
    expect(v.action).toBe("block");
    expect(v.reasons.join(" ")).toMatch(/s3:PutObject covering .*completions\/\*/);
    expect(v.reasons.join(" ")).toMatch(/Done-intent fence/);
    expect(v.reasons.join(" ")).toMatch(/setup-tickets-lambda\.mjs/);
  });
  it("a PutObject narrowed to completions/twin-* or a Deny on completions/TEAM-* → block", () => {
    const base = policyFor("jira").Statement.filter((s) => s.Sid !== "CompletionRecordFence");
    const narrowed = { Statement: [...base, { Effect: "Allow", Action: "s3:PutObject", Resource: `${BUCKET_ARN}/completions/twin-*` }] };
    expect(decideTwin({ ...good, policies: { state: "ok", docs: docs(narrowed) } }).action).toBe("block");
    const denied = { Statement: [...policyFor("jira").Statement, { Effect: "Deny", Action: "s3:PutObject", Resource: `${BUCKET_ARN}/completions/TEAM-*` }] };
    expect(decideTwin({ ...good, policies: { state: "ok", docs: docs(denied) } }).action).toBe("block");
  });
  it("the proceed reason names all three grants", () => {
    expect(decideTwin(good).reasons.join(" ")).toMatch(/s3:GetObject and s3:PutObject over/);
  });
  it("explicit Deny → block", () => {
    const doc = { Statement: [...policyFor("jira").Statement, { Effect: "Deny", Action: "s3:ListBucket", Resource: BUCKET_ARN }] };
    expect(decideTwin({ ...good, policies: { state: "ok", docs: docs(doc) } }).action).toBe("block");
  });
  it("unreadable policies → block", () => {
    expect(decideTwin({ ...good, policies: { state: "error", error: "AccessDenied" } }).action).toBe("block");
  });
  it("unreadable function config → block, even for the optional twin", () => {
    expect(decideTwin({ ...good, config: { state: "error", error: "AccessDeniedException" } }).action).toBe("block");
    expect(decideTwin({ ...good, optional: true, config: { state: "error", error: "AccessDeniedException" } }).action).toBe("block");
  });
  it("ARTIFACT_BUCKET missing from the env → block; a different bucket → block", () => {
    expect(decideTwin({ ...good, config: { state: "ok", role: "R", bucket: "" } }).action).toBe("block");
    expect(decideTwin({ ...good, config: { state: "ok", role: "R", bucket: null } }).action).toBe("block");
    expect(decideTwin({ ...good, config: { state: "ok", role: "R", bucket: "some-other-bucket" } }).action).toBe("block");
  });
  it("absent function → skip only when optional", () => {
    expect(decideTwin({ ...good, optional: true, config: { state: "absent" } }).action).toBe("skip-absent");
    expect(decideTwin({ ...good, optional: false, config: { state: "absent" } }).action).toBe("block");
  });
});

// ── TEAM-5924: GetObject is proven over completions/*, not over one probe key ─────
// Ship review F2 on #892: the check used to prove GetObject only on the synthetic
// completions/twin-preflight-probe.json, so a Deny on completions/TEAM-*.json (every
// real record 403s) or an Allow on completions/twin-* (no real record is granted)
// read as ready. Both must refuse.
describe("TEAM-5924: GetObject proven over completions/*, not a probe key", () => {
  const NS = `${BUCKET_ARN}/completions/`;
  const LIST = { Effect: "Allow", Action: "s3:ListBucket", Resource: BUCKET_ARN };
  // TEAM-5941: the fence write is a third requirement; these GetObject cases carry it so
  // they keep testing the READ rule alone.
  const FENCE = { Effect: "Allow", Action: "s3:PutObject", Resource: `${NS}*` };
  const good = {
    fn: "agentcore-hub-jira",
    optional: false,
    expectedBucket: BUCKET,
    config: { state: "ok", role: ROLE["agentcore-hub-jira"], bucket: BUCKET },
    policies: { state: "ok", docs: docs(policyFor("jira")) },
  };
  const withStatements = (...extra: Statement[]) => ({
    ...good,
    policies: { state: "ok", docs: docs({ Statement: [...policyFor("jira").Statement, ...extra] }) },
  });
  const only = (...Statement: Statement[]) => ({ ...good, policies: { state: "ok", docs: docs({ Statement: [FENCE, ...Statement] }) } });
  const helper = <T extends keyof typeof twinPreflight>(name: T) => {
    const fn = twinPreflight[name] as unknown;
    expect(typeof fn, `twin-preflight.mjs exports ${String(name)}`).toBe("function");
    return fn as (...args: unknown[]) => unknown;
  };

  it("a Deny on completions/TEAM-*.json → block (the probe key is not what the Done guard reads)", () => {
    const v = decideTwin(withStatements({ Effect: "Deny", Action: "s3:GetObject", Resource: `${NS}TEAM-*.json` }));
    expect(v.action).toBe("block");
    expect(v.reasons.join(" ")).toMatch(/Deny/);
    expect(v.reasons.join(" ")).toMatch(/completions\/\*/);
  });

  it.each([
    ["s3:Get*", `${NS}TEAM-*.json`],
    ["*", `${NS}TEAM-*.json`],
    [["s3:*"], `${NS}TEAM-*.json`],
    ["s3:GetObject", "arn:aws:s3:::agentcore-hub-*"],
    ["s3:GetObject", `${NS}TEAM-5924.json`],
    ["s3:GetObject", `${BUCKET_ARN}/complet?ons/*`],
  ])("a Deny with Action %j on %s → block", (Action, Resource) => {
    expect(decideTwin(withStatements({ Effect: "Deny", Action, Resource })).action).toBe("block");
  });

  it("a conditioned Deny on completions/TEAM-* → block; a NotAction Deny → block", () => {
    const Condition = { Bool: { "aws:SecureTransport": "false" } };
    expect(decideTwin(withStatements({ Effect: "Deny", Action: "s3:GetObject", Resource: `${NS}TEAM-*`, Condition })).action).toBe("block");
    expect(decideTwin(withStatements({ Effect: "Deny", NotAction: "s3:ListBucket", Resource: `${NS}TEAM-*` })).action).toBe("block");
  });

  // Pin, not a head regression: head's policyDenies already fails closed on ANY
  // NotResource Deny. The helper assertion is what is new.
  it("a NotResource Deny → block (fail closed: its complement may cover completions/*)", () => {
    const deny = { Effect: "Deny", Action: "s3:GetObject", NotResource: `${NS}twin-preflight-probe.json` };
    expect(decideTwin(withStatements(deny)).action).toBe("block");
    expect(helper("policyMayDenyUnder")(docs({ Statement: [deny] }), "s3:GetObject", NS)).toBe(true);
  });

  // Pin, not a head regression: head's policyGrants already ignores every NotResource
  // Allow, so this was never counted as granting the probe key.
  it("a NotResource Allow is not a grant → block", () => {
    const allow = { Effect: "Allow", Action: "s3:GetObject", NotResource: `${BUCKET_ARN}/other/*` };
    expect(decideTwin(only(LIST, allow)).action).toBe("block");
  });

  it("an Allow on completions/twin-* only → block (it matches the probe key, not completions/TEAM-1.json)", () => {
    const v = decideTwin(only(LIST, { Effect: "Allow", Action: "s3:GetObject", Resource: `${NS}twin-*` }));
    expect(v.action).toBe("block");
    expect(v.reasons.join(" ")).toMatch(/completions\/\*/);
  });

  it.each([`${NS}TEAM-1.json`, `${NS}*.json`, `${NS}twin-preflight-probe.json`, `${BUCKET_ARN}/complet?ons/*`])(
    "an Allow on %s only → block",
    (Resource) => {
      expect(decideTwin(only(LIST, { Effect: "Allow", Action: "s3:GetObject", Resource })).action).toBe("block");
    }
  );

  it.each([`${NS}*`, `${BUCKET_ARN}/*`, `${BUCKET_ARN}/comp*`, "arn:aws:s3:::*", "*"])(
    "an Allow on %s covers the namespace → proceed",
    (Resource) => {
      expect(decideTwin(only(LIST, { Effect: "Allow", Action: "s3:GetObject", Resource })).action).toBe("proceed");
    }
  );

  it.each([
    ["s3:GetObject", `${BUCKET_ARN}/config/*`],
    ["s3:GetObject", "arn:aws:s3:::other-bucket/*"],
    ["s3:GetObject", BUCKET_ARN],
    ["s3:PutObject", `${BUCKET_ARN}/config/*`],
    ["s3:DeleteObject", "*"],
  ])("a Deny with Action %s on %s cannot touch a completion read or the fence write → proceed", (Action, Resource) => {
    expect(decideTwin(withStatements({ Effect: "Deny", Action, Resource })).action).toBe("proceed");
  });

  // TEAM-5941: a Deny that may touch the fence WRITE under completions/ blocks too — the
  // twins refuse every Done on a ticket with a record when that write is denied.
  it.each([`${NS}*`, `${NS}TEAM-*.json`, `${BUCKET_ARN}/*`])("a Deny with Action s3:PutObject on %s → block", (Resource) => {
    const v = decideTwin(withStatements({ Effect: "Deny", Action: "s3:PutObject", Resource }));
    expect(v.action).toBe("block");
    expect(v.reasons.join(" ")).toMatch(/Deny that may cover s3:PutObject/);
  });

  it("coversPrefix: only a pattern matching EVERY key under the prefix covers it", () => {
    const covers = helper("coversPrefix");
    for (const p of [`${NS}*`, `${BUCKET_ARN}/*`, `${BUCKET_ARN}/comp*`, `${NS}**`, "arn:aws:s3:::*", "*"]) {
      expect(covers(p, NS), p).toBe(true);
    }
    for (const p of [`${NS}TEAM-1.json`, `${NS}twin-*`, `${NS}*.json`, `${BUCKET_ARN}/complet?ons/*`, BUCKET_ARN, `${BUCKET_ARN}/config/*`]) {
      expect(covers(p, NS), p).toBe(false);
    }
  });

  it("mayIntersectPrefix: any pattern some key under the prefix could match", () => {
    const meets = helper("mayIntersectPrefix");
    for (const p of [`${NS}TEAM-*.json`, `${NS}TEAM-1.json`, `${BUCKET_ARN}/*`, "*", "arn:aws:s3:::agentcore-*", `${BUCKET_ARN}/complet?ons/x`]) {
      expect(meets(p, NS), p).toBe(true);
    }
    for (const p of [`${BUCKET_ARN}/config/*`, "arn:aws:s3:::other/*", BUCKET_ARN, `${BUCKET_ARN}/completions`]) {
      expect(meets(p, NS), p).toBe(false);
    }
  });

  it("runPreflight: the TEAM-* Deny refuses the deploy (exit 1)", async () => {
    const doc = { ...policyFor("jira") };
    doc.Statement = [...doc.Statement, { Effect: "Deny", Action: "s3:GetObject", Resource: `${NS}TEAM-*.json` }];
    const r = await preflight(plan(JIRA_ROW), fakeAws({ get: { "agentcore-hub-jira": ok(doc) } }));
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatch(/agentcore-hub-jira: BLOCK/);
  });
});

// ── TEAM-6143: the dynamodb twin's require_done Done needs ConditionCheckItem ───────
// A Done carrying require_done is one TransactWriteItems with a ConditionCheck per
// required ticket row. The grant lands only via setup-tickets-lambda.mjs (a handoff), so
// shipping that code onto a role without it would AccessDenies every such Done, which
// the workflow-output drain retries without end. The preflight must block instead.
describe("TEAM-6143: dynamodb:ConditionCheckItem on the tickets table", () => {
  const preTxn = () => {
    const doc = policyFor("dynamodb");
    doc.Statement = doc.Statement.map((s) =>
      Array.isArray(s.Action) && (s.Action as string[]).includes("dynamodb:UpdateItem")
        ? { ...s, Action: (s.Action as string[]).filter((a) => a !== "dynamodb:ConditionCheckItem") }
        : s
    );
    return doc;
  };
  const good = {
    fn: "agentcore-hub-tickets",
    optional: true,
    expectedBucket: BUCKET,
    config: { state: "ok", role: ROLE["agentcore-hub-tickets"], bucket: BUCKET, region: REGION, account: ACCOUNT, table: "" },
    policies: { state: "ok", docs: docs(policyFor("dynamodb")) },
  };

  it("the policy tickets-lambda-config.mjs writes → proceed, naming the grant", () => {
    const v = decideTwin(good);
    expect(v.action).toBe("proceed");
    expect(v.reasons.join(" ")).toContain(`dynamodb:ConditionCheckItem on ${TABLE_ARN}`);
  });
  it("a pre-TEAM-6143 policy (no ConditionCheckItem) → block, naming the action, the table and the setup script", () => {
    const v = decideTwin({ ...good, policies: { state: "ok", docs: docs(preTxn()) } });
    expect(v.action).toBe("block");
    expect(v.reasons.join(" ")).toMatch(/no unconditioned inline dynamodb:ConditionCheckItem covering arn:aws:dynamodb:us-east-1:123456789012:table\/agentcore-hub-tickets/);
    expect(v.reasons.join(" ")).toMatch(/TEAM-6143/);
    expect(v.reasons.join(" ")).toContain("TICKET_PROVIDER=dynamodb node deploy/setup-tickets-lambda.mjs");
  });
  it("checks the table the function's TICKETS_TABLE names, not the default", () => {
    const v = decideTwin({ ...good, config: { ...good.config, table: "custom-tickets" } });
    expect(v.action).toBe("block");
    expect(v.reasons.join(" ")).toMatch(/table\/custom-tickets/);
  });
  it("a Deny that may cover it, or a conditioned grant → block", () => {
    const denied = { Statement: [...policyFor("dynamodb").Statement, { Effect: "Deny", Action: "dynamodb:*", Resource: "*" }] };
    expect(decideTwin({ ...good, policies: { state: "ok", docs: docs(denied) } }).action).toBe("block");
    const conditioned = {
      Statement: [
        ...preTxn().Statement,
        { Effect: "Allow", Action: "dynamodb:ConditionCheckItem", Resource: TABLE_ARN, Condition: { Bool: { "aws:SecureTransport": "true" } } },
      ],
    };
    expect(decideTwin({ ...good, policies: { state: "ok", docs: docs(conditioned) } }).action).toBe("block");
  });
  it("no region/account to build the table ARN → block (unverifiable)", () => {
    const v = decideTwin({ ...good, config: { state: "ok", role: ROLE["agentcore-hub-tickets"], bucket: BUCKET } });
    expect(v.action).toBe("block");
    expect(v.reasons.join(" ")).toMatch(/ConditionCheckItem is unverifiable/);
  });
  it("the Jira twin is not asked for it (no table)", () => {
    const jira = { ...good, fn: "agentcore-hub-jira", optional: false, config: { ...good.config, role: ROLE["agentcore-hub-jira"] }, policies: { state: "ok", docs: docs(policyFor("jira")) } };
    const v = decideTwin(jira);
    expect(v.action).toBe("proceed");
    expect(v.reasons.join(" ")).not.toMatch(/ConditionCheckItem/);
  });
  it("runPreflight: a live tickets role without the grant refuses the deploy (exit 1)", async () => {
    const r = await preflight(plan(JIRA_ROW, TICKETS_ROW), fakeAws({ get: { "agentcore-hub-tickets": ok(preTxn()) } }));
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatch(/agentcore-hub-tickets: BLOCK/);
    expect(r.out).toMatch(/dynamodb:ConditionCheckItem/);
  });
});

// ── the wrapper over the CLI ────────────────────────────────────────────────────
describe("inspectTwin", () => {
  it("queries only Role, FunctionArn, ARTIFACT_BUCKET and TICKETS_TABLE (never the env values that hold secrets)", async () => {
    const aws = fakeAws({});
    await inspectTwin("agentcore-hub-jira", { run: aws.run, region: REGION });
    const cfg = aws.calls.find((c) => c[1] === "get-function-configuration")!;
    expect(cfg[cfg.indexOf("--query") + 1]).toBe(
      "{role: Role, bucket: Environment.Variables.ARTIFACT_BUCKET, arn: FunctionArn, table: Environment.Variables.TICKETS_TABLE}"
    );
  });
  it("TEAM-6143: derives region + account from the FunctionArn and passes TICKETS_TABLE through", async () => {
    const aws = fakeAws({
      config: { "agentcore-hub-tickets": ok({ role: `arn:aws:iam::${ACCOUNT}:role/${ROLE["agentcore-hub-tickets"]}`, bucket: BUCKET, arn: fnArn("agentcore-hub-tickets"), table: "custom-tickets" }) },
    });
    const r = await inspectTwin("agentcore-hub-tickets", { run: aws.run, region: REGION });
    expect(r.config).toMatchObject({ state: "ok", region: REGION, account: ACCOUNT, table: "custom-tickets" });
  });
  it("strips an IAM path off the role ARN", async () => {
    const aws = fakeAws({ config: { "agentcore-hub-jira": ok({ role: `arn:aws:iam::${ACCOUNT}:role/svc/AgentCoreHubJiraLambdaRole`, bucket: BUCKET }) } });
    const r = await inspectTwin("agentcore-hub-jira", { run: aws.run, region: REGION });
    expect(r.config).toMatchObject({ state: "ok", role: "AgentCoreHubJiraLambdaRole" });
  });
  it("classifies ResourceNotFoundException as absent and anything else as error", async () => {
    const absent = await inspectTwin("agentcore-hub-tickets", { run: fakeAws({ config: { "agentcore-hub-tickets": awsError("ResourceNotFoundException", "GetFunctionConfiguration") } }).run, region: REGION });
    expect(absent.config.state).toBe("absent");
    const denied = await inspectTwin("agentcore-hub-tickets", { run: fakeAws({ config: { "agentcore-hub-tickets": awsError("AccessDeniedException", "GetFunctionConfiguration") } }).run, region: REGION });
    expect(denied.config).toMatchObject({ state: "error" });
  });
  it("parses a URL-encoded PolicyDocument string", async () => {
    const encoded = encodeURIComponent(JSON.stringify(policyFor("jira")));
    const aws = fakeAws({ get: { "agentcore-hub-jira": ok(encoded) } });
    const r = await inspectTwin("agentcore-hub-jira", { run: aws.run, region: REGION });
    expect(r.policies!.state).toBe("ok");
    expect(policyGrants(r.policies!.docs, "s3:ListBucket", BUCKET_ARN)).toBe(true);
  });
});

// ── end to end over the plan ────────────────────────────────────────────────────
describe("runPreflight", () => {
  it("grant present → exit 0", async () => {
    const r = await preflight(plan(JIRA_ROW, TICKETS_ROW), fakeAws({}));
    expect(r.exitCode).toBe(0);
  });
  it("missing grant → exit 1, and the refusal tells the operator what to run", async () => {
    const r = await preflight(plan(JIRA_ROW), fakeAws({ get: { "agentcore-hub-jira": ok(withoutList(policyFor("jira"))) } }));
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatch(/agentcore-hub-jira/);
    expect(r.out).toMatch(/node deploy\/setup-tickets-lambda\.mjs/);
  });
  it("conditioned grant → exit 1", async () => {
    const doc = policyFor("jira");
    doc.Statement = doc.Statement.map((s) => (s.Sid === "ArtifactBucketList" ? { ...s, Condition: { StringLike: { "s3:prefix": ["completions/*"] } } } : s));
    expect((await preflight(plan(JIRA_ROW), fakeAws({ get: { "agentcore-hub-jira": ok(doc) } }))).exitCode).toBe(1);
  });
  it("AccessDenied on the IAM read → exit 1, pointing at the deploy role", async () => {
    const r = await preflight(plan(JIRA_ROW), fakeAws({ list: { "agentcore-hub-jira": awsError("AccessDenied", "ListRolePolicies") } }));
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatch(/deploy\/pipeline\/deploy\.sh/);
    const r2 = await preflight(plan(JIRA_ROW), fakeAws({ get: { "agentcore-hub-jira": awsError("AccessDenied", "GetRolePolicy") } }));
    expect(r2.exitCode).toBe(1);
  });
  it("ARTIFACT_BUCKET missing from the function env → exit 1", async () => {
    const aws = fakeAws({ config: { "agentcore-hub-jira": ok({ role: `arn:aws:iam::${ACCOUNT}:role/AgentCoreHubJiraLambdaRole`, bucket: null }) } });
    expect((await preflight(plan(JIRA_ROW), aws)).exitCode).toBe(1);
  });
  it("one bad twin blocks the deploy even when the other is fine", async () => {
    const r = await preflight(plan(JIRA_ROW, TICKETS_ROW), fakeAws({ get: { "agentcore-hub-tickets": ok(withoutList(policyFor("dynamodb"))) } }));
    expect(r.exitCode).toBe(1);
  });
  it("optional twin absent → exit 0 (Target 1b skips it)", async () => {
    const aws = fakeAws({ config: { "agentcore-hub-tickets": awsError("ResourceNotFoundException", "GetFunctionConfiguration") } });
    expect((await preflight(plan(JIRA_ROW, TICKETS_ROW), aws)).exitCode).toBe(0);
  });
  it("no twin in the plan → exit 0 with zero AWS calls", async () => {
    const aws = fakeAws({});
    expect((await preflight(plan(OTHER_ROW), aws)).exitCode).toBe(0);
    expect(aws.calls).toEqual([]);
  });
  it("no pipeline ARTIFACT_BUCKET → exit 1 (nothing to check the grant against)", async () => {
    expect((await preflight(plan(JIRA_ROW), fakeAws({}), "")).exitCode).toBe(1);
  });
});

// ── static pins: the wiring that makes the verdict matter ───────────────────────
describe("wiring", () => {
  const repo = resolve(__dirname, "../../..");
  const read = (p: string) => readFileSync(resolve(repo, p), "utf8");

  it("TWIN_FUNCTIONS are exactly the ticket twins in surfaces.json", () => {
    const fns = (JSON.parse(read("deploy/pipeline/surfaces.json")).lambdas as { function: string }[]).map((l) => l.function);
    expect([...TWIN_FUNCTIONS].sort()).toEqual(["agentcore-hub-jira", "agentcore-hub-tickets"]);
    for (const fn of TWIN_FUNCTIONS) expect(fns).toContain(fn);
  });

  it("buildspec-deploy runs the preflight in pre_build, after the plan and before the build phase", () => {
    const text = read("deploy/pipeline/buildspec-deploy.yml");
    const code = text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    const pre = code.indexOf("  pre_build:");
    const planAt = code.indexOf("plan-surfaces.py pipeline-out/changed-files.txt");
    const flight = code.indexOf("node deploy/lib/twin-preflight.mjs");
    const build = code.indexOf("\n  build:");
    expect(pre).toBeGreaterThan(-1);
    expect(flight).toBeGreaterThan(planAt);
    expect(planAt).toBeGreaterThan(pre);
    expect(build).toBeGreaterThan(flight);
    expect(code.slice(flight, build)).toMatch(/exit 1/);
  });

  it("the Deploy role may read the two twin roles' inline policies (and nothing broader)", () => {
    const stack = read("deploy/pipeline/lib/pipeline-stack.ts");
    const at = stack.indexOf('sid: "TwinPreflightIamRead"');
    expect(at).toBeGreaterThan(-1);
    const stmt = stack.slice(at, stack.indexOf("}),", at));
    expect(stmt).toMatch(/"iam:ListRolePolicies"/);
    expect(stmt).toMatch(/"iam:GetRolePolicy"/);
    expect(stmt).toMatch(/role\/AgentCoreHubJiraLambdaRole/);
    expect(stmt).toMatch(/role\/AgentCoreHubTicketsLambdaRole/);
    expect(stmt).not.toMatch(/iam:\*|iam:Put|iam:Pass/);
  });
});
