/**
 * TEAM-4537: Jira hard-caps issue summary at 255 chars. wf_1789190697687_fxrs67
 * / epic TEAM-4518 died at intake with a Jira 400 "Summary can't exceed 255
 * characters" — the auto-generated intake-ticket title (`Intake: <analyst> —
 * <title>`) exceeded the cap even though the epic's own title had fit.
 *
 * This provider talks to Jira REST directly (src/app/api/workflow/start/route.ts
 * → startWithJira → JiraCloudProvider), bypassing the ticket-tools Lambdas —
 * so it needs its own clamp, independent of the two Lambda copies.
 *
 * EXPECTED_CLAMPED_LONG_TITLE is pinned to the SAME literal as the two Lambda
 * index.test.mjs files for the SAME LONG_TITLE input, so a drift in any of the
 * three clampSummary() copies fails a test instead of silently diverging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const LONG_TITLE = "A".repeat(200) + " " + "B".repeat(200); // 401 chars, one space near the middle
const LONG_DESCRIPTION = "The full text must survive in the description even though the title is long.";
const EXPECTED_CLAMPED_LONG_TITLE = "A".repeat(200) + "…";

type Post = { url: string; fields: Record<string, unknown> };

function mockFetch(posts: Post[]) {
  return vi.fn(async (url: string | URL, options: RequestInit = {}) => {
    const method = options.method || "GET";
    const u = String(url);
    if (method === "POST" && u.endsWith("/rest/api/3/issue")) {
      const fields = JSON.parse(String(options.body)).fields as Record<string, unknown>;
      posts.push({ url: u, fields });
      return new Response(JSON.stringify({ key: "TEAM-999" }), { status: 201 });
    }
    // The createEpic/createTicket follow-up getIssue GET.
    const lastFields = posts[posts.length - 1]?.fields;
    return new Response(
      JSON.stringify({
        key: "TEAM-999",
        fields: {
          summary: lastFields?.summary,
          status: { name: "To Do" },
          issuetype: { name: "Task" },
          labels: [],
        },
      }),
      { status: 200 }
    );
  });
}

describe("JiraCloudProvider — summary clamp (TEAM-4537)", () => {
  let originalFetch: typeof globalThis.fetch;
  let posts: Post[];

  beforeEach(() => {
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    process.env.JIRA_EMAIL = "bot@example.com";
    process.env.JIRA_API_TOKEN = "token";
    process.env.JIRA_PROJECT_KEY = "TEAM";
    posts = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(posts) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JIRA_SITE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_PROJECT_KEY;
  });

  it("createEpic clamps a >255-char title to <=255 chars, description kept in full", async () => {
    const { JiraCloudProvider } = await import("./ticket-provider-jira");
    const jira = new JiraCloudProvider();

    await jira.createEpic({ title: LONG_TITLE, description: LONG_DESCRIPTION });

    expect(posts.length).toBe(1);
    const summary = posts[0].fields.summary as string;
    expect(summary.length).toBeLessThanOrEqual(255);
    expect(summary).toBe(EXPECTED_CLAMPED_LONG_TITLE);
    const description = posts[0].fields.description as { content: Array<{ content: Array<{ text: string }> }> };
    expect(description.content[0].content[0].text).toBe(LONG_DESCRIPTION);
  });

  it("createTicket clamps a >255-char title to <=255 chars, description kept in full", async () => {
    const { JiraCloudProvider } = await import("./ticket-provider-jira");
    const jira = new JiraCloudProvider();

    await jira.createTicket({
      parentId: "TEAM-1",
      title: LONG_TITLE,
      description: LONG_DESCRIPTION,
      assignee: "agentcore_hub_requirements_analyst",
    });

    expect(posts.length).toBe(1);
    const summary = posts[0].fields.summary as string;
    expect(summary.length).toBeLessThanOrEqual(255);
    expect(summary).toBe(EXPECTED_CLAMPED_LONG_TITLE);
    const description = posts[0].fields.description as { content: Array<{ content: Array<{ text: string }> }> };
    expect(description.content[0].content[0].text).toBe(LONG_DESCRIPTION);
  });
});
