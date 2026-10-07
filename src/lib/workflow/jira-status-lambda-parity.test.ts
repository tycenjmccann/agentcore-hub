/**
 * TEAM-5375: the Jira Lambda keeps its own cancel vocabulary (it is a separate
 * deploy unit), so this pins it to the hub's: the same cancelled names, the same
 * Won't Do target, and both mappers agreeing on every spelling.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env.EVENTS_TABLE = "agentcore-hub-events";
  process.env.JIRA_SITE_URL = "example.atlassian.net";
  process.env.JIRA_EMAIL = "bot@example.com";
  process.env.JIRA_API_TOKEN = "token";
  process.env.JIRA_PROJECT_KEY = "TEAM";
});

import {
  CANCEL_JIRA_STATUS,
  CANCELLED_STATUS_NAMES,
  isCancelledStatusName,
  mapJiraStatusToInternal,
} from "./jira-status-vocabulary";
import { CANCELLED_JIRA_NAMES, mapStatusToInternal } from "../../../lambda/agentcore-hub-jira/index.mjs";

/** [input, isCancelled, internal] — the same rows as jira-status-vocabulary.test.ts. */
const STATUS_TABLE: Array<[string, boolean, string]> = [
  ["Won't Do", true, "cancelled"],
  ["Wont Do", true, "cancelled"],
  ["won't do", true, "cancelled"],
  ["WON'T DO", true, "cancelled"],
  ["Won’t Do", true, "cancelled"],
  ["Cancelled", true, "cancelled"],
  ["Canceled", true, "cancelled"],
  [" canceled ", true, "cancelled"],
  ["Done", false, "done"],
  ["To Do", false, "todo"],
  ["In Review", false, "in_review"],
];

const jiraTwin = readFileSync(join(__dirname, "..", "..", "..", "lambda", "agentcore-hub-jira", "index.mjs"), "utf8");

describe("Jira Lambda cancel vocabulary == hub vocabulary (TEAM-5375)", () => {
  it("the cancelled names are the same list", () => {
    expect([...CANCELLED_JIRA_NAMES]).toEqual([...CANCELLED_STATUS_NAMES]);
  });

  it("cancelled lands on the same Jira status", () => {
    const table = jiraTwin.slice(jiraTwin.indexOf("const INTERNAL_TO_JIRA = {"));
    expect(table.slice(0, table.indexOf("};"))).toContain(`cancelled: "${CANCEL_JIRA_STATUS}",`);
  });

  it.each(STATUS_TABLE)("%s: both mappers agree (cancelled=%s -> %s)", (name, cancelled, internal) => {
    expect(isCancelledStatusName(name)).toBe(cancelled);
    expect(mapStatusToInternal(name)).toBe(internal);
    expect(mapJiraStatusToInternal(name)).toBe(internal);
  });
});
