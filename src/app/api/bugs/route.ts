import { NextRequest, NextResponse } from "next/server";
import { JiraClient } from "@/lib/workflow/jira-client";

export const dynamic = "force-dynamic";

const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

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

    // Dedupe: one open bug per signature. New occurrences accumulate on it as
    // comments so the fix ticket sees the full history instead of the pipeline
    // burning a run per crash.
    const dedupeLabels = (body.dedupeLabels || []).map((l) => String(l).trim()).filter(Boolean);
    if (dedupeLabels.length > 0) {
      const jql =
        `project = "${projectKey}" AND issuetype = Bug AND statusCategory != Done AND ` +
        dedupeLabels.map((l) => `labels = "${l}"`).join(" AND ") +
        " ORDER BY created DESC";
      const existing = await jira.searchIssues(jql, ["summary", "status", "labels"], 1);
      if (existing.issues.length > 0) {
        const key = existing.issues[0].key;
        await jira.addComment(key, "workflow-manager", `[new occurrence] ${title}\n\n${description}`);
        return NextResponse.json({ ticketId: key, deduped: true });
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
