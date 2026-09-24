/**
 * Push a registry routing change onto the live harnesses (TEAM-4997).
 *
 * The registry is only the intent; a harness keeps running whatever model it was
 * last configured with. `applyHarnessModels` closes that gap for the three
 * harness agents the ticket names and reports, per agent, what actually
 * happened — so "the console says fable-5.1" and "the harness runs sonnet-5"
 * can never again both be true and invisible.
 *
 * Four outcomes, and the distinction matters:
 *   live      — the deployed harness already runs the resolved model. No write.
 *   applying  — we sent UpdateHarness; the control plane applies it async.
 *   drift     — this save did not change the agent's model, but the deployed
 *               harness reports a different one. REPORTED, never silently
 *               "fixed": repinning a harness nobody asked us to touch is how a
 *               deploy and a console edit start fighting each other.
 *   failed    — no harness by that name, or the API rejected the update.
 *
 * `personal_assistant_agent` is also a harness but is deliberately NOT in the
 * apply set: the ticket names three agents, and adding a fourth would be a
 * routing change this ticket does not own. It is visible in the registry GET.
 */

import { BedrockAgentCoreControlClient, UpdateHarnessCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import type { HarnessModelConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import { DEFAULT_REGION, discoverAgents, getHarnessDetail } from "@/lib/agentcore-sdk";
import type { ModelsRegistry } from "@/lib/models-registry";
import { resolveAgentModel } from "@/lib/models-registry";
import { buildHarnessModelConfig } from "./harness-models";

/** The harness agents this ticket owns, in report order. */
export const APPLY_HARNESS_AGENT_IDS = [
  "agentcore_hub_workflow_manager",
  "agentcore_hub_builder",
  "agentcore_hub_routine_builder",
] as const;

export type HarnessApplyStatus = "live" | "drift" | "applying" | "failed";

export interface HarnessApplyResult {
  agentId: string;
  harnessId?: string;
  /** What the LIVE harness reports today (undefined when unreadable). */
  previous?: string;
  /** What the registry now resolves this agent to. */
  current: string;
  status: HarnessApplyStatus;
  error?: string;
}

/** Per-region, same as agentcore-sdk.ts — a client per call is pure waste. */
const clients = new Map<string, BedrockAgentCoreControlClient>();
function controlClient(region: string): BedrockAgentCoreControlClient {
  let client = clients.get(region);
  if (!client) {
    client = new BedrockAgentCoreControlClient({ region });
    clients.set(region, client);
  }
  return client;
}

/**
 * A harness's `harnessName` IS the agentId (deploy/setup-builder-agent.mjs:322),
 * which is what makes this lookup possible without a stored mapping.
 */
async function harnessIdFor(agentId: string, region: string): Promise<string | undefined> {
  const agents = await discoverAgents(region);
  return agents.find((a) => a.type === "harness" && a.name === agentId)?.id;
}

/**
 * Apply `nextReg` to the live harnesses. `agentIds` narrows the set (the reapply
 * route passes one); omitted, all three are considered. Never throws — a
 * per-agent failure is a `failed` row, because a half-applied save still has to
 * report what it did.
 */
export async function applyHarnessModels(
  liveReg: ModelsRegistry | null | undefined,
  nextReg: ModelsRegistry,
  agentIds?: readonly string[],
  region: string = DEFAULT_REGION
): Promise<HarnessApplyResult[]> {
  const targets = agentIds?.length
    ? APPLY_HARNESS_AGENT_IDS.filter((id) => agentIds.includes(id))
    : [...APPLY_HARNESS_AGENT_IDS];
  const explicit = Boolean(agentIds?.length);

  const results: HarnessApplyResult[] = [];
  for (const agentId of targets) {
    const current = resolveAgentModel(nextReg, agentId).modelId;
    const wasResolved = liveReg ? resolveAgentModel(liveReg, agentId).modelId : undefined;
    // The status is decided below; until then this is everything BUT the status.
    const result: Omit<HarnessApplyResult, "status"> = { agentId, current };

    try {
      const harnessId = await harnessIdFor(agentId, region);
      if (!harnessId) {
        results.push({ ...result, status: "failed", error: `no harness named ${agentId}` });
        continue;
      }
      result.harnessId = harnessId;

      const deployed = (await getHarnessDetail(harnessId, region)).model;
      if (deployed) result.previous = deployed;

      if (deployed === current) {
        results.push({ ...result, status: "live" });
        continue;
      }
      // Nothing about this agent changed in this save and we weren't asked for
      // it by name — report the divergence, don't take it over.
      if (!explicit && wasResolved === current) {
        results.push({ ...result, status: "drift" });
        continue;
      }

      await controlClient(region).send(
        new UpdateHarnessCommand({
          harnessId,
          // Exactly these two fields: UpdateHarness retains every field the
          // request omits, so a partial update cannot clobber tools or prompt.
          model: buildHarnessModelConfig(current) as HarnessModelConfiguration,
        })
      );
      console.log(`[models] harness.repinned agentId=${agentId} harnessId=${harnessId} model=${current}`);
      results.push({ ...result, status: "applying" });
    } catch (err) {
      const error = (err as Error)?.message || "update failed";
      console.warn(`[models] harness.apply_failed agentId=${agentId} error=${error}`);
      results.push({ ...result, status: "failed", error });
    }
  }
  return results;
}
