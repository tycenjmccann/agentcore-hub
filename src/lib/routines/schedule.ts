/**
 * Routines — EventBridge Scheduler management.
 *
 * Each routine gets ONE EventBridge schedule whose target is the internal
 * routines-runner Lambda (input = {routineId}). Scheduler → Lambda is IAM-internal:
 * no public endpoint, no open resource policy (satisfies the no-public-Lambda rule).
 *
 * The schedule's target uses a role that may assume it and invoke the runner
 * (SCHEDULER_ROLE_ARN); the runner's Lambda resource policy allows
 * scheduler.amazonaws.com to invoke it (added at deploy time).
 *
 * Enable/disable a routine == flipping the schedule State (ENABLED|DISABLED) so a
 * paused routine simply stops firing without losing its definition.
 */

import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  FlexibleTimeWindowMode,
  ScheduleState,
  ResourceNotFoundException,
} from "@aws-sdk/client-scheduler";
import type { RoutineSchedule } from "./types";

const REGION = process.env.AWS_REGION || "us-east-1";
const RUNNER_ARN = process.env.ROUTINES_RUNNER_ARN || "";
const SCHEDULER_ROLE_ARN = process.env.ROUTINES_SCHEDULER_ROLE_ARN || "";
/** All routine schedules live in one group for easy listing/teardown. */
const GROUP = process.env.ROUTINES_SCHEDULE_GROUP || "agentcore-hub-routines";
/** Failed invokes land here after the bounded retry policy is exhausted, instead
 *  of silently disappearing. Set by lambda/routines-runner/deploy.sh. */
const DLQ_ARN = process.env.ROUTINES_DLQ_ARN || "";

const scheduler = new SchedulerClient({ region: REGION });

/** Deterministic schedule name for a routine — lets us update/delete idempotently. */
export function scheduleNameFor(routineId: string): string {
  return `routine-${routineId}`;
}

function assertConfigured() {
  if (!RUNNER_ARN || !SCHEDULER_ROLE_ARN) {
    throw new Error(
      "Routines scheduler not configured. Set ROUTINES_RUNNER_ARN and " +
        "ROUTINES_SCHEDULER_ROLE_ARN (see lambda/routines-runner/deploy.sh)."
    );
  }
}

/**
 * Create or replace the schedule for a routine. Returns the schedule ARN.
 * Idempotent: if the schedule already exists it is updated in place.
 */
export async function upsertSchedule(
  routineId: string,
  schedule: RoutineSchedule,
  enabled: boolean
): Promise<string> {
  assertConfigured();
  const Name = scheduleNameFor(routineId);
  const common = {
    Name,
    GroupName: GROUP,
    ScheduleExpression: schedule.expression,
    ScheduleExpressionTimezone: schedule.timezone || "UTC",
    State: enabled ? ScheduleState.ENABLED : ScheduleState.DISABLED,
    FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
    Target: {
      Arn: RUNNER_ARN,
      RoleArn: SCHEDULER_ROLE_ARN,
      Input: JSON.stringify({ routineId }),
      // Bound the retry storm: EventBridge Scheduler defaults to 185 retries over
      // 24h. A slow/failed POST would otherwise start the same workflow many times.
      // Cap retries; exhausted invokes go to the DLQ instead of vanishing.
      RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 300 },
      ...(DLQ_ARN ? { DeadLetterConfig: { Arn: DLQ_ARN } } : {}),
    },
  };

  try {
    await scheduler.send(new GetScheduleCommand({ Name, GroupName: GROUP }));
    await scheduler.send(new UpdateScheduleCommand(common));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      await scheduler.send(new CreateScheduleCommand(common));
    } else {
      throw err;
    }
  }

  const account = RUNNER_ARN.split(":")[4];
  return `arn:aws:scheduler:${REGION}:${account}:schedule/${GROUP}/${Name}`;
}


/** Delete a routine's schedule. Tolerates an already-absent schedule. */
export async function deleteSchedule(routineId: string): Promise<void> {
  assertConfigured();
  try {
    await scheduler.send(
      new DeleteScheduleCommand({ Name: scheduleNameFor(routineId), GroupName: GROUP })
    );
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    throw err;
  }
}
