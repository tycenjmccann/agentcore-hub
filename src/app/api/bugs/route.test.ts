import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-3911: the /api/bugs kill switch now gates BOTH automated filing shapes.
 *
 * Before: only requests carrying `dedupeLabels` (the crash-rca path) consulted
 * the auto-filing kill switch. The Workflow Manager's new free-form bug carries
 * NO dedupeLabels — it marks itself with `origin: "workflow-manager"` instead —
 * so the switch check is extended to `dedupeLabels.length > 0 || origin === WM`.
 *
 * Invariants this pins (AC-3.1..3.5):
 *   - a WM free-form body (origin only) is suppressed when the switch is off,
 *     and fails CLOSED when the switch read throws;
 *   - when the switch is on it proceeds to createIssue, and `origin` is NEVER
 *     leaked into the Jira labels;
 *   - the crash path (dedupeLabels) still suppresses when off — unchanged;
 *   - a request with NEITHER dedupeLabels NOR origin (human Telegram/UI intake)
 *     never even reads the switch (no wm-config GetCommand) and files directly.
 *
 * Seam-mocked exactly like src/app/api/workflow/start/route.test.ts: the real
 * POST handler runs; the DynamoDB doc client and the JiraClient are stubbed.
 * TICKET_PROVIDER is a module-scope const so it is pinned before the dynamic
 * import in beforeEach (vi.resetModules + import).
 */
const h = vi.hoisted(() => ({
  // "on" (item missing) | "off" | "throw" (DDB blip → fail closed)
  killSwitch: "on" as "on" | "off" | "throw",
  sends: [] as Array<{ name: string; input: unknown }>,
  createCalls: [] as Array<Record<string, unknown>>,
  // Every searchIssues(jql, ...) the handler runs, in order (sig, mute, family).
  searchCalls: [] as Array<{ jql: string; fields: unknown; max: unknown }>,
  // Queued searchIssues results (shifted per call); default is no hits.
  searchQueue: [] as Array<{ issues: Array<{ key: string }> }>,
  commentCalls: [] as Array<{ key: string; author: string; content: string }>,
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: unknown) {}
  }
  class PutCommand {
    constructor(public input: unknown) {}
  }
  class DeleteCommand {
    constructor(public input: unknown) {}
  }
  return {
    GetCommand,
    PutCommand,
    DeleteCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: { constructor: { name: string }; input: unknown }) {
          const name = cmd.constructor.name;
          h.sends.push({ name, input: cmd.input });
          if (name === "GetCommand") {
            if (h.killSwitch === "throw") throw new Error("ddb blip");
            if (h.killSwitch === "off") return { Item: { detail: { value: "off" } } };
            return {}; // missing item = enabled
          }
          return {}; // PutCommand (lock acquire) / DeleteCommand (release)
        },
      }),
    },
  };
});

vi.mock("@/lib/workflow/jira-client", () => {
  class JiraClient {
    static fromEnv() {
      return new JiraClient();
    }
    async searchIssues(jql: string, fields: unknown, max: unknown) {
      h.searchCalls.push({ jql, fields, max });
      return h.searchQueue.shift() ?? { issues: [] as Array<{ key: string }> };
    }
    async createIssue(fields: Record<string, unknown>) {
      h.createCalls.push(fields);
      return { key: "TEAM-9" };
    }
    async addComment(key: string, author: string, content: string) {
      h.commentCalls.push({ key, author, content });
    }
  }
  return { JiraClient };
});

let POST: typeof import("./route").POST;

const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  h.killSwitch = "on";
  h.sends.length = 0;
  h.createCalls.length = 0;
  h.searchCalls.length = 0;
  h.searchQueue.length = 0;
  h.commentCalls.length = 0;
  for (const k of ["TICKET_PROVIDER", "GITHUB_OWNER", "GITHUB_REPO", "JIRA_PROJECT_KEY"]) {
    saved[k] = process.env[k];
  }
  // Module-scope consts read at import time — pin before the dynamic import.
  process.env.TICKET_PROVIDER = "jira";
  process.env.JIRA_PROJECT_KEY = "TEAM";
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/bugs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

const getSends = () => h.sends.filter((s) => s.name === "GetCommand");

