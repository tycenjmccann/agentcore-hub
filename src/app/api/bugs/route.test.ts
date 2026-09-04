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
    async searchIssues() {
      return { issues: [] as Array<{ key: string }> };
    }
    async createIssue(fields: Record<string, unknown>) {
      h.createCalls.push(fields);
      return { key: "TEAM-9" };
    }
    async addComment() {
      /* no-op */
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
