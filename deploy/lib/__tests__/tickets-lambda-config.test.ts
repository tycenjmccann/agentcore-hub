/**
 * TEAM-5867 (TEAM-5799 follow-up) — the ticket-tools Lambda's deploy-time config, as data.
 *
 * Two findings against deploy/setup-tickets-lambda.mjs, both of which left every
 * recordless ticket (human gates, Merge Approval) unable to reach Done once TEAM-5832
 * (#878) made the twins' Done guard fail closed:
 *
 *   P0  the role held s3:GetObject on <bucket>/* ONLY. S3 answers a GetObject of a
 *       MISSING key with 404 only when the caller also holds s3:ListBucket on the bucket;
 *       otherwise it answers 403 AccessDenied — which the guard (rightly) refuses.
 *   P1  ARTIFACT_BUCKET was derived at import time from AWS_ACCOUNT_ID (usually unset),
 *       BEFORE STS resolved the account, never recomputed, forwarded only when truthy,
 *       and the Lambda env is replaced wholesale — so a standalone re-run stripped it.
 *
 * The script is an imperative handoff script (STS/IAM/Lambda calls at top level), so the
 * decisions live in deploy/lib/tickets-lambda-config.mjs and are pinned here. The last
 * describe block reads the SCRIPT's source and asserts it actually uses the module — on
 * the pre-5867 file those assertions fail (inline "s3:GetObject", the conditional
 * `...(ARTIFACT_BUCKET && { … })` spread, the import-time AWS_ACCOUNT_ID derivation).
 *
 * Account ids below are the AWS-docs placeholder (scripts/check-no-hardcoded-accounts.sh).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildTicketsLambdaEnv,
  buildTicketsPolicyStatements,
  resolveArtifactBucket,
} from "../tickets-lambda-config.mjs";

const ACCOUNT = "123456789012";
// resolveArtifactBucket defaults `env` to process.env, so TS infers NodeJS.ProcessEnv.
const envOf = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
const REGION = "us-east-1";
const BUCKET = `agentcore-hub-artifacts-${ACCOUNT}-${REGION}`;
const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;

type Statement = {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, unknown>;
};

const base = (provider: "dynamodb" | "jira") => ({
  provider,
  region: REGION,
  accountId: ACCOUNT,
  tableName: "agentcore-hub-tickets",
  artifactBucket: BUCKET,
});
const statements = (provider: "dynamodb" | "jira", extra = {}): Statement[] =>
  buildTicketsPolicyStatements({ ...base(provider), ...extra });
const actionsOf = (s: Statement) => ([] as string[]).concat(s.Action);
const s3Statements = (list: Statement[]) =>
  list.filter((s) => actionsOf(s).some((a) => a.startsWith("s3:")));

describe("buildTicketsPolicyStatements — the S3 grants (TEAM-5867 P0)", () => {
  it.each(["dynamodb", "jira"] as const)(
    "%s: grants s3:ListBucket on the bucket ARN itself - no /*, no Condition",
    (provider) => {
      const list = statements(provider).filter((s) => actionsOf(s).includes("s3:ListBucket"));
      expect(list).toEqual([
        {
          Sid: "ArtifactBucketList",
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: BUCKET_ARN,
        },
      ]);
      // The bucket ARN, not an object ARN: ListBucket on `<bucket>/*` grants nothing.
      expect(list[0].Resource).not.toContain("/");
      // Unconditioned on purpose: the twins probe with GetObject, whose implicit ListBucket
      // check carries no s3:prefix, so a StringLike s3:prefix condition would never match
      // and S3 would keep answering 403 for a missing record.
      expect(list[0]).not.toHaveProperty("Condition");
    }
  );

  it.each(["dynamodb", "jira"] as const)(
    "%s: keeps the bucket-wide s3:GetObject statement byte-identical to the pre-TEAM-5867 grant",
    (provider) => {
      const list = statements(provider).filter((s) => actionsOf(s).includes("s3:GetObject"));
      expect(list).toHaveLength(1);
      // Sid aside (new, a label), Action/Resource are what verify-infra.sh:311 and the
      // pipeline-tools test's completions/* probe match on.
      const { Sid, ...rest } = list[0];
      expect(Sid).toBe("ArtifactRead");
      expect(rest).toEqual({
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: `${BUCKET_ARN}/*`,
      });
    }
  );

  it("no S3 statement carries an s3:prefix Condition", () => {
    for (const provider of ["dynamodb", "jira"] as const) {
      for (const s of s3Statements(statements(provider))) {
        expect(s.Condition, `${provider}/${s.Sid}`).toBeUndefined();
      }
    }
  });

  it("the S3 actions are exactly GetObject, ListBucket and the TEAM-5941 fence PutObject - no s3:Delete*, no other write", () => {
    for (const provider of ["dynamodb", "jira"] as const) {
      const s3Actions = s3Statements(statements(provider)).flatMap(actionsOf).sort();
      expect(s3Actions).toEqual(["s3:GetObject", "s3:ListBucket", "s3:PutObject"]);
    }
  });

  // TEAM-5941: the Done-intent fence is a conditional PutObject of completions/<ticket>.json
  // right before the provider commit, and a denied write REFUSES the Done (fail closed).
  it.each(["dynamodb", "jira"] as const)(
    "%s: the fence PutObject is one unconditioned statement scoped to completions/* and nothing wider",
    (provider) => {
      const list = statements(provider).filter((s) => actionsOf(s).includes("s3:PutObject"));
      expect(list).toHaveLength(1);
      const { Sid, ...rest } = list[0];
      expect(Sid).toBe("CompletionRecordFence");
      expect(rest).toEqual({
        Effect: "Allow",
        Action: ["s3:PutObject"],
        Resource: `${BUCKET_ARN}/completions/*`,
      });
      // ArtifactRead is NOT widened to carry the write: the read stays bucket-wide, the
      // write stays prefix-scoped.
      const read = statements(provider).find((s) => s.Sid === "ArtifactRead");
      expect(actionsOf(read!)).toEqual(["s3:GetObject"]);
    }
  );

  it("is additive: every non-S3 statement is what the script wrote before", () => {
    const ddb = statements("dynamodb", {
      pipelineToolsLambda: "agentcore-hub-pipeline-tools",
      eventsTable: "agentcore-hub-events",
      workflowsTable: "agentcore-hub-workflows",
    });
    const others = ddb.filter((s) => !actionsOf(s).some((a) => a.startsWith("s3:")));
    expect(others).toEqual([
      {
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: `arn:aws:logs:${REGION}:${ACCOUNT}:*`,
      },
      {
        Effect: "Allow",
        Action: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"],
        Resource: [
          `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/agentcore-hub-tickets`,
          `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/agentcore-hub-tickets/index/*`,
        ],
      },
      {
        Effect: "Allow",
        Action: ["lambda:InvokeFunction"],
        Resource: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:agentcore-hub-pipeline-tools`,
      },
      {
        Effect: "Allow",
        Action: ["dynamodb:PutItem"],
        Resource: `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/agentcore-hub-events`,
      },
      {
        Effect: "Allow",
        Action: ["dynamodb:GetItem"],
        Resource: `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/agentcore-hub-workflows`,
      },
    ]);
    // jira: no tickets-table statement; the optional three stay conditional (unset ⇒ absent).
    const jira = statements("jira");
    expect(jira.map((s) => s.Sid ?? actionsOf(s)[0])).toEqual([
      "logs:CreateLogGroup",
      "ArtifactRead",
      "ArtifactBucketList",
      "CompletionRecordFence", // TEAM-5941
    ]);
  });

  it("throws before building any statement when artifactBucket is empty", () => {
    expect(() => statements("dynamodb", { artifactBucket: "" })).toThrow(/artifactBucket is required/);
    expect(() => statements("jira", { artifactBucket: undefined })).toThrow(/artifactBucket is required/);
  });
});

describe("resolveArtifactBucket (TEAM-5867 P1)", () => {
  it("derives the conventional bucket from the STS account when ARTIFACT_BUCKET is unset", () => {
    expect(resolveArtifactBucket({ env: envOf({}), accountId: ACCOUNT, region: REGION })).toBe(BUCKET);
    // AWS_ACCOUNT_ID alone no longer feeds the derivation — the STS answer does.
    expect(
      resolveArtifactBucket({ env: envOf({ AWS_ACCOUNT_ID: "210987654321" }), accountId: ACCOUNT, region: REGION })
    ).toBe(BUCKET);
  });

  it("an explicit ARTIFACT_BUCKET wins over the derived name", () => {
    expect(
      resolveArtifactBucket({ env: envOf({ ARTIFACT_BUCKET: "explicit-bucket" }), accountId: ACCOUNT, region: REGION })
    ).toBe("explicit-bucket");
  });

  it("throws when neither env nor accountId yields a bucket (nothing may reach IAM)", () => {
    expect(() => resolveArtifactBucket({ env: envOf({}), accountId: "", region: REGION })).toThrow(
      /ARTIFACT_BUCKET could not be resolved/
    );
    expect(() => resolveArtifactBucket({ env: envOf({}), accountId: ACCOUNT, region: "" })).toThrow(
      /ARTIFACT_BUCKET could not be resolved/
    );
  });
});

describe("buildTicketsLambdaEnv (TEAM-5867 P1)", () => {
  const common = {
    region: REGION,
    tableName: "agentcore-hub-tickets",
    projectKey: "TEAM",
    artifactBucket: BUCKET,
    jira: { siteUrl: "https://example.atlassian.net", email: "bot@example.com", apiToken: "tok" },
  };

  it("always includes ARTIFACT_BUCKET in BOTH provider arms and still omits unset optional vars", () => {
    expect(buildTicketsLambdaEnv({ ...common, provider: "dynamodb" })).toEqual({
      TICKETS_TABLE: "agentcore-hub-tickets",
      PROJECT_KEY: "TEAM",
      AWS_REGION_OVERRIDE: REGION,
      ARTIFACT_BUCKET: BUCKET,
    });
    expect(buildTicketsLambdaEnv({ ...common, provider: "jira" })).toEqual({
      JIRA_SITE_URL: "https://example.atlassian.net",
      JIRA_EMAIL: "bot@example.com",
      JIRA_API_TOKEN: "tok",
      JIRA_PROJECT_KEY: "TEAM",
      AWS_REGION_OVERRIDE: REGION,
      ARTIFACT_BUCKET: BUCKET,
    });
  });

  it("forwards the optional vars only when set, identically in both arms", () => {
    const optional = {
      fixTicketContract: "on",
      pipelineToolsLambda: "agentcore-hub-pipeline-tools",
      eventsTable: "agentcore-hub-events",
      workflowsTable: "agentcore-hub-workflows",
    };
    for (const provider of ["dynamodb", "jira"] as const) {
      const env = buildTicketsLambdaEnv({ ...common, provider, ...optional });
      expect(env).toMatchObject({
        ARTIFACT_BUCKET: BUCKET,
        FIX_TICKET_CONTRACT: "on",
        PIPELINE_TOOLS_LAMBDA: "agentcore-hub-pipeline-tools",
        EVENTS_TABLE: "agentcore-hub-events",
        WORKFLOWS_TABLE: "agentcore-hub-workflows",
      });
    }
    // The jira arm never carries the tickets table; the dynamodb arm never carries JIRA_*.
    expect(buildTicketsLambdaEnv({ ...common, provider: "jira" })).not.toHaveProperty("TICKETS_TABLE");
    expect(Object.keys(buildTicketsLambdaEnv({ ...common, provider: "dynamodb" })).filter((k) => k.startsWith("JIRA_"))).toEqual([]);
  });

  it("throws when artifactBucket is empty - the env can no longer be built without one", () => {
    expect(() => buildTicketsLambdaEnv({ ...common, provider: "dynamodb", artifactBucket: "" })).toThrow(
      /artifactBucket is required/
    );
  });
});

describe("deploy/setup-tickets-lambda.mjs uses the module (static pins)", () => {
  const src = () =>
    readFileSync(resolve(__dirname, "../../setup-tickets-lambda.mjs"), "utf8");

  it("imports the builders and has no inline S3 statement or conditional ARTIFACT_BUCKET spread", () => {
    const text = src();
    expect(text).toContain('from "./lib/tickets-lambda-config.mjs"');
    expect(text).toContain("buildTicketsPolicyStatements(");
    expect(text).toContain("buildTicketsLambdaEnv(");
    expect(text).toContain("resolveArtifactBucket(");
    // The pre-5867 inline statement and env spread — the quoted literals, not prose.
    expect(text).not.toContain('"s3:GetObject"');
    expect(text).not.toContain('"s3:ListBucket"');
    expect(text).not.toContain("...(ARTIFACT_BUCKET && {");
  });

  it("resolves ARTIFACT_BUCKET after the STS call and no longer from AWS_ACCOUNT_ID at import time", () => {
    const text = src();
    expect(text).not.toContain("process.env.AWS_ACCOUNT_ID");
    const sts = text.indexOf("get-caller-identity");
    const bucket = text.indexOf("ARTIFACT_BUCKET = resolveArtifactBucket(");
    expect(sts).toBeGreaterThan(-1);
    expect(bucket).toBeGreaterThan(sts);
    // …and refuses to continue without one, before Step 1.
    const exit = text.indexOf("process.exit(1);", bucket);
    const step1 = text.indexOf("1/5 Creating DynamoDB table");
    expect(exit).toBeGreaterThan(bucket);
    expect(exit).toBeLessThan(step1);
  });
});
