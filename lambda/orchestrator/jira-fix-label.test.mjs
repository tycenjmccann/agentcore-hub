import { describe, it, expect } from "vitest";
import { mapJiraIssueToTicket } from "./index.mjs";

/**
 * TEAM-4113 (prod-Jira fix) — a fix ticket's origin `kind` rides a `fix:<kind>`
 * label in Jira (createTicket in agentcore-hub-jira; Jira has no arbitrary
 * columns). mapJiraIssueToTicket must reconstruct `spawnedBy` from it so the
 * rework-loop cap + completion open-fix re-verify see fix tickets in Jira mode
 * exactly as they do in DynamoDB mode. Without this, isReworkFix is always
 * false in prod and the cap counts zero rounds forever.
 */

const issue = (labels) => ({
  key: "TEAM-9",
  fields: { summary: "s", status: { name: "Done" }, labels, issuetype: { name: "Task" }, description: null },
});

describe("mapJiraIssueToTicket — fix:<kind> label → spawnedBy", () => {
  it("reconstructs spawnedBy.kind from a fix:qa_fix label", () => {
    const t = mapJiraIssueToTicket(issue(["wf:run1", "agent:agentcore_hub_backend_dev", "fix:qa_fix"]));
    expect(t.spawnedBy).toEqual({ kind: "qa_fix" });
  });

  it("handles review_fix and codex_fix", () => {
    expect(mapJiraIssueToTicket(issue(["fix:review_fix"])).spawnedBy).toEqual({ kind: "review_fix" });
    expect(mapJiraIssueToTicket(issue(["fix:codex_fix"])).spawnedBy).toEqual({ kind: "codex_fix" });
  });

  it("no fix label → no spawnedBy (undefined, not a fix ticket)", () => {
    expect(mapJiraIssueToTicket(issue(["wf:run1", "agent:agentcore_hub_backend_dev"])).spawnedBy).toBeUndefined();
  });

  it("empty labels → no spawnedBy", () => {
    expect(mapJiraIssueToTicket(issue([])).spawnedBy).toBeUndefined();
  });
});
