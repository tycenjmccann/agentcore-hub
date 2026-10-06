import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLOSEOUT_OVERRIDE_FIELDS as fieldsTs,
  parseCloseoutOverride as parseTs,
} from "./performance";
// The three readers of shared/closeout-override.json cannot import one another:
// the orchestrator decides whether a refused run may complete, the cost-report
// Lambda decides whether its card is capped as "cancelled", and the web mirror
// re-derives the card's outcome. A drift means a run the orchestrator closed on
// an override scores uncapped, or the reverse.
import {
  CLOSEOUT_OVERRIDE_FIELDS as fieldsOrch,
  COMPLETION_BLOCKED_NOTIF_RE,
  parseCloseoutOverride as parseOrch,
} from "../../../lambda/orchestrator/completion.mjs";
import {
  CLOSEOUT_OVERRIDE_FIELDS as fieldsCard,
  parseCloseoutOverride as parseCard,
} from "../../../lambda/cost-report/index.mjs";

/**
 * TEAM-5359 parity contract: the SAME input table through all three
 * parseCloseoutOverride copies, identical output required. The field names are
 * pinned separately so a rename on one side fails by name, not by a confusing
 * deep-equal diff.
 */

const FIELDS = ["by", "reason", "offenders", "at"];
const ok = { by: "human:ops", reason: "closed out after stop", offenders: ["TEAM-5326", "TEAM-5328@ship"], at: "2026-10-05T21:40:00Z" };
const j = (v: unknown) => JSON.stringify(v);

const INPUTS: Array<[string, unknown]> = [
  ["valid", j(ok)],
  ["valid, offenders []", j({ ...ok, offenders: [] })],
  ["numeric offenders stringified", j({ ...ok, offenders: [5326, "TEAM-1"] })],
  ["extra keys dropped", j({ ...ok, sig: "x", note: "y" })],
  ["null", null],
  ["undefined", undefined],
  ["empty string", ""],
  ["unparseable", "{not json"],
  ["JSON null", "null"],
  ["JSON array", "[]"],
  ["JSON string", j("override")],
  ["JSON number", "7"],
  ["empty object", "{}"],
  ["offenders missing", j({ by: ok.by, reason: ok.reason, at: ok.at })],
  ["offenders a string", j({ ...ok, offenders: "TEAM-5326" })],
  ["offenders an object", j({ ...ok, offenders: { 0: "TEAM-5326" } })],
  ["by blank", j({ ...ok, by: "  " })],
  ["by non-string", j({ ...ok, by: 42 })],
  ["reason missing", j({ by: ok.by, offenders: ok.offenders, at: ok.at })],
  ["reason empty", j({ ...ok, reason: "" })],
  ["at missing", j({ by: ok.by, reason: ok.reason, offenders: ok.offenders })],
  ["at non-string", j({ ...ok, at: 1791220686225 })],
  ["already-parsed object (not text)", ok],
];

const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

describe("closeout-override field names", () => {
  it("are {by, reason, offenders, at} in all three readers", () => {
    expect([...fieldsOrch]).toEqual(FIELDS);
    expect([...fieldsCard]).toEqual(FIELDS);
    expect([...fieldsTs]).toEqual(FIELDS);
  });
});

describe("parseCloseoutOverride — orchestrator × cost-report × web", () => {
  it.each(INPUTS)("%s", (_name, input) => {
    const orch = parseOrch(input as string);
    expect(parseCard(input as string)).toStrictEqual(orch);
    expect(parseTs(input as string)).toStrictEqual(orch);
    // A non-null result carries exactly the shared field names, in order.
    if (orch) expect(Object.keys(orch)).toEqual(FIELDS);
  });

  it("the table exercises both verdicts", () => {
    const parsed = INPUTS.map(([, i]) => parseOrch(i as string));
    expect(parsed.filter(Boolean).length).toBe(4);
    expect(parsed.filter((p) => p === null).length).toBe(INPUTS.length - 4);
  });
});

// The legs below belong to api_dev (TEAM-5358) and do not exist on this branch
// yet. Each reads its file IF PRESENT, so it turns itself on the day the file
// lands — no edit here needed. Until then it asserts only that it is waiting.
describe("api_dev surfaces (active once the files exist)", () => {
  const ROUTE = "src/app/api/workflow/[id]/closeout-override/route.ts";
  const TWIN = "src/lib/workflow/completion-evidence.ts";

  it(`${ROUTE} uses the shared field names`, () => {
    if (!existsSync(repo(ROUTE))) {
      expect(existsSync(repo(ROUTE))).toBe(false); // TODO(TEAM-5358): route not landed yet
      return;
    }
    const src = readFileSync(repo(ROUTE), "utf8");
    expect(src).toContain("closeout-override.json");
    for (const f of FIELDS) {
      expect(src, `route never names "${f}"`).toMatch(new RegExp(`["'\`]${f}["'\`]|\\b${f}\\s*[:,}]|\\.${f}\\b`));
    }
  });

  it(`${TWIN} completion-blocked notice prefix matches completion.mjs`, () => {
    const src = existsSync(repo(TWIN)) ? readFileSync(repo(TWIN), "utf8") : "";
    const m = /COMPLETION_BLOCKED_NOTIF_RE\s*(?::[^=]+)?=\s*(\/.+?\/[a-z]*)\s*;/.exec(src);
    if (!m) {
      expect(m).toBeNull(); // TODO(TEAM-5358): TS twin declares no notice regex yet
      return;
    }
    expect(m[1]).toBe(String(COMPLETION_BLOCKED_NOTIF_RE));
  });

  it("the orchestrator prefix is the one the ticket specifies", () => {
    expect(String(COMPLETION_BLOCKED_NOTIF_RE)).toBe("/^notif_completion_/");
  });
});
