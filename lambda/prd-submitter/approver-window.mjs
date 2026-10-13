/**
 * The approver's working window — TEAM-5771.
 *
 * A system PRD starts an Operator run whose Merge Approval only a human can
 * close. One that starts at 03:00 on a Sunday parks that gate for a day and a
 * half, so prd-submitter holds it until the window opens. This file is only
 * the arithmetic; the hold itself lives in index.mjs.
 *
 * Semantics follow businessWindow() in deploy/telegram-bug-intake/index.mjs:
 * half-open [start, end) hours on a 24h clock, same HH-HH grammar, and a bad
 * value warns once and falls back to the defaults rather than breaking the
 * import. Unlike that window this one is UTC-only — the approver window is
 * stated in UTC, so there is no zone (and no DST) to get wrong.
 *
 * Environment:
 *   SI_APPROVER_HOURS - "HH-HH" UTC (default 15-22). Unset or "off" turns the
 *                       hold OFF: CD ships this code before the human-run
 *                       deploy.sh adds the tick rule, and a hold with no tick
 *                       to release it would strand the PRD.
 *   SI_APPROVER_DAYS  - ISO weekday range "D-D", 1 = Monday (default 1-5).
 */

export const WINDOW_DEFAULTS = Object.freeze({ start: 15, end: 22, days: Object.freeze([1, 2, 3, 4, 5]) });

const HOURS_RE = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/;
const DAYS_RE = /^\s*([1-7])\s*-\s*([1-7])\s*$/;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

// One warn per distinct bad value, not one per invocation: the tick runs every
// five minutes and would otherwise repeat the same sentence all day.
const warned = new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[prd-submitter] ${message}`);
}

/**
 * The configured window, or null when the hold is off.
 * → { start, end, days: [ISO weekday…] }
 */
export function parseWindow(env = process.env) {
  const spec = env.SI_APPROVER_HOURS;
  if (spec === undefined || spec === null || String(spec).trim() === "" || String(spec).trim().toLowerCase() === "off") {
    return null;
  }
  const w = { start: WINDOW_DEFAULTS.start, end: WINDOW_DEFAULTS.end, days: [...WINDOW_DEFAULTS.days] };

  const m = HOURS_RE.exec(String(spec));
  const start = m ? Number(m[1]) : NaN;
  const end = m ? Number(m[2]) : NaN;
  if (m && start >= 0 && start < end && end <= 24) {
    w.start = start;
    w.end = end;
  } else {
    warnOnce(`SI_APPROVER_HOURS="${spec}" is not HH-HH — holding system PRDs to ${w.start}-${w.end} UTC`);
  }

  const daySpec = env.SI_APPROVER_DAYS;
  if (daySpec !== undefined && daySpec !== null && String(daySpec).trim() !== "") {
    const d = DAYS_RE.exec(String(daySpec));
    if (d && Number(d[1]) <= Number(d[2])) {
      w.days = [];
      for (let i = Number(d[1]); i <= Number(d[2]); i++) w.days.push(i);
    } else {
      warnOnce(`SI_APPROVER_DAYS="${daySpec}" is not a D-D ISO weekday range — using ${w.days[0]}-${w.days.at(-1)}`);
    }
  }
  return w;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a UTC instant. */
function isoDay(date) {
  return date.getUTCDay() || 7;
}

/** Is `now` inside the window? */
export function inWindow(now, w) {
  const t = new Date(now);
  const h = t.getUTCHours();
  return w.days.includes(isoDay(t)) && h >= w.start && h < w.end;
}

/**
 * The earliest window opening at or after `now` — `now` itself when it is
 * already inside. Walks forward a UTC day at a time, so a weekend hops to the
 * first configured weekday. Fail-safe: nothing found in 8 days (impossible with
 * a parsed window) yields now+24h, which delays a start rather than losing it.
 */
export function nextOpenAt(now, w) {
  const t = new Date(now);
  if (inWindow(t, w)) return t;
  const midnight = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  for (let i = 0; i < 8; i++) {
    const open = new Date(midnight + i * DAY_MS + w.start * HOUR_MS);
    if (w.days.includes(isoDay(open)) && open.getTime() >= t.getTime()) return open;
  }
  return new Date(t.getTime() + DAY_MS);
}
