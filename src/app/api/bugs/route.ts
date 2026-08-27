import { NextRequest, NextResponse } from "next/server";
import { JiraClient } from "@/lib/workflow/jira-client";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

export const dynamic = "force-dynamic";

const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
// Ceiling on OPEN auto-filed bugs sharing a dedupe signature label family
// (e.g. "crash-rca"). At the cap, new reports land as comments on the newest
// open bug instead of new tickets — one systemic root cause (a crashed
// runtime) must never fan out into a bug per persona per night.
const MAX_OPEN_AUTO_BUGS = Number(process.env.WM_MAX_OPEN_AUTO_BUGS || 3);
// A signature the user closed as Won't Do stays muted this long.
const WONT_DO_MUTE_DAYS = Number(process.env.WM_BUG_MUTE_DAYS || 7);

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" })
);

/**
 * Auto-bug-filing kill switch. Stored in the events table (no new IAM) as
 * {workflowId: "wm-config", eventId: "auto-file-bugs", detail: {value}} —
 * toggled by `intervene.py bugs-off|bugs-on`. Missing item = enabled.
 */
async function autoFilingDisabled(): Promise<boolean> {
  try {
    const item = (await ddb.send(new GetCommand({
      TableName: EVENTS_TABLE,
      Key: { workflowId: "wm-config", eventId: "auto-file-bugs" },
    }))).Item;
    return item?.detail?.value === "off";
  } catch {
    return false; // config read failure must not block human-relayed bugs
  }
}

/**
 * POST /api/bugs — file a top-level Jira Bug programmatically.
 *
 * A Bug with a `repo:owner/name` label auto-fires the bug-fix pipeline via the
 * Jira webhook → orchestrator bootstrapBugWorkflow path (same as Telegram
 * intake). This endpoint is the app-side write path for agents that must not
 * hold Jira credentials themselves (e.g. the Workflow Manager's `file-bug`
 * intervention).
 *
 * Body:
 *   title        (required)
 *   description  (required)
 *   repo         owner/name — defaults to GITHUB_OWNER/GITHUB_REPO
 *   labels       extra labels (e.g. ["crash-rca", "agent:agentcore_hub_backend_designer"])
 *   dedupeLabels if set, an OPEN Bug carrying ALL of these labels absorbs this
 *                report as a comment instead of a duplicate ticket
 *
 * Returns { ticketId, deduped } — deduped=true means the description landed as
 * a comment on the existing open bug named by ticketId.
 */