describe("POST /api/bugs — kill switch gates WM free-form + crash filings (TEAM-3911)", () => {
  it("AC-3.1: switch off + free-form WM body (origin, no dedupeLabels) → suppressed, no createIssue", async () => {
    h.killSwitch = "off";
    const res = await post({
      title: "T",
      description: "D",
      repo: "owner/name",
      origin: "workflow-manager",
    });
    const json = await res.json();
    expect(json.suppressed).toBe(true);
    expect(h.createCalls.length).toBe(0);
    // The switch WAS consulted for the origin-marked filing.
    expect(getSends().length).toBe(1);
  });

  it("AC-3.2: switch read throws → free-form WM body fails closed (suppressed)", async () => {
    h.killSwitch = "throw";
    const res = await post({
      title: "T",
      description: "D",
      repo: "owner/name",
      origin: "workflow-manager",
    });
    const json = await res.json();
    expect(json.suppressed).toBe(true);
    expect(json.reason).toMatch(/fails closed/i);
    expect(h.createCalls.length).toBe(0);
  });

  it("AC-3.3: switch on → free-form WM body proceeds; labels carry repo: and NOT origin", async () => {
    h.killSwitch = "on"; // item missing = enabled
    const res = await post({
      title: "T",
      description: "D",
      repo: "owner/name",
      origin: "workflow-manager",
    });
    const json = await res.json();
    expect(json.ticketId).toBe("TEAM-9");
    expect(json.deduped).toBe(false);
    expect(h.createCalls.length).toBe(1);
    const labels = h.createCalls[0].labels as string[];
    expect(labels).toContain("repo:owner/name");
    expect(labels).not.toContain("origin");
    expect(labels).not.toContain("workflow-manager");
    expect(labels.some((l) => l.includes("origin"))).toBe(false);
  });

  it("AC-3.4: crash path (dedupeLabels) + switch off → suppressed (unchanged behavior)", async () => {
    h.killSwitch = "off";
    const res = await post({
      title: "T",
      description: "D",
      repo: "owner/name",
      labels: ["crash-rca", "agent:persona_x"],
      dedupeLabels: ["crash-rca", "agent:persona_x"],
    });
    const json = await res.json();
    expect(json.suppressed).toBe(true);
    expect(h.createCalls.length).toBe(0);
  });

  it("AC-3.5: neither dedupeLabels nor origin → switch NOT consulted, createIssue called", async () => {
    // A human-relayed bug (Telegram/UI). Even if the switch were off it must file.
    h.killSwitch = "off";
    const res = await post({ title: "T", description: "D", repo: "owner/name" });
    const json = await res.json();
    expect(json.ticketId).toBe("TEAM-9");
    expect(h.createCalls.length).toBe(1);
    // The wm-config GetCommand is never sent for a non-WM filing.
    expect(getSends().length).toBe(0);
  });
});

describe("POST /api/bugs — dedupeLabels are space-filtered + JQL-escaped (TEAM-3920)", () => {
  // The exact signature query the handler builds for the given (already
  // space-filtered) label list under the pinned project key "TEAM".
  const sigJql = (labelClauses: string[]) =>
    `project = "TEAM" AND issuetype = Bug AND statusCategory != Done AND ` +
    labelClauses.map((l) => `labels = "${l}"`).join(" AND ") +
    " ORDER BY created DESC";

  it("a dedupe label containing a space is dropped and never reaches the JQL", async () => {
    const res = await post({
      title: "T",
      description: "D",
      repo: "owner/name",
      labels: ["crash-rca", "agent:foo bar"],
      dedupeLabels: ["crash-rca", "agent:foo bar"],
    });
    // No open bug exists (default empty results) → the filing proceeds normally.
    expect(res.status).toBe(200);
    expect(h.createCalls.length).toBe(1);
    // The spaced label is filtered out; only the well-formed one is queried.
    expect(h.searchCalls.length).toBeGreaterThan(0);
    const jql = h.searchCalls[0].jql;
    expect(jql).toBe(sigJql(["crash-rca"]));
    expect(jql).not.toContain("foo bar");
  });

  it("a dedupe label containing a double quote is escaped into well-formed JQL", async () => {
    await post({
      title: "T",
      description: "D",
      repo: "owner/name",
      labels: ["crash-rca"],
      dedupeLabels: ['crash-rca', 'agent:"pwn'],
    });
    const jql = h.searchCalls[0].jql;
    // The `"` is escaped as `\"` so the label stays inside its string literal.
    expect(jql).toContain('labels = "agent:\\"pwn"');
    expect(jql).toBe(sigJql(["crash-rca", 'agent:\\"pwn']));
    // Well-formed: every double quote is either the opening/closing of a literal
    // or backslash-escaped — no odd unescaped quote breaks out of the string.
    const unescapedQuotes = (jql.match(/(?<!\\)"/g) || []).length;
    expect(unescapedQuotes % 2).toBe(0);
  });

  it("well-formed labels produce the exact sigJql and dedupe behavior is unchanged", async () => {
    const labels = ["crash-rca", "agent:agentcore_hub_qa_verifier"];
    // An open bug already carries this signature → the report dedupes onto it.
    h.searchQueue.push({ issues: [{ key: "TEAM-5" }] });
    const res = await post({
      title: "Verifier crashed again",
      description: "RCA body",
      repo: "owner/name",
      labels,
      dedupeLabels: labels,
    });
    const json = await res.json();
    // Exact JQL for the well-formed crash signature (regression guard).
    expect(h.searchCalls[0].jql).toBe(sigJql(labels));
    // Unchanged dedupe: absorbed as a comment on the existing open bug, no new ticket.
    expect(json).toEqual({ ticketId: "TEAM-5", deduped: true });
    expect(h.commentCalls.length).toBe(1);
    expect(h.commentCalls[0].key).toBe("TEAM-5");
    expect(h.createCalls.length).toBe(0);
  });
});
