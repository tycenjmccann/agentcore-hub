/**
 * TEAM-5358 FR-3: a Won't Do / Cancelled Jira ticket reads as `cancelled`.
 *
 * Every hub-side Jira status map fell back to `todo` (jira-read, ticket-provider-jira)
 * or to the raw name (jira-client), so a cancelled gate read as open work: the
 * board showed it as To Do and close-out counted it as an open child.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { INTERNAL_STATUS_TO_JIRA, JiraClient, mapJiraStatusToInternal } from "./jira-client";
import { CancelStatusMissingError } from "./jira-status-vocabulary";

describe("jira-client status map (TEAM-5358 FR-3)", () => {
  it.each(["Won't Do", "won't do", "Wont Do", "WON'T DO", "Won’t Do", "Cancelled", "Canceled"])("%s maps to cancelled", (name) => {
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

  it.each([
    ["Won't Do", "cancelled"],
    ["Wont Do", "cancelled"],
    ["WON'T DO", "cancelled"],
    ["Won’t Do", "cancelled"],
    ["Cancelled", "cancelled"],
    ["To Do", "todo"],
    ["Ready", "ready"],
  ])("%s -> %s", async (name, want) => {
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

// ─── TEAM-5375: every picker takes a cancel by destination only ─────────────────

type Transition = { id: string; name: string; to: { name: string; id?: string } };

/** GET /transitions offers `transitions`; GET issue answers `status`; every POST is recorded. */
function stubJira(transitions: Transition[], status = "To Do") {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const method = (init.method || "GET").toUpperCase();
    if (method === "POST") {
      posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : {} });
      if (path.endsWith("/rest/api/3/issue")) return new Response(JSON.stringify({ key: "TEAM-7" }), { status: 201 });
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/transitions")) return new Response(JSON.stringify({ transitions }), { status: 200 });
    return new Response(
      JSON.stringify({ key: "TEAM-7", fields: { summary: "Epic", status: { name: status }, issuetype: { name: "Epic" }, labels: [] } }),
      { status: 200 }
    );
  }) as unknown as typeof globalThis.fetch;
  return posts;
}

const transitionPosts = (posts: Array<{ path: string; body: Record<string, unknown> }>) =>
  posts.filter((p) => p.path.endsWith("/transitions")).map((p) => (p.body.transition as { id: string }).id);

const CANCEL_TO_DONE: Transition[] = [{ id: "41", name: "Cancel", to: { name: "Done", id: "3" } }];
const DECOY_THEN_WONT_DO: Transition[] = [
  { id: "41", name: "Cancel", to: { name: "Done", id: "3" } },
  { id: "51", name: "Close", to: { name: "Won't Do", id: "9" } },
];

describe("JiraClient.transitionIssue: cancel by destination only (TEAM-5375)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const client = () => new JiraClient({ siteUrl: "example.atlassian.net", email: "bot@example.com", apiToken: "token" });

  it.each([
    ["transitionIssue(Won't Do)", (c: JiraClient) => c.transitionIssue("TEAM-7", "Won't Do")],
    ["transitionToInternalStatus(cancelled)", (c: JiraClient) => c.transitionToInternalStatus("TEAM-7", "cancelled")],
  ])('%s refuses a "Cancel" -> Done transition with cancel_status_missing', async (_label, run) => {
    const posts = stubJira(CANCEL_TO_DONE);
    const err = await run(client()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelStatusMissingError);
    expect((err as CancelStatusMissingError).code).toBe("cancel_status_missing");
    expect(transitionPosts(posts)).toEqual([]);
  });

  it("takes the Won't Do destination past a Done-bound decoy", async () => {
    const posts = stubJira(DECOY_THEN_WONT_DO);
    await client().transitionToInternalStatus("TEAM-7", "cancelled");
    expect(transitionPosts(posts)).toEqual(["51"]);
  });

  it("a non-cancel target still matches by transition name (unchanged)", async () => {
    const posts = stubJira([{ id: "21", name: "Ready", to: { name: "Selected", id: "2" } }]);
    await client().transitionIssue("TEAM-7", "Ready");
    expect(transitionPosts(posts)).toEqual(["21"]);
  });
});

describe("JiraCloudProvider: Wont Do reads cancelled; cancel by destination only (TEAM-5375)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    process.env.JIRA_SITE_URL = "example.atlassian.net";
    process.env.JIRA_EMAIL = "bot@example.com";
    process.env.JIRA_API_TOKEN = "token";
    process.env.JIRA_PROJECT_KEY = "TEAM";
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JIRA_SITE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_PROJECT_KEY;
  });

  it.each([
    ["Wont Do", "cancelled"],
    ["WON'T DO", "cancelled"],
    ["Won't Do", "cancelled"],
    ["Canceled", "cancelled"],
    ["To Do", "todo"],
    ["In Review", "in_review"],
  ])("a %s issue reads as %s", async (name, want) => {
    stubJira([], name);
    const { JiraCloudProvider } = await import("./ticket-provider-jira");
    const epic = await new JiraCloudProvider().createEpic({ title: "Epic", description: "d" });
    expect(epic.status).toBe(want);
  });

  it('transitionTo(Won\'t Do) refuses a "Cancel" -> Done transition with cancel_status_missing', async () => {
    const posts = stubJira(CANCEL_TO_DONE);
    const { JiraCloudProvider } = await import("./ticket-provider-jira");
    const err = await new JiraCloudProvider().transitionTo("TEAM-7", "Won't Do").catch((e: unknown) => e);
    // Matched by shape: the dynamic import above may hold its own copy of the module.
    expect(err).toMatchObject({ name: "CancelStatusMissingError", code: "cancel_status_missing", issueKey: "TEAM-7" });
    expect(transitionPosts(posts)).toEqual([]);
  });

  it("transitionTo(Won't Do) takes the Won't Do destination past a Done-bound decoy", async () => {
    const posts = stubJira(DECOY_THEN_WONT_DO);
    const { JiraCloudProvider } = await import("./ticket-provider-jira");
    await new JiraCloudProvider().transitionTo("TEAM-7", "Won't Do");
    expect(transitionPosts(posts)).toEqual(["51"]);
  });

  it("transitionTo(Ready) still matches by transition name (unchanged)", async () => {
    const posts = stubJira([{ id: "21", name: "Ready", to: { name: "Selected" } }]);
    const { JiraCloudProvider } = await import("./ticket-provider-jira");
    await new JiraCloudProvider().transitionTo("TEAM-7", "Ready");
    expect(transitionPosts(posts)).toEqual(["21"]);
  });
});