export async function POST(req: NextRequest) {
  if (TICKET_PROVIDER !== "jira") {
    return NextResponse.json(
      { error: "Bug filing requires TICKET_PROVIDER=jira (the bug-fix pipeline bootstraps off Jira Bugs). Use /api/workflow/start instead." },
      { status: 400 }
    );
  }

  let body: {
    title?: string;
    description?: string;
    repo?: string;
    labels?: string[];
    dedupeLabels?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const title = (body.title || "").trim();
  const description = (body.description || "").trim();
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  if (!description) return NextResponse.json({ error: "description is required" }, { status: 400 });

  const repo = (body.repo || "").trim() ||
    (process.env.GITHUB_OWNER && process.env.GITHUB_REPO
      ? `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`
      : "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json(
      { error: `repo must be owner/name (got "${repo}"). Pass repo explicitly or set GITHUB_OWNER/GITHUB_REPO.` },
      { status: 400 }
    );
  }

  // Jira labels cannot contain spaces.
  const extraLabels = (body.labels || []).map((l) => String(l).trim()).filter((l) => l && !/\s/.test(l));
  const labels = [`repo:${repo}`, ...extraLabels];
  const projectKey = process.env.JIRA_PROJECT_KEY || "TEAM";

  try {
    const jira = JiraClient.fromEnv();

    // dedupeLabels present = automated filing path (WM crash-rca etc.). Everything
    // below the kill switch applies ONLY to automated filings; human-relayed bugs
    // (Telegram intake, UI) don't send dedupeLabels and are never suppressed.
    const dedupeLabels = (body.dedupeLabels || []).map((l) => String(l).trim()).filter(Boolean);
    if (dedupeLabels.length > 0) {
      // 0. Kill switch — the operator said stop; enforce it in code, not prompt.
      if (await autoFilingDisabled()) {
        return NextResponse.json({
          suppressed: true,
          reason: "Automated bug filing is disabled (wm-config/auto-file-bugs=off). Report the RCA as a ticket comment instead. Do NOT retry.",
        });
      }

      // 1. Exact-signature dedupe: one open bug per signature, occurrences
      //    accumulate as comments.
      const sigJql =
        `project = "${projectKey}" AND issuetype = Bug AND statusCategory != Done AND ` +
        dedupeLabels.map((l) => `labels = "${l}"`).join(" AND ") +
        " ORDER BY created DESC";
      const existing = await jira.searchIssues(sigJql, ["summary", "status", "labels"], 1);
      if (existing.issues.length > 0) {
        const key = existing.issues[0].key;
        await jira.addComment(key, "workflow-manager", `[new occurrence] ${title}\n\n${description}`);
        return NextResponse.json({ ticketId: key, deduped: true });
      }

      // 2. Won't-Do mute: a signature the operator recently closed unresolved
      //    (or whose fix run they cancelled) is a "stop reporting this" signal.
      //    Refiling it within the mute window is suppressed outright.
      const mutedJql =
        `project = "${projectKey}" AND issuetype = Bug AND statusCategory = Done AND ` +
        `resolution in ("Won't Do", "Won't Fix", "Duplicate") AND resolved >= -${WONT_DO_MUTE_DAYS}d AND ` +
        dedupeLabels.map((l) => `labels = "${l}"`).join(" AND ") +
        " ORDER BY resolved DESC";
      try {
        const muted = await jira.searchIssues(mutedJql, ["summary", "resolution"], 1);
        if (muted.issues.length > 0) {
          return NextResponse.json({
            suppressed: true,
            reason: `Signature muted: ${muted.issues[0].key} was closed Won't Do within the last ${WONT_DO_MUTE_DAYS} days. Do NOT retry.`,
          });
        }
      } catch { /* mute check is best-effort — resolution field may vary per site */ }

      // 3. Family cap: at MAX_OPEN_AUTO_BUGS open bugs sharing the family label
      //    (dedupeLabels[0], e.g. "crash-rca"), one systemic root cause has
      //    already fanned out enough — absorb this report as a comment on the
      //    newest open bug instead of opening ticket N+1 and burning another
      //    pipeline run.
      const familyJql =
        `project = "${projectKey}" AND issuetype = Bug AND statusCategory != Done AND ` +
        `labels = "${dedupeLabels[0]}" ORDER BY created DESC`;
      const openFamily = await jira.searchIssues(familyJql, ["summary"], MAX_OPEN_AUTO_BUGS);
      if (openFamily.issues.length >= MAX_OPEN_AUTO_BUGS) {
        const key = openFamily.issues[0].key;
        await jira.addComment(
          key,
          "workflow-manager",
          `[absorbed — open ${dedupeLabels[0]} bug cap (${MAX_OPEN_AUTO_BUGS}) reached] ${title}\n\n${description}`
        );
        return NextResponse.json({
          ticketId: key,
          deduped: true,
          reason: `${openFamily.issues.length} open ${dedupeLabels[0]} bugs already — RCA added as comment on ${key}. Likely one systemic root cause; do NOT file more.`,
        });
      }
    }

    const created = await jira.createIssue({
      project: { key: projectKey },
      issuetype: { name: "Bug" },
      summary: title.slice(0, 250),
      labels,
      description: {
        type: "doc",
        version: 1,
        content: description.split(/\n\n+/).map((p) => ({
          type: "paragraph",
          content: [{ type: "text", text: p }],
        })),
      },
    });

    return NextResponse.json({ ticketId: created.key, deduped: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/bugs] file failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
