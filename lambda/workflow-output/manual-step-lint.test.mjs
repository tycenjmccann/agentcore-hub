import { describe, expect, it } from "vitest";
import { clauseStatesCompletion, lintManualSteps, runnableSteps, splitClauses, splitSentences, windowTokens } from "./manual-step-lint.mjs";

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

describe("manual-step lint — review F4: completed manual work is not an admission", () => {
  it.each([
    "The manual step was completed successfully.",
    "The manual step for `deploy.sh --backfill` succeeded.",
    "The manual step has been run by the on-call engineer.",
  ])("passes with no follow-ups: %s", (summary) => {
    expect(lintManualSteps({ summary, followUps: [] })).toBeNull();
  });

  it.each([
    "The manual step was NOT completed.",
    "This step must be run by an operator; it has not been done.",
    "The manual step `deploy.sh --backfill` hasn't succeeded yet.",
    // Review R2: round 1 excused these two; a completion word in ANOTHER clause
    // ("CI ran it", "that was done") is not the step's own clause, and "a human
    // needs to" is never excused at all.
    "This step must be run by CI, and CI ran it successfully.",
    "A human needs to approve it, and that was done before merge.",
  ])("a negated completion is still refused: %s", (summary) => {
    expect(lintManualSteps({ summary, followUps: [] })).toMatchObject({ status: 422, reason: "unticketed_manual_step" });
  });
});

describe("manual-step lint — review F5: every step needs its own follow-up", () => {
  const S_TWO = "Run `scripts/a.sh` and then `scripts/b.sh` against prod. I did NOT run them.";

  it("a.sh + b.sh with only b.sh ticketed is refused, naming a.sh", () => {
    const r = lintManualSteps({ summary: S_TWO, followUps: [handoff("Run scripts/b.sh against prod")] });
    expect(r).toMatchObject({ status: 422, reason: "unticketed_manual_step", sentence: "I did NOT run them." });
    expect(r.expected.title).toBe("Run scripts/a.sh");
    expect(r.message).toContain("`a.sh`");
    expect(r.message).not.toContain("`b.sh`");
  });

  it("a.sh + b.sh with both ticketed (one follow-up each) passes", () => {
    expect(lintManualSteps({ summary: S_TWO, followUps: [handoff("Run scripts/a.sh"), handoff("Run scripts/b.sh")] })).toBeNull();
  });

  it("one follow-up naming both steps also passes", () => {
    expect(lintManualSteps({ summary: S_TWO, followUps: [handoff("Run a.sh then b.sh against prod")] })).toBeNull();
  });

  it("the real 17w716 case still passes with its single handoff", () => {
    expect(lintManualSteps({ summary: S_17W716, followUps: [handoff("Run lambda/cost-report/deploy.sh --backfill")] })).toBeNull();
  });
});

describe("manual-step lint — review R2 F4: only the step's own clause can excuse it", () => {
  it.each([
    // The reviewer's repro: future-tense "will be done after the release".
    "A human needs to run `deploy.sh --backfill`; this will be done after the release.",
    // The pipeline-succeeded variant: success of something else excuses nothing.
    "A human needs to run `deploy.sh --backfill`; the pipeline succeeded.",
    "I did NOT run `deploy.sh --backfill`, but the pipeline succeeded.",
    "`deploy.sh --backfill` was not run by me and the deploy completed.",
    "The backfill was deferred to a follow-up PRD, and everything else is done.",
    // Qualified phrases: completion in another clause, or a future marker in its own.
    "The backfill must be run by an operator; the pipeline succeeded.",
    "The manual step `deploy.sh --backfill` remains, and the pipeline succeeded.",
    "The manual step `deploy.sh --backfill` will be done after the release.",
    "The manual step is still pending although the pipeline succeeded.",
    "The manual step will be completed later.",
  ])("refused with no follow-ups: %s", (summary) => {
    expect(lintManualSteps({ summary, followUps: [] })).toMatchObject({ status: 422, reason: "unticketed_manual_step" });
  });

  it("the repro names the step and is satisfied by a follow-up for it", () => {
    const summary = "A human needs to run `deploy.sh --backfill`; this will be done after the release.";
    expect(lintManualSteps({ summary, followUps: [] }).expected.title).toBe("Run deploy.sh --backfill");
    expect(lintManualSteps({ summary, followUps: [handoff("Run deploy.sh --backfill after the release")] })).toBeNull();
  });

  it("every occurrence counts: one completed manual step does not excuse a second, open one", () => {
    const summary = "The first manual step was completed; the second manual step is open.";
    expect(lintManualSteps({ summary, followUps: [] })?.status).toBe(422);
  });

  it("clauses split on ; , and/but — but never inside backticks", () => {
    expect(splitClauses("Run `a.sh, b.sh` now; then stop, and wait but go").map((c) => c.text)).toEqual(["Run `a.sh, b.sh` now", "then stop", "wait", "go"]);
    expect(clauseStatesCompletion("the manual step was completed")).toBe(true);
    expect(clauseStatesCompletion("the manual step will be completed")).toBe(false);
    expect(clauseStatesCompletion("the manual step was not completed")).toBe(false);
  });
});

