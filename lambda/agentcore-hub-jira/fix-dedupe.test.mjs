import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4100 F5 — create-time (workflow, findingId) uniqueness for fix tickets,
 * JIRA twin. Parity partner of lambda/agentcore-hub-tickets/fix-dedupe.test.mjs.
 *
 * Jira has NO conditional create and no DynamoDB, so this twin cannot be atomic
 * the way the DynamoDB one is. The guarantee it DOES provide: a deterministic
 * `finding:<fid>` label + search-before-create makes any RETRY / replay / late
 * second reporter converge on the one existing ticket instead of minting a
 * duplicate (the fuzzy-summary idempotency guard missed these). A truly
 * simultaneous sub-second race can still double-create under Jira's
 * eventually-consistent search index — a documented Jira limitation, called out
 * in createTicket. This test pins the convergence guarantee and the label; the
 * atomic concurrency contract is asserted only against the DynamoDB twin.
 *
 * Harness: real handler over a stubbed global fetch (jiraFetch's only seam) that
 * models a tiny in-memory Jira — POST creates, search/jql matches on labels +
 * summary — plus the S3 roster read mocked to the fallback roster.
 */

const h = vi.hoisted(() => ({
  state: {
    /** in-memory Jira issues: { key, fields: { summary, status, labels } }. */
    issues: /** @type {any[]} */ ([]),
    /** every `${method} ${path}` the handler issued. */
    calls: /** @type {string[]} */ ([]),
    counter: 0,
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { throw new Error("NoSuchKey"); } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));

let handler;

const WF = "wf_dedupe";
const FID = "abc123def456";
const ASSIGNEE = "agentcore_hub_backend_dev";
const create = (parameters) => handler({ tool_name: "Tickets___create_ticket", parameters });
const fixParams = (over = {}) => ({
  summary: "Fix (auth): null check",
  description: "d",
  assignee: ASSIGNEE,
  blocked_by: ["TEAM-9"],
  workflow_id: WF,
  spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-9", findingId: FID },
  ...over,
});

const createPosts = () => h.state.calls.filter((c) => c === "POST /rest/api/3/issue");
const findingLabelOf = (key) => (h.state.issues.find((i) => i.key === key)?.fields.labels || []);

beforeEach(async () => {
  h.state.issues.length = 0;
  h.state.calls.length = 0;
  h.state.counter = 0;
  process.env.JIRA_SITE_URL = "example.atlassian.net";
  process.env.JIRA_EMAIL = "bot@example.com";
  process.env.JIRA_API_TOKEN = "token";
  process.env.JIRA_PROJECT_KEY = "TEAM";
  delete process.env.ARTIFACT_BUCKET;

  vi.stubGlobal("fetch", async (url, options = {}) => {
    const s = h.state;
    const full = String(url);
    const path = full.replace(/^https:\/\/[^/]+/, "");
    const method = options.method || "GET";
    s.calls.push(`${method} ${path.split("?")[0]}`);
    let body = {};

    if (method === "POST" && path === "/rest/api/3/issue") {
      const fields = JSON.parse(options.body).fields;
      const key = `TEAM-${++s.counter}`;
      s.issues.push({
        key,
        fields: {
          summary: fields.summary,
          status: { name: "To Do" },
          labels: fields.labels || [],
          issuetype: fields.issuetype || { name: "Task" },
        },
      });
      body = { key };
    } else if (method === "GET" && path.includes("/search/jql")) {
      const jql = new URL(full).searchParams.get("jql") || "";
      const labelFilters = [...jql.matchAll(/labels = "([^"]+)"/g)].map((m) => m[1]);
      const sumM = jql.match(/summary ~ "(.*?)" ORDER/);
      const wantSummary = sumM ? sumM[1].replace(/\\?"/g, "").trim().toLowerCase() : null;
      const matched = s.issues.filter((iss) => {
        const labs = iss.fields.labels || [];
        if (!labelFilters.every((l) => labs.includes(l))) return false;
        if (wantSummary && !(iss.fields.summary || "").toLowerCase().includes(wantSummary)) return false;
        return true;
      });
      body = { issues: matched };
    } else if (method === "GET" && path.endsWith("/transitions")) {
      body = { transitions: [
        { id: "31", name: "Blocked", to: { name: "Blocked" } },
        { id: "41", name: "Ready", to: { name: "Ready" } },
      ] };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });

  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("create_ticket — F5 fix-ticket dedupe (Jira, deterministic finding label)", () => {
  it("stamps a deterministic finding:<fid> label so retries can converge", async () => {
    const res = await create(fixParams());
    expect(findingLabelOf(res.ticketId)).toContain(`finding:${FID}`);
    expect(findingLabelOf(res.ticketId)).toContain(`wf:${WF}`);
  });

  it("a later create for the same finding dedupes to the existing key, no second issue", async () => {
    const first = await create(fixParams());
    expect(createPosts()).toHaveLength(1);

    const second = await create(fixParams());
    expect(second.deduped).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(second.ticketId).toBe(first.ticketId); // same key
    expect(createPosts()).toHaveLength(1); // still ONE real create
  });

  it("a finding whose only ticket is already Done is NOT treated as a live duplicate", async () => {
    const first = await create(fixParams());
    // Close it out.
    h.state.issues.find((i) => i.key === first.ticketId).fields.status = { name: "Done" };

    const second = await create(fixParams());
    expect(second.deduped).toBeUndefined();
    expect(createPosts()).toHaveLength(2); // a fresh fix ticket is created
  });

  it("a create with no findingId writes no finding label and always creates", async () => {
    const res = await create(fixParams({ spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-9" }, summary: "Fix (no-finding): x" }));
    expect(findingLabelOf(res.ticketId).some((l) => l.startsWith("finding:"))).toBe(false);
    expect(createPosts()).toHaveLength(1);
  });

  it("different findings in the same workflow are independent", async () => {
    await create(fixParams({ spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-9", findingId: "finding-1" }, summary: "Fix (auth): a" }));
    await create(fixParams({ spawned_by: { kind: "qa_fix", qaTicketId: "TEAM-9", findingId: "finding-2" }, summary: "Fix (db): b" }));
    expect(createPosts()).toHaveLength(2);
  });
});
