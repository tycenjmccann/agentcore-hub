/**
 * The hub's read of the gate-decision HMAC key (TEAM-5322, TEAM-5318 F1).
 *
 * Same contract as the twins' loadDecisionKeys (lambda/agentcore-hub-tickets/
 * gate-contract.mjs): Secrets Manager `GATE_DECISION_SECRET_ID` (default
 * `agentcore-hub-gate-decision-key`), AWSCURRENT first and AWSPREVIOUS when it
 * differs, cached 5 minutes. `GATE_DECISION_KEY` is a dev/test literal that wins
 * over the secret — never set it in production, where the key must stay off any
 * env a GetFunctionConfiguration or task-definition read could expose.
 *
 * Never throws and never returns the reason text of an SDK error: a missing key
 * means the console cannot mint, and the caller answers decision_required with
 * detail `decision_channel_unavailable`.
 */

import { DEFAULT_GATE_DECISION_SECRET_ID } from "./decision-contract";
// Defined in the dependency-free grammar module so the console can name it too.
import { DECISION_CHANNEL_UNAVAILABLE } from "./decision-grammar";

const REGION = process.env.AWS_REGION || "us-east-1";
const CACHE_MS = 5 * 60 * 1000;

export { DECISION_CHANNEL_UNAVAILABLE };

export type DecisionKeys = { ok: true; keys: string[] } | { ok: false; detail: string };

let cache: { keys: string[]; at: number } | null = null;

/** Test seam: drop the cached key so the next call reads again. */
export function resetDecisionKeyCache(): void {
  cache = null;
}

async function readStage(secretId: string, stage: "AWSCURRENT" | "AWSPREVIOUS"): Promise<string | null> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const sm = new SecretsManagerClient({ region: REGION });
  const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId, VersionStage: stage }));
  return typeof out.SecretString === "string" && out.SecretString !== "" ? out.SecretString : null;
}

export async function loadDecisionKeys(now: number = Date.now()): Promise<DecisionKeys> {
  const literal = process.env.GATE_DECISION_KEY;
  if (literal) return { ok: true, keys: [literal] };
  if (cache && now - cache.at < CACHE_MS) return { ok: true, keys: cache.keys };
  const id = process.env.GATE_DECISION_SECRET_ID || DEFAULT_GATE_DECISION_SECRET_ID;
  try {
    const current = await readStage(id, "AWSCURRENT");
    if (!current) return { ok: false, detail: DECISION_CHANNEL_UNAVAILABLE };
    let previous: string | null = null;
    try {
      previous = await readStage(id, "AWSPREVIOUS");
    } catch {
      // No AWSPREVIOUS until the first rotation — not a failure.
    }
    const keys = previous && previous !== current ? [current, previous] : [current];
    cache = { keys, at: now };
    return { ok: true, keys };
  } catch (err) {
    console.warn(
      `[decision-keys] decision key unreadable (${(err as { name?: string })?.name || "Error"}) - the console cannot mint`
    );
    return { ok: false, detail: DECISION_CHANNEL_UNAVAILABLE };
  }
}