describe("manual-step lint — review R2 F5: only RUNNABLE tokens are steps", () => {
  it("the reviewer's repro: an edited file is not a step — `Run deploy.sh` satisfies it", () => {
    const summary = "Updated `src/app.ts`; a human needs to run `deploy.sh`.";
    expect(lintManualSteps({ summary, followUps: [handoff("Run deploy.sh")] })).toBeNull();
    const r = lintManualSteps({ summary, followUps: [] });
    expect(r.expected.title).toBe("Run deploy.sh");
    expect(r.message).toContain("no follow_ups entry names `deploy.sh`. Nothing");
  });

  it("anaphora with only an edited file in reach demands no file — any follow-up satisfies, none is refused", () => {
    const summary = "Updated `src/app.ts`; I did NOT run it.";
    expect(lintManualSteps({ summary, followUps: [handoff("Run the smoke test")] })).toBeNull();
    const r = lintManualSteps({ summary, followUps: [] });
    expect(r).toMatchObject({ status: 422 });
    expect(r.expected.title).toBe("Run the manual step");
  });

  it("an edited file AFTER the run verb, behind another action, is not a step either", () => {
    const summary = "A human needs to run `deploy.sh` after updating `src/app.ts`.";
    expect(lintManualSteps({ summary, followUps: [handoff("Run deploy.sh")] })).toBeNull();
  });

  it("the hit clause wins over an earlier sentence's unrelated command", () => {
    const summary = "Run `scripts/a.sh --seed` in dev. A human needs to run `scripts/b.sh` in prod.";
    expect(lintManualSteps({ summary, followUps: [handoff("Run b.sh in prod")] })).toBeNull();
  });

  it.each([
    ["flags make a bare path runnable", "A human needs to do lambda/x/migrate.mjs --apply.", "migrate.mjs"],
    ["right after run/execute/invoke", "A human needs to execute `make backfill`.", "make backfill"],
    ["an interpreter command line", "A human needs to do `npm run seed` on prod.", "npm run seed"],
    ["a passive run after the script", "`scripts/migrate.py` must be run by an operator.", "migrate.py"],
  ])("%s", (_name, summary, needle) => {
    const r = lintManualSteps({ summary, followUps: [] });
    expect(r.message).toContain(`\`${needle}\``);
    expect(lintManualSteps({ summary, followUps: [handoff(`Do ${needle}`)] })).toBeNull();
  });

  it("each distinct runnable token needs its own follow-up, and non-runnable files around them do not count", () => {
    const summary = "Edited `docs/runbook.md` and `src/app.ts`. A human needs to run `a.sh` and `b.sh --prod`.";
    const r = lintManualSteps({ summary, followUps: [handoff("Run a.sh")] });
    expect(r.message).toContain("no follow_ups entry names `b.sh`. Nothing");
    expect(r.expected.title).toBe("Run b.sh --prod");
    expect(lintManualSteps({ summary, followUps: [handoff("Run a.sh"), handoff("Run b.sh --prod")] })).toBeNull();
  });

  it("a script listed next to a runnable one is a step, across the clause split", () => {
    const summary = "`scripts/a.sh` and `scripts/b.sh` must be run by ops.";
    const r = lintManualSteps({ summary, followUps: [handoff("Run b.sh")] });
    expect(r.message).toContain("no follow_ups entry names `a.sh`. Nothing");
  });

  it("runnableSteps: invoked scripts and flagged commands, never an edited file", () => {
    expect(runnableSteps("Run `scripts/a.sh` and then `scripts/b.sh` against prod.").map((s) => s.needle)).toEqual(["a.sh", "b.sh"]);
    expect(runnableSteps("Updated `src/app.ts` and docs/x.md.")).toEqual([]);
    expect(runnableSteps("Run `lambda/cost-report/deploy.sh --backfill` now.")).toEqual([
      { needle: "deploy.sh", label: "lambda/cost-report/deploy.sh --backfill", start: 4, end: 45 },
    ]);
  });
});
