import { describe, it, expect } from "vitest";
import { toScheduleExpression, describeForm, validateScheduleFloor, type ScheduleForm } from "./cron";

describe("toScheduleExpression", () => {
  it("daily → cron with time, wildcards", () => {
    expect(toScheduleExpression({ frequency: "daily", hour: 6, minute: 30 })).toBe("cron(30 6 * * ? *)");
  });

  it("weekly → cron on the chosen day", () => {
    expect(toScheduleExpression({ frequency: "weekly", hour: 9, minute: 0, dayOfWeek: 1 })).toBe(
      "cron(0 9 ? * MON *)"
    );
    expect(toScheduleExpression({ frequency: "weekly", hour: 17, minute: 15, dayOfWeek: 5 })).toBe(
      "cron(15 17 ? * FRI *)"
    );
  });

  it("monthly → cron on day-of-month, capped at 28", () => {
    expect(toScheduleExpression({ frequency: "monthly", hour: 8, minute: 0, dayOfMonth: 15 })).toBe(
      "cron(0 8 15 * ? *)"
    );
    expect(toScheduleExpression({ frequency: "monthly", hour: 8, minute: 0, dayOfMonth: 31 })).toBe(
      "cron(0 8 28 * ? *)"
    );
  });

  it("biweekly → rate(14 days)", () => {
    expect(toScheduleExpression({ frequency: "biweekly", hour: 9, minute: 0, dayOfWeek: 1 })).toBe("rate(14 days)");
  });
});

describe("validateScheduleFloor", () => {
  it("rejects sub-hourly rate()", () => {
    expect(validateScheduleFloor("rate(1 minute)")).toMatch(/minimum/);
    expect(validateScheduleFloor("rate(30 minutes)")).toMatch(/minimum/);
    expect(validateScheduleFloor("rate(59 minutes)")).toMatch(/minimum/);
  });

  it("allows hourly-or-slower rate()", () => {
    expect(validateScheduleFloor("rate(1 hour)")).toBeNull();
    expect(validateScheduleFloor("rate(60 minutes)")).toBeNull();
    expect(validateScheduleFloor("rate(14 days)")).toBeNull();
  });

  it("rejects sub-hourly cron (wildcard/step/list/range minute)", () => {
    expect(validateScheduleFloor("cron(* * * * ? *)")).toMatch(/Sub-hourly/);
    expect(validateScheduleFloor("cron(0/5 * * * ? *)")).toMatch(/Sub-hourly/);
    expect(validateScheduleFloor("cron(0,30 * * * ? *)")).toMatch(/Sub-hourly/);
    expect(validateScheduleFloor("cron(0-15 * * * ? *)")).toMatch(/Sub-hourly/);
  });

  it("allows fixed-minute cron (daily/weekly/monthly and hourly)", () => {
    expect(validateScheduleFloor("cron(30 6 * * ? *)")).toBeNull();
    expect(validateScheduleFloor("cron(0 9 ? * MON *)")).toBeNull();
    expect(validateScheduleFloor("cron(15 * * * ? *)")).toBeNull(); // once/hour at :15
  });

  it("rejects unrecognized expressions", () => {
    expect(validateScheduleFloor("every minute")).toMatch(/Unrecognized/);
  });
});

describe("describeForm", () => {
  it("summarizes each frequency", () => {
    const base: ScheduleForm = { frequency: "daily", hour: 9, minute: 5 };
    expect(describeForm(base)).toBe("Every day at 09:05");
    expect(describeForm({ ...base, frequency: "weekly", dayOfWeek: 3 })).toBe("Weekly on WED at 09:05");
    expect(describeForm({ ...base, frequency: "monthly", dayOfMonth: 12 })).toBe("Monthly on day 12 at 09:05");
    expect(describeForm({ ...base, frequency: "biweekly" })).toContain("Every 2 weeks");
  });
});
