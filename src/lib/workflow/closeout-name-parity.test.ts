import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNIVERSAL_DECISION_OPTIONS as universalTs } from "./decision-contract";
import { UNIVERSAL_DECISION_OPTIONS as universalGrammar } from "./decision-grammar";
import { JIRA_STATUS_TO_INTERNAL, INTERNAL_STATUS_TO_JIRA, mapJiraStatusToInternal } from "./jira-client";
import { functionSource as fn, entrySource } from "./twin-source";
// The four .mjs decision-contract copies. Each Lambda packs its own copy, so a
// drift means one surface admits `stopped` where another refuses it.
import { UNIVERSAL_DECISION_OPTIONS as universalTickets } from "../../../lambda/agentcore-hub-tickets/decision-contract.mjs";
import { UNIVERSAL_DECISION_OPTIONS as universalJira } from "../../../lambda/agentcore-hub-jira/decision-contract.mjs";
import { UNIVERSAL_DECISION_OPTIONS as universalOutput } from "../../../lambda/workflow-output/decision-contract.mjs";
import { UNIVERSAL_DECISION_OPTIONS as universalBridge } from "../../../deploy/telegram-bug-intake/decision-contract.mjs";

/**
 * TEAM-5358 close-out name parity. The close-out levers (cancel, stop, transition,
 * the follow-up move) cross four codebases by NAME: the hub routes send wire keys,
 * the two ticket twins read them, and every reader of a ticket's status has to know
 * the `cancelled` id. Nothing type-checks across that boundary, so one renamed key
 * or one missing map entry is a silent no-op on one backend — a Won't Do ticket that
 * reads as open `todo`, or a stop whose note never reaches the decision record.
 *
 * The twins are pinned by source (they read module-level env at import and the Jira
 * twin's own suite is node:test), the hub by its exported maps where it has them.
 */

const REPO = join(__dirname, "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");

const ticketsTwin = read("lambda", "agentcore-hub-tickets", "index.mjs");
const jiraTwin = read("lambda", "agentcore-hub-jira", "index.mjs");
const gateContract = read("lambda", "agentcore-hub-tickets", "gate-contract.mjs");
const jiraRead = read("src", "lib", "workflow", "jira-read.ts");
const transitionRoute = read("src", "app", "api", "workflow", "[id]", "tickets", "transition", "route.ts");
const stopRoute = read("src", "app", "api", "workflow", "[id]", "stop", "route.ts");
const cancelRun = read("src", "lib", "workflow", "cancel-run.ts");
const ticketProviderJira = read("src", "lib", "workflow", "ticket-provider-jira.ts");
const jiraClient = read("src", "lib", "workflow", "jira-client.ts");
const workflowWebhook = read("src", "app", "api", "workflow", "webhook", "route.ts");

/** The object literal of the first `invokeTicketTool("<tool>", {…})` call after `from`. */
function payload(src: string, tool: string): string {
  const at = src.indexOf(`invokeTicketTool("${tool}"`);
  expect(at, `${tool} is not invoked — the extractor is stale`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf("});", at));
}

describe("closeout name parity — the cancelled status id (TEAM-5358 FR-3)", () => {
  it("the tickets twin has a terminal cancelled state and a cancel transition from every open state", () => {
    const table = ticketsTwin.slice(ticketsTwin.indexOf("const TRANSITIONS = {"));
    const body = table.slice(0, table.indexOf("\n};"));
    expect(body).toMatch(/\n  cancelled: \[\],/);
    for (const from of ["todo", "ready", "in_progress", "in_review", "blocked"]) {
      const row = body.slice(body.indexOf(`\n  ${from}: [`), body.indexOf("],", body.indexOf(`\n  ${from}: [`)));
      expect(row, `${from} has no cancel transition`).toMatch(/\{ id: "cancel", name: "Cancel", to: "cancelled" \}/);
    }
    const done = body.slice(body.indexOf("\n  done: ["), body.indexOf("],", body.indexOf("\n  done: [")));
    expect(done, "done must not reach cancelled").not.toMatch(/cancelled/);
  });

  it("the Jira twin maps cancelled to Won't Do and reads every spelling back as cancelled", () => {
    expect(jiraTwin).toMatch(/const INTERNAL_TO_JIRA = \{[^}]*\bcancelled: "Won't Do",/);
    expect(jiraTwin).toMatch(/const CANCELLED_JIRA_NAMES = \["won't do", "wont do", "cancelled", "canceled"\];/);
  });

  it("the hub's Jira maps agree with the twin: Won't Do reads cancelled, never todo", () => {
    expect(INTERNAL_STATUS_TO_JIRA.cancelled).toBe("Won't Do");
    for (const s of ["Won't Do", "wont do", "Cancelled", "canceled"]) {
      expect(mapJiraStatusToInternal(s), s).toBe("cancelled");
      expect(JIRA_STATUS_TO_INTERNAL[s.toLowerCase()], s).toBe("cancelled");
    }
    // TEAM-5375: the hub readers take the vocabulary from one module and hold no
    // cancel-name copy of their own (a copy is what let "Wont Do" read as todo).
    for (const [file, src] of [
      ["jira-read.ts", jiraRead],
      ["ticket-provider-jira.ts", ticketProviderJira],
      ["webhook/route.ts", workflowWebhook],
      ["jira-client.ts", jiraClient],
      ["cancel-run.ts", cancelRun],
    ] as const) {
      expect(src, `${file} does not use jira-status-vocabulary`).toMatch(/from "(?:\.\/|@\/lib\/workflow\/)jira-status-vocabulary"/);
      expect(src, `${file} keeps its own cancel-name map entry`).not.toMatch(/"(?:won'?t do|cancell?ed)":\s*"cancelled"/i);
      expect(src, `${file} keeps its own cancel-name list`).not.toMatch(/\[\s*"won'?t do"/i);
    }
  });

  it("the transition route accepts cancelled as a target, and not from done", () => {
    expect(transitionRoute).toMatch(/const VALID_STATUSES = \[[^\]]*"cancelled"[^\]]*\]/);
    const table = transitionRoute.slice(transitionRoute.indexOf("const VALID_TRANSITIONS"));
    const body = table.slice(0, table.indexOf("};"));
    for (const from of ["ready", "in_review", "blocked"]) {
      expect(body, `${from} cannot reach cancelled`).toMatch(new RegExp(`\\b${from}: \\[[^\\]]*"cancelled"`));
    }
    expect(body).not.toMatch(/\bdone: \[[^\]]*"cancelled"/);
    expect(body).not.toMatch(/\bcancelled: \[/);
  });
});

