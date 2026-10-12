/**
 * Ticket-provider probe (TEAM-5592) — agentcore-hub-ticket-provider-probe.
 *
 * Every 5 minutes (EventBridge), one authenticated `GET /rest/api/3/myself`:
 *   fail ⇒ TicketProviderUnavailable=1 and return; the replay queue is not touched.
 *   ok   ⇒ TicketProviderUnavailable=0, then drain the replay queue that
 *          report_completion fills while Jira is down (index.mjs drainCompletion).
 *
 * The same read is the Jira site's keep-alive: an authenticated call every 5 minutes
 * keeps it out of SUSPENDED_INACTIVITY, which is how the 2026-10-08 outage began.
 * Ships in the workflow-output zip; deployed by deploy/ticket-provider-probe/deploy.sh.
 * Runbook: deploy/ticket-provider-probe/README.md.
 */

import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { drainCompletion } from "./index.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const sqs = new SQSClient({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });
const QUEUE_URL = process.env.TICKET_REPLAY_QUEUE_URL || "";

export const METRIC_NAMESPACE = "AgentCoreHub/TicketProvider";
export const METRIC_NAME = "TicketProviderUnavailable";
// One datapoint per write Jira refused permanently (drainCompletion `permanent`):
// the agentcore-hub-ticket-replay-dropped alarm pages on the first.
export const DROPPED_METRIC_NAME = "TicketReplayDropped";
const PROBE_TIMEOUT_MS = 8000;
// The function timeout is 120 s; one drainCompletion is a handful of ~1 s Jira calls.
const DRAIN_BUDGET_MS = Number(process.env.TICKET_PROBE_DRAIN_BUDGET_MS) || 90_000;
// No message is STARTED with less than this left on the invocation clock, which makes
// a cut-off unlikely, not impossible: a drainCompletion slower than this can still be
// stopped mid-write by the function timeout. That is safe - its message comes back
// after the visibility timeout and every step is idempotent.
const MESSAGE_RESERVE_MS = 30_000;

/** `{ ok, status, error }` for one GET /rest/api/3/myself, with the jira twin's credential. Never throws. */
export async function probeJira() {
  // No scheme, as the jira twin reads it (lambda/agentcore-hub-jira BASE_URL).
  const site = (process.env.JIRA_SITE_URL || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const email = process.env.JIRA_EMAIL || "";
  const token = process.env.JIRA_API_TOKEN || "";
  if (!site || !email || !token) return { ok: false, status: null, error: "JIRA_SITE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set" };
  try {
    const res = await fetch(`https://${site}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, status: res.status, error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return { ok: false, status: null, error: `${err?.name || "Error"}: ${err?.message || ""}` };
  }
}

/** Best-effort: a metric that cannot be published must not stop the drain. */
async function publishMetric(name, value, onFailure) {
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: [{ MetricName: name, Dimensions: [{ Name: "Provider", Value: "jira" }], Value: value, Unit: "Count" }],
    }));
  } catch (err) {
    console.error(`[ticket-probe] PutMetricData ${name} failed (${err?.name || "Error"}: ${err?.message || ""}) - ${onFailure}`);
  }
}

const publishAvailability = (unavailable) => publishMetric(METRIC_NAME, unavailable ? 1 : 0,
  "the alarm reads this as missing data (breaching)");

/**
 * Drain the replay queue in order. A message is deleted on `applied` / `dropped`. On
 * `retry` it is left in flight (it comes back after the visibility timeout) and its
 * group is stopped: the rest of that group's batch is handed back at visibility 0, so
 * nothing in a run is applied ahead of a write it was queued behind. `dropped` covers a
 * write Jira refused permanently too (drainCompletion stamps and publishes it), so a
 * 4xx never holds its group for the DLQ's 12 receives.
 *
 * `remainingMs` is the invocation's own clock (context.getRemainingTimeInMillis): the
 * budget is checked before each message against the time it may still need.
 */
export async function drainQueue({ budgetMs = DRAIN_BUDGET_MS, remainingMs = null } = {}) {
  const out = { applied: 0, dropped: 0, retried: 0, released: 0, failed: 0 };
  if (!QUEUE_URL) return out;
  const deadline = Date.now() + budgetMs;
  const outOfTime = () => Date.now() >= deadline || (typeof remainingMs === "function" && remainingMs() < MESSAGE_RESERVE_MS);
  const blocked = new Set();
  while (!outOfTime()) {
    const r = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ["MessageGroupId"],
    }));
    const batch = r?.Messages || [];
    if (batch.length === 0) break;
    for (const m of batch) {
      const group = m.Attributes?.MessageGroupId || "";
      if (blocked.has(group) || outOfTime()) {
        await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }));
        out.released++;
        continue;
      }
      let result;
      try {
        result = await drainCompletion(JSON.parse(m.Body));
      } catch (err) {
        console.error(`[ticket-probe] message ${m.MessageId} threw (${err?.name || "Error"}: ${err?.message || ""}) - left for redelivery`);
        result = { outcome: "retry" };
        out.failed++;
      }
      if (result.outcome === "applied" || result.outcome === "dropped") {
        // A permanent drop is human-surfaced before its message goes: drainCompletion
        // has commented on the ticket (or epic) and stamped the record; this pages.
        if (result.permanent) await publishMetric(DROPPED_METRIC_NAME, 1, "the drop is still on the ticket, the record and the journey");
        await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: m.ReceiptHandle }));
        out[result.outcome]++;
      } else {
        blocked.add(group);
        out.retried++;
      }
    }
    // Every group in the queue is now waiting on a retry: nothing more can be applied this tick.
    if (batch.every((m) => blocked.has(m.Attributes?.MessageGroupId || ""))) break;
  }
  return out;
}

export const handler = async (event = {}, context = {}) => {
  const probe = await probeJira();
  await publishAvailability(!probe.ok);
  if (!probe.ok) {
    console.error(`[ticket-probe] Jira UNAVAILABLE (${probe.error}) - TicketProviderUnavailable=1, replay queue not read`);
    return { available: false, status: probe.status, error: probe.error };
  }
  console.log(`[ticket-probe] /myself ${probe.status}`);
  if (event?.probeOnly) return { available: true, status: probe.status, drained: null };
  const drained = await drainQueue({ remainingMs: typeof context?.getRemainingTimeInMillis === "function" ? () => context.getRemainingTimeInMillis() : null });
  console.log(`[ticket-probe] drained: ${JSON.stringify(drained)}`);
  return { available: true, status: probe.status, drained };
};
