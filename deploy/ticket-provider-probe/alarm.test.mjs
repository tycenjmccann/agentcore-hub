// TEAM-5592: the ticket-provider alarm goes to ALARM after 3 failed probes in a
// row, back to OK on one healthy probe, and treats a silent probe (missing data)
// as a failure - the silent probe is the original incident.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { Alarms } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "alarm.json"), "utf8"),
);
const alarm = Alarms.find((a) => a.MetricName === "TicketProviderUnavailable");
const dropped = Alarms.find((a) => a.MetricName === "TicketReplayDropped");

const COMPARE = {
  GreaterThanOrEqualToThreshold: (v, t) => v >= t,
  GreaterThanThreshold: (v, t) => v > t,
  LessThanThreshold: (v, t) => v < t,
  LessThanOrEqualToThreshold: (v, t) => v <= t,
};

// M-of-N over the last EvaluationPeriods datapoints (oldest first; null =
// missing). Covers the TreatMissingData modes this alarm could use.
function evaluate(def, datapoints) {
  const window = datapoints.slice(-def.EvaluationPeriods);
  const breaches = (v) => COMPARE[def.ComparisonOperator](v, def.Threshold);
  let breaching = 0;
  let present = 0;
  for (const v of window) {
    if (v === null || v === undefined) {
      if (def.TreatMissingData === "breaching") breaching++;
      continue;
    }
    present++;
    if (breaches(v)) breaching++;
  }
  if (breaching >= def.DatapointsToAlarm) return "ALARM";
  if (present === 0 && def.TreatMissingData === "missing") return "INSUFFICIENT_DATA";
  return "OK";
}

describe("ticket-provider-unavailable alarm", () => {
  it("has the 3-of-3, 5-minute, missing-is-breaching definition", () => {
    expect(alarm.AlarmName).toBe("agentcore-hub-ticket-provider-unavailable");
    expect(alarm.Namespace).toBe("AgentCoreHub/TicketProvider");
    expect(alarm.MetricName).toBe("TicketProviderUnavailable");
    expect(alarm.Dimensions).toEqual([{ Name: "Provider", Value: "jira" }]);
    expect(alarm.Statistic).toBe("Maximum");
    expect(alarm.Period).toBe(300);
    expect(alarm.EvaluationPeriods).toBe(3);
    expect(alarm.DatapointsToAlarm).toBe(3);
    expect(alarm.Threshold).toBe(1);
    expect(alarm.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
    expect(alarm.TreatMissingData).toBe("breaching");
    expect(alarm.AlarmDescription).not.toMatch(/—/);
  });

  it("three failed probes in a row put it in ALARM", () => {
    expect(evaluate(alarm, [1, 1, 1])).toBe("ALARM");
  });

  it("one healthy probe returns it to OK", () => {
    expect(evaluate(alarm, [1, 1, 1, 0])).toBe("OK");
    expect(evaluate(alarm, [1, 1, 0])).toBe("OK");
  });

  it("a silent probe counts as a failure", () => {
    expect(evaluate(alarm, [1, 1, null])).toBe("ALARM");
    expect(evaluate(alarm, [null, null, null])).toBe("ALARM");
  });

  it("two failures alone do not alarm", () => {
    expect(evaluate(alarm, [0, 1, 1])).toBe("OK");
  });
});

describe("ticket-replay-dropped alarm", () => {
  it("is 1 of 1 on any drop, missing data not breaching, in the probe's namespace", () => {
    expect(Alarms).toHaveLength(2);
    expect(dropped).toMatchObject({
      AlarmName: "agentcore-hub-ticket-replay-dropped",
      Namespace: "AgentCoreHub/TicketProvider",
      Dimensions: [{ Name: "Provider", Value: "jira" }],
      EvaluationPeriods: 1, DatapointsToAlarm: 1, Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
    });
    expect(dropped.AlarmDescription).not.toMatch(/—/);
  });

  it("one drop alarms; the quiet period after it is OK (the probe publishes only on a drop)", () => {
    expect(evaluate(dropped, [1])).toBe("ALARM");
    expect(evaluate(dropped, [1, null])).toBe("OK");
    expect(evaluate(dropped, [null])).toBe("OK");
  });
});
