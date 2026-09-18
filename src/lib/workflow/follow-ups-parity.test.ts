import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TEAM-4739 / TEAM-4740 parity contract for `follow_ups`.
 *
 * A ticket regularly surfaces a thread it does not own — a post-deploy
 * verification, a console or IAM handoff a human has to perform, a docs gap. Until
 * now a persona had two bad options: close its own ticket over the loose end, or
 * file the follow-up itself, reaching across ticket boundaries to create work in
 * someone else's lane. `follow_ups` on `WorkflowOutput___report_completion` is the
 * third option: DECLARE it, and let the one component that owns ticket creation
 * act on it.
 *
 * The contract spans two tickets, so this file is written to be green in either
 * merge order:
 *
 *   * the SENDER (this ticket, TEAM-4739) is `deploy/runtime-agent/main.py`. Those
 *     assertions are always on — my own half must not be able to regress.
 *   * the RECEIVER (TEAM-4740) is `lambda/workflow-output/index.mjs`, which owns
 *     the schema, the `kind`/`owner` allow-lists and the dropping of unknown
 *     entries, exactly as it already owns EVIDENCE_KINDS. That assertion is
 *     `skipIf`-gated on the key being present, so it activates by itself the
 *     moment TEAM-4740 merges — with no PR-ordering coupling and no red build in
 *     either direction.
 *
 * Why source-text assertions rather than importing: main.py cannot be imported
 * from TypeScript, and it cannot be imported from Python either (its module
 * top-level installs Node.js, fetches from S3 and chdirs). The behavioural half of
 * the sender contract is covered by
 * `deploy/runtime-agent/tests/test_report_completion_evidence.py`, which `ast`s the
 * real function out and exec's it. What is left for this file is the NAME parity
 * that neither side's own suite can see: a rename on either side of the Lambda
 * boundary is invisible to both unit suites and fails only in production, on a
 * ship, in the release manager's turn.
 */

const REPO = join(__dirname, "..", "..", "..");
const MAIN_PY = join(REPO, "deploy", "runtime-agent", "main.py");
const WORKFLOW_OUTPUT = join(REPO, "lambda", "workflow-output", "index.mjs");

const mainPy = readFileSync(MAIN_PY, "utf8");
const workflowOutput = readFileSync(WORKFLOW_OUTPUT, "utf8");

/** The `WorkflowOutput___report_completion` def, from its `def` line to the next
 *  top-level `def`/`@tool` — so a `follow_ups` somewhere else in the 5k-line file
 *  cannot satisfy the assertions below. */
function reportCompletionSource(): string {
  const start = mainPy.indexOf("def WorkflowOutput___report_completion(");
  expect(start, "WorkflowOutput___report_completion is not defined in main.py").toBeGreaterThan(-1);
  const rest = mainPy.slice(start + 1);
  const end = rest.search(/\n@tool|\ndef /);
  return rest.slice(0, end === -1 ? undefined : end);
}

// TEAM-4740's half. Read as source text because the Lambda cannot be imported
// here either (it constructs AWS SDK clients at module scope).
const lambdaAcceptsFollowUps = /\bfollow_ups\b/.test(workflowOutput);

describe("follow_ups parity — runtime harness ↔ workflow-output Lambda", () => {
  const fn = reportCompletionSource();

  it("report_completion declares follow_ups with a blank default", () => {
    // The exact failure mode of PR #618's missing `pipeline_execution_id`: the
    // body forwarded a parameter the SIGNATURE did not have, so Strands rejected
    // the keyword argument and the agent could never comply with the rail that
    // demanded it. A blank default is what keeps a pre-4739 call byte-identical.
    expect(fn).toMatch(/follow_ups:\s*str\s*=\s*""/);
  });

  it("forwards the literal key follow_ups, not a renamed one", () => {
    // The whole point of a parity test: the harness and the Lambda agree on ONE
    // spelling. `followUps` would be dropped silently by a Lambda destructuring
    // `follow_ups`, and the persona would never learn its declaration vanished.
    expect(fn).toMatch(/["']follow_ups["']\s*\]?\s*=/);
    expect(fn).not.toMatch(/\bfollowUps\b/);
  });

  it("forwards it only when non-blank, so absent stays absent", () => {
    // Every additive parameter on this tool follows the same rule (evidence_kind,
    // ci_status, merge_commit, pipeline_name): sending "" always would add a key
    // to every pre-4739 completion record, and "the agent said nothing" would stop
    // being distinguishable from "the agent said there is nothing to follow up on".
    expect(fn).toMatch(/if\s+follow_ups(\.strip\(\))?[\s:]/);
    expect(fn).toMatch(/follow_ups\.strip\(\)/);
  });

  it("teaches the model the kinds and owners in the tool spec", () => {
    // The docstring IS the tool spec Strands ships to the model. A parameter the
    // model is never told the shape of is a parameter it never fills, and the
    // Lambda's allow-list would then only ever see malformed entries.
    const doc = fn.slice(0, fn.indexOf('"""', fn.indexOf('"""') + 3));
    for (const kind of [
      "post_deploy_verification",
      "console_handoff",
      "iam_handoff",
      "fix",
      "docs",
    ]) {
      expect(doc, `the docstring does not name the ${kind} kind`).toContain(kind);
    }
    expect(doc).toContain("agent");
    expect(doc).toContain("human");
    // The harness must not promise validation it does not perform — the Lambda
    // drops unknown entries, and a persona told otherwise would treat a silently
    // dropped follow-up as filed.
    expect(doc.toLowerCase()).toMatch(/dropped|drops/);
  });

  it("does not validate or re-serialise the array in the harness", () => {
    // One owner for the schema. A harness that parsed the JSON would either
    // duplicate the allow-lists (two places to drift) or swallow a malformed
    // entry, which is the one signal telling a blueprint author their JSON is
    // wrong. So: trim, forward, and let the Lambda refuse.
    expect(fn).not.toMatch(/json\.loads\(\s*follow_ups/);
  });

  it.skipIf(!lambdaAcceptsFollowUps)(
    "workflow-output destructures follow_ups (lands with TEAM-4740)",
    () => {
      expect(workflowOutput).toMatch(/\bfollow_ups\b/);
    },
  );

  it("names the ticket that lands the receiving half", () => {
    // Not decoration: without this the skip above reads as "an assertion someone
    // disabled". TEAM-4740 owns lambda/workflow-output/** and this test must not
    // edit it.
    if (!lambdaAcceptsFollowUps) {
      expect(
        workflowOutput,
        "workflow-output does not yet read follow_ups — TEAM-4740 lands the " +
          "receiving half (schema, kind/owner allow-lists, dropping unknown " +
          "entries). The skipped assertion above activates automatically then.",
      ).not.toMatch(/\bfollow_ups\b/);
    }
    expect(true).toBe(true);
  });
});
