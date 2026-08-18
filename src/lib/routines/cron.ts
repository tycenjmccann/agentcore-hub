/**
 * Build an EventBridge Scheduler expression from the New Routine form's simple
 * inputs (frequency + time-of-day + day-of-week/month). Kept tiny and pure so it
 * unit-tests cleanly and the form stays declarative.
 *
 * EventBridge cron is 6-field: cron(min hour day-of-month month day-of-week year).
 * Day-of-week uses 1-7 (SUN-SAT) or names; a "?" means "no specific value" and is
 * required in exactly one of day-of-month / day-of-week.
 */

export type Frequency = "daily" | "weekly" | "biweekly" | "monthly";

export const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export interface ScheduleForm {
  frequency: Frequency;
  /** 0-23 local-to-timezone hour. */
  hour: number;
  /** 0-59 minute. */
  minute: number;
  /** 0-6 (Sun-Sat) — used by weekly/biweekly. */
  dayOfWeek?: number;
  /** 1-28 — used by monthly (capped at 28 so every month has the day). */
  dayOfMonth?: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Produce the EventBridge expression for the given form. Biweekly has no native
 *  cron form, so it uses rate(14 days) anchored at creation — good enough for
 *  "every other week"; the exact time-of-day is then not enforced (documented in
 *  the form). daily/weekly/monthly get precise cron expressions. */
export function toScheduleExpression(form: ScheduleForm): string {
  const { frequency, hour, minute } = form;
  switch (frequency) {
    case "daily":
      return `cron(${minute} ${hour} * * ? *)`;
    case "weekly": {
      const dow = DOW[form.dayOfWeek ?? 1];
      return `cron(${minute} ${hour} ? * ${dow} *)`;
    }
    case "biweekly":
      // No cron primitive for "every 2 weeks"; rate() from creation time.
      return `rate(14 days)`;
    case "monthly": {
      const dom = Math.min(Math.max(form.dayOfMonth ?? 1, 1), 28);
      return `cron(${minute} ${hour} ${dom} * ? *)`;
    }
  }
}

/** Human summary of a form, for the form's live preview (mirrors format.ts output
 *  but works from the structured inputs before an expression exists). */
export function describeForm(form: ScheduleForm): string {
  const time = `${pad(form.hour)}:${pad(form.minute)}`;
  switch (form.frequency) {
    case "daily":
      return `Every day at ${time}`;
    case "weekly":
      return `Weekly on ${DOW[form.dayOfWeek ?? 1]} at ${time}`;
    case "biweekly":
      return `Every 2 weeks (from creation)`;
    case "monthly":
      return `Monthly on day ${Math.min(Math.max(form.dayOfMonth ?? 1, 1), 28)} at ${time}`;
  }
}
