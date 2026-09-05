/**
 * TEAM-3991 D1.5 — the PR-aware dispatch guard, console side.
 *
 * A re-dispatched agent starts from a blank session: it cannot see the PR it
 * already opened, so it re-investigates and re-implements work that is already on
 * GitHub (prod: TEAM-3790 re-investigated a finding it had itself merged, and a
 * second run opened a competing PR for the same ticket).
 *
 * So before a human's retry/nudge puts an agent back on a ticket, we ask GitHub
 * whether a PR for it already exists:
 *   - it does, and the caller did not say `resume: true`  ⇒ refuse with PR_EXISTS
 *     and tell them what the PR is. The human decides: resume, or leave it.
 *   - `resume: true` ⇒ proceed, but first write a resume context the orchestrator
 *     prepends to the agent's prompt ("PR #N exists … resume, don't
 *     re-investigate"), so the agent picks up instead of starting over.
 *   - GitHub unreachable / no repo config / no PR ⇒ FAIL OPEN, dispatch as before.
 *     An unreachable GitHub must never wedge a human's intervention.
 *
 * The orchestrator half of this guard lives in lambda/orchestrator/index.mjs
 * (dispatch path) over the same `findTicketPullRequest` — see evidence-parity.test.ts.
 */

import { findTicketPullRequest, githubApi, parseRepo, type TicketPullRequest } from "./evidence";
import { setResumeContext } from "./workflow-store";

/** The PR already open/merged for this ticket, or null (⇒ dispatch freely). */
export async function existingTicketPr(
  workflow: Record<string, unknown>,
  ticketId: string
): Promise<TicketPullRequest | null> {
  if (!ticketId || !process.env.GITHUB_PAT) return null;
  const { owner, repo } = parseRepo(workflow?.repoConfig);
  if (!owner || !repo) return null;
  const base =
    (workflow?.repoConfig as { repos?: Array<{ defaultBranch?: string }> } | undefined)?.repos?.[0]
      ?.defaultBranch || "main";
  try {
    return await findTicketPullRequest(githubApi(), {
      owner,
      repo,
      base,
      ticketId,
      featureBranch: typeof workflow?.featureBranch === "string" ? workflow.featureBranch : "",
    });
  } catch (err) {
    // Fail open — see the module note.
    console.warn(`[pr-guard] ${ticketId}: PR lookup failed: ${(err as Error).message}`);
    return null;
  }
}

/** The 409 body a refused dispatch returns. `resume: true` overrides it. */
export function prExistsPayload(ticketId: string, pr: TicketPullRequest) {
  return {
    code: "PR_EXISTS",
    number: pr.number,
    prUrl: pr.url,
    state: pr.state,
    merged: pr.merged,
    ticketId,
    message:
      `PR #${pr.number} exists — resume, don't re-investigate. ${ticketId} already has a ` +
      `${pr.state} PR (${pr.url}) on ${pr.headRef || "its feature branch"}. Re-dispatching from a ` +
      `blank session makes the agent redo work that is already on GitHub. Pass resume:true to ` +
      `dispatch with a resume context instead.`,
  };
}

/** The note the orchestrator prepends to the resumed agent's prompt. */
export function resumeNote(ticketId: string, pr: TicketPullRequest): string {
  return (
    `PR #${pr.number} exists on ${pr.headRef || "your feature branch"} (${pr.url}) — resume, don't ` +
    `re-investigate. That PR is ${pr.state}: read it (and its review comments) first, then continue ` +
    `from where it left off for ${ticketId}. Do NOT open a second PR for the same work.`
  );
}

/**
 * Persist the resume context the orchestrator's `consumeResumeContext` reads
 * (`resumeContexts.<ticketId>` on the workflow row). The write itself lives in
 * workflow-store.setResumeContext (TEAM-4099 F6 moved it there, so every
 * workflows-table write from the app tier is in one auditable module): seed the
 * map, then a scoped SET of the one key — never a whole-map rewrite, so two
 * concurrent resumes cannot clobber each other. Best-effort: a failure means the
 * agent starts cold, not that the human's dispatch dies.
 */
export async function writeResumeContext(
  workflowId: string,
  ticketId: string,
  note: string
): Promise<boolean> {
  try {
    await setResumeContext(workflowId, ticketId, note);
    return true;
  } catch (err) {
    console.warn(`[pr-guard] ${workflowId}/${ticketId}: resume context write failed: ${(err as Error).message}`);
    return false;
  }
}
