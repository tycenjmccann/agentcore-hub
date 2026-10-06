/**
 * TEAM-5358 FR-3: a Won't Do / Cancelled Jira ticket reads as `cancelled`.
 *
 * Every hub-side Jira status map fell back to `todo` (jira-read, ticket-provider-jira)
 * or to the raw name (jira-client), so a cancelled gate read as open work: the
 * board showed it as To Do and close-out counted it as an open child.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { INTERNAL_STATUS_TO_JIRA, mapJiraStatusToInternal } from "./jira-client";

describe("jira-client status map (TEAM-5358 FR-3)", () => {
  it.each(["Won't Do", "won't do", "Wont Do", "Cancelled", "Canceled"])("%s maps to cancelled", (name) => {
    expect(mapJiraStatusToInternal(name)).toBe("cancelled");
  });

  it("cancelled transitions to Won't Do, never Done", () => {
    expect(INTERNAL_STATUS_TO_JIRA.cancelled).toBe("Won't Do");
  });
});

describe("jira-read: Won't Do reads as cancelled, not todo (TEAM-5358 FR-3)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    process.env.JIRA_EMAIL = "bot@example.com";
    process.env.JIRA_API_TOKEN = "token";
    process.env.JIRA_PROJECT_KEY = "TEAM";
    originalFetch = globalThis.fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JIRA_SITE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_PROJECT_KEY;
  });

  it.each([["Won't Do", "cancelled"], ["Cancelled", "cancelled"], ["To Do", "todo"]])("%s -> %s", async (name, want) => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          issues: [{ key: "TEAM-1", fields: { summary: "Merge Approval", status: { name }, issuetype: { name: "Task" }, labels: ["wf:wf_1"] } }],
        }),
        { status: 200 }
      )
    ) as unknown as typeof globalThis.fetch;
    const { getTicketsForWorkflowFromJira } = await import("./jira-read");
    const [t] = await getTicketsForWorkflowFromJira("wf_1");
    expect(t.status).toBe(want);
  });
});
