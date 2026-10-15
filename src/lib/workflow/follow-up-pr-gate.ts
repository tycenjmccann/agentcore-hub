/**
 * TEAM-6136 — the TEAM-6032 (DL-038) follow-up PR gate for POST
 * /api/workflow/[id]/complete. NOT a port: the gate is the orchestrator's own
 * `followUpPrGate` (lambda/orchestrator/completion.mjs, pure, no imports beyond
 * repo-check.mjs), so both terminal-completion entry points share one set of
 * exclusions and one fail-open. This file only builds the route's deps — the
 * orchestrator's are readCompletionRecord (index.mjs) and githubApi (index.mjs).
 */
import { followUpPrGate, isIntentOnlyReservation } from "../../../lambda/orchestrator/completion.mjs";
import { ghGet } from "@/lib/workflow/repo-check";

export { followUpPrGate };

type Env = Record<string, string | undefined>;

/** The gate's contract (completion.mjs JSDoc). TS would infer `tickets: never[]` and a
 *  zero-arg readCompletionRecord from the .mjs defaults, so the shape is stated here. */
type FollowUpPrGate = (args: {
  workflow: Record<string, unknown>;
  agentTasks: unknown;
  tickets: Array<Record<string, unknown>>;
  mergeProof: unknown;
  readCompletionRecord: (ticketId: string) => Promise<Record<string, unknown> | null>;
  getAgentPhase: (agentId: string) => string | undefined;
  api: (path: string) => Promise<unknown>;
  warn: (msg: string) => void;
}) => Promise<string[]>;
const gate = followUpPrGate as unknown as FollowUpPrGate;

/**
 * Mirror of the orchestrator's `mergeVerifyConfigured` (index.mjs completeWorkflow):
 * SHIP_MERGE_VERIFY not opted out, a ship phase in the def, a feature branch, a
 * repo config and a GitHub token. The `!verdict.handoff` half is the caller's.
 */
export function followUpPrGateConfigured(
  workflow: Record<string, unknown>,
  hasShipPhase: boolean,
  env: Env = process.env
): boolean {
  const optedOut = ["off", "false", "0"].includes(String(env.SHIP_MERGE_VERIFY || "").trim().toLowerCase());
  return !optedOut && hasShipPhase && Boolean(workflow.featureBranch && workflow.repoConfig && env.GITHUB_PAT);
}

/** The gate's `api`: GET-only, throws on non-2xx like the orchestrator's githubApi. */
export function githubApi(token: string | undefined, fetchImpl?: typeof fetch) {
  return async (path: string): Promise<unknown> => {
    const r = await ghGet(path, { token, fetchImpl });
    if (r.status < 200 || r.status >= 300) throw new Error(`GitHub GET ${path} ${r.status}`);
    return r.json;
  };
}

/**
 * The open follow-up PR urls that refuse completion; [] when there are none or
 * the check could not run (fail-open — never throws, so a caller's surrounding
 * catch can never be reached through here). A Done-intent reservation is no
 * record (TEAM-5996, same as the orchestrator's readCompletionRecord).
 */
export async function openFollowUpPrsAtCompletion(opts: {
  workflow: Record<string, unknown>;
  tickets: Array<Record<string, unknown>>;
  readCompletionRecord: (ticketId: string) => Promise<Record<string, unknown> | null>;
  getAgentPhase: (agentId: string) => string | undefined;
  token: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  try {
    return await gate({
      workflow: { id: opts.workflow.workflowId, ...opts.workflow }, // the gate's warns name `workflow.id`
      agentTasks: opts.workflow.agentTasks || {},
      tickets: opts.tickets,
      mergeProof: null,
      readCompletionRecord: async (ticketId: string) => {
        const record = await opts.readCompletionRecord(ticketId);
        return isIntentOnlyReservation(record) ? null : record;
      },
      getAgentPhase: opts.getAgentPhase,
      api: githubApi(opts.token, opts.fetchImpl),
      warn: console.warn,
    });
  } catch (err) {
    console.warn(`[complete] follow-up PR check skipped for ${String(opts.workflow.workflowId)}: ${(err as Error).message}`);
    return [];
  }
}
