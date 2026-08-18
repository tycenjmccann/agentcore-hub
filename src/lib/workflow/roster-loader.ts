/**
 * Server-side agent roster loader — reads the LIVE config/agents.json from S3
 * (the same doc the orchestrator + runtime read). Used to validate that a
 * connector picked for a routine is actually bound to an agent in that routine's
 * workflow def; the runtime only NARROWS per-invoke connectors against roster
 * bindings, so a picked-but-unbound connector would silently do nothing.
 */

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

export interface RosterAgent {
  agentId: string;
  workflowDefId?: string;
  connectors?: string[];
}

const TTL_MS = 15_000;
let _cache: { agents: RosterAgent[]; at: number } | null = null;

export async function loadRoster(): Promise<RosterAgent[]> {
  const now = Date.now();
  if (_cache && now - _cache.at < TTL_MS) return _cache.agents;
  if (!ARTIFACT_BUCKET) return [];
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: "config/agents.json" })
    );
    const doc = JSON.parse(await obj.Body!.transformToString());
    const agents: RosterAgent[] = Array.isArray(doc) ? doc : doc.agents || [];
    _cache = { agents, at: now };
    return agents;
  } catch {
    return [];
  }
}

/**
 * Connector ids that are bound to at least one agent in the given workflow def.
 * Agents are tagged with workflowDefId (missing → "software-delivery"). Returns a
 * Set so callers can cheaply check whether a picked connector will actually apply.
 */
export async function boundConnectorIdsForDef(workflowDefId: string): Promise<Set<string>> {
  const roster = await loadRoster();
  const bound = new Set<string>();
  for (const a of roster) {
    const defId = a.workflowDefId || "software-delivery";
    if (defId !== workflowDefId) continue;
    for (const c of a.connectors || []) bound.add(c);
  }
  return bound;
}