describe("closeout name parity — the wire names (TEAM-5358 FR-5/FR-7/FR-8)", () => {
  it("transition: reason and note are read by both twins, and the whole args reach the decision path", () => {
    const ddb = fn(ticketsTwin, "transitionIssue");
    // TEAM-5408 wrapped the Jira twin's transitionTicket in a TerminalStatusRefusal
    // catch; the real reads are in the body it delegates to unchanged
    // (transitionTicketUnguarded). entrySource follows that one hop and fails
    // closed if the forward ever stops being a bare, unmodified parameter pass.
    const jiraEntry = entrySource(jiraTwin, "transitionTicket");
    const jira = jiraEntry.body;
    expect(ddb).toMatch(/\bargs\.reason\b/);
    expect(ddb).toMatch(/\bargs\.note\b/);
    expect(jira).toMatch(/const \{[^}]*\breason\b[^}]*\bnote\b[^}]*\} = params;/);
    // decision / decision_token are read once, in the shared gate-contract, from
    // the args each twin hands it whole.
    expect(ddb).toMatch(/gateConditionCleared\(issueKey, current\.Item, \{ transition, args, target: transition\.to \}\)/);
    expect(jira).toMatch(/gateConditionCleared\([^)]*\bargs: params\b/);
    expect(gateContract).toMatch(/\bargs\.decision_token\b/);
    expect(gateContract).toMatch(/\bargs\.decision\b/);
    // Pin the delegation shape itself: a drift here is exactly what would make
    // the checks above start reading the wrapper instead of the real body again.
    expect(jiraEntry.chain).toEqual(["transitionTicket", "transitionTicketUnguarded"]);
    expect(jiraEntry.entry).toMatch(/TerminalStatusRefusal\) return err\.terminalRefusal/);
  });

  it("the hub sends exactly those names on a decided transition and on a stop", () => {
    for (const [label, src] of [["transition route", transitionRoute], ["stop route", stopRoute]] as const) {
      for (const key of ["reason", "decision", "decision_token", "note"]) {
        expect(src, `${label} no longer sends ${key}`).toMatch(new RegExp(`\\b${key}\\b\\s*[:,]`));
      }
    }
    const stop = payload(stopRoute, "Tickets___transition_ticket");
    for (const key of ["ticket_id", "transition_id", "reason", "decision", "decision_token", "note"]) {
      expect(stop, `stop's gate close no longer sends ${key}`).toMatch(new RegExp(`\\b${key}\\b`));
    }
    expect(stop).toMatch(/transition_id: "cancelled"/);
  });

  it("the follow-up move's parent is read under the same two spellings by both twins", () => {
    expect(payload(cancelRun, "Tickets___update_ticket")).toMatch(/\bparent: postRunEpicKey\b/);
    expect(fn(ticketsTwin, "editIssue")).toMatch(/args\.parent \?\? args\.parent_key/);
    expect(fn(jiraTwin, "updateTicket")).toMatch(/params\.parent \?\? params\.parent_key/);
    expect(ticketsTwin).toMatch(/case "update_ticket":/);
  });
});

describe("closeout name parity — UNIVERSAL_DECISION_OPTIONS (TEAM-5358 FR-6)", () => {
  it("is [stopped] in the four .mjs copies, the TS mirror and the client grammar", () => {
    const all = { universalTickets, universalJira, universalOutput, universalBridge, universalTs, universalGrammar };
    for (const [name, v] of Object.entries(all)) expect([...v], name).toEqual(["stopped"]);
  });
});
