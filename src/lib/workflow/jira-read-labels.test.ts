/**
 * TEAM-4706 (DL-029): Jira labels must reach the wire.
 *
 * Consumers classify a human gate ticket by its labels — the Telegram bridge's
 * gateTicketOf() reads GET /api/workflow/{id}/tickets and has to tell a
 * `gate:deploy-approval` gate from a plain `gate:approval` one. DynamoDB mode
 * already returns `labels` on the row; jira-read's mapIssueToTicket read the
 * labels locally (agent:/reviewer:/wf: prefixes) but dropped them from the
 * response, so in TICKET_PROVIDER=jira mode — what production runs — the
 * classification was impossible without a second Jira call.
 *
 * mapIssueToTicket is module-private, so these drive it through the exported
 * getTicketsForWorkflowFromJira with fetch stubbed. jira-read.ts reads its
 * JIRA_* env at module top level, hence resetModules + dynamic import.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const WORKFLOW_ID = "wf_1";
const LABELS = [
  "wf:wf_1",
  "gate:approval",
  "gate:deploy-approval",
  "pipeline:hub-foo-deploy",
  "exec:11111111-2222-3333-4444-555555555555",
];

/** A minimal /rest/api/3/search/jql body carrying exactly one issue. */
function searchPayload(fields: Record<string, unknown>) {
  return { issues: [{ key: "TEAM-1", fields }] };
}

describe("mapIssueToTicket — labels on the wire (TEAM-4706)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

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

  function stubSearch(fields: Record<string, unknown>) {
    fetchMock = vi.fn(async () => new Response(JSON.stringify(searchPayload(fields)), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  }

  it("surfaces a labelled issue's labels verbatim", async () => {
    stubSearch({
      summary: "Merge Approval: deploy hub-foo",
      status: { name: "Blocked" },
      issuetype: { name: "Task" },
      labels: LABELS,
      created: "2026-09-16T00:00:00.000Z",
      updated: "2026-09-16T01:00:00.000Z",
    });

    const { getTicketsForWorkflowFromJira } = await import("./jira-read");
    const tickets = await getTicketsForWorkflowFromJira(WORKFLOW_ID);

    expect(tickets).toHaveLength(1);
    expect(tickets[0].labels).toEqual(LABELS);
    // Verbatim: no filtering of the prefixes the mapper consumes locally.
    expect(tickets[0].labels).toContain("gate:deploy-approval");
    // No parent on the issue => no epic follow-up fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns [] when the issue has no labels field, and the rest of the shape is unchanged", async () => {
    stubSearch({
      summary: "Requirements analysis",
      status: { name: "In Progress" },
      issuetype: { name: "Task" },
      created: "2026-09-16T00:00:00.000Z",
      updated: "2026-09-16T01:00:00.000Z",
    });

    const { getTicketsForWorkflowFromJira } = await import("./jira-read");
    const tickets = await getTicketsForWorkflowFromJira(WORKFLOW_ID);

    expect(tickets).toHaveLength(1);
    expect(tickets[0].labels).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // `labels` is purely additive — every pre-existing key still reads as before.
    expect(Object.keys(tickets[0]).sort()).toEqual(
      [
        "assignee",
        "blockedBy",
        "createdAt",
        "description",
        "labels",
        "parentId",
        "status",
        "ticketId",
        "title",
        "type",
        "updatedAt",
        "workflowId",
      ].sort()
    );
    expect(tickets[0]).toMatchObject({
      ticketId: "TEAM-1",
      title: "Requirements analysis",
      description: "",
      status: "in_progress",
      assignee: undefined,
      parentId: undefined,
      blockedBy: "",
      workflowId: undefined,
      type: "task",
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T01:00:00.000Z",
    });
  });
});
