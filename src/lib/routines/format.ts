/**
 * Human-readable rendering of EventBridge Scheduler expressions for the UI.
 * Best-effort: falls back to the raw expression for anything it doesn't parse.
 */

const DOW: Record<string, string> = {
  "1": "Sun", SUN: "Sun", "2": "Mon", MON: "Mon", "3": "Tue", TUE: "Tue",
  "4": "Wed", WED: "Wed", "5": "Thu", THU: "Thu", "6": "Fri", FRI: "Fri",
  "7": "Sat", SAT: "Sat",
};

export function describeSchedule(expression: string, timezone?: string): string {
  const tz = timezone && timezone !== "UTC" ? ` (${timezone})` : "";

  const rate = expression.match(/^rate\((\d+)\s+(\w+)\)$/i);
  if (rate) {
    const n = Number(rate[1]);
    const unit = rate[2].replace(/s$/, "");
    return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  }

  // cron(min hour day-of-month month day-of-week year)
  const cron = expression.match(/^cron\((.+)\)$/i);
  if (cron) {
    const parts = cron[1].trim().split(/\s+/);
    if (parts.length === 6) {
      const [min, hour, dom, , dow] = parts;
      const time =
        /^\d+$/.test(hour) && /^\d+$/.test(min)
          ? `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`
          : null;
      if (dow && dow !== "?" && dow !== "*") {
        const days = dow.split(",").map((d) => DOW[d.toUpperCase()] || d).join(", ");
        return `Weekly on ${days}${time ? ` at ${time}` : ""}${tz}`;
      }
      if (dom && dom !== "?" && dom !== "*") {
        return `Monthly on day ${dom}${time ? ` at ${time}` : ""}${tz}`;
      }
      if (time) return `Daily at ${time}${tz}`;
    }
  }

  return expression;
}
