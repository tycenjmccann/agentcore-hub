/**
 * TEAM-6087 — one TICKET_PROVIDER default for the deploy layer.
 *
 * deploy/setup-tickets-lambda.mjs defaulted an unset TICKET_PROVIDER to
 * "dynamodb" while every other deploy script that reads it defaulted to
 * "jira" (lambda/orchestrator/deploy.sh, lambda/workflow-output/deploy.sh,
 * deploy/runtime-agent/deploy-one.sh, deploy-one-robust.py,
 * deploy/ticket-provider-probe/deploy.sh, the Dockerfile, .env.example). An
 * install that left the var unset created the tickets Lambda under one name
 * while the runtimes' TICKET_TOOLS_LAMBDA pointed at the other.
 *
 * deploy/lib/ticket-provider.mjs is now the one place the Node setup
 * scripts (deploy/setup-tickets-lambda.mjs,
 * deploy/workflow-manager/setup-workflow-manager.mjs) resolve the default
 * from. The shell scripts can't import a .mjs, so they keep their own
 * `${TICKET_PROVIDER:-jira}` / `${TICKET_TOOLS_LAMBDA:-agentcore-hub-jira}`
 * literals — the "shell parity" and "lambda-name parity" blocks below read
 * those files' source and assert every literal still matches
 * DEFAULT_TICKET_PROVIDER / ticketToolsLambdaName(DEFAULT_TICKET_PROVIDER),
 * so a future edit that reintroduces the drift fails here.
 *
 * Runtime code (lambda/orchestrator/index.mjs, agent-invoker.mjs,
 * lambda/workflow-output/index.mjs, src/app/api/**, main.py, the
 * workflow-manager toolkit) is out of scope and still defaults to
 * "dynamodb" when unset — not touched or pinned here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_TICKET_PROVIDER,
  resolveTicketProvider,
  ticketToolsLambdaName,
} from "../ticket-provider.mjs";

const repoFile = (rel: string) => readFileSync(resolve(__dirname, "../../..", rel), "utf8");
// Same idiom as tickets-lambda-config.test.ts's envOf: resolveTicketProvider only
// reads TICKET_PROVIDER, so a plain Record is fine — cast past ProcessEnv's
// unrelated required keys (NODE_ENV).
const envOf = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe("DEFAULT_TICKET_PROVIDER", () => {
  it("is jira — the deploy layer's canonical default (ships in Dockerfile/.env.example)", () => {
    expect(DEFAULT_TICKET_PROVIDER).toBe("jira");
  });
});

describe("resolveTicketProvider", () => {
  it("defaults to jira when unset", () => {
    expect(resolveTicketProvider(envOf({}))).toBe("jira");
  });

  it("defaults to jira on an empty string", () => {
    expect(resolveTicketProvider(envOf({ TICKET_PROVIDER: "" }))).toBe("jira");
  });

  it("respects an explicit dynamodb", () => {
    expect(resolveTicketProvider(envOf({ TICKET_PROVIDER: "dynamodb" }))).toBe("dynamodb");
  });

  it("respects an explicit jira", () => {
    expect(resolveTicketProvider(envOf({ TICKET_PROVIDER: "jira" }))).toBe("jira");
  });

  it("lowercases", () => {
    expect(resolveTicketProvider(envOf({ TICKET_PROVIDER: "JIRA" }))).toBe("jira");
    expect(resolveTicketProvider(envOf({ TICKET_PROVIDER: "DynamoDB" }))).toBe("dynamodb");
  });
});

describe("ticketToolsLambdaName", () => {
  it("maps jira to agentcore-hub-jira", () => {
    expect(ticketToolsLambdaName("jira")).toBe("agentcore-hub-jira");
  });

  it("maps everything else (dynamodb) to agentcore-hub-tickets", () => {
    expect(ticketToolsLambdaName("dynamodb")).toBe("agentcore-hub-tickets");
  });
});

describe("deploy/setup-tickets-lambda.mjs uses the shared default (static pin)", () => {
  const src = () => repoFile("deploy/setup-tickets-lambda.mjs");

  it("imports and calls resolveTicketProvider / ticketToolsLambdaName", () => {
    const text = src();
    expect(text).toContain('from "./lib/ticket-provider.mjs"');
    expect(text).toContain("resolveTicketProvider(process.env)");
    expect(text).toContain("ticketToolsLambdaName(TICKET_PROVIDER)");
  });

  it("has no inline dynamodb fallback for TICKET_PROVIDER", () => {
    expect(src()).not.toMatch(/TICKET_PROVIDER\s*\|\|\s*"dynamodb"/);
  });
});

describe("deploy/workflow-manager/setup-workflow-manager.mjs uses the shared default (static pin)", () => {
  const src = () => repoFile("deploy/workflow-manager/setup-workflow-manager.mjs");

  it("imports and calls resolveTicketProvider", () => {
    const text = src();
    expect(text).toContain('from "../lib/ticket-provider.mjs"');
    expect(text).toContain("resolveTicketProvider(process.env)");
  });

  it("has no inline dynamodb fallback for TICKET_PROVIDER", () => {
    expect(src()).not.toMatch(/TICKET_PROVIDER\s*\|\|\s*"dynamodb"/);
  });
});

describe("shell deploy scripts' TICKET_PROVIDER default matches DEFAULT_TICKET_PROVIDER", () => {
  // Every `TICKET_PROVIDER:-<word>` in these files must equal the shared
  // default — require at least one match per file so this can't pass vacuously.
  const files = [
    "lambda/orchestrator/deploy.sh",
    "lambda/workflow-output/deploy.sh",
    "scripts/verify-infra.sh",
    ".claude-plugin/bin/verify-module.sh",
  ];

  for (const file of files) {
    it(`${file}`, () => {
      const text = repoFile(file);
      const matches = [...text.matchAll(/TICKET_PROVIDER:-(\w+)/g)].map((m) => m[1]);
      expect(matches.length).toBeGreaterThan(0);
      for (const value of matches) {
        expect(value).toBe(DEFAULT_TICKET_PROVIDER);
      }
    });
  }
});

describe("runtime deploy scripts' TICKET_TOOLS_LAMBDA default matches ticketToolsLambdaName(DEFAULT_TICKET_PROVIDER)", () => {
  const expected = ticketToolsLambdaName(DEFAULT_TICKET_PROVIDER);

  // Since TEAM-6069 deploy-one.sh takes its defaults from lib/runtime-env-defaults.sh,
  // which derives TICKET_TOOLS_LAMBDA from TICKET_PROVIDER (default jira).
  it("deploy/runtime-agent/deploy-one.sh (via lib/runtime-env-defaults.sh)", () => {
    expect(repoFile("deploy/runtime-agent/deploy-one.sh")).toMatch(/source "\$SCRIPT_DIR\/\.\.\/lib\/runtime-env-defaults\.sh"/);
    const text = repoFile("deploy/lib/runtime-env-defaults.sh");
    expect(text).toMatch(new RegExp(`TICKET_PROVIDER:-${DEFAULT_TICKET_PROVIDER}\\}`));
    const jiraArm = text.match(/if \[ "\$provider" = "jira" \]; then\s*TICKET_TOOLS_LAMBDA="([\w-]+)"/);
    expect(jiraArm?.[1]).toBe(ticketToolsLambdaName("jira"));
    expect(ticketToolsLambdaName(DEFAULT_TICKET_PROVIDER)).toBe(expected);
  });

  it("deploy/runtime-agent/deploy-one-robust.py (_ticket_tools_lambda)", () => {
    const text = repoFile("deploy/runtime-agent/deploy-one-robust.py");
    expect(text).toMatch(new RegExp(`os\\.environ\\.get\\("TICKET_PROVIDER", "${DEFAULT_TICKET_PROVIDER}"\\)`));
    const jiraArm = text.match(/== "jira":\s*return "([\w-]+)"/);
    expect(jiraArm?.[1]).toBe(ticketToolsLambdaName("jira"));
    expect(ticketToolsLambdaName(DEFAULT_TICKET_PROVIDER)).toBe(expected);
  });

  it("deploy/ticket-provider-probe/deploy.sh", () => {
    const text = repoFile("deploy/ticket-provider-probe/deploy.sh");
    const matches = [...text.matchAll(/TICKET_TOOLS_LAMBDA:-([\w-]+)/g)].map((m) => m[1]);
    expect(matches.length).toBeGreaterThan(0);
    for (const value of matches) expect(value).toBe(expected);
  });
});
