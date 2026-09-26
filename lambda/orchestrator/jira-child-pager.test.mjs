import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * TEAM-5174 (R3-02) — getChildTicketsFromJira, the orchestrator's ONE Jira child
 * listing (evaluateCompletionSnapshot, the evidence/ship gates, the cascade and
 * the reconcile sweep all read it via getChildTickets).
 *
 * TEAM-5168 made it follow `nextPageToken` while `isLast === false`, but derived
 * the next token as `isLast === false ? nextPageToken : undefined` and returned on
 * a falsy token — so a page that said "more children exist" with no / an empty /
 * a repeated token was handed back as a COMPLETE roster, and an epic could
 * complete early. A throw is this pager's only truncation channel (the 10-page
 * cap already throws), so the token cases must throw too. index.mjs is imported
 * for real; only the AWS SDK constructors it builds at module load are mocked
 * (same seams as gate-creation-blocked.test.mjs), and `fetch` is a page server.
 */

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand { constructor(input) { this.input = input; } }
  class PutCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  };
});
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { return {}; } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

/** `n` bare children of TEAM-1 as /search/jql returns them. */
const childPage = (from, n) => Array.from({ length: n }, (_, i) => ({
  key: `TEAM-${from + i}`,
  fields: { summary: `Child ${from + i}`, status: { name: "To Do" }, labels: [], issuetype: { name: "Task" }, parent: { key: "TEAM-1" } },
}));
const tokenOf = (url) => new URL(String(url)).searchParams.get("nextPageToken");

/** Serves `pages[i]` to the i-th /search/jql request; records every URL. */
function servePages(pages) {
  const urls = [];
  global.fetch = vi.fn(async (url) => {
    urls.push(String(url));
    const body = pages[Math.min(urls.length - 1, pages.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  return urls;
}

const ORIGINAL_FETCH = global.fetch;
let getChildTicketsFromJira;

beforeEach(async () => {
  process.env.TICKET_PROVIDER = "jira";
  process.env.JIRA_SITE_URL = "jira.test";
  process.env.JIRA_EMAIL = "bot@test";
  process.env.JIRA_API_TOKEN = "t";
  vi.resetModules();
  ({ getChildTicketsFromJira } = await import("./index.mjs"));
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.TICKET_PROVIDER;
  delete process.env.JIRA_SITE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
});

describe("getChildTicketsFromJira — TEAM-5174: isLast:false without a usable token is truncated, never complete", () => {
  it("isLast:false with NO nextPageToken throws (a partial roster is never returned as complete)", async () => {
    const urls = servePages([{ issues: childPage(100, 100), isLast: false }]);
    await expect(getChildTicketsFromJira("TEAM-1")).rejects.toThrow(/truncated .*no nextPageToken/);
    expect(urls).toHaveLength(1);
  });

  it("isLast:false with an EMPTY-STRING nextPageToken throws", async () => {
    const urls = servePages([{ issues: childPage(100, 100), isLast: false, nextPageToken: "" }]);
    await expect(getChildTicketsFromJira("TEAM-1")).rejects.toThrow(/truncated/);
    expect(urls).toHaveLength(1);
  });

  it("a REPEATED nextPageToken throws after the second page (no infinite loop, no complete roster)", async () => {
    const urls = servePages([
      { issues: childPage(100, 100), isLast: false, nextPageToken: "p2" },
      { issues: childPage(200, 100), isLast: false, nextPageToken: "p2" },
    ]);
    await expect(getChildTicketsFromJira("TEAM-1")).rejects.toThrow(/truncated .*repeated/);
    expect(urls).toHaveLength(2);
    expect(tokenOf(urls[1])).toBe("p2");
  });
});

describe("getChildTicketsFromJira — TEAM-5168 regression: valid tokens still page", () => {
  it("follows nextPageToken across two pages and returns the 101st child", async () => {
    const urls = servePages([
      { issues: childPage(100, 100), isLast: false, nextPageToken: "p2" },
      { issues: childPage(200, 1), isLast: true },
    ]);
    const children = await getChildTicketsFromJira("TEAM-1");
    expect(urls).toHaveLength(2);
    expect(tokenOf(urls[0])).toBeNull();
    expect(tokenOf(urls[1])).toBe("p2");
    for (const u of urls) {
      const p = new URL(u).searchParams;
      expect(p.get("jql")).toBe("parent = TEAM-1 ORDER BY created ASC");
      expect(p.get("maxResults")).toBe("100");
    }
    expect(children).toHaveLength(101);
    expect(children[100].ticketId).toBe("TEAM-200");
    expect(children[100].parentId).toBe("TEAM-1");
  });

  it("a single page with isLast:true is a complete roster", async () => {
    const urls = servePages([{ issues: childPage(100, 3), isLast: true }]);
    const children = await getChildTicketsFromJira("TEAM-1");
    expect(urls).toHaveLength(1);
    expect(children.map((c) => c.ticketId)).toEqual(["TEAM-100", "TEAM-101", "TEAM-102"]);
  });

  it("a missing isLast is treated as the last page (matches the web-tier pager)", async () => {
    const urls = servePages([{ issues: childPage(100, 2) }]);
    const children = await getChildTicketsFromJira("TEAM-1");
    expect(urls).toHaveLength(1);
    expect(children).toHaveLength(2);
  });

  it("ten pages that all say isLast:false with FRESH tokens still hit the 10-page cap and throw", async () => {
    let n = 0;
    global.fetch = vi.fn(async () => {
      n++;
      const body = { issues: childPage(n * 1000, 100), isLast: false, nextPageToken: `p${n + 1}` };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    await expect(getChildTicketsFromJira("TEAM-1")).rejects.toThrow(/truncated after 10 pages \(1000 tickets\)/);
    expect(n).toBe(10);
  });
});
