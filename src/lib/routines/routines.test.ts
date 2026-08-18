import { describe, it, expect } from "vitest";
import { describeSchedule } from "./format";
import { buildStartPayload } from "./payload";
import type { RoutineInputTemplate } from "./types";

describe("describeSchedule", () => {
  it("renders rate() singular and plural", () => {
    expect(describeSchedule("rate(1 day)")).toBe("Every day");
    expect(describeSchedule("rate(7 days)")).toBe("Every 7 days");
  });

  it("renders weekly cron with a day + time", () => {
    expect(describeSchedule("cron(0 9 ? * MON *)")).toBe("Weekly on Mon at 09:00");
  });

  it("renders daily cron", () => {
    expect(describeSchedule("cron(30 6 * * ? *)")).toBe("Daily at 06:30");
  });

  it("appends a non-UTC timezone", () => {
    expect(describeSchedule("cron(0 9 ? * MON *)", "America/Los_Angeles")).toContain("(America/Los_Angeles)");
  });

  it("falls back to the raw expression it cannot parse", () => {
    expect(describeSchedule("cron(weird)")).toBe("cron(weird)");
  });
});

describe("buildStartPayload", () => {
  const fired = new Date("2026-08-17T09:00:00.000Z");
  const base: RoutineInputTemplate = { titleTemplate: "Report {date}", description: "d", workflowDefId: "wf" };

  it("substitutes {date} and defaults sources", () => {
    const p = buildStartPayload(base, fired);
    expect(p.title).toBe("Report 2026-08-17");
    expect(p.sources).toEqual([]);
    expect(p.workflowDefId).toBe("wf");
  });

  it("omits modelOverride when absent and includes it when present", () => {
    expect("modelOverride" in buildStartPayload(base, fired)).toBe(false);
    const p = buildStartPayload({ ...base, modelOverride: "opus" }, fired);
    expect(p.modelOverride).toBe("opus");
  });
});
