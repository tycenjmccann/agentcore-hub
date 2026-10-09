/**
 * Evaluations roster: which roster agents are scorecard COLUMNS, and which are
 * personas HOSTED on another agent's runtime.
 *
 * Every pipeline persona shares one fleet runtime in the default hub deployment,
 * so a persona's judge results are keyed under the host (`<host>#<persona>` day
 * rows, see lambda/eval-packager/lib/daily.mjs) and a top-level column keyed by
 * the persona's own agentId can never fill. But that is a TOPOLOGY fact, not a
 * roster fact: deploy/runtime-agent/deploy-topology.sh also supports 4- and
 * 14-runtime layouts where a persona owns its runtime and its column is real.
 *
 * So "hosted" is DERIVED from the live roster's `runtimeArn`s — the S3
 * config/agents.json that deploy-topology injects them into — never hardcoded:
 * evaluations-enabled agents that share one ARN collapse onto the agent whose
 * agentId names that runtime (`.../runtime/agentcore_hub_agent-<id>` →
 * `agentcore_hub_agent`). The checked-in agents.json ships `runtimeArn: null`
 * (open-source contract), so with no live roster every agent is its own column.
 * An explicit `evalHost` on a roster entry is an operator override and wins.
 */

import agentsConfig from "@/config/agents.json";

export interface EvalRosterAgent {
  agentId: string;
  displayName: string;
  evaluationsEnabled?: boolean;
  evalConfigName?: string;
  runtimeArn?: string | null;
  /** Explicit override: the agentId whose runtime scores this persona. */
  evalHost?: string;
}

export interface EvalColumn {
  agentId: string;
  displayName: string;
}

export interface EvalColumns {
  /** Evaluations-enabled agents that own their runtime, in roster order. */
  columns: EvalColumn[];
  /** persona agentId → host agentId, for every hosted persona. */
  hosted: Record<string, string>;
}

/**
 * `arn:aws:bedrock-agentcore:…:runtime/<name>-<id>` → `<name>`, with a
 * leading `harness_` dropped so a harness ARN names its agent the same way.
 * Returns null for anything that does not look like a runtime ARN.
 */
export function runtimeNameFromArn(arn: string | null | undefined): string | null {
  if (typeof arn !== "string") return null;
  const m = /[:/]runtime\/([^/]+)$/.exec(arn);
  if (!m) return null;
  const leaf = m[1];
  const cut = leaf.lastIndexOf("-");
  const name = cut > 0 ? leaf.slice(0, cut) : leaf;
  return name.startsWith("harness_") ? name.slice("harness_".length) : name;
}

/** Pure: split the evaluations-enabled roster into columns and hosted personas. */
export function deriveEvalColumns(agents: EvalRosterAgent[]): EvalColumns {
  const enabled = agents.filter((a) => a && a.evaluationsEnabled && a.agentId);
  const byId = new Map(enabled.map((a) => [a.agentId, a]));
  const hosted: Record<string, string> = {};

  // 1. Explicit overrides — only when the named host is itself an eval agent.
  for (const a of enabled) {
    if (a.evalHost && a.evalHost !== a.agentId && byId.has(a.evalHost)) hosted[a.agentId] = a.evalHost;
  }

  // 2. Shared runtimes — a group of ≥2 agents on one ARN collapses onto the
  //    agent whose agentId names that runtime. No anchor → no guess: every
  //    member keeps its own column. The anchor MUST be a roster agent because
  //    the day rows are keyed by the agentId the eval-packager resolves from the
  //    roster (resolveAgentId), never by a runtime name: the 1-runtime layout
  //    works because `agentcore_hub_agent` is a roster entry, and a 4-runtime
  //    layout needs one roster entry per phase runtime (`agentcore_hub_design`,
  //    …) for evaluations to attribute at all — the same entry anchors it here.
  const byArn = new Map<string, EvalRosterAgent[]>();
  for (const a of enabled) {
    if (hosted[a.agentId] || !a.runtimeArn) continue;
    (byArn.get(a.runtimeArn) ?? byArn.set(a.runtimeArn, []).get(a.runtimeArn)!).push(a);
  }
  for (const [arn, group] of byArn) {
    if (group.length < 2) continue;
    const name = runtimeNameFromArn(arn);
    const anchor = group.find((a) => a.agentId === name);
    if (!anchor) continue;
    for (const a of group) if (a !== anchor) hosted[a.agentId] = anchor.agentId;
  }

  const columns = enabled
    .filter((a) => !hosted[a.agentId])
    .map((a) => ({ agentId: a.agentId, displayName: a.displayName || a.agentId }));
  return { columns, hosted };
}

// ─── Live roster (server only) ───────────────────────────────────────────────

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const TTL_MS = 15_000;
let _cache: { agents: EvalRosterAgent[]; at: number } | null = null;

/** The bundled roster — the fallback when there is no bucket or the read fails. */
export function bundledEvalRoster(): EvalRosterAgent[] {
  return (agentsConfig as unknown as { agents: EvalRosterAgent[] }).agents;
}

/**
 * The LIVE config/agents.json from S3 (runtimeArns injected by deploy), 15 s
 * cache, bundled copy when the bucket is unset or unreadable. Same document and
 * same key the orchestrator and every Lambda read.
 */
export async function loadEvalRoster(): Promise<EvalRosterAgent[]> {
  const now = Date.now();
  if (_cache && now - _cache.at < TTL_MS) return _cache.agents;
  if (!ARTIFACT_BUCKET) return bundledEvalRoster();
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: "config/agents.json" }));
    const doc = JSON.parse(await obj.Body!.transformToString());
    const agents: EvalRosterAgent[] = Array.isArray(doc) ? doc : doc.agents || [];
    if (!agents.length) return bundledEvalRoster();
    _cache = { agents, at: now };
    return agents;
  } catch (err) {
    console.warn("[eval-roster] live agents.json unavailable, using bundled roster:", (err as Error)?.message);
    return bundledEvalRoster();
  }
}
