import { describe, expect, it } from "vitest";
import { lintManualSteps, splitSentences, windowTokens } from "./manual-step-lint.mjs";

// Run 17w716's summary, the shape that lost the backfill: command, then the admission.
const S_17W716 =
  "Implemented the v11 cost card schema and migrated the renderer. " +
  "Run `lambda/cost-report/deploy.sh --backfill` to rebuild v10 cards as v11 … I did NOT run it.";

const handoff = (title, detail = "") => ({ kind: "console_handoff", owner: "human", title, detail });

describe("manual-step lint — refusals", () => {
  it("17w716: refuses, names the sentence, and gives the expected follow-up shape", () => {
    const r = lintManualSteps({ summary: S_17W716, followUps: [] });
    expect(r).toMatchObject({ ok: false, status: 422, reason: "unticketed_manual_step", sentence: "I did NOT run it." });
    expect(r.expected).toEqual({
      kind: "console_handoff",
      owner: "human",
      assignee: "human:engineer",
      title: "Run lambda/cost-report/deploy.sh --backfill",
      detail: expect.stringContaining("deploy.sh --backfill"),
    });
    expect(r.message).toContain("I did NOT run it.");
    expect(r.message).toContain("`deploy.sh`");
  });

  it("an unrelated follow-up does not satisfy it", () => {
    const r = lintManualSteps({ summary: S_17W716, followUps: [handoff("Grant AccessAnalyzer", "iam.json")] });
    expect(r?.reason).toBe("unticketed_manual_step");
  });

  it.each([
    "A human needs to flip the feature flag in the console.",
    "The migration must be run by an operator with prod access.",
    "Seeding the table is a manual step.",
    "The roster-only CD detection was deferred to a follow-up PRD.",
    "The smoke script was not run by me.",
  ])("each fixed phrase trips: %s", (summary) => {
    expect(lintManualSteps({ summary, followUps: [] })?.status).toBe(422);
  });

  it("lists every unticketed sentence, the first one leading", () => {
    const r = lintManualSteps({
      summary: "Run `scripts/a.sh`. I did not run it. Then run `scripts/b.sh`. A human needs to run b.sh too.",
      followUps: [handoff("Run a.sh")],
    });
    expect(r.unticketed).toEqual(["A human needs to run b.sh too."]);
  });
});

describe("manual-step lint — passes", () => {
  it("17w716 with a console_handoff naming deploy.sh --backfill passes", () => {
    expect(lintManualSteps({ summary: S_17W716, followUps: [handoff("Run deploy.sh --backfill")] })).toBeNull();
  });

  it("the script may be named in the detail, under any kind", () => {
    const fu = { kind: "fix", owner: "agent", title: "Backfill v10 cards", detail: "lambda/cost-report/deploy.sh --backfill" };
    expect(lintManualSteps({ summary: S_17W716, followUps: [fu] })).toBeNull();
  });

  it("a hit whose window names nothing is satisfied by any follow-up", () => {
    expect(lintManualSteps({ summary: "A human needs to approve it.", followUps: [handoff("Approve it")] })).toBeNull();
  });

  it.each([
    "CI ran the tests and they passed.",
    "No manual steps are required.",
    "Deployed without manual steps; the pipeline ran green.",
    "I did not run into any problems.",
    "The tests were not run by CI on forks, so I ran them locally.",
    "",
  ])("an ordinary completion is clean: %j", (summary) => {
    expect(lintManualSteps({ summary, followUps: [] })).toBeNull();
  });
});

describe("manual-step lint — parsing", () => {
  it("splits on terminators, ellipses and newlines but not inside file names", () => {
    expect(splitSentences("Run deploy.sh now … I did NOT run it.\nNext line")).toEqual([
      "Run deploy.sh now …",
      "I did NOT run it.",
      "Next line",
    ]);
  });

  it("extracts basenames, flags and backtick spans", () => {
    expect(windowTokens("Run `lambda/cost-report/deploy.sh --backfill` and docs/x.md")).toEqual({
      paths: ["deploy.sh", "x.md"],
      flags: ["--backfill"],
      spans: ["lambda/cost-report/deploy.sh --backfill"],
    });
  });
});
