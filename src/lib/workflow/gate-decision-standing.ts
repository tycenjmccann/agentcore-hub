/**
 * TEAM-5395 F6 — the hub's mirror of the orchestrator's blocker rule
 * (cascade.mjs isBlockerResolved + index.mjs gateDecided) for a human gate in Done.
 *
 * A gate a human closed to Done in Jira whose ratify and reopen both failed still
 * reads Done (the webhook's residual), so status alone never answers "is this gate
 * decided?". A done human gate resolves its dependants only when its signed v3
 * gate-decision record stands (gateDecisionStands against liveGate: this run, this
 * ticket, the gate's current cycle and scope) with status "done". Everything else
 * fails closed: key unavailable, record absent or unreadable, get_issue refused, a throw.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { isHumanGateTicket } from "./completion-evidence";
import { loadDecisionKeys, type DecisionKeys } from "./decision-keys";
import { gateDecisionRecordKey, gateDecisionStands } from "./gate-decision-record";
import { liveGate, type LiveGateReader } from "./gate-live";

const REGION = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region: REGION });

export type GateStandingDeps = {
  readJson?: (key: string) => Promise<unknown>;
  live?: LiveGateReader;
  keys?: () => Promise<DecisionKeys>;
};

export type NudgeBlocker = {
  ticketId: string;
  status?: unknown;
  assignee?: unknown;
  labels?: unknown;
};

const is404 = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
};

/** null on 404 (absent = no decision); any other error throws, which the caller turns into false. */
async function readArtifactJson(key: string): Promise<unknown> {
  const bucket = process.env.ARTIFACT_BUCKET || "";
  if (!bucket) throw new Error("ARTIFACT_BUCKET unset");
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await obj.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch (err) {
    if (is404(err)) return null;
    throw err;
  }
}

/** True only when `ticketId`'s gate-decision record stands for `workflowId` with status "done". Never throws. */
export async function humanGateDecidedDone(ticketId: string, workflowId: string, deps: GateStandingDeps = {}): Promise<boolean> {
  try {
    if (!workflowId || !ticketId) return false;
    const keys = await (deps.keys ?? loadDecisionKeys)();
    if (!keys.ok) {
      console.warn(`[gate-standing] ${ticketId}: gate decision key unavailable - held as a blocker`);
      return false;
    }
    const rec = await (deps.readJson ?? readArtifactJson)(gateDecisionRecordKey(workflowId, ticketId));
    if (!rec) {
      console.log(`[gate-standing] ${ticketId}: done human gate held as a blocker (absent)`);
      return false;
    }
    const live = await (deps.live ?? liveGate)(ticketId).catch(() => null);
    const stands = gateDecisionStands(rec, keys.keys, { workflowId, ticketId, live });
    if (!stands.ok) console.log(`[gate-standing] ${ticketId}: done human gate held as a blocker (${stands.why})`);
    return stands.ok && stands.record.status === "done";
  } catch (err) {
    console.warn(`[gate-standing] ${ticketId}: decision check failed - held as a blocker: ${(err as Error).message}`);
    return false;
  }
}

/**
 * THE nudge blocker predicate: a done agent ticket resolves; a done human gate
 * resolves only through humanGateDecidedDone; anything else (a missing blocker,
 * a cancelled gate, any open status) does not.
 */
export async function nudgeBlockerResolved(
  blocker: NudgeBlocker | null | undefined,
  workflowId: string,
  deps: GateStandingDeps = {}
): Promise<boolean> {
  if (!blocker || blocker.status !== "done") return false;
  if (!isHumanGateTicket(blocker)) return true;
  return humanGateDecidedDone(blocker.ticketId, workflowId, deps);
}
